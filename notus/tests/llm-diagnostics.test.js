const assert = require('assert');
const { buildLlmFailureDiagnostics, summarizeLlmRequest } = require('../lib/llmDiagnostics');
const config = { llmModel: 'selected-model', llmApiProtocol: 'anthropic', llmApiKey: 'configured-key' };
const diagnostic = buildLlmFailureDiagnostics({ status: 400, provider_request_id: 'req-123', response_body: JSON.stringify({
  error: { message: 'Invalid history: configured-key; Authorization: Bearer header-value; api_key=assignment-value; {"password":"json-value"}; https://username:credential@example.test/request?signature=url-value&api_key=other-value&reason=invalid',
    code: 'invalid_history', type: 'invalid_request_error', param: 'messages.3.content' },
  input: 'full-prompt-must-not-be-stored',
}) }, config);
assert.equal(diagnostic.http_status, 400);
assert.equal(diagnostic.provider_request_id, 'req-123');
assert.equal(diagnostic.provider_param, 'messages.3.content');
assert(diagnostic.provider_message.includes('Invalid history'));
const serialized = JSON.stringify(diagnostic);
for (const secret of ['configured-key', 'header-value', 'assignment-value', 'json-value', 'username', 'credential@', 'url-value', 'other-value', 'full-prompt-must-not-be-stored']) assert(!serialized.includes(secret), secret);
const textError = buildLlmFailureDiagnostics({ status: 502, response_body: 'Upstream gateway unavailable' }, config);
assert.equal(textError.provider_message, 'Upstream gateway unavailable');
assert(buildLlmFailureDiagnostics({ response_body: { error: { message: '错误'.repeat(6000) } } }, config).provider_message.length <= 4096);
const summary = summarizeLlmRequest({ endpoint: 'https://username:password@example.test/v1/chat/completions?api_key=private-query',
  body: { model: 'actual-model', max_tokens: 4096, stream: true, tools: [{ function: { name: 'tool', parameters: 'private-schema' } }],
    messages: [{ role: 'system', content: 'private-system' },
      { role: 'assistant', content: 'private-thought', tool_calls: [{ id: 'paired', function: { arguments: 'private-arguments' } }] },
      { role: 'tool', tool_call_id: 'paired', content: 'private-result' },
      { role: 'tool', tool_call_id: 'missing', content: 'private-result' },
      { role: 'assistant', reasoning_content: 'private-reasoning', tool_calls: [{ id: 'pending' }] },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,private-image' } }] }] },
  protocol: 'openai', budget: { contextWindowTokens: 128000, hardInputBudgetTokens: 110000 }, estimatedPromptTokens: 35000 });
assert.equal(summary.tool_call_count, 2); assert.equal(summary.tool_result_count, 2);
assert.equal(summary.unmatched_tool_result_count, 1); assert.equal(summary.pending_tool_call_count, 1);
assert.equal(summary.assistant_tool_messages_missing_reasoning, 1); assert.equal(summary.image_count, 1);
const enriched = buildLlmFailureDiagnostics({ status: 400, llm_request: { ...summary, duration_ms: 321, phase: 'reading_response',
  malicious: 'request-body-must-not-be-stored' }, cause: { code: 'ECONNRESET', message: 'token=private-cause' } }, config);
assert.equal(enriched.model, 'actual-model'); assert.equal(enriched.protocol, 'openai');
assert.equal(enriched.request.endpoint, 'https://example.test/v1/chat/completions');
assert.equal(enriched.request.max_output, 4096);
const persisted = require('../lib/agentToolPolicy').redactSecrets(enriched);
assert.equal(persisted.request.context_window, 128000, '预算数字应在二次脱敏后保持可排查');
for (const secret of ['private-query', 'private-system', 'private-schema', 'private-thought', 'private-arguments', 'private-result', 'private-reasoning', 'private-image', 'private-cause', 'request-body-must-not-be-stored']) assert(!JSON.stringify(enriched).includes(secret), secret);
assert(!buildLlmFailureDiagnostics({ response_body: '<html><body>private-html</body></html>' }, config).provider_message.includes('private-html'));
assert.equal(buildLlmFailureDiagnostics({ response_body: { data: { error: { message: 'Nested error', code: 400 } } } }, config).provider_message, 'Nested error');
console.log('LLM diagnostics preserve bounded provider errors and redact credentials');
