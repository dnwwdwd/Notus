const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'components/AgentWorkspace/AgentWorkspace.js'), 'utf8');
const { getAgentImagePreviewUrl } = require('../utils/agentMedia');

assert.ok(source.includes('function FileChip({ file, onRemove, readOnly, onOpen, onPreview, imageOnly = false, imageSize = 72 })'));
assert.ok(source.includes("import { getAgentImagePreviewUrl } from '../../utils/agentMedia';"));
assert.ok(source.includes('return getAgentImagePreviewUrl(file);'));
assert.ok(source.includes('if (image && imageOnly && previewUrl)'));
assert.ok(source.includes('|| isSupportedImageFile(file);'));
assert.ok(source.includes('imageOnly={isImageMedia(file)}'));
assert.ok(source.includes('const images = incoming.filter(isSupportedImageFile);'));
assert.ok(source.includes("addFiles(images, { ...options, mediaKind: 'image' });"));
assert.ok(source.includes('`${PARSED_ATTACHMENT_ACCEPT},${IMAGE_ACCEPT}`'));
assert.ok(source.includes('const messageImages = Array.isArray(message.attachments) ? message.attachments.filter(isImageMedia) : [];'));
assert.ok(source.includes('const messageAttachments = Array.isArray(message.attachments) ? message.attachments.filter((file) => !isImageMedia(file)) : [];'));
assert.ok(source.includes('data-message-image-row="true"'));
assert.ok(source.includes('data-message-bubble="true"'));
assert.ok(source.includes('imageSize={112}'));
assert.ok(source.includes('const [messageImagePreview, setMessageImagePreview] = useState(null);'));
assert.ok(source.includes('const openMessageImagePreview = useCallback((message, selectedFile) => {'));
assert.ok(source.includes('onPreviewImages={openMessageImagePreview}'));
assert.ok(source.includes('<ImagePreviewOverlay preview={messageImagePreview}'));
assert.strictEqual(
  getAgentImagePreviewUrl({
    previewUrl: 'blob:expired-preview',
    preview_url: '/api/agent/images/persisted.png?conversation_id=23',
    conversation_id: 23,
    stored_name: 'persisted.png',
  }),
  '/api/agent/images/persisted.png?conversation_id=23',
  'session_created 回传的受控地址必须覆盖已被回收的浏览器对象 URL。'
);
assert.strictEqual(
  getAgentImagePreviewUrl({ conversation_id: 23, stored_name: 'persisted.png' }),
  '/api/agent/images/persisted.png?conversation_id=23',
  '历史消息缺少显式 preview_url 时仍须由会话归属生成受控地址。'
);
assert.strictEqual(getAgentImagePreviewUrl({ previewUrl: 'blob:pending-preview' }), 'blob:pending-preview');

console.log('agent image message preview tests passed');
