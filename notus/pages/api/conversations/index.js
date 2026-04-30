const { ensureRuntime } = require('../../../lib/runtime');
const {
  createConversation,
  listConversations,
} = require('../../../lib/conversations');

export default function handler(req, res) {
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  if (req.method === 'GET') {
    const kind = req.query.kind ? String(req.query.kind) : null;
    const fileId = req.query.file_id !== undefined ? req.query.file_id : undefined;
    const draftKey = req.query.draft_key !== undefined ? req.query.draft_key : undefined;
    const limit = req.query.limit !== undefined ? req.query.limit : undefined;
    const rows = listConversations({ kind, fileId, draftKey, limit });
    return res.status(200).json(rows);
  }

  if (req.method === 'POST') {
    const {
      title = '新对话',
      kind = 'knowledge',
      file_id: fileId = null,
      draft_key: draftKey = null,
    } = req.body || {};
    const conversation = createConversation({
      kind,
      title,
      fileId,
      draftKey,
    });
    return res.status(201).json(conversation);
  }

  return res.status(405).end();
}
