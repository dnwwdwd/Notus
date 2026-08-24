const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');
const { normalizeUsage, sumUsageRecords } = require('./llmBudget');

const DEFAULT_CAPABILITY_TTL_MS = 15 * 60 * 1000;
const DEFAULT_LEASE_MS = 90 * 1000;
const activeRuns = new Map();

function toPositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function capabilityKeyPath() {
  return path.join(getEffectiveConfig().dataRoot, 'secrets', 'agent-capability.key');
}

function getCapabilityKey() {
  const file = capabilityKeyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw Object.assign(new Error('Agent 恢复票据密钥不可用'), { code: 'AGENT_CAPABILITY_KEY_INVALID' });
  return key;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value) {
  return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
}

function sign(encodedPayload) {
  return crypto.createHmac('sha256', getCapabilityKey()).update(encodedPayload).digest('base64url');
}

function nonceHash(nonce) {
  return crypto.createHash('sha256').update(String(nonce || '')).digest('hex');
}

function issueCapability({ sessionId, interactionId = null, resumeJobId = null, action = 'resume', ownerId = null, ttlMs = DEFAULT_CAPABILITY_TTL_MS } = {}) {
  const sid = toPositiveInt(sessionId);
  if (!sid) throw Object.assign(new Error('session_id is required'), { code: 'SESSION_ID_REQUIRED' });
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAtMs = Date.now() + Math.max(30_000, Number(ttlMs) || DEFAULT_CAPABILITY_TTL_MS);
  const payload = {
    v: 1,
    sid,
    iid: toPositiveInt(interactionId),
    jid: resumeJobId ? String(resumeJobId) : null,
    action: String(action || 'resume'),
    owner: ownerId ? String(ownerId) : null,
    exp: expiresAtMs,
    nonce,
  };
  const encoded = encode(payload);
  const db = getDb();
  db.prepare("DELETE FROM agent_capabilities WHERE expires_at <= datetime('now') OR (consumed_at IS NOT NULL AND consumed_at <= datetime('now', '-1 day'))").run();
  db.prepare(`
    INSERT INTO agent_capabilities (
      nonce_hash, session_id, interaction_id, resume_job_id, owner_id, action, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    nonceHash(nonce),
    sid,
    payload.iid,
    payload.jid,
    payload.owner,
    payload.action,
    new Date(expiresAtMs).toISOString()
  );
  return `${encoded}.${sign(encoded)}`;
}

function validateCapability(token, expected = {}, { consume = false } = {}) {
  const [encoded, signature] = String(token || '').split('.');
  if (!encoded || !signature) return { valid: false, reason: 'CAPABILITY_REQUIRED' };
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(sign(encoded));
  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) {
    return { valid: false, reason: 'CAPABILITY_INVALID' };
  }
  let payload;
  try { payload = decode(encoded); } catch { return { valid: false, reason: 'CAPABILITY_INVALID' }; }
  if (Number(payload.exp || 0) <= Date.now()) return { valid: false, reason: 'CAPABILITY_EXPIRED' };
  if (expected.sessionId && Number(payload.sid) !== Number(expected.sessionId)) return { valid: false, reason: 'CAPABILITY_SCOPE_MISMATCH' };
  if (expected.interactionId && Number(payload.iid) !== Number(expected.interactionId)) return { valid: false, reason: 'CAPABILITY_SCOPE_MISMATCH' };
  if (expected.resumeJobId && String(payload.jid || '') !== String(expected.resumeJobId)) return { valid: false, reason: 'CAPABILITY_SCOPE_MISMATCH' };
  if (expected.action && String(payload.action || '') !== String(expected.action)) return { valid: false, reason: 'CAPABILITY_ACTION_MISMATCH' };
  if (expected.ownerId && String(payload.owner || '') !== String(expected.ownerId)) return { valid: false, reason: 'CAPABILITY_OWNER_MISMATCH' };

  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_capabilities WHERE nonce_hash = ?').get(nonceHash(payload.nonce));
  if (!row) return { valid: false, reason: 'CAPABILITY_INVALID' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { valid: false, reason: 'CAPABILITY_EXPIRED' };
  let consumed = Boolean(row.consumed_at);
  if (consume && !consumed) {
    const result = db.prepare("UPDATE agent_capabilities SET consumed_at = datetime('now') WHERE nonce_hash = ? AND consumed_at IS NULL")
      .run(row.nonce_hash);
    // 并发消费时只有一个请求能把 NULL 改为时间；其余请求按重复消费处理，
    // 由 interaction_id 的唯一 resume job 返回同一个幂等结果。
    consumed = !result.changes;
  }
  return { valid: true, payload, consumed };
}

function createOrGetResumeJob({ sessionId, interactionId, ownerId = null } = {}) {
  const sid = toPositiveInt(sessionId);
  const iid = toPositiveInt(interactionId);
  if (!sid || !iid) throw Object.assign(new Error('session_id and interaction_id are required'), { code: 'RESUME_JOB_INPUT_INVALID' });
  const db = getDb();
  return db.transaction(() => {
    let job = db.prepare('SELECT * FROM agent_resume_jobs WHERE interaction_id = ?').get(iid);
    if (!job) {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO agent_resume_jobs (id, session_id, interaction_id, owner_id)
        VALUES (?, ?, ?, ?)
      `).run(id, sid, iid, ownerId ? String(ownerId) : null);
      job = db.prepare('SELECT * FROM agent_resume_jobs WHERE id = ?').get(id);
    }
    db.prepare(`
      UPDATE agent_sessions
      SET status = 'queued_resume', state_version = state_version + 1, updated_at = datetime('now')
      WHERE id = ? AND status IN ('waiting_interaction', 'queued_resume')
    `).run(sid);
    // 提问卡回答仅唤醒持久化任务；是否能执行仍由同会话 FIFO 队列判断。
    try { require('./agentTaskQueue').wakeTask(sid); } catch {}
    return job;
  })();
}

function formatResumeJob(row) {
  if (!row) return null;
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch {}
  return {
    id: String(row.id),
    session_id: Number(row.session_id),
    interaction_id: Number(row.interaction_id),
    owner_id: row.owner_id || null,
    status: String(row.status),
    run_id: row.run_id || null,
    attempt_count: Number(row.attempt_count || 0),
    result,
    error_code: row.error_code || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

function getResumeJob(id) {
  return formatResumeJob(getDb().prepare('SELECT * FROM agent_resume_jobs WHERE id = ?').get(String(id || '')));
}

function listResumeJobsByConversation(conversationId) {
  const id = toPositiveInt(conversationId);
  if (!id) return [];
  return getDb().prepare(`
    SELECT jobs.* FROM agent_resume_jobs jobs
    INNER JOIN agent_sessions sessions ON sessions.id = jobs.session_id
    WHERE sessions.conversation_id = ?
    ORDER BY jobs.created_at ASC
  `).all(id).map(formatResumeJob);
}

function recoverStaleRunLeases({ conversationId = null } = {}) {
  const cid = toPositiveInt(conversationId);
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare(`
      SELECT id, active_run_id, lease_expires_at, state_version FROM agent_sessions
      WHERE status = 'running'
        AND (? IS NULL OR conversation_id = ?)
    `).all(cid, cid);
    const now = Date.now();
    const staleRows = rows.filter((row) => {
      const expiresAt = Date.parse(String(row.lease_expires_at || ''));
      const expired = !Number.isFinite(expiresAt) || expiresAt <= now;
      const activeRun = row.active_run_id ? activeRuns.get(String(row.active_run_id)) : null;
      const orphaned = !activeRun || activeRun.signal?.aborted;
      return expired || orphaned;
    });
    if (staleRows.length === 0) return [];
    const update = db.prepare(`
      UPDATE agent_sessions
      SET status = 'queued_resume', active_run_id = NULL, lease_expires_at = NULL,
          state_version = state_version + 1, updated_at = datetime('now')
      WHERE id = ? AND status = 'running' AND state_version = ?
    `);
    const recovered = [];
    for (const row of staleRows) {
      if (!update.run(row.id, Number(row.state_version || 0)).changes) continue;
      if (row.active_run_id) activeRuns.delete(String(row.active_run_id));
      recovered.push(Number(row.id));
    }
    return recovered;
  })();
}

function acquireRunLease(sessionId, { runId = crypto.randomUUID(), leaseMs = DEFAULT_LEASE_MS, allowedStatuses = ['created', 'queued_resume', 'running', 'waiting_retry', 'waiting_model_recovery'] } = {}) {
  const sid = toPositiveInt(sessionId);
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS)).toISOString();
  return db.transaction(() => {
    const session = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sid);
    if (!session) return { acquired: false, reason: 'SESSION_NOT_FOUND' };
    const leaseExpired = !session.lease_expires_at || new Date(session.lease_expires_at).getTime() <= now.getTime();
    const resumableHandoff = ['queued_resume', 'waiting_retry', 'waiting_model_recovery'].includes(session.status);
    if (!allowedStatuses.includes(session.status)) return { acquired: false, reason: 'SESSION_NOT_RESUMABLE', session };
    // Loop 会先把 session 写入可恢复等待态，再由 API Route 的 finally 释放 lease。
    // 这段极短的收尾窗口不代表仍有模型或工具在执行，可以由新 run 直接接管。
    // status 仍为 running 时继续严格拒绝第二个执行者，保留真实并发保护。
    if (session.active_run_id && session.active_run_id !== runId && !leaseExpired && !resumableHandoff) {
      return { acquired: false, reason: 'SESSION_RUN_CONFLICT', session };
    }
    const result = db.prepare(`
      UPDATE agent_sessions
      SET active_run_id = ?, lease_expires_at = ?, status = 'running', cancel_requested_at = NULL,
          last_tool_results = '{}', consecutive_fails = '{}',
          state_version = state_version + 1, updated_at = datetime('now')
      WHERE id = ? AND state_version = ?
    `).run(runId, expiresAt, sid, Number(session.state_version || 0));
    if (!result.changes) return { acquired: false, reason: 'SESSION_STATE_CONFLICT' };
    if (resumableHandoff && session.active_run_id && session.active_run_id !== runId) {
      activeRuns.delete(String(session.active_run_id));
    }
    return { acquired: true, runId, expiresAt, stateVersion: Number(session.state_version || 0) + 1 };
  })();
}

function renewRunLease(sessionId, runId, leaseMs = DEFAULT_LEASE_MS) {
  const expiresAt = new Date(Date.now() + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS)).toISOString();
  const db = getDb();
  return db.transaction(() => {
    const sid = toPositiveInt(sessionId);
    const row = db.prepare(`
      SELECT state_version FROM agent_sessions
      WHERE id = ? AND active_run_id = ? AND status = 'running'
    `).get(sid, String(runId || ''));
    if (!row) return { renewed: false, expiresAt, reason: 'SESSION_RUN_CONFLICT' };
    const result = db.prepare(`
      UPDATE agent_sessions
      SET lease_expires_at = ?, state_version = state_version + 1, updated_at = datetime('now')
      WHERE id = ? AND active_run_id = ? AND status = 'running' AND state_version = ?
    `).run(expiresAt, sid, String(runId || ''), Number(row.state_version || 0));
    return {
      renewed: Boolean(result.changes),
      expiresAt,
      reason: result.changes ? null : 'SESSION_STATE_CONFLICT',
      stateVersion: result.changes ? Number(row.state_version || 0) + 1 : Number(row.state_version || 0),
    };
  })();
}

function releaseRunLease(sessionId, runId, status = null) {
  const normalizedStatus = status ? String(status) : null;
  const result = getDb().prepare(`
    UPDATE agent_sessions
    SET active_run_id = NULL, lease_expires_at = NULL,
        status = COALESCE(?, status), state_version = state_version + 1, updated_at = datetime('now')
    WHERE id = ? AND active_run_id = ?
  `).run(normalizedStatus, toPositiveInt(sessionId), String(runId || ''));
  activeRuns.delete(String(runId || ''));
  return Boolean(result.changes);
}

function registerActiveRun(runId, controller) {
  if (runId && controller) activeRuns.set(String(runId), controller);
}

function requestCancellation(sessionId) {
  const sid = toPositiveInt(sessionId);
  const db = getDb();
  const session = db.prepare('SELECT active_run_id, status FROM agent_sessions WHERE id = ?').get(sid);
  const inactiveSession = !session?.active_run_id;
  db.prepare(`
    UPDATE agent_sessions
    SET cancel_requested_at = datetime('now'),
        status = CASE
          WHEN ? AND status NOT IN ('completed', 'cancelled', 'failed', 'rolled_back') THEN 'cancelled'
          ELSE status
        END,
        active_run_id = CASE WHEN ? THEN NULL ELSE active_run_id END,
        lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END,
        state_version = CASE WHEN ? THEN state_version + 1 ELSE state_version END,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(inactiveSession ? 1 : 0, inactiveSession ? 1 : 0, inactiveSession ? 1 : 0, inactiveSession ? 1 : 0, sid);
  const controller = session?.active_run_id ? activeRuns.get(String(session.active_run_id)) : null;
  if (controller && !controller.signal.aborted) controller.abort('cancel');
  return { requested: true, active: Boolean(controller), runId: session?.active_run_id || null };
}

function isCancellationRequested(sessionId) {
  return Boolean(getDb().prepare('SELECT cancel_requested_at FROM agent_sessions WHERE id = ?').get(toPositiveInt(sessionId))?.cancel_requested_at);
}

function updateResumeJob(id, updates = {}) {
  const sets = [];
  const values = [];
  const add = (sql, value) => { sets.push(sql); values.push(value); };
  if (updates.status) add('status = ?', String(updates.status));
  if (Object.prototype.hasOwnProperty.call(updates, 'runId')) add('run_id = ?', updates.runId || null);
  if (Object.prototype.hasOwnProperty.call(updates, 'result')) add('result_json = ?', updates.result ? JSON.stringify(updates.result) : null);
  if (Object.prototype.hasOwnProperty.call(updates, 'errorCode')) add('error_code = ?', updates.errorCode || null);
  if (updates.incrementAttempt) sets.push('attempt_count = attempt_count + 1');
  if (updates.started) sets.push("started_at = COALESCE(started_at, datetime('now'))");
  if (updates.finished) sets.push("finished_at = datetime('now')");
  if (sets.length === 0) return getResumeJob(id);
  sets.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE agent_resume_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, String(id || ''));
  return getResumeJob(id);
}

function recordRunUsage({ sessionId, runId = null, loopIndex = null, sourceType = 'llm', provider = '', model = '', usage = null, usageSource = 'provider' } = {}) {
  const normalized = normalizeUsage(usage) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  getDb().prepare(`
    INSERT INTO agent_run_usage (
      session_id, run_id, loop_index, source_type, provider, model,
      prompt_tokens, completion_tokens, total_tokens, usage_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    toPositiveInt(sessionId), runId || null, toPositiveInt(loopIndex), String(sourceType),
    String(provider || ''), String(model || ''), normalized.prompt_tokens,
    normalized.completion_tokens, normalized.total_tokens, String(usageSource || 'provider')
  );
  return normalized;
}

function getSessionUsage(sessionId) {
  const rows = getDb().prepare(`
    SELECT prompt_tokens, completion_tokens, total_tokens FROM agent_run_usage
    WHERE session_id = ? ORDER BY id ASC
  `).all(toPositiveInt(sessionId));
  return sumUsageRecords(rows);
}

module.exports = {
  DEFAULT_CAPABILITY_TTL_MS,
  DEFAULT_LEASE_MS,
  acquireRunLease,
  createOrGetResumeJob,
  getResumeJob,
  getSessionUsage,
  isCancellationRequested,
  issueCapability,
  listResumeJobsByConversation,
  recoverStaleRunLeases,
  recordRunUsage,
  registerActiveRun,
  releaseRunLease,
  renewRunLease,
  requestCancellation,
  updateResumeJob,
  validateCapability,
};
