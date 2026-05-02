const { ensureRuntime } = require('../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../lib/logger');
const {
  getConversation,
  getConversationMessages,
} = require('../../../lib/conversations');
const { getDb } = require('../../../lib/db');
const { listOperationSetsByConversation } = require('../../../lib/canvasOperationSets');
const { listInteractionsByConversation } = require('../../../lib/conversationInteractions');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/conversations/[id]');
  const logger = createLogger(context);
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('canvas.operation_set.restored', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const id = Number(req.query.id);

  if (req.method === 'GET') {
    const conversation = getConversation(id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND', request_id: context.request_id });
    }
    const messages = getConversationMessages(id);
    const pendingOperationSets = conversation.kind === 'canvas'
      ? listOperationSetsByConversation(id, {
        articleHash: String(req.query.article_hash || '').trim() || undefined,
      })
      : [];
    const pendingInteractions = conversation.kind === 'canvas'
      ? listInteractionsByConversation(id, {
        articleHash: String(req.query.article_hash || '').trim() || undefined,
      })
      : [];
    if (conversation.kind === 'canvas') {
      logger.info('canvas.operation_set.restored', {
        conversation_id: conversation.id,
        file_id: conversation.file_id || null,
        canvas_mode: 'restore',
        scope_mode: 'none',
        operation_kind: '',
        helper_used: false,
        operation_count: pendingOperationSets.reduce((sum, item) => {
          return sum + (Array.isArray(item.operations) ? item.operations.length : 0);
        }, 0),
        fallback_reason: null,
        operation_set_status: pendingOperationSets.map((item) => item.status).join(',') || null,
      });
    }
    return res.status(200).json({
      ...conversation,
      messages,
      pending_operation_sets: pendingOperationSets,
      pending_interactions: pendingInteractions,
      request_id: context.request_id,
    });
  }

  if (req.method === 'DELETE') {
    getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return res.status(204).end();
  }

  return res.status(405).end();
}
