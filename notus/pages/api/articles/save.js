const { ensureRuntime } = require('../../../lib/runtime');
const { blocksToMarkdown } = require('../../../utils/markdownBlocks');
const { createFile, getFileById, updateFile } = require('../../../lib/files');
const { indexFileWithFallback } = require('../../../lib/fileIndexing');
const { createLogger, createRequestContext } = require('../../../lib/logger');

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/articles/save');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });

  const { article, path } = req.body || {};
  if (!article || !Array.isArray(article.blocks)) {
    return res.status(400).json({ error: 'article.blocks is required', code: 'INVALID_ARTICLE', request_id: context.request_id });
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

    const indexState = await indexFileWithFallback(file.path, logger, { action: 'article-save' });
    const latest = getFileById(file.id);
    return res.status(200).json({
      ok: true,
      file_id: latest.id,
      path: latest.path,
      title: latest.title,
      indexed: indexState.indexed,
      warning: indexState.warning,
      warning_code: indexState.warning_code,
      request_id: context.request_id,
      article: {
        id: article.id || `article_${latest.id}`,
        file_id: latest.id,
        title: latest.title,
        blocks: article.blocks,
      },
    });
  } catch (error) {
    logger.error('articles.save.failed', { error });
    return res.status(400).json({ error: error.message, code: 'ARTICLE_SAVE_FAILED', request_id: context.request_id });
  }
}
