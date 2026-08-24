const { ensureRuntime } = require('../../../../../lib/runtime');
const { validateSessionAccess } = require('../../../../../lib/agentSession');
const { validateCapability } = require('../../../../../lib/agentControlPlane');
const { getTaskChangeSetDetail } = require('../../../../../lib/agentTaskChangeSets');

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
  const sessionId = Number(req.query.id || 0);
  const controlTicket = req.headers['x-agent-control-ticket'];
  const token = req.headers['x-agent-session-token'];
  if (!controlTicket && !token) {
    return res.status(403).json({ error: 'SESSION_ACCESS_REQUIRED', code: 'SESSION_ACCESS_REQUIRED' });
  }
  if (controlTicket) {
    const access = validateCapability(controlTicket, { sessionId, action: 'session_read' });
    if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
  } else {
    const access = validateSessionAccess(sessionId, token);
    if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
  }
  const changeSet = getTaskChangeSetDetail(sessionId);
  if (!changeSet) return res.status(404).json({ error: 'TASK_CHANGE_SET_NOT_FOUND', code: 'TASK_CHANGE_SET_NOT_FOUND' });
  return res.status(200).json({ task_change_set: changeSet });
}
