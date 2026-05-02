const { completeChat } = require('./llm');
const { trimTextToTokenBudget } = require('./llmBudget');
const { buildKnowledgeQueryPlanPrompt } = require('./prompt');
const { segmentText } = require('./tokenizer');
const {
  buildKnowledgeHelperCacheKey,
  readKnowledgeHelperCache,
  writeKnowledgeHelperCache,
} = require('./knowledgeHelperCache');

const PLAN_INTENTS = new Set(['follow_up', 'summary', 'comparison', 'procedure', 'fact']);
const REWRITE_INTENTS = new Set(['follow_up', 'summary', 'comparison']);

function normalizeHistory(history = [], limit = 6) {
  return (Array.isArray(history) ? history : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => ({
      role: message.role,
      content: String(message.content || '').trim(),
    }))
    .filter((message) => message.content)
    .slice(-Math.max(0, limit));
}

function normalizeIntent(intent, fallback = 'fact') {
  const normalized = String(intent || '').trim().toLowerCase();
  return PLAN_INTENTS.has(normalized) ? normalized : fallback;
}

function uniqueStrings(values = [], limit = 8) {
  const seen = new Set();
  const items = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(normalized);
  });
  return items.slice(0, Math.max(0, limit));
}

function isLikelyFollowUpQuery(query) {
  const text = String(query || '').trim();
  if (!text) return false;
  if (text.length <= 12) return true;
  if (/^(继续|展开|补充|详细|具体|然后|还有|那|呢|为什么|怎么|如何|说下|讲下)/.test(text)) return true;
  if (/(这个|这个问题|这个结论|这个观点|上一条|刚才|前面|上述|第二种|第一种|第三种|这种|那种|它|他|她|其|上面)/.test(text)) {
    return true;
  }
  return false;
}

function inferIntent(query) {
  const text = String(query || '').trim();
  if (/^(继续|展开|补充|详细|具体|那|呢|还有|然后)/.test(text)) return 'follow_up';
  if (/(总结|归纳|梳理|汇总|概括)/.test(text)) return 'summary';
  if (/(对比|比较|区别|差异|优缺点)/.test(text)) return 'comparison';
  if (/(如何|怎么|步骤|部署|配置|安装|接入|实现)/.test(text)) return 'procedure';
  return 'fact';
}

function buildTitleHints(query, history = []) {
  const values = [];
  const normalizedQuery = String(query || '').trim();
  const strippedQuery = normalizedQuery
    .replace(/^(请问|请|帮我|麻烦|可以|能否)\s*/g, '')
    .replace(/^(如何|怎么|怎样|详细介绍一下|介绍一下|说说|讲讲|总结一下|总结|对比一下|比较一下|展开讲讲)\s*/g, '')
    .replace(/[？?！!。,.，]/g, ' ')
    .trim();

  if (strippedQuery) values.push(strippedQuery);

  const previousUsers = normalizeHistory(history)
    .filter((message) => message.role === 'user')
    .slice(-2)
    .map((message) => trimTextToTokenBudget(message.content, 40, ' ...'));

  values.push(...previousUsers);
  return uniqueStrings(values, 4);
}

function buildKeywordHints(query, standaloneQuery = '', history = []) {
  const sources = [
    String(query || ''),
    String(standaloneQuery || ''),
    ...normalizeHistory(history, 4).map((message) => (message.role === 'user' ? message.content : '')),
  ].filter(Boolean);

  const tokens = sources.flatMap((source) => segmentText(source, 16));
  return uniqueStrings(
    tokens.filter((token) => token.length > 1 || /[a-z0-9]/i.test(token)),
    8
  );
}

function buildExpandedQuery(intent, standaloneQuery, keywords = []) {
  const keywordText = uniqueStrings(keywords, 4).join('、');
  if (!standaloneQuery) return '';

  if (intent === 'procedure') {
    return keywordText
      ? `${standaloneQuery}\n重点关注部署步骤、前置条件、配置项、依赖关系和注意事项，尤其是：${keywordText}`
      : `${standaloneQuery}\n重点关注部署步骤、前置条件、配置项、依赖关系和注意事项。`;
  }
  if (intent === 'comparison') {
    return keywordText
      ? `${standaloneQuery}\n重点关注差异点、适用场景、优缺点和决策依据，尤其是：${keywordText}`
      : `${standaloneQuery}\n重点关注差异点、适用场景、优缺点和决策依据。`;
  }
  if (intent === 'summary') {
    return keywordText
      ? `${standaloneQuery}\n重点关注核心观点、结构脉络和关键结论，尤其是：${keywordText}`
      : `${standaloneQuery}\n重点关注核心观点、结构脉络和关键结论。`;
  }
  return keywordText
    ? `${standaloneQuery}\n相关关键词：${keywordText}`
    : standaloneQuery;
}

function extractHistoryChoices(history = []) {
  return uniqueStrings(
    normalizeHistory(history)
      .filter((message) => message.role === 'user')
      .slice(-2)
      .map((message) => message.content.replace(/[？?！!。]/g, ' ').trim())
      .map((message) => trimTextToTokenBudget(message, 24, ' …')),
    2
  );
}

function buildAmbiguityFlags(query, intent, history = []) {
  const text = String(query || '').trim();
  const flags = [];
  const tokens = segmentText(text, 16);
  const hasHistory = normalizeHistory(history).length > 0;

  if (!text) flags.push('empty_query');
  if (text.length <= 4) flags.push('too_short');
  if (/(这个|那个|它|他|她|这篇|这条|这段|那篇|那条|上面|前面|刚才|上述)/.test(text)) {
    flags.push('pronoun_reference');
    if (!hasHistory) flags.push('missing_subject');
  }
  if (intent === 'summary' && tokens.length <= 2) flags.push('broad_scope');
  if (intent === 'comparison' && !/(和|与|跟|vs|对比|比较)/i.test(text)) flags.push('missing_counterpart');
  if (tokens.length <= 1) flags.push('missing_subject');
  return uniqueStrings(flags, 6);
}

function computeClarityScore(query, intent, history = [], ambiguityFlags = []) {
  const text = String(query || '').trim();
  const normalizedHistory = normalizeHistory(history);
  let score = text ? 0.88 : 0.12;

  if (ambiguityFlags.includes('too_short')) score -= 0.22;
  if (ambiguityFlags.includes('pronoun_reference')) score -= normalizedHistory.length > 0 ? 0.12 : 0.24;
  if (ambiguityFlags.includes('missing_subject')) score -= 0.18;
  if (ambiguityFlags.includes('broad_scope')) score -= 0.14;
  if (ambiguityFlags.includes('missing_counterpart')) score -= 0.14;
  if (intent === 'follow_up' && normalizedHistory.length > 0) score += 0.1;
  if (text.length >= 24) score += 0.04;

  return Math.max(0.1, Math.min(0.95, Number(score.toFixed(2))));
}

function canResolveFromHistory(intent, history = [], ambiguityFlags = []) {
  const normalizedHistory = normalizeHistory(history);
  if (normalizedHistory.length === 0) return false;
  if (intent === 'follow_up') return true;
  if (ambiguityFlags.includes('pronoun_reference')) return true;
  return false;
}

function buildClarifyQuestion(intent, ambiguityFlags = [], history = []) {
  const choices = extractHistoryChoices(history);
  if (choices.length === 2 && ambiguityFlags.includes('pronoun_reference')) {
    return `你指的是“${choices[0]}”还是“${choices[1]}”？`;
  }
  if (intent === 'comparison' || ambiguityFlags.includes('missing_counterpart')) {
    return '你想比较哪两个对象？请把双方都说清楚。';
  }
  if (intent === 'summary' || ambiguityFlags.includes('broad_scope')) {
    return '你想总结哪篇笔记、哪个主题，或者限定哪段时间？';
  }
  if (ambiguityFlags.includes('pronoun_reference') || ambiguityFlags.includes('missing_subject')) {
    return '你指的是哪篇笔记、哪条结论，或者刚才提到的哪个对象？';
  }
  return '你想问的对象、范围或时间还不够明确，能再具体一点吗？';
}

function buildRuleBasedPlan(query, history = [], options = {}) {
  const normalizedQuery = String(query || '').trim();
  const recentHistory = normalizeHistory(history);
  const followUp = isLikelyFollowUpQuery(normalizedQuery);
  const intent = followUp ? 'follow_up' : inferIntent(normalizedQuery);
  const previousUserMessages = recentHistory
    .filter((message) => message.role === 'user')
    .slice(-2)
    .map((message) => trimTextToTokenBudget(message.content, 60, ' ...'));
  const previousAssistant = recentHistory
    .filter((message) => message.role === 'assistant')
    .slice(-1)
    .map((message) => trimTextToTokenBudget(message.content, 90, ' ...'))[0] || '';

  const ambiguityFlags = buildAmbiguityFlags(normalizedQuery, intent, recentHistory);
  const clarityScore = computeClarityScore(normalizedQuery, intent, recentHistory, ambiguityFlags);
  const resolvableFromHistory = canResolveFromHistory(intent, recentHistory, ambiguityFlags);
  const enableClarify = options.enableClarify !== false;
  const clarifyNeeded = enableClarify && (
    clarityScore < 0.45
    || (clarityScore < 0.75 && !resolvableFromHistory && ambiguityFlags.length > 0)
  );

  let standaloneQuery = normalizedQuery;
  let rewriteStrategy = 'direct';
  if (followUp && resolvableFromHistory) {
    const contextParts = [];
    if (previousUserMessages.length > 0) {
      contextParts.push(`上一轮问题：${previousUserMessages[previousUserMessages.length - 1]}`);
    }
    if (previousAssistant) {
      contextParts.push(`上一轮回答要点：${previousAssistant}`);
    }
    if (contextParts.length > 0) {
      standaloneQuery = `${contextParts.join('\n')}\n当前追问：${normalizedQuery}`;
      rewriteStrategy = 'history_resolved';
    }
  }

  const keywords = buildKeywordHints(normalizedQuery, standaloneQuery, recentHistory);
  const titleHints = buildTitleHints(normalizedQuery, recentHistory);

  if (clarifyNeeded) {
    rewriteStrategy = 'clarify';
  }

  return {
    intent,
    is_follow_up: followUp,
    standalone_query: standaloneQuery,
    expanded_query: buildExpandedQuery(intent, standaloneQuery, keywords),
    keywords,
    title_hints: titleHints,
    used_llm: false,
    clarity_score: clarityScore,
    ambiguity_flags: ambiguityFlags,
    clarify_needed: clarifyNeeded,
    clarify_question: clarifyNeeded ? buildClarifyQuestion(intent, ambiguityFlags, recentHistory) : '',
    rewrite_strategy: rewriteStrategy,
    helper_call_type: '',
    helper_call_triggered: false,
    helper_call_cache_hit: false,
    helper_call_failed: false,
    helper_call_latency_ms: 0,
    fallback_reason: '',
  };
}

function normalizePlanShape(rawPlan = {}, fallbackPlan, model) {
  const normalizedStandalone = String(rawPlan.standalone_query || '').trim() || fallbackPlan.standalone_query;
  const normalizedKeywords = uniqueStrings(rawPlan.keywords, 8);
  const keywords = normalizedKeywords.length > 0 ? normalizedKeywords : fallbackPlan.keywords;
  const normalizedTitleHints = uniqueStrings(rawPlan.title_hints, 4);

  return {
    ...fallbackPlan,
    intent: normalizeIntent(rawPlan.intent, fallbackPlan.intent),
    is_follow_up: rawPlan.is_follow_up === undefined ? fallbackPlan.is_follow_up : Boolean(rawPlan.is_follow_up),
    standalone_query: normalizedStandalone,
    expanded_query: String(rawPlan.expanded_query || '').trim() || buildExpandedQuery(
      normalizeIntent(rawPlan.intent, fallbackPlan.intent),
      normalizedStandalone,
      keywords
    ),
    keywords,
    title_hints: normalizedTitleHints.length > 0 ? normalizedTitleHints : fallbackPlan.title_hints,
    used_llm: Boolean(model),
    model: model || '',
    rewrite_strategy: 'llm_rewrite',
  };
}

function shouldUseLlmRewrite(fallbackPlan, options = {}) {
  if (!options.allowLlmRewrite) return false;
  if (!options.llmConfig) return false;
  if (fallbackPlan.clarify_needed) return false;
  if (fallbackPlan.clarity_score < 0.45 || fallbackPlan.clarity_score >= 0.75) return false;
  if (!REWRITE_INTENTS.has(String(fallbackPlan.intent || ''))) return false;
  if (options.helperAlreadyUsed) return false;
  return fallbackPlan.rewrite_strategy === 'history_resolved'
    || fallbackPlan.ambiguity_flags.includes('pronoun_reference')
    || fallbackPlan.ambiguity_flags.includes('broad_scope');
}

async function buildKnowledgeQueryPlan({
  query,
  history = [],
  llmConfig = null,
  model,
  allowLlmRewrite = false,
  enableClarify = true,
  helperAlreadyUsed = false,
  cacheContext = {},
} = {}) {
  const fallbackPlan = buildRuleBasedPlan(query, history, { enableClarify });

  if (!shouldUseLlmRewrite(fallbackPlan, {
    allowLlmRewrite,
    llmConfig,
    helperAlreadyUsed,
  })) {
    return fallbackPlan;
  }

  const cacheKey = buildKnowledgeHelperCacheKey('knowledge_query_plan', {
    ...cacheContext,
    query: String(query || '').trim(),
    intent: fallbackPlan.intent,
    clarity_score: fallbackPlan.clarity_score,
    ambiguity_flags: fallbackPlan.ambiguity_flags,
  });
  const cached = readKnowledgeHelperCache(cacheKey);
  if (cached) {
    return {
      ...cached,
      helper_call_type: 'rewrite',
      helper_call_triggered: true,
      helper_call_cache_hit: true,
      helper_call_failed: false,
      helper_call_latency_ms: 0,
      fallback_reason: '',
    };
  }

  const startedAt = Date.now();
  try {
    const reply = await completeChat(buildKnowledgeQueryPlanPrompt(query, {
      history: normalizeHistory(history),
    }), {
      responseFormat: { type: 'json_object' },
      taskType: 'knowledge_query_plan',
      temperature: 0.1,
      maxOutputTokens: 256,
      config: llmConfig,
      model,
    });
    const parsed = JSON.parse(reply.message?.content || '{}');
    const nextPlan = normalizePlanShape(parsed, fallbackPlan, model || llmConfig.llmModel);
    writeKnowledgeHelperCache(cacheKey, nextPlan);
    return {
      ...nextPlan,
      helper_call_type: 'rewrite',
      helper_call_triggered: true,
      helper_call_cache_hit: false,
      helper_call_failed: false,
      helper_call_latency_ms: Date.now() - startedAt,
      fallback_reason: '',
    };
  } catch {
    return {
      ...fallbackPlan,
      helper_call_type: 'rewrite',
      helper_call_triggered: true,
      helper_call_cache_hit: false,
      helper_call_failed: true,
      helper_call_latency_ms: Date.now() - startedAt,
      fallback_reason: 'rewrite_request_failed',
    };
  }
}

module.exports = {
  buildKnowledgeQueryPlan,
  buildRuleBasedPlan,
  buildClarifyQuestion,
  computeClarityScore,
  inferIntent,
  isLikelyFollowUpQuery,
  normalizeHistory,
};
