const { ensureRuntime } = require('../../../lib/runtime');
const { getDb } = require('../../../lib/db');
const { indexBatch, retryFailedIndexing } = require('../../../lib/indexer');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const { file_ids: fileIds } = req.body || {};

  try {
    if (Array.isArray(fileIds) && fileIds.length > 0) {
      const placeholders = fileIds.map(() => '?').join(',');
      const rows = getDb().prepare(`SELECT path FROM files WHERE id IN (${placeholders})`).all(...fileIds.map(Number));
      const result = await indexBatch(rows.map((row) => row.path));
      return res.status(200).json(result);
    }

    const result = await retryFailedIndexing(100);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message, code: 'INDEX_RETRY_FAILED' });
  }
}
