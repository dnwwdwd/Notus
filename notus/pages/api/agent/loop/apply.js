const { ensureRuntime } = require('../../../../lib/runtime');
const {
  applyFileRevision,
  applyPreviewPatchFile,
  applyPreviewWithConflictCheck,
  discardFileRevision,
  discardPendingPreviewPatches,
  discardPreviewPatchFile,
  rollbackFileRevision,
  rollbackPreviewPatchFile,
} = require('../../../../lib/agentTools');
const {
  extendHardLimit,
  extendTokenBudget,
  getSession,
  loadMessagesCheckpoint,
  updateSessionStatus,
  validateSessionAccess,
} = require('../../../../lib/agentSession');
const { validateCapability } = require('../../../../lib/agentControlPlane');
const { getOperationSetById, markOperationSetStatus } = require('../../../../lib/canvasOperationSets');
const { completeOperationConfirmation } = require('../../../../lib/agentTaskChangeSets');
const { wakeAgentTaskWorker } = require('../../../../lib/agentTaskWorker');

function normalizePositiveInt(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function validateCurrentConversation(operationSetId, session, currentConversationId) {
  const currentId = normalizePositiveInt(currentConversationId);
  if (!currentId) {
    return {
      valid: false,
      status: 400,
      code: 'CURRENT_CONVERSATION_REQUIRED',
      error: '缺少当前对话，不能应用或回滚这组修改',
    };
  }
  const operationSet = getOperationSetById(operationSetId);
  if (!operationSet) {
    return {
      valid: false,
      status: 404,
      code: 'OPERATION_SET_NOT_FOUND',
      error: '预览记录不存在或已过期',
    };
  }
  const sessionConversationId = normalizePositiveInt(session?.conversation_id);
  const operationConversationId = normalizePositiveInt(operationSet.conversation_id);
  if (
    (sessionConversationId && sessionConversationId !== currentId)
    || (operationConversationId && operationConversationId !== currentId)
    || (sessionConversationId && operationConversationId && sessionConversationId !== operationConversationId)
  ) {
    return {
      valid: false,
      status: 409,
      code: 'CURRENT_CONVERSATION_MISMATCH',
      error: '这组修改不属于当前对话，已不能继续应用或回滚',
    };
  }
  return { valid: true, operationSet };
}

function isOperationSetResolved(operationSet) {
  if (!operationSet) return false;
  if (String(operationSet.revision_type || '') === 'file_revision') {
    return ['applied', 'discarded', 'cancelled'].includes(String(operationSet.status || ''));
  }
  const patches = Array.isArray(operationSet.patches) ? operationSet.patches : [];
  return patches.length > 0 && patches.every((patch) => !['pending', 'applying', 'failed'].includes(String(patch?.status || 'pending')));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });
  const {
    session_id: sessionId,
    session_token: sessionToken,
    control_ticket: controlTicket,
    operation_set_id: operationSetId,
    action = 'apply',
    extra_loops: extraLoops = 10,
    force = false,
    patch_index: patchIndex = null,
    file_path: filePath = '',
    approval_mode: approvalMode = '',
    current_conversation_id: currentConversationId = null,
  } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'session_id is required', code: 'SESSION_ID_REQUIRED' });
  const expectedAction = action === 'extend' ? 'extend' : 'operate';
  const access = controlTicket
    ? validateCapability(controlTicket, { sessionId, action: expectedAction }, { consume: action === 'extend' })
    : validateSessionAccess(sessionId, sessionToken || req.headers['x-agent-session-token']);
  if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
  if (action === 'extend') {
    extendHardLimit(sessionId, extraLoops);
    const session = extendTokenBudget(sessionId, 0.25);
    return res.status(200).json({ success: true, new_hard_limit: session.hard_limit, new_token_budget_total: session.token_budget_total });
  }
  if (action === 'reject') {
    if (operationSetId) markOperationSetStatus(operationSetId, 'cancelled');
    updateSessionStatus(sessionId, 'cancelled');
    return res.status(200).json({ success: true });
  }
  if (!operationSetId) return res.status(400).json({ error: 'operation_set_id is required', code: 'OPERATION_SET_ID_REQUIRED' });
  const currentConversation = validateCurrentConversation(operationSetId, access.session, currentConversationId);
  if (!currentConversation.valid) {
    return res.status(currentConversation.status).json({
      success: false,
      error: currentConversation.error,
      code: currentConversation.code,
    });
  }

  let result;
  const isFileRevision = String(currentConversation.operationSet?.revision_type || currentConversation.operationSet?.type || currentConversation.operationSet?.mode || '') === 'file_revision';
  if (isFileRevision) {
    if (action === 'apply_file' || action === 'apply_all' || action === 'apply') {
      result = await applyFileRevision(operationSetId, sessionId);
    } else if (action === 'rollback_file' || action === 'rollback') {
      result = await rollbackFileRevision(operationSetId, sessionId);
    } else if (action === 'discard_file' || action === 'discard_pending') {
      result = await discardFileRevision(operationSetId, sessionId);
    } else {
      return res.status(400).json({ error: `unsupported action: ${action}`, code: 'UNSUPPORTED_ACTION' });
    }
  } else if (action === 'apply_file') {
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
  const latestOperationSet = getOperationSetById(operationSetId);
  let resumed = false;
  let changeSet = null;
  const checkpoint = loadMessagesCheckpoint(sessionId);
  if (
    getSession(sessionId)?.status === 'waiting_operation_confirmation'
    && Number(checkpoint?.pendingOperationSetId || 0) === Number(operationSetId)
    && isOperationSetResolved(latestOperationSet)
  ) {
    const resolution = ['applied', 'partial'].includes(String(latestOperationSet.status || '')) ? 'applied' : 'discarded';
    const resumePayload = {
      ...result,
      operation_set_id: Number(operationSetId),
      applied: resolution === 'applied',
      discarded: resolution === 'discarded',
      approval_mode: approvalMode || 'manual_confirm',
    };
    const completion = completeOperationConfirmation({
      operationSetId,
      sessionId,
      resolution,
      toolResult: resumePayload,
    });
    changeSet = completion.changeSet;
    if (completion.resumed) {
      wakeAgentTaskWorker();
      resumed = true;
    }
  }
  return res.status(200).json({
    ...result,
    operation_set: latestOperationSet,
    task_change_set: changeSet,
    task_resumed: resumed,
    session: getSession(sessionId),
  });
}
