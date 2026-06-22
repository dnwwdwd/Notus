const { ensureRuntime } = require('../../../../lib/runtime');
const { updateSessionStatus, getSession, validateSessionAccess } = require('../../../../lib/agentSession');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
  const sessionId = Number(req.body?.session_id || 0);
  if (!sessionId) return res.status(400).json({ error: 'session_id is required', code: 'SESSION_ID_REQUIRED' });
  const access = validateSessionAccess(sessionId, req.body?.session_token);
  if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
  updateSessionStatus(sessionId, 'cancelled');
  return res.status(200).json({ success: true, status: getSession(sessionId).status });
}
