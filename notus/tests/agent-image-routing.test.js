const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const startRoute = read('pages/api/agent/loop/start.js');
const inputSources = read('lib/agentInputSources.js');
const controller = read('hooks/useAgentLoopController.js');

assert.ok(startRoute.includes('function splitMediaInputs(body = {})'));
assert.ok(startRoute.includes('const rawMediaItems = Array.isArray(body.media_items)'));
assert.ok(startRoute.includes('const mediaInputs = splitMediaInputs(body);'));
assert.ok(startRoute.includes('const attachments = assertAttachmentLimits(conversationId, mediaInputs.attachments);'));
assert.ok(startRoute.includes('const images = assertImageLimits(conversationId, mediaInputs.images);'));
assert.ok(startRoute.includes('initialImages = getImageInputBlocks(images, { messageId });'));
assert.ok(startRoute.includes('function buildPersistedImages(images = [], conversationId, messageId)'));
assert.ok(startRoute.includes('images: buildPersistedImages(images, conversationId, userMessageId),'));
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
