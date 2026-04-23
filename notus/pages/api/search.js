const { ensureRuntime } = require('../../lib/runtime');
const { hybridSearch } = require('../../lib/retrieval');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const { query, topK, top_k: top_k, file_ids: fileIds = [] } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required', code: 'QUERY_REQUIRED' });

  try {
    const result = await hybridSearch(query, { topK: topK || top_k, fileIds });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message, code: 'SEARCH_FAILED' });
  }
}
