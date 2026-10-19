const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-request-diagnostics-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, NOTES_DIR: path.join(root, 'notes'), DB_PATH: path.join(root, 'test.db') });
const { completeToolChat } = require('../lib/llm');
const { buildLlmFailureDiagnostics } = require('../lib/llmDiagnostics');
let mode = 'reject';
let attempts = 0;
let captured;
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part;
  captured = JSON.parse(raw);
  attempts += 1;
  await new Promise((resolve) => setTimeout(resolve, 25));
  if (mode === 'timeout') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return; }
  if (mode === 'html') { res.writeHead(502, { 'content-type': 'text/html' }); res.end('<html>private-html</html>'); return; }
  if (mode === 'reject' || (mode === 'compact' && attempts === 1)) {
    res.writeHead(400, { 'content-type': 'application/json', 'x-request-id': `request-${mode}` });
    res.end(JSON.stringify({ error: { message: mode === 'compact' ? 'maximum context length exceeded' : 'Missing reasoning_content; api_key=private-key',
      code: mode === 'compact' ? 'context_length_exceeded' : 'invalid_request_error', param: 'messages[1].reasoning_content' },
      messages: 'private-echoed-prompt' })); return;
  }
  if (mode === 'json-error') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Gateway error inside JSON', status: 400 } })); return;
  }
  if (mode === 'stream-error') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'stream-request' });
    res.end('event: error\ndata: {"error":{"type":"invalid_request_error","message":"Invalid history block"}}\n\n'); return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '完成' }, finish_reason: 'stop' }] }));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = { llmConfig: { llmApiKey: 'private-key', llmBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    llmModel: 'deepseek-test', llmApiProtocol: 'openai', llmContextWindowTokens: 60000, llmMaxOutputTokens: 4096 },
    system: 'private-system', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'private-path' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'private-result' }] }],
    tools: [{ name: 'read_file', input_schema: { type: 'object' } }], maxRetries: 0 };
  for (const protocol of ['openai', 'anthropic']) {
    mode = 'reject';
    const failures = [];
    await assert.rejects(completeToolChat({ ...request, llmConfig: { ...request.llmConfig, llmApiProtocol: protocol },
      onRequestFailure: error => failures.push(buildLlmFailureDiagnostics(error, request.llmConfig)) }), { status: 400 });
    assert.equal(failures.length, 1);
    const diagnostic = failures[0];
    assert.equal(diagnostic.protocol, protocol); assert.equal(diagnostic.model, captured.model);
    assert.equal(diagnostic.request.max_output, captured.max_tokens);
    assert.equal(diagnostic.request.tool_call_count, 1); assert.equal(diagnostic.request.tool_result_count, 1);
    assert.equal(diagnostic.request.unmatched_tool_result_count, 0); assert.equal(diagnostic.request.pending_tool_call_count, 0);
    assert.equal(diagnostic.request.message_count, captured.messages.length);
    assert(diagnostic.request.duration_ms >= 20); assert.equal(diagnostic.request.phase, 'reading_response');
    assert.equal(diagnostic.request.response_http_status, 400); assert.equal(diagnostic.provider_request_id, 'request-reject');
    for (const privateValue of ['private-key', 'private-system', 'private-path', 'private-result', 'private-echoed-prompt']) assert(!JSON.stringify(diagnostic).includes(privateValue));
  }
  mode = 'compact'; attempts = 0;
  const compactFailures = [];
  const complete = await completeToolChat({ ...request, maxRetries: 1, onRequestFailure: e => compactFailures.push(e) });
  assert.equal(complete.content[0].text, '完成'); assert.equal(attempts, 2);
  assert.equal(compactFailures.length, 1, '内部压缩前的失败必须被记录');
  assert.equal(compactFailures[0].llm_request.compaction_retry, 0);
  for (const failureMode of ['html', 'json-error', 'stream-error', 'timeout']) {
    mode = failureMode;
    await assert.rejects(completeToolChat({ ...request, requestTimeoutMs: 1000,
      ...(mode === 'stream-error' || mode === 'timeout' ? { onVisibleText: () => {} } : {}) }), error => {
      const diagnostic = buildLlmFailureDiagnostics(error, request.llmConfig);
      assert(Number.isFinite(diagnostic.request.duration_ms));
      assert(!JSON.stringify(diagnostic).includes('private-html'));
      if (mode === 'stream-error') { assert.equal(diagnostic.http_status, 400); assert.equal(diagnostic.request.response_http_status, 200); assert.equal(diagnostic.provider_request_id, 'stream-request'); }
      if (mode === 'timeout') { assert.equal(error.code, 'LLM_REQUEST_TIMEOUT'); assert.equal(diagnostic.request.phase, 'reading_stream'); assert(diagnostic.request.duration_ms >= 900); }
      return true;
    });
  }
  const before = attempts;
  await assert.rejects(completeToolChat({ ...request, messages: [{ role: 'user', content: '超预算'.repeat(5000) }], compact: () => ({ messages: [{ role: 'user', content: '超预算'.repeat(5000) }] }),
    llmConfig: { ...request.llmConfig, llmContextWindowTokens: 3000, llmMaxOutputTokens: 256 } }), error => {
    assert.equal(error.code, 'CONTEXT_BUDGET_EXCEEDED'); assert.equal(error.llm_request.dispatched, false);
    assert.equal(error.llm_request.phase, 'preflight'); return true;
  });
  assert.equal(attempts, before, '本地预算失败不应发送 HTTP');
  await new Promise(resolve => server.closeAllConnections() || server.close(resolve));
  await assert.rejects(completeToolChat(request), error => {
    const diagnostic = buildLlmFailureDiagnostics(error, request.llmConfig);
    assert.equal(diagnostic.request.phase, 'connecting');
    assert(diagnostic.transport_causes.some(cause => ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(cause.code)), '保留连接拒绝或连接池断开的底层原因');
    return true;
  });
  console.log('request diagnostics passed: HTTP/JSON/SSE/HTML/timeout/network/preflight and internal compaction');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true });
});
