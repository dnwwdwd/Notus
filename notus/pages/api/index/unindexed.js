const { ensureRuntime } = require('../../../lib/runtime');
const { getDb } = require('../../../lib/db');
const { syncFilesFromDisk } = require('../../../lib/files');
const { createLogger, createRequestContext } = require('../../../lib/logger');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/index/unindexed');
  const logger = createLogger(context);
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('index.unindexed.runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  syncFilesFromDisk();
  const files = getDb().prepare(`
    SELECT id, path, title, hash, index_error
    FROM files
    WHERE indexed = 0
    ORDER BY CASE WHEN index_error IS NULL THEN 0 ELSE 1 END, path COLLATE NOCASE
  `).all().map((row) => ({
    id: Number(row.id),
    path: row.path,
    title: row.title || '',
    hash: row.hash || '',
    status: row.index_error ? 'failed' : 'pending',
    error: row.index_error || '',
  }));

  return res.status(200).json({ files, request_id: context.request_id });
}
