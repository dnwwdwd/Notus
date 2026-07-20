const { ensureRuntime } = require('../../../lib/runtime');
const { listSkills, scanAllSkills, skillRoots } = require('../../../lib/skills');

export default function handler(req, res) {
  if (!ensureRuntime().ok) return res.status(500).json({ error: '运行时初始化失败' });
  if (req.method === 'GET') return res.status(200).json({ skills: listSkills({ includeMissing: req.query.include_missing === '1' }), roots: skillRoots() });
  if (req.method === 'POST' && req.body?.action === 'rescan') return res.status(200).json({ skills: scanAllSkills() });
  return res.status(405).end();
}
