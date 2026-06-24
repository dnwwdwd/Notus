const { ensureRuntime } = require('../../../../lib/runtime');
const {
  applyPreviewPatchFile,
  applyPreviewWithConflictCheck,
  discardPendingPreviewPatches,
  discardPreviewPatchFile,
  rollbackPreviewPatchFile,
} = require('../../../../lib/agentTools');
const { extendHardLimit, getSession, updateSessionStatus, validateSessionAccess } = require('../../../../lib/agentSession');
const { markOperationSetStatus } = require('../../../../lib/canvasOperationSets');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
  const {
    session_id: sessionId,
    session_token: sessionToken,
    operation_set_id: operationSetId,
    action = 'apply',
    extra_loops: extraLoops = 10,
    force = false,
    patch_index: patchIndex = null,
    file_path: filePath = '',
    approval_mode: approvalMode = '',
  } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'session_id is required', code: 'SESSION_ID_REQUIRED' });
  const access = validateSessionAccess(sessionId, sessionToken);
  if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
  if (action === 'extend') {
    const session = extendHardLimit(sessionId, extraLoops);
    updateSessionStatus(sessionId, 'running');
    return res.status(200).json({ success: true, new_hard_limit: session.hard_limit });
  }
  if (action === 'reject') {
    if (operationSetId) markOperationSetStatus(operationSetId, 'cancelled');
    updateSessionStatus(sessionId, 'cancelled');
    return res.status(200).json({ success: true });
  }
  if (!operationSetId) return res.status(400).json({ error: 'operation_set_id is required', code: 'OPERATION_SET_ID_REQUIRED' });

  let result;
  if (action === 'apply_file') {
    result = await applyPreviewPatchFile(operationSetId, sessionId, { patchIndex, filePath, force });
  } else if (action === 'rollback_file') {
    result = await rollbackPreviewPatchFile(operationSetId, sessionId, { patchIndex, filePath, force });
  } else if (action === 'discard_file') {
    result = await discardPreviewPatchFile(operationSetId, sessionId, { patchIndex, filePath });
  } else if (action === 'discard_pending') {
    result = await discardPendingPreviewPatches(operationSetId, sessionId);
  } else if (action === 'apply_all' || action === 'apply') {
    result = await applyPreviewWithConflictCheck(operationSetId, sessionId, { force, approvalMode });
  } else {
    return res.status(400).json({ error: `unsupported action: ${action}`, code: 'UNSUPPORTED_ACTION' });
  }

  if (result.conflict) return res.status(409).json(result);
  if (!result.success) return res.status(400).json(result);
  return res.status(200).json({ ...result, session: getSession(sessionId) });
}
