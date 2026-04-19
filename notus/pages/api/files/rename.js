const { ensureRuntime } = require('../../../lib/runtime');
const { renameFile } = require('../../../lib/files');
const { indexFile } = require('../../../lib/indexer');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  try {
    const { old_path: oldPath, new_path: newPath } = req.body || {};
    const file = renameFile(oldPath, newPath);
    const indexResult = await indexFile(file.path);
    return res.status(200).json({ ...file, indexed: indexResult.embeddingFailed ? 0 : 1 });
  } catch (error) {
    return res.status(400).json({ error: error.message, code: 'FILE_RENAME_FAILED' });
  }
}
