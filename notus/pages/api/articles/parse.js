const { ensureRuntime } = require('../../../lib/runtime');
const { getFileById } = require('../../../lib/files');
const { articleFromMarkdown } = require('../../../utils/markdownBlocks');

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const { file_id: fileId } = req.body || {};
  if (!fileId) return res.status(400).json({ error: 'file_id is required', code: 'FILE_ID_REQUIRED' });

  const file = getFileById(fileId);
  if (!file) return res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });

  const article = articleFromMarkdown({
    id: `article_${file.id}`,
    file_id: file.id,
    title: file.title,
    markdown: file.content,
  });

  return res.status(200).json(article);
}
