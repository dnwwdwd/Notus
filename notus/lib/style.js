const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');
const { getFileById, sha256 } = require('./files');
const { hybridSearch } = require('./retrieval');
const { completeChat } = require('./llm');
const { trimTextToTokenBudget } = require('./llmBudget');
const { createLogger } = require('./logger');

const STYLE_ELIGIBLE_TYPES = new Set(['paragraph', 'list', 'blockquote']);
const DEFAULT_MAX_SOURCE_CHARS = 4000;
const STYLE_BACKFILL_INTERVAL_MS = 60 * 1000;
const STYLE_BACKFILL_BATCH_SIZE = 5;
const logger = createLogger({ subsystem: 'style' });

let queue = [];
let queuedIds = new Set();
let processing = false;
let paused = false;
let schedulerTimer = null;

function normalizeNullablePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function parseSignaturePhrases(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function formatFingerprintRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    file_id: normalizeNullablePositiveInt(row.file_id),
    file_hash: row.file_hash || '',
    sentence_style: String(row.sentence_style || '').trim(),
    tone: String(row.tone || '').trim(),
    structure: String(row.structure || '').trim(),
    vocabulary: String(row.vocabulary || '').trim(),
    rhetoric: String(row.rhetoric || '').trim(),
    signature_phrases: parseSignaturePhrases(row.signature_phrases_json),
    raw_response: row.raw_response || '',
    status: String(row.status || 'pending'),
    retry_count: Number(row.retry_count || 0),
    last_error: row.last_error || null,
    model_used: row.model_used || '',
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function getWritableChunksForFile(fileId) {
  const database = getDb();
  return database.prepare(`
    SELECT id, file_id, content, type, position, heading_path
    FROM chunks
    WHERE file_id = ?
    ORDER BY position ASC
  `).all(normalizeNullablePositiveInt(fileId));
}

function buildFingerprintSource(content = '', maxChars = DEFAULT_MAX_SOURCE_CHARS) {
  const source = String(content || '').trim();
  if (!source) return '';
  if (source.length <= maxChars) return source;
  const head = Math.max(1200, Math.floor(maxChars * 0.52));
  const tail = Math.max(800, maxChars - head);
  return `${source.slice(0, head)}\n\n[中间内容已省略]\n\n${source.slice(-tail)}`;
}

function splitSentences(content = '') {
  return String(content || '')
    .replace(/\r\n/g, '\n')
    .split(/[。！？!?；;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickFrequentPhrases(content = '', limit = 5) {
  const normalized = String(content || '');
  const matches = normalized.match(/“[^”]{2,24}”|‘[^’]{2,24}’|\"[^\"]{2,24}\"|[\u3400-\u9fffA-Za-z0-9]{4,16}/g) || [];
  const counts = new Map();
  matches.forEach((item) => {
    const key = String(item || '').trim();
    if (!key || key.length < 4) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([item]) => item);
}

function extractFingerprintLocal(content = '') {
  const text = String(content || '').trim();
  const sentences = splitSentences(text);
  const averageLength = sentences.length > 0
    ? Math.round(sentences.reduce((sum, item) => sum + item.length, 0) / sentences.length)
    : 0;
  const subjectiveMatches = text.match(/我觉得|我认为|其实|说白了|本质上|说实话|先说结论|反直觉/g) || [];
  const analogyMatches = text.match(/像是|好比|相当于|可以理解成|更像/g) || [];
  const shortSentence = averageLength > 0 && averageLength <= 22;
  return {
    sentence_style: shortSentence ? '以短句和中短句为主，整体节奏偏紧。' : '句长中等，段落节奏相对平稳。',
    tone: subjectiveMatches.length > 0 ? '语气较直接，带有明确个人判断和解释倾向。' : '语气相对克制，偏解释和说明。',
    structure: /先说结论|先看结论|结论/.test(text)
      ? '倾向先给判断或结论，再展开说明。'
      : '更常按背景、问题和说明顺序展开。',
    vocabulary: /搞定|折腾|说白了|卡住|顶住/.test(text)
      ? '词汇偏口语化，夹杂少量习惯性表达。'
      : '词汇整体偏中性，不刻意追求书面腔。',
    rhetoric: analogyMatches.length > 0
      ? '经常用类比或换一种说法来解释概念。'
      : '修辞较克制，主要通过举例或直接说明推进。',
    signature_phrases: pickFrequentPhrases(text, 5),
  };
}

function parseFingerprintPayload(content = '') {
  const text = String(content || '').trim();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      sentence_style: String(parsed.sentence_style || '').trim(),
      tone: String(parsed.tone || '').trim(),
      structure: String(parsed.structure || '').trim(),
      vocabulary: String(parsed.vocabulary || '').trim(),
      rhetoric: String(parsed.rhetoric || '').trim(),
      signature_phrases: parseSignaturePhrases(parsed.signature_phrases),
    };
  } catch {
    return null;
  }
}

function getCurrentStyleModel() {
  const config = getEffectiveConfig();
  return config.styleExtractionModel || config.llmModel;
}

function isStyleEligible({ chunks = [], content = '' } = {}) {
  const writableChunks = (Array.isArray(chunks) ? chunks : []).filter((chunk) => STYLE_ELIGIBLE_TYPES.has(chunk.type));
  const totalLength = writableChunks.reduce((sum, chunk) => sum + String(chunk.content || '').trim().length, 0);
  if (writableChunks.length < 3) return false;
  if (totalLength >= 600) return true;
  return String(content || '').trim().length >= 600;
}

async function requestFingerprintFromLlm(content) {
  const prompt = [
    {
      role: 'system',
      content: [
        '你是一位写作风格分析助手。',
        '只分析表达方式，不分析文章主题。',
        '从句法风格、语气态度、篇章结构、词汇偏好、修辞习惯五个维度输出一条简洁描述。',
        '另外摘取 3 到 5 个最能代表作者表达方式的短语。',
        '只输出 JSON，格式为 {"sentence_style":"","tone":"","structure":"","vocabulary":"","rhetoric":"","signature_phrases":["..."]}。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请分析以下文章的写作风格：\n\n${buildFingerprintSource(content)}`,
    },
  ];

  const reply = await completeChat(prompt, {
    taskType: 'style_fingerprint',
    temperature: 0.1,
    responseFormat: { type: 'json_object' },
    model: getCurrentStyleModel(),
  });

  const parsed = parseFingerprintPayload(reply.message?.content);
  return {
    fingerprint: parsed,
    raw: reply.message?.content || '',
    usage: reply.usage || null,
    budget: reply.budget || null,
    compacted: Boolean(reply.compacted),
  };
}

async function requestProfileFromLlm(fingerprints = []) {
  const body = fingerprints
    .map((item, index) => [
      `文章 ${index + 1}：${item.file_title || item.file_path || item.file_id || '未命名'}`,
      `句法：${item.sentence_style || ''}`,
      `语气：${item.tone || ''}`,
      `结构：${item.structure || ''}`,
      `词汇：${item.vocabulary || ''}`,
      `修辞：${item.rhetoric || ''}`,
      `标志表达：${(item.signature_phrases || []).join(' / ')}`,
    ].join('\n'))
    .join('\n\n');
  const prompt = [
    {
      role: 'system',
      content: [
        '你是一位写作风格归纳助手。',
        '请把多篇文章的风格特征合并成一份统一画像。',
        '输出 JSON，格式为 {"summary":"...","sentence_style":"...","tone":"...","structure":"...","vocabulary":"...","rhetoric":"...","signature_phrases":["..."]}。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `请基于这些文章风格指纹整理统一画像：\n\n${body}`,
    },
  ];
  const reply = await completeChat(prompt, {
    taskType: 'style_profile',
    temperature: 0.1,
    responseFormat: { type: 'json_object' },
    model: getCurrentStyleModel(),
  });
  try {
    const parsed = JSON.parse(reply.message?.content || '{}');
    return {
      profile: {
        summary: String(parsed.summary || '').trim(),
        sentence_style: String(parsed.sentence_style || '').trim(),
        tone: String(parsed.tone || '').trim(),
        structure: String(parsed.structure || '').trim(),
        vocabulary: String(parsed.vocabulary || '').trim(),
        rhetoric: String(parsed.rhetoric || '').trim(),
        signature_phrases: parseSignaturePhrases(parsed.signature_phrases),
      },
      raw: reply.message?.content || '',
    };
  } catch {
    return { profile: null, raw: reply.message?.content || '' };
  }
}

function buildProfileLocal(fingerprints = []) {
  if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
    return {
      summary: '',
      sentence_style: '',
      tone: '',
      structure: '',
      vocabulary: '',
      rhetoric: '',
      signature_phrases: [],
    };
  }
  const mergedPhrases = [...new Set(
    fingerprints.flatMap((item) => parseSignaturePhrases(item.signature_phrases)).slice(0, 8)
  )].slice(0, 8);
  const sample = fingerprints[0];
  return {
    summary: `整体风格以${sample.tone || '直接表达'}和${sample.structure || '清晰说明'}为主，写作目标是保留作者本人表达习惯。`,
    sentence_style: sample.sentence_style || '',
    tone: sample.tone || '',
    structure: sample.structure || '',
    vocabulary: sample.vocabulary || '',
    rhetoric: sample.rhetoric || '',
    signature_phrases: mergedPhrases,
  };
}

function upsertFingerprintRecord({
  fileId,
  fileHash,
  fingerprint,
  rawResponse = '',
  status = 'completed',
  retryCount = 0,
  lastError = null,
  modelUsed = '',
} = {}) {
  const database = getDb();
  database.prepare(`
    INSERT INTO style_fingerprints (
      file_id, file_hash, sentence_style, tone, structure, vocabulary, rhetoric,
      signature_phrases_json, raw_response, status, retry_count, last_error, model_used, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(file_id) DO UPDATE SET
      file_hash = excluded.file_hash,
      sentence_style = excluded.sentence_style,
      tone = excluded.tone,
      structure = excluded.structure,
      vocabulary = excluded.vocabulary,
      rhetoric = excluded.rhetoric,
      signature_phrases_json = excluded.signature_phrases_json,
      raw_response = excluded.raw_response,
      status = excluded.status,
      retry_count = excluded.retry_count,
      last_error = excluded.last_error,
      model_used = excluded.model_used,
      updated_at = excluded.updated_at
  `).run(
    normalizeNullablePositiveInt(fileId),
    String(fileHash || ''),
    String(fingerprint?.sentence_style || '').trim(),
    String(fingerprint?.tone || '').trim(),
    String(fingerprint?.structure || '').trim(),
    String(fingerprint?.vocabulary || '').trim(),
    String(fingerprint?.rhetoric || '').trim(),
    JSON.stringify(parseSignaturePhrases(fingerprint?.signature_phrases)),
    rawResponse || '',
    status,
    Math.max(0, Number(retryCount) || 0),
    lastError || null,
    modelUsed || ''
  );
}

function getFingerprintByFileId(fileId) {
  const database = getDb();
  const row = database.prepare(`
    SELECT *
    FROM style_fingerprints
    WHERE file_id = ?
  `).get(normalizeNullablePositiveInt(fileId));
  return formatFingerprintRow(row);
}

function listCompletedFingerprints(fileIds = null) {
  const database = getDb();
  const normalizedIds = Array.isArray(fileIds)
    ? fileIds.map((item) => normalizeNullablePositiveInt(item)).filter(Boolean)
    : [];
  const rows = database.prepare(`
    SELECT sf.*, f.title AS file_title, f.path AS file_path
    FROM style_fingerprints sf
    JOIN files f ON f.id = sf.file_id
    WHERE sf.status = 'completed'
      ${normalizedIds.length > 0 ? `AND sf.file_id IN (${normalizedIds.map(() => '?').join(',')})` : ''}
    ORDER BY sf.updated_at DESC, sf.id DESC
  `).all(...normalizedIds);
  return rows.map((row) => ({
    ...formatFingerprintRow(row),
    file_title: row.file_title || '',
    file_path: row.file_path || '',
  }));
}

function getStyleProfile() {
  const database = getDb();
  const row = database.prepare(`
    SELECT *
    FROM style_profile
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.summary_json || '{}');
    return {
      id: Number(row.id),
      source_count: Number(row.source_count || 0),
      updated_at: row.updated_at || null,
      ...parsed,
    };
  } catch {
    return null;
  }
}

function upsertStyleProfile(profile = {}, sourceCount = 0) {
  const database = getDb();
  database.prepare(`
    INSERT INTO style_profile (summary_json, source_count, updated_at)
    VALUES (?, ?, datetime('now'))
  `).run(JSON.stringify(profile), Math.max(0, Number(sourceCount) || 0));
  database.prepare(`
    DELETE FROM style_profile
    WHERE id NOT IN (
      SELECT id FROM style_profile ORDER BY updated_at DESC, id DESC LIMIT 1
    )
  `).run();
  return getStyleProfile();
}

async function buildStyleProfile({ force = false } = {}) {
  const fingerprints = listCompletedFingerprints();
  if (fingerprints.length === 0) return null;
  if (!force && fingerprints.length > 5 && fingerprints.length % 5 !== 0 && getStyleProfile()) {
    return getStyleProfile();
  }
  try {
    const { profile } = await requestProfileFromLlm(fingerprints);
    if (profile?.summary || profile?.sentence_style) {
      return upsertStyleProfile(profile, fingerprints.length);
    }
  } catch (error) {
    logger.warn('style.profile.llm_failed', { error });
  }
  return upsertStyleProfile(buildProfileLocal(fingerprints), fingerprints.length);
}

async function extractFingerprintForFile(fileId, options = {}) {
  const normalizedFileId = normalizeNullablePositiveInt(fileId);
  if (!normalizedFileId) return { ok: false, skipped: true };
  const file = options.file || getFileById(normalizedFileId);
  if (!file?.content) return { ok: false, skipped: true };
  const chunks = Array.isArray(options.chunks) && options.chunks.length > 0
    ? options.chunks
    : getWritableChunksForFile(normalizedFileId);
  const fileHash = options.fileHash || sha256(String(file.content || ''));

  if (!isStyleEligible({ chunks, content: file.content })) {
    upsertFingerprintRecord({
      fileId: normalizedFileId,
      fileHash,
      fingerprint: extractFingerprintLocal(file.content),
      rawResponse: '',
      status: 'skipped',
      retryCount: 0,
      lastError: null,
      modelUsed: 'local',
    });
    return { ok: true, skipped: true, status: 'skipped' };
  }

  const existing = getFingerprintByFileId(normalizedFileId);
  if (!options.force && existing?.file_hash && existing.file_hash === fileHash && existing.status === 'completed') {
    return { ok: true, skipped: true, status: 'completed' };
  }

  try {
    const { fingerprint, raw } = await requestFingerprintFromLlm(file.content);
    const finalFingerprint = fingerprint || extractFingerprintLocal(file.content);
    upsertFingerprintRecord({
      fileId: normalizedFileId,
      fileHash,
      fingerprint: finalFingerprint,
      rawResponse: raw,
      status: 'completed',
      retryCount: 0,
      lastError: null,
      modelUsed: getCurrentStyleModel(),
    });
    await buildStyleProfile();
    return { ok: true, skipped: false, status: 'completed', fingerprint: finalFingerprint };
  } catch (error) {
    const nextRetry = Math.min(3, Number(existing?.retry_count || 0) + 1);
    const fallback = extractFingerprintLocal(file.content);
    upsertFingerprintRecord({
      fileId: normalizedFileId,
      fileHash,
      fingerprint: fallback,
      rawResponse: '',
      status: nextRetry >= 3 ? 'failed' : 'pending',
      retryCount: nextRetry,
      lastError: error.message,
      modelUsed: 'local-fallback',
    });
    logger.warn('style.fingerprint.failed', { file_id: normalizedFileId, error });
    return { ok: false, skipped: false, status: nextRetry >= 3 ? 'failed' : 'pending', error };
  }
}

function enqueueStyleExtraction(fileId, options = {}) {
  const normalizedFileId = normalizeNullablePositiveInt(fileId);
  if (!normalizedFileId) return;
  const config = getEffectiveConfig();
  if (!config.canvasEnableStyleExtraction) return;
  if (queuedIds.has(normalizedFileId)) return;
  queue.push({ fileId: normalizedFileId, options });
  queuedIds.add(normalizedFileId);
  void drainStyleQueue();
}

async function drainStyleQueue() {
  if (processing || paused) return;
  const config = getEffectiveConfig();
  if (!config.canvasEnableStyleExtraction) return;
  const next = queue.shift();
  if (!next) return;
  processing = true;
  queuedIds.delete(next.fileId);
  try {
    await extractFingerprintForFile(next.fileId, next.options);
  } finally {
    processing = false;
    if (queue.length > 0) {
      setTimeout(() => {
        void drainStyleQueue();
      }, 0);
    }
  }
}

function listBackfillCandidates(limit = STYLE_BACKFILL_BATCH_SIZE) {
  const database = getDb();
  const rows = database.prepare(`
    SELECT f.id
    FROM files f
    LEFT JOIN style_fingerprints sf ON sf.file_id = f.id
    WHERE f.indexed = 1
      AND (
        sf.file_id IS NULL
        OR sf.file_hash IS NULL
        OR sf.file_hash != f.hash
        OR sf.status IN ('pending', 'failed')
      )
    ORDER BY f.updated_at ASC, f.id ASC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || STYLE_BACKFILL_BATCH_SIZE));
  return rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
}

function fillBacklog(limit = STYLE_BACKFILL_BATCH_SIZE) {
  if (paused) return;
  const config = getEffectiveConfig();
  if (!config.canvasEnableStyleExtraction) return;
  listBackfillCandidates(limit).forEach((fileId) => enqueueStyleExtraction(fileId));
}

function startStyleBackgroundWorkers() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    fillBacklog();
  }, STYLE_BACKFILL_INTERVAL_MS);
  if (schedulerTimer.unref) schedulerTimer.unref();
  fillBacklog();
}

function setStyleBackfillPaused(nextPaused) {
  paused = Boolean(nextPaused);
  if (!paused) void drainStyleQueue();
}

async function getStyleContext(topic, options = {}) {
  const profile = getStyleProfile();
  const normalizedTopic = String(topic || options.articleTitle || '').trim();
  const manualFileIds = Array.isArray(options.styleFileIds)
    ? options.styleFileIds.map((item) => normalizeNullablePositiveInt(item)).filter(Boolean)
    : [];
  let candidateChunks = [];

  if (manualFileIds.length > 0) {
    candidateChunks = normalizedTopic
      ? await hybridSearch(normalizedTopic, { topK: 6, fileIds: manualFileIds })
      : [];
  } else if (normalizedTopic) {
    const preferred = options.activeFileId
      ? await hybridSearch(normalizedTopic, { topK: 3, fileIds: [options.activeFileId], vecThreshold: 0.2 })
      : [];
    const supplemental = await hybridSearch(normalizedTopic, { topK: 4 });
    const byKey = new Map();
    [...preferred, ...supplemental].forEach((chunk) => {
      if (!chunk) return;
      const key = chunk.chunk_id || `${chunk.file_id}:${chunk.heading_path}:${chunk.preview}`;
      if (!byKey.has(key)) byKey.set(key, chunk);
    });
    candidateChunks = [...byKey.values()].slice(0, 6);
  }

  const filteredFileIds = [...new Set(candidateChunks.map((chunk) => normalizeNullablePositiveInt(chunk.file_id)).filter(Boolean))].slice(0, 4);
  const fingerprints = filteredFileIds.length > 0
    ? listCompletedFingerprints(filteredFileIds).slice(0, 2)
    : [];
  const dimensions = fingerprints.length > 0
    ? buildProfileLocal(fingerprints)
    : (profile || buildProfileLocal([]));
  const referenceExcerpts = candidateChunks.slice(0, 3).map((chunk, index) => ({
    key: chunk.chunk_id || `${chunk.file_id}-${index}`,
    file_id: chunk.file_id || null,
    file_title: chunk.file_title || '',
    heading_path: chunk.heading_path || '',
    content: trimTextToTokenBudget(chunk.content || chunk.preview || '', 160),
  }));

  return {
    mode: manualFileIds.length > 0 ? 'manual' : 'auto',
    profile,
    dimensions: {
      sentence_style: dimensions?.sentence_style || profile?.sentence_style || '',
      tone: dimensions?.tone || profile?.tone || '',
      structure: dimensions?.structure || profile?.structure || '',
      vocabulary: dimensions?.vocabulary || profile?.vocabulary || '',
      rhetoric: dimensions?.rhetoric || profile?.rhetoric || '',
    },
    signature_phrases: [
      ...new Set([
        ...(parseSignaturePhrases(dimensions?.signature_phrases)),
        ...(parseSignaturePhrases(profile?.signature_phrases)),
      ]),
    ].slice(0, 8),
    reference_excerpts: referenceExcerpts,
    fingerprints,
    source_file_ids: filteredFileIds,
  };
}

module.exports = {
  STYLE_ELIGIBLE_TYPES,
  buildStyleProfile,
  extractFingerprintForFile,
  extractFingerprintLocal,
  enqueueStyleExtraction,
  getFingerprintByFileId,
  getStyleContext,
  getStyleProfile,
  isStyleEligible,
  listCompletedFingerprints,
  listBackfillCandidates,
  setStyleBackfillPaused,
  startStyleBackgroundWorkers,
};
