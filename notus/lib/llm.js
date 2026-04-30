const { getEffectiveConfig } = require('./config');
const { createAppError } = require('./errors');
const {
  compactMessageWindow,
  estimateChatRequestTokens,
  isContextOverflowError,
  normalizeUsage,
  resolveLlmBudget,
} = require('./llmBudget');

function resolveLlmConfig(override = null) {
  const config = { ...getEffectiveConfig(), ...(override || {}) };
  if (!config.llmApiKey) throw createAppError('LLM_API_KEY_MISSING', 'LLM API Key 未配置');
  if (!config.llmBaseUrl) throw createAppError('LLM_BASE_URL_MISSING', 'LLM Base URL 未配置');
  if (!config.llmModel) throw createAppError('LLM_MODEL_MISSING', 'LLM 模型未配置');
  return config;
}

async function readErrorPayload(response) {
  const body = await response.text();
  return {
    body,
    message: `LLM API ${response.status}: ${body}`,
  };
}

function buildBudgetPayload(budget, estimatedPromptTokens, retryCount) {
  return {
    task_type: budget.taskType,
    model: budget.model,
    context_window_tokens: budget.contextWindowTokens,
    configured_max_output_tokens: budget.configuredMaxOutputTokens,
    max_output_tokens: budget.maxOutputTokens,
    safety_margin_tokens: budget.safetyMarginTokens,
    compact_trigger_tokens: budget.compactTriggerTokens,
    hard_input_budget_tokens: budget.hardInputBudgetTokens,
    estimated_prompt_tokens: estimatedPromptTokens,
    retry_count: retryCount,
  };
}

async function applyCompaction({
  compact,
  messages,
  tools,
  responseFormat,
  budget,
  mode,
}) {
  let next = null;

  if (typeof compact === 'function') {
    next = await compact({
      messages,
      tools,
      responseFormat,
      budget,
      mode,
    });
  }

  if (!next) {
    const fallbackMessages = compactMessageWindow(messages, budget.compactTriggerTokens);
    const before = JSON.stringify(messages);
    const after = JSON.stringify(fallbackMessages);
    if (after && after !== before) {
      next = { messages: fallbackMessages };
    }
  }

  if (!next?.messages) return null;
  const before = JSON.stringify(messages);
  const after = JSON.stringify(next.messages);
  const toolBefore = JSON.stringify(tools || null);
  const toolAfter = JSON.stringify(next.tools === undefined ? tools || null : next.tools || null);

  if (before === after && toolBefore === toolAfter) return null;
  return {
    messages: next.messages,
    tools: next.tools === undefined ? tools : next.tools,
    meta: next.meta || null,
  };
}

function parseSseChunk(chunk, handlers = {}) {
  const lines = chunk.split('\n');
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const payload = JSON.parse(data);
      const text = payload.choices?.[0]?.delta?.content || '';
      if (text && handlers.onDelta) handlers.onDelta(text);
      if (payload.usage && handlers.onUsage) {
        handlers.onUsage(payload.usage);
      }
    } catch {
      // Ignore malformed provider keep-alive chunks.
    }
  });
}

function buildHeaders(config) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.llmApiKey}`,
  };
}

function buildBaseRequestBody(messages, options, budget, config) {
  const body = {
    model: options.model || config.llmModel,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: budget.maxOutputTokens,
  };
  if (options.tools) body.tools = options.tools;
  if (options.responseFormat) body.response_format = options.responseFormat;
  return body;
}

async function completeChat(messages, options = {}) {
  const {
    tools,
    model,
    responseFormat,
    temperature = 0.2,
    config: override,
    taskType = 'default',
    maxOutputTokens,
    compact,
    maxRetries = 1,
    onUsage,
  } = options;

  const config = resolveLlmConfig(override);
  const budget = resolveLlmBudget(config, taskType, { model, maxOutputTokens });
  let currentMessages = Array.isArray(messages) ? messages : [];
  let currentTools = tools || null;
  let estimatedPromptTokens = estimateChatRequestTokens({
    messages: currentMessages,
    tools: currentTools,
    responseFormat,
  });
  let compacted = false;
  let retryCount = 0;

  if (estimatedPromptTokens > budget.compactTriggerTokens) {
    const compactedRequest = await applyCompaction({
      compact,
      messages: currentMessages,
      tools: currentTools,
      responseFormat,
      budget,
      mode: 'soft',
    });
    if (compactedRequest) {
      currentMessages = compactedRequest.messages;
      currentTools = compactedRequest.tools;
      compacted = true;
      estimatedPromptTokens = estimateChatRequestTokens({
        messages: currentMessages,
        tools: currentTools,
        responseFormat,
      });
    }
  }

  while (true) {
    const response = await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(buildBaseRequestBody(currentMessages, {
        model,
        tools: currentTools,
        responseFormat,
        temperature,
      }, budget, config)),
    });

    if (!response.ok) {
      const errorPayload = await readErrorPayload(response);
      const overflow = isContextOverflowError(response.status, errorPayload.body);
      if (overflow && retryCount < maxRetries) {
        const compactedRequest = await applyCompaction({
          compact,
          messages: currentMessages,
          tools: currentTools,
          responseFormat,
          budget,
          mode: 'hard',
        });
        if (compactedRequest) {
          currentMessages = compactedRequest.messages;
          currentTools = compactedRequest.tools;
          compacted = true;
          retryCount += 1;
          estimatedPromptTokens = estimateChatRequestTokens({
            messages: currentMessages,
            tools: currentTools,
            responseFormat,
          });
          continue;
        }
      }

      throw createAppError('LLM_API_ERROR', errorPayload.message, {
        status: response.status,
        response_body: errorPayload.body,
        overflow,
        budget: buildBudgetPayload(budget, estimatedPromptTokens, retryCount),
      });
    }

    const payload = await response.json();
    const usage = normalizeUsage(payload.usage);
    if (usage && typeof onUsage === 'function') onUsage(usage);
    return {
      message: payload.choices?.[0]?.message || { role: 'assistant', content: '' },
      usage,
      budget: buildBudgetPayload(budget, estimatedPromptTokens, retryCount),
      compacted,
    };
  }
}

async function streamChat(messages, options = {}) {
  const {
    model,
    temperature = 0.2,
    config: override,
    onToken,
    onUsage,
    taskType = 'default',
    maxOutputTokens,
    compact,
    maxRetries = 1,
  } = options;

  const config = resolveLlmConfig(override);
  const budget = resolveLlmBudget(config, taskType, { model, maxOutputTokens });
  let currentMessages = Array.isArray(messages) ? messages : [];
  let estimatedPromptTokens = estimateChatRequestTokens({ messages: currentMessages });
  let compacted = false;
  let retryCount = 0;

  if (estimatedPromptTokens > budget.compactTriggerTokens) {
    const compactedRequest = await applyCompaction({
      compact,
      messages: currentMessages,
      tools: null,
      responseFormat: null,
      budget,
      mode: 'soft',
    });
    if (compactedRequest) {
      currentMessages = compactedRequest.messages;
      compacted = true;
      estimatedPromptTokens = estimateChatRequestTokens({ messages: currentMessages });
    }
  }

  while (true) {
    const response = await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        ...buildBaseRequestBody(currentMessages, { model, temperature }, budget, config),
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    if (!response.ok) {
      const errorPayload = await readErrorPayload(response);
      const overflow = isContextOverflowError(response.status, errorPayload.body);
      if (overflow && retryCount < maxRetries) {
        const compactedRequest = await applyCompaction({
          compact,
          messages: currentMessages,
          tools: null,
          responseFormat: null,
          budget,
          mode: 'hard',
        });
        if (compactedRequest) {
          currentMessages = compactedRequest.messages;
          compacted = true;
          retryCount += 1;
          estimatedPromptTokens = estimateChatRequestTokens({ messages: currentMessages });
          continue;
        }
      }

      throw createAppError('LLM_API_ERROR', errorPayload.message, {
        status: response.status,
        response_body: errorPayload.body,
        overflow,
        budget: buildBudgetPayload(budget, estimatedPromptTokens, retryCount),
      });
    }

    if (!response.body) throw createAppError('LLM_STREAM_MISSING', 'LLM API 未返回可读取的流');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let pending = '';
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const parts = pending.split('\n\n');
      pending = parts.pop() || '';
      parts.forEach((part) => {
        parseSseChunk(part, {
          onDelta: (text) => {
            fullText += text;
            if (typeof onToken === 'function') onToken(text);
          },
          onUsage: (nextUsage) => {
            usage = normalizeUsage(nextUsage);
            if (usage && typeof onUsage === 'function') onUsage(usage);
          },
        });
      });
    }

    if (pending) {
      parseSseChunk(pending, {
        onDelta: (text) => {
          fullText += text;
          if (typeof onToken === 'function') onToken(text);
        },
        onUsage: (nextUsage) => {
          usage = normalizeUsage(nextUsage);
          if (usage && typeof onUsage === 'function') onUsage(usage);
        },
      });
    }

    return {
      text: fullText,
      usage,
      budget: buildBudgetPayload(budget, estimatedPromptTokens, retryCount),
      compacted,
    };
  }
}

module.exports = {
  completeChat,
  streamChat,
};
