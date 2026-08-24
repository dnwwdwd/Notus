const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');

const MAX_IMAGES_PER_MESSAGE = 30;
const MAX_IMAGES_PER_CONVERSATION = 50;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const MAX_ATTACHMENTS_PER_CONVERSATION = 20;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_ANTHROPIC_IMAGE_CONTEXT_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

function normalizeImageMimeType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

function getImageExtensionFromMimeType(value) {
  const target = normalizeImageMimeType(value);
  for (const [extension, mimeType] of IMAGE_MIME_TYPES.entries()) {
    if (mimeType === target || (target === 'image/jpg' && mimeType === 'image/jpeg')) return extension;
  }
  return '';
}

function isSupportedImageMimeType(value) {
  return Boolean(getImageExtensionFromMimeType(value));
}

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function normalizeStoredName(value) {
  return path.basename(String(value || '').trim());
}

function getImageExtension(value) {
  const normalized = String(value || '').trim().toLowerCase();
  // 上传接口已把扩展名单独保存为 `.png` / `.jpg` 等值；`path.extname('.png')`
  // 会返回空字符串，必须先识别这种元数据形态，不能把已上传图片静默丢弃。
  if (IMAGE_MIME_TYPES.has(normalized)) return normalized;
  return path.extname(normalized).toLowerCase();
}

function isSupportedImageName(value) {
  return IMAGE_MIME_TYPES.has(getImageExtension(value));
}

function getImagesDir() {
  return path.resolve(getEffectiveConfig().sessionDir, 'images');
}

function resolveStoredImagePath(storedName) {
  const safeName = normalizeStoredName(storedName);
  const imagesDir = getImagesDir();
  if (!safeName || !isSupportedImageName(safeName)) return null;
  const absolutePath = path.resolve(imagesDir, safeName);
  if (!absolutePath.startsWith(`${imagesDir}${path.sep}`)) return null;
  return absolutePath;
}

function normalizeImageMetadata(image = {}, index = 0) {
  const storedName = normalizeStoredName(image.stored_name || image.storedName);
  const extension = getImageExtension(image.extension || image.name || storedName);
  if (!storedName || !IMAGE_MIME_TYPES.has(extension)) return null;
  const size = Number(image.size || 0);
  return {
    id: String(image.id || `img-${index + 1}`),
    name: path.basename(String(image.name || storedName)).slice(0, 180) || '未命名图片',
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    type: String(image.type || IMAGE_MIME_TYPES.get(extension)),
    extension,
    stored_name: storedName,
    source_kind: 'image',
    media_kind: 'image',
    upload_order: Number.isFinite(Number(image.upload_order)) ? Number(image.upload_order) : index,
    message_id: normalizePositiveInt(image.message_id || image.messageId),
    image_ref: String(image.image_ref || image.imageRef || '').trim(),
  };
}

function normalizeMessageImages(images = []) {
  return (Array.isArray(images) ? images : [])
    .map(normalizeImageMetadata)
    .filter(Boolean);
}

function makeConversationImageReference(messageId, imageId) {
  const normalizedMessageId = normalizePositiveInt(messageId);
  const normalizedImageId = String(imageId || '').trim();
  if (!normalizedMessageId || !normalizedImageId) return '';
  return `notus-conversation-image://${normalizedMessageId}/${encodeURIComponent(normalizedImageId)}`;
}

function parseConversationImageReference(value = '') {
  const match = String(value || '').trim().match(/^notus-conversation-image:\/\/(\d+)\/([^/?#]+)$/i);
  if (!match) return null;
  let imageId = '';
  try { imageId = decodeURIComponent(match[2]); } catch { return null; }
  const messageId = normalizePositiveInt(match[1]);
  if (!messageId || !imageId) return null;
  return { message_id: messageId, image_id: imageId };
}

function parseMessageMeta(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function listConversationImages(conversationId) {
  const id = normalizePositiveInt(conversationId);
  if (!id) return [];
  const rows = getDb().prepare(`
    SELECT id, content, meta, created_at
    FROM messages
    WHERE conversation_id = ?
      AND role = 'user'
      AND type = 'text'
    ORDER BY id ASC
  `).all(id);
  return rows.flatMap((row) => {
    const images = normalizeMessageImages(parseMessageMeta(row.meta).images);
    return images.map((image) => ({
      ...image,
      message_id: Number(row.id),
      message_content: String(row.content || '').slice(0, 240),
      created_at: row.created_at || null,
      image_ref: makeConversationImageReference(row.id, image.id),
    }));
  });
}

function resolveConversationImages(conversationId, imageRefs = []) {
  const refs = Array.isArray(imageRefs) ? imageRefs : [];
  if (refs.length === 0) {
    const error = new Error('请至少选择一张会话图片');
    error.code = 'IMAGE_REFERENCES_REQUIRED';
    throw error;
  }
  if (refs.length > MAX_IMAGES_PER_MESSAGE) {
    const error = new Error(`单次最多读取 ${MAX_IMAGES_PER_MESSAGE} 张会话图片`);
    error.code = 'IMAGE_MESSAGE_LIMIT_EXCEEDED';
    throw error;
  }
  const available = listConversationImages(conversationId);
  const byRef = new Map(available.map((image) => [image.image_ref, image]));
  const selected = [];
  const used = new Set();
  refs.forEach((rawRef) => {
    const ref = String(rawRef || '').trim();
    if (!ref || used.has(ref)) return;
    used.add(ref);
    const parsed = parseConversationImageReference(ref);
    const image = parsed ? byRef.get(ref) : null;
    if (!image) {
      const error = new Error('会话图片不存在、已失效或不属于当前对话');
      error.code = 'CONVERSATION_IMAGE_NOT_FOUND';
      throw error;
    }
    selected.push(image);
  });
  if (selected.length === 0) {
    const error = new Error('没有找到可读取的会话图片');
    error.code = 'CONVERSATION_IMAGE_NOT_FOUND';
    throw error;
  }
  return selected.sort((left, right) => (
    Number(left.message_id || 0) - Number(right.message_id || 0)
    || Number(left.upload_order || 0) - Number(right.upload_order || 0)
  ));
}

function normalizeAttachmentMetadata(attachment = {}, index = 0) {
  const storedName = path.basename(String(attachment.stored_name || attachment.storedName || '').trim());
  const name = path.basename(String(attachment.name || attachment.file_name || storedName).trim());
  if (!name) return null;
  const size = Number(attachment.size || 0);
  return {
    id: String(attachment.id || `att-${index + 1}`),
    name: name.slice(0, 180),
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    type: String(attachment.type || ''),
    extension: String(attachment.extension || getImageExtension(name)).toLowerCase(),
    stored_name: storedName,
    source_kind: attachment.source_kind || 'file',
    media_kind: 'attachment',
    upload_order: Number.isFinite(Number(attachment.upload_order)) ? Number(attachment.upload_order) : index,
  };
}

function normalizeMessageAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .map(normalizeAttachmentMetadata)
    .filter(Boolean);
}

function countConversationImages(conversationId) {
  const id = normalizePositiveInt(conversationId);
  if (!id) return 0;
  const rows = getDb().prepare(`
    SELECT meta
    FROM messages
    WHERE conversation_id = ?
      AND role = 'user'
      AND type = 'text'
  `).all(id);
  return rows.reduce((total, row) => {
    try {
      const meta = JSON.parse(row.meta || '{}');
      return total + normalizeMessageImages(meta?.images).length;
    } catch {
      return total;
    }
  }, 0);
}

function countConversationAttachments(conversationId) {
  const id = normalizePositiveInt(conversationId);
  if (!id) return 0;
  const rows = getDb().prepare(`
    SELECT meta
    FROM messages
    WHERE conversation_id = ?
      AND role = 'user'
      AND type = 'text'
  `).all(id);
  return rows.reduce((total, row) => {
    try {
      const meta = JSON.parse(row.meta || '{}');
      return total + normalizeMessageAttachments(meta?.attachments).length;
    } catch {
      return total;
    }
  }, 0);
}

function assertAttachmentLimits(conversationId, attachments = []) {
  const normalized = normalizeMessageAttachments(attachments);
  if (normalized.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    const error = new Error(`单条消息最多上传 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`);
    error.code = 'ATTACHMENT_MESSAGE_LIMIT_EXCEEDED';
    throw error;
  }
  const existing = countConversationAttachments(conversationId);
  if (existing + normalized.length > MAX_ATTACHMENTS_PER_CONVERSATION) {
    const error = new Error(`整个对话最多上传 ${MAX_ATTACHMENTS_PER_CONVERSATION} 个附件，当前还可上传 ${Math.max(0, MAX_ATTACHMENTS_PER_CONVERSATION - existing)} 个`);
    error.code = 'ATTACHMENT_CONVERSATION_LIMIT_EXCEEDED';
    throw error;
  }
  return normalized;
}

function assertImageLimits(conversationId, images = []) {
  const normalized = normalizeMessageImages(images);
  if (normalized.length > MAX_IMAGES_PER_MESSAGE) {
    const error = new Error(`单条消息最多上传 ${MAX_IMAGES_PER_MESSAGE} 张图片`);
    error.code = 'IMAGE_MESSAGE_LIMIT_EXCEEDED';
    throw error;
  }
  const existing = countConversationImages(conversationId);
  if (existing + normalized.length > MAX_IMAGES_PER_CONVERSATION) {
    const error = new Error(`整个对话最多上传 ${MAX_IMAGES_PER_CONVERSATION} 张图片，当前还可上传 ${Math.max(0, MAX_IMAGES_PER_CONVERSATION - existing)} 张`);
    error.code = 'IMAGE_CONVERSATION_LIMIT_EXCEEDED';
    throw error;
  }
  return normalized;
}

function assertImageContextSize(images = [], maxBytes = null) {
  const normalized = normalizeMessageImages(images);
  const limit = Number(maxBytes || 0);
  if (!limit) return normalized;
  const totalBytes = normalized.reduce((total, image) => {
    const filePath = resolveStoredImagePath(image.stored_name);
    if (!filePath || !fs.existsSync(filePath)) {
      const error = new Error(`图片临时文件不存在：${image.name}`);
      error.code = 'IMAGE_NOT_FOUND';
      throw error;
    }
    return total + fs.statSync(filePath).size;
  }, 0);
  if (totalBytes > limit) {
    const error = new Error(`Anthropic 单次请求的图片原始文件总大小最多 ${Math.floor(limit / 1024 / 1024)}MB，请减少图片数量或压缩图片后重试`);
    error.code = 'ANTHROPIC_IMAGE_CONTEXT_TOO_LARGE';
    throw error;
  }
  return normalized;
}

function getImageInputBlocks(images = [], { messageId = null } = {}) {
  return normalizeMessageImages(images)
    .sort((left, right) => Number(left.upload_order || 0) - Number(right.upload_order || 0))
    .map((image) => {
    const filePath = resolveStoredImagePath(image.stored_name);
    if (!filePath || !fs.existsSync(filePath)) {
      const error = new Error(`图片临时文件不存在：${image.name}`);
      error.code = 'IMAGE_NOT_FOUND';
      throw error;
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_IMAGE_SIZE) {
      const error = new Error(`图片超过 ${Math.round(MAX_IMAGE_SIZE / 1024 / 1024)}MB 上限：${image.name}`);
      error.code = 'IMAGE_TOO_LARGE';
      throw error;
    }
    const mediaType = IMAGE_MIME_TYPES.get(getImageExtension(filePath));
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: fs.readFileSync(filePath).toString('base64'),
      },
      name: image.name,
      upload_order: image.upload_order,
      image_ref: image.image_ref || makeConversationImageReference(image.message_id || messageId, image.id),
    };
    });
}

module.exports = {
  IMAGE_MIME_TYPES,
  MAX_ATTACHMENTS_PER_CONVERSATION,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ANTHROPIC_IMAGE_CONTEXT_BYTES,
  MAX_IMAGE_SIZE,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGES_PER_CONVERSATION,
  assertAttachmentLimits,
  assertImageContextSize,
  assertImageLimits,
  countConversationAttachments,
  countConversationImages,
  getImageInputBlocks,
  getImageExtensionFromMimeType,
  getImagesDir,
  isSupportedImageMimeType,
  isSupportedImageName,
  listConversationImages,
  makeConversationImageReference,
  normalizeMessageAttachments,
  normalizeMessageImages,
  parseConversationImageReference,
  resolveConversationImages,
  resolveStoredImagePath,
};
