const crypto = require('crypto');
const { completeChat } = require('./llm');
const {
  estimateChatRequestTokens,
  resolveLlmBudget,
  trimTextToTokenBudget,
} = require('./llmBudget');
const { buildKnowledgeRerankPrompt } = require('./prompt');
const {
  buildKnowledgeHelperCacheKey,
  readKnowledgeHelperCache,
  writeKnowledgeHelperCache,
} = require('./knowledgeHelperCache');

function hashHistory(history = []) {
  const source = JSON.stringify(
    (Array.isArray(history) ? history : []).map((item) => ({
      role: item?.role || '',
      content: String(item?.content || ''),
    }))
  );
  return crypto.createHash('sha1').update(source).digest('hex');
}

function buildKnowledgeHelperContext(input = {}) {
  return {
    conversation_id: Number(input.conversationId || 0) || 0,
    query: String(input.query || '').trim(),
    active_file_id: Number(input.activeFileId || 0) || 0,
    reference_mode: String(input.referenceMode || 'auto').trim() || 'auto',
    reference_file_ids: Array.isArray(input.referenceFileIds)
      ? input.referenceFileIds.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)
      : [],
    history_hash: hashHistory(input.history || []),
  };
}

function isPromptNearCompactionThreshold(messages = [], config = null, options = {}) {
  if (!config) return false;
  const budget = resolveLlmBudget(config, options.taskType || 'knowledge_answer', {
    model: options.model,
  });
  const estimated = estimateChatRequestTokens({ messages });
  return estimated >= Math.floor(budget.compactTriggerTokens * Number(options.ratio || 0.92));
}

function countDistinctFiles(sections = []) {
  return new Set(
    (Array.isArray(sections) ? sections : [])
      .map((section) => Number(section?.file_id || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
  ).size;
}

function normalizeRerankSections(sections = []) {
  return (Array.isArray(sections) ? sections : [])
    .slice(0, 8)
    .map((section) => ({
      key: String(section.key || ''),
      file_id: Number(section.file_id || 0) || 0,
      file_title: section.file_title || section.file_path || '未命名文档',
      file_path: section.file_path || '',
      heading_path: trimTextToTokenBudget(section.heading_path || '', 48, ' …'),
      preview: trimTextToTokenBudget(section.preview || section.content || '', 80),
      evidence_sentences: (Array.isArray(section.evidence_sentences) ? section.evidence_sentences : [])
        .slice(0, 3)
        .map((sentence) => trimTextToTokenBudget(sentence, 40, ' …')),
      score: Number(section.score || 0),
    }))
    .filter((section) => section.key);
}

function buildConflictSummary(sections = []) {
  const groups = new Map();
  (Array.isArray(sections) ? sections : []).forEach((section) => {
    const group = String(section?.conflict_group || '').trim();
    if (!group) return;
    const current = groups.get(group) || [];
    current.push(section);
    groups.set(group, current);
  });

  for (const entries of groups.values()) {
    const strong = entries.filter((section) => Number(section?.evidence_strength || 0) >= 0.72);
    const fileCount = new Set(strong.map((section) => Number(section.file_id || 0)).filter((item) => item > 0)).size;
    if (strong.length >= 2 && fileCount >= 2) {
      return strong
        .slice(0, 2)
        .map((section) => `《${section.file_title || section.file_path}》${section.heading_path ? ` ${section.heading_path}` : ''}`)
        .join('；');
    }
  }

  return '';
}

function buildWeakEvidenceReason(knowledgeContext = {}) {
  const sections = Array.isArray(knowledgeContext.sections) ? knowledgeContext.sections : [];
  const matchedFiles = Array.isArray(knowledgeContext.matched_files) ? knowledgeContext.matched_files : [];
  if (sections.length === 0 && matchedFiles.length > 0) {
    return '只定位到候选文档标题或路径，正文证据偏弱';
  }
  if (sections.length === 0) {
    return '相关正文证据不足';
  }
  if (Number(knowledgeContext?.stats?.best_score || 0) < 0.03) {
    return '检索结果相关性偏弱';
  }
  if (countDistinctFiles(sections) >= 3) {
    return '证据分散在多篇文档中，结论还不够稳定';
  }
  return '现有证据只能支持部分结论';
}

function buildNoEvidenceAnswer(sections = [], matchedFiles = []) {
  const evidence = sections.length > 0
    ? sections
      .slice(0, 3)
      .map((section) => `- 《${section.file_title}》${section.heading_path ? ` ${section.heading_path}` : ''}`)
      .join('\n')
    : '';
  const matchedFileText = matchedFiles.length > 0
    ? matchedFiles
      .slice(0, 3)
      .map((item) => `- 《${item.file_title || item.file_path}》`)
      .join('\n')
    : '';

  if (!evidence && !matchedFileText) {
    return '不知道。笔记里没有找到足够相关的内容，暂时没法可靠回答这个问题。';
  }

  if (!evidence && matchedFileText) {
    return `我已经定位到可能相关的文档，但正文证据还不够强，暂时没法可靠回答。\n\n比较接近的文档有：\n${matchedFileText}`;
  }

  return `我现在没法可靠回答这个问题。现有笔记里只找到少量相关线索，证据还不够充分。\n\n比较接近的内容有：\n${evidence}`;
}

function buildClarifyResponse(queryPlan = {}) {
  return String(queryPlan?.clarify_question || '').trim()
    || '你想问的对象、范围或时间还不够明确，能再具体一点吗？';
}

function shouldTriggerKnowledgeRerank(queryPlan = {}, knowledgeContext = {}) {
  const sections = Array.isArray(knowledgeContext.sections) ? knowledgeContext.sections : [];
  if (sections.length < 2) return false;
  const topScore = Number(sections[0]?.score || 0);
  const secondScore = Number(sections[1]?.score || 0);
  const gap = topScore - secondScore;
  if (['summary', 'comparison', 'follow_up'].includes(String(queryPlan.intent || ''))) return true;
  if (gap < 0.03) return true;
  if (countDistinctFiles(sections.slice(0, 5)) >= 3) return true;
  if (!knowledgeContext.sufficiency && sections.length > 0) return true;
  return false;
}

function mergeRerankedSections(originalSections = [], rankedSections = []) {
  const originalMap = new Map((Array.isArray(originalSections) ? originalSections : []).map((section) => [section.key, section]));
  const reranked = [];

  (Array.isArray(rankedSections) ? rankedSections : []).forEach((section) => {
    const original = originalMap.get(section.key);
    if (!original) return;
    reranked.push({
      ...original,
      relevance_score: Number(section.relevance_score || 0),
      evidence_strength: Number(section.evidence_strength || 0),
      conflict_group: String(section.conflict_group || '').trim(),
      rerank_reason: String(section.reason || '').trim(),
    });
    originalMap.delete(section.key);
  });

  const remaining = [...originalMap.values()].map((section) => ({
    ...section,
    relevance_score: Number(section.relevance_score || 0),
    evidence_strength: Number(section.evidence_strength || 0),
    conflict_group: String(section.conflict_group || '').trim(),
  }));

  return [...reranked, ...remaining];
}

function normalizeRerankResponse(parsed = {}) {
  const sectionItems = Array.isArray(parsed.sections)
    ? parsed.sections
      .map((section) => ({
        key: String(section?.key || '').trim(),
        relevance_score: Number(section?.relevance_score || 0),
        evidence_strength: Number(section?.evidence_strength || 0),
        conflict_group: String(section?.conflict_group || '').trim(),
        reason: String(section?.reason || '').trim(),
      }))
      .filter((section) => section.key)
    : [];

  if (sectionItems.length > 0) {
    return sectionItems;
  }

  return (Array.isArray(parsed.ranked_section_keys) ? parsed.ranked_section_keys : [])
    .map((key, index) => ({
      key: String(key || '').trim(),
      relevance_score: Math.max(0, 1 - (index * 0.08)),
      evidence_strength: 0,
      conflict_group: '',
      reason: '',
    }))
    .filter((section) => section.key);
}

async function maybeRerankKnowledgeSections({
  query,
  queryPlan,
  knowledgeContext,
  llmConfig,
  model,
  history = [],
  cacheContext = {},
  logger = null,
} = {}) {
  const normalizedSections = normalizeRerankSections(knowledgeContext?.sections || []);
  if (normalizedSections.length < 2 || !llmConfig) {
    return {
      sections: knowledgeContext?.sections || [],
      rerank_applied: false,
      helper_call_triggered: false,
      helper_call_cache_hit: false,
      helper_call_failed: false,
      fallback_reason: normalizedSections.length < 2 ? 'insufficient_sections' : 'llm_unavailable',
      helper_call_type: 'rerank',
    };
  }

  const cacheKey = buildKnowledgeHelperCacheKey('knowledge_rerank', {
    ...cacheContext,
    query: String(query || '').trim(),
    intent: queryPlan?.intent || 'fact',
    sections: normalizedSections.map((section) => ({
      key: section.key,
      score: section.score,
      preview: section.preview,
      evidence_sentences: section.evidence_sentences,
    })),
  });
  const cached = readKnowledgeHelperCache(cacheKey);
  if (cached) {
    return {
      sections: mergeRerankedSections(knowledgeContext.sections, cached.sections),
      rerank_applied: true,
      helper_call_triggered: true,
      helper_call_cache_hit: true,
      helper_call_failed: false,
      fallback_reason: '',
      helper_call_type: 'rerank',
      raw: cached,
      helper_call_latency_ms: 0,
    };
  }

  const messages = buildKnowledgeRerankPrompt(query, normalizedSections, { history });
  const startedAt = Date.now();

  try {
    const reply = await completeChat(messages, {
      responseFormat: { type: 'json_object' },
      taskType: 'knowledge_rerank',
      temperature: 0,
      maxOutputTokens: 256,
      config: llmConfig,
      model,
    });
    const parsed = JSON.parse(reply.message?.content || '{}');
    const rankedSections = normalizeRerankResponse(parsed);
    if (rankedSections.length === 0) {
      return {
        sections: knowledgeContext.sections,
        rerank_applied: false,
        helper_call_triggered: true,
        helper_call_cache_hit: false,
        helper_call_failed: true,
        fallback_reason: 'invalid_rerank_response',
        helper_call_type: 'rerank',
        helper_call_latency_ms: Date.now() - startedAt,
      };
    }

    writeKnowledgeHelperCache(cacheKey, {
      sections: rankedSections,
      ranked_section_keys: parsed.ranked_section_keys || rankedSections.map((section) => section.key),
    });

    return {
      sections: mergeRerankedSections(knowledgeContext.sections, rankedSections),
      rerank_applied: true,
      helper_call_triggered: true,
      helper_call_cache_hit: false,
      helper_call_failed: false,
      fallback_reason: '',
      helper_call_type: 'rerank',
      raw: parsed,
      helper_call_latency_ms: Date.now() - startedAt,
    };
  } catch (error) {
    if (logger) {
      logger.warn('chat.helper.rerank_failed', {
        error,
        helper_call_type: 'rerank',
      });
    }
    return {
      sections: knowledgeContext.sections,
      rerank_applied: false,
      helper_call_triggered: true,
      helper_call_cache_hit: false,
      helper_call_failed: true,
      fallback_reason: 'rerank_request_failed',
      helper_call_type: 'rerank',
      helper_call_latency_ms: Date.now() - startedAt,
    };
  }
}

function decideKnowledgeAnswerMode({
  queryPlan,
  knowledgeContext,
  features = {},
  rerankResult = null,
} = {}) {
  const sections = Array.isArray(knowledgeContext?.sections) ? knowledgeContext.sections : [];
  const matchedFiles = Array.isArray(knowledgeContext?.matched_files) ? knowledgeContext.matched_files : [];
  const conflictSummary = features.enableConflictMode ? buildConflictSummary(sections) : '';

  if (features.enableClarify && queryPlan?.clarify_needed) {
    return {
      answer_mode: 'clarify_needed',
      confidence: 0.12,
      weak_evidence_reason: '',
      conflict_summary: '',
    };
  }

  if (features.enableConflictMode && conflictSummary) {
    return {
      answer_mode: 'conflicting_evidence',
      confidence: 0.58,
      weak_evidence_reason: '',
      conflict_summary: conflictSummary,
    };
  }

  if (sections.length === 0) {
    return {
      answer_mode: 'no_evidence',
      confidence: matchedFiles.length > 0 ? 0.22 : 0.12,
      weak_evidence_reason: '',
      conflict_summary: '',
    };
  }

  if (!knowledgeContext?.sufficiency) {
    if (features.enableWeakEvidenceSupplement === false) {
      return {
        answer_mode: 'no_evidence',
        confidence: matchedFiles.length > 0 ? 0.22 : 0.16,
        weak_evidence_reason: '',
        conflict_summary: '',
      };
    }
    return {
      answer_mode: 'weak_evidence',
      confidence: 0.44,
      weak_evidence_reason: buildWeakEvidenceReason(knowledgeContext),
      conflict_summary: '',
    };
  }

  const bestScore = Number(knowledgeContext?.stats?.best_score || sections[0]?.score || 0);
  const rerankBoost = rerankResult?.rerank_applied ? 0.04 : 0;
  return {
    answer_mode: 'grounded',
    confidence: Math.max(0.72, Math.min(0.95, 0.72 + (bestScore * 1.2) + rerankBoost)),
    weak_evidence_reason: '',
    conflict_summary: '',
  };
}

module.exports = {
  buildKnowledgeHelperContext,
  buildClarifyResponse,
  buildNoEvidenceAnswer,
  countDistinctFiles,
  decideKnowledgeAnswerMode,
  hashHistory,
  isPromptNearCompactionThreshold,
  maybeRerankKnowledgeSections,
  shouldTriggerKnowledgeRerank,
};
