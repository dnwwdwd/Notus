const { ensureRuntime } = require('../../../../lib/runtime');
const { getSession, listRunLogs, countSnapshots, validateSessionAccess } = require('../../../../lib/agentSession');
const { listOperationSetsBySession } = require('../../../../lib/canvasOperationSets');

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
  try {
    const sessionId = Number(req.query.id || 0);
    const access = validateSessionAccess(sessionId, req.query.session_token || req.headers['x-agent-session-token']);
    if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
    const session = getSession(sessionId);
    return res.status(200).json({
      session,
      run_logs: listRunLogs(sessionId),
      snapshots_count: countSnapshots(sessionId),
      operation_sets: listOperationSetsBySession(sessionId),
    });
  } catch (error) {
    return res.status(404).json({ error: error.message, code: 'SESSION_NOT_FOUND' });
  }
}
