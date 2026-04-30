const { ensureRuntime } = require('../../../lib/runtime');
const {
  getConversation,
  getConversationMessages,
} = require('../../../lib/conversations');
const { getDb } = require('../../../lib/db');

export default function handler(req, res) {
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const id = Number(req.query.id);

  if (req.method === 'GET') {
    const conversation = getConversation(id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' });
    const messages = getConversationMessages(id);
    return res.status(200).json({ ...conversation, messages });
  }

  if (req.method === 'DELETE') {
    getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return res.status(204).end();
  }

  return res.status(405).end();
}
