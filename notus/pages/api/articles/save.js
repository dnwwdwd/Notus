const { ensureRuntime } = require('../../../lib/runtime');
const { blocksToMarkdown } = require('../../../utils/markdownBlocks');
const { createFile, getFileById, updateFile } = require('../../../lib/files');
const { indexFile } = require('../../../lib/indexer');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const { article, path } = req.body || {};
  if (!article || !Array.isArray(article.blocks)) {
    return res.status(400).json({ error: 'article.blocks is required', code: 'INVALID_ARTICLE' });
  }

  const markdown = blocksToMarkdown(article.blocks);

  try {
    let file;
    if (article.file_id) {
      file = updateFile(article.file_id, markdown);
    } else {
      const targetPath = path || `${String(article.title || '未命名文章').trim() || '未命名文章'}.md`;
      file = createFile(targetPath, markdown);
    }

    await indexFile(file.path);
    const latest = getFileById(file.id);
    return res.status(200).json({
      ok: true,
      file_id: latest.id,
      path: latest.path,
      title: latest.title,
      article: {
        id: article.id || `article_${latest.id}`,
        file_id: latest.id,
        title: latest.title,
        blocks: article.blocks,
      },
    });
  } catch (error) {
    return res.status(400).json({ error: error.message, code: 'ARTICLE_SAVE_FAILED' });
  }
}
