const { ensureRuntime } = require('../../../../lib/runtime');
const { getSession, listRunEvents, listRunLogs, countSnapshots, sanitizeSessionForRead, validateSessionAccess } = require('../../../../lib/agentSession');
const { listOperationSetsBySession } = require('../../../../lib/canvasOperationSets');
const { sanitizeResearchReceipts } = require('../../../../lib/agentResearch');
const { validateCapability } = require('../../../../lib/agentControlPlane');
const { getTaskBySession, getQueuePosition } = require('../../../../lib/agentTaskQueue');
const { listExecutionSegments } = require('../../../../lib/agentExecutionSegments');
const { getTaskChangeSetBySession } = require('../../../../lib/agentTaskChangeSets');

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
  try {
    const sessionId = Number(req.query.id || 0);
    res.setHeader('Cache-Control', 'no-store, no-cache, no-transform');
    res.setHeader('Pragma', 'no-cache');
    const controlTicket = req.headers['x-agent-control-ticket'];
    const token = req.headers['x-agent-session-token'];
    if (!controlTicket && !token) {
      return res.status(403).json({ error: 'CAPABILITY_REQUIRED', code: 'CAPABILITY_REQUIRED' });
    }
    if (controlTicket) {
      const access = validateCapability(controlTicket, { sessionId, action: 'session_read' });
      if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
    } else if (token) {
      const access = validateSessionAccess(sessionId, token);
      if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
    }
    const session = getSession(sessionId);
    return res.status(200).json({
      session: token ? session : sanitizeSessionForRead(session),
      run_events: listRunEvents(sessionId),
      run_logs: listRunLogs(sessionId),
      research_receipts: sanitizeResearchReceipts(sessionId),
      snapshots_count: countSnapshots(sessionId),
      operation_sets: listOperationSetsBySession(sessionId),
      execution_segments: listExecutionSegments(sessionId),
      task_change_set: getTaskChangeSetBySession(sessionId),
      task: getTaskBySession(sessionId),
      queue_position: getQueuePosition(sessionId),
    });
  } catch (error) {
    return res.status(404).json({ error: error.message, code: 'SESSION_NOT_FOUND' });
  }
}
