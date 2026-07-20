const { ensureRuntime } = require('../../../lib/runtime');
const { createSkillDraft } = require('../../../lib/skills');

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!ensureRuntime().ok) return res.status(500).json({ error: '运行时初始化失败' });
  try { return res.status(201).json({ draft: createSkillDraft(req.body || {}) }); } catch (error) { return res.status(400).json({ error: error.message, code: error.code || 'SKILL_DRAFT_ERROR' }); }
}
