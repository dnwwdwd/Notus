const { ensureRuntime } = require('../../../../../lib/runtime');
const { restoreDefault } = require('../../../../../lib/globalAgentFiles');
const { createLogger, createRequestContext } = require('../../../../../lib/logger');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/settings/agent-files/[file]/restore-default');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).end();
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: '全局 Agent 文件服务初始化失败', code: 'RUNTIME_ERROR', request_id: context.request_id });
  try {
    const result = restoreDefault(String(req.query.file || ''), { expectedHash: String(req.body?.expected_hash || '') });
    return res.status(200).json({ ...result, request_id: context.request_id });
  } catch (error) {
    const code = error.code || 'AGENT_FILE_RESTORE_FAILED';
    logger.warn('agent_files.restore.failed', { code, error });
    return res.status(['AGENT_FILE_VERSION_CONFLICT', 'AGENT_FILE_WRITE_CONFLICT'].includes(code) ? 409 : 400).json({ error: error.message || '恢复默认失败', code, request_id: context.request_id });
  }
}
