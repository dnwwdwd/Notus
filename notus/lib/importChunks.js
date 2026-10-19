const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getEffectiveConfig } = require('./config');
const { getDb } = require('./db');
const { buildItemKey, normalizeJobId } = require('./importJobs');

// 单文件分片上传：体积超过单次请求上限的 Markdown 拆成多片顺序提交，
// 服务端按 (job_id, item_key, chunk_index) 落盘暂存，齐片后拼接为完整内容再走统一导入链路。
// 分片表与作业账本共同保证幂等：重复片直接跳过，已完成的文件回放既有结果。
const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_CHUNKS = 512;
const STAGING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let lastPrunedAt = 0;

function chunkError(message, code) {
  return Object.assign(new Error(message), { code });
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

// 暂存目录固定在 dataRoot 内（懒猫为 cache），不参与备份清单。
function resolveStagingRoot() {
  const config = getEffectiveConfig();
  const root = config.importStagingDir;
  if (!root) throw chunkError('当前环境未配置分片暂存目录', 'IMPORT_CHUNK_STAGING_UNAVAILABLE');
  return root;
}

function buildStagingPath(jobId, itemKey) {
  const root = resolveStagingRoot();
  // jobId 与 itemKey 都是受控字符集（前者经 normalizeJobId，后者是 sha256 截断），不参与路径穿越。
  return path.join(root, jobId, itemKey);
}

function assertChunkInput({ jobId, itemKey, chunkIndex, totalChunks }) {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw chunkError('chunk_index 必须是从 0 开始的整数', 'IMPORT_CHUNK_INDEX_INVALID');
  }
  if (!Number.isInteger(totalChunks) || totalChunks <= 0 || totalChunks > MAX_TOTAL_CHUNKS) {
    throw chunkError(`total_chunks 必须是 1 到 ${MAX_TOTAL_CHUNKS} 之间的整数`, 'IMPORT_CHUNK_TOTAL_INVALID');
  }
  if (chunkIndex >= totalChunks) {
    throw chunkError('chunk_index 不能大于等于 total_chunks', 'IMPORT_CHUNK_INDEX_INVALID');
  }
  if (!jobId) throw chunkError('分片上传必须携带 job_id', 'IMPORT_CHUNK_JOB_REQUIRED');
  if (!itemKey) throw chunkError('分片上传缺少文件标识', 'IMPORT_CHUNK_ITEM_REQUIRED');
}

function listChunkRecords(jobId, itemKey) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM file_import_chunks WHERE job_id = ? AND item_key = ? ORDER BY chunk_index ASC'
  ).all(jobId, itemKey);
}

function saveChunkRecord({ jobId, itemKey, chunkIndex, totalChunks, bytes, digest }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO file_import_chunks (job_id, item_key, chunk_index, total_chunks, bytes, digest, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(job_id, item_key, chunk_index) DO UPDATE SET
      total_chunks = excluded.total_chunks,
      bytes = excluded.bytes,
      digest = excluded.digest,
      updated_at = excluded.updated_at
  `).run(jobId, itemKey, chunkIndex, totalChunks, bytes, digest);
  return listChunkRecords(jobId, itemKey);
}

// 单片落盘：同一片重复提交时按内容摘要判定，内容一致直接复用，内容不同则以最后一次为准。
function writeChunkFile({ jobId, itemKey, chunkIndex, content }) {
  const stagingDir = buildStagingPath(jobId, itemKey);
  fs.mkdirSync(stagingDir, { recursive: true });
  const chunkPath = path.join(stagingDir, `chunk-${String(chunkIndex).padStart(6, '0')}.part`);
  const buffer = Buffer.from(String(content == null ? '' : content), 'utf8');
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');

  if (fs.existsSync(chunkPath)) {
    const existing = fs.readFileSync(chunkPath);
    if (crypto.createHash('sha256').update(existing).digest('hex') === digest) {
      return { chunkPath, digest, bytes: buffer.length, reused: true };
    }
  }

  const tmpPath = `${chunkPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmpPath, buffer, { flag: 'wx' });
    fs.renameSync(tmpPath, chunkPath);
  } catch (error) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    throw error;
  }
  return { chunkPath, digest, bytes: buffer.length, reused: false };
}

// 齐片后按序拼接为完整文本。缺片时返回缺失索引，交由客户端补齐后续传。
function assembleChunks(jobId, itemKey) {
  const records = listChunkRecords(jobId, itemKey);
  if (records.length === 0) return { complete: false, missing: [], totalChunks: 0, content: '' };

  const totalChunks = Math.max(...records.map((row) => Number(row.total_chunks) || 0));
  const present = new Set(records.map((row) => Number(row.chunk_index)));
  const missing = [];
  for (let index = 0; index < totalChunks; index += 1) {
    if (!present.has(index)) missing.push(index);
  }
  if (missing.length > 0) return { complete: false, missing, totalChunks, content: '' };

  const stagingDir = buildStagingPath(jobId, itemKey);
  const parts = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const chunkPath = path.join(stagingDir, `chunk-${String(index).padStart(6, '0')}.part`);
    if (!fs.existsSync(chunkPath)) return { complete: false, missing: [index], totalChunks, content: '' };
    parts.push(fs.readFileSync(chunkPath));
  }
  return { complete: true, missing: [], totalChunks, content: Buffer.concat(parts).toString('utf8') };
}

function removeStagingItem(jobId, itemKey) {
  const stagingDir = buildStagingPath(jobId, itemKey);
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // 暂存清理失败不影响导入结论，由定期清理兜底。
  }
  const db = getDb();
  db.prepare('DELETE FROM file_import_chunks WHERE job_id = ? AND item_key = ?').run(jobId, itemKey);
}

// 清理孤儿暂存：分片记录超过保留期后同时删除磁盘目录，避免临时文件无限增长。
function pruneImportChunks(now = Date.now()) {
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return 0;
  lastPrunedAt = now;
  const db = getDb();
  const expired = db.prepare(
    `SELECT job_id, item_key FROM file_import_chunks WHERE updated_at < datetime('now', ?) GROUP BY job_id, item_key`
  ).all(`-${Math.floor(STAGING_MAX_AGE_MS / (24 * 60 * 60 * 1000))} days`);

  expired.forEach((row) => {
    try {
      const stagingDir = path.join(resolveStagingRoot(), row.job_id, row.item_key);
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // 忽略单个目录的清理失败。
    }
  });

  const result = db.prepare(
    `DELETE FROM file_import_chunks WHERE updated_at < datetime('now', ?)`
  ).run(`-${Math.floor(STAGING_MAX_AGE_MS / (24 * 60 * 60 * 1000))} days`);
  return result.changes || 0;
}

function resolveChunkRequest({ jobId, parentPath, name, chunkIndex, totalChunks }) {
  const resolvedJobId = normalizeJobId(jobId);
  const itemKey = buildItemKey(parentPath, name);
  assertChunkInput({
    jobId: resolvedJobId,
    itemKey,
    chunkIndex: normalizePositiveInt(chunkIndex, -1) === 0 ? 0 : Number(chunkIndex),
    totalChunks: Number(totalChunks),
  });
  return { resolvedJobId, itemKey };
}

module.exports = {
  DEFAULT_CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  MAX_TOTAL_CHUNKS,
  STAGING_MAX_AGE_MS,
  assembleChunks,
  buildStagingPath,
  listChunkRecords,
  pruneImportChunks,
  removeStagingItem,
  resolveChunkRequest,
  saveChunkRecord,
  writeChunkFile,
};
