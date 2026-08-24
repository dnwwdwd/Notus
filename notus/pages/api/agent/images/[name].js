const fs = require('fs');
const { ensureRuntime } = require('../../../../lib/runtime');
const {
  listConversationImages,
  resolveStoredImagePath,
} = require('../../../../lib/conversationImages');

function normalizeConversationId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).end();
  const conversationId = normalizeConversationId(req.query.conversation_id);
  if (!conversationId) return res.status(400).end();
  const storedName = String(req.query.name || '');
  const belongsToConversation = listConversationImages(conversationId)
    .some((image) => image.stored_name === storedName);
  if (!belongsToConversation) return res.status(404).end();
  const imagePath = resolveStoredImagePath(storedName);
  if (!imagePath || !fs.existsSync(imagePath)) return res.status(404).end();
  const extension = imagePath.slice(imagePath.lastIndexOf('.')).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extension] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return fs.createReadStream(imagePath).pipe(res);
}
