const { ensureRuntime } = require('../../../lib/runtime');
const { streamExport } = require('../../../lib/backup');
const { createLogger, createRequestContext } = require('../../../lib/logger');

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/backup/export');
  const logger = createLogger(context);
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    const status = runtime.error?.code === 'DATA_MAINTENANCE' ? 503 : 500;
    return res.status(status).json({ error: runtime.error?.message || '运行时初始化失败', code: runtime.error?.code || 'RUNTIME_ERROR', request_id: context.request_id });
  }
  try {
    await streamExport(res);
  } catch (error) {
    logger.error('backup.export.failed', { error });
    if (!res.headersSent) return res.status(error.status || 500).json({ error: '备份导出失败', code: error.code || 'BACKUP_EXPORT_FAILED', request_id: context.request_id });
    res.end();
  }
}
