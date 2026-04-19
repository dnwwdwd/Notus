const { ensureRuntime } = require('../../../lib/runtime');
const { createFile, createFolder, getAllFiles } = require('../../../lib/files');
const { indexFile } = require('../../../lib/indexer');

export default async function handler(req, res) {
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

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
        return res.status(201).json(createFolder(path));
      }

      const file = createFile(path, content);
      const indexResult = await indexFile(file.path);
      return res.status(201).json({ ...file, indexed: indexResult.embeddingFailed ? 0 : 1 });
    } catch (error) {
      return res.status(400).json({ error: error.message, code: 'FILE_CREATE_FAILED' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
}
