const { ensureRuntime } = require('../../../lib/runtime');
const { getDb } = require('../../../lib/db');

export default function handler(req, res) {
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const db = getDb();
  const id = Number(req.query.id);

  if (req.method === 'GET') {
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' });
    const messages = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(id)
      .map((message) => ({
        ...message,
        citations: message.citations ? JSON.parse(message.citations) : [],
      }));
    return res.status(200).json({ ...conversation, messages });
  }

  if (req.method === 'DELETE') {
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    return res.status(204).end();
  }

  return res.status(405).end();
}
