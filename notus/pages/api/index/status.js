const { ensureRuntime } = require('../../../lib/runtime');
const { syncFilesFromDisk } = require('../../../lib/files');
const {
  summarizeFileIndexStatus,
  sanitizeGenerationForApi,
  getActiveGeneration,
  getLatestRebuildGeneration,
} = require('../../../lib/indexGenerations');
const { createLogger, createRequestContext } = require('../../../lib/logger');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/index/status');
  const logger = createLogger(context);
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('index.status.runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  syncFilesFromDisk();
  const summary = summarizeFileIndexStatus();
  const activeGeneration = getActiveGeneration();
  const rebuildGeneration = getLatestRebuildGeneration();
  const rebuildProgress = rebuildGeneration?.progress_object || {};

  return res.status(200).json({
    ...summary,
    active_generation: sanitizeGenerationForApi(activeGeneration),
    rebuild_generation: rebuildGeneration && rebuildGeneration.id !== activeGeneration?.id
      ? {
        ...sanitizeGenerationForApi(rebuildGeneration),
        current: Number(rebuildProgress.current || rebuildGeneration.processed_files || 0),
        total: Number(rebuildProgress.total || rebuildGeneration.total_files || 0),
        dirty_files: Number(rebuildProgress.dirty_files || 0),
        error: rebuildProgress.error || rebuildGeneration.error_summary || null,
      }
      : null,
    request_id: context.request_id,
  });
}
