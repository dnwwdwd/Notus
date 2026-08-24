const { ensureRuntime } = require('../../../../../../lib/runtime');
const { listHistory } = require('../../../../../../lib/globalAgentFiles');
const { createLogger, createRequestContext } = require('../../../../../../lib/logger');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/settings/agent-files/[file]/history');
  const logger = createLogger(context);
  if (req.method !== 'GET') return res.status(405).end();
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: '全局 Agent 文件服务初始化失败', code: 'RUNTIME_ERROR', request_id: context.request_id });
  try {
    return res.status(200).json({ versions: listHistory(String(req.query.file || '')).map(({ content, ...item }) => item), request_id: context.request_id });
  } catch (error) {
    logger.warn('agent_files.history.list_failed', { error });
    return res.status(400).json({ error: error.message || '读取历史失败', code: error.code || 'AGENT_FILE_HISTORY_FAILED', request_id: context.request_id });
  }
}
