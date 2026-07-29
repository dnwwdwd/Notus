const { ensureRuntime } = require('../../../../../../lib/runtime');
const { getHistoryVersion, rollbackHistory } = require('../../../../../../lib/globalAgentFiles');
const { createLogger, createRequestContext } = require('../../../../../../lib/logger');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/settings/agent-files/[file]/history/[versionId]');
  const logger = createLogger(context);
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).end();
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: '全局 Agent 文件服务初始化失败', code: 'RUNTIME_ERROR', request_id: context.request_id });
  try {
    const file = String(req.query.file || '');
    const versionId = String(req.query.versionId || '');
    if (req.method === 'GET') return res.status(200).json({ ...getHistoryVersion(file, versionId), request_id: context.request_id });
    const result = rollbackHistory(file, versionId, { expectedHash: String(req.body?.expected_hash || '') });
    return res.status(200).json({ ...result, request_id: context.request_id });
  } catch (error) {
    const code = error.code || 'AGENT_FILE_HISTORY_FAILED';
    logger.warn('agent_files.history.request_failed', { code, error });
    return res.status(['AGENT_FILE_VERSION_CONFLICT', 'AGENT_FILE_WRITE_CONFLICT'].includes(code) ? 409 : 400).json({ error: error.message || '历史版本操作失败', code, request_id: context.request_id });
  }
}
