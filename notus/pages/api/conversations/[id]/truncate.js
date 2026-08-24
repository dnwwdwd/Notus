const { ensureRuntime } = require('../../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../../lib/logger');
const { rewriteConversationFromMessage } = require('../../../../lib/conversations');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/conversations/[id]/truncate');
  const logger = createLogger(context);
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('conversation.truncate.failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  if (req.method !== 'POST') return res.status(405).end();

  try {
    const result = rewriteConversationFromMessage({
      conversationId: req.query.id,
      messageId: req.body?.message_id || req.body?.messageId,
      content: req.body?.content,
    });
    return res.status(200).json({
      ...result,
      request_id: context.request_id,
    });
  } catch (error) {
    logger.error('conversation.truncate.failed', { error });
    const status = error.code === 'MESSAGE_NOT_FOUND' ? 404 : 400;
    return res.status(status).json({
      error: error.message || '截断对话失败',
      code: error.code || 'CONVERSATION_TRUNCATE_FAILED',
      request_id: context.request_id,
    });
  }
}
