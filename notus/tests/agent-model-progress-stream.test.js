const assert = require('assert');
const { consumeToolStream, createVisibleTextStream } = require('../lib/llm');

function responseFromChunks(chunks) {
  const encoder = new TextEncoder();
  return {
    body: new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }),
  };
}

(async () => {
  const visible = createVisibleTextStream();
  assert.strictEqual(visible.push('公开说明<thi'), '公开说明', '不完整隐藏推理标签不能提前显示');
  assert.strictEqual(visible.push('nking>内部推理</thinking>继续'), '继续', '隐藏推理内容不能进入用户可见流');

  const received = [];
  const response = await consumeToolStream(responseFromChunks([
    'data: {"choices":[{"delta":{"content":"先读取"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"文件。"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"demo.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\n',
    'data: [DONE]\n\n',
  ]), {
    apiProtocol: 'openai',
    onVisibleText: (text) => received.push(text),
  });

  assert.deepStrictEqual(received, ['先读取', '文件。'], '模型执行说明必须按到达顺序流式回调');
  assert.deepStrictEqual(response.content, [
    { type: 'text', text: '先读取文件。' },
    { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'demo.md' } },
  ]);
  assert.strictEqual(response.stopReason, 'tool_calls');
  assert.strictEqual(response.usage.total_tokens, 19);
  console.log('agent model progress stream tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
