const crypto = require('crypto');
const path = require('path');

const OBJECT_STORAGE_PROVIDERS = new Set(['cos', 'oss', 'r2']);
const LONG_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function createObjectStorageError(message, code = 'OBJECT_STORAGE_ERROR', cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function normalizePrefix(value = '') {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return '';
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw createObjectStorageError('对象前缀不能包含空路径、. 或 ..', 'INVALID_OBJECT_STORAGE_CONFIG');
  }
  return segments.join('/');
}

function normalizePublicBaseUrl(value = '') {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw createObjectStorageError('公开访问基础 URL 无效', 'INVALID_OBJECT_STORAGE_CONFIG');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw createObjectStorageError('公开访问基础 URL 只允许 http 或 https 地址', 'INVALID_OBJECT_STORAGE_CONFIG');
  }
  return raw;
}

function normalizeEndpoint(value = '') {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw createObjectStorageError('对象存储 Endpoint 无效', 'INVALID_OBJECT_STORAGE_CONFIG');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw createObjectStorageError('对象存储 Endpoint 只允许 http 或 https 地址', 'INVALID_OBJECT_STORAGE_CONFIG');
  }
  return raw;
}

function normalizeObjectStorageConfig(raw = {}) {
  const config = {
    provider: String(raw.provider || '').trim().toLowerCase(),
    bucket: String(raw.bucket || '').trim(),
    region: String(raw.region || '').trim(),
    endpoint: normalizeEndpoint(raw.endpoint),
    prefix: normalizePrefix(raw.prefix),
    publicBaseUrl: normalizePublicBaseUrl(raw.publicBaseUrl),
    accessKeyId: String(raw.accessKeyId || '').trim(),
    secretAccessKey: String(raw.secretAccessKey || '').trim(),
  };

  if (!OBJECT_STORAGE_PROVIDERS.has(config.provider)) {
    throw createObjectStorageError('请选择腾讯云 COS、阿里云 OSS 或 Cloudflare R2', 'INVALID_OBJECT_STORAGE_CONFIG');
  }
  if (!config.bucket) throw createObjectStorageError('请填写 Bucket 名称', 'INVALID_OBJECT_STORAGE_CONFIG');
  if (!config.accessKeyId || !config.secretAccessKey) {
    throw createObjectStorageError('请填写对象存储 Access Key 与 Secret', 'INVALID_OBJECT_STORAGE_CONFIG');
  }
  if (['cos', 'oss'].includes(config.provider) && !config.region) {
    throw createObjectStorageError('COS 和 OSS 必须填写 Bucket 所在地域', 'INVALID_OBJECT_STORAGE_CONFIG');
  }
  if (config.provider === 'r2' && !config.endpoint) {
    throw createObjectStorageError('Cloudflare R2 必须填写 S3 Endpoint', 'INVALID_OBJECT_STORAGE_CONFIG');
  }
  return config;
}

function mimeToExtension(mimeType, originalName = '') {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const mapping = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
  };
  if (mapping[normalized]) return mapping[normalized];
  const extension = path.extname(String(originalName || '')).replace(/^\./, '').toLowerCase();
  return extension || 'bin';
}

function buildObjectKey({ buffer, mimeType, originalName, prefix = '', now = new Date() }) {
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!content.length) throw createObjectStorageError('图片内容为空', 'INVALID_IMAGE');
  const normalizedPrefix = normalizePrefix(prefix);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const name = `${hash}.${mimeToExtension(mimeType, originalName)}`;
  return [normalizedPrefix, year, month, name].filter(Boolean).join('/');
}

function buildPublicUrl(publicBaseUrl, objectKey) {
  const base = normalizePublicBaseUrl(publicBaseUrl);
  const encodedKey = String(objectKey || '').split('/').map((part) => encodeURIComponent(part)).join('/');
  return `${base}/${encodedKey}`;
}

function uploadWithCos(config, objectKey, buffer, mimeType) {
  const COS = require('cos-nodejs-sdk-v5');
  const client = new COS({ SecretId: config.accessKeyId, SecretKey: config.secretAccessKey });
  return new Promise((resolve, reject) => {
    client.putObject({
      Bucket: config.bucket,
      Region: config.region,
      Key: objectKey,
      Body: buffer,
      ContentType: mimeType,
      Headers: { 'Cache-Control': LONG_CACHE_CONTROL },
    }, (error, result) => (error ? reject(error) : resolve(result)));
  });
}

async function uploadWithOss(config, objectKey, buffer, mimeType) {
  const OSS = require('ali-oss');
  const client = new OSS({
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.secretAccessKey,
    secure: true,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });
  return client.put(objectKey, buffer, {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': LONG_CACHE_CONTROL,
    },
  });
}

async function uploadWithR2(config, objectKey, buffer, mimeType) {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    Body: buffer,
    ContentType: mimeType,
    CacheControl: LONG_CACHE_CONTROL,
  }));
}

async function uploadObjectImage(rawConfig, { buffer, mimeType, originalName = '' } = {}) {
  const config = normalizeObjectStorageConfig(rawConfig);
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const normalizedMimeType = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!normalizedMimeType.startsWith('image/')) {
    throw createObjectStorageError('只支持图片文件', 'UNSUPPORTED_IMAGE_TYPE');
  }
  const objectKey = buildObjectKey({
    buffer: content,
    mimeType: normalizedMimeType,
    originalName,
    prefix: config.prefix,
  });

  try {
    if (config.provider === 'cos') await uploadWithCos(config, objectKey, content, normalizedMimeType);
    if (config.provider === 'oss') await uploadWithOss(config, objectKey, content, normalizedMimeType);
    if (config.provider === 'r2') await uploadWithR2(config, objectKey, content, normalizedMimeType);
  } catch (error) {
    const statusCode = Number(error?.statusCode || error?.$metadata?.httpStatusCode || 0);
    const suffix = statusCode ? `（HTTP ${statusCode}）` : '';
    throw createObjectStorageError(`对象存储上传失败${suffix}`, 'OBJECT_STORAGE_UPLOAD_FAILED', error);
  }

  return {
    provider: config.provider,
    objectKey,
    publicUrl: buildPublicUrl(config.publicBaseUrl, objectKey),
    mimeType: normalizedMimeType,
    contentLength: content.length,
  };
}

module.exports = {
  OBJECT_STORAGE_PROVIDERS,
  LONG_CACHE_CONTROL,
  normalizePrefix,
  normalizeObjectStorageConfig,
  buildObjectKey,
  buildPublicUrl,
  uploadObjectImage,
};
