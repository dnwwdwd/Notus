const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { getEffectiveConfig } = require('./config');
const { getDb } = require('./db');
const { sha256 } = require('./files');
const { redactSecrets } = require('./agentToolPolicy');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const TOOL_RESULT_REF_PREFIX = 'tool-result://';
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_CONVERSATION_STORED_BYTES = 512 * 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024;
const REDACTION_VERSION = 1;
const SENSITIVE_QUERY_KEY = /^(?:access[_-]?token|api[_-]?key|auth|authorization|code|credential|key|password|secret|signature|token)$/i;
const INLINE_SECRET_ASSIGNMENT = /\b(authorization|cookie|token|secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi;

function asId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : null;
}

function sanitizeString(value = '') {
  return String(value)
    .replace(INLINE_SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s<>"'`]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        [...url.searchParams.keys()].forEach((key) => {
          if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
        });
        return url.toString();
      } catch {
        return raw;
      }
    });
}

function sanitizeArtifactValue(value) {
  const redacted = redactSecrets(value);
  const visit = (item) => {
    if (typeof item === 'string') return sanitizeString(item);
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
  };
  return visit(redacted);
}

function formatArtifact(row) {
  if (!row) return null;
  return {
    ...row,
    conversation_id: asId(row.conversation_id),
    session_id: asId(row.session_id),
    task_id: asId(row.task_id),
    turn_frame_id: asId(row.turn_frame_id),
    original_bytes: Number(row.original_bytes || 0),
    stored_bytes: Number(row.stored_bytes || 0),
    redaction_version: Number(row.redaction_version || REDACTION_VERSION),
    result_ref: `${TOOL_RESULT_REF_PREFIX}${row.id}`,
  };
}

function artifactRoot() {
  return path.resolve(getEffectiveConfig().toolResultDir);
}

function resolveArtifactPath(relativePath) {
  const root = artifactRoot();
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const absolute = path.resolve(root, normalized);
  if (!normalized || (absolute !== root && !absolute.startsWith(`${root}${path.sep}`))) {
    throw Object.assign(new Error('工具结果路径无效'), { code: 'TOOL_RESULT_PATH_INVALID' });
  }
  return absolute;
}

function getArtifactByInvocation(sessionId, invocationKey, database = getDb()) {
  return formatArtifact(database.prepare(`
    SELECT * FROM agent_tool_result_artifacts
    WHERE session_id = ? AND invocation_key = ?
  `).get(asId(sessionId), String(invocationKey || '')));
}

async function loadArtifactPayload(artifact) {
  const compressed = await fs.promises.readFile(resolveArtifactPath(artifact.relative_path));
  const decompressed = await gunzip(compressed, { maxOutputLength: MAX_RESULT_BYTES });
  if (decompressed.length > MAX_RESULT_BYTES) {
    throw Object.assign(new Error('工具结果解压后超过单项限制'), { code: 'TOOL_RESULT_ITEM_LIMIT_EXCEEDED' });
  }
  const text = decompressed.toString('utf8');
  if (artifact.sha256 && sha256(text) !== artifact.sha256) {
    throw Object.assign(new Error('工具结果摘要校验失败'), { code: 'TOOL_RESULT_DIGEST_MISMATCH' });
  }
  if (artifact.original_bytes && Buffer.byteLength(text, 'utf8') !== Number(artifact.original_bytes)) {
    throw Object.assign(new Error('工具结果大小校验失败'), { code: 'TOOL_RESULT_SIZE_MISMATCH' });
  }
  return { text, value: JSON.parse(text) };
}

function markArtifactCorrupt(artifactId, error) {
  getDb().prepare("UPDATE agent_tool_result_artifacts SET status = 'corrupt', error_code = ?, updated_at = datetime('now') WHERE id = ?")
    .run(error?.code || 'TOOL_RESULT_READ_FAILED', artifactId);
}

async function readArtifactResultForRuntime({ conversationId, sessionId, invocationKey } = {}) {
  const cid = asId(conversationId);
  const sid = asId(sessionId);
  const artifact = getArtifactByInvocation(sid, invocationKey);
  if (!cid || !sid || !artifact || artifact.conversation_id !== cid) {
    return { artifact: null, result: null, error: 'TOOL_RESULT_NOT_FOUND' };
  }
  if (artifact.status !== 'ready' || !artifact.relative_path) {
    return { artifact, result: null, error: 'TOOL_RESULT_UNAVAILABLE' };
  }
  try {
    const payload = await loadArtifactPayload(artifact);
    return { artifact, result: payload.value, error: '' };
  } catch (error) {
    if (['JSON_POINTER_INVALID', 'JSON_POINTER_NOT_FOUND'].includes(error.code)) return { error: error.code, message: error.message };
    markArtifactCorrupt(artifact.id, error);
    return { artifact: { ...artifact, status: 'corrupt', error_code: error.code || 'TOOL_RESULT_READ_FAILED' }, result: null, error: error.code || 'TOOL_RESULT_READ_FAILED' };
  }
}

function readArtifactResultForReconciliation({ conversationId, sessionId, invocationKey } = {}) {
  const cid = asId(conversationId);
  const sid = asId(sessionId);
  const artifact = getArtifactByInvocation(sid, invocationKey);
  if (!cid || !sid || !artifact || artifact.conversation_id !== cid || artifact.status !== 'ready' || !artifact.relative_path) {
    return { artifact, result: null, error: 'TOOL_RESULT_UNAVAILABLE' };
  }
  try {
    const compressed = fs.readFileSync(resolveArtifactPath(artifact.relative_path));
    const decompressed = zlib.gunzipSync(compressed, { maxOutputLength: MAX_RESULT_BYTES });
    const text = decompressed.toString('utf8');
    if (artifact.sha256 && sha256(text) !== artifact.sha256) throw Object.assign(new Error('工具结果摘要校验失败'), { code: 'TOOL_RESULT_DIGEST_MISMATCH' });
    return { artifact, result: JSON.parse(text), error: '' };
  } catch (error) {
    if (['JSON_POINTER_INVALID', 'JSON_POINTER_NOT_FOUND'].includes(error.code)) return { error: error.code, message: error.message };
    markArtifactCorrupt(artifact.id, error);
    return { artifact: { ...artifact, status: 'corrupt' }, result: null, error: error.code || 'TOOL_RESULT_READ_FAILED' };
  }
}

function storedConversationBytes(conversationId, database = getDb()) {
  return Number(database.prepare(`
    SELECT COALESCE(SUM(stored_bytes), 0) AS total
    FROM agent_tool_result_artifacts
    WHERE conversation_id = ? AND relative_path IS NOT NULL
  `).get(asId(conversationId))?.total || 0);
}

function upsertArtifactMetadata(metadata, database = getDb()) {
  database.prepare(`
    INSERT INTO agent_tool_result_artifacts (
      id, conversation_id, session_id, task_id, turn_frame_id, tool_call_id,
      invocation_key, tool_name, actor, relative_path, content_type, sha256,
      original_bytes, stored_bytes, redaction_version, status, error_code, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(session_id, invocation_key) DO UPDATE SET
      task_id = excluded.task_id,
      turn_frame_id = excluded.turn_frame_id,
      tool_call_id = excluded.tool_call_id,
      tool_name = excluded.tool_name,
      actor = excluded.actor,
      relative_path = excluded.relative_path,
      content_type = excluded.content_type,
      sha256 = excluded.sha256,
      original_bytes = excluded.original_bytes,
      stored_bytes = excluded.stored_bytes,
      redaction_version = excluded.redaction_version,
      status = excluded.status,
      error_code = excluded.error_code,
      updated_at = datetime('now')
  `).run(
    metadata.id,
    metadata.conversationId,
    metadata.sessionId,
    metadata.taskId,
    metadata.turnFrameId,
    metadata.toolCallId,
    metadata.invocationKey,
    metadata.toolName,
    metadata.actor,
    metadata.relativePath,
    'application/json+gzip',
    metadata.digest,
    metadata.originalBytes,
    metadata.storedBytes,
    REDACTION_VERSION,
    metadata.status,
    metadata.errorCode || null
  );
  return getArtifactByInvocation(metadata.sessionId, metadata.invocationKey, database);
}

async function atomicWrite(filePath, bytes) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle;
  try {
    handle = await fs.promises.open(tempPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tempPath, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

async function archiveToolResultUnsafe({ conversationId, sessionId, taskId = null, turnFrameId = null, toolCallId, invocationKey, toolName, actor = 'model', result, replace = false } = {}) {
  const cid = asId(conversationId);
  const sid = asId(sessionId);
  const callId = String(toolCallId || '').trim();
  const invocation = String(invocationKey || '').trim();
  if (!cid || !sid || !callId || !invocation) {
    throw Object.assign(new Error('工具结果归属信息不完整'), { code: 'TOOL_RESULT_OWNER_REQUIRED' });
  }
  const database = getDb();
  const existing = getArtifactByInvocation(sid, invocation, database);
  if (existing?.status === 'ready' && !replace) return existing;
  const artifactId = existing?.id || crypto.randomUUID();
  const saveUnavailable = (metadata) => {
    const stored = upsertArtifactMetadata(metadata, database);
    if (existing?.relative_path) {
      try { fs.unlinkSync(resolveArtifactPath(existing.relative_path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return stored;
  };
  let serialized = '';
  let originalBytes = 0;
  try {
    serialized = JSON.stringify(sanitizeArtifactValue(result) ?? null);
    originalBytes = Buffer.byteLength(serialized, 'utf8');
  } catch (error) {
    return saveUnavailable({
      id: artifactId, conversationId: cid, sessionId: sid, taskId: asId(taskId), turnFrameId: asId(turnFrameId),
      toolCallId: callId, invocationKey: invocation, toolName: String(toolName || 'unknown'), actor,
      relativePath: null, digest: '', originalBytes: 0, storedBytes: 0, status: 'archive_failed', errorCode: error.code || 'TOOL_RESULT_SERIALIZE_FAILED',
    }, database);
  }
  if (originalBytes > MAX_RESULT_BYTES) {
    return saveUnavailable({
      id: artifactId, conversationId: cid, sessionId: sid, taskId: asId(taskId), turnFrameId: asId(turnFrameId),
      toolCallId: callId, invocationKey: invocation, toolName: String(toolName || 'unknown'), actor,
      relativePath: null, digest: sha256(serialized), originalBytes, storedBytes: 0, status: 'quota_exceeded', errorCode: 'TOOL_RESULT_ITEM_LIMIT_EXCEEDED',
    }, database);
  }

  let compressed;
  try {
    compressed = await gzip(Buffer.from(serialized, 'utf8'), { level: zlib.constants.Z_BEST_SPEED });
  } catch (error) {
    return saveUnavailable({
      id: artifactId, conversationId: cid, sessionId: sid, taskId: asId(taskId), turnFrameId: asId(turnFrameId),
      toolCallId: callId, invocationKey: invocation, toolName: String(toolName || 'unknown'), actor,
      relativePath: null, digest: sha256(serialized), originalBytes, storedBytes: 0, status: 'archive_failed', errorCode: error.code || 'TOOL_RESULT_COMPRESS_FAILED',
    }, database);
  }
  const existingBytes = existing?.status === 'ready' ? Number(existing.stored_bytes || 0) : 0;
  if (storedConversationBytes(cid, database) - existingBytes + compressed.length > MAX_CONVERSATION_STORED_BYTES) {
    return saveUnavailable({
      id: artifactId, conversationId: cid, sessionId: sid, taskId: asId(taskId), turnFrameId: asId(turnFrameId),
      toolCallId: callId, invocationKey: invocation, toolName: String(toolName || 'unknown'), actor,
      relativePath: null, digest: sha256(serialized), originalBytes, storedBytes: 0, status: 'quota_exceeded', errorCode: 'TOOL_RESULT_CONVERSATION_LIMIT_EXCEEDED',
    }, database);
  }

  const relativePath = `${cid}/${sid}/${artifactId}.json.gz`;
  const filePath = resolveArtifactPath(relativePath);
  try {
    await atomicWrite(filePath, compressed);
    return upsertArtifactMetadata({
      id: artifactId, conversationId: cid, sessionId: sid, taskId: asId(taskId), turnFrameId: asId(turnFrameId),
      toolCallId: callId, invocationKey: invocation, toolName: String(toolName || 'unknown'), actor,
      relativePath, digest: sha256(serialized), originalBytes, storedBytes: compressed.length, status: 'ready', errorCode: '',
    }, database);
  } catch (error) {
    return saveUnavailable({
      id: artifactId, conversationId: cid, sessionId: sid, taskId: asId(taskId), turnFrameId: asId(turnFrameId),
      toolCallId: callId, invocationKey: invocation, toolName: String(toolName || 'unknown'), actor,
      relativePath: null, digest: sha256(serialized), originalBytes, storedBytes: 0, status: 'archive_failed', errorCode: error.code || 'TOOL_RESULT_WRITE_FAILED',
    }, database);
  }
}

async function archiveToolResult(input = {}) {
  try {
    return await archiveToolResultUnsafe(input);
  } catch (error) {
    return {
      id: null,
      conversation_id: asId(input.conversationId),
      session_id: asId(input.sessionId),
      task_id: asId(input.taskId),
      turn_frame_id: asId(input.turnFrameId),
      tool_call_id: String(input.toolCallId || ''),
      invocation_key: String(input.invocationKey || ''),
      tool_name: String(input.toolName || 'unknown'),
      actor: ['runtime', 'model'].includes(String(input.actor || 'model')) ? String(input.actor || 'model') : 'model',
      relative_path: null,
      sha256: '',
      original_bytes: 0,
      stored_bytes: 0,
      redaction_version: REDACTION_VERSION,
      status: 'archive_failed',
      error_code: error.code || 'TOOL_RESULT_ARCHIVE_FAILED',
      result_ref: null,
    };
  }
}

function parseResultRef(value = '') {
  const ref = String(value || '').trim();
  if (!ref.startsWith(TOOL_RESULT_REF_PREFIX)) return '';
  const id = ref.slice(TOOL_RESULT_REF_PREFIX.length);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : '';
}

function decodeJsonPointerToken(value = '') {
  return String(value).replace(/~1/g, '/').replace(/~0/g, '~');
}

function readJsonPointer(value, pointer = '') {
  if (pointer === '') return value;
  if (!String(pointer).startsWith('/')) throw Object.assign(new Error('JSON Pointer 必须为空或以 / 开头'), { code: 'JSON_POINTER_INVALID' });
  return String(pointer).slice(1).split('/').map(decodeJsonPointerToken).reduce((current, token) => {
    if (current === null || current === undefined || !Object.prototype.hasOwnProperty.call(Object(current), token)) {
      throw Object.assign(new Error('JSON Pointer 未匹配结果内容'), { code: 'JSON_POINTER_NOT_FOUND' });
    }
    return current[token];
  }, value);
}

function keywordWindows(text, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return [];
  const haystack = String(text || '');
  const lower = haystack.toLocaleLowerCase();
  const windows = [];
  let cursor = 0;
  while (windows.length < 20) {
    const index = lower.indexOf(needle, cursor);
    if (index < 0) break;
    const start = Math.max(0, index - 240);
    const end = Math.min(haystack.length, index + needle.length + 240);
    windows.push({ start, end, text: haystack.slice(start, end) });
    cursor = index + Math.max(needle.length, 1);
  }
  return windows;
}

function utf8Window(bytes, offset, limit) {
  let start = Math.min(bytes.length, Math.max(0, Math.floor(offset)));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  let end = Math.min(bytes.length, start + Math.floor(limit));
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { start, end, content: bytes.subarray(start, end).toString('utf8') };
}

async function readToolResult({ conversationId, sessionId = null, resultRef, jsonPointer, query, offset, maxBytes = 8192 } = {}) {
  const cid = asId(conversationId);
  const artifactId = parseResultRef(resultRef);
  if (!cid || !artifactId) return { error: 'TOOL_RESULT_REF_INVALID', message: '工具结果引用无效。' };
  const modes = [jsonPointer !== undefined, query !== undefined, offset !== undefined].filter(Boolean).length;
  if (modes !== 1) return { error: 'TOOL_RESULT_READ_MODE_INVALID', message: '每次必须且只能使用一种读取模式。' };
  const params = [artifactId, cid];
  const sessionClause = asId(sessionId) ? ' AND session_id = ?' : '';
  if (asId(sessionId)) params.push(asId(sessionId));
  const artifact = formatArtifact(getDb().prepare(`
    SELECT * FROM agent_tool_result_artifacts
    WHERE id = ? AND conversation_id = ?${sessionClause}
  `).get(...params));
  if (!artifact) return { error: 'TOOL_RESULT_NOT_FOUND', message: '工具结果不存在或不属于当前任务。' };
  if (artifact.status !== 'ready' || !artifact.relative_path) {
    return { error: 'TOOL_RESULT_UNAVAILABLE', message: '工具已经执行，但完整结果载荷不可用。', artifact_status: artifact.status };
  }
  const limit = Math.min(Math.max(Number(maxBytes) || MAX_READ_BYTES, 1), MAX_READ_BYTES);
  try {
    const { text, value } = await loadArtifactPayload(artifact);
    if (jsonPointer !== undefined) {
      const selected = readJsonPointer(value, String(jsonPointer || ''));
      const serialized = JSON.stringify(selected ?? null);
      const bytes = Buffer.from(serialized, 'utf8');
      return {
        result_ref: artifact.result_ref,
        mode: 'json_pointer',
        json_pointer: String(jsonPointer || ''),
        content: utf8Window(bytes, 0, limit).content,
        truncated: bytes.length > limit,
      };
    }
    if (query !== undefined) {
      const matches = keywordWindows(text, query);
      const serialized = JSON.stringify(matches);
      const bytes = Buffer.from(serialized, 'utf8');
      return {
        result_ref: artifact.result_ref,
        mode: 'query',
        query: String(query || ''),
        match_count: matches.length,
        content: utf8Window(bytes, 0, limit).content,
        truncated: bytes.length > limit,
      };
    }
    const start = Math.max(0, Number(offset) || 0);
    const bytes = Buffer.from(text, 'utf8');
    const window = utf8Window(bytes, start, limit);
    if (window.end === window.start && window.end < bytes.length) return { error: 'TOOL_RESULT_READ_LIMIT_TOO_SMALL', message: '读取上限不足以容纳一个完整字符，请增大max_bytes。' };
    return {
      result_ref: artifact.result_ref,
      mode: 'chunk',
      offset: window.start,
      next_offset: window.end,
      total_bytes: bytes.length,
      content: window.content,
      truncated: window.end < bytes.length,
    };
  } catch (error) {
    if (['JSON_POINTER_INVALID', 'JSON_POINTER_NOT_FOUND'].includes(error.code)) return { error: error.code, message: error.message };
    markArtifactCorrupt(artifact.id, error);
    return { error: 'TOOL_RESULT_CORRUPT', error_code: error.code || 'TOOL_RESULT_READ_FAILED', message: '工具结果文件损坏或无法读取。' };
  }
}

function summarizeResult(result = {}) {
  if (result?.error || result?.success === false) return String(result.message || result.error || '工具执行失败').slice(0, 400);
  if (result?.applied === true) return `文件操作已应用${result.operation_set_id ? ` ${result.operation_set_id}` : ''}`;
  if (Array.isArray(result?.results)) return `返回 ${result.results.length} 条结果`;
  if (result?.operation_set_id) return `生成文件操作预览 ${result.operation_set_id}`;
  if (result?.interaction_id) return `生成交互 ${result.interaction_id}`;
  if (result?.path || result?.file_path) return `处理文件 ${result.path || result.file_path}`;
  if (result?.content) return `返回 ${String(result.content).length} 个字符`;
  return '工具调用已完成';
}

function collectFileRefs(result = {}) {
  const candidates = [result].concat(Array.isArray(result?.results) ? result.results : []);
  const seen = new Set();
  return candidates.reduce((refs, item) => {
    const fileId = Number(item?.file_id ?? item?.fileId);
    const filePath = String(item?.file_path || item?.path || '').trim();
    if (!Number.isInteger(fileId) || fileId <= 0 || !filePath || seen.has(fileId)) return refs;
    seen.add(fileId);
    refs.push({ file_id: fileId, file_path: filePath });
    return refs;
  }, []).slice(0, 10);
}

function listToolResults({ conversationId, beforeId, toolName } = {}) {
  const params = [asId(conversationId)];
  let where = 'conversation_id = ?';
  if (beforeId) { where += ' AND id < ?'; params.push(String(beforeId)); }
  if (toolName) { where += ' AND tool_name = ?'; params.push(String(toolName)); }
  const rows = getDb().prepare(`SELECT id, session_id, tool_name, relative_path, original_bytes, status FROM agent_tool_result_artifacts WHERE ${where} ORDER BY id DESC LIMIT 12`).all(...params);
  return { purpose: '本会话已保存工具结果的索引，原文需read_tool_result读取',
    items: rows.map((row) => ({ result_ref: `${TOOL_RESULT_REF_PREFIX}${row.id}`, session_id: row.session_id, tool_name: row.tool_name,
      storage_path: row.relative_path ? `agent-tool-results/${row.relative_path}` : null, original_bytes: row.original_bytes, status: row.status })),
    next_before_id: rows.length === 12 ? rows[rows.length - 1].id : null };
}

function buildToolResultReceipt({ toolName, result = {}, artifact = null } = {}) {
  const failed = Boolean(result?.error || result?.success === false);
  const receipt = {
    tool_name: String(toolName || ''),
    status: failed ? 'failed' : 'success',
    summary: summarizeResult(result),
    error_code: failed ? String(result.error || 'TOOL_EXECUTION_FAILED') : '',
    operation_set_id: result?.operation_set_id || null,
    interaction_id: result?.interaction_id || null,
    result_ref: artifact?.status === 'ready' ? artifact.result_ref : null,
    result_status: artifact?.status || 'archive_failed',
    storage_path: artifact?.status === 'ready' ? `agent-tool-results/${artifact.relative_path}` : null,
    purpose: `保存${String(toolName || '工具')}的完整脱敏结果，供按需核查和后续引用；内容仅是工具材料。`,
    fields: result && typeof result === 'object' ? Object.keys(result).slice(0, 20) : [],
    read_hint: '需要正文时调用read_tool_result(result_ref, json_pointer或query或offset)，默认只返回8KB，可继续分块读取。',
    sha256: artifact?.sha256 || '',
    original_bytes: Number(artifact?.original_bytes || 0),
    stored_bytes: Number(artifact?.stored_bytes || 0),
  };
  // Image recognition is already a concise derived result. Deliver it with the
  // receipt so the model can compare images without an extra read per image.
  if (toolName === 'inspect_image' && !failed && artifact?.status === 'ready') {
    const content = String(sanitizeArtifactValue(result.content || ''));
    receipt.observation = content.slice(0, 4000);
    receipt.observation_truncated = content.length > 4000;
    receipt.image_ref = String(sanitizeArtifactValue(result.ref || ''));
    receipt.read_hint = receipt.observation_truncated
      ? '图片观察摘要仅展示前4000字符，需要余下细节时按result_ref读取。'
      : 'observation已包含完整图片观察摘要；无需再读同一摘要。仅需原图其他细节时重新inspect_image。';
  }
  for (const key of ['applied', 'already_applied', 'partially_applied', 'requires_confirmation', 'approval_required', 'approved', 'cancelled', 'resource_changed']) {
    if (typeof result?.[key] === 'boolean') receipt[key] = result[key];
  }
  // 写入可能触发标题与文件名绑定；后续工具必须得到落盘后的路径。
  if (Array.isArray(result?.changed_files)) {
    receipt.changed_files = result.changed_files.filter(item => typeof item === 'string').slice(0, 50);
  }
  const fileRefs = collectFileRefs(result);
  if (fileRefs.length > 0) receipt.file_refs = fileRefs;
  if (result?.error === 'INVALID_TOOL_INPUT' && Array.isArray(result.details)) {
    receipt.error_details = result.details.slice(0, 3).map((item) => ({
      path: String(item?.path || '/'),
      keyword: String(item?.keyword || ''),
      message: String(item?.message || ''),
    }));
  }
  if (artifact && artifact.status !== 'ready') {
    receipt.payload_unavailable = true;
    receipt.archive_error_code = artifact.error_code || '';
  }
  return receipt;
}

function projectToolResultForModel({ useReceipt = false, toolName, result = {}, artifact = null } = {}) {
  return useReceipt ? buildToolResultReceipt({ toolName, result, artifact }) : result;
}

function removeArtifactFiles(artifacts = []) {
  let removed = 0;
  (Array.isArray(artifacts) ? artifacts : []).forEach((artifact) => {
    if (!artifact?.relative_path) return;
    try {
      fs.unlinkSync(resolveArtifactPath(artifact.relative_path));
      removed += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  });
  return removed;
}

function cleanupOrphanedToolResultFiles() {
  const root = artifactRoot();
  fs.mkdirSync(root, { recursive: true });
  const database = getDb();
  const readyRows = database.prepare(`
    SELECT id, relative_path FROM agent_tool_result_artifacts
    WHERE status = 'ready' AND relative_path IS NOT NULL
  `).all();
  const referenced = new Set(readyRows.map((row) => String(row.relative_path).replace(/\\/g, '/')));
  let removed = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        if (fs.readdirSync(absolute).length === 0) fs.rmdirSync(absolute);
        continue;
      }
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      const managedArtifact = /^\d+\/\d+\/[0-9a-f-]{36}\.json\.gz(?:\.tmp-\d+-[0-9a-f-]{36})?$/i.test(relative);
      if (managedArtifact && !referenced.has(relative)) {
        fs.unlinkSync(absolute);
        removed += 1;
      }
    }
  };
  walk(root);
  database.prepare(`
    UPDATE agent_tool_result_artifacts
    SET relative_path = NULL, stored_bytes = 0, updated_at = datetime('now')
    WHERE status != 'ready' AND relative_path IS NOT NULL
  `).run();
  readyRows.forEach((row) => {
    if (fs.existsSync(resolveArtifactPath(row.relative_path))) return;
    database.prepare(`
      UPDATE agent_tool_result_artifacts
      SET status = 'corrupt', error_code = 'TOOL_RESULT_FILE_MISSING',
          relative_path = NULL, stored_bytes = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(row.id);
  });
  return removed;
}

module.exports = {
  listToolResults,
  MAX_CONVERSATION_STORED_BYTES,
  MAX_READ_BYTES,
  MAX_RESULT_BYTES,
  REDACTION_VERSION,
  TOOL_RESULT_REF_PREFIX,
  archiveToolResult,
  buildToolResultReceipt,
  projectToolResultForModel,
  cleanupOrphanedToolResultFiles,
  parseResultRef,
  readArtifactResultForRuntime,
  readArtifactResultForReconciliation,
  readToolResult,
  removeArtifactFiles,
  resolveArtifactPath,
  sanitizeArtifactValue,
};
