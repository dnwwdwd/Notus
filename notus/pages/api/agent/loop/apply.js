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
  updateSessionStatus,
  validateSessionAccess,
} = require('../../../../lib/agentSession');
const { validateCapability } = require('../../../../lib/agentControlPlane');
const { getOperationSetById, markOperationSetStatus } = require('../../../../lib/canvasOperationSets');
const { getTaskChangeSetBySession, resumeNonManualOperationConfirmation } = require('../../../../lib/agentTaskChangeSets');
const { getTaskBySession, requestTaskResume, cancelTask } = require('../../../../lib/agentTaskQueue');
const { wakeAgentTaskWorker } = require('../../../../lib/agentTaskWorker');
const { resolveManualConfirmation } = require('../../../../lib/agentManualConfirmation');
const { getSessionTurnFrame } = require('../../../../lib/agentTurnFrames');
const { agentRuntimeAtLeast } = require('../../../../lib/agentRuntimeMode');
const { recordRuntimeFact, recordToolCallPrepared, recordToolCallTerminal } = require('../../../../lib/agentRuntimeFacts');
const { archiveToolResult } = require('../../../../lib/agentToolResultStore');
const { publish } = require('../../../../lib/agentRunEventBus');
const { sha256 } = require('../../../../lib/files');

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
  if (Number(operationSet.agent_session_id) !== Number(session?.id)) {
    return { valid: false, status: 403, code: 'SESSION_OPERATION_SET_MISMATCH', error: '这组修改不属于该任务' };
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
    ? validateCapability(controlTicket, { sessionId, action: expectedAction })
    : validateSessionAccess(sessionId, sessionToken || req.headers['x-agent-session-token']);
  if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason });
  access.session = getSession(sessionId);
  if (!access.session) return res.status(404).json({ error: 'SESSION_NOT_FOUND', code: 'SESSION_NOT_FOUND' });
  if (action === 'extend') {
    if (!access.consumed && access.session.status !== 'waiting_limit_confirmation') {
      return res.status(409).json({ error: 'SESSION_NOT_WAITING_LIMIT', code: 'SESSION_NOT_WAITING_LIMIT' });
    }
    const session = require('../../../../lib/db').getDb().transaction(() => {
      if (controlTicket && validateCapability(controlTicket, { sessionId, action: expectedAction }, { consume: true }).consumed) return getSession(sessionId);
      if (!access.consumed) {
        extendHardLimit(sessionId, extraLoops);
        extendTokenBudget(sessionId, 0.25);
        requestTaskResume(sessionId);
      }
      return getSession(sessionId);
    })();
    wakeAgentTaskWorker();
    return res.status(200).json({ success: true, task_resumed: true, new_hard_limit: session.hard_limit, new_token_budget_total: session.token_budget_total });
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

  if (action === 'reject') {
    require('../../../../lib/db').getDb().transaction(() => {
      markOperationSetStatus(operationSetId, 'cancelled');
      if (!['completed', 'cancelled', 'failed'].includes(access.session.status)) {
        updateSessionStatus(sessionId, 'cancelled');
        cancelTask(sessionId);
      }
    })();
    return res.status(200).json({ success: true });
  }
  const taskBeforeOperation = getTaskBySession(sessionId);
  const turnFrame = getSessionTurnFrame(sessionId);
  const operationInvocationKey = `operation-set:${operationSetId}:${action}:${patchIndex ?? (filePath || 'all')}`;
  if (agentRuntimeAtLeast('shadow')) {
    recordToolCallPrepared({ conversationId: access.session.conversation_id, sessionId, taskId: taskBeforeOperation?.id, turnFrameId: turnFrame?.id, actor: 'user', toolCallId: `operation-set-${operationSetId}`, invocationKey: operationInvocationKey, toolName: `operation_set_${action}`, inputDigest: sha256(JSON.stringify({ operationSetId, action, patchIndex, filePath, force: Boolean(force) })), replayPolicy: 'operation_set', control: { operation_set_id: Number(operationSetId), action: String(action || '') } });
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

  if (agentRuntimeAtLeast('shadow')) {
    const artifact = await archiveToolResult({ conversationId: access.session.conversation_id, sessionId, taskId: taskBeforeOperation?.id, turnFrameId: turnFrame?.id, toolCallId: `operation-set-${operationSetId}`, invocationKey: operationInvocationKey, toolName: `operation_set_${action}`, actor: 'runtime', result });
    recordToolCallTerminal({ conversationId: access.session.conversation_id, sessionId, taskId: taskBeforeOperation?.id, turnFrameId: turnFrame?.id, actor: 'user', toolCallId: `operation-set-${operationSetId}`, invocationKey: operationInvocationKey, factType: result.conflict || !result.success ? 'tool_call_failed' : 'tool_call_completed', payload: { tool_name: `operation_set_${action}`, operation_set_id: Number(operationSetId), resource_changed: Boolean(result.success && !String(action).startsWith('discard')), result_ref: artifact?.status === 'ready' ? artifact.result_ref : null, artifact_status: artifact?.status || 'archive_failed' } });
  }
  const handledSet = getOperationSetById(operationSetId);
  const eventStatus = result.success ? handledSet?.status : 'apply_failed';
  const handledPatches = handledSet?.patches || [];
  const directoryCount = handledPatches.filter(patch => /folder/.test(patch.change_type || '')).length;
  const eventBase = { type: 'artifact', operation_set_id: Number(operationSetId), execution_segment_id: handledSet?.execution_segment_id,
    status: eventStatus, change_file_count: handledSet?.revision_type === 'file_revision' ? 1 : handledPatches.length - directoryCount, change_directory_count: directoryCount };
  publish({ sessionId, event: { ...eventBase, artifact_type: 'operation_set', message: result.success ? '' : '本批应用未完成，已成功的修改保留，请检查失败项。' } });
  if (result.success && isOperationSetResolved(handledSet)) publish({ sessionId, event: { ...eventBase, artifact_type: 'operation_resolution', text: eventStatus === 'applied' ? '本批已成功应用。' : '本批已处理。' } });
  result.task_change_set = getTaskChangeSetBySession(sessionId);
  if (result.conflict) return res.status(409).json(result);
  if (!result.success) return res.status(400).json(result);
  const latestOperationSet = getOperationSetById(operationSetId);
  const task = getTaskBySession(sessionId);
  const isManualDiff = String(task?.approval_mode || '') === 'manual_confirm';
  let changeSet = result.task_change_set;
  let resumed = false;
  if (isManualDiff) {
    const completion = resolveManualConfirmation({ operationSetId, sessionId, action, toolResult: result });
    changeSet = completion.changeSet || changeSet;
    resumed = completion.resumed;
    if (resumed) wakeAgentTaskWorker();
  }
  const resolvesManualPreview = ['apply', 'apply_all', 'apply_file', 'discard_file', 'discard_pending'].includes(action)
    && isOperationSetResolved(latestOperationSet);
  if (resolvesManualPreview && !isManualDiff) {
    const resolution = ['applied', 'partial'].includes(String(latestOperationSet.status || '')) ? 'applied' : 'discarded';
    const toolResult = {
      ...result,
      operation_set_id: Number(operationSetId),
      applied: resolution === 'applied',
      discarded: resolution === 'discarded',
      approval_mode: task?.approval_mode || approvalMode || 'manual_confirm',
    };
    const completion = resumeNonManualOperationConfirmation({ operationSetId, sessionId, resolution, toolResult });
    changeSet = completion.changeSet;
    if (completion.resumed) {
      wakeAgentTaskWorker();
      resumed = true;
    }
  }
  if (agentRuntimeAtLeast('facts')) {
    recordRuntimeFact({ eventKey: `operation-set:${operationSetId}:${action}:state`, conversationId: access.session.conversation_id, sessionId, taskId: taskBeforeOperation?.id, turnFrameId: turnFrame?.id, actor: 'user', factType: String(action).startsWith('rollback') ? 'operation_rolled_back' : String(action).startsWith('discard') ? 'operation_discarded' : 'operation_applied', payload: { operation_set_id: Number(operationSetId), action, status: latestOperationSet?.status || '' } });
  }
  return res.status(200).json({
    ...result,
    operation_set: latestOperationSet,
    task_change_set: changeSet,
    task_resumed: resumed,
    session: getSession(sessionId),
  });
}
