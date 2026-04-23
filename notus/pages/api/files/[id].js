const { ensureRuntime } = require('../../../lib/runtime');
const { deleteFile, getFileById, updateFile } = require('../../../lib/files');
const { queueFileIndexing } = require('../../../lib/fileIndexing');
const { getIndexCoordinator } = require('../../../lib/indexCoordinator');
const { createLogger, createRequestContext } = require('../../../lib/logger');

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/files/[id]');
  const logger = createLogger(context);
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('files.runtime.failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const { id } = req.query;

  if (req.method === 'GET') {
    const file = getFileById(id);
    if (!file) return res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND', request_id: context.request_id });
    return res.status(200).json({ ...file, request_id: context.request_id });
  }

  if (req.method === 'PUT') {
    try {
      const { content = '' } = req.body || {};
      const file = updateFile(id, content);
      const indexState = await queueFileIndexing(file.path, logger, { action: 'save', file_id: Number(id) });
      return res.status(200).json({
        ...file,
        save_status: 'saved',
        index_state: indexState.index_state,
        active_generation_id: indexState.active_generation_id,
        request_id: context.request_id,
      });
    } catch (error) {
      logger.error('files.save.failed', { file_id: Number(id), error });
      return res.status(400).json({ error: error.message, code: 'FILE_SAVE_FAILED', request_id: context.request_id });
    }
  }

  if (req.method === 'DELETE') {
    const existing = getFileById(id);
    if (existing?.path) getIndexCoordinator().removePath(existing.path);
    if (!deleteFile(id)) {
      return res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND', request_id: context.request_id });
    }
    return res.status(204).end();
  }

  return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
}
