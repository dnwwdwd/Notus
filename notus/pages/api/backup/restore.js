const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const formidable = require('formidable');
const { ensureRuntime } = require('../../../lib/runtime');
const { restoreFromZip, MAX_UPLOAD_BYTES } = require('../../../lib/backup');
const { createLogger, createRequestContext } = require('../../../lib/logger');

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
    maxFiles: 1,
    maxFileSize: MAX_UPLOAD_BYTES,
    filename: (_name, _ext, part) => `${crypto.randomUUID()}${path.extname(part?.originalFilename || '').toLowerCase() || '.zip'}`,
  });
  return new Promise((resolve, reject) => {
    form.parse(req, (error, fields, files) => {
      if (error) reject(error);
      else resolve({ fields, files });
    });
  });
}

function getBackupFiles(files) {
  const value = files?.backup;
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

async function removeQuietly(filePath) {
  if (filePath) await fsp.rm(filePath, { force: true }).catch(() => {});
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/backup/restore');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED', request_id: context.request_id });
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    const status = runtime.error?.code === 'DATA_MAINTENANCE' ? 503 : 500;
    return res.status(status).json({ error: runtime.error?.message || '运行时初始化失败', code: runtime.error?.code || 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const uploadDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'notus-backup-upload-'));
  let uploadedPath = '';
  try {
    const { files } = await parseForm(req, uploadDir);
    const uploaded = getBackupFiles(files);
    if (uploaded.length !== 1) return res.status(400).json({ error: '请选择一个备份 ZIP 文件', code: 'BACKUP_FILE_REQUIRED', request_id: context.request_id });
    uploadedPath = uploaded[0].filepath;
    const result = await restoreFromZip(uploadedPath);
    return res.status(200).json({ ...result, request_id: context.request_id });
  } catch (error) {
    logger.error('backup.restore.failed', { error });
    const uploadTooLarge = error?.code === 1016 || error?.httpCode === 413 || /maxFileSize|too large/i.test(String(error?.message || ''));
    const rawCode = String(error?.code || '');
    const controlled = rawCode === 'BACKUP_FILE_REQUIRED' || rawCode.startsWith('BACKUP_') || rawCode.startsWith('DATA_MAINTENANCE');
    const code = uploadTooLarge ? 'BACKUP_INVALID' : (controlled ? rawCode : 'BACKUP_RESTORE_FAILED');
    const status = uploadTooLarge ? 400 : (error.status || (error.code === 'BACKUP_ACTIVE_TASKS' ? 409 : 400));
    return res.status(status).json({
      error: controlled && !uploadTooLarge ? (error.message || '备份还原失败') : '备份还原失败',
      code,
      request_id: context.request_id,
    });
  } finally {
    await removeQuietly(uploadedPath);
    await fsp.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
  }
}
