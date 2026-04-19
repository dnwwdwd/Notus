const { ensureRuntime } = require('../../../lib/runtime');
const { buildTree } = require('../../../lib/files');

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  return res.status(200).json(buildTree());
}
