const { ensureRuntime } = require('../../../../../lib/runtime');
const { countSnapshots, getSession, rollbackSession, validateSessionAccess } = require('../../../../../lib/agentSession');
const { getDb } = require('../../../../../lib/db');
const { validateCapability } = require('../../../../../lib/agentControlPlane');
const { listOperationSetsBySession } = require('../../../../../lib/canvasOperationSets');
const { rollbackFileRevision, rollbackPreviewPatchFile } = require('../../../../../lib/agentTools');
const { getTaskBySession } = require('../../../../../lib/agentTaskQueue');
const { getSessionTurnFrame } = require('../../../../../lib/agentTurnFrames');
const { agentRuntimeAtLeast } = require('../../../../../lib/agentRuntimeMode');
const { recordRuntimeFact, recordToolCallPrepared, recordToolCallTerminal } = require('../../../../../lib/agentRuntimeFacts');
const { archiveToolResult } = require('../../../../../lib/agentToolResultStore');
const { sha256 } = require('../../../../../lib/files');

async function rollbackOperationSets(sessionId, force = false) {
  const sets = listOperationSetsBySession(sessionId).filter((set) => (
    set.status === 'applied' || (set.patches || []).some((patch) => ['applied', 'auto_applied'].includes(patch.status))
  )).reverse();
  const results = [];
  const conflicts = [];
  for (const set of sets) {
    const isRevision = String(set.revision_type || set.type || set.mode || '') === 'file_revision';
    if (isRevision) {
      const result = await rollbackFileRevision(set.id, sessionId);
      results.push(result);
      if (result.conflict || !result.success) conflicts.push(result.error || `operation_set:${set.id}`);
      continue;
    }
    const patches = Array.isArray(set.patches) ? set.patches : [];
    for (let index = patches.length - 1; index >= 0; index -= 1) {
      if (!['applied', 'auto_applied'].includes(patches[index]?.status)) continue;
      const result = await rollbackPreviewPatchFile(set.id, sessionId, { patchIndex: index, force });
      results.push(result);
      if (result.conflict || !result.success) conflicts.push(result.error || `operation_set:${set.id}:${index}`);
    }
  }
  return { handled: sets.length > 0, results, conflicts };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
  try {
    const sessionId = Number(req.query.id || 0);
    const controlTicket = req.body?.control_ticket || req.headers['x-agent-control-ticket'];
    const access = controlTicket
      ? validateCapability(controlTicket, { sessionId, action: 'rollback' }, { consume: true })
      : validateSessionAccess(sessionId, req.body?.session_token || req.headers['x-agent-session-token']);
    if (!access.valid) return res.status(403).json({ success: false, error: access.reason, code: access.reason });
    const session = getSession(sessionId);
    const task = getTaskBySession(sessionId);
    const frame = getSessionTurnFrame(sessionId);
    const invocationKey = `session:${sessionId}:rollback`;
    if (agentRuntimeAtLeast('shadow')) {
      recordToolCallPrepared({ conversationId: session.conversation_id, sessionId, taskId: task?.id, turnFrameId: frame?.id, actor: 'user', toolCallId: `session-rollback-${sessionId}`, invocationKey, toolName: 'rollback_session', inputDigest: sha256(JSON.stringify({ force: Boolean(req.body?.force) })), replayPolicy: 'operation_set', control: { session_id: sessionId, action: 'rollback_session' } });
    }
    const operationRollback = await rollbackOperationSets(sessionId, Boolean(req.body?.force));
    // 0.1.13 新链路只从 operation set 聚合回滚；旧快照仅为历史 session 兼容。
    const result = operationRollback.handled
      ? {
        restored_count: operationRollback.results.filter((item) => item.success).length,
        restoredCount: operationRollback.results.filter((item) => item.success).length,
        errors: [],
        conflicts: operationRollback.conflicts,
        rollback_source: 'operation_sets',
      }
      : (session.prompt_version === 'legacy-v1' && countSnapshots(sessionId) > 0
        ? { ...(await rollbackSession(sessionId, undefined, Boolean(req.body?.force))), rollback_source: 'legacy_snapshots' }
        : { restored_count: 0, restoredCount: 0, errors: [], conflicts: [], rollback_source: 'operation_sets' });
    const artifact = agentRuntimeAtLeast('shadow')
      ? await archiveToolResult({ conversationId: session.conversation_id, sessionId, taskId: task?.id, turnFrameId: frame?.id, toolCallId: `session-rollback-${sessionId}`, invocationKey, toolName: 'rollback_session', actor: 'runtime', result })
      : null;
    const failed = Boolean(result.conflicts?.length || result.errors?.length);
    getDb().transaction(() => {
      if (agentRuntimeAtLeast('shadow')) {
        recordToolCallTerminal({ conversationId: session.conversation_id, sessionId, taskId: task?.id, turnFrameId: frame?.id, actor: 'user', toolCallId: `session-rollback-${sessionId}`, invocationKey, factType: failed ? 'tool_call_failed' : 'tool_call_completed', payload: { tool_name: 'rollback_session', resource_changed: Number(result.restored_count || 0) > 0, result_ref: artifact?.status === 'ready' ? artifact.result_ref : null, artifact_status: artifact?.status || 'archive_failed' } });
      }
      if (!failed) {
        getDb().prepare("UPDATE agent_sessions SET status = 'rolled_back', waiting_since = NULL, state_version = state_version + 1, updated_at = datetime('now') WHERE id = ?").run(sessionId);
        getDb().prepare("UPDATE agent_task_queue SET status = 'cancelled', run_id = NULL, resume_requested = 0, finished_at = COALESCE(finished_at, datetime('now')), updated_at = datetime('now') WHERE session_id = ?").run(sessionId);
      }
      if (agentRuntimeAtLeast('facts')) recordRuntimeFact({ eventKey: `session:${sessionId}:rolled-back`, conversationId: session.conversation_id, sessionId, taskId: task?.id, turnFrameId: frame?.id, actor: 'user', factType: 'session_rolled_back', payload: { restored_count: Number(result.restored_count || 0), conflict_count: result.conflicts?.length || 0 } });
    })();
    if (result.conflicts?.length > 0) return res.status(409).json({ success: false, ...result });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message, code: 'ROLLBACK_FAILED' });
  }
}
