const { getDb, isVecAvailable } = require('./db');
const { getEmbedding } = require('./embeddings');
const { getEffectiveConfig } = require('./config');
const { buildFtsQuery, segmentText } = require('./tokenizer');
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

function uniqueStrings(values = [], limit = 8) {
  const seen = new Set();
  const items = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(normalized);
  });
  return items.slice(0, Math.max(0, limit));
}

function splitIntoSentenceCandidates(content = '') {
  return String(content || '')
    .split(/\n{2,}|(?<=[。！？!?])\s*|(?<=\.)\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectEvidenceSentences(content = '', query = '', keywords = [], limit = 3) {
  const queryTokens = new Set(segmentText([query, ...(Array.isArray(keywords) ? keywords : [])].join(' '), 24));
  const scored = splitIntoSentenceCandidates(content)
    .map((sentence) => {
      const tokens = segmentText(sentence, 32);
      const overlap = tokens.filter((token) => queryTokens.has(token)).length;
      const tokenScore = queryTokens.size > 0 ? overlap / queryTokens.size : 0;
      const length = sentence.length;
      const lengthPenalty = length < 12 ? 0.12 : length > 180 ? 0.08 : 0;
      return {
        sentence,
        score: tokenScore - lengthPenalty,
      };
    })
    .sort((left, right) => right.score - left.score);

  const selected = [];
  scored.forEach((item) => {
    if (selected.length >= limit) return;
    if (item.score <= 0 && selected.length > 0) return;
    if (selected.some((sentence) => sentence === item.sentence)) return;
    selected.push(item.sentence);
  });

  if (selected.length > 0) return selected;
  return splitIntoSentenceCandidates(content).slice(0, limit);
}

function normalizeQueryPlanInput(input) {
  if (typeof input === 'string') {
    const query = String(input || '').trim();
    return {
      query,
      intent: 'fact',
      standalone_query: query,
      expanded_query: query,
      keywords: [],
      title_hints: [],
      is_follow_up: false,
    };
  }

  const query = String(input?.query || input?.original_query || input?.standalone_query || '').trim();
  return {
    query,
    intent: String(input?.intent || 'fact').trim() || 'fact',
    standalone_query: String(input?.standalone_query || query).trim() || query,
    expanded_query: String(input?.expanded_query || input?.standalone_query || query).trim() || query,
    keywords: uniqueStrings(input?.keywords, 8),
    title_hints: uniqueStrings(input?.title_hints, 4),
    is_follow_up: Boolean(input?.is_follow_up),
  };
}

function buildQueryVariants(queryPlan) {
  const variants = [];
  const addVariant = (label, query, weight) => {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return;
    if (variants.some((item) => item.query.toLowerCase() === normalizedQuery.toLowerCase())) return;
    variants.push({ label, query: normalizedQuery, weight });
  };

  addVariant('original', queryPlan.query, 1);
  addVariant('standalone', queryPlan.standalone_query, 0.95);
  addVariant('expanded', queryPlan.expanded_query, 0.88);

  return variants;
}

function buildTitleSearchInputs(queryPlan, queryVariants) {
  const inputs = [];
  const addInput = (label, text, weight) => {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) return;
    if (inputs.some((item) => item.text.toLowerCase() === normalizedText.toLowerCase())) return;
    inputs.push({ label, text: normalizedText, weight });
  };

  addInput('title_original', queryPlan.query, 1);
  addInput('title_standalone', queryPlan.standalone_query, 0.96);
  queryPlan.title_hints.forEach((hint, index) => addInput(`title_hint_${index + 1}`, hint, 0.94));
  if (queryPlan.keywords.length > 0) {
    addInput('title_keywords', queryPlan.keywords.slice(0, 4).join(' '), 0.9);
  }
  queryVariants
    .filter((variant) => variant.label === 'expanded')
    .forEach((variant) => addInput('title_expanded', variant.query, 0.82));

  return inputs;
}

async function queryEmbedding(query) {
  try {
    return await getEmbedding(query);
  } catch {
    return null;
  }
}

function chunkVectorSearch(db, embedding, topK, threshold, options = {}) {
  if (!embedding || !isVecAvailable()) return [];
  const candidateMultiplier = Number(options.candidateMultiplier || 2);
  return db.prepare(`
    SELECT chunk_id, distance
    FROM chunks_vec
    WHERE embedding MATCH ?
      AND k = ?
  `).all(JSON.stringify(embedding), Math.max(topK * candidateMultiplier, topK))
    .map((row, index) => ({
      chunk_id: row.chunk_id,
      distance: row.distance,
      vec_score: distanceToSimilarity(row.distance),
      vec_rank: index + 1,
    }))
    .filter((row) => row.vec_score === null || row.vec_score >= threshold);
}

function imageVectorSearch(db, embedding, topK, threshold, options = {}) {
  if (!embedding || !isVecAvailable()) return [];
  const candidateMultiplier = Number(options.candidateMultiplier || 2);
  return db.prepare(`
    SELECT image_id, distance
    FROM images_vec
    WHERE embedding MATCH ?
      AND k = ?
  `).all(JSON.stringify(embedding), Math.max(topK * candidateMultiplier, topK))
    .map((row, index) => ({
      image_id: row.image_id,
      image_vec_score: distanceToSimilarity(row.distance),
      image_rank: index + 1,
    }))
    .filter((row) => row.image_vec_score === null || row.image_vec_score >= threshold);
}

function ftsSearch(db, query, topK, fileIds = []) {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const normalizedFileIds = normalizeFileIds(fileIds);
  const hasFileFilter = normalizedFileIds.length > 0;

  try {
    return db.prepare(`
      SELECT c.id AS chunk_id, bm25(chunks_fts) AS rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
      ${hasFileFilter ? `AND c.file_id IN (${normalizedFileIds.map(() => '?').join(',')})` : ''}
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, ...(hasFileFilter ? normalizedFileIds : []), topK * 3).map((row, index) => ({
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
      AND ifnull(heading_path, '') = ?
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
  const vecThreshold = Number(opts.vecThreshold || opts.vec_threshold || config.vecScoreThreshold || 0.5);
  const rrfK = Number(opts.rrfK || 60);
  const headingBoost = Number(opts.headingBoost || 0.1);
  const recencyBoost = Number(opts.recencyBoost || 0.05);
  const fileIds = normalizeFileIds(opts.fileIds || opts.file_ids);
  const hasFileFilter = fileIds.length > 0;
  const db = getDb();

  const embedding = await queryEmbedding(query);
  const [vecRows, ftsRows, rawImageRows] = await Promise.all([
    Promise.resolve(chunkVectorSearch(db, embedding, topK, vecThreshold, {
      candidateMultiplier: hasFileFilter ? 6 : 3,
    })),
    Promise.resolve(ftsSearch(db, query, topK, fileIds)),
    Promise.resolve(imageVectorSearch(db, embedding, topK, vecThreshold, {
      candidateMultiplier: hasFileFilter ? 6 : 3,
    })),
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
        base_score: score,
        vec_score: candidate.vec_score ?? candidate.image_vec_score ?? null,
        fts_rank: candidate.fts_rank || null,
        source: classifySource(candidate),
        image_id: candidate.image_id || null,
        image_url: candidate.image_url || null,
        image_proxy_url: candidate.image_proxy_url || null,
        image_alt_text: candidate.image_alt_text || '',
        image_caption: candidate.image_caption || '',
        matched_queries: [],
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(topK * 4, 20));
}

function searchFileMatches(db, queries = [], options = {}) {
  const topK = Number(options.topK || 6);
  const fileIds = normalizeFileIds(options.fileIds || options.file_ids);
  const hasFileFilter = fileIds.length > 0;
  const rrfK = Number(options.rrfK || 60);
  const byFile = new Map();

  queries.forEach((queryItem) => {
    const ftsQuery = buildFtsQuery(queryItem.text);
    if (!ftsQuery) return;

    const rows = db.prepare(`
      SELECT f.id AS file_id, f.title AS file_title, f.path AS file_path, bm25(files_fts) AS rank
      FROM files_fts
      JOIN files f ON f.id = files_fts.rowid
      WHERE files_fts MATCH ?
      ${hasFileFilter ? `AND f.id IN (${fileIds.map(() => '?').join(',')})` : ''}
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, ...(hasFileFilter ? fileIds : []), topK * 2);

    rows.forEach((row, index) => {
      const current = byFile.get(row.file_id) || {
        file_id: row.file_id,
        file_title: row.file_title || row.file_path,
        file_path: row.file_path,
        score: 0,
        matched_queries: [],
      };
      current.score += rrfScore(index + 1, rrfK) * Number(queryItem.weight || 1);
      current.matched_queries = uniqueStrings([...current.matched_queries, queryItem.label], 6);
      byFile.set(row.file_id, current);
    });
  });

  return [...byFile.values()]
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .slice(0, topK);
}

function annotateVariantChunks(chunks = [], variant, options = {}) {
  const titleMatchedIds = new Set(normalizeFileIds(options.titleMatchedFileIds));
  return (Array.isArray(chunks) ? chunks : []).map((chunk) => ({
    ...chunk,
    score: Number(chunk.score || 0) * Number(variant.weight || 1),
    base_score: Number(chunk.score || 0),
    matched_queries: uniqueStrings([...(chunk.matched_queries || []), variant.label], 6),
    title_match: titleMatchedIds.has(Number(chunk.file_id)),
    title_matched_queries: titleMatchedIds.has(Number(chunk.file_id))
      ? uniqueStrings([...(chunk.title_matched_queries || []), variant.label], 6)
      : (chunk.title_matched_queries || []),
  }));
}

function mergeChunks(chunks = []) {
  const byId = new Map();

  chunks.forEach((chunk) => {
    if (!chunk?.chunk_id) return;

    const current = byId.get(chunk.chunk_id);
    if (!current) {
      byId.set(chunk.chunk_id, {
        ...chunk,
        matched_queries: uniqueStrings(chunk.matched_queries, 6),
        title_matched_queries: uniqueStrings(chunk.title_matched_queries, 6),
      });
      return;
    }

    current.score += Number(chunk.score || 0);
    current.base_score = Math.max(Number(current.base_score || 0), Number(chunk.base_score || 0));
    current.current_file_priority = Boolean(current.current_file_priority || chunk.current_file_priority);
    current.title_match = Boolean(current.title_match || chunk.title_match);
    current.matched_queries = uniqueStrings([...(current.matched_queries || []), ...(chunk.matched_queries || [])], 6);
    current.title_matched_queries = uniqueStrings([...(current.title_matched_queries || []), ...(chunk.title_matched_queries || [])], 6);
    if (Number(chunk.score || 0) > Number(current.best_variant_score || 0)) {
      current.preview = chunk.preview;
      current.content = chunk.content;
      current.source = chunk.source;
      current.vec_score = chunk.vec_score;
      current.fts_rank = chunk.fts_rank;
      current.image_id = chunk.image_id;
      current.image_url = chunk.image_url;
      current.image_proxy_url = chunk.image_proxy_url;
      current.image_alt_text = chunk.image_alt_text;
      current.image_caption = chunk.image_caption;
      current.best_variant_score = Number(chunk.score || 0);
    }
    byId.set(chunk.chunk_id, current);
  });

  return [...byId.values()];
}

function boostCurrentFileChunks(chunks = [], activeFileId) {
  if (!activeFileId) return chunks;
  return chunks.map((chunk) => {
    if (Number(chunk.file_id) !== Number(activeFileId)) return chunk;
    const baseScore = Number(chunk.score || 0);
    const boost = Math.min(0.12, Math.max(0.04, baseScore * 0.25));
    return {
      ...chunk,
      score: baseScore + boost,
      current_file_priority: true,
    };
  });
}

function sortChunks(chunks = []) {
  return [...chunks].sort((left, right) => {
    const scoreDiff = Number(right.score || 0) - Number(left.score || 0);
    if (Math.abs(scoreDiff) > 0.0001) {
      return scoreDiff;
    }
    if (Boolean(right.current_file_priority) !== Boolean(left.current_file_priority)) {
      return Number(right.current_file_priority) - Number(left.current_file_priority);
    }
    return Number(right.base_score || 0) - Number(left.base_score || 0);
  });
}

function capChunksPerFile(chunks = [], options = {}) {
  const limitPerFile = Number(options.limitPerFile || 3);
  const totalLimit = Number(options.totalLimit || chunks.length);
  const counts = new Map();
  const selected = [];

  sortChunks(chunks).forEach((chunk) => {
    const fileId = Number(chunk.file_id || 0);
    const currentCount = counts.get(fileId) || 0;
    if (currentCount >= limitPerFile) return;
    counts.set(fileId, currentCount + 1);
    selected.push(chunk);
  });

  return selected.slice(0, totalLimit);
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

function loadExpandedContextRows(db, group, options = {}) {
  const before = Number(options.expandBefore || 1);
  const after = Number(options.expandAfter || 1);
  const headingPath = String(group.heading_path || '');
  const positions = group.seeds
    .map((chunk) => Number(chunk.position))
    .filter((value) => Number.isFinite(value));

  if (positions.length === 0) return [];

  if (!headingPath) {
    const minPosition = Math.min(...positions);
    const maxPosition = Math.max(...positions);
    return db.prepare(`
      SELECT id, content, type, position, line_start, line_end, heading_path
      FROM chunks
      WHERE file_id = ?
        AND position BETWEEN ? AND ?
      ORDER BY position ASC
    `).all(group.file_id, Math.max(0, minPosition - before), maxPosition + after);
  }

  const rows = db.prepare(`
    SELECT id, content, type, position, line_start, line_end, heading_path
    FROM chunks
    WHERE file_id = ?
      AND ifnull(heading_path, '') = ?
    ORDER BY position ASC
  `).all(group.file_id, headingPath);

  if (rows.length === 0) return [];

  const minPosition = Math.min(...positions);
  const maxPosition = Math.max(...positions);
  const startIndex = Math.max(0, rows.findIndex((row) => Number(row.position) >= minPosition) - before);
  const reversedIndex = [...rows].reverse().findIndex((row) => Number(row.position) <= maxPosition);
  const endIndex = reversedIndex === -1
    ? rows.length - 1
    : Math.min(rows.length - 1, rows.length - reversedIndex - 1 + after);

  const slice = rows.slice(startIndex, endIndex + 1);
  if (slice.some((row) => row.type === 'heading')) return slice;

  const headingRow = rows.find((row) => row.type === 'heading');
  return headingRow ? [headingRow, ...slice] : slice;
}

function buildExpandedSections(db, chunks = [], options = {}) {
  const maxSections = Number(options.maxSections || 5);
  const maxQuotesPerSection = Number(options.maxQuotesPerSection || 2);
  const groups = new Map();

  chunks.forEach((chunk) => {
    const key = `${chunk.file_id}::${chunk.heading_path || `__pos__${chunk.position}`}`;
    const current = groups.get(key) || {
      key,
      file_id: chunk.file_id,
      file_title: chunk.file_title,
      file_path: chunk.file_path,
      heading_path: chunk.heading_path || '',
      current_file_priority: Boolean(chunk.current_file_priority),
      score: Number(chunk.score || 0),
      title_match: Boolean(chunk.title_match),
      matched_queries: [],
      title_matched_queries: [],
      seeds: [],
    };

    current.current_file_priority = current.current_file_priority || Boolean(chunk.current_file_priority);
    current.score = Math.max(current.score, Number(chunk.score || 0));
    current.title_match = current.title_match || Boolean(chunk.title_match);
    current.matched_queries = uniqueStrings([...(current.matched_queries || []), ...(chunk.matched_queries || [])], 6);
    current.title_matched_queries = uniqueStrings([...(current.title_matched_queries || []), ...(chunk.title_matched_queries || [])], 6);
    current.seeds.push(chunk);
    groups.set(key, current);
  });

  return [...groups.values()]
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
    .slice(0, maxSections)
    .map((group) => {
      const contextRows = loadExpandedContextRows(db, group, options);
      const sortedSeeds = sortChunks(group.seeds);
      const content = contextRows
        .map((row) => String(row.content || '').trim())
        .filter(Boolean)
        .join('\n\n')
        .trim();
      const lineStart = contextRows.reduce((min, row) => {
        if (!row.line_start) return min;
        return min === null ? row.line_start : Math.min(min, row.line_start);
      }, null);
      const lineEnd = contextRows.reduce((max, row) => {
        if (!row.line_end) return max;
        return max === null ? row.line_end : Math.max(max, row.line_end);
      }, null);

      return {
        key: group.key,
        file_id: group.file_id,
        file_title: group.file_title,
        file_path: group.file_path,
        heading_path: group.heading_path || '',
        line_start: lineStart,
        line_end: lineEnd,
        score: Number(group.score || 0),
        current_file_priority: Boolean(group.current_file_priority),
        title_match: Boolean(group.title_match),
        title_matched_queries: group.title_matched_queries,
        matched_queries: group.matched_queries,
        content,
        preview: content.slice(0, 160),
        quotes: sortedSeeds.slice(0, maxQuotesPerSection).map(quoteFromChunk),
        evidence_sentences: selectEvidenceSentences(
          content,
          options.sentenceQuery || '',
          options.sentenceKeywords || [],
          Number(options.maxEvidenceSentences || 3)
        ),
      };
    });
}

function buildRetrievalStats(chunks = [], sections = [], matchedFiles = []) {
  const bestScore = chunks.reduce((max, chunk) => Math.max(max, Number(chunk.score || 0)), 0);
  const sorted = sortChunks(chunks).slice(0, 2);
  const topGap = sorted.length >= 2
    ? Number((Number(sorted[0].score || 0) - Number(sorted[1].score || 0)).toFixed(4))
    : Number(sorted[0]?.score || 0);
  return {
    chunk_count: chunks.length,
    section_count: sections.length,
    file_count: new Set(chunks.map((chunk) => chunk.file_id)).size,
    section_file_count: new Set(sections.map((section) => section.file_id)).size,
    matched_file_count: matchedFiles.length,
    best_score: bestScore,
    top_score_gap: topGap,
  };
}

function hasSufficientEvidence(chunks = [], sections = [], stats = {}) {
  if (sections.length === 0) return false;
  const strongSections = sections.filter((section) => String(section.content || '').trim().length >= 48);
  if (strongSections.length === 0) return false;
  if (chunks.length === 0) return false;
  if (Number(stats.best_score || 0) < 0.018 && strongSections.length < 2) {
    return strongSections.some((section) => section.title_match && (section.quotes || []).length > 0 && String(section.content || '').trim().length >= 96);
  }
  return true;
}

async function retrieveKnowledgeContext(queryInput, opts = {}) {
  const queryPlan = normalizeQueryPlanInput(queryInput);
  const activeFileId = normalizePositiveId(opts.activeFileId || opts.active_file_id);
  const requestedFileIds = normalizeFileIds(opts.fileIds || opts.file_ids);
  const restrictToFileIds = Boolean(opts.restrictToFileIds || opts.restrict_to_file_ids);
  const topK = Number(opts.topK || opts.top_k || 5);
  const config = getEffectiveConfig();
  const db = getDb();
  const queryVariants = buildQueryVariants(queryPlan);
  const titleSearchInputs = buildTitleSearchInputs(queryPlan, queryVariants);
  const allowedFileIds = restrictToFileIds ? requestedFileIds : [];
  const matchedFiles = searchFileMatches(db, titleSearchInputs, {
    topK: Math.max(4, topK),
    fileIds: restrictToFileIds ? requestedFileIds : undefined,
  });
  const titleMatchedFileIds = normalizeFileIds(matchedFiles.map((item) => item.file_id));
  const generalFileIds = restrictToFileIds ? requestedFileIds : undefined;
  const shouldRunGeneralSearch = !restrictToFileIds || requestedFileIds.length > 0;
  const primaryQueryVariant = queryVariants[1] || queryVariants[0] || { label: 'original', query: queryPlan.query, weight: 1 };

  const generalSearches = shouldRunGeneralSearch
    ? queryVariants.map((variant) => hybridSearch(variant.query, {
      ...opts,
      topK: topK + 3,
      vecThreshold: Number(opts.vecThreshold || opts.vec_threshold || config.vecScoreThreshold || 0.5),
      fileIds: generalFileIds,
    }).then((rows) => annotateVariantChunks(rows, variant, { titleMatchedFileIds })))
    : [];

  const currentFileAllowed = activeFileId && (!restrictToFileIds || requestedFileIds.includes(activeFileId));
  const activeFileSearch = currentFileAllowed
    ? hybridSearch(primaryQueryVariant.query, {
      ...opts,
      topK: Math.max(4, topK),
      vecThreshold: Number(opts.vecThreshold || opts.vec_threshold || config.vecScoreThreshold || 0.5),
      fileIds: [activeFileId],
    }).then((rows) => annotateVariantChunks(rows, {
      label: 'active_file',
      weight: 1.08,
    }, { titleMatchedFileIds }))
    : Promise.resolve([]);

  const titleFileSearch = titleMatchedFileIds.length > 0
    ? hybridSearch(primaryQueryVariant.query, {
      ...opts,
      topK: topK + 2,
      vecThreshold: Number(opts.vecThreshold || opts.vec_threshold || config.vecScoreThreshold || 0.5),
      fileIds: titleMatchedFileIds,
    }).then((rows) => annotateVariantChunks(rows, {
      label: 'title_file',
      weight: 0.92,
    }, { titleMatchedFileIds }))
    : Promise.resolve([]);

  const searchResults = await Promise.all([
    ...generalSearches,
    activeFileSearch,
    titleFileSearch,
  ]);

  const rankedChunks = capChunksPerFile(
    sortChunks(
      mergeChunks(
        promoteHeadingMatches(
          db,
          boostCurrentFileChunks(
            mergeChunks(searchResults.flat()),
            activeFileId
          )
        )
      )
    ),
    {
      limitPerFile: Number(opts.maxChunksPerFile || 3),
      totalLimit: Math.max(topK * 2, 10),
    }
  );

  const sortedRankedChunks = sortChunks(rankedChunks);
  const sectionSeedChunks = sortedRankedChunks.slice(0, Math.max(topK * 2, 8));
  const chunks = sortedRankedChunks.slice(0, topK);
  const sections = buildExpandedSections(db, sectionSeedChunks, {
    maxSections: Number(opts.maxSections || Math.max(topK * 2, 8)),
    maxQuotesPerSection: Number(opts.maxQuotesPerSection || 2),
    expandBefore: Number(opts.expandBefore || 1),
    expandAfter: Number(opts.expandAfter || 1),
    sentenceQuery: primaryQueryVariant.query,
    sentenceKeywords: queryPlan.keywords,
    maxEvidenceSentences: Number(opts.maxEvidenceSentences || 3),
  });
  const stats = buildRetrievalStats(chunks, sections, matchedFiles);
  const sufficiency = hasSufficientEvidence(chunks, sections, stats);

  return {
    query_plan: queryPlan,
    rewrite_queries: queryVariants.map((variant) => ({
      label: variant.label,
      query: variant.query,
      weight: variant.weight,
    })),
    matched_files: matchedFiles,
    seed_count: sectionSeedChunks.length,
    expanded_section_count: sections.length,
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
