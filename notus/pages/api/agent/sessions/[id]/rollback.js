const { ensureRuntime } = require('../../../../../lib/runtime');
const { countSnapshots, getSession, rollbackSession, updateSessionStatus, validateSessionAccess } = require('../../../../../lib/agentSession');
const { validateCapability } = require('../../../../../lib/agentControlPlane');
const { listOperationSetsBySession } = require('../../../../../lib/canvasOperationSets');
const { rollbackFileRevision, rollbackPreviewPatchFile } = require('../../../../../lib/agentTools');

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
    if (result.conflicts?.length === 0 && result.errors?.length === 0) updateSessionStatus(sessionId, 'rolled_back');
    if (result.conflicts?.length > 0) return res.status(409).json({ success: false, ...result });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message, code: 'ROLLBACK_FAILED' });
  }
}
