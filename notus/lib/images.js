const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const crypto = require('crypto');
const { getDb, isVecAvailable } = require('./db');
const { getEffectiveConfig } = require('./config');
const { getFileById } = require('./files');
const { getImageEmbedding, supportsImageEmbedding } = require('./embeddings');

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const CACHE_DIR_NAME = 'images';

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildImageProxyUrl(fileId, src) {
  return `/api/files/${fileId}/content-image?src=${encodeURIComponent(src)}`;
}

function isPrivateIpv4(ip) {
  return ip.startsWith('10.') ||
    ip.startsWith('127.') ||
    ip.startsWith('169.254.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip) ||
    ip === '0.0.0.0';
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();
  return normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:');
}

function isPrivateIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

async function assertPublicRemoteUrl(src) {
  let target;
  try {
    target = new URL(src);
  } catch {
    throw new Error('图片地址无效');
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('只允许 http/https 图片地址');
  }
  if (target.username || target.password) {
    throw new Error('图片地址不允许携带用户名或密码');
  }

  const hostname = target.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('不允许访问本机或局域网地址');
  }

  if (net.isIP(hostname) && isPrivateIp(hostname)) {
    throw new Error('不允许访问内网地址');
  }

  const records = await dns.lookup(hostname, { all: true }).catch(() => []);
  if (records.some((record) => isPrivateIp(record.address))) {
    throw new Error('不允许访问内网地址');
  }

  return target;
}

function mimeToExtension(mimeType, fallbackPath = '') {
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
  const ext = path.extname(String(fallbackPath || '')).replace(/^\./, '').toLowerCase();
  return ext || 'bin';
}

function assetRelativePathFromBuffer(buffer, mimeType, originalPathname = '') {
  const hash = sha256Buffer(buffer);
  const ext = mimeToExtension(mimeType, originalPathname);
  return `${CACHE_DIR_NAME}/${hash}.${ext}`;
}

function assetAbsolutePath(relativePath) {
  return path.join(getEffectiveConfig().assetsDir, relativePath);
}

function updateImageRecordById(id, values) {
  if (!id) return;
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([key]) => `${key} = ?`).join(', ');
  getDb().prepare(`UPDATE images SET ${setClause} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
}

function touchImagesByUrl(url, values) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return;
  const setClause = entries.map(([key]) => `${key} = ?`).join(', ');
  getDb().prepare(`UPDATE images SET ${setClause} WHERE url = ?`).run(...entries.map(([, value]) => value), url);
}

function getImageRecord(fileId, src) {
  const normalizedFileId = Number(fileId);
  if (!Number.isFinite(normalizedFileId)) return null;
  return getDb().prepare(`
    SELECT
      i.*,
      c.file_id
    FROM images i
    JOIN chunks c ON c.id = i.chunk_id
    WHERE c.file_id = ? AND i.url = ?
    ORDER BY i.id ASC
    LIMIT 1
  `).get(normalizedFileId, String(src || ''));
}

function getPendingImagesForFile(fileId) {
  return getDb().prepare(`
    SELECT i.*
    FROM images i
    JOIN chunks c ON c.id = i.chunk_id
    WHERE c.file_id = ?
    ORDER BY i.id ASC
  `).all(Number(fileId));
}

function deleteImageVectorsByFileId(fileId) {
  if (!isVecAvailable()) return;
  const rows = getDb().prepare(`
    SELECT i.id
    FROM images i
    JOIN chunks c ON c.id = i.chunk_id
    WHERE c.file_id = ?
  `).all(Number(fileId));
  const stmt = getDb().prepare('DELETE FROM images_vec WHERE image_id = ?');
  rows.forEach((row) => stmt.run(BigInt(row.id)));
}

async function readResponseBuffer(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const buffer = Buffer.from(value);
    size += buffer.length;
    if (size > MAX_IMAGE_BYTES) {
      throw new Error('图片体积超过上限');
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

async function downloadImage(src) {
  const parsedUrl = await assertPublicRemoteUrl(src);
  const response = await fetch(parsedUrl.toString(), {
    method: 'GET',
    redirect: 'follow',
    headers: { Accept: 'image/*' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`图片下载失败：${response.status}`);
  }

  const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!mimeType.startsWith('image/')) {
    throw new Error('远端资源不是图片');
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_IMAGE_BYTES) {
    throw new Error('图片体积超过上限');
  }

  const buffer = await readResponseBuffer(response);
  const relativePath = assetRelativePathFromBuffer(buffer, mimeType, parsedUrl.pathname);
  const absolutePath = assetAbsolutePath(relativePath);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  if (!fs.existsSync(absolutePath)) {
    fs.writeFileSync(absolutePath, buffer);
  }

  return {
    buffer,
    mimeType,
    contentLength: buffer.length,
    relativePath,
    absolutePath,
  };
}

async function ensureImageCached(recordOrOptions) {
  const image = recordOrOptions || {};
  if (image.local_path) {
    const absolutePath = assetAbsolutePath(image.local_path);
    if (fs.existsSync(absolutePath)) {
      return {
        absolutePath,
        relativePath: image.local_path,
        mimeType: image.mime_type || 'image/*',
        contentLength: image.content_length || fs.statSync(absolutePath).size,
      };
    }
  }

  const download = await downloadImage(image.url);
  const now = new Date().toISOString();
  if (image.id) {
    updateImageRecordById(image.id, {
      local_path: download.relativePath,
      status: 'done',
      processed_at: now,
      cache_status: 'done',
      cache_error: null,
      mime_type: download.mimeType,
      content_length: download.contentLength,
      cached_at: now,
    });
  }
  touchImagesByUrl(image.url, {
    local_path: download.relativePath,
    status: 'done',
    processed_at: now,
    cache_status: 'done',
    cache_error: null,
    mime_type: download.mimeType,
    content_length: download.contentLength,
    cached_at: now,
  });

  return download;
}

async function ensureImageEmbedded(record) {
  if (!record?.id || !isVecAvailable()) return null;

  const config = getEffectiveConfig();
  if (!config.embeddingMultimodalEnabled || !supportsImageEmbedding(config)) {
    updateImageRecordById(record.id, {
      embedding_status: 'skipped',
      embedding_error: null,
    });
    return null;
  }

  const cache = await ensureImageCached(record);
  const embedding = await getImageEmbedding({
    absolutePath: cache.absolutePath,
    mimeType: cache.mimeType,
    sourceUrl: record.url,
  }, config);

  getDb().prepare(`
    DELETE FROM images_vec WHERE image_id = ?
  `).run(BigInt(record.id));
  getDb().prepare(`
    INSERT INTO images_vec (image_id, embedding)
    VALUES (?, ?)
  `).run(BigInt(record.id), JSON.stringify(embedding));

  updateImageRecordById(record.id, {
    embedding_status: 'done',
    embedding_error: null,
    embedded_at: new Date().toISOString(),
  });

  return embedding;
}

async function processImageRecord(record) {
  try {
    const cache = await ensureImageCached(record);
    const nextRecord = {
      ...record,
      local_path: cache.relativePath,
      mime_type: cache.mimeType,
      content_length: cache.contentLength,
    };
    await ensureImageEmbedded(nextRecord);
    return { id: record.id, url: record.url, cached: true, embedded: true };
  } catch (error) {
    if (record?.id) {
      updateImageRecordById(record.id, {
        status: 'failed',
        cache_status: 'failed',
        cache_error: error.message,
      });
      updateImageRecordById(record.id, {
        embedding_status: 'failed',
        embedding_error: error.message,
      });
    }
    return { id: record?.id || null, url: record?.url || '', cached: false, embedded: false, error: error.message };
  }
}

async function processImagesForFile(fileId) {
  const rows = getPendingImagesForFile(fileId);
  const results = [];
  for (const row of rows) {
    results.push(await processImageRecord(row));
  }
  return results;
}

async function ensureImageAvailableForRequest(fileId, src) {
  if (!getFileById(fileId)) {
    throw new Error('File not found');
  }

  const record = getImageRecord(fileId, src) || { id: null, url: src, local_path: null };
  const cache = await ensureImageCached(record);

  if (record.id) {
    await ensureImageEmbedded({
      ...record,
      local_path: cache.relativePath,
      mime_type: cache.mimeType,
      content_length: cache.contentLength,
    }).catch(() => null);
  }

  return cache;
}

module.exports = {
  MAX_IMAGE_BYTES,
  buildImageProxyUrl,
  downloadImage,
  getImageRecord,
  deleteImageVectorsByFileId,
  processImagesForFile,
  ensureImageAvailableForRequest,
};
