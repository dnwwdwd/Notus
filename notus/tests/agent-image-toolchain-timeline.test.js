const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { mergeAgentMedia } = require('../lib/agentMedia');
const { sanitizeRunEvent, restoreViewedImagePreviews } = require('../lib/agentSession');
const { dedupeAgentMedia } = require('../utils/agentMedia');
const controllerSource = fs.readFileSync(path.join(__dirname, '..', 'hooks/useAgentLoopController.js'), 'utf8');

const image = {
  id: 'image-1',
  stored_name: 'image-1.png',
  name: 'diagram.png',
  type: 'image/png',
  media_kind: 'image',
  upload_order: 1,
};

const merged = mergeAgentMedia({
  attachments: [],
  mediaItems: [image],
  images: [image],
});

assert.strictEqual(merged.images.length, 1, '同一图片同时出现在 images 与 media_items 时只能保留一次');
assert.strictEqual(merged.images[0].id, 'image-1');

const aliasedImage = { ...image, id: 'server-image-1' };
const mergedAliases = mergeAgentMedia({ attachments: [], mediaItems: [image], images: [aliasedImage] });
assert.strictEqual(mergedAliases.images.length, 1, '同一存储文件即使临时 ID 不同也只能保留一次');

const historicalImages = dedupeAgentMedia([image, { ...image, preview_url: '/api/agent/images/image-1.png?conversation_id=7' }]);
assert.strictEqual(historicalImages.length, 1, '旧对话中重复保存的同一图片只能渲染一次');
assert.strictEqual(dedupeAgentMedia([image, aliasedImage]).length, 1, '前端历史媒体需按存储名兼容不同 ID 的同一图片');

const imageViewEvent = {
  type: 'progress',
  stage: 'image_view_start',
  conversation_id: 7,
  message_id: 42,
  image_count: 1,
  images: [{
    id: 'image-1',
    name: 'diagram.png',
    alt: '用户提交的图片',
    preview_url: '/api/agent/images/image-1.png?conversation_id=7',
  }],
};
const persisted = sanitizeRunEvent(imageViewEvent);

assert.strictEqual(persisted.message_id, 42, '图片查看事件补发时必须保留消息 ID');
assert.strictEqual(persisted.image_count, 1, '图片查看事件补发时必须保留图片数量');
assert.deepStrictEqual(persisted.images, imageViewEvent.images, '图片查看事件补发时必须保留受控缩略图');

const secondMessageImageEvent = sanitizeRunEvent({
  ...imageViewEvent,
  message_id: 43,
  images: [{
    id: 'image-2',
    name: 'second-message.png',
    alt: '第二条消息的图片',
    preview_url: '/api/agent/images/image-2.png?conversation_id=7',
  }],
});
assert.strictEqual(secondMessageImageEvent.message_id, 43, '后续消息的图片事件必须保留自身消息 ID');
assert.deepStrictEqual(secondMessageImageEvent.images.map((image) => image.id), ['image-2'], '后续消息不能混入前一条消息的图片');

const wrongConversationEvent = sanitizeRunEvent({ ...imageViewEvent, conversation_id: 7, images: [{ ...imageViewEvent.images[0], preview_url: '/api/agent/images/image-1.png?conversation_id=8' }] });
assert.strictEqual(wrongConversationEvent.images.length, 0, '图片事件不能保存其他会话的受控地址');

const repeatedImageEvent = sanitizeRunEvent({ ...imageViewEvent, image_count: 2, images: [imageViewEvent.images[0], imageViewEvent.images[0]] });
assert.strictEqual(repeatedImageEvent.image_count, 1, '持久化事件即使收到重复图片，也必须按去重后的数量展示');
assert.strictEqual(repeatedImageEvent.images.length, 1, '持久化事件不得保存重复图片缩略图');

const uuidImageEvent = sanitizeRunEvent({
  ...imageViewEvent,
  images: [{ ...imageViewEvent.images[0], preview_url: '/api/agent/images/be840e20-ad1a-44b7-9257-5b1923ad2c7c.png?conversation_id=7' }],
});
assert.strictEqual(
  uuidImageEvent.images[0].preview_url,
  '/api/agent/images/be840e20-ad1a-44b7-9257-5b1923ad2c7c.png?conversation_id=7',
  '受控图片地址中的随机文件名不能被通用脱敏规则破坏'
);

const repairedLegacyEvent = restoreViewedImagePreviews({
  type: 'progress',
  stage: 'image_recognition_done',
  images: [{ id: 'image-1', preview_url: '/[REDACTED].png?conversation_id=7' }],
}, {
  conversationId: 7,
  input: { images: [{ id: 'image-1', stored_name: 'be840e20-ad1a-44b7-9257-5b1923ad2c7c.png' }] },
});
assert.strictEqual(
  repairedLegacyEvent.images[0].preview_url,
  '/api/agent/images/be840e20-ad1a-44b7-9257-5b1923ad2c7c.png?conversation_id=7',
  '历史记录中的失效受控地址必须由任务输入恢复'
);

const reconstructedLegacyEvent = restoreViewedImagePreviews({ type: 'progress', stage: 'image_view_start', images: [] }, {
  conversationId: 7,
  messageId: 42,
  input: { images: [{ id: 'image-1', name: 'diagram.png', stored_name: 'be840e20-ad1a-44b7-9257-5b1923ad2c7c.png' }] },
});
assert.strictEqual(reconstructedLegacyEvent.images.length, 1, '旧事件缺少 images 时必须从任务输入补回缩略图');
assert.strictEqual(reconstructedLegacyEvent.message_id, 42, '旧事件恢复时必须补回任务用户消息 ID');

assert.ok(controllerSource.includes("id: `image-view-${event.message_id || loop || 'current'}`"), '图片补发必须按原始消息 ID 合并到同一工具步骤');
assert.ok(controllerSource.includes('images: Array.isArray(event.images) ? event.images : []'), '历史会话恢复必须读取持久化的受控缩略图');
assert.ok(controllerSource.includes("const isCompleted = session.status === 'completed';"), '已完成任务恢复时必须识别最终状态');
assert.ok(controllerSource.includes("if (isCompleted && event.type === 'artifact' && event.artifact_type === 'run_error') return false;"), '已成功完成的任务不能继续展示已解决的模型错误');

const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'components/AgentWorkspace/AgentWorkspace.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '..', 'styles/globals.css'), 'utf8');
const overlaySource = fs.readFileSync(path.join(__dirname, '..', 'components/ui/ImagePreviewOverlay.js'), 'utf8');
const eventBusSource = fs.readFileSync(path.join(__dirname, '..', 'lib/agentRunEventBus.js'), 'utf8');
assert.ok(workspaceSource.includes('onPreviewImages?.(step.images, image)'), '工具链缩略图点击时必须接入图片预览回调');
assert.ok(workspaceSource.includes('dedupeAgentMedia(sourceImages)'), '工具链预览只应使用当前工具步骤传入的图片集合');
assert.ok(workspaceSource.includes('onPreviewToolchainImages={openToolchainImagePreview}'), '工具链预览回调必须连接到工作区预览组件');
assert.ok(workspaceSource.includes('setMessageImagePreview({ images, currentIndex, hideTitle: true });'), '工具链图片预览必须在预览容器上隐藏文件名标题');
assert.ok(overlaySource.includes('preview.hideTitle ? null'), '共享预览层必须支持隐藏标题');
assert.ok(eventBusSource.includes("const { recordRunEvent, sanitizeRunEvent } = require('./agentSession');"), '实时事件总线必须使用同一脱敏函数');
assert.ok(eventBusSource.includes('event: safeEvent'), '实时事件总线必须广播脱敏后的事件');
assert.ok(!workspaceSource.includes('<figcaption>{image.name || `图片 ${imageIndex + 1}`}</figcaption>'), '工具链缩略图不应显示文件名');
assert.ok(workspaceSource.includes('const hasViewedImages = visibleSteps.some((step) => Array.isArray(step.images) && step.images.length > 0);'), '已完成任务必须识别到图片工具记录');
assert.ok(workspaceSource.includes('if (!liveSession && !hasActionRequired && !hasViewedImages) setTraceExpanded(false);'), '已完成任务含图片记录时不能自动收起工具链');
assert.ok(styleSource.includes('object-fit: contain;'), '工具链缩略图必须完整显示图片而非裁切');
assert.ok(!styleSource.includes('.notus-agent-toolchain__image-preview { width: 112px; aspect-ratio: 4 / 3;'), '工具链缩略图容器不得固定为 4:3');
assert.ok(styleSource.includes('.notus-agent-toolchain__image-preview img { display: block; width: auto; height: auto;'), '工具链缩略图必须按原图比例缩放');

console.log('agent image toolchain timeline tests passed');
