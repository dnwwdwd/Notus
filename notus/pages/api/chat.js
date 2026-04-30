const { ensureRuntime } = require('../../lib/runtime');
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

function buildInsufficientAnswer(sections = []) {
  const evidence = sections.length > 0
    ? sections
      .slice(0, 3)
      .map((section) => `- 《${section.file_title}》${section.heading_path ? ` ${section.heading_path}` : ''}`)
      .join('\n')
    : '';

  if (!evidence) {
    return '不知道。笔记里没有找到足够相关的内容，暂时没法可靠回答这个问题。';
  }

  return `我现在没法可靠回答这个问题。现有笔记里只找到少量相关线索，证据还不够充分。\n\n比较接近的内容有：\n${evidence}`;
}

function isLikelyFollowUpQuery(query) {
  const text = String(query || '').trim();
  if (!text) return false;
  if (text.length <= 10) return true;
  if (/^(继续|展开|补充|详细|具体|然后|还有|那|呢|为什么|怎么|如何)/.test(text)) return true;
  if (/(这个|这个问题|这个结论|这个观点|上一条|刚才|前面|上述|第二种|第一种|第三种|这种|那种|它|他|她|其)/.test(text)) {
    return true;
  }
  return false;
}

function buildEffectiveKnowledgeQuery(query, history) {
  const text = String(query || '').trim();
  const normalizedHistory = Array.isArray(history) ? history : [];
  if (!isLikelyFollowUpQuery(text)) return text;

  const previousQuestions = normalizedHistory
    .filter((message) => message.role === 'user' && String(message.content || '').trim())
    .slice(-2)
    .map((message) => String(message.content || '').trim());

  if (previousQuestions.length === 0) return text;
  return `${previousQuestions.join('\n')}\n当前追问：${text}`;
}

function createKnowledgePromptController({
  query,
  effectiveQuery,
  conversationHistory,
  knowledgeContext,
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
  if (req.method !== 'POST') return res.status(405).end();

  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR' });

  const {
    conversation_id: conversationId,
    query,
    model,
    llm_config_id: llmConfigId,
    active_file_id: activeFileId,
    reference_mode: referenceMode,
    reference_file_ids: referenceFileIds = [],
  } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query is required', code: 'QUERY_REQUIRED' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  let conversation = null;
  try {
    conversation = ensureConversation({
      conversationId,
      kind: 'knowledge',
      title: query,
      fileId: null,
    });
    const conversationHistory = getConversationHistory(conversation.id, { limit: 12 });
    appendConversationMessage({
      conversationId: conversation.id,
      role: 'user',
      content: query,
    });
    touchConversation(conversation.id);

    const effectiveQuery = buildEffectiveKnowledgeQuery(query, conversationHistory);

    const knowledgeContext = await retrieveKnowledgeContext(effectiveQuery, {
      topK: 5,
      activeFileId,
      fileIds: referenceMode === 'manual' ? referenceFileIds : [],
      restrictToFileIds: referenceMode === 'manual',
    });
    const { chunks, sections, stats, sufficiency } = knowledgeContext;
    send(res, { type: 'chunks', chunks, sections, stats, sufficiency });

    const citations = citationsFromChunks(chunks);
    let answer = '';
    let usage = null;
    let budget = null;
    let compacted = false;

    if (chunks.length === 0) {
      answer = buildInsufficientAnswer([]);
      send(res, { type: 'token', text: answer });
    } else if (!sufficiency) {
      answer = buildInsufficientAnswer(sections);
      send(res, { type: 'token', text: answer });
    } else {
      const llmConfig = llmConfigId ? resolveLlmRuntimeConfig({ llmConfigId, model }) : null;
      if (llmConfigId && !llmConfig) {
        throw new Error('所选 LLM 配置不存在');
      }
      const promptController = createKnowledgePromptController({
        query,
        effectiveQuery,
        conversationHistory,
        knowledgeContext,
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
    });
    touchConversation(conversation.id);
    send(res, {
      type: 'done',
      conversation_id: conversation.id,
      message_id: messageId,
      usage,
      budget,
      compacted,
    });
  } catch (error) {
    send(res, {
      type: 'error',
      error: error.message,
      conversation_id: conversation?.id || null,
    });
  }

  return res.end();
}
