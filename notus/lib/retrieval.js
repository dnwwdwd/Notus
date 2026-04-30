const { getDb, isVecAvailable } = require('./db');
const { getEmbedding } = require('./embeddings');
const { getEffectiveConfig } = require('./config');
const { buildFtsQuery } = require('./tokenizer');
const { buildImageProxyUrl } = require('./images');

function rrfScore(rank, k) {
  return 1 / (k + rank);
}

function distanceToSimilarity(distance) {
  if (distance === null || distance === undefined) return null;
  return Math.max(0, 1 - Number(distance));
}

function classifySource(item) {
  if (item.image_rank && !item.vec_rank && !item.fts_rank) return 'image_vec';
  if (item.vec_rank && item.fts_rank) return 'hybrid';
  if (item.vec_rank) return 'vec_only';
  if (item.fts_rank) return 'fts_only';
  if (item.image_rank) return 'image_vec';
  return 'fts_only';
}

function normalizeFileIds(value) {
  const input = Array.isArray(value) ? value : [];
  const normalized = [...new Set(input.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0))];
  return normalized;
}

function normalizePositiveId(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? next : null;
}

async function queryEmbedding(query) {
  try {
    return await getEmbedding(query);
  } catch {
    return null;
  }
}

function chunkVectorSearch(db, embedding, topK, threshold) {
  if (!embedding || !isVecAvailable()) return [];
  return db.prepare(`
    SELECT chunk_id, distance
    FROM chunks_vec
    WHERE embedding MATCH ?
      AND k = ?
  `).all(JSON.stringify(embedding), topK * 2)
    .map((row, index) => ({
      chunk_id: row.chunk_id,
      distance: row.distance,
      vec_score: distanceToSimilarity(row.distance),
      vec_rank: index + 1,
    }))
    .filter((row) => row.vec_score === null || row.vec_score >= threshold);
}

function imageVectorSearch(db, embedding, topK, threshold) {
  if (!embedding || !isVecAvailable()) return [];
  return db.prepare(`
    SELECT image_id, distance
    FROM images_vec
    WHERE embedding MATCH ?
      AND k = ?
  `).all(JSON.stringify(embedding), topK * 2)
    .map((row, index) => ({
      image_id: row.image_id,
      image_vec_score: distanceToSimilarity(row.distance),
      image_rank: index + 1,
    }))
    .filter((row) => row.image_vec_score === null || row.image_vec_score >= threshold);
}

function ftsSearch(db, query, topK) {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    return db.prepare(`
      SELECT rowid AS chunk_id, bm25(chunks_fts) AS rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, topK * 2).map((row, index) => ({
      chunk_id: row.chunk_id,
      fts_rank: index + 1,
      fts_score: row.rank,
    }));
  } catch {
    return [];
  }
}

function mergeTextCandidates(byChunk, vecRows, ftsRows, rrfK) {
  vecRows.forEach((row) => {
    byChunk.set(row.chunk_id, {
      chunk_id: row.chunk_id,
      vec_rank: row.vec_rank,
      vec_score: row.vec_score,
      score: rrfScore(row.vec_rank, rrfK),
    });
  });

  ftsRows.forEach((row) => {
    const current = byChunk.get(row.chunk_id) || {
      chunk_id: row.chunk_id,
      score: 0,
    };
    current.fts_rank = row.fts_rank;
    current.fts_score = row.fts_score;
    current.score += rrfScore(row.fts_rank, rrfK);
    byChunk.set(row.chunk_id, current);
  });
}

function isHeadingChunk(chunk) {
  return chunk?.type === 'heading';
}

function findSectionBodyChunk(db, chunk) {
  if (!chunk?.file_id || !chunk?.heading_path || !Number.isFinite(Number(chunk.position))) return null;

  return db.prepare(`
    SELECT id, content, type, position, line_start, line_end, heading_path
    FROM chunks
    WHERE file_id = ?
      AND heading_path = ?
      AND position > ?
      AND type != 'heading'
    ORDER BY position ASC
    LIMIT 1
  `).get(chunk.file_id, chunk.heading_path, Number(chunk.position));
}

function promoteHeadingMatches(db, chunks = []) {
  return (Array.isArray(chunks) ? chunks : [])
    .map((chunk) => {
      if (!isHeadingChunk(chunk)) return chunk;

      const sectionBody = findSectionBodyChunk(db, chunk);
      if (sectionBody) {
        return {
          ...chunk,
          chunk_id: sectionBody.id,
          content: sectionBody.content,
          preview: sectionBody.content.slice(0, 80),
          type: sectionBody.type,
          position: sectionBody.position,
          line_start: sectionBody.line_start,
          line_end: sectionBody.line_end,
          promoted_from_heading: true,
          original_chunk_id: chunk.chunk_id,
          original_line_start: chunk.line_start,
          original_line_end: chunk.line_end,
        };
      }

      return {
        ...chunk,
        weak_heading_match: true,
        score: Math.max(0, Number(chunk.score || 0) - 0.12),
      };
    })
    .filter((chunk) => !(chunk?.weak_heading_match && Number(chunk.score || 0) <= 0));
}

function attachImageCandidates(byChunk, imageRows, imageMap, rrfK) {
  imageRows.forEach((row) => {
    const image = imageMap.get(row.image_id);
    if (!image) return;

    const current = byChunk.get(image.chunk_id) || {
      chunk_id: image.chunk_id,
      score: 0,
    };

    if (!current.image_rank || row.image_rank < current.image_rank) {
      current.image_rank = row.image_rank;
      current.image_id = image.id;
      current.image_url = image.url;
      current.image_alt_text = image.alt_text || '';
      current.image_caption = image.caption || '';
      current.image_local_path = image.local_path || '';
      current.image_proxy_url = buildImageProxyUrl(image.file_id, image.url);
      current.image_vec_score = row.image_vec_score;
    }

    current.score += rrfScore(row.image_rank, rrfK);
    byChunk.set(image.chunk_id, current);
  });
}

async function hybridSearch(query, opts = {}) {
  const config = getEffectiveConfig();
  const topK = Number(opts.topK || opts.top_k || config.topK || 5);
  const vecThreshold = Number(opts.vecThreshold || config.vecScoreThreshold || 0.5);
  const rrfK = Number(opts.rrfK || 60);
  const headingBoost = Number(opts.headingBoost || 0.1);
  const recencyBoost = Number(opts.recencyBoost || 0.05);
  const fileIds = normalizeFileIds(opts.fileIds || opts.file_ids);
  const hasFileFilter = fileIds.length > 0;
  const db = getDb();

  const embedding = await queryEmbedding(query);
  const [vecRows, ftsRows, rawImageRows] = await Promise.all([
    Promise.resolve(chunkVectorSearch(db, embedding, topK, vecThreshold)),
    Promise.resolve(ftsSearch(db, query, topK)),
    Promise.resolve(imageVectorSearch(db, embedding, topK, vecThreshold)),
  ]);

  const imageRows = rawImageRows.length > 0
    ? db.prepare(`
      SELECT
        i.id,
        i.chunk_id,
        i.url,
        i.alt_text,
        i.caption,
        i.local_path,
        c.file_id
      FROM images i
      JOIN chunks c ON c.id = i.chunk_id
      WHERE i.id IN (${rawImageRows.map(() => '?').join(',')})
      ${hasFileFilter ? `AND c.file_id IN (${fileIds.map(() => '?').join(',')})` : ''}
    `).all(...rawImageRows.map((row) => row.image_id), ...(hasFileFilter ? fileIds : []))
    : [];

  const imageMap = new Map(imageRows.map((row) => [row.id, row]));
  const byChunk = new Map();

  mergeTextCandidates(byChunk, vecRows, ftsRows, rrfK);
  attachImageCandidates(byChunk, rawImageRows, imageMap, rrfK);

  const candidates = [...byChunk.values()];
  if (candidates.length === 0) return [];

  const rows = db.prepare(`
    SELECT
      c.id,
      c.content,
      c.type,
      c.position,
      c.heading_path,
      c.line_start,
      c.line_end,
      f.id AS file_id,
      f.title AS file_title,
      f.path AS file_path,
      f.updated_at AS file_updated_at
    FROM chunks c
    JOIN files f ON f.id = c.file_id
    WHERE c.id IN (${candidates.map(() => '?').join(',')})
    ${hasFileFilter ? `AND f.id IN (${fileIds.map(() => '?').join(',')})` : ''}
  `).all(...candidates.map((candidate) => candidate.chunk_id), ...(hasFileFilter ? fileIds : []));

  const rowMap = new Map(rows.map((row) => [row.id, row]));
  const now = Date.now();

  return candidates
    .map((candidate) => {
      const row = rowMap.get(candidate.chunk_id);
      if (!row) return null;

      let score = candidate.score;
      if (row.type === 'heading') score += headingBoost;
      const updatedAt = row.file_updated_at ? new Date(row.file_updated_at).getTime() : 0;
      if (updatedAt && now - updatedAt < 7 * 24 * 60 * 60 * 1000) score += recencyBoost;

      const imagePreview = candidate.image_alt_text || candidate.image_caption || candidate.image_url || '';
      const preview = candidate.image_id && !candidate.vec_rank && !candidate.fts_rank
        ? `图片：${imagePreview || row.content.slice(0, 80)}`
        : row.content.slice(0, 80);

      return {
        chunk_id: candidate.chunk_id,
        file_id: row.file_id,
        file_title: row.file_title || row.file_path,
        file_path: row.file_path,
        content: row.content,
        type: row.type,
        position: row.position,
        heading_path: row.heading_path || '',
        line_start: row.line_start,
        line_end: row.line_end,
        preview,
        score,
        vec_score: candidate.vec_score ?? candidate.image_vec_score ?? null,
        fts_rank: candidate.fts_rank || null,
        source: classifySource(candidate),
        image_id: candidate.image_id || null,
        image_url: candidate.image_url || null,
        image_proxy_url: candidate.image_proxy_url || null,
        image_alt_text: candidate.image_alt_text || '',
        image_caption: candidate.image_caption || '',
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
}

function dedupeChunks(chunks = []) {
  const byId = new Map();
  chunks.forEach((chunk) => {
    if (!chunk?.chunk_id) return;
    const existing = byId.get(chunk.chunk_id);
    if (!existing || Number(chunk.score || 0) > Number(existing.score || 0)) {
      byId.set(chunk.chunk_id, chunk);
    }
  });
  return [...byId.values()];
}

function boostCurrentFileChunks(chunks = [], activeFileId) {
  if (!activeFileId) return chunks;
  return chunks.map((chunk) => (
    Number(chunk.file_id) === Number(activeFileId)
      ? { ...chunk, score: Number(chunk.score || 0) + 0.25, current_file_priority: true }
      : chunk
  ));
}

function sortChunks(chunks = []) {
  return [...chunks].sort((left, right) => {
    if (Boolean(right.current_file_priority) !== Boolean(left.current_file_priority)) {
      return Number(right.current_file_priority) - Number(left.current_file_priority);
    }
    return Number(right.score || 0) - Number(left.score || 0);
  });
}

function quoteFromChunk(chunk) {
  return {
    chunk_id: chunk.chunk_id,
    preview: chunk.preview,
    content: chunk.content,
    line_start: chunk.line_start,
    line_end: chunk.line_end,
    score: Number(chunk.score || 0),
    source: chunk.source,
  };
}

function buildSectionGroups(chunks = [], options = {}) {
  const maxSections = Number(options.maxSections || 6);
  const maxQuotesPerSection = Number(options.maxQuotesPerSection || 2);
  const groups = new Map();

  chunks.forEach((chunk) => {
    const key = `${chunk.file_id}::${chunk.heading_path || '正文'}`;
    const current = groups.get(key) || {
      key,
      file_id: chunk.file_id,
      file_title: chunk.file_title,
      file_path: chunk.file_path,
      heading_path: chunk.heading_path || '',
      line_start: chunk.line_start,
      line_end: chunk.line_end,
      score: Number(chunk.score || 0),
      current_file_priority: Boolean(chunk.current_file_priority),
      quotes: [],
    };

    current.score = Math.max(current.score, Number(chunk.score || 0));
    current.current_file_priority = current.current_file_priority || Boolean(chunk.current_file_priority);
    current.line_start = current.line_start && chunk.line_start
      ? Math.min(current.line_start, chunk.line_start)
      : (current.line_start || chunk.line_start || null);
    current.line_end = current.line_end && chunk.line_end
      ? Math.max(current.line_end, chunk.line_end)
      : (current.line_end || chunk.line_end || null);

    if (!current.quotes.some((item) => item.chunk_id === chunk.chunk_id)) {
      current.quotes.push(quoteFromChunk(chunk));
    }

    groups.set(key, current);
  });

  return [...groups.values()]
    .map((section) => ({
      ...section,
      quotes: section.quotes
        .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
        .slice(0, maxQuotesPerSection),
    }))
    .sort((left, right) => {
      if (Boolean(right.current_file_priority) !== Boolean(left.current_file_priority)) {
        return Number(right.current_file_priority) - Number(left.current_file_priority);
      }
      return Number(right.score || 0) - Number(left.score || 0);
    })
    .slice(0, maxSections);
}

function buildRetrievalStats(chunks = [], sections = []) {
  const bestScore = chunks.reduce((max, chunk) => Math.max(max, Number(chunk.score || 0)), 0);
  return {
    chunk_count: chunks.length,
    section_count: sections.length,
    file_count: new Set(chunks.map((chunk) => chunk.file_id)).size,
    best_score: bestScore,
  };
}

function hasSufficientEvidence(chunks = [], sections = [], stats = {}) {
  if (sections.length === 0) return false;
  if (chunks.length < 2 && sections.length < 1) return false;
  if (Number(stats.best_score || 0) < 0.015) return false;
  return true;
}

async function retrieveKnowledgeContext(query, opts = {}) {
  const activeFileId = normalizePositiveId(opts.activeFileId || opts.active_file_id);
  const requestedFileIds = normalizeFileIds(opts.fileIds || opts.file_ids);
  const restrictToFileIds = Boolean(opts.restrictToFileIds || opts.restrict_to_file_ids);
  const topK = Number(opts.topK || opts.top_k || 5);
  const db = getDb();

  const preferredChunks = activeFileId
    ? await hybridSearch(query, {
      ...opts,
      topK: Math.max(3, Math.min(topK, 5)),
      vecThreshold: Math.min(Number(opts.vecThreshold || opts.vec_threshold || 0.5), 0.25),
      fileIds: [activeFileId],
    })
    : [];

  const supplementalFileIds = activeFileId
    ? requestedFileIds.filter((fileId) => fileId !== activeFileId)
    : requestedFileIds;
  const shouldSearchSupplement = !restrictToFileIds || supplementalFileIds.length > 0;
  const supplementalChunks = shouldSearchSupplement
    ? await hybridSearch(query, {
      ...opts,
      topK: activeFileId ? topK + 2 : topK,
      fileIds: supplementalFileIds.length > 0 ? supplementalFileIds : (restrictToFileIds ? [] : undefined),
    })
    : [];

  const rankedChunks = sortChunks(dedupeChunks([
    ...boostCurrentFileChunks(preferredChunks, activeFileId),
    ...supplementalChunks,
  ]));
  const chunks = sortChunks(dedupeChunks(promoteHeadingMatches(db, rankedChunks))).slice(0, topK);
  const sections = buildSectionGroups(chunks, opts);
  const stats = buildRetrievalStats(chunks, sections);
  const sufficiency = hasSufficientEvidence(chunks, sections, stats);

  return {
    chunks,
    sections,
    stats,
    sufficiency,
  };
}

module.exports = {
  hybridSearch,
  retrieveKnowledgeContext,
};
