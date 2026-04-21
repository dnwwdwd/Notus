const { ensureRuntime } = require('../../../lib/runtime');
const { renameFile } = require('../../../lib/files');
const { indexFileWithFallback } = require('../../../lib/fileIndexing');
const { createLogger, createRequestContext } = require('../../../lib/logger');

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/files/rename');
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
    const { old_path: oldPath, new_path: newPath } = req.body || {};
    const file = renameFile(oldPath, newPath);
    const indexState = await indexFileWithFallback(file.path, logger, { action: 'rename' });
    return res.status(200).json({
      ...file,
      indexed: indexState.indexed,
      warning: indexState.warning,
      warning_code: indexState.warning_code,
      request_id: context.request_id,
    });
  } catch (error) {
    logger.error('files.rename.failed', { error, body: req.body || null });
    return res.status(400).json({ error: error.message, code: 'FILE_RENAME_FAILED', request_id: context.request_id });
  }
}
