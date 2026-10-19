const assert = require('assert');

const { toAnthropicMessages, normalizeAnthropicConversation } = require('../lib/llm');

// 场景：Agent Loop 模型未返回工具调用时会把 assistant 消息压回历史并继续请求，
// 对话以 assistant 结尾。Vertex 系 Anthropic 通道会拒绝 prefill：
// "This model does not support assistant message prefill."
const trailingAssistant = toAnthropicMessages([
  { role: 'user', content: [{ type: 'text', text: '帮我整理这个文件' }] },
  { role: 'assistant', content: [{ type: 'text', text: '好的，我已经读取了文件内容。' }] },
]);
const normalized = normalizeAnthropicConversation(trailingAssistant);
assert.strictEqual(normalized.length, 3);
assert.strictEqual(normalized[0].role, 'user');
assert.strictEqual(normalized[1].role, 'assistant');
assert.strictEqual(normalized[2].role, 'user');
assert.strictEqual(normalized[2].content[0].text, '请继续。');

// 空文本块被清理；空 assistant 消息直接丢弃，避免空 text 块触发协议错误。
const emptyAssistant = normalizeAnthropicConversation(toAnthropicMessages([
  { role: 'user', content: [{ type: 'text', text: '继续' }] },
  { role: 'assistant', content: [] },
  { role: 'user', content: [{ type: 'text', text: '还有吗' }] },
]));
assert.strictEqual(emptyAssistant.length, 1);
assert.deepStrictEqual(emptyAssistant[0].role, 'user');
assert.deepStrictEqual(emptyAssistant[0].content, [{ type: 'text', text: '继续' }, { type: 'text', text: '还有吗' }]);

// 相邻同角色消息必须合并，保持角色交替。
const merged = normalizeAnthropicConversation([
  { role: 'user', content: [{ type: 'text', text: '第一条' }] },
  { role: 'user', content: [{ type: 'text', text: '第二条' }] },
  { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
]);
assert.strictEqual(merged.length, 3);
assert.strictEqual(merged[0].content.length, 2);
assert.strictEqual(merged[0].content[0].text, '第一条');
assert.strictEqual(merged[0].content[1].text, '第二条');
assert.strictEqual(merged[1].role, 'assistant');
assert.strictEqual(merged[2].role, 'user');
assert.strictEqual(merged[2].content[0].text, '请继续。');

// 以 user 结尾的正常对话不改写。
const normal = normalizeAnthropicConversation(toAnthropicMessages([
  { role: 'user', content: [{ type: 'text', text: '你好' }] },
]));
assert.strictEqual(normal.length, 1);
assert.deepStrictEqual(normal[0], { role: 'user', content: [{ type: 'text', text: '你好' }] });

// tool_result 块不会被误删；assistant tool_use 之后的 user tool_result 保留原样。
const withTools = normalizeAnthropicConversation(toAnthropicMessages([
  { role: 'user', content: [{ type: 'text', text: '列出文件' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'list_files', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.md', is_error: false }] },
]));
assert.strictEqual(withTools.length, 3);
assert.strictEqual(withTools[1].content[0].type, 'tool_use');
assert.strictEqual(withTools[2].content[0].type, 'tool_result');

console.log('anthropic-conversation-shape test passed');
