const { ensureRuntime } = require('../../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../../lib/logger');
const {
  appendConversationMessage,
  getConversationMessageById,
  touchConversation,
} = require('../../../../lib/conversations');
const { computeArticleHash } = require('../../../../lib/canvasOperationSets');
const {
  buildInteractionAnswerSummary,
  claimInteractionProcessing,
  getInteractionById,
  normalizeInteractionResponse,
  updateInteractionWhen,
} = require('../../../../lib/conversationInteractions');
const { getLatestRunEventId, setSessionWriteTarget } = require('../../../../lib/agentSession');
const { getDb } = require('../../../../lib/db');
const {
  createOrGetResumeJob,
  getResumeJobByInteraction,
  validateCapability,
} = require('../../../../lib/agentControlPlane');
const { wakeTask } = require('../../../../lib/agentTaskQueue');
const { wakeAgentTaskWorker } = require('../../../../lib/agentTaskWorker');

function getAgentSessionId(interaction) {
  if (interaction?.source !== 'agent_loop') return null;
  const id = Number(interaction?.payload?.agent_session_id || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function responseError(code, message = code, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function buildResumeResult(interaction, { resumeJob = null, eventCursor = null } = {}) {
  const sessionId = getAgentSessionId(interaction);
  if (!sessionId || !['answered', 'cancelled'].includes(interaction?.status)) return null;
  const cursor = Number(eventCursor);
  return {
    resume_job: resumeJob || getResumeJobByInteraction(interaction.id),
    // 必须在 Worker 被唤醒前写入。刷新后页面只从该位置补订阅，不会回放旧 final。
    event_cursor: Number.isFinite(cursor) && cursor >= 0 ? cursor : getLatestRunEventId(sessionId),
  };
}

function wakeAnsweredInteraction(interaction, resumeJob) {
  const sessionId = getAgentSessionId(interaction);
  if (!sessionId || !resumeJob?.id || resumeJob.status !== 'queued') return;
  wakeTask(sessionId, { resumeJobId: resumeJob.id });
  wakeAgentTaskWorker();
}

function buildStatusError(status) {
  if (status === 'answered') {
    return { code: 'INTERACTION_ALREADY_ANSWERED', message: '这张提问卡片已经回答过了' };
  }
  if (status === 'processing') {
    return { code: 'INTERACTION_PROCESSING', message: '这张提问卡片正在处理，请稍候刷新任务状态' };
  }
  if (status === 'stale') {
    return { code: 'INTERACTION_STALE', message: '文章已经变化，需要重新确认这张提问卡片' };
  }
  if (status === 'cancelled') {
    return { code: 'INTERACTION_CANCELLED', message: '这张提问卡片已经失效' };
  }
  if (status === 'failed') {
    return { code: 'INTERACTION_NOT_PENDING', message: '这张提问卡片已经进入失败状态，请直接重试生成预览' };
  }
  return { code: 'INTERACTION_NOT_PENDING', message: '这张提问卡片当前不可继续回答' };
}

function respondWithCurrentInteraction(res, interactionId, requestId) {
  const current = getInteractionById(interactionId);
  if (!current) {
    return res.status(404).json({ error: '提问卡片不存在', code: 'INTERACTION_NOT_FOUND', request_id: requestId });
  }
  if (['answered', 'cancelled'].includes(current.status)) {
    const resume = buildResumeResult(current);
    if (resume?.resume_job?.status === 'queued') {
      wakeAnsweredInteraction(current, resume.resume_job);
    }
    const cancelled = current.status === 'cancelled';
    return res.status(200).json({
      interaction: current,
      resolution_status: cancelled ? 'cancelled' : 'resolved',
      ...(cancelled ? { answer_message: null, normalized_response: null, resume_payload: { action: 'cancel' } } : {}),
      should_continue: Boolean(getAgentSessionId(current)),
      idempotent_replay: true,
      ...(resume || {}),
      request_id: requestId,
    });
  }
  if (current.status === 'processing') {
    return res.status(202).json({
      interaction: current,
      resolution_status: 'processing',
      should_continue: false,
      request_id: requestId,
    });
  }
  const statusError = buildStatusError(current.status);
  return res.status(409).json({
    error: statusError.message,
    code: statusError.code,
    interaction: current,
    request_id: requestId,
  });
}

function assertConsumedAnswerCapability({ interaction, resumeTicket, ownerId = null } = {}) {
  const sessionId = getAgentSessionId(interaction);
  if (!sessionId) return;
  const consumed = validateCapability(resumeTicket, {
    sessionId,
    interactionId: interaction.id,
    action: 'respond',
    ...(ownerId ? { ownerId } : {}),
  }, { consume: true });
  if (!consumed.valid) throw responseError(consumed.reason, consumed.reason, 403);
  if (consumed.consumed) throw responseError('CAPABILITY_ALREADY_CONSUMED', '恢复票据已消费，请刷新任务状态');
}

function buildCorrectionStateFromResponse(interaction, normalizedResponse) {
  const payload = interaction?.payload || {};
  const answers = normalizedResponse?.answers || {};
  const next = payload.correction_state && typeof payload.correction_state === 'object'
    ? { ...payload.correction_state }
    : {};

  const primaryIntent = String(answers.primary_intent?.value || '').trim();
  if (primaryIntent === 'edit') {
    next.wrong_intent = 'text';
    next.preferred_primary_intent = 'edit';
  } else if (primaryIntent === 'text') {
    next.wrong_intent = 'edit';
    next.preferred_primary_intent = 'text';
  } else if (primaryIntent === 'analyze') {
    next.wrong_intent = 'edit';
    next.preferred_primary_intent = 'analyze';
  }

  if (answers.source_content_ref) next.wrong_source = true;
  if (answers.target_location) next.wrong_target = true;
  if (answers.write_mode) next.wrong_write_action = true;

  return Object.keys(next).length > 0 ? next : null;
}

function applyResourceApproval(payload, action) {
  if (action !== 'confirm') return { cancelled: true, action: payload.action };
  if (payload.action === 'skill_install' || payload.action === 'skill_update') {
    const skill = require('../../../../lib/skills').installSkillDraft(payload.draft_id, payload.action === 'skill_update' ? 'replace' : 'reject');
    return { approved: true, action: payload.action, skill: { id: skill.id, name: skill.name, enabled: skill.enabled } };
  }
  if (payload.action === 'skill_uninstall') {
    require('../../../../lib/skills').deleteSkill(payload.skill_id);
    return { approved: true, action: payload.action, deleted: true };
  }
  if (payload.action === 'skill_disable') {
    const skill = require('../../../../lib/skills').setSkillEnabled(payload.skill_id, false);
    return { approved: true, action: payload.action, skill: { id: skill.id, name: skill.name, enabled: skill.enabled } };
  }
  if (payload.action === 'mcp_remove') {
    return Promise.resolve(require('../../../../lib/mcp').removeServer(payload.server_id))
      .then(() => ({ approved: true, action: payload.action, deleted: true }));
  }
  throw responseError('RESOURCE_ACTION_UNKNOWN', '未知资源操作', 400);
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/interactions/[id]/respond');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('canvas.clarify.failed', { error: runtime.error });
    return res.status(500).json({
      error: runtime.error.message,
      code: 'RUNTIME_ERROR',
      request_id: context.request_id,
    });
  }

  const interactionId = Number(req.query.id);
  const interaction = getInteractionById(interactionId);
  if (!interaction) {
    return res.status(404).json({
      error: '提问卡片不存在',
      code: 'INTERACTION_NOT_FOUND',
      request_id: context.request_id,
    });
  }

  const agentSessionId = getAgentSessionId(interaction);
  const ownerId = null;
  const resumeTicket = req.body?.resume_ticket || req.headers['x-agent-resume-ticket'];
  if (agentSessionId) {
    const capability = validateCapability(resumeTicket, {
      sessionId: agentSessionId,
      interactionId: interaction.id,
      action: 'respond',
      ...(ownerId ? { ownerId } : {}),
    });
    if (!capability.valid) {
      return res.status(403).json({ error: capability.reason, code: capability.reason, request_id: context.request_id });
    }
  }

  if (interaction.status === 'answered') return respondWithCurrentInteraction(res, interaction.id, context.request_id);
  if (interaction.status === 'processing') return respondWithCurrentInteraction(res, interaction.id, context.request_id);

  const { action } = req.body || {};
  if (interaction.kind === 'resource_approval') {
    if (interaction.status !== 'pending') return respondWithCurrentInteraction(res, interaction.id, context.request_id);

    let claimed;
    try {
      claimed = getDb().transaction(() => {
        const processing = claimInteractionProcessing(interaction.id);
        if (!processing) return null;
        assertConsumedAnswerCapability({ interaction: processing, resumeTicket, ownerId });
        return processing;
      })();
    } catch (error) {
      return res.status(error.status || 409).json({ error: error.message, code: error.code || 'INTERACTION_RESPONSE_FAILED', request_id: context.request_id });
    }
    if (!claimed) return respondWithCurrentInteraction(res, interaction.id, context.request_id);

    let result;
    try {
      result = await applyResourceApproval(claimed.payload || {}, action);
    } catch (error) {
      const failed = updateInteractionWhen(interaction.id, ['processing'], {
        status: 'failed',
        response: { approved: false, error: error.code || 'RESOURCE_ACTION_FAILED', message: error.message },
      });
      return res.status(error.status || 400).json({
        error: error.message,
        code: error.code || 'RESOURCE_ACTION_FAILED',
        interaction: failed || getInteractionById(interaction.id),
        request_id: context.request_id,
      });
    }

    const finalized = getDb().transaction(() => {
      const updated = updateInteractionWhen(interaction.id, ['processing'], {
        status: 'answered',
        response: result,
        answeredAt: new Date().toISOString(),
      });
      if (!updated) return null;
      const resumeJob = agentSessionId
        ? createOrGetResumeJob({ sessionId: agentSessionId, interactionId: updated.id, ownerId })
        : null;
      const eventCursor = agentSessionId ? getLatestRunEventId(agentSessionId) : null;
      return { updated, resumeJob, eventCursor };
    })();
    if (!finalized) return respondWithCurrentInteraction(res, interaction.id, context.request_id);
    wakeAnsweredInteraction(finalized.updated, finalized.resumeJob);
    return res.status(200).json({
      interaction: finalized.updated,
      resolution_status: action === 'confirm' ? 'resolved' : 'cancelled',
      should_continue: true,
      resume_payload: result,
      ...(buildResumeResult(finalized.updated, { resumeJob: finalized.resumeJob, eventCursor: finalized.eventCursor }) || {}),
      request_id: context.request_id,
    });
  }

  if (action === 'cancel') {
    if (interaction.status !== 'pending') return respondWithCurrentInteraction(res, interaction.id, context.request_id);
    let cancelled;
    try {
      cancelled = getDb().transaction(() => {
        const processing = claimInteractionProcessing(interaction.id);
        if (!processing) return null;
        assertConsumedAnswerCapability({ interaction: processing, resumeTicket, ownerId });
        const updated = updateInteractionWhen(interaction.id, ['processing'], {
          status: 'cancelled',
          response: { action: 'cancel' },
          answeredAt: null,
        });
        if (!updated) return null;
        const resumeJob = agentSessionId
          ? createOrGetResumeJob({ sessionId: agentSessionId, interactionId: updated.id, ownerId })
          : null;
        const eventCursor = agentSessionId ? getLatestRunEventId(agentSessionId) : null;
        return { updated, resumeJob, eventCursor };
      })();
    } catch (error) {
      return res.status(error.status || 409).json({ error: error.message, code: error.code || 'INTERACTION_RESPONSE_FAILED', request_id: context.request_id });
    }
    if (!cancelled?.updated) return respondWithCurrentInteraction(res, interaction.id, context.request_id);
    wakeAnsweredInteraction(cancelled.updated, cancelled.resumeJob);
    return res.status(200).json({
      interaction: cancelled.updated,
      answer_message: null,
      resolution_status: 'cancelled',
      normalized_response: null,
      should_continue: true,
      resume_payload: { action: 'cancel' },
      ...(buildResumeResult(cancelled.updated, { resumeJob: cancelled.resumeJob, eventCursor: cancelled.eventCursor }) || {}),
      request_id: context.request_id,
    });
  }

  if (interaction.status !== 'pending') return respondWithCurrentInteraction(res, interaction.id, context.request_id);
  if (interaction.kind === 'mcp_approval') {
    return res.status(410).json({ error: 'MCP 逐工具授权已停用，请重新发送任务并在输入框选择 MCP Server', code: 'MCP_APPROVAL_RETIRED', request_id: context.request_id });
  }

  const { response, raw_text: rawText, article, article_hash: articleHash, schema_version: schemaVersion } = req.body || {};
  if (schemaVersion && Number(schemaVersion) !== Number(interaction.schema_version)) {
    return res.status(409).json({
      error: '提问卡片版本已经变化，请刷新后重试',
      code: 'INTERACTION_SCHEMA_MISMATCH',
      interaction,
      request_id: context.request_id,
    });
  }

  const currentArticleHash = article
    ? computeArticleHash(article)
    : String(articleHash || '').trim();
  if (interaction.article_hash && currentArticleHash && currentArticleHash !== interaction.article_hash) {
    const staleInteraction = updateInteractionWhen(interaction.id, ['pending'], { status: 'stale' }) || getInteractionById(interaction.id);
    logger.info('canvas.clarify.staled', {
      conversation_id: interaction.conversation_id,
      file_id: article?.file_id || article?.fileId || null,
      reason_code: interaction.reason_code,
      question_count: Array.isArray(interaction.payload?.questions) ? interaction.payload.questions.length : 0,
      resolution_status: 'stale',
      continued_to_edit: false,
      operation_set_created: false,
    });
    return res.status(409).json({
      error: '文章已经变化，需要重新确认',
      code: 'INTERACTION_STALE',
      interaction: staleInteraction,
      request_id: context.request_id,
    });
  }

  const normalizedResponse = normalizeInteractionResponse(interaction, {
    answers: response?.answers || response || null,
    raw_text: String(rawText || response?.raw_text || '').trim(),
  });
  if (normalizedResponse.resolution_status === 'failed') {
    return res.status(200).json({
      interaction,
      answer_message: null,
      resolution_status: 'failed',
      normalized_response: normalizedResponse,
      should_continue: false,
      resume_payload: null,
      request_id: context.request_id,
    });
  }

  const summaryText = buildInteractionAnswerSummary(interaction, normalizedResponse);
  const nextStatus = normalizedResponse.resolution_status === 'resolved' ? 'answered' : 'pending';
  const correctionState = buildCorrectionStateFromResponse(interaction, normalizedResponse);
  let finalized;
  try {
    finalized = getDb().transaction(() => {
      const processing = claimInteractionProcessing(interaction.id);
      if (!processing) return null;
      if (nextStatus === 'answered') {
        assertConsumedAnswerCapability({ interaction: processing, resumeTicket, ownerId });
        if (processing.payload?.write_target_preflight) {
          const selected = String(normalizedResponse.answers?.write_target?.value || '').trim();
          const candidates = Array.isArray(processing.payload?.write_target_candidates)
            ? processing.payload.write_target_candidates
            : [];
          const candidate = candidates.find((item) => String(item?.filePath || '') === selected);
          if (!agentSessionId || (!candidate && selected !== '__new_article__')) {
            throw responseError('WRITE_TARGET_INVALID', '写作目标无效，请重新选择。', 400);
          }
          setSessionWriteTarget(agentSessionId, selected === '__new_article__'
            ? { mode: 'new' }
            : { mode: 'modify', file_path: candidate.filePath, operation_set_id: candidate.operationSetId });
        }
      }
      const answerMessageId = appendConversationMessage({
        conversationId: processing.conversation_id,
        role: 'user',
        content: summaryText,
        meta: {
          interaction_id: processing.id,
          interaction_resolution_status: normalizedResponse.resolution_status,
          correction_state: correctionState,
          article_hash: processing.article_hash || '',
        },
      });
      touchConversation(processing.conversation_id);
      const updatedInteraction = updateInteractionWhen(processing.id, ['processing'], {
        response: normalizedResponse,
        status: nextStatus,
        answerMessageId,
        answeredAt: nextStatus === 'answered' ? new Date().toISOString() : null,
      });
      if (!updatedInteraction) throw responseError('INTERACTION_STATE_CONFLICT', '提问卡片状态已变化，请刷新后重试');
      if (nextStatus !== 'answered' || !agentSessionId) {
        return { answerMessageId, updatedInteraction, resumeJob: null, eventCursor: null };
      }
      const resumeJob = createOrGetResumeJob({ sessionId: agentSessionId, interactionId: updatedInteraction.id, ownerId });
      const eventCursor = getLatestRunEventId(agentSessionId);
      return { answerMessageId, updatedInteraction, resumeJob, eventCursor };
    })();
  } catch (error) {
    return res.status(error.status || 409).json({
      error: error.message || '回答提问卡片失败',
      code: error.code || 'INTERACTION_RESPONSE_FAILED',
      request_id: context.request_id,
    });
  }
  if (!finalized) return respondWithCurrentInteraction(res, interaction.id, context.request_id);

  const answerMessage = getConversationMessageById(finalized.answerMessageId);
  if (finalized.resumeJob) wakeAnsweredInteraction(finalized.updatedInteraction, finalized.resumeJob);
  logger.info('canvas.clarify.answered', {
    conversation_id: interaction.conversation_id,
    file_id: article?.file_id || article?.fileId || null,
    reason_code: interaction.reason_code,
    question_count: Array.isArray(interaction.payload?.questions) ? interaction.payload.questions.length : 0,
    resolution_status: normalizedResponse.resolution_status,
    continued_to_edit: normalizedResponse.resolution_status === 'resolved',
    operation_set_created: false,
  });

  return res.status(200).json({
    interaction: finalized.updatedInteraction,
    answer_message: answerMessage,
    resolution_status: normalizedResponse.resolution_status,
    normalized_response: normalizedResponse,
    should_continue: normalizedResponse.resolution_status === 'resolved',
    resume_payload: normalizedResponse.resolution_status === 'resolved'
      ? {
        interaction_id: finalized.updatedInteraction.id,
        interaction_response: normalizedResponse,
        conversation_id: finalized.updatedInteraction.conversation_id,
      }
      : null,
    ...(buildResumeResult(finalized.updatedInteraction, {
      resumeJob: finalized.resumeJob,
      eventCursor: finalized.eventCursor,
    }) || {}),
    request_id: context.request_id,
  });
}
