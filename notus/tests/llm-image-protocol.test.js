const assert = require('assert');

const { toAnthropicMessages, toOpenAiMessages } = require('../lib/llm');

const image = {
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data: 'aGVsbG8=',
  },
};
const messages = [{
  role: 'user',
  content: [
    { type: 'text', text: '请分析图片' },
    image,
  ],
}];

const openaiMessages = toOpenAiMessages('system', messages);
assert.strictEqual(openaiMessages[1].content[0].type, 'text');
assert.strictEqual(openaiMessages[1].content[1].type, 'image_url');
assert.strictEqual(openaiMessages[1].content[1].image_url.url, 'data:image/png;base64,aGVsbG8=');

const anthropicMessages = toAnthropicMessages(messages);
assert.strictEqual(anthropicMessages[0].content[0].type, 'text');
assert.deepStrictEqual(anthropicMessages[0].content[1], image);

const toolImageMessages = [
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tool-image', name: 'read_conversation_images', input: { image_refs: ['notus-conversation-image://1/img-1'] } }],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tool-image', content: '{"image_count":1}', is_error: false },
      { type: 'text', text: '已读取会话图片。' },
      image,
    ],
  },
];
const openAiToolImageMessages = toOpenAiMessages('system', toolImageMessages);
assert.deepStrictEqual(openAiToolImageMessages.map((message) => message.role), ['system', 'assistant', 'tool', 'user']);
assert.strictEqual(openAiToolImageMessages[3].content[1].type, 'image_url');
const anthropicToolImageMessages = toAnthropicMessages(toolImageMessages);
assert.strictEqual(anthropicToolImageMessages[1].content[0].type, 'tool_result');
assert.strictEqual(anthropicToolImageMessages[1].content[2].type, 'image');

console.log('llm image protocol tests passed');
