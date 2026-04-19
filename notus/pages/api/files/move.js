const { ensureRuntime } = require('../../../lib/runtime');
const { moveFiles } = require('../../../lib/files');
const { indexBatch } = require('../../../lib/indexer');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  try {
    const { paths = [], dest = '' } = req.body || {};
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths is required', code: 'INVALID_PATHS' });
    }

    const files = moveFiles(paths, dest);
    await indexBatch(files.map((file) => file.path));
    return res.status(200).json({ files });
  } catch (error) {
    return res.status(400).json({ error: error.message, code: 'FILE_MOVE_FAILED' });
  }
}
