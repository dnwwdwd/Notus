const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const startRoute = read('pages/api/agent/loop/start.js');
const taskWorker = read('lib/agentTaskWorker.js');
const inputSources = read('lib/agentInputSources.js');
const controller = read('hooks/useAgentLoopController.js');

assert.ok(startRoute.includes('function splitMediaInputs(body = {})'));
assert.ok(startRoute.includes('const mediaItems = Array.isArray(body.media_items)'));
assert.ok(startRoute.includes('const media = splitMediaInputs(body);'));
assert.ok(startRoute.includes('attachments: media.attachments, images: media.images, media_items: media.media_items'));
assert.ok(startRoute.includes('meta: { agent_loop: true, agent_goal: goal, user_query: userQuery, attachments: media.attachments, images: media.images, media_items: media.media_items'));
assert.ok(startRoute.includes('mcp_selection: requestedMcpSelection'));
assert.ok(startRoute.includes('function persistedImages(images, conversationId, messageId)'));
assert.ok(startRoute.includes('images: persistedImages(media.images, conversation.id, userMessageId),'));
assert.ok(taskWorker.includes('const attachments = assertAttachmentLimits(conversationId, media.attachments);'));
assert.ok(taskWorker.includes('const images = assertImageLimits(conversationId, media.images);'));
assert.ok(taskWorker.includes('initialImages = getImageInputBlocks(images, { messageId: task.user_message_id });'));
assert.ok(inputSources.includes('function isImageAttachment(attachment = {})'));
assert.ok(inputSources.includes('filter((attachment) => !isImageAttachment(attachment))'));
assert.ok(controller.includes('function buildUserMessageMedia(input = {}, conversationId = null)'));
assert.ok(controller.includes('media_items: Array.isArray(input?.media_items)'));
assert.ok(controller.includes('images: Array.isArray(event.images) ? event.images : input.images,'));
assert.ok(controller.includes("source_kind: 'image',"));
assert.ok(controller.includes("media_kind: 'image',"));
assert.ok(controller.includes('attachments: buildUserMessageMedia({'));
assert.ok(controller.includes('Number(event.conversation_id || event.conversationId || 0) || null),'));

console.log('agent image routing tests passed');
