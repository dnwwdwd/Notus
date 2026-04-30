const { ensureRuntime } = require('../../../lib/runtime');
const { getFileById } = require('../../../lib/files');
const { articleFromMarkdown } = require('../../../utils/markdownBlocks');

function detectFallbackBlockType(content = '') {
  if (/^#{1,6}\s/m.test(content)) return 'heading';
  if (/^```/m.test(content)) return 'code';
  if (/^\|.+\|$/m.test(content)) return 'table';
  if (/^>\s/m.test(content)) return 'blockquote';
  if (/^([-*+]|\d+\.)\s/m.test(content)) return 'list';
  return 'paragraph';
}

function buildFallbackArticle(file) {
  const source = String(file?.content || '').replace(/\r\n/g, '\n').trim();
  const segments = source
    ? source.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
    : [];
  const blocks = (segments.length > 0 ? segments : [source])
    .filter(Boolean)
    .map((content, index) => ({
      id: `b_${index + 1}`,
      type: detectFallbackBlockType(content),
      content,
      headingLevel: 0,
      headingPath: '',
      lineStart: null,
      lineEnd: null,
      semanticGroup: 'fallback',
    }));

  return {
    id: `article_${file.id}`,
    file_id: file.id,
    title: file.title,
    blocks,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
    return;
  }

  const { file_id: fileId } = req.body || {};
  if (!fileId) {
    res.status(400).json({ error: 'file_id is required', code: 'FILE_ID_REQUIRED' });
    return;
  }

  const file = getFileById(fileId);
  if (!file) {
    res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
    return;
  }

  try {
    const article = await articleFromMarkdown({
      id: `article_${file.id}`,
      file_id: file.id,
      title: file.title,
      markdown: file.content,
    });
    res.status(200).json(article);
    return;
  } catch {
    res.status(200).json(buildFallbackArticle(file));
  }
}
