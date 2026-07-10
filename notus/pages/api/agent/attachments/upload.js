const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const formidable = require('formidable');
const { ensureRuntime } = require('../../../../lib/runtime');
const { getEffectiveConfig } = require('../../../../lib/config');
const { createLogger, createRequestContext } = require('../../../../lib/logger');
const { SUPPORTED_EXTENSIONS } = require('../../../../lib/attachmentParsing');

export const config = {
  api: {
    bodyParser: false,
  },
};

const MAX_FILE_SIZE = 25 * 1024 * 1024;

function sanitizeFileName(value) {
  return path.basename(String(value || '未命名附件')).replace(/[<>:"|?*\x00-\x1F]/g, '_').slice(0, 180) || '未命名附件';
}

function parseForm(req, uploadDir) {
  const form = formidable.formidable({
    multiples: true,
    uploadDir,
    keepExtensions: true,
    maxFileSize: MAX_FILE_SIZE,
    filename: (_name, ext, part) => {
      const originalExt = path.extname(part?.originalFilename || '').toLowerCase();
      const safeExt = SUPPORTED_EXTENSIONS.has(originalExt) ? originalExt : String(ext || '').toLowerCase();
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
  try {
    if (filePath) fs.unlinkSync(filePath);
  } catch {}
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/agent/attachments/upload');
  const logger = createLogger(context);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  }

  const runtime = ensureRuntime();
  if (!runtime.ok) {
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const uploadDir = path.resolve(getEffectiveConfig().sessionDir, 'attachments');
  fs.mkdirSync(uploadDir, { recursive: true });

  try {
    const { files } = await parseForm(req, uploadDir);
    const uploadedFiles = flattenFiles(files);
    if (uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'files is required', code: 'FILES_REQUIRED', request_id: context.request_id });
    }

    const attachments = [];
    const errors = [];

    uploadedFiles.forEach((file) => {
      const originalName = sanitizeFileName(file.originalFilename || file.newFilename || '未命名附件');
      const extension = path.extname(originalName).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        removeQuietly(file.filepath);
        errors.push({
          name: originalName,
          code: 'UNSUPPORTED_FORMAT',
          error: `不支持的文件格式：${extension || '未知'}。当前支持 PDF、DOCX、MD、TXT。`,
        });
        return;
      }
      attachments.push({
        id: `att-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        name: originalName,
        size: Number(file.size || 0),
        type: file.mimetype || '',
        extension,
        stored_name: path.basename(file.filepath),
      });
    });

    if (attachments.length === 0) {
      return res.status(400).json({ error: errors[0]?.error || '没有可上传的附件', code: errors[0]?.code || 'UPLOAD_FAILED', errors, request_id: context.request_id });
    }

    return res.status(200).json({
      attachments,
      errors,
      request_id: context.request_id,
    });
  } catch (error) {
    logger.error('agent.attachments.upload.failed', { error });
    return res.status(400).json({
      error: error.message || '附件上传失败',
      code: error.code || 'UPLOAD_FAILED',
      request_id: context.request_id,
    });
  }
}
