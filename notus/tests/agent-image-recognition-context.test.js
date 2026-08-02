const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const startRoute = read('pages/api/agent/loop/start.js');
const taskWorker = read('lib/agentTaskWorker.js');
const recognition = read('lib/imageRecognition.js');
const attachmentStore = read('lib/parsedAttachmentStore.js');
const agentTools = read('lib/agentTools.js');
const prompt = read('lib/agentLoopPrompt.js');
const agentLoop = read('lib/agentLoop.js');
const { buildInitialUserMessage } = require('../lib/agentLoopPrompt');

assert.ok(startRoute.includes("const { wakeAgentTaskWorker } = require('../../../../lib/agentTaskWorker');"));
assert.ok(startRoute.includes('const task = createTask({'));
assert.ok(startRoute.includes('wakeAgentTaskWorker();'));
assert.ok(taskWorker.includes("const { recognizeConversationImages } = require('./imageRecognition');"));
assert.ok(taskWorker.includes('currentImageRecognition = await recognizeConversationImages({'));
assert.ok(taskWorker.includes('initialImages = [];'));
assert.ok(taskWorker.includes('initialImages, currentImageRecognition,'));
assert.ok(
  startRoute.indexOf('wakeAgentTaskWorker();') < startRoute.indexOf('return res.status(202).json({ protocol_version: 3, session_id: created.sessionId'),
  '路由必须先创建会话与任务，再唤醒后台 Worker；图片识别由 Worker 异步执行，不能阻塞用户消息的确认响应。'
);
assert.ok(recognition.includes("type: 'image_recognition'"));
assert.ok(recognition.includes('image_refs: imageRefs,'));
assert.ok(recognition.includes('completeToolChat({'));
assert.ok(attachmentStore.includes("image_recognition: '图片识别结果'"));
assert.ok(attachmentStore.includes('受控图片引用：'));
assert.ok(!agentTools.includes("tool('list_conversation_images'"));
assert.ok(!agentTools.includes("tool('read_conversation_images'"));
assert.ok(!agentTools.includes('executeListConversationImages'));
assert.ok(!agentTools.includes('executeReadConversationImages'));
assert.ok(!prompt.includes('先调用 list_conversation_images'));
assert.ok(!agentLoop.includes('imageContextBlocks'));

const initialMessage = buildInitialUserMessage('用户任务：请分析图片', { search_knowledge_limit: 5 }, {
  currentImageRecognition: {
    text: '图片主体是一张带错误提示的界面截图。',
    imageRefs: ['notus-conversation-image://42/img-a'],
  },
});
assert.ok(initialMessage.includes('本轮图片识别结果'));
assert.ok(initialMessage.includes('图片主体是一张带错误提示的界面截图。'));
assert.ok(initialMessage.includes('notus-conversation-image://42/img-a'));
assert.ok(initialMessage.includes('不要说“没有收到图片”'));

const agentToolsModule = require('../lib/agentTools');
assert.ok(!Object.hasOwn(agentToolsModule, 'executeListConversationImages'));
assert.ok(!Object.hasOwn(agentToolsModule, 'executeReadConversationImages'));

console.log('agent image recognition context tests passed');
