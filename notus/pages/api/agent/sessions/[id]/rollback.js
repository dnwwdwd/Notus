const { ensureRuntime } = require('../../../../../lib/runtime');
const { rollbackSession, validateSessionAccess } = require('../../../../../lib/agentSession');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
  try {
    const sessionId = Number(req.query.id || 0);
    const access = validateSessionAccess(sessionId, req.body?.session_token);
    if (!access.valid) return res.status(403).json({ success: false, error: access.reason, code: access.reason });
    const result = await rollbackSession(sessionId, undefined, Boolean(req.body?.force));
    if (result.conflicts?.length > 0) return res.status(409).json({ success: false, ...result });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message, code: 'ROLLBACK_FAILED' });
  }
}
