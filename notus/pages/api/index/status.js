const { ensureRuntime } = require('../../../lib/runtime');
const { getDb } = require('../../../lib/db');
const { syncFilesFromDisk } = require('../../../lib/files');
const { createLogger, createRequestContext } = require('../../../lib/logger');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/index/status');
  const logger = createLogger(context);
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('index.status.runtime_failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  syncFilesFromDisk();
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN indexed = 1 THEN 1 ELSE 0 END) AS indexed,
      SUM(CASE WHEN indexed = 0 AND index_error IS NULL THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN indexed = 0 AND index_error IS NOT NULL THEN 1 ELSE 0 END) AS failed
    FROM files
  `).get();

  return res.status(200).json({
    total: row.total || 0,
    indexed: row.indexed || 0,
    pending: row.pending || 0,
    failed: row.failed || 0,
    request_id: context.request_id,
  });
}
