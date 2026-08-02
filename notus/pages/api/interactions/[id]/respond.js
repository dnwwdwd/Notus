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
  getInteractionById,
  normalizeInteractionResponse,
  updateInteraction,
} = require('../../../../lib/conversationInteractions');
const { setSessionWriteTarget } = require('../../../../lib/agentSession');
const { getDb } = require('../../../../lib/db');
const {
  createOrGetResumeJob,
  issueCapability,
  validateCapability,
} = require('../../../../lib/agentControlPlane');
const { wakeAgentTaskWorker } = require('../../../../lib/agentTaskWorker');

function getAgentSessionId(interaction) {
  if (interaction?.source !== 'agent_loop') return null;
  const id = Number(interaction?.payload?.agent_session_id || 0);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function buildResumeResult(interaction, ownerId = null) {
  const sessionId = getAgentSessionId(interaction);
  if (!sessionId || interaction?.status !== 'answered') return null;
  const resumeJob = createOrGetResumeJob({ sessionId, interactionId: interaction.id, ownerId });
  wakeAgentTaskWorker();
  return {
    resume_job: resumeJob,
    resume_ticket: issueCapability({
      sessionId,
      interactionId: interaction.id,
      resumeJobId: resumeJob.id,
      action: 'resume',
      ownerId,
    }),
  };
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

function buildStatusError(status) {
  if (status === 'answered') {
    return { code: 'INTERACTION_ALREADY_ANSWERED', message: '这张提问卡片已经回答过了' };
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
  let capability = null;
  if (agentSessionId) {
    capability = validateCapability(resumeTicket, {
      sessionId: agentSessionId,
      interactionId: interaction.id,
      action: 'respond',
      ...(ownerId ? { ownerId } : {}),
    });
    if (!capability.valid) {
      return res.status(403).json({ error: capability.reason, code: capability.reason, request_id: context.request_id });
    }
    if (interaction.status === 'answered') {
      const resume = buildResumeResult(interaction, ownerId);
      return res.status(200).json({
        interaction,
        resolution_status: 'resolved',
        should_continue: true,
        idempotent_replay: true,
        ...resume,
        request_id: context.request_id,
      });
    }
  }

  const { action } = req.body || {};
  if (interaction.kind === 'resource_approval') {
    if (interaction.status !== 'pending') {
      const statusError = buildStatusError(interaction.status);
      return res.status(409).json({ error: statusError.message, code: statusError.code, interaction, request_id: context.request_id });
    }
    const payload = interaction.payload || {};
    if (agentSessionId) {
      const consumed = validateCapability(resumeTicket, {
        sessionId: agentSessionId,
        interactionId: interaction.id,
        action: 'respond',
      }, { consume: true });
      if (!consumed.valid || consumed.consumed) {
        return res.status(409).json({ error: '恢复票据已消费，请刷新任务状态', code: 'CAPABILITY_ALREADY_CONSUMED', request_id: context.request_id });
      }
    }
    let result = { cancelled: true, action: payload.action };
    if (action === 'confirm') {
      try {
        if (payload.action === 'skill_install' || payload.action === 'skill_update') {
          const skill = require('../../../../lib/skills').installSkillDraft(payload.draft_id, payload.action === 'skill_update' ? 'replace' : 'reject');
          result = { approved: true, action: payload.action, skill: { id: skill.id, name: skill.name, enabled: skill.enabled } };
        } else if (payload.action === 'skill_uninstall') {
          require('../../../../lib/skills').deleteSkill(payload.skill_id); result = { approved: true, action: payload.action, deleted: true };
        } else if (payload.action === 'skill_disable') {
          const skill = require('../../../../lib/skills').setSkillEnabled(payload.skill_id, false); result = { approved: true, action: payload.action, skill: { id: skill.id, name: skill.name, enabled: skill.enabled } };
        } else if (payload.action === 'mcp_remove') {
          await require('../../../../lib/mcp').removeServer(payload.server_id); result = { approved: true, action: payload.action, deleted: true };
        } else throw Object.assign(new Error('未知资源操作'), { code: 'RESOURCE_ACTION_UNKNOWN' });
      } catch (error) {
        const failed = updateInteraction(interaction.id, { status: 'failed', response: { approved: false, error: error.code || 'RESOURCE_ACTION_FAILED', message: error.message } });
        return res.status(400).json({ error: error.message, code: error.code || 'RESOURCE_ACTION_FAILED', interaction: failed, request_id: context.request_id });
      }
    }
    const finalized = getDb().transaction(() => {
      const updated = updateInteraction(interaction.id, { status: 'answered', response: result, answeredAt: new Date().toISOString() });
      return { updated, resume: buildResumeResult(updated, ownerId) };
    })();
    return res.status(200).json({ interaction: finalized.updated, resolution_status: action === 'confirm' ? 'resolved' : 'cancelled', should_continue: true, resume_payload: result, ...(finalized.resume || {}), request_id: context.request_id });
  }
  if (action === 'cancel') {
    if (['answered', 'cancelled'].includes(interaction.status)) {
      const statusError = buildStatusError(interaction.status);
      return res.status(409).json({
        error: statusError.message,
        code: statusError.code,
        interaction,
        request_id: context.request_id,
      });
    }
    if (agentSessionId) validateCapability(resumeTicket, {
      sessionId: agentSessionId,
      interactionId: interaction.id,
      action: 'respond',
    }, { consume: true });
    const cancelledInteraction = updateInteraction(interaction.id, {
      status: 'cancelled',
      answeredAt: null,
    });
    return res.status(200).json({
      interaction: cancelledInteraction,
      answer_message: null,
      resolution_status: 'cancelled',
      normalized_response: null,
      should_continue: false,
      resume_payload: null,
      request_id: context.request_id,
    });
  }

  if (interaction.status !== 'pending') {
    const statusError = buildStatusError(interaction.status);
    return res.status(409).json({
      error: statusError.message,
      code: statusError.code,
      interaction,
      request_id: context.request_id,
    });
  }

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
    const staleInteraction = updateInteraction(interaction.id, { status: 'stale' });
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

  if (agentSessionId && normalizedResponse.resolution_status === 'resolved') {
    const consumed = validateCapability(resumeTicket, {
      sessionId: agentSessionId,
      interactionId: interaction.id,
      action: 'respond',
    }, { consume: true });
    if (!consumed.valid || consumed.consumed) {
      return res.status(409).json({ error: '恢复票据已消费，请刷新任务状态', code: 'CAPABILITY_ALREADY_CONSUMED', request_id: context.request_id });
    }
  }

  const summaryText = buildInteractionAnswerSummary(interaction, normalizedResponse);
  const nextStatus = normalizedResponse.resolution_status === 'resolved' ? 'answered' : 'pending';
  if (nextStatus === 'answered' && interaction.payload?.write_target_preflight) {
    const selected = String(normalizedResponse.answers?.write_target?.value || '').trim();
    const candidates = Array.isArray(interaction.payload?.write_target_candidates)
      ? interaction.payload.write_target_candidates
      : [];
    const candidate = candidates.find((item) => String(item?.filePath || '') === selected);
    const sessionId = Number(interaction.payload?.agent_session_id || 0);
    if (!sessionId || (!candidate && selected !== '__new_article__')) {
      return res.status(400).json({
        error: '写作目标无效，请重新选择。',
        code: 'WRITE_TARGET_INVALID',
        interaction,
        request_id: context.request_id,
      });
    }
    setSessionWriteTarget(sessionId, selected === '__new_article__'
      ? { mode: 'new' }
      : { mode: 'modify', file_path: candidate.filePath, operation_set_id: candidate.operationSetId });
  }
  const correctionState = buildCorrectionStateFromResponse(interaction, normalizedResponse);
  const finalized = getDb().transaction(() => {
    const answerMessageId = appendConversationMessage({
      conversationId: interaction.conversation_id,
      role: 'user',
      content: summaryText,
      meta: {
        interaction_id: interaction.id,
        interaction_resolution_status: normalizedResponse.resolution_status,
        correction_state: correctionState,
        article_hash: interaction.article_hash || '',
      },
    });
    touchConversation(interaction.conversation_id);
    const updatedInteraction = updateInteraction(interaction.id, {
      response: normalizedResponse,
      status: nextStatus,
      answerMessageId,
      answeredAt: nextStatus === 'answered' ? new Date().toISOString() : null,
    });
    return {
      answerMessageId,
      updatedInteraction,
      resume: nextStatus === 'answered' ? buildResumeResult(updatedInteraction, ownerId) : null,
    };
  })();
  const { answerMessageId, updatedInteraction } = finalized;
  const answerMessage = getConversationMessageById(answerMessageId);

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
    interaction: updatedInteraction,
    answer_message: answerMessage,
    resolution_status: normalizedResponse.resolution_status,
    normalized_response: normalizedResponse,
    should_continue: normalizedResponse.resolution_status === 'resolved',
    resume_payload: normalizedResponse.resolution_status === 'resolved'
      ? {
        interaction_id: updatedInteraction.id,
        interaction_response: normalizedResponse,
        conversation_id: updatedInteraction.conversation_id,
      }
      : null,
    ...(finalized.resume || {}),
    request_id: context.request_id,
  });
}
