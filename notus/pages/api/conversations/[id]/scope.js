const { ensureRuntime } = require('../../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../../lib/logger');
const {
  getConversation,
  resetConversationScopes,
  updateConversationScopes,
} = require('../../../../lib/conversations');
const {
  SCOPE_KEYS,
  validateScope,
} = require('../../../../lib/workspaceScope');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/conversations/[id]/scope');
  const logger = createLogger(context);
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('conversation.scope.failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const id = Number(req.query.id);
  const conversation = getConversation(id);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND', request_id: context.request_id });
  }

  if (req.method === 'DELETE') {
    const updated = resetConversationScopes(id);
    return res.status(200).json({ conversation: updated, request_id: context.request_id });
  }

  if (req.method !== 'PUT') return res.status(405).end();

  const body = req.body || {};
  const updates = {};
  SCOPE_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(body, key)) updates[key] = body[key];
  });

  const warnings = [];
  Object.entries(updates).forEach(([key, scope]) => {
    const validation = validateScope(scope, { activeFileId: conversation.file_id });
    if (validation.warning) warnings.push({ key, warning: validation.warning, doc_count: validation.doc_count });
  });

  const updated = updateConversationScopes(id, updates);
  logger.info('conversation.scope.updated', {
    conversation_id: id,
    updated_keys: Object.keys(updates),
    warning_count: warnings.length,
  });

  return res.status(200).json({
    conversation: updated,
    warnings,
    request_id: context.request_id,
  });
}
