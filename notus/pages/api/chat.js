const { ensureRuntime } = require('../../lib/runtime');
const { getEffectiveConfig } = require('../../lib/config');
const { createLogger, createRequestContext } = require('../../lib/logger');
const { buildKnowledgeQueryPlan } = require('../../lib/queryPlanner');
const { retrieveKnowledgeContext } = require('../../lib/retrieval');
const { retrieveWorkspaceDocuments } = require('../../lib/workspaceDocuments');
const { buildKnowledgeQAPrompt } = require('../../lib/prompt');
const { streamChat } = require('../../lib/llm');
const { resolveLlmRuntimeConfig } = require('../../lib/llmConfigs');
const {
  buildHistorySummary,
  sanitizeKnowledgeChunks,
  sanitizeKnowledgeSections,
} = require('../../lib/contextCompaction');
const {
  appendConversationMessage,
  ensureConversation,
  getConversationHistory,
  touchConversation,
  updateConversationScopes,
} = require('../../lib/conversations');
const { getFileById } = require('../../lib/files');
const { getVisibleDocumentLabel } = require('../../lib/documentLabels');
const {
  createInteraction,
  getInteractionById,
  updateInteraction,
} = require('../../lib/conversationInteractions');
const {
  buildKnowledgeClarifiedQuery,
  buildKnowledgeInteractionHash,
  buildKnowledgeInteractionPayload,
} = require('../../lib/knowledgeClarify');
const {
  resolveCombinedScopeFileIds,
  scopeFromLegacyReference: buildRetrievalScopeFromLegacy,
} = require('../../lib/workspaceScope');
const {
  buildClarifyResponse,
  buildKnowledgeHelperContext,
  buildNoEvidenceAnswer,
  decideKnowledgeAnswerMode,
  isPromptNearCompactionThreshold,
  maybeRerankKnowledgeSections,
  shouldTriggerKnowledgeRerank,
} = require('../../lib/knowledgeRuntime');

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function citationsFromChunks(chunks) {
  return chunks.map((chunk) => ({
    file: chunk.file_title,
    file_title: chunk.file_title,
    file_id: chunk.file_id,
    path: chunk.heading_path,
    heading_path: chunk.heading_path,
    quote: chunk.preview,
    preview: chunk.preview,
    lines: chunk.line_start && chunk.line_end ? `L${chunk.line_start}–${chunk.line_end}` : '',
    line_start: chunk.line_start,
    line_end: chunk.line_end,
    image_id: chunk.image_id || null,
    image_url: chunk.image_url || null,
    image_proxy_url: chunk.image_proxy_url || null,
    image_alt_text: chunk.image_alt_text || '',
    image_caption: chunk.image_caption || '',
  }));
}

function buildCitationSummary(knowledgeContext = {}) {
  const sections = Array.isArray(knowledgeContext.sections) ? knowledgeContext.sections : [];
  const chunks = Array.isArray(knowledgeContext.chunks) ? knowledgeContext.chunks : [];
  const matchedFiles = Array.isArray(knowledgeContext.matched_files) ? knowledgeContext.matched_files : [];
  return {
    citation_count: chunks.length,
    section_count: sections.length,
    matched_file_count: matchedFiles.length,
  };
}

function createKnowledgePromptController({
  query,
  effectiveQuery,
  conversationHistory,
  knowledgeContext,
  answerMeta,
}) {
  let stage = 0;

  function buildStageSnapshot(currentStage) {
    if (currentStage <= 0) {
      return {
        history: conversationHistory,
        memorySummary: '',
        documents: knowledgeContext.documents || [],
        sections: sanitizeKnowledgeSections(knowledgeContext.sections, {
          sectionLimit: 4,
          quoteLimit: 3,
          quoteTokenBudget: 140,
        }),
        chunks: sanitizeKnowledgeChunks(knowledgeContext.chunks, {
          chunkLimit: 3,
          chunkTokenBudget: 220,
        }),
      };
    }

    if (currentStage === 1) {
      return {
        history: conversationHistory,
        memorySummary: '',
        documents: (knowledgeContext.documents || []).slice(0, 2).map((doc) => ({
          ...doc,
          content: String(doc.content || '').slice(0, 6000),
          truncated: true,
        })),
        sections: sanitizeKnowledgeSections(knowledgeContext.sections, {
          sectionLimit: 3,
          quoteLimit: 2,
          quoteTokenBudget: 120,
        }),
        chunks: [],
      };
    }

    if (currentStage === 2) {
      const { recentHistory, memorySummary } = buildHistorySummary(conversationHistory, {
        keepRecentMessages: 6,
        maxOlderTurns: 4,
        userTokenBudget: 60,
        assistantTokenBudget: 90,
      });
      return {
        history: recentHistory,
        memorySummary,
        documents: [],
        sections: sanitizeKnowledgeSections(knowledgeContext.sections, {
          sectionLimit: 3,
          quoteLimit: 2,
          quoteTokenBudget: 100,
        }),
        chunks: [],
      };
    }

    if (currentStage === 3) {
      const { recentHistory, memorySummary } = buildHistorySummary(conversationHistory, {
        keepRecentMessages: 4,
        maxOlderTurns: 3,
        userTokenBudget: 50,
        assistantTokenBudget: 70,
      });
      return {
        history: recentHistory,
        memorySummary,
        documents: [],
        sections: sanitizeKnowledgeSections(knowledgeContext.sections, {
          sectionLimit: 2,
          quoteLimit: 1,
          quoteTokenBudget: 80,
        }),
        chunks: [],
      };
    }

    const { recentHistory, memorySummary } = buildHistorySummary(conversationHistory, {
      keepRecentMessages: 2,
      maxOlderTurns: 2,
      userTokenBudget: 40,
      assistantTokenBudget: 56,
    });
    return {
      history: recentHistory,
      memorySummary,
      documents: [],
      sections: sanitizeKnowledgeSections(knowledgeContext.sections, {
        sectionLimit: 1,
        quoteLimit: 1,
        quoteTokenBudget: 64,
      }),
      chunks: [],
    };
  }

  function buildMessages() {
    const state = buildStageSnapshot(stage);
    return buildKnowledgeQAPrompt(query, {
      ...knowledgeContext,
      documents: state.documents,
      sections: state.sections,
      chunks: state.chunks,
    }, {
      history: state.history,
      memorySummary: state.memorySummary,
      effectiveQuery,
      answerMode: answerMeta?.answer_mode || 'grounded',
      weakEvidenceReason: answerMeta?.weak_evidence_reason || '',
      conflictSummary: answerMeta?.conflict_summary || '',
    });
  }

  return {
    buildMessages,
    compact({ mode }) {
      const nextStage = mode === 'hard' ? Math.max(stage, 3) : stage + 1;
      if (nextStage > 4 || nextStage === stage) return null;
      stage = nextStage;
      return {
        messages: buildMessages(),
        meta: { compact_stage: stage },
      };
    },
    getCompacted() {
      return stage > 0;
    },
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

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/chat');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('chat.runtime.failed', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const {
    conversation_id: conversationId,
    query,
    model,
    llm_config_id: llmConfigId,
    active_file_id: activeFileId,
    reference_mode: referenceMode,
    reference_file_ids: referenceFileIds = [],
    webSearchEnabled = false,
    searchProvider = null,
    attachments = [],
    interaction_id: interactionId,
  } = req.body || {};
  let interaction = interactionId ? getInteractionById(interactionId) : null;
  const isInteractionResume = Boolean(interaction?.id);
  const requestedQuery = String(query || '').trim();
  if (!requestedQuery && !isInteractionResume) {
    return res.status(400).json({ error: 'query is required', code: 'QUERY_REQUIRED', request_id: context.request_id });
  }
  if (interactionId && !interaction) {
    return res.status(404).json({ error: '提问卡片不存在', code: 'INTERACTION_NOT_FOUND', request_id: context.request_id });
  }
  if (isInteractionResume && !['answered', 'failed'].includes(interaction.status)) {
    return res.status(409).json({
      error: interaction.status === 'stale' ? '当前提问卡片已经失效，请重新发起问题' : '当前提问卡片还没有完成回答',
      code: interaction.status === 'stale' ? 'INTERACTION_STALE' : 'INTERACTION_NOT_READY',
      interaction,
      request_id: context.request_id,
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  let conversation = null;
  try {
    const llmConfig = resolveLlmRuntimeConfig({ llmConfigId, model });
    if (llmConfigId && !llmConfig) {
      throw new Error('所选 LLM 配置不存在');
    }

    const originalQuery = isInteractionResume
      ? String(interaction?.payload?.original_user_input || '').trim()
      : requestedQuery;
    const resolvedQuery = isInteractionResume
      ? buildKnowledgeClarifiedQuery(interaction)
      : requestedQuery;

    conversation = ensureConversation({
      conversationId: isInteractionResume ? interaction.conversation_id : conversationId,
      kind: 'knowledge',
      title: originalQuery || resolvedQuery,
      fileId: null,
    });
    let retrievalScope = conversation.retrieval_scope || { type: 'all' };
    if (!isInteractionResume && referenceMode !== undefined) {
      retrievalScope = buildRetrievalScopeFromLegacy({ referenceMode, referenceFileIds });
      conversation = updateConversationScopes(conversation.id, { retrieval_scope: retrievalScope }) || conversation;
    }
    const scopeResolution = resolveCombinedScopeFileIds(
      retrievalScope,
      conversation.read_scope || { type: 'all' },
      { activeFileId }
    );
    const scopedFileIds = scopeResolution.fileIds;
    const restrictToScope = scopeResolution.restrictToFileIds;
    const effectiveReferenceMode = restrictToScope ? 'manual' : 'auto';
    const currentScopeHash = buildKnowledgeInteractionHash({
      activeFileId,
      fileIds: scopedFileIds,
      restrictToFileIds: restrictToScope,
      referenceMode: effectiveReferenceMode,
    });
    if (isInteractionResume && interaction.article_hash && interaction.article_hash !== currentScopeHash) {
      interaction = updateInteraction(interaction.id, { status: 'stale' });
      return res.status(409).json({
        error: '当前检索范围已经变化，需要重新确认',
        code: 'INTERACTION_STALE',
        interaction,
        request_id: context.request_id,
      });
    }
    const featureConfig = getEffectiveConfig();
    const features = {
      enableClarify: Boolean(featureConfig.knowledgeEnableClarify),
      enableConditionalRerank: Boolean(featureConfig.knowledgeEnableConditionalRerank),
      enableWeakEvidenceSupplement: Boolean(featureConfig.knowledgeEnableWeakEvidenceSupplement),
      enableConflictMode: Boolean(featureConfig.knowledgeEnableConflictMode),
    };
    const conversationHistory = getConversationHistory(conversation.id, { limit: 12 });
    if (!isInteractionResume) {
      appendConversationMessage({
        conversationId: conversation.id,
        role: 'user',
        content: requestedQuery,
        meta: {
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

    const helperContext = buildKnowledgeHelperContext({
      conversationId: conversation.id,
      query: resolvedQuery,
      history: conversationHistory,
      activeFileId,
      referenceMode: effectiveReferenceMode,
      referenceFileIds: scopedFileIds,
    });
    const helperPressureHigh = llmConfig
      ? isPromptNearCompactionThreshold(
        [...conversationHistory, ...(isInteractionResume ? [] : [{ role: 'user', content: requestedQuery }])],
        llmConfig,
        { model, taskType: 'knowledge_answer', ratio: 0.9 }
      )
      : false;

    let queryPlan = await buildKnowledgeQueryPlan({
      query: resolvedQuery,
      history: conversationHistory,
      llmConfig: llmConfig || null,
      model,
      allowLlmRewrite: !helperPressureHigh,
      enableClarify: isInteractionResume ? false : features.enableClarify,
      cacheContext: helperContext,
    });
    const activeFile = activeFileId ? getFileById(activeFileId) : null;
    const activeFileLabel = activeFile ? getVisibleDocumentLabel(activeFile, '当前文档') : '';
    if (features.enableClarify && queryPlan.clarify_needed && !isInteractionResume) {
      const clarifyPayload = buildKnowledgeInteractionPayload({
        query: requestedQuery,
        queryPlan: {
          ...queryPlan,
          query: requestedQuery,
        },
        activeFileId,
        activeFileLabel,
        fileIds: scopedFileIds,
        restrictToFileIds: restrictToScope,
        referenceMode: effectiveReferenceMode,
        history: conversationHistory,
      });
      queryPlan = {
        ...queryPlan,
        clarify_reason: clarifyPayload.clarify_reason || '',
        clarify_intro: clarifyPayload.clarify_intro || '',
        clarify_questions: clarifyPayload.questions || [],
        clarify_render_mode: 'card',
      };
    }
    const effectiveQuery = queryPlan.standalone_query || resolvedQuery;
    let helperTelemetry = {
      helper_call_type: queryPlan.helper_call_type || '',
      helper_call_triggered: Boolean(queryPlan.helper_call_triggered),
      helper_call_cache_hit: Boolean(queryPlan.helper_call_cache_hit),
      helper_call_latency_ms: Number(queryPlan.helper_call_latency_ms || 0),
      helper_call_failed: Boolean(queryPlan.helper_call_failed),
      fallback_reason: queryPlan.fallback_reason || '',
    };

    logger.info('chat.query_plan.resolved', {
      conversation_id: conversation.id,
      query: resolvedQuery,
      intent: queryPlan.intent,
      is_follow_up: queryPlan.is_follow_up,
      standalone_query: queryPlan.standalone_query,
      expanded_query: queryPlan.expanded_query,
      keywords: queryPlan.keywords,
      title_hints: queryPlan.title_hints,
      planner_used_llm: queryPlan.used_llm,
      clarity_score: queryPlan.clarity_score,
      ambiguity_flags: queryPlan.ambiguity_flags,
      clarify_needed: queryPlan.clarify_needed,
      clarify_reason: queryPlan.clarify_reason || '',
      helper_call_type: helperTelemetry.helper_call_type,
      helper_call_triggered: helperTelemetry.helper_call_triggered,
      helper_call_cache_hit: helperTelemetry.helper_call_cache_hit,
      helper_call_failed: helperTelemetry.helper_call_failed,
      helper_call_latency_ms: helperTelemetry.helper_call_latency_ms,
      fallback_reason: helperTelemetry.fallback_reason,
    });

    if (features.enableClarify && queryPlan.clarify_needed && !isInteractionResume) {
      const payload = buildKnowledgeInteractionPayload({
        query: requestedQuery,
        queryPlan: {
          ...queryPlan,
          query: requestedQuery,
        },
        activeFileId,
        activeFileLabel,
        fileIds: scopedFileIds,
        restrictToFileIds: restrictToScope,
        referenceMode: effectiveReferenceMode,
        history: conversationHistory,
      });
      const pendingResponse = buildPendingInteractionResponse(payload);
      let clarifyInteraction = createInteraction({
        conversationId: conversation.id,
        kind: 'clarify_card',
        source: 'knowledge',
        status: 'pending',
        reasonCode: queryPlan.clarify_reason || 'clarify_needed',
        articleHash: currentScopeHash,
        payload,
        response: pendingResponse,
      });
      const answerMeta = {
        answer_mode: 'clarify_needed',
        confidence: 0.12,
        clarity_score: queryPlan.clarity_score,
        ambiguity_flags: queryPlan.ambiguity_flags,
        rerank_applied: false,
        weak_evidence_reason: '',
        conflict_summary: '',
        retrieval_stats: null,
        clarify_question: queryPlan.clarify_question,
        clarify_reason: queryPlan.clarify_reason || '',
        clarify_intro: queryPlan.clarify_intro || '',
        interaction_id: clarifyInteraction.id,
        interaction_kind: 'clarify_card',
        question_count: payload.questions.length,
        ...helperTelemetry,
      };
      const answer = queryPlan.clarify_intro || buildClarifyResponse(queryPlan);
      send(res, {
        type: 'assistant_meta',
        interaction: clarifyInteraction,
        ...answerMeta,
      });
      send(res, { type: 'token', text: answer });
      send(res, { type: 'citations', citations: [] });
      const messageId = appendConversationMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: answer,
        citations: [],
        meta: answerMeta,
      });
      touchConversation(conversation.id);
      clarifyInteraction = updateInteraction(clarifyInteraction.id, { messageId });
      send(res, {
        type: 'done',
        conversation_id: conversation.id,
        message_id: messageId,
        answer_mode: answerMeta.answer_mode,
        confidence: answerMeta.confidence,
        meta: answerMeta,
        interaction: clarifyInteraction,
      });
      return res.end();
    }

    const knowledgeContext = await retrieveKnowledgeContext({
      ...queryPlan,
      query: resolvedQuery,
    }, {
      topK: 5,
      activeFileId,
      fileIds: scopedFileIds,
      restrictToFileIds: restrictToScope,
    });
    Object.assign(knowledgeContext, await retrieveWorkspaceDocuments({
      ...queryPlan,
      query: resolvedQuery,
    }, {
      knowledgeContext,
      maxDocuments: 5,
      activeFileId,
      fileIds: scopedFileIds,
      restrictToFileIds: restrictToScope,
    }));
    const chunks = Array.isArray(knowledgeContext.chunks) ? knowledgeContext.chunks : [];
    let sections = Array.isArray(knowledgeContext.sections) ? knowledgeContext.sections : [];
    const stats = knowledgeContext.stats || {};
    const sufficiency = Boolean(knowledgeContext.sufficiency);
    const matchedFiles = Array.isArray(knowledgeContext.matched_files) ? knowledgeContext.matched_files : [];
    const rewriteQueries = Array.isArray(knowledgeContext.rewrite_queries) ? knowledgeContext.rewrite_queries : [];
    const documentSummaries = Array.isArray(knowledgeContext.document_summaries) ? knowledgeContext.document_summaries : [];
    const documentStats = knowledgeContext.document_stats || {};
    const seedCount = Number(knowledgeContext.seed_count || 0);
    const expandedSectionCount = Number(knowledgeContext.expanded_section_count || sections.length);
    const helperAlreadyUsed = Boolean(helperTelemetry.helper_call_triggered);
    let rerankResult = null;

    if (
      features.enableConditionalRerank
      && llmConfig
      && !helperAlreadyUsed
      && shouldTriggerKnowledgeRerank(queryPlan, knowledgeContext)
    ) {
      const promptPressureHigh = isPromptNearCompactionThreshold(
        buildKnowledgeQAPrompt(resolvedQuery, knowledgeContext, {
          history: conversationHistory,
          effectiveQuery,
          answerMode: 'grounded',
        }),
        llmConfig,
        { model, taskType: 'knowledge_answer', ratio: 0.92 }
      );
      if (!promptPressureHigh) {
        rerankResult = await maybeRerankKnowledgeSections({
          query: resolvedQuery,
          queryPlan,
          knowledgeContext,
          llmConfig,
          model,
          history: conversationHistory,
          cacheContext: helperContext,
          logger,
        });
        if (Array.isArray(rerankResult.sections) && rerankResult.sections.length > 0) {
          knowledgeContext.sections = rerankResult.sections;
          sections = rerankResult.sections;
          helperTelemetry = {
            helper_call_type: rerankResult.helper_call_type || 'rerank',
            helper_call_triggered: Boolean(rerankResult.helper_call_triggered),
            helper_call_cache_hit: Boolean(rerankResult.helper_call_cache_hit),
            helper_call_latency_ms: Number(rerankResult.helper_call_latency_ms || 0),
            helper_call_failed: Boolean(rerankResult.helper_call_failed),
            fallback_reason: rerankResult.fallback_reason || '',
          };
        }
      }
    }

    const answerMeta = {
      ...decideKnowledgeAnswerMode({
        queryPlan,
        knowledgeContext,
        features,
        rerankResult,
      }),
      clarity_score: queryPlan.clarity_score,
      ambiguity_flags: queryPlan.ambiguity_flags,
      rerank_applied: Boolean(rerankResult?.rerank_applied),
      retrieval_stats: stats,
      documents: documentSummaries,
      document_stats: documentStats,
      clarify_question: '',
      ...(isInteractionResume ? {
        interaction_id: interaction.id,
        interaction_kind: 'clarify_card',
      } : {}),
      ...helperTelemetry,
    };

    logger.info('chat.retrieval.completed', {
      conversation_id: conversation.id,
      query: resolvedQuery,
      matched_files: matchedFiles,
      rewrite_queries: rewriteQueries,
      seed_count: seedCount,
      expanded_section_count: expandedSectionCount,
      best_score: stats.best_score,
      sufficiency,
      answer_mode: answerMeta.answer_mode,
      document_stats: documentStats,
      helper_call_type: helperTelemetry.helper_call_type,
      helper_call_triggered: helperTelemetry.helper_call_triggered,
      helper_call_cache_hit: helperTelemetry.helper_call_cache_hit,
      helper_call_failed: helperTelemetry.helper_call_failed,
      helper_call_latency_ms: helperTelemetry.helper_call_latency_ms,
      fallback_reason: helperTelemetry.fallback_reason,
    });

    const citationSummary = buildCitationSummary(knowledgeContext);

    send(res, {
      type: 'chunks',
      chunks,
      sections,
      documents: documentSummaries,
      document_stats: documentStats,
      stats,
      sufficiency,
      query_plan: queryPlan,
      matched_files: matchedFiles,
      rewrite_queries: rewriteQueries,
      seed_count: seedCount,
      expanded_section_count: expandedSectionCount,
      citation_count: citationSummary.citation_count,
      answer_mode: answerMeta.answer_mode,
      confidence: answerMeta.confidence,
      rerank_applied: answerMeta.rerank_applied,
    });
    send(res, {
      type: 'assistant_meta',
      source_count: citationSummary.citation_count,
      document_stats: documentStats,
      ...answerMeta,
    });

    const citations = citationsFromChunks(chunks);
    let answer = '';
    let usage = null;
    let budget = null;
    let compacted = false;

    if (answerMeta.answer_mode === 'no_evidence') {
      answer = buildNoEvidenceAnswer(sections, matchedFiles);
      send(res, { type: 'token', text: answer });
    } else {
      const promptController = createKnowledgePromptController({
        query: resolvedQuery,
        effectiveQuery,
        conversationHistory,
        knowledgeContext,
        answerMeta,
      });
      const streamResult = await streamChat(promptController.buildMessages(), {
        model,
        temperature: 0.1,
        config: llmConfig || undefined,
        taskType: 'knowledge_answer',
        compact: (payload) => promptController.compact(payload),
        onToken: (text) => send(res, { type: 'token', text }),
      });
      answer = streamResult.text;
      usage = streamResult.usage;
      budget = streamResult.budget;
      compacted = Boolean(streamResult.compacted || promptController.getCompacted());
      send(res, {
        type: 'usage',
        usage,
        budget,
        compacted,
      });
    }

    send(res, {
      type: 'citations',
      citations,
      source_count: citationSummary.citation_count,
    });
    if (isInteractionResume && interaction) {
      interaction = updateInteraction(interaction.id, { status: 'answered' });
    }
    const messageId = appendConversationMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: answer,
      citations,
      meta: answerMeta,
    });
    touchConversation(conversation.id);
    send(res, {
      type: 'done',
      conversation_id: conversation.id,
      message_id: messageId,
      usage,
      budget,
      compacted,
      answer_mode: answerMeta.answer_mode,
      confidence: answerMeta.confidence,
      source_count: citationSummary.citation_count,
      document_stats: documentStats,
      meta: answerMeta,
      interaction: isInteractionResume ? interaction : null,
    });
  } catch (error) {
    if (isInteractionResume && interaction) {
      interaction = updateInteraction(interaction.id, { status: 'failed' });
      const assistantMessage = '继续检索失败，请重试。';
      const assistantMeta = {
        answer_mode: 'clarify_needed',
        confidence: 0,
        clarity_score: 0,
        ambiguity_flags: [],
        rerank_applied: false,
        weak_evidence_reason: '',
        conflict_summary: '',
        retrieval_stats: null,
        clarify_question: '',
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
        citations: [],
        meta: assistantMeta,
      });
      touchConversation(conversation.id);
      send(res, {
        type: 'assistant_meta',
        conversation_id: conversation.id,
        message_id: messageId,
        assistant_message: assistantMessage,
        interaction,
        ...assistantMeta,
      });
      send(res, {
        type: 'done',
        conversation_id: conversation.id,
        message_id: messageId,
        answer_mode: assistantMeta.answer_mode,
        confidence: assistantMeta.confidence,
        meta: assistantMeta,
        interaction,
      });
      return res.end();
    }
    logger.error('chat.failed', {
      error,
      conversation_id: conversation?.id || null,
      query: requestedQuery || interaction?.payload?.original_user_input || '',
    });
    send(res, {
      type: 'error',
      error: error.message,
      conversation_id: conversation?.id || null,
      request_id: context.request_id,
    });
  }

  return res.end();
}
