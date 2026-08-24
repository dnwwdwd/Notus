const { ensureRuntime } = require('../../../lib/runtime');
const { getSkillDraft, installSkillDraft } = require('../../../lib/skills');

export default function handler(req, res) {
  if (!ensureRuntime().ok) return res.status(500).json({ error: '运行时初始化失败' });
  const draft = getSkillDraft(req.query.id);
  if (!draft) return res.status(404).json({ error: '草稿不存在' });
  try {
    if (req.method === 'GET') return res.status(200).json({ draft });
    if (req.method === 'POST' && req.query.action === 'install') return res.status(200).json({ skill: installSkillDraft(draft.id, req.body?.conflictPolicy || 'reject') });
    return res.status(405).end();
  } catch (error) { return res.status(400).json({ error: error.message, code: error.code || 'SKILL_DRAFT_ERROR' }); }
}
