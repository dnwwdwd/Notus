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

export default function handler(req, res) {
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

  if (interaction.status !== 'pending') {
    const statusError = buildStatusError(interaction.status);
    return res.status(409).json({
      error: statusError.message,
      code: statusError.code,
      interaction,
      request_id: context.request_id,
    });
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

  if (currentArticleHash && currentArticleHash !== interaction.article_hash) {
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

  const summaryText = buildInteractionAnswerSummary(interaction, normalizedResponse);
  const nextStatus = normalizedResponse.resolution_status === 'resolved' ? 'answered' : 'pending';
  const correctionState = buildCorrectionStateFromResponse(interaction, normalizedResponse);
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
    request_id: context.request_id,
  });
}
