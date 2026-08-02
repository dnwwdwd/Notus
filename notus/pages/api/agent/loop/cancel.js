const { ensureRuntime } = require('../../../../lib/runtime');
const { getSession, validateSessionAccess } = require('../../../../lib/agentSession');
const { requestCancellation, validateCapability } = require('../../../../lib/agentControlPlane');
const { cancelTask } = require('../../../../lib/agentTaskQueue');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
  const sessionId = Number(req.body?.session_id || 0);
  if (!sessionId) return res.status(400).json({ error: 'session_id is required', code: 'SESSION_ID_REQUIRED' });
  const controlTicket = req.body?.control_ticket || req.headers['x-agent-control-ticket'];
  const access = controlTicket
    ? validateCapability(controlTicket, { sessionId, action: 'cancel' }, { consume: true })
    : validateSessionAccess(sessionId, req.body?.session_token || req.headers['x-agent-session-token']);
  if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
  requestCancellation(sessionId);
  cancelTask(sessionId);
  return res.status(200).json({ success: true, status: getSession(sessionId).status, cancellation_requested: true });
}
