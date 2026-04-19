const { ensureRuntime } = require('../../../lib/runtime');
const { getFileById } = require('../../../lib/files');
const { articleFromMarkdown } = require('../../../utils/markdownBlocks');

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const file = getFileById(req.query.id);
  if (!file) return res.status(404).json({ error: 'Article not found', code: 'ARTICLE_NOT_FOUND' });

  return res.status(200).json(articleFromMarkdown({
    id: `article_${file.id}`,
    file_id: file.id,
    title: file.title,
    markdown: file.content,
  }));
}
