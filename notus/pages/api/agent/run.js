const { ensureRuntime } = require('../../../lib/runtime');
const { runCanvasAgent } = require('../../../lib/canvasAgent');
const { computeDiff } = require('../../../lib/diff');
const { resolveLlmRuntimeConfig } = require('../../../lib/llmConfigs');
const { createLogger, createRequestContext } = require('../../../lib/logger');
const {
  appendConversationMessage,
  ensureConversation,
  getConversationHistory,
  getConversationMessageById,
  touchConversation,
  updateConversationScopes,
} = require('../../../lib/conversations');
const {
  computeArticleHash,
  createOperationSet,
  updateOperationSet,
} = require('../../../lib/canvasOperationSets');
const {
  STRUCTURED_REASON_CODES,
  buildResumePlanFromInteraction,
  computeTextDigest,
  createInteraction,
  getInteractionById,
  updateInteraction,
  validateInteractionSourceDigest,
} = require('../../../lib/conversationInteractions');
const {
  isScopeUnrestricted,
  resolveScopeFileIds,
  scopeFromLegacyReference,
  scopeFromLegacyStyle,
} = require('../../../lib/workspaceScope');
const { getVisibleDocumentLabel } = require('../../../lib/documentLabels');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function normalizeCitations(citations = []) {
  return citations.map((item) => ({
    file: getVisibleDocumentLabel(item.file_title || item.file || '', '未命名文档'),
    file_title: getVisibleDocumentLabel(item.file_title || item.file || '', '未命名文档'),
    file_id: item.file_id || null,
    path: item.heading_path || item.path || '',
    heading_path: item.heading_path || item.path || '',
    quote: item.preview || item.content || item.quote || '',
    preview: item.preview || item.quote || '',
    lines: item.line_start && item.line_end ? `L${item.line_start}–${item.line_end}` : item.lines || '',
    line_start: item.line_start || null,
    line_end: item.line_end || null,
  }));
}

function buildBlockPreview(content = '') {
  return String(content || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '空白块';
}

function buildTargetLocationOptions(article, candidateBlockIds = [], targetCandidates = []) {
  const blocks = Array.isArray(article?.blocks) ? article.blocks : [];
  const options = [
    { id: 'document_start', label: '文首', description: '写到正文开头位置' },
    { id: 'document_end', label: '文末', description: '写到正文结尾位置' },
  ];

  const rankedBlockIds = unique([
    ...(Array.isArray(targetCandidates) ? targetCandidates.map((item) => item?.block_id) : []),
    ...candidateBlockIds,
  ]);

  rankedBlockIds.slice(0, 4).forEach((blockId) => {
    const index = blocks.findIndex((item) => item.id === blockId);
    const block = index >= 0 ? blocks[index] : null;
    if (!block) return;
    const candidate = (Array.isArray(targetCandidates) ? targetCandidates : []).find((item) => item.block_id === blockId) || null;
    options.push({
      id: `block:${blockId}`,
      label: `第 ${index + 1} 段`,
      description: candidate?.heading_path
        ? `${candidate.heading_path} · ${buildBlockPreview(block.content)}`
        : buildBlockPreview(block.content),
    });
  });

  return options;
}

function unique(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function hasBodyKey(body = {}, key) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function legacyRequestScopes(body = {}) {
  const updates = {};
  if (hasBodyKey(body, 'reference_mode') || hasBodyKey(body, 'fact_file_ids')) {
    updates.retrieval_scope = scopeFromLegacyReference({
      referenceMode: body.reference_mode,
      referenceFileIds: body.fact_file_ids,
    });
  }
  if (hasBodyKey(body, 'style_mode') || hasBodyKey(body, 'style_file_ids')) {
    updates.style_scope = scopeFromLegacyStyle({
      styleMode: body.style_mode,
      styleFileIds: body.style_file_ids,
    });
  }
  return updates;
}

function resolveLegacyAgentScopes(conversation, { activeFileId, referenceMode, factFileIds, styleMode, styleFileIds } = {}) {
  const retrievalScope = conversation.retrieval_scope || scopeFromLegacyReference({ referenceMode, referenceFileIds: factFileIds });
  const styleScope = conversation.style_scope || scopeFromLegacyStyle({ styleMode, styleFileIds });
  const resolvedFactIds = isScopeUnrestricted(retrievalScope)
    ? []
    : resolveScopeFileIds(retrievalScope, { activeFileId });
  const resolvedStyleIds = isScopeUnrestricted(styleScope)
    ? []
    : resolveScopeFileIds(styleScope, { activeFileId });

  return {
    referenceMode: resolvedFactIds.length > 0 ? 'manual' : 'auto',
    factFileIds: resolvedFactIds.length > 0 ? resolvedFactIds : factFileIds,
    styleMode: resolvedStyleIds.length > 0 ? 'manual' : 'auto',
    styleFileIds: resolvedStyleIds.length > 0 ? resolvedStyleIds : styleFileIds,
  };
}

function buildClarifyQuestions(result, article) {
  const missingSlots = Array.isArray(result.missingSlots) ? result.missingSlots : [];
  const sourceCandidates = Array.isArray(result.sourceCandidates) ? result.sourceCandidates : [];
  const candidateBlockIds = Array.isArray(result.candidateBlockIds) ? result.candidateBlockIds : [];
  const targetCandidates = Array.isArray(result.targetCandidates) ? result.targetCandidates : [];
  const questions = [];

  if (missingSlots.includes('primary_intent')) {
    questions.push({
      id: 'primary_intent',
      slot: 'primary_intent',
      label: '这次要做什么？',
      type: 'single_select',
      required: true,
      options: [
        {
          id: 'edit',
          label: '直接改文档',
        },
        {
          id: 'text',
          label: '继续讨论',
        },
        {
          id: 'analyze',
          label: '文章分析',
        },
      ],
      allow_custom: true,
      custom_placeholder: '自定义答案',
      recommended_option_ids: result.primaryIntent ? [result.primaryIntent] : ['edit'],
    });
  }

  if (missingSlots.includes('source_content_ref')) {
    const singleSelect = sourceCandidates.length > 0;
    questions.push({
      id: 'source_content_ref',
      slot: 'source_content_ref',
      label: '要写入哪段内容？',
      type: singleSelect ? 'single_select' : 'text_input',
      required: true,
      options: singleSelect
        ? sourceCandidates.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.description || '',
        }))
        : [],
      allow_custom: true,
      custom_placeholder: '自定义内容',
      recommended_option_ids: sourceCandidates[0] ? [sourceCandidates[0].id] : [],
    });
  }

  if (missingSlots.includes('target_location')) {
    const options = buildTargetLocationOptions(article, candidateBlockIds, targetCandidates);
    questions.push({
      id: 'target_location',
      slot: 'target_location',
      label: '要写到哪里？',
      type: 'single_select',
      required: true,
      options,
      allow_custom: true,
      custom_placeholder: '自定义位置',
      recommended_option_ids: options[2] ? [options[2].id] : (options[1] ? [options[1].id] : []),
    });
  }

  if (missingSlots.includes('write_mode')) {
    questions.push({
      id: 'write_mode',
      slot: 'write_mode',
      label: '怎么写入？',
      type: 'single_select',
      required: true,
      options: [
        {
          id: 'append_new_blocks',
          label: '追加新段落',
        },
        {
          id: 'replace_target',
          label: '替换目标段落',
        },
        {
          id: 'insert_before_target',
          label: '写到目标前面',
        },
      ],
      allow_custom: true,
      custom_placeholder: '自定义方式',
      recommended_option_ids: ['append_new_blocks'],
    });
  }

  return questions.slice(0, 3);
}

function buildClarifyInteractionPayload({ userInput, article, result }) {
  const sourceReference = result.sourceReference || {};
  const prefilledAnswers = result.prefilledAnswers && typeof result.prefilledAnswers === 'object'
    ? result.prefilledAnswers
    : {};
  const questions = buildClarifyQuestions(result, article);

  return {
    title: '确认后继续',
    original_user_input: String(userInput || ''),
    primary_intent: result.primaryIntent || 'edit',
    source_message_id: sourceReference.source_message_id || null,
    source_kind: sourceReference.source_kind || 'assistant_message',
    source_content_snapshot: String(sourceReference.source_content_snapshot || ''),
    source_content_digest: String(sourceReference.source_content_digest || computeTextDigest(sourceReference.source_content_snapshot || '')),
    source_content_type: sourceReference.source_content_type || result.sourceContentType || '',
    source_candidates: Array.isArray(result.sourceCandidates) ? result.sourceCandidates : [],
    target_candidates: Array.isArray(result.targetCandidates) ? result.targetCandidates : [],
    candidate_block_ids: Array.isArray(result.candidateBlockIds) ? result.candidateBlockIds : [],
    decision_summary: result.decisionSummary || '',
    risk_level: result.riskLevel || 'low',
    ai_arbitration_mode: result.aiArbitrationMode || 'none',
    correction_state: result.correctionState || null,
    article_blocks: (Array.isArray(article?.blocks) ? article.blocks : []).map((block, index) => ({
      id: block.id,
      index: index + 1,
      type: block.type,
      content: buildBlockPreview(block.content),
    })),
    prefilled_answers: prefilledAnswers,
    questions,
  };
}

function buildPendingInteractionResponse(payload = {}) {
  const prefilledAnswers = payload.prefilled_answers && typeof payload.prefilled_answers === 'object'
    ? payload.prefilled_answers
    : {};
  const missingSlots = (Array.isArray(payload.questions) ? payload.questions : [])
    .map((question) => question?.id)
    .filter(Boolean);
  return {
    answers: { ...prefilledAnswers },
    missing_slots: missingSlots,
    resolution_status: Object.keys(prefilledAnswers).length > 0 ? 'partial' : 'failed',
  };
}

function buildAssistantMeta(result, operationSet = null, extras = {}) {
  return {
    canvas_mode: result.canvasMode || 'text',
    primary_intent: result.primaryIntent || result.canvasMode || 'text',
    intent_confidence: Number(result.intentConfidence || 0) || 0,
    scope_mode: result.scopeMode || 'none',
    target_block_ids: result.targetBlockIds || [],
    operation_kind: result.operationKind || '',
    last_focus_summary: result.focusSummary || '',
    operation_set_id: operationSet?.id || null,
    operation_count: Array.isArray(result.operations) ? result.operations.length : 0,
    helper_used: Boolean(result.helperUsed),
    style_context_mode: result.styleContextMode || 'none',
    fallback_reason: result.fallbackReason || null,
    risk_level: result.riskLevel || 'low',
    decision_summary: result.decisionSummary || '',
    ai_arbitration_mode: result.aiArbitrationMode || 'none',
    source_content_type: result.sourceContentType || '',
    target_anchor: result.targetAnchor || null,
    position_relation: result.positionRelation || '',
    write_action: result.writeAction || '',
    correction_state: result.correctionState || null,
    show_decision_summary: Boolean(result.showDecisionSummary),
    ...extras,
  };
}

function emitDone(res, payload) {
  send(res, {
    type: 'done',
    ...payload,
  });
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/agent/run');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('canvas.run.failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const {
    conversation_id: conversationId,
    user_input: userInput,
    article,
    llm_config_id: llmConfigId,
    active_file_id: activeFileId,
    reference_mode: referenceMode = 'auto',
    fact_file_ids: factFileIds = [],
    style_mode: styleMode = 'auto',
    style_file_ids: styleFileIds = [],
    webSearchEnabled = false,
    searchProvider = null,
    attachments = [],
    interaction_id: interactionId,
    user_meta: userMeta = null,
  } = req.body || {};

  if (!article?.blocks) {
    return res.status(400).json({
      error: 'article.blocks is required',
      code: 'INVALID_AGENT_REQUEST',
      request_id: context.request_id,
    });
  }

  const articleFileId = Number(article?.file_id || article?.fileId) || null;
  if (!articleFileId) {
    return res.status(400).json({
      error: '请先保存当前创作，再继续 AI 改写',
      code: 'ARTICLE_FILE_REQUIRED',
      request_id: context.request_id,
    });
  }

  let interaction = interactionId ? getInteractionById(interactionId) : null;
  const isInteractionResume = Boolean(interaction?.id);
  const articleHash = computeArticleHash(article);
  const resolvedUserInput = isInteractionResume
    ? (interaction?.payload?.original_user_input || userInput || '继续生成预览')
    : userInput;

  if (!isInteractionResume && !resolvedUserInput) {
    return res.status(400).json({
      error: 'user_input is required',
      code: 'INVALID_AGENT_REQUEST',
      request_id: context.request_id,
    });
  }

  if (interactionId && !interaction) {
    return res.status(404).json({
      error: '提问抽屉不存在',
      code: 'INTERACTION_NOT_FOUND',
      request_id: context.request_id,
    });
  }

  if (isInteractionResume) {
    if (!['answered', 'failed'].includes(interaction.status)) {
      return res.status(409).json({
        error: interaction.status === 'stale' ? '文章已变化，需要重新确认' : '提问抽屉还没有完成回答',
        code: interaction.status === 'stale' ? 'INTERACTION_STALE' : 'INTERACTION_NOT_READY',
        request_id: context.request_id,
      });
    }
    if (interaction.article_hash && interaction.article_hash !== articleHash) {
      interaction = updateInteraction(interaction.id, { status: 'stale' });
      return res.status(409).json({
        error: '文章已变化，需要重新确认',
        code: 'INTERACTION_STALE',
        interaction,
        request_id: context.request_id,
      });
    }
    if (!validateInteractionSourceDigest(interaction, getConversationMessageById)) {
      interaction = updateInteraction(interaction.id, { status: 'failed' });
      return res.status(409).json({
        error: '来源内容已失效，请重新发起一次写入',
        code: 'INTERACTION_SOURCE_MISMATCH',
        interaction,
        request_id: context.request_id,
      });
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  let conversation = ensureConversation({
    conversationId: isInteractionResume ? interaction.conversation_id : conversationId,
    kind: 'canvas',
    title: isInteractionResume ? (interaction.payload?.original_user_input || '继续生成预览') : userInput,
    fileId: articleFileId,
    draftKey: article?.draft_key || article?.draftKey || null,
  });
  const scopeUpdates = isInteractionResume ? {} : legacyRequestScopes(req.body || {});
  if (Object.keys(scopeUpdates).length > 0) {
    conversation = updateConversationScopes(conversation.id, scopeUpdates) || conversation;
  }
  const effectiveScopes = resolveLegacyAgentScopes(conversation, {
    activeFileId: activeFileId || articleFileId,
    referenceMode,
    factFileIds,
    styleMode,
    styleFileIds,
  });

  const conversationHistory = getConversationHistory(conversation.id, { limit: 12 });
  if (!isInteractionResume) {
    appendConversationMessage({
      conversationId: conversation.id,
      role: 'user',
      content: userInput,
      meta: {
        ...(userMeta && typeof userMeta === 'object' ? userMeta : {}),
        article_hash: articleHash,
        web_search_enabled: Boolean(webSearchEnabled),
        search_provider: searchProvider || null,
        attachments: Array.isArray(attachments) ? attachments.map((item) => ({
          name: item?.name || '',
          type: item?.type || '',
          size: item?.size || 0,
        })).filter((item) => item.name) : [],
      },
    });
    touchConversation(conversation.id);
  }

  try {
    const llmConfig = llmConfigId ? resolveLlmRuntimeConfig({ llmConfigId }) : null;
    if (llmConfigId && !llmConfig) {
      throw new Error('所选 LLM 配置不存在');
    }

    const result = await runCanvasAgent({
      userInput: resolvedUserInput,
      article,
      conversationHistory,
      activeFileId,
      referenceMode: effectiveScopes.referenceMode,
      factFileIds: effectiveScopes.factFileIds,
      styleMode: effectiveScopes.styleMode,
      styleFileIds: effectiveScopes.styleFileIds,
      llmConfig,
      forcedPlan: isInteractionResume ? buildResumePlanFromInteraction(interaction, article) : null,
    }, (event) => send(res, { ...event, conversation_id: conversation.id }));

    if (
      result.canvasMode === 'clarify'
      && result.interactionEligible
      && result.clarifyRenderMode === 'card'
      && STRUCTURED_REASON_CODES.includes(result.clarifyReason)
    ) {
      const payload = buildClarifyInteractionPayload({
        userInput: resolvedUserInput,
        article,
        result,
      });
      const pendingResponse = buildPendingInteractionResponse(payload);
      let clarifyInteraction = isInteractionResume
        ? updateInteraction(interaction.id, {
          status: 'pending',
          reasonCode: result.clarifyReason,
          articleHash,
          payload,
          response: pendingResponse,
          answeredAt: null,
        })
        : createInteraction({
          conversationId: conversation.id,
          kind: 'clarify_card',
          source: 'canvas',
          status: 'pending',
          reasonCode: result.clarifyReason,
          articleHash,
          payload,
          response: pendingResponse,
        });

      const assistantMeta = buildAssistantMeta(result, null, {
        interaction_id: clarifyInteraction.id,
        interaction_kind: 'clarify_card',
        reason_code: result.clarifyReason,
        question_count: payload.questions.length,
      });
      const assistantMessage = String(result.text || '').trim() || '请确认后继续。';
      const messageId = appendConversationMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: assistantMessage,
        citations: [],
        meta: assistantMeta,
      });
      touchConversation(conversation.id);
      clarifyInteraction = updateInteraction(clarifyInteraction.id, { messageId });

      logger.info(isInteractionResume ? 'canvas.clarify.reopened' : 'canvas.clarify.requested', {
        conversation_id: conversation.id,
        file_id: articleFileId,
        reason_code: result.clarifyReason,
        question_count: payload.questions.length,
        resolution_status: 'pending',
        continued_to_edit: false,
        operation_set_created: false,
        risk_level: result.riskLevel || 'low',
        decision_summary: result.decisionSummary || '',
        ai_arbitration_mode: result.aiArbitrationMode || 'none',
        decision_path: result.decisionPath || [],
        source_content_type: result.sourceContentType || '',
      });

      send(res, {
        type: 'assistant_meta',
        conversation_id: conversation.id,
        message_id: messageId,
        assistant_message: assistantMessage,
        assistant_meta: assistantMeta,
        interaction: clarifyInteraction,
      });
      send(res, {
        type: 'interaction_request',
        conversation_id: conversation.id,
        message_id: messageId,
        assistant_message: assistantMessage,
        assistant_meta: assistantMeta,
        interaction: clarifyInteraction,
      });
      emitDone(res, {
        conversation_id: conversation.id,
        message_id: messageId,
        assistant_message: assistantMessage,
        assistant_meta: assistantMeta,
        interaction: clarifyInteraction,
        citations: [],
        usage: result.usage || null,
        budget: result.budget || null,
        compacted: Boolean(result.compacted),
      });
      return res.end();
    }

    const citations = normalizeCitations(result.citations || []);
    let operationSet = null;
    if (Array.isArray(result.operations) && result.operations.length > 0) {
      operationSet = createOperationSet({
        conversationId: conversation.id,
        fileId: articleFileId,
        articleHash,
        mode: result.scopeMode || 'single',
        operations: result.operations,
        status: 'pending',
      });
    }

    if (isInteractionResume) {
      interaction = updateInteraction(interaction.id, { status: 'answered' });
      logger.info('canvas.clarify.resumed', {
        conversation_id: conversation.id,
        file_id: articleFileId,
        reason_code: interaction.reason_code,
        question_count: Array.isArray(interaction.payload?.questions) ? interaction.payload.questions.length : 0,
        resolution_status: 'resolved',
        continued_to_edit: true,
        operation_set_created: Boolean(operationSet?.id),
        risk_level: result.riskLevel || 'low',
        decision_summary: result.decisionSummary || '',
        ai_arbitration_mode: result.aiArbitrationMode || 'none',
        source_content_type: result.sourceContentType || '',
      });
    }

    const assistantMeta = buildAssistantMeta(result, operationSet, isInteractionResume
      ? {
        interaction_id: interaction.id,
        interaction_kind: 'clarify_card',
        reason_code: interaction.reason_code,
      }
      : {});

    const assistantMessage = String(result.text || '').trim() || '处理完成。';
    const messageId = appendConversationMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: assistantMessage,
      citations,
      meta: assistantMeta,
    });
    touchConversation(conversation.id);

    if (operationSet?.id) {
      operationSet = updateOperationSet(operationSet.id, { messageId });
      result.operations.forEach((operation) => {
        const block = article.blocks.find((item) => item.id === operation.block_id);
        send(res, {
          type: 'operation',
          conversation_id: conversation.id,
          operation,
          diff: computeDiff(block?.content || '', operation.new || ''),
        });
      });
    }

    if (result.helperUsed) {
      logger.info('canvas.helper.used', {
        conversation_id: conversation.id,
        file_id: articleFileId,
        canvas_mode: assistantMeta.canvas_mode,
        primary_intent: assistantMeta.primary_intent,
        intent_confidence: assistantMeta.intent_confidence,
        scope_mode: assistantMeta.scope_mode,
        operation_kind: assistantMeta.operation_kind,
        helper_used: true,
        operation_count: assistantMeta.operation_count,
        fallback_reason: assistantMeta.fallback_reason,
        operation_set_status: operationSet?.status || null,
        risk_level: assistantMeta.risk_level,
        decision_summary: assistantMeta.decision_summary,
        ai_arbitration_mode: assistantMeta.ai_arbitration_mode,
      });
    }

    const runEvent = assistantMeta.fallback_reason ? 'canvas.run.refused' : 'canvas.run.completed';
    logger.info(runEvent, {
      conversation_id: conversation.id,
      file_id: articleFileId,
      canvas_mode: assistantMeta.canvas_mode,
      primary_intent: assistantMeta.primary_intent,
      intent_confidence: assistantMeta.intent_confidence,
      scope_mode: assistantMeta.scope_mode,
      operation_kind: assistantMeta.operation_kind,
      helper_used: assistantMeta.helper_used,
      operation_count: assistantMeta.operation_count,
      fallback_reason: assistantMeta.fallback_reason,
      operation_set_status: operationSet?.status || null,
      risk_level: assistantMeta.risk_level,
      decision_summary: assistantMeta.decision_summary,
      ai_arbitration_mode: assistantMeta.ai_arbitration_mode,
      source_content_type: assistantMeta.source_content_type,
    });

    send(res, {
      type: 'assistant_meta',
      conversation_id: conversation.id,
      message_id: messageId,
      assistant_message: assistantMessage,
      assistant_meta: assistantMeta,
      operation_set: operationSet,
      interaction: isInteractionResume ? interaction : null,
    });
    emitDone(res, {
      conversation_id: conversation.id,
      message_id: messageId,
      assistant_message: assistantMessage,
      assistant_meta: assistantMeta,
      operation_set: operationSet,
      interaction: isInteractionResume ? interaction : null,
      citations,
      usage: result.usage || null,
      budget: result.budget || null,
      compacted: Boolean(result.compacted),
    });
  } catch (error) {
    if (isInteractionResume && interaction) {
      interaction = updateInteraction(interaction.id, { status: 'failed' });
      const assistantMessage = '生成预览失败，请重试。';
      const assistantMeta = {
        canvas_mode: 'clarify_resume_failed',
        scope_mode: 'none',
        target_block_ids: [],
        operation_kind: '',
        last_focus_summary: assistantMessage,
        operation_set_id: null,
        operation_count: 0,
        helper_used: false,
        style_context_mode: 'none',
        fallback_reason: 'clarify_resume_failed',
        interaction_id: interaction.id,
        interaction_kind: 'clarify_card',
        retry_interaction_id: interaction.id,
        retry_available: true,
      };
      const messageId = appendConversationMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: assistantMessage,
        meta: assistantMeta,
      });
      touchConversation(conversation.id);
      logger.error('canvas.clarify.failed', {
        conversation_id: conversation.id,
        file_id: articleFileId,
        reason_code: interaction.reason_code,
        question_count: Array.isArray(interaction.payload?.questions) ? interaction.payload.questions.length : 0,
        resolution_status: 'failed',
        continued_to_edit: false,
        operation_set_created: false,
        decision_summary: interaction.payload?.decision_summary || '',
        risk_level: interaction.payload?.risk_level || 'low',
        ai_arbitration_mode: interaction.payload?.ai_arbitration_mode || 'none',
        error,
      });
      send(res, {
        type: 'assistant_meta',
        conversation_id: conversation.id,
        message_id: messageId,
        assistant_message: assistantMessage,
        assistant_meta: assistantMeta,
        interaction,
      });
      emitDone(res, {
        conversation_id: conversation.id,
        message_id: messageId,
        assistant_message: assistantMessage,
        assistant_meta: assistantMeta,
        interaction,
        operation_set: null,
        citations: [],
        usage: null,
        budget: null,
        compacted: false,
      });
      return res.end();
    }

    logger.error('canvas.run.failed', {
      conversation_id: conversation.id,
      file_id: articleFileId,
      error,
    });
    send(res, {
      type: 'error',
      error: error.message,
      conversation_id: conversation.id,
    });
  }

  return res.end();
}
