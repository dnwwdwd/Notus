const { getEffectiveConfig } = require('./config');
const { createAppError } = require('./errors');

function resolveLlmConfig(override = null) {
  const config = { ...getEffectiveConfig(), ...(override || {}) };
  if (!config.llmApiKey) throw createAppError('LLM_API_KEY_MISSING', 'LLM API Key 未配置');
  if (!config.llmBaseUrl) throw createAppError('LLM_BASE_URL_MISSING', 'LLM Base URL 未配置');
  if (!config.llmModel) throw createAppError('LLM_MODEL_MISSING', 'LLM 模型未配置');
  return config;
}

async function readError(response) {
  const body = await response.text();
  return `LLM API ${response.status}: ${body}`;
}

async function completeChat(messages, { tools, model, responseFormat, config: override } = {}) {
  const config = resolveLlmConfig(override);
  const body = {
    model: model || config.llmModel,
    messages,
    temperature: 0.2,
  };
  if (tools) body.tools = tools;
  if (responseFormat) body.response_format = responseFormat;

  const response = await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw createAppError('LLM_API_ERROR', await readError(response), { status: response.status });
  const payload = await response.json();
  return payload.choices?.[0]?.message || { role: 'assistant', content: '' };
}

function parseSseChunk(chunk, onDelta) {
  const lines = chunk.split('\n');
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const payload = JSON.parse(data);
      const text = payload.choices?.[0]?.delta?.content || '';
      if (text) onDelta(text);
    } catch {
      // Ignore malformed provider keep-alive chunks.
    }
  });
}

async function streamChat(messages, { model, config: override, onToken } = {}) {
  const config = resolveLlmConfig(override);
  const response = await fetch(`${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify({
      model: model || config.llmModel,
      messages,
      stream: true,
      temperature: 0.2,
    }),
  });

  if (!response.ok) throw createAppError('LLM_API_ERROR', await readError(response), { status: response.status });
  if (!response.body) throw createAppError('LLM_STREAM_MISSING', 'LLM API 未返回可读取的流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let pending = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const parts = pending.split('\n\n');
    pending = parts.pop() || '';
    parts.forEach((part) => {
      parseSseChunk(part, (text) => {
        fullText += text;
        if (onToken) onToken(text);
      });
    });
  }

  if (pending) {
    parseSseChunk(pending, (text) => {
      fullText += text;
      if (onToken) onToken(text);
    });
  }

  return fullText;
}

module.exports = {
  completeChat,
  streamChat,
};
