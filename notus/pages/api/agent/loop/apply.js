const { ensureRuntime } = require('../../../../lib/runtime');
const {
  applyPreviewPatchFile,
  applyPreviewWithConflictCheck,
  discardPendingPreviewPatches,
  discardPreviewPatchFile,
  rollbackPreviewPatchFile,
} = require('../../../../lib/agentTools');
const { extendHardLimit, getSession, updateSessionStatus, validateSessionAccess } = require('../../../../lib/agentSession');
const { getOperationSetById, markOperationSetStatus } = require('../../../../lib/canvasOperationSets');

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
    current_conversation_id: currentConversationId = null,
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
  const currentConversation = validateCurrentConversation(operationSetId, access.session, currentConversationId);
  if (!currentConversation.valid) {
    return res.status(currentConversation.status).json({
      success: false,
      error: currentConversation.error,
      code: currentConversation.code,
    });
  }

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
