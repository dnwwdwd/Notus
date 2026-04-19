const { ensureRuntime } = require('../../../lib/runtime');
const { deleteFile, getFileById, updateFile } = require('../../../lib/files');
const { indexFile } = require('../../../lib/indexer');

export default async function handler(req, res) {
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const { id } = req.query;

  if (req.method === 'GET') {
    const file = getFileById(id);
    if (!file) return res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
    return res.status(200).json(file);
  }

  if (req.method === 'PUT') {
    try {
      const { content = '' } = req.body || {};
      const file = updateFile(id, content);
      const indexResult = await indexFile(file.path);
      return res.status(200).json({ ...file, indexed: indexResult.embeddingFailed ? 0 : 1 });
    } catch (error) {
      return res.status(400).json({ error: error.message, code: 'FILE_SAVE_FAILED' });
    }
  }

  if (req.method === 'DELETE') {
    if (!deleteFile(id)) {
      return res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
    }
    return res.status(204).end();
  }

  return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
}
