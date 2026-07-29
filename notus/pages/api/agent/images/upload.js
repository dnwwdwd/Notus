const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const formidable = require('formidable');
const { ensureRuntime } = require('../../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../../lib/logger');
const {
  IMAGE_MIME_TYPES,
  MAX_IMAGE_SIZE,
  MAX_IMAGES_PER_MESSAGE,
  getImageExtensionFromMimeType,
  getImagesDir,
  isSupportedImageName,
  isSupportedImageMimeType,
} = require('../../../../lib/conversationImages');

export const config = {
  api: {
    bodyParser: false,
  },
};

function sanitizeFileName(value) {
  return path.basename(String(value || '未命名图片')).replace(/[<>:"|?*\x00-\x1F]/g, '_').slice(0, 180) || '未命名图片';
}

function parseForm(req, uploadDir) {
  const form = formidable.formidable({
    multiples: true,
    uploadDir,
    keepExtensions: true,
    maxFileSize: MAX_IMAGE_SIZE,
    maxFiles: MAX_IMAGES_PER_MESSAGE,
    filename: (_name, ext, part) => {
      const originalExt = path.extname(part?.originalFilename || '').toLowerCase();
      const safeExt = IMAGE_MIME_TYPES.has(originalExt)
        ? originalExt
        : getImageExtensionFromMimeType(part?.mimetype) || String(ext || '').toLowerCase();
      return `${crypto.randomUUID()}${safeExt}`;
    },
  });
  return new Promise((resolve, reject) => {
    form.parse(req, (error, fields, files) => {
      if (error) reject(error);
      else resolve({ fields, files });
    });
  });
}

function flattenFiles(files) {
  return Object.values(files || {}).flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean);
}

function removeQuietly(filePath) {
  try { if (filePath) fs.unlinkSync(filePath); } catch {}
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/agent/images/upload');
  const logger = createLogger(context);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const uploadDir = getImagesDir();
  fs.mkdirSync(uploadDir, { recursive: true });

  try {
    const { files } = await parseForm(req, uploadDir);
    const uploadedFiles = flattenFiles(files);
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'images is required', code: 'IMAGES_REQUIRED', request_id: context.request_id });
    }
    if (uploadedFiles.length > MAX_IMAGES_PER_MESSAGE) {
      uploadedFiles.forEach((file) => removeQuietly(file.filepath));
      return res.status(400).json({ error: `单条消息最多上传 ${MAX_IMAGES_PER_MESSAGE} 张图片`, code: 'IMAGE_MESSAGE_LIMIT_EXCEEDED', request_id: context.request_id });
    }

    const images = [];
    const errors = [];
    uploadedFiles.forEach((file) => {
      const originalName = sanitizeFileName(file.originalFilename || file.newFilename || '未命名图片');
      const extension = path.extname(originalName).toLowerCase() || getImageExtensionFromMimeType(file.mimetype);
      if (!isSupportedImageName(originalName) && !isSupportedImageMimeType(file.mimetype)) {
        removeQuietly(file.filepath);
        errors.push({ name: originalName, code: 'UNSUPPORTED_IMAGE_FORMAT', error: '当前支持 PNG、JPG、JPEG、WEBP 和 GIF 图片。' });
        return;
      }
      const name = path.extname(originalName) ? originalName : `${originalName}${extension}`;
      images.push({
        id: `img-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        name,
        size: Number(file.size || 0),
        type: IMAGE_MIME_TYPES.get(extension),
        extension,
        stored_name: path.basename(file.filepath),
        source_kind: 'image',
        media_kind: 'image',
      });
    });

    if (images.length === 0) {
      return res.status(400).json({ error: errors[0]?.error || '没有可上传的图片', code: errors[0]?.code || 'IMAGE_UPLOAD_FAILED', errors, request_id: context.request_id });
    }
    return res.status(200).json({ images, errors, request_id: context.request_id });
  } catch (error) {
    logger.error('agent.images.upload.failed', { error });
    return res.status(400).json({ error: error.message || '图片上传失败', code: error.code || 'IMAGE_UPLOAD_FAILED', request_id: context.request_id });
  }
}
