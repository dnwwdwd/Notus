const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const startRoute = read('pages/api/agent/loop/start.js');
const recognition = read('lib/imageRecognition.js');
const attachmentStore = read('lib/parsedAttachmentStore.js');
const agentTools = read('lib/agentTools.js');
const prompt = read('lib/agentLoopPrompt.js');
const agentLoop = read('lib/agentLoop.js');
const { buildInitialUserMessage } = require('../lib/agentLoopPrompt');

assert.ok(startRoute.includes("const { recognizeConversationImages } = require('../../../../lib/imageRecognition');"));
assert.ok(startRoute.includes('const recognition = await recognizeConversationImages({'));
assert.ok(startRoute.includes('initialImages = [];'));
assert.ok(startRoute.includes('currentImageRecognition = recognition;'));
assert.ok(startRoute.includes('currentImageRecognition,'));
assert.ok(
  startRoute.indexOf("type: 'session_created'") < startRoute.indexOf('const recognition = await recognizeConversationImages({'),
  'session_created 必须先于耗时的图片识别返回，以便立即回显用户消息和受控图片预览。'
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
