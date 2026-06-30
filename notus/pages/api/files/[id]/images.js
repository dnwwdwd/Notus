const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const formidable = require('formidable');
const { ensureRuntime } = require('../../../../lib/runtime');
const { getEffectiveConfig } = require('../../../../lib/config');
const { getFileById } = require('../../../../lib/files');
const { MAX_IMAGE_BYTES, storeLocalImageBuffer } = require('../../../../lib/images');
const { createLogger, createRequestContext } = require('../../../../lib/logger');

export const config = {
  api: {
    bodyParser: false,
  },
};

function parseForm(req, uploadDir) {
  const form = formidable.formidable({
    multiples: false,
    uploadDir,
    keepExtensions: true,
    maxFileSize: MAX_IMAGE_BYTES,
    filename: (_name, ext, part) => {
      const originalExt = path.extname(part?.originalFilename || '').toLowerCase();
      return `${crypto.randomUUID()}${originalExt || String(ext || '').toLowerCase()}`;
    },
  });
  return new Promise((resolve, reject) => {
    form.parse(req, (error, fields, files) => {
      if (error) reject(error);
      else resolve({ fields, files });
    });
  });
}

function firstUploadedFile(files = {}) {
  return Object.values(files).flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean)[0] || null;
}

function removeQuietly(filePath) {
  try {
    if (filePath) fs.unlinkSync(filePath);
  } catch {}
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/files/[id]/images');
  const logger = createLogger(context);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const file = getFileById(req.query.id);
  if (!file) {
    return res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND', request_id: context.request_id });
  }

  const uploadDir = path.resolve(getEffectiveConfig().sessionDir, 'editor-images');
  fs.mkdirSync(uploadDir, { recursive: true });

  try {
    const { files } = await parseForm(req, uploadDir);
    const uploaded = firstUploadedFile(files);
    if (!uploaded) {
      return res.status(400).json({ error: 'image is required', code: 'IMAGE_REQUIRED', request_id: context.request_id });
    }
    if (!String(uploaded.mimetype || '').startsWith('image/')) {
      removeQuietly(uploaded.filepath);
      return res.status(400).json({ error: '只支持图片文件', code: 'UNSUPPORTED_IMAGE_TYPE', request_id: context.request_id });
    }

    const buffer = fs.readFileSync(uploaded.filepath);
    const stored = storeLocalImageBuffer(buffer, {
      mimeType: uploaded.mimetype || '',
      originalName: uploaded.originalFilename || uploaded.newFilename || '',
      filePath: file.path,
    });
    removeQuietly(uploaded.filepath);

    return res.status(200).json({
      src: stored.markdownSrc,
      asset_path: stored.relativePath,
      mime_type: stored.mimeType,
      size: stored.contentLength,
      request_id: context.request_id,
    });
  } catch (error) {
    logger.error('files.editor_image.upload.failed', { file_id: Number(req.query.id), error });
    return res.status(400).json({
      error: error.message || '图片上传失败',
      code: error.code || 'IMAGE_UPLOAD_FAILED',
      request_id: context.request_id,
    });
  }
}
