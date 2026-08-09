const { ensureRuntime } = require('../../../../lib/runtime');
const { getSession, validateSessionAccess } = require('../../../../lib/agentSession');
const { requestCancellation, validateCapability } = require('../../../../lib/agentControlPlane');
const { cancelTask } = require('../../../../lib/agentTaskQueue');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
  const primarySession = {
    session_id: req.body?.session_id,
    session_token: req.body?.session_token || req.headers['x-agent-session-token'],
    control_ticket: req.body?.control_ticket || req.headers['x-agent-control-ticket'],
  };
  const requestedSessions = Array.isArray(req.body?.sessions) && req.body.sessions.length
    ? req.body.sessions
    : [primarySession];
  const sessionsById = new Map();
  requestedSessions.forEach((item) => {
    const sessionId = Number(item?.session_id || 0);
    if (!sessionId || sessionsById.has(sessionId)) return;
    sessionsById.set(sessionId, {
      sessionId,
      sessionToken: item?.session_token || item?.token || '',
      controlTicket: item?.control_ticket || item?.controlTicket || '',
    });
  });
  if (sessionsById.size === 0) return res.status(400).json({ error: 'session_id is required', code: 'SESSION_ID_REQUIRED' });
  const requested = [...sessionsById.values()];
  for (const item of requested) {
    const access = item.controlTicket
      ? validateCapability(item.controlTicket, { sessionId: item.sessionId, action: 'cancel' })
      : validateSessionAccess(item.sessionId, item.sessionToken);
    if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
  }
  requested.forEach((item) => {
    if (item.controlTicket) validateCapability(item.controlTicket, { sessionId: item.sessionId, action: 'cancel' }, { consume: true });
  });
  const cancelledSessionIds = requested.map((item) => item.sessionId);
  cancelledSessionIds.forEach((id) => {
    requestCancellation(id);
    cancelTask(id);
  });
  return res.status(200).json({
    success: true,
    status: getSession(cancelledSessionIds[0]).status,
    cancellation_requested: true,
    cancelled_session_ids: cancelledSessionIds,
  });
}
