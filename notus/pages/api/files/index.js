const { ensureRuntime } = require('../../../lib/runtime');
const { createFile, createFolder, getAllFiles } = require('../../../lib/files');
const { queueFileIndexing } = require('../../../lib/fileIndexing');
const { createLogger, createRequestContext } = require('../../../lib/logger');

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/files');
  const logger = createLogger(context);
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('files.runtime.failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  if (req.method === 'GET') {
    const query = String(req.query.query || '').trim().toLowerCase();
    const files = getAllFiles().filter((file) => {
      if (!query) return true;
      return file.path.toLowerCase().includes(query) || file.title.toLowerCase().includes(query);
    });
    return res.status(200).json(files);
  }

  if (req.method === 'POST') {
    try {
      const { path, content, kind = 'file' } = req.body || {};
      if (kind === 'folder') {
        const folder = createFolder(path);
        logger.info('files.folder.created', { folder_path: folder.path });
        return res.status(201).json({ ...folder, request_id: context.request_id });
      }

      const file = createFile(path, content);
      const indexState = await queueFileIndexing(file.path, logger, { action: 'create' });
      return res.status(201).json({
        ...file,
        index_state: indexState.index_state,
        active_generation_id: indexState.active_generation_id,
        request_id: context.request_id,
      });
    } catch (error) {
      logger.error('files.create.failed', { error, body: req.body || null });
      return res.status(400).json({ error: error.message, code: 'FILE_CREATE_FAILED', request_id: context.request_id });
    }
  }

  return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
}
