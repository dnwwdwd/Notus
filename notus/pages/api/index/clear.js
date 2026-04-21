const { ensureRuntime } = require('../../../lib/runtime');
const { clearIndex } = require('../../../lib/indexer');

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  try {
    clearIndex();
    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message, code: 'INDEX_CLEAR_FAILED' });
  }
}
