const { getEffectiveConfig } = require('./config');
const { MAX_IMAGE_BYTES, storeLocalImageBuffer } = require('./images');
const { uploadObjectImage } = require('./objectStorage');

function normalizeImageBuffer(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
  if (buffer.length <= 0) {
    const error = new Error('图片内容为空');
    error.code = 'INVALID_IMAGE';
    throw error;
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    const error = new Error('图片体积超过上限');
    error.code = 'IMAGE_TOO_LARGE';
    throw error;
  }
  return buffer;
}

async function persistImageBuffer({ buffer, mimeType = '', originalName = '', filePath = '' } = {}) {
  const content = normalizeImageBuffer(buffer);
  const config = getEffectiveConfig();
  if (config.imageStorageMode === 'object_storage') {
    const stored = await uploadObjectImage(config.objectStorage, {
      buffer: content,
      mimeType,
      originalName,
    });
    return {
      src: stored.publicUrl,
      asset_path: null,
      object_key: stored.objectKey,
      storage: 'object_storage',
      provider: stored.provider,
      mime_type: stored.mimeType,
      size: stored.contentLength,
    };
  }

  const stored = storeLocalImageBuffer(content, {
    mimeType,
    originalName,
    filePath,
  });
  return {
    src: stored.markdownSrc,
    asset_path: stored.relativePath,
    object_key: null,
    storage: 'local',
    provider: null,
    mime_type: stored.mimeType,
    size: stored.contentLength,
  };
}

module.exports = {
  persistImageBuffer,
};
