const crypto = require('crypto');
const { getDb } = require('./db');

// 分批导入的作业账本：客户端为一次导入生成一个 job_id，服务端按 (job_id, item_key)
// 记录每个文件的最终结果，使重复提交、断线重试和失败项重试都能幂等收口。
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const JOB_MAX_AGE_DAYS = 7;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let lastPrunedAt = 0;

function normalizeJobId(value) {
  const jobId = String(value || '').trim();
  if (!jobId) return '';
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw Object.assign(new Error('job_id 格式无效'), { code: 'IMPORT_JOB_ID_INVALID' });
  }
  return jobId;
}

// item_key 只由父目录与显示名决定，因此同一文件在第几批、第几次重试都落到同一条记录。
function buildItemKey(parentPath, name) {
  return crypto
    .createHash('sha256')
    .update(`${String(parentPath || '')}\n${String(name || '')}`)
    .digest('hex')
    .slice(0, 32);
}

function getJobRecord(jobId, itemKey) {
  const db = getDb();
  return db.prepare('SELECT * FROM file_import_jobs WHERE job_id = ? AND item_key = ?').get(jobId, itemKey) || null;
}

function saveJobRecord({ jobId, itemKey, parentPath = '', name = '', status, path = '', warning = '', warningCode = '' }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO file_import_jobs (job_id, item_key, parent_path, name, status, path, warning, warning_code, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(job_id, item_key) DO UPDATE SET
      status = excluded.status,
      path = excluded.path,
      warning = excluded.warning,
      warning_code = excluded.warning_code,
      updated_at = excluded.updated_at
  `).run(jobId, itemKey, String(parentPath || ''), String(name || ''), String(status || 'imported'), String(path || ''), String(warning || ''), String(warningCode || ''));
  return getJobRecord(jobId, itemKey);
}

function pruneImportJobs(now = Date.now()) {
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return 0;
  lastPrunedAt = now;
  const db = getDb();
  const result = db.prepare(
    `DELETE FROM file_import_jobs WHERE updated_at < datetime('now', ?)`
  ).run(`-${JOB_MAX_AGE_DAYS} days`);
  return result.changes || 0;
}

module.exports = {
  JOB_ID_PATTERN,
  JOB_MAX_AGE_DAYS,
  normalizeJobId,
  buildItemKey,
  getJobRecord,
  saveJobRecord,
  pruneImportJobs,
};
