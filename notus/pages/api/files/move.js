const { ensureRuntime } = require('../../../lib/runtime');
const { moveFiles } = require('../../../lib/files');
const { indexBatch } = require('../../../lib/indexer');
const { createLogger, createRequestContext } = require('../../../lib/logger');

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/files/move');
  const logger = createLogger(context);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('files.runtime.failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  try {
    const { paths = [], dest = '' } = req.body || {};
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths is required', code: 'INVALID_PATHS', request_id: context.request_id });
    }

    const files = moveFiles(paths, dest);
    const indexSummary = await indexBatch(files.map((file) => file.path));
    logger.info('files.move.completed', {
      moved_count: files.length,
      failed_count: indexSummary.failed || 0,
    });
    return res.status(200).json({ files, index_summary: indexSummary, request_id: context.request_id });
  } catch (error) {
    logger.error('files.move.failed', { error, body: req.body || null });
    return res.status(400).json({ error: error.message, code: 'FILE_MOVE_FAILED', request_id: context.request_id });
  }
}
