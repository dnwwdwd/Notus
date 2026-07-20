const { ensureRuntime } = require('../../../lib/runtime');
const { getCapabilities } = require('../../../lib/skills');

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error?.message || '运行时初始化失败' });
  return res.status(200).json(getCapabilities());
}
