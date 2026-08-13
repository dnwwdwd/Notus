const { getEffectiveConfig } = require('./config');
const { buildAnthropicCompatibleAuthHeaders, normalizeAnthropicApiBaseUrl } = require('./anthropicCompat');
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

function requestSignal(userSignal, timeoutMs) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort('timeout'), Math.max(1000, Number(timeoutMs) || 180000));
  const controller = new AbortController();
  const abort = (reason) => { if (!controller.signal.aborted) controller.abort(reason); };
  const onUserAbort = () => abort('user');
  const onTimeout = () => abort('timeout');
  userSignal?.addEventListener?.('abort', onUserAbort, { once: true });
  timeoutController.signal.addEventListener('abort', onTimeout, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      userSignal?.removeEventListener?.('abort', onUserAbort);
      timeoutController.signal.removeEventListener('abort', onTimeout);
    },
    reason() { return controller.signal.reason; },
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

function parseAnthropicSseChunk(chunk, handlers = {}) {
  const lines = chunk.split('\n');
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const payload = JSON.parse(data);
      const text = payload.delta?.text || payload.content_block?.text || '';
      if (text && handlers.onDelta) handlers.onDelta(text);
      if (payload.usage && handlers.onUsage) {
        handlers.onUsage(normalizeAnthropicUsage(payload.usage));
      }
    } catch {
      // Ignore malformed provider keep-alive chunks.
    }
  });
}

function parseSseEvent(chunk = '') {
  const lines = String(chunk || '').split(/\r?\n/);
  let event = '';
  const data = [];
  lines.forEach((line) => {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trim());
  });
  return { event, data: data.join('\n') };
}

function mergeStreamUsage(previous = null, next = null, protocol = 'openai') {
  if (!next || typeof next !== 'object') return previous;
  const normalized = protocol === 'anthropic' ? normalizeAnthropicUsage(next) : normalizeUsage(next);
  if (!normalized) return previous;
  return normalizeUsage({
    prompt_tokens: normalized.prompt_tokens || previous?.prompt_tokens || 0,
    completion_tokens: normalized.completion_tokens || previous?.completion_tokens || 0,
    total_tokens: normalized.total_tokens || ((normalized.prompt_tokens || previous?.prompt_tokens || 0) + (normalized.completion_tokens || previous?.completion_tokens || 0)),
  });
}

function createVisibleTextStream() {
  let raw = '';
  let visible = '';
  const reveal = () => {
    let source = raw;
    const lower = source.toLowerCase();
    const lastTagStart = source.lastIndexOf('<');
    if (lastTagStart >= 0) {
      const tail = lower.slice(lastTagStart);
      if (['<thinking>', '</thinking>'].some((tag) => tag.startsWith(tail))) {
        source = source.slice(0, lastTagStart);
      }
    }
    const visibleLower = source.toLowerCase();
    const lastOpen = visibleLower.lastIndexOf('<thinking>');
    const lastClose = visibleLower.lastIndexOf('</thinking>');
    if (lastOpen > lastClose) source = source.slice(0, lastOpen);
    return source
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/<\/thinking>/gi, '');
  };
  return {
    push(chunk = '') {
      raw += String(chunk || '');
      const next = reveal();
      const delta = next.startsWith(visible) ? next.slice(visible.length) : next;
      visible = next;
      return delta;
    },
    text() {
      return visible;
    },
  };
}

function toolStreamEntry(store, index = 0) {
  const key = Number.isFinite(Number(index)) ? Number(index) : 0;
  if (!store.has(key)) store.set(key, { index: key, id: '', name: '', input: '', initialInput: null });
  return store.get(key);
}

async function consumeToolStream(response, { apiProtocol, onVisibleText } = {}) {
  if (!response.body) throw createAppError('LLM_STREAM_MISSING', 'LLM API 未返回可读取的流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const visibleText = createVisibleTextStream();
  const toolCalls = new Map();
  let pending = '';
  let usage = null;
  let stopReason = '';

  const emitText = (text) => {
    const delta = visibleText.push(text);
    if (delta && typeof onVisibleText === 'function') onVisibleText(delta);
  };
  const handleOpenAi = (payload) => {
    usage = mergeStreamUsage(usage, payload?.usage, 'openai');
    const choice = payload?.choices?.[0] || {};
    const delta = choice.delta || {};
    if (delta.content) emitText(delta.content);
    (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).forEach((call, fallbackIndex) => {
      const entry = toolStreamEntry(toolCalls, call.index ?? fallbackIndex);
      entry.id = call.id || entry.id;
      entry.name += String(call.function?.name || call.name || '');
      entry.input += String(call.function?.arguments || call.arguments || '');
    });
    if (choice.finish_reason) stopReason = choice.finish_reason;
  };
  const handleAnthropic = (eventName, payload) => {
    usage = mergeStreamUsage(usage, payload?.usage, 'anthropic');
    if (eventName === 'content_block_start') {
      const block = payload?.content_block || {};
      if (block.type === 'text' && block.text) emitText(block.text);
      if (block.type === 'tool_use') {
        const entry = toolStreamEntry(toolCalls, payload.index);
        entry.id = block.id || entry.id;
        entry.name = block.name || entry.name;
        entry.initialInput = block.input || entry.initialInput;
      }
    }
    if (eventName === 'content_block_delta') {
      const delta = payload?.delta || {};
      if (delta.type === 'text_delta' && delta.text) emitText(delta.text);
      if (delta.type === 'input_json_delta') {
        const entry = toolStreamEntry(toolCalls, payload.index);
        entry.input += String(delta.partial_json || '');
      }
    }
    if (eventName === 'message_delta' && payload?.delta?.stop_reason) stopReason = payload.delta.stop_reason;
  };
  const handlePart = (part) => {
    const { event, data } = parseSseEvent(part);
    if (!data || data === '[DONE]') return;
    try {
      const payload = JSON.parse(data);
      if (apiProtocol === 'anthropic') handleAnthropic(event, payload);
      else handleOpenAi(payload);
    } catch {
      // 忽略 Provider 的 keep-alive 与不完整 SSE 事件。
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const parts = pending.split(/\r?\n\r?\n/);
    pending = parts.pop() || '';
    parts.forEach(handlePart);
  }
  pending += decoder.decode();
  if (pending.trim()) handlePart(pending);

  const content = [];
  const text = visibleText.text();
  if (text) content.push({ type: 'text', text });
  [...toolCalls.values()].sort((left, right) => left.index - right.index).forEach((call) => {
    const serializedInput = call.input || (call.initialInput ? JSON.stringify(call.initialInput) : '');
    if (call.name) content.push({
      type: 'tool_use',
      id: call.id || `stream-tool-${call.index}`,
      name: call.name,
      input: serializedInput ? parseToolInput(serializedInput) : (call.initialInput || {}),
    });
  });
  return {
    content,
    stopReason: stopReason || (toolCalls.size > 0 ? 'tool_use' : 'end_turn'),
    usage,
  };
}

function normalizeApiProtocol(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'anthropic' ? 'anthropic' : 'openai';
}

function normalizeAnthropicUsage(usage = null) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number(usage.input_tokens);
  const outputTokens = Number(usage.output_tokens);
  return normalizeUsage({
    prompt_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    completion_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  });
}

function buildOpenAiHeaders(config) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.llmApiKey}`,
  };
}

function buildAnthropicHeaders(config) {
  return {
    'Content-Type': 'application/json',
    ...buildAnthropicCompatibleAuthHeaders({
      apiKey: config.llmApiKey,
      baseUrl: config.llmBaseUrl,
    }),
  };
}

function buildAnthropicRequestUrl(baseUrl, path) {
  return `${normalizeAnthropicApiBaseUrl(baseUrl)}${path}`;
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

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item?.text === 'string') return item.text;
      return JSON.stringify(item);
    }).join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

function buildAnthropicRequestBody(messages, options, budget, config) {
  const systemMessages = [];
  const requestMessages = [];

  (Array.isArray(messages) ? messages : []).forEach((message) => {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'system' ? 'system' : 'user';
    const content = normalizeMessageContent(message?.content);
    if (!content) return;
    if (role === 'system') {
      systemMessages.push(content);
      return;
    }
    requestMessages.push({ role, content });
  });

  if (options.responseFormat?.type === 'json_object') {
    systemMessages.push('输出必须是合法 JSON 对象，不要包含 Markdown 代码块或额外解释。');
  }

  const body = {
    model: options.model || config.llmModel,
    messages: requestMessages.length > 0 ? requestMessages : [{ role: 'user', content: '' }],
    temperature: options.temperature ?? 0.2,
    max_tokens: budget.maxOutputTokens,
  };
  if (systemMessages.length > 0) body.system = systemMessages.join('\n\n');
  return body;
}

function readAnthropicMessage(payload) {
  const text = Array.isArray(payload?.content)
    ? payload.content
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item?.type === 'text' && typeof item.text === 'string') return item.text;
          return '';
        })
        .filter(Boolean)
        .join('')
    : '';

  return {
    role: 'assistant',
    content: text || payload?.message?.content || '',
  };
}

function toTextBlock(content) {
  if (!content) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [{ type: 'text', text: normalizeMessageContent(content) }];
  return content.map((item) => {
    if (typeof item === 'string') return { type: 'text', text: item };
    return item;
  }).filter(Boolean);
}

function isImageBlock(block) {
  return block?.type === 'image' && block?.source?.type === 'base64'
    && block?.source?.media_type && block?.source?.data;
}

function toOpenAiImageBlock(block) {
  if (!isImageBlock(block)) return null;
  return {
    type: 'image_url',
    image_url: {
      url: `data:${block.source.media_type};base64,${block.source.data}`,
    },
  };
}

function toOpenAiTools(tools = []) {
  return (Array.isArray(tools) ? tools : []).map((item) => ({
    type: 'function',
    function: {
      name: item.name,
      description: item.description || '',
      parameters: item.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function toAnthropicMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = toTextBlock(message.content).map((block) => {
      if (block.type === 'tool_result') {
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: String(block.content || ''),
          is_error: Boolean(block.is_error),
        };
      }
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input || {} };
      }
      if (isImageBlock(block)) {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: block.source.media_type,
            data: block.source.data,
          },
        };
      }
      return { type: 'text', text: String(block.text || block.content || '') };
    }).filter((block) => block.type !== 'text' || block.text);
    return { role, content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] };
  });
}

function toOpenAiMessages(system, messages = []) {
  const output = [];
  if (system) output.push({ role: 'system', content: String(system) });
  (Array.isArray(messages) ? messages : []).forEach((message) => {
    const blocks = toTextBlock(message.content);
    if (message.role === 'assistant') {
      const text = blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join('\n').trim();
      const toolCalls = blocks.filter((block) => block.type === 'tool_use').map((block) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      }));
      output.push({ role: 'assistant', content: text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
      return;
    }
    const userContent = blocks.flatMap((block) => {
      if (block.type === 'text' && block.text) return [{ type: 'text', text: block.text }];
      const image = toOpenAiImageBlock(block);
      return image ? [image] : [];
    });
    blocks.filter((block) => block.type === 'tool_result').forEach((block) => {
      output.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: String(block.content || ''),
      });
    });
    if (userContent.length > 0) {
      output.push({
        role: 'user',
        content: userContent.some((block) => block.type === 'image_url')
          ? userContent
          : userContent.map((block) => block.text).join('\n'),
      });
    }
  });
  return output.length > 0 ? output : [{ role: 'user', content: '' }];
}

function parseToolInput(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function parseOpenAiToolResponse(payload = {}) {
  const choice = payload.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  if (message.content) content.push({ type: 'text', text: message.content });
  (message.tool_calls || []).forEach((call) => {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function?.name || call.name || '',
      input: parseToolInput(call.function?.arguments || call.arguments),
    });
  });
  return {
    content,
    stopReason: (message.tool_calls || []).length > 0 ? 'tool_use' : (choice.finish_reason || 'end_turn'),
  };
}

function parseAnthropicToolResponse(payload = {}) {
  const content = Array.isArray(payload.content) ? payload.content.map((block) => {
    if (block?.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input || {} };
    if (block?.type === 'text') return { type: 'text', text: block.text || '' };
    return block;
  }).filter(Boolean) : [];
  return { content, stopReason: payload.stop_reason || 'end_turn' };
}

function buildAnthropicToolRequestBody({ system, messages, tools, model, temperature }, budget, config) {
  const body = {
    model: model || config.llmModel,
    messages: toAnthropicMessages(messages),
    temperature: temperature ?? 0.2,
    max_tokens: budget.maxOutputTokens,
  };
  if (system) body.system = String(system);
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
  return body;
}

async function completeToolChat({
  system = '',
  messages = [],
  tools = [],
  llmConfig = null,
  model,
  temperature = 0.2,
  taskType = 'agent_loop',
  maxOutputTokens,
  compact,
  signal,
  requestTimeoutMs,
  maxRetries = 1,
  onVisibleText,
} = {}) {
  const config = resolveLlmConfig(llmConfig);
  const apiProtocol = normalizeApiProtocol(config.llmApiProtocol);
  const budget = resolveLlmBudget(config, taskType, { model, maxOutputTokens });
  let currentMessages = Array.isArray(messages) ? messages : [];
  let currentTools = Array.isArray(tools) ? tools : [];
  let retryCount = 0;

  while (true) {
    let requestMessages = apiProtocol === 'anthropic'
      ? toAnthropicMessages(currentMessages)
      : toOpenAiMessages(system, currentMessages);
    let estimatedPromptTokens = estimateChatRequestTokens({
      messages: apiProtocol === 'anthropic' ? [{ role: 'system', content: system }, ...currentMessages] : requestMessages,
      tools: currentTools,
    });
    // Provider 明确返回 overflow 后必须进入 60% 的 hard compact，不能因为
    // 上一轮 soft compact 的本地估算刚好低于 85% 而跳过唯一一次恢复机会。
    if (retryCount > 0 || estimatedPromptTokens >= budget.compactTriggerTokens) {
      const compactBudget = {
        ...budget,
        compactTriggerTokens: Math.floor(budget.hardInputBudgetTokens * (retryCount > 0 ? 0.6 : 0.75)),
      };
      const compacted = await applyCompaction({
        compact,
        messages: currentMessages,
        tools: currentTools,
        responseFormat: null,
        budget: compactBudget,
        mode: retryCount > 0 ? 'hard' : 'soft',
      });
      if (compacted) {
        currentMessages = compacted.messages;
        currentTools = compacted.tools || currentTools;
        requestMessages = apiProtocol === 'anthropic'
          ? toAnthropicMessages(currentMessages)
          : toOpenAiMessages(system, currentMessages);
        estimatedPromptTokens = estimateChatRequestTokens({
          messages: apiProtocol === 'anthropic' ? [{ role: 'system', content: system }, ...currentMessages] : requestMessages,
          tools: currentTools,
        });
      }
    }
    if (estimatedPromptTokens > budget.hardInputBudgetTokens) {
      throw createAppError('CONTEXT_BUDGET_EXCEEDED', '当前任务上下文超出模型预算，请缩小处理范围。', {
        budget: buildBudgetPayload(budget, estimatedPromptTokens, retryCount),
      });
    }

    const scopedSignal = requestSignal(signal, requestTimeoutMs || config.llmRequestTimeoutMs || 180000);
    let response;
    try {
      response = apiProtocol === 'anthropic'
        ? await fetch(buildAnthropicRequestUrl(config.llmBaseUrl, '/messages'), {
          method: 'POST', headers: buildAnthropicHeaders(config), signal: scopedSignal.signal,
          body: JSON.stringify({
            ...buildAnthropicToolRequestBody({ system, messages: currentMessages, tools: currentTools, model, temperature }, budget, config),
            ...(typeof onVisibleText === 'function' ? { stream: true } : {}),
          }),
        })
        : await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST', headers: buildOpenAiHeaders(config), signal: scopedSignal.signal,
          body: JSON.stringify({
            ...buildBaseRequestBody(requestMessages, {
              model, tools: toOpenAiTools(currentTools), temperature,
            }, budget, config),
            ...(typeof onVisibleText === 'function' ? { stream: true, stream_options: { include_usage: true } } : {}),
          }),
        });
    } catch (error) {
      if (scopedSignal.signal.aborted) {
        throw createAppError(scopedSignal.reason() === 'user' ? 'ABORTED' : 'LLM_REQUEST_TIMEOUT',
          scopedSignal.reason() === 'user' ? 'LLM 请求已取消' : 'LLM 请求超时');
      }
      throw error;
    } finally {
      scopedSignal.dispose();
    }

    if (!response.ok) {
      const errorPayload = await readErrorPayload(response);
      const overflow = isContextOverflowError(response.status, errorPayload.body);
      if (overflow && retryCount < Math.max(0, Number(maxRetries) || 0)) {
        retryCount += 1;
        continue;
      }
      throw createAppError(overflow ? 'CONTEXT_BUDGET_EXCEEDED' : 'LLM_API_ERROR', errorPayload.message, {
        status: response.status,
        response_body: errorPayload.body,
        overflow,
        budget: buildBudgetPayload(budget, estimatedPromptTokens, retryCount),
      });
    }

    const streamed = typeof onVisibleText === 'function'
      ? await consumeToolStream(response, { apiProtocol, onVisibleText })
      : null;
    const payload = streamed ? null : await response.json();
    const usage = streamed?.usage || (apiProtocol === 'anthropic' ? normalizeAnthropicUsage(payload.usage) : normalizeUsage(payload.usage));
    const parsed = streamed || (apiProtocol === 'anthropic' ? parseAnthropicToolResponse(payload) : parseOpenAiToolResponse(payload));
    return {
      role: 'assistant', content: parsed.content, stopReason: parsed.stopReason, usage,
      budget: buildBudgetPayload(budget, estimatedPromptTokens, retryCount), raw: payload,
    };
  }
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
  const apiProtocol = normalizeApiProtocol(config.llmApiProtocol);
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
    const response = apiProtocol === 'anthropic'
      ? await fetch(buildAnthropicRequestUrl(config.llmBaseUrl, '/messages'), {
        method: 'POST',
        headers: buildAnthropicHeaders(config),
        body: JSON.stringify(buildAnthropicRequestBody(currentMessages, {
          model,
          responseFormat,
          temperature,
        }, budget, config)),
      })
      : await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: buildOpenAiHeaders(config),
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
    const usage = apiProtocol === 'anthropic'
      ? normalizeAnthropicUsage(payload.usage)
      : normalizeUsage(payload.usage);
    if (usage && typeof onUsage === 'function') onUsage(usage);
    return {
      message: apiProtocol === 'anthropic'
        ? readAnthropicMessage(payload)
        : payload.choices?.[0]?.message || { role: 'assistant', content: '' },
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
  const apiProtocol = normalizeApiProtocol(config.llmApiProtocol);
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
    const response = apiProtocol === 'anthropic'
      ? await fetch(buildAnthropicRequestUrl(config.llmBaseUrl, '/messages'), {
        method: 'POST',
        headers: buildAnthropicHeaders(config),
        body: JSON.stringify({
          ...buildAnthropicRequestBody(currentMessages, { model, temperature }, budget, config),
          stream: true,
        }),
      })
      : await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: buildOpenAiHeaders(config),
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
        const parser = apiProtocol === 'anthropic' ? parseAnthropicSseChunk : parseSseChunk;
        parser(part, {
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
      const parser = apiProtocol === 'anthropic' ? parseAnthropicSseChunk : parseSseChunk;
      parser(pending, {
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
  completeToolChat,
  consumeToolStream,
  createVisibleTextStream,
  toAnthropicMessages,
  toOpenAiMessages,
};
