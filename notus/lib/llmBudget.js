const DEFAULT_CONTEXT_WINDOW_TOKENS = 800000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

const TASK_OUTPUT_BUDGETS = {
  default: 8192,
  knowledge_answer: 8192,
  knowledge_query_plan: 1024,
  knowledge_rerank: 512,
  canvas_agent: 12288,
  operation_json: 4096,
  outline_json: 4096,
  canvas_intent: 512,
  canvas_query_plan: 768,
  canvas_text: 4096,
  canvas_analysis: 4096,
  style_fingerprint: 1024,
  style_profile: 1024,
  settings_test: 256,
};

const KNOWN_MODEL_BUDGETS = {
  'qwen3-max': { context_window_tokens: 262144, max_output_tokens: 32768 },
  'qwen3-max-2026-01-23': { context_window_tokens: 262144, max_output_tokens: 32768 },
};

function normalizePositiveInt(value, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return fallback;
  return Math.max(1, Math.floor(next));
}

function normalizeModelName(model) {
  return String(model || '').trim().toLowerCase();
}

function getKnownModelBudget(model) {
  const normalized = normalizeModelName(model);
  if (!normalized) return null;
  if (KNOWN_MODEL_BUDGETS[normalized]) return KNOWN_MODEL_BUDGETS[normalized];
  if (normalized.startsWith('qwen3-max')) return KNOWN_MODEL_BUDGETS['qwen3-max'];
  return null;
}

function deriveLlmConfigBudgetFields(input = {}) {
  const known = getKnownModelBudget(input.model);
  const contextWindow = normalizePositiveInt(
    input.context_window_tokens,
    known?.context_window_tokens || DEFAULT_CONTEXT_WINDOW_TOKENS
  );
  const configuredMaxOutput = normalizePositiveInt(
    input.max_output_tokens,
    known?.max_output_tokens || DEFAULT_MAX_OUTPUT_TOKENS
  );
  const maxOutputTokens = Math.min(
    configuredMaxOutput,
    Math.max(256, contextWindow - 1024)
  );

  return {
    context_window_tokens: contextWindow,
    max_output_tokens: maxOutputTokens,
  };
}

function resolveTaskOutputTokens(taskType, configuredMaxOutput) {
  const taskBudget = TASK_OUTPUT_BUDGETS[taskType] || TASK_OUTPUT_BUDGETS.default;
  return Math.max(256, Math.min(configuredMaxOutput, taskBudget));
}

function resolveLlmBudget(config = {}, taskType = 'default', options = {}) {
  const model = String(options.model || config.llmModel || '').trim();
  const derived = deriveLlmConfigBudgetFields({
    model,
    context_window_tokens: options.contextWindowTokens ?? config.llmContextWindowTokens,
    max_output_tokens: options.configuredMaxOutputTokens ?? config.llmMaxOutputTokens,
  });
  const configuredMaxOutputTokens = derived.max_output_tokens;
  const maxOutputTokens = normalizePositiveInt(
    options.maxOutputTokens,
    resolveTaskOutputTokens(taskType, configuredMaxOutputTokens)
  );
  const safetyMarginTokens = Math.min(
    Math.max(Math.round(derived.context_window_tokens * 0.02), 2048),
    8192
  );
  const hardInputBudgetTokens = Math.max(
    2048,
    derived.context_window_tokens - maxOutputTokens - safetyMarginTokens
  );

  return {
    taskType,
    model,
    contextWindowTokens: derived.context_window_tokens,
    configuredMaxOutputTokens,
    maxOutputTokens,
    safetyMarginTokens,
    hardInputBudgetTokens,
    compactTriggerTokens: Math.max(1024, Math.floor(hardInputBudgetTokens * 0.85)),
  };
}

function estimateTextTokens(input = '') {
  const text = String(input || '');
  if (!text) return 0;
  const cjkMatches = text.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || [];
  const cjkCount = cjkMatches.length;
  const asciiMatches = text.match(/[A-Za-z0-9]/g) || [];
  const asciiCount = asciiMatches.length;
  const whitespaceMatches = text.match(/\s/g) || [];
  const whitespaceCount = whitespaceMatches.length;
  const otherCount = Math.max(0, text.length - cjkCount - asciiCount - whitespaceCount);

  const estimate = (cjkCount * 1.15)
    + (asciiCount / 3.1)
    + (otherCount / 1.4)
    + (whitespaceCount / 12)
    + 4;

  return Math.max(1, Math.ceil(estimate));
}

function estimateMessagesTokens(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  return messages.reduce((total, message) => {
    const role = String(message?.role || '');
    const name = String(message?.name || '');
    const toolCalls = message?.tool_calls ? JSON.stringify(message.tool_calls) : '';
    const content = typeof message?.content === 'string'
      ? message.content
      : JSON.stringify(message?.content || '');

    return total
      + 10
      + estimateTextTokens(role)
      + estimateTextTokens(name)
      + estimateTextTokens(content)
      + estimateTextTokens(toolCalls);
  }, 0) + 6;
}

function estimateToolsTokens(tools = null) {
  if (!tools) return 0;
  return estimateTextTokens(JSON.stringify(tools)) + 12;
}

function estimateChatRequestTokens({ messages = [], tools = null, responseFormat = null } = {}) {
  return estimateMessagesTokens(messages)
    + estimateToolsTokens(tools)
    + (responseFormat ? estimateTextTokens(JSON.stringify(responseFormat)) + 6 : 0);
}

function trimTextToTokenBudget(input = '', maxTokens, suffix = '\n[已按上下文预算截断]') {
  const text = String(input || '');
  const budget = normalizePositiveInt(maxTokens, 0);
  if (!text || !budget) return '';

  const estimated = estimateTextTokens(text);
  if (estimated <= budget) return text;

  const ratio = Math.max(0.1, Math.min(0.95, budget / Math.max(estimated, 1)));
  const charBudget = Math.max(80, Math.floor(text.length * ratio));
  const headChars = Math.max(40, Math.floor(charBudget * 0.72));
  const tailChars = Math.max(0, charBudget - headChars);

  if (tailChars < 32) {
    return `${text.slice(0, headChars)}${suffix}`;
  }

  return `${text.slice(0, headChars)}${suffix}\n...\n${text.slice(-tailChars)}`;
}

function normalizeUsage(usage = null) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.prompt_tokens);
  const completionTokens = Number(usage.completion_tokens);
  const totalTokens = Number(usage.total_tokens);

  return {
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    total_tokens: Number.isFinite(totalTokens)
      ? totalTokens
      : Math.max(0, (Number.isFinite(promptTokens) ? promptTokens : 0) + (Number.isFinite(completionTokens) ? completionTokens : 0)),
  };
}

function sumUsageRecords(records = []) {
  return records.reduce((acc, item) => {
    const usage = normalizeUsage(item);
    if (!usage) return acc;
    acc.prompt_tokens += usage.prompt_tokens;
    acc.completion_tokens += usage.completion_tokens;
    acc.total_tokens += usage.total_tokens;
    return acc;
  }, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
}

function compactMessageWindow(messages = [], targetTokens) {
  const list = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
  if (list.length === 0) return [];

  const systemMessages = list.filter((message) => message.role === 'system');
  const nonSystemMessages = list.filter((message) => message.role !== 'system');
  const keep = [];
  const tokenBudget = Math.max(256, normalizePositiveInt(targetTokens, 1024));

  for (let index = nonSystemMessages.length - 1; index >= 0; index -= 1) {
    const next = [nonSystemMessages[index], ...keep];
    if (estimateMessagesTokens([...systemMessages, ...next]) <= tokenBudget) {
      keep.unshift(nonSystemMessages[index]);
    }
  }

  const fallback = [...systemMessages, ...keep];
  if (estimateMessagesTokens(fallback) <= tokenBudget) {
    return fallback;
  }

  const lastMessage = keep[keep.length - 1] || nonSystemMessages[nonSystemMessages.length - 1];
  if (!lastMessage) return systemMessages;

  const remaining = Math.max(128, tokenBudget - estimateMessagesTokens(systemMessages) - 24);
  const compactedLast = {
    ...lastMessage,
    content: trimTextToTokenBudget(lastMessage.content || '', remaining),
  };

  return [...systemMessages, compactedLast];
}

function parseOverflowBody(body = '') {
  const text = String(body || '');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isContextOverflowError(status, body = '') {
  if (Number(status) !== 400) return false;
  const parsed = parseOverflowBody(body);
  const values = [
    body,
    parsed?.error?.message,
    parsed?.message,
    parsed?.error?.code,
    parsed?.code,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return [
    'maximum context length',
    'context_length_exceeded',
    'range of input length should be',
    'input length',
    'token limit',
    'context window',
    'prompt is too long',
  ].some((pattern) => values.includes(pattern));
}

module.exports = {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  TASK_OUTPUT_BUDGETS,
  KNOWN_MODEL_BUDGETS,
  deriveLlmConfigBudgetFields,
  resolveLlmBudget,
  estimateTextTokens,
  estimateMessagesTokens,
  estimateChatRequestTokens,
  trimTextToTokenBudget,
  normalizeUsage,
  sumUsageRecords,
  compactMessageWindow,
  isContextOverflowError,
  getKnownModelBudget,
};
