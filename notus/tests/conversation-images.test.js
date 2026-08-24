const assert = require('assert');

const {
  MAX_ATTACHMENTS_PER_CONVERSATION,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ANTHROPIC_IMAGE_CONTEXT_BYTES,
  MAX_IMAGES_PER_CONVERSATION,
  MAX_IMAGES_PER_MESSAGE,
  assertAttachmentLimits,
  assertImageLimits,
  normalizeMessageAttachments,
  normalizeMessageImages,
} = require('../lib/conversationImages');
const { mapConversationMessages } = require('../utils/conversations');

assert.strictEqual(MAX_IMAGES_PER_MESSAGE, 30);
assert.strictEqual(MAX_IMAGES_PER_CONVERSATION, 50);
assert.strictEqual(MAX_ATTACHMENTS_PER_MESSAGE, 10);
assert.strictEqual(MAX_ATTACHMENTS_PER_CONVERSATION, 20);
assert.strictEqual(MAX_ANTHROPIC_IMAGE_CONTEXT_BYTES, 20 * 1024 * 1024);

assert.throws(
  () => assertImageLimits(null, Array.from({ length: 31 }, (_, index) => ({
    name: `image-${index}.png`,
    stored_name: `image-${index}.png`,
  }))),
  (error) => error.code === 'IMAGE_MESSAGE_LIMIT_EXCEEDED'
);
assert.throws(
  () => assertAttachmentLimits(null, Array.from({ length: 11 }, (_, index) => ({
    name: `file-${index}.txt`,
  }))),
  (error) => error.code === 'ATTACHMENT_MESSAGE_LIMIT_EXCEEDED'
);

assert.strictEqual(normalizeMessageImages([{ name: 'one.png', stored_name: 'one.png' }]).length, 1);
assert.strictEqual(
  normalizeMessageImages([{ name: 'one.png', extension: '.png', stored_name: 'one.png' }]).length,
  1,
  '图片上传接口单独返回 extension 时，服务端仍须保留该图片供视觉输入与受控预览使用。'
);
assert.strictEqual(normalizeMessageImages([{ name: 'one.svg', stored_name: 'one.svg' }]).length, 0);
assert.strictEqual(normalizeMessageAttachments([{ name: 'brief.pdf', upload_order: 3 }])[0].upload_order, 3);

const mapped = mapConversationMessages([{
  id: 1,
  role: 'user',
  content: '请一起分析',
  meta: {
    attachments: [{ id: 'a1', name: 'brief.pdf', upload_order: 1 }],
    images: [{ id: 'i1', name: 'screen.png', stored_name: 'screen.png', upload_order: 0 }],
  },
}], 'canvas');
assert.deepStrictEqual(mapped[0].attachments.map((item) => item.id), ['i1', 'a1']);
assert.deepStrictEqual(mapped[0].attachments.map((item) => item.media_kind), ['image', 'attachment']);

console.log('conversation image tests passed');
