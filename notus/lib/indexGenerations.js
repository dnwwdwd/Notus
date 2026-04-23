const { getDb, getSetting, setSetting } = require('./db');
const { getEffectiveConfig } = require('./config');
const { syncFilesFromDisk } = require('./files');
const {
  getGenerationDbPath,
  copyLegacyIndexFromMainDb,
} = require('./indexGenerationDb');
const { createLogger } = require('./logger');

const logger = createLogger({ subsystem: 'index-generations' });

const ACTIVE_GENERATION_KEY = 'index_active_generation_id';
const REBUILD_STATES = new Set(['queued', 'building', 'catching_up', 'validated']);
const ACTIVE_LIKE_STATES = new Set(['active', 'retained']);
const SUCCESS_STATES = new Set(['ready', 'degraded']);

function safeJsonParse(value, fallback = null) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function buildEmbeddingConfig(config = getEffectiveConfig()) {
  return {
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    embeddingDim: Number(config.embeddingDim),
    embeddingMultimodalEnabled: Boolean(config.embeddingMultimodalEnabled),
    embeddingBaseUrl: config.embeddingBaseUrl || '',
    embeddingApiKey: config.embeddingApiKey || '',
  };
}

function sanitizeEmbeddingConfig(config = {}) {
  return {
    provider: config.embeddingProvider || '',
    model: config.embeddingModel || '',
    dim: Number(config.embeddingDim) || 0,
    multimodal_enabled: Boolean(config.embeddingMultimodalEnabled),
    base_url: config.embeddingBaseUrl || '',
    api_key_set: Boolean(config.embeddingApiKey),
  };
}

function normalizeGeneration(row) {
  if (!row) return null;
  const configSnapshot = safeJsonParse(row.config_snapshot, {});
  const progress = safeJsonParse(row.progress, {});
  return {
    ...row,
    id: Number(row.id),
    total_files: Number(row.total_files || 0),
    processed_files: Number(row.processed_files || 0),
    config_snapshot_object: configSnapshot,
    progress_object: progress,
  };
}

function sanitizeGenerationForApi(row) {
  const generation = normalizeGeneration(row);
  if (!generation) return null;
  return {
    id: generation.id,
    kind: generation.kind,
    state: generation.state,
    started_at: generation.started_at,
    finished_at: generation.finished_at,
    activated_at: generation.activated_at,
    total_files: generation.total_files,
    processed_files: generation.processed_files,
    error_summary: generation.error_summary || null,
    progress: generation.progress_object || {},
    embedding: sanitizeEmbeddingConfig(generation.config_snapshot_object || {}),
  };
}

function sameEmbeddingSignature(left = {}, right = {}) {
  return String(left.embeddingProvider || '') === String(right.embeddingProvider || '') &&
    String(left.embeddingModel || '') === String(right.embeddingModel || '') &&
    Number(left.embeddingDim || 0) === Number(right.embeddingDim || 0) &&
    Boolean(left.embeddingMultimodalEnabled) === Boolean(right.embeddingMultimodalEnabled) &&
    String(left.embeddingBaseUrl || '') === String(right.embeddingBaseUrl || '');
}

function sameEmbeddingConfig(left = {}, right = {}) {
  return sameEmbeddingSignature(left, right) &&
    String(left.embeddingApiKey || '') === String(right.embeddingApiKey || '');
}

function getGenerationById(id) {
  const row = getDb().prepare('SELECT * FROM index_generations WHERE id = ?').get(Number(id));
  return normalizeGeneration(row);
}

function getActiveGenerationId() {
  const raw = getSetting(ACTIVE_GENERATION_KEY, null);
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function getActiveGeneration() {
  const activeId = getActiveGenerationId();
  if (!activeId) return null;
  return getGenerationById(activeId);
}

function getLatestRebuildGeneration() {
  const row = getDb().prepare(`
    SELECT *
    FROM index_generations
    WHERE state IN ('queued', 'building', 'catching_up', 'validated', 'failed')
    ORDER BY id DESC
    LIMIT 1
  `).get();
  return normalizeGeneration(row);
}

function listActiveLikeGenerations(limit = 5) {
  return getDb().prepare(`
    SELECT *
    FROM index_generations
    WHERE state IN ('active', 'retained', 'failed')
    ORDER BY COALESCE(activated_at, finished_at, started_at) DESC, id DESC
    LIMIT ?
  `).all(Number(limit)).map(normalizeGeneration);
}

function createGeneration({
  kind = 'manual_rebuild',
  state = 'queued',
  configSnapshot = buildEmbeddingConfig(),
  totalFiles = 0,
  progress = {},
  errorSummary = null,
} = {}) {
  const dbPath = getGenerationDbPath(
    getDb().prepare('SELECT IFNULL(MAX(id), 0) + 1 AS next_id FROM index_generations').get().next_id
  );
  const result = getDb().prepare(`
    INSERT INTO index_generations (
      kind, state, config_snapshot, db_path, progress, total_files, processed_files, error_summary, started_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
  `).run(
    kind,
    state,
    JSON.stringify(configSnapshot || buildEmbeddingConfig()),
    dbPath,
    JSON.stringify(progress || {}),
    Number(totalFiles || 0),
    errorSummary
  );
  return getGenerationById(result.lastInsertRowid);
}

function updateGeneration(id, values = {}) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (!entries.length) return getGenerationById(id);
  const sql = entries.map(([key]) => `${key} = ?`).join(', ');
  getDb().prepare(`UPDATE index_generations SET ${sql} WHERE id = ?`)
    .run(...entries.map(([, value]) => value), Number(id));
  return getGenerationById(id);
}

function updateGenerationProgress(id, progress = {}, extra = {}) {
  const current = getGenerationById(id);
  const mergedProgress = {
    ...(current?.progress_object || {}),
    ...(progress || {}),
  };
  return updateGeneration(id, {
    progress: JSON.stringify(mergedProgress),
    ...extra,
  });
}

function markGenerationFailed(id, error) {
  const message = error?.message || String(error || '索引构建失败');
  return updateGeneration(id, {
    state: 'failed',
    error_summary: message,
    progress: JSON.stringify({
      ...(getGenerationById(id)?.progress_object || {}),
      stage: 'failed',
      error: message,
    }),
    finished_at: new Date().toISOString(),
  });
}

function updateGenerationConfigSnapshot(id, configSnapshot) {
  return updateGeneration(id, {
    config_snapshot: JSON.stringify(configSnapshot || buildEmbeddingConfig()),
  });
}

function setActiveGenerationId(id) {
  setSetting(ACTIVE_GENERATION_KEY, id ? String(id) : '');
}

function activateGeneration(id) {
  const next = getGenerationById(id);
  if (!next) throw new Error('generation not found');

  const currentId = getActiveGenerationId();
  if (currentId && currentId !== next.id) {
    updateGeneration(currentId, {
      state: 'retained',
    });
  }

  updateGeneration(next.id, {
    state: 'active',
    activated_at: new Date().toISOString(),
    finished_at: next.finished_at || new Date().toISOString(),
  });
  setActiveGenerationId(next.id);
  return getGenerationById(next.id);
}

function projectLegacyFlags(fileId, status, errorMessage) {
  const normalizedId = Number(fileId);
  if (!Number.isFinite(normalizedId) || normalizedId <= 0) return;

  if (status === 'ready' || status === 'degraded') {
    getDb().prepare(`
      UPDATE files
      SET indexed = 1,
          indexed_at = datetime('now'),
          index_error = NULL,
          retry_count = 0,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(normalizedId);
    return;
  }

  if (status === 'failed') {
    getDb().prepare(`
      UPDATE files
      SET indexed = 0,
          indexed_at = NULL,
          index_error = ?,
          retry_count = retry_count + 1,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(errorMessage || '索引失败', normalizedId);
    return;
  }

  getDb().prepare(`
    UPDATE files
    SET indexed = 0,
        indexed_at = NULL,
        index_error = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(normalizedId);
}

function setFileIndexStatus(file, generationId, result = {}) {
  const fileId = Number(file?.id || result.file_id);
  if (!Number.isFinite(fileId) || fileId <= 0) return null;
  const status = result.status || 'queued';
  const contentHash = result.contentHash || result.content_hash || file?.hash || null;
  const errorMessage = result.error || null;

  getDb().prepare(`
    INSERT INTO file_index_status (
      file_id, generation_id, status, content_hash, chunks_count,
      text_indexed, vector_indexed, image_vector_indexed, error, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(file_id) DO UPDATE SET
      generation_id = excluded.generation_id,
      status = excluded.status,
      content_hash = excluded.content_hash,
      chunks_count = excluded.chunks_count,
      text_indexed = excluded.text_indexed,
      vector_indexed = excluded.vector_indexed,
      image_vector_indexed = excluded.image_vector_indexed,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run(
    fileId,
    Number(generationId || 0) || null,
    status,
    contentHash,
    Number(result.chunksCount || result.chunks_count || 0),
    Number(result.textIndexed ?? result.text_indexed ?? 0),
    Number(result.vectorIndexed ?? result.vector_indexed ?? 0),
    Number(result.imageVectorIndexed ?? result.image_vector_indexed ?? 0),
    errorMessage
  );

  projectLegacyFlags(fileId, status, errorMessage);
  return getDb().prepare('SELECT * FROM file_index_status WHERE file_id = ?').get(fileId);
}

function setFileQueued(file, generationId, extra = {}) {
  return setFileIndexStatus(file, generationId, {
    status: 'queued',
    chunks_count: extra.chunksCount || 0,
    content_hash: extra.contentHash || file?.hash || null,
    text_indexed: 0,
    vector_indexed: 0,
    image_vector_indexed: 0,
    error: null,
  });
}

function setFileRunning(file, generationId, extra = {}) {
  return setFileIndexStatus(file, generationId, {
    status: 'running',
    chunks_count: extra.chunksCount || 0,
    content_hash: extra.contentHash || file?.hash || null,
    text_indexed: 0,
    vector_indexed: 0,
    image_vector_indexed: 0,
    error: null,
  });
}

function upsertGenerationFileResult(generationId, file, result = {}) {
  const fileId = Number(file?.id || result.file_id);
  if (!Number.isFinite(fileId) || fileId <= 0) return null;

  getDb().prepare(`
    INSERT INTO generation_file_results (
      generation_id, file_id, path, content_hash, status, chunks_count,
      text_indexed, vector_indexed, image_vector_indexed, error, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(generation_id, file_id) DO UPDATE SET
      path = excluded.path,
      content_hash = excluded.content_hash,
      status = excluded.status,
      chunks_count = excluded.chunks_count,
      text_indexed = excluded.text_indexed,
      vector_indexed = excluded.vector_indexed,
      image_vector_indexed = excluded.image_vector_indexed,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run(
    Number(generationId),
    fileId,
    file?.path || result.path || '',
    result.contentHash || result.content_hash || file?.hash || null,
    result.status || 'queued',
    Number(result.chunksCount || result.chunks_count || 0),
    Number(result.textIndexed ?? result.text_indexed ?? 0),
    Number(result.vectorIndexed ?? result.vector_indexed ?? 0),
    Number(result.imageVectorIndexed ?? result.image_vector_indexed ?? 0),
    result.error || null
  );

  return getDb().prepare(`
    SELECT *
    FROM generation_file_results
    WHERE generation_id = ? AND file_id = ?
  `).get(Number(generationId), fileId);
}

function getGenerationFileResult(generationId, fileId) {
  return getDb().prepare(`
    SELECT *
    FROM generation_file_results
    WHERE generation_id = ? AND file_id = ?
  `).get(Number(generationId), Number(fileId));
}

function deleteGenerationFileResult(generationId, fileId) {
  getDb().prepare(`
    DELETE FROM generation_file_results
    WHERE generation_id = ? AND file_id = ?
  `).run(Number(generationId), Number(fileId));
}

function upsertGenerationDirtyFile(generationId, file) {
  const fileId = Number(file?.id);
  if (!Number.isFinite(fileId) || fileId <= 0) return;

  getDb().prepare(`
    INSERT INTO generation_dirty_files (
      generation_id, file_id, path, content_hash, updated_at
    )
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(generation_id, file_id) DO UPDATE SET
      path = excluded.path,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `).run(
    Number(generationId),
    fileId,
    file.path,
    file.hash || null
  );
}

function listGenerationDirtyFiles(generationId) {
  return getDb().prepare(`
    SELECT *
    FROM generation_dirty_files
    WHERE generation_id = ?
    ORDER BY updated_at ASC, file_id ASC
  `).all(Number(generationId));
}

function clearGenerationDirtyFile(generationId, fileId) {
  getDb().prepare(`
    DELETE FROM generation_dirty_files
    WHERE generation_id = ? AND file_id = ?
  `).run(Number(generationId), Number(fileId));
}

function clearAllDirtyFiles(generationId) {
  getDb().prepare('DELETE FROM generation_dirty_files WHERE generation_id = ?').run(Number(generationId));
}

function applyGenerationAsActiveFileStatus(generationId) {
  const files = getDb().prepare('SELECT id, path, hash FROM files ORDER BY path COLLATE NOCASE').all();

  getDb().prepare('DELETE FROM file_index_status').run();
  files.forEach((file) => {
    const result = getGenerationFileResult(generationId, file.id);
    if (result) {
      setFileIndexStatus(file, generationId, {
        status: result.status,
        content_hash: result.content_hash,
        chunks_count: result.chunks_count,
        text_indexed: result.text_indexed,
        vector_indexed: result.vector_indexed,
        image_vector_indexed: result.image_vector_indexed,
        error: result.error,
      });
    } else {
      setFileQueued(file, generationId, { contentHash: file.hash || null });
    }
  });
}

function summarizeFileIndexStatus() {
  const row = getDb().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(s.status, 'queued') = 'ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN COALESCE(s.status, 'queued') = 'degraded' THEN 1 ELSE 0 END) AS degraded,
      SUM(CASE WHEN COALESCE(s.status, 'queued') = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN COALESCE(s.status, 'queued') = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN COALESCE(s.status, 'queued') = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM files f
    LEFT JOIN file_index_status s ON s.file_id = f.id
  `).get();

  const summary = {
    total: Number(row?.total || 0),
    ready: Number(row?.ready || 0),
    degraded: Number(row?.degraded || 0),
    queued: Number(row?.queued || 0),
    running: Number(row?.running || 0),
    failed: Number(row?.failed || 0),
  };
  summary.indexed = summary.ready + summary.degraded;
  summary.pending = summary.queued + summary.running;
  return summary;
}

function buildEmbeddingApplyState() {
  const activeGeneration = getActiveGeneration();
  const activeEmbedding = activeGeneration?.config_snapshot_object || null;
  const desiredEmbedding = buildEmbeddingConfig();
  const rebuildGeneration = getLatestRebuildGeneration();

  if (activeEmbedding && sameEmbeddingConfig(activeEmbedding, desiredEmbedding)) {
    return 'active';
  }

  if (rebuildGeneration && REBUILD_STATES.has(rebuildGeneration.state) &&
    sameEmbeddingConfig(rebuildGeneration.config_snapshot_object || {}, desiredEmbedding)) {
    return 'rebuilding';
  }

  if (rebuildGeneration && rebuildGeneration.state === 'failed' &&
    sameEmbeddingConfig(rebuildGeneration.config_snapshot_object || {}, desiredEmbedding)) {
    return 'failed';
  }

  return 'pending_rebuild';
}

function ensureActiveGeneration() {
  syncFilesFromDisk();

  const existing = getActiveGeneration();
  if (existing) return existing;

  const desiredConfig = buildEmbeddingConfig();
  const files = getDb().prepare('SELECT id, path, hash, indexed, index_error FROM files ORDER BY path COLLATE NOCASE').all();
  const generation = createGeneration({
    kind: 'bootstrap',
    state: 'building',
    configSnapshot: desiredConfig,
    totalFiles: files.length,
    progress: {
      stage: 'bootstrap',
      current: files.length,
      total: files.length,
      currentFile: '',
      dirty_files: 0,
    },
  });

  let copied = {
    chunks: 0,
    images: 0,
    chunk_vec_copied: false,
    image_vec_copied: false,
  };

  try {
    copied = copyLegacyIndexFromMainDb(generation, getDb());
  } catch (error) {
    logger.warn('index_generations.bootstrap_legacy_copy_failed', {
      generation_id: generation.id,
      error,
    });
  }

  files.forEach((file) => {
    const chunkRow = getDb().prepare('SELECT COUNT(*) AS count FROM chunks WHERE file_id = ?').get(file.id);
    const chunkCount = Number(chunkRow?.count || 0);
    let status = 'queued';
    let error = null;
    let textIndexed = 0;
    let vectorIndexed = 0;
    let imageVectorIndexed = 0;

    if (file.indexed === 1) {
      status = copied.chunk_vec_copied ? 'ready' : 'degraded';
      textIndexed = 1;
      vectorIndexed = copied.chunk_vec_copied ? 1 : 0;
      imageVectorIndexed = copied.image_vec_copied ? 1 : 0;
      if (!copied.chunk_vec_copied && chunkCount > 0) {
        error = '已迁移文本索引，但旧向量索引未能复制，建议执行一次重建';
      }
    } else if (chunkCount > 0) {
      status = 'degraded';
      textIndexed = 1;
      vectorIndexed = 0;
      imageVectorIndexed = 0;
      error = file.index_error || '旧索引缺少可用向量，当前先保留文本检索';
    } else if (file.index_error) {
      status = 'failed';
      error = file.index_error;
    }

    upsertGenerationFileResult(generation.id, file, {
      status,
      content_hash: file.hash || null,
      chunks_count: chunkCount,
      text_indexed: textIndexed,
      vector_indexed: vectorIndexed,
      image_vector_indexed: imageVectorIndexed,
      error,
    });
  });

  updateGeneration(generation.id, {
    state: 'validated',
    processed_files: files.length,
    finished_at: new Date().toISOString(),
    progress: JSON.stringify({
      stage: 'validated',
      current: files.length,
      total: files.length,
      currentFile: '',
      dirty_files: 0,
      copied,
    }),
  });

  const active = activateGeneration(generation.id);
  applyGenerationAsActiveFileStatus(active.id);
  return active;
}

module.exports = {
  ACTIVE_GENERATION_KEY,
  REBUILD_STATES,
  ACTIVE_LIKE_STATES,
  SUCCESS_STATES,
  buildEmbeddingConfig,
  sanitizeEmbeddingConfig,
  sameEmbeddingSignature,
  sameEmbeddingConfig,
  getGenerationById,
  getActiveGenerationId,
  getActiveGeneration,
  getLatestRebuildGeneration,
  listActiveLikeGenerations,
  createGeneration,
  updateGeneration,
  updateGenerationProgress,
  markGenerationFailed,
  updateGenerationConfigSnapshot,
  activateGeneration,
  setFileIndexStatus,
  setFileQueued,
  setFileRunning,
  upsertGenerationFileResult,
  getGenerationFileResult,
  deleteGenerationFileResult,
  upsertGenerationDirtyFile,
  listGenerationDirtyFiles,
  clearGenerationDirtyFile,
  clearAllDirtyFiles,
  applyGenerationAsActiveFileStatus,
  summarizeFileIndexStatus,
  sanitizeGenerationForApi,
  buildEmbeddingApplyState,
  ensureActiveGeneration,
};
