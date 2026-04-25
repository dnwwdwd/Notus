const { ensureRuntime } = require('../../../lib/runtime');
const { applyOperation } = require('../../../lib/diff');

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

  return res.status(200).json(result);
}
