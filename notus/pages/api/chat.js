const { ensureRuntime } = require('../../lib/runtime');
const { getEffectiveConfig } = require('../../lib/config');
const { createLogger, createRequestContext } = require('../../lib/logger');
const { buildKnowledgeQueryPlan } = require('../../lib/queryPlanner');
const { retrieveKnowledgeContext } = require('../../lib/retrieval');
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
} = require('../../lib/conversations');
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
  } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required', code: 'QUERY_REQUIRED', request_id: context.request_id });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  let conversation = null;
  try {
    const llmConfig = resolveLlmRuntimeConfig({ llmConfigId, model });
    if (llmConfigId && !llmConfig) {
      throw new Error('所选 LLM 配置不存在');
    }

    conversation = ensureConversation({
      conversationId,
      kind: 'knowledge',
      title: query,
      fileId: null,
    });
    const featureConfig = getEffectiveConfig();
    const features = {
      enableClarify: Boolean(featureConfig.knowledgeEnableClarify),
      enableConditionalRerank: Boolean(featureConfig.knowledgeEnableConditionalRerank),
      enableWeakEvidenceSupplement: Boolean(featureConfig.knowledgeEnableWeakEvidenceSupplement),
      enableConflictMode: Boolean(featureConfig.knowledgeEnableConflictMode),
    };
    const conversationHistory = getConversationHistory(conversation.id, { limit: 12 });
    appendConversationMessage({
      conversationId: conversation.id,
      role: 'user',
      content: query,
    });
    touchConversation(conversation.id);

    const helperContext = buildKnowledgeHelperContext({
      conversationId: conversation.id,
      query,
      history: conversationHistory,
      activeFileId,
      referenceMode,
      referenceFileIds,
    });
    const helperPressureHigh = llmConfig
      ? isPromptNearCompactionThreshold(
        [...conversationHistory, { role: 'user', content: query }],
        llmConfig,
        { model, taskType: 'knowledge_answer', ratio: 0.9 }
      )
      : false;

    const queryPlan = await buildKnowledgeQueryPlan({
      query,
      history: conversationHistory,
      llmConfig: llmConfig || null,
      model,
      allowLlmRewrite: !helperPressureHigh,
      enableClarify: features.enableClarify,
      cacheContext: helperContext,
    });
    const effectiveQuery = queryPlan.standalone_query || query;
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
      query,
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
      helper_call_type: helperTelemetry.helper_call_type,
      helper_call_triggered: helperTelemetry.helper_call_triggered,
      helper_call_cache_hit: helperTelemetry.helper_call_cache_hit,
      helper_call_failed: helperTelemetry.helper_call_failed,
      helper_call_latency_ms: helperTelemetry.helper_call_latency_ms,
      fallback_reason: helperTelemetry.fallback_reason,
    });

    if (features.enableClarify && queryPlan.clarify_needed) {
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
        ...helperTelemetry,
      };
      const answer = buildClarifyResponse(queryPlan);
      send(res, {
        type: 'assistant_meta',
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
      send(res, {
        type: 'done',
        conversation_id: conversation.id,
        message_id: messageId,
        answer_mode: answerMeta.answer_mode,
        confidence: answerMeta.confidence,
        meta: answerMeta,
      });
      return res.end();
    }

    const knowledgeContext = await retrieveKnowledgeContext({
      ...queryPlan,
      query,
    }, {
      topK: 5,
      activeFileId,
      fileIds: referenceMode === 'manual' ? referenceFileIds : [],
      restrictToFileIds: referenceMode === 'manual',
    });
    const chunks = Array.isArray(knowledgeContext.chunks) ? knowledgeContext.chunks : [];
    let sections = Array.isArray(knowledgeContext.sections) ? knowledgeContext.sections : [];
    const stats = knowledgeContext.stats || {};
    const sufficiency = Boolean(knowledgeContext.sufficiency);
    const matchedFiles = Array.isArray(knowledgeContext.matched_files) ? knowledgeContext.matched_files : [];
    const rewriteQueries = Array.isArray(knowledgeContext.rewrite_queries) ? knowledgeContext.rewrite_queries : [];
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
        buildKnowledgeQAPrompt(query, knowledgeContext, {
          history: conversationHistory,
          effectiveQuery,
          answerMode: 'grounded',
        }),
        llmConfig,
        { model, taskType: 'knowledge_answer', ratio: 0.92 }
      );
      if (!promptPressureHigh) {
        rerankResult = await maybeRerankKnowledgeSections({
          query,
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
      clarify_question: '',
      ...helperTelemetry,
    };

    logger.info('chat.retrieval.completed', {
      conversation_id: conversation.id,
      query,
      matched_files: matchedFiles,
      rewrite_queries: rewriteQueries,
      seed_count: seedCount,
      expanded_section_count: expandedSectionCount,
      best_score: stats.best_score,
      sufficiency,
      answer_mode: answerMeta.answer_mode,
      helper_call_type: helperTelemetry.helper_call_type,
      helper_call_triggered: helperTelemetry.helper_call_triggered,
      helper_call_cache_hit: helperTelemetry.helper_call_cache_hit,
      helper_call_failed: helperTelemetry.helper_call_failed,
      helper_call_latency_ms: helperTelemetry.helper_call_latency_ms,
      fallback_reason: helperTelemetry.fallback_reason,
    });

    send(res, {
      type: 'chunks',
      chunks,
      sections,
      stats,
      sufficiency,
      query_plan: queryPlan,
      matched_files: matchedFiles,
      rewrite_queries: rewriteQueries,
      seed_count: seedCount,
      expanded_section_count: expandedSectionCount,
      answer_mode: answerMeta.answer_mode,
      confidence: answerMeta.confidence,
      rerank_applied: answerMeta.rerank_applied,
    });
    send(res, {
      type: 'assistant_meta',
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
        query,
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

    send(res, { type: 'citations', citations });
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
      meta: answerMeta,
    });
  } catch (error) {
    logger.error('chat.failed', {
      error,
      conversation_id: conversation?.id || null,
      query,
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
