const { ensureRuntime } = require('../../../lib/runtime');
const { applyOperation } = require('../../../lib/diff');
const { blocksToMarkdown } = require('../../../utils/markdownBlocks');
const { getFileById, updateFile } = require('../../../lib/files');
const { queueFileIndexing } = require('../../../lib/fileIndexing');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const { article_id: articleId, article, operation } = req.body || {};
  if (!article?.blocks || !operation) {
    return res.status(400).json({ success: false, error: 'article and operation are required', code: 'INVALID_APPLY_REQUEST' });
  }

  const result = applyOperation(article, operation);
  if (!result.success) return res.status(409).json(result);

  try {
    const fileId = article.file_id || articleId;
    if (fileId) {
      const file = getFileById(fileId);
      if (file) {
        const markdown = blocksToMarkdown(result.article.blocks);
        const saved = updateFile(file.id, markdown);
        await queueFileIndexing(saved.path);
      }
    }
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message, code: 'APPLY_SAVE_FAILED' });
  }
}
