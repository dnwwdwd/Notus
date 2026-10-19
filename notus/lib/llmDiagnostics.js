const { redactSecrets } = require('./agentToolPolicy');

function diagnosticText(value, config = {}, limit = 4096) {
  if (!['string', 'number'].includes(typeof value)) return '';
  let text = String(value);
  if (config.llmApiKey) text = text.split(String(config.llmApiKey)).join('[REDACTED]');
  text = text.replace(/\b(authorization|cookie|token|secret|password|api[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?(?:bearer\s+)?[^\s,"';}]+/gi, '$1=[REDACTED]');
  text = text.replace(/https?:\/\/[^\s<>"'`]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      url.username = '';
      url.password = '';
      for (const key of [...url.searchParams.keys()]) {
        if (/token|secret|password|signature|credential|key|auth|code/i.test(key)) url.searchParams.set(key, '[REDACTED]');
      }
      return url.toString();
    } catch { return '[URL]'; }
  });
  return String(redactSecrets(text)).slice(0, limit);
}

function buildLlmFailureDiagnostics(error = {}, config = {}) {
  let body = error.response_body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* Plain-text provider errors are also useful. */ }
  }
  const provider = body?.error && typeof body.error === 'object' ? body.error
    : (body?.data?.error || body?.data || body);
  const html = (typeof body === 'string' && /<(?:!doctype|html|head|body)\b/i.test(body))
    || /text\/html/i.test(error.llm_request?.response_content_type || '');
  const message = html ? '模型服务返回 HTML 错误页，未保存页面正文。'
    : provider?.message || provider?.detail || provider?.error_msg || body?.message || (typeof body?.error === 'string' ? body.error : '')
    || (typeof body === 'string' ? body : error.message) || '';
  const diagnostic = {
    http_status: Number(error.status || 0),
    model: diagnosticText(error.llm_request?.model || config.llmModel || '', config, 256),
    protocol: config.llmApiProtocol === 'anthropic' ? 'anthropic' : 'openai',
    provider_message: diagnosticText(message, config),
    provider_code: diagnosticText(provider?.code ?? body?.code ?? '', config, 256),
    provider_type: diagnosticText(provider?.type || '', config, 256),
    provider_param: diagnosticText(provider?.param || '', config, 512),
    provider_request_id: diagnosticText(error.provider_request_id || body?.request_id || body?.requestId || provider?.request_id || '', config, 256),
    local_error_code: diagnosticText(error.code || '', config, 256),
  };
  // 仅提升受控请求统计，不能把请求正文或任意 Error 属性直接存入日志。
  const request = error.llm_request;
  if (request && typeof request === 'object') {
    diagnostic.protocol = request.protocol === 'anthropic' ? 'anthropic' : 'openai';
    diagnostic.request = {};
    for (const key of ['endpoint', 'started_at', 'phase', 'response_content_type', 'budget_unit']) {
      if (typeof request[key] === 'string') diagnostic.request[key] = diagnosticText(request[key], config, 512);
    }
    for (const key of ['duration_ms', 'response_http_status', 'attempt', 'compaction_retry', 'context_window',
      'estimated_input', 'max_output', 'hard_input_limit', 'message_count', 'tool_count',
      'tool_call_count', 'tool_result_count', 'unmatched_tool_result_count', 'pending_tool_call_count',
      'assistant_tool_messages_missing_reasoning', 'image_count']) {
      if (Number.isFinite(request[key])) diagnostic.request[key] = Math.max(0, request[key]);
    }
    for (const key of ['dispatched', 'stream']) {
      if (typeof request[key] === 'boolean') diagnostic.request[key] = request[key];
    }
    if (request.message_roles) diagnostic.request.message_roles = Object.fromEntries(
      ['system', 'user', 'assistant', 'tool', 'other'].filter((role) => Number.isFinite(request.message_roles[role]))
        .map((role) => [role, Math.max(0, request.message_roles[role])])
    );
  }
  const causes = [];
  let cause = error.cause;
  for (let depth = 0; cause && depth < 3; depth += 1) {
    causes.push({ code: diagnosticText(cause.code || '', config, 256), message: diagnosticText(cause.message || '', config, 512) });
    cause = cause.cause;
  }
  if (causes.length) diagnostic.transport_causes = causes;
  return diagnostic;
}

function summarizeLlmRequest({ endpoint, body, protocol, budget, estimatedPromptTokens, attempt = 1, compactionRetry = 0 }) {
  let safeEndpoint = '';
  try { const url = new URL(endpoint); safeEndpoint = `${url.protocol}//${url.host}${url.pathname}`; } catch { /* 本地预算失败没有发送地址。 */ }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const roles = { system: 0, user: 0, assistant: 0, tool: 0, other: 0 };
  const pending = new Set();
  let calls = 0;
  let results = 0;
  let unmatched = 0;
  let missingReasoning = 0;
  let images = 0;
  for (const message of messages) {
    roles[Object.hasOwn(roles, message.role) ? message.role : 'other'] += 1;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const toolCalls = protocol === 'anthropic' ? blocks.filter((block) => block.type === 'tool_use') : (message.tool_calls || []);
    const toolResults = protocol === 'anthropic' ? blocks.filter((block) => block.type === 'tool_result') : (message.role === 'tool' ? [message] : []);
    for (const call of toolCalls) { calls += 1; if (call.id) pending.add(call.id); }
    for (const result of toolResults) {
      results += 1;
      if (!pending.delete(result.tool_use_id || result.tool_call_id)) unmatched += 1;
    }
    if (protocol === 'openai' && message.role === 'assistant' && toolCalls.length && !message.reasoning_content) missingReasoning += 1;
    images += blocks.filter((block) => ['image', 'image_url'].includes(block.type)).length;
  }
  return {
    endpoint: safeEndpoint, model: body.model, protocol, stream: Boolean(body.stream), attempt, compaction_retry: compactionRetry,
    budget_unit: 'tokens', context_window: budget.contextWindowTokens, estimated_input: estimatedPromptTokens,
    max_output: body.max_tokens, hard_input_limit: budget.hardInputBudgetTokens,
    message_count: messages.length, message_roles: roles, tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
    tool_call_count: calls, tool_result_count: results, unmatched_tool_result_count: unmatched,
    pending_tool_call_count: pending.size, assistant_tool_messages_missing_reasoning: missingReasoning, image_count: images,
  };
}

module.exports = { buildLlmFailureDiagnostics, summarizeLlmRequest };
