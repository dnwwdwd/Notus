const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-stream-lifecycle-'));
  Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, DB_PATH: path.join(root, 'test.db'), NOTES_DIR: path.join(root, 'notes') });
  const { completeToolChat } = require('../lib/llm');
  const { classifyLLMError } = require('../lib/agentLoop');
  let delayMs = 1500;
  const timers = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n');
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.end('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }, delayMs);
    timers.add(timer);
    res.on('close', () => { clearTimeout(timer); timers.delete(timer); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = {
    llmConfig: { llmApiKey: 'test', llmBaseUrl: `http://127.0.0.1:${server.address().port}`, llmModel: 'test', llmApiProtocol: 'openai' },
    messages: [{ role: 'user', content: '测试流式请求生命周期' }],
    onVisibleText: () => {}, requestTimeoutMs: 1000,
  };
  try {
    await assert.rejects(completeToolChat(request), { code: 'LLM_REQUEST_TIMEOUT' }, '收到响应头后，正文仍必须受超时控制');
    const controller = new AbortController();
    const cancellation = setTimeout(() => controller.abort(), 100);
    try {
      await assert.rejects(completeToolChat({ ...request, signal: controller.signal }), { code: 'ABORTED' }, '正文读取期间的用户取消必须传递给模型请求');
    } finally { clearTimeout(cancellation); }
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(completeToolChat({ ...request, signal: aborted.signal }), { code: 'ABORTED' });
    delayMs = 20;
    const result = await completeToolChat(request);
    assert.strictEqual(result.content[0].text, '开始完成');
    for (const code of ['UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT', 'ECONNRESET']) {
      const error = new TypeError('terminated', { cause: Object.assign(new Error('connection closed'), { code }) });
      assert.strictEqual(classifyLLMError(error).retryable, true, `底层 ${code} 应可重试`);
    }
    assert.strictEqual(classifyLLMError(new TypeError('programming error')).retryable, false);
    assert.strictEqual(classifyLLMError({ status: 401, cause: { code: 'UND_ERR_SOCKET' } }).category, 'action_required');
    console.log('llm stream lifecycle tests passed');
  } finally {
    timers.forEach(clearTimeout);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
