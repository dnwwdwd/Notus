const { ensureRuntime } = require('../../../../lib/runtime');
const { readFile, saveFile, statusFor } = require('../../../../lib/globalAgentFiles');
const { createLogger, createRequestContext } = require('../../../../lib/logger');

function respondError(res, context, error, logger) {
  const code = error.code || 'AGENT_FILE_REQUEST_FAILED';
  const status = ['AGENT_FILE_INVALID_TYPE', 'AGENT_FILE_EMPTY', 'AGENT_FILE_TOO_LARGE'].includes(code) ? 400
    : ['AGENT_FILE_VERSION_CONFLICT', 'AGENT_FILE_WRITE_CONFLICT'].includes(code) ? 409
      : 500;
  logger.warn('agent_files.request.failed', { code, error });
  return res.status(status).json({ error: error.message || '全局 Agent 文件操作失败', code, request_id: context.request_id });
}

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/settings/agent-files/[file]');
  const logger = createLogger(context);
  if (!['GET', 'PUT'].includes(req.method)) return res.status(405).end();
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: '全局 Agent 文件服务初始化失败', code: 'RUNTIME_ERROR', request_id: context.request_id });
  try {
    const file = String(req.query.file || '');
    if (req.method === 'GET') {
      const record = readFile(file);
      return res.status(200).json({ ...statusFor(file), content: record.content, request_id: context.request_id });
    }
    const result = saveFile(file, req.body?.content, {
      expectedHash: String(req.body?.expected_hash || ''),
      allowEmpty: Boolean(req.body?.allow_empty),
      source: 'user_settings',
    });
    return res.status(200).json({ ...result, request_id: context.request_id });
  } catch (error) {
    return respondError(res, context, error, logger);
  }
}
