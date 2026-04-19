const { ensureRuntime } = require('../../../lib/runtime');
const { getDb } = require('../../../lib/db');

export default function handler(req, res) {
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const db = getDb();

  if (req.method === 'GET') {
    const kind = req.query.kind ? String(req.query.kind) : null;
    const rows = kind
      ? db.prepare(`
        SELECT c.*, COUNT(m.id) AS message_count, MAX(m.content) AS preview
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE c.kind = ?
        GROUP BY c.id
        ORDER BY c.updated_at DESC
      `).all(kind)
      : db.prepare(`
        SELECT c.*, COUNT(m.id) AS message_count, MAX(m.content) AS preview
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id
        GROUP BY c.id
        ORDER BY c.updated_at DESC
      `).all();
    return res.status(200).json(rows);
  }

  if (req.method === 'POST') {
    const { title = '新对话', kind = 'knowledge', file_id: fileId = null } = req.body || {};
    const result = db.prepare(`
      INSERT INTO conversations (kind, title, file_id, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
    `).run(kind, title, fileId ? Number(fileId) : null);
    return res.status(201).json({
      id: result.lastInsertRowid,
      kind,
      title,
      file_id: fileId ? Number(fileId) : null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      message_count: 0,
      preview: '',
    });
  }

  return res.status(405).end();
}
