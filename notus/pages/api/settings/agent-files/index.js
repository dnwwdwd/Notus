const { ensureRuntime } = require('../../../../lib/runtime');
const { FILE_TYPES, initializeGlobalAgentFiles, statusFor } = require('../../../../lib/globalAgentFiles');
const { createLogger, createRequestContext } = require('../../../../lib/logger');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/settings/agent-files');
  const logger = createLogger(context);
  if (req.method !== 'GET') return res.status(405).end();
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: '全局 Agent 文件服务初始化失败', code: 'RUNTIME_ERROR', request_id: context.request_id });
  try {
    initializeGlobalAgentFiles();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ files: FILE_TYPES.map(statusFor), request_id: context.request_id });
  } catch (error) {
    logger.error('agent_files.list.failed', { error });
    return res.status(500).json({ error: '读取全局 Agent 文件失败', code: error.code || 'AGENT_FILE_READ_FAILED', request_id: context.request_id });
  }
}
