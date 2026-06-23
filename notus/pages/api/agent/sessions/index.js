const { ensureRuntime } = require('../../../../lib/runtime');
const { countSnapshots, listRecentSessions, listRunLogs } = require('../../../../lib/agentSession');
const { listOperationSetsBySession } = require('../../../../lib/canvasOperationSets');

function normalizeLimit(value, fallback, max) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.min(Math.max(Math.floor(next), 1), max);
}

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
  try {
    const sessionLimit = normalizeLimit(req.query.limit, 20, 100);
    const logLimit = normalizeLimit(req.query.logs_limit, 50, 200);
    const sessions = listRecentSessions({
      limit: sessionLimit,
      conversationId: req.query.conversation_id,
    }).map((session) => {
      const runLogs = listRunLogs(session.id);
      return {
        ...session,
        snapshots_count: countSnapshots(session.id),
        run_logs: runLogs.slice(Math.max(0, runLogs.length - logLimit)),
        operation_sets: listOperationSetsBySession(session.id),
      };
    });
    return res.status(200).json({ sessions });
  } catch (error) {
    return res.status(500).json({ error: error.message, code: 'AGENT_SESSIONS_QUERY_FAILED' });
  }
}
