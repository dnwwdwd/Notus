const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');
const { sha256 } = require('./files');
const { triggerIncrementalIndex, removeFile: removeFileFromIndex } = require('./indexer');
const {
  isPathSafe,
  normalizeAgentPath,
  normalizeAuthorizedPaths,
  resolveInsideNotes,
} = require('./agentPathRules');

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed', 'rolled_back']);
const ACTIVE_STATUSES = new Set(['running', 'waiting_confirm']);
const TOOL_HARD_LIMITS = {};

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === undefined || parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function normalizeOps(ops = []) {
  const set = new Set((Array.isArray(ops) ? ops : []).map((op) => String(op || '').trim()).filter(Boolean));
  set.delete('delete');
  if (set.size === 0) {
    set.add('modify');
    set.add('create');
  }
  return [...set];
}

function normalizeToolProfile(value) {
  return String(value || '').trim() === 'read_only' ? 'read_only' : 'default';
}

function normalizeCreatedFiles(value) {
  const parsed = Array.isArray(value) ? value : safeJsonParse(value, []);
  return (Array.isArray(parsed) ? parsed : []).map((item) => {
    if (typeof item === 'string') return { path: item, hash: '' };
    return {
      path: String(item?.path || item?.file_path || '').replace(/\\/g, '/'),
      hash: String(item?.hash || item?.file_hash || ''),
    };
  }).filter((item) => item.path);
}

function serializeCreatedFiles(files = []) {
  return JSON.stringify(normalizeCreatedFiles(files));
}

function createSession({
  goal,
  authorizedPaths,
  authorizedOps = ['modify', 'create'],
  conversationId = null,
  softLimit = 15,
  hardLimit = 30,
  searchKnowledgeLimit = 5,
  webSearchEnabled = false,
  webSearchProvider = '',
  webSearchMode = '',
  webSearchCount = null,
  toolProfile = 'default',
} = {}) {
  const normalizedGoal = String(goal || '').trim();
  if (!normalizedGoal) throw new Error('goal is required');
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`
    INSERT INTO agent_sessions (
      goal, authorized_paths, authorized_ops, session_token, expires_at,
      soft_limit, hard_limit, search_knowledge_limit, conversation_id,
      web_search_enabled, web_search_provider, web_search_mode, web_search_count, tool_profile, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    normalizedGoal,
    JSON.stringify(normalizeAuthorizedPaths(authorizedPaths)),
    JSON.stringify(normalizeOps(authorizedOps)),
    token,
    expiresAt,
    Math.max(1, Number(softLimit) || 15),
    Math.max(1, Number(hardLimit) || 30),
    searchKnowledgeLimit === null ? null : Math.max(0, Number(searchKnowledgeLimit) || 5),
    normalizePositiveInt(conversationId),
    webSearchEnabled ? 1 : 0,
    String(webSearchProvider || '').trim(),
    String(webSearchMode || '').trim(),
    webSearchCount === null || webSearchCount === undefined ? null : Math.max(1, Number(webSearchCount) || 5),
    normalizeToolProfile(toolProfile)
  );
  return { sessionId: Number(result.lastInsertRowid), token };
}

function formatSession(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    conversation_id: normalizePositiveInt(row.conversation_id),
    authorized_paths: normalizeAuthorizedPaths(safeJsonParse(row.authorized_paths, [])),
    authorized_ops: normalizeOps(safeJsonParse(row.authorized_ops, [])),
    created_files: normalizeCreatedFiles(row.created_files),
    loop_count: Number(row.loop_count || 0),
    soft_limit: Number(row.soft_limit || 15),
    hard_limit: Number(row.hard_limit || 30),
    search_knowledge_limit: row.search_knowledge_limit === null || row.search_knowledge_limit === undefined
      ? null
      : Number(row.search_knowledge_limit),
    web_search_enabled: Boolean(row.web_search_enabled),
    web_search_provider: String(row.web_search_provider || ''),
    web_search_mode: String(row.web_search_mode || ''),
    web_search_count: row.web_search_count === null || row.web_search_count === undefined
      ? null
      : Number(row.web_search_count),
    tool_profile: normalizeToolProfile(row.tool_profile),
    tool_call_counts: safeJsonParse(row.tool_call_counts, {}),
    consecutive_fails: safeJsonParse(row.consecutive_fails, {}),
    last_tool_results: safeJsonParse(row.last_tool_results, {}),
  };
}

function getSession(sessionId) {
  const id = normalizePositiveInt(sessionId);
  if (!id) throw new Error('session_id is required');
  const row = getDb().prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id);
  if (!row) throw new Error(`Session ${id} not found`);
  return formatSession(row);
}

function listSessionsByConversation(conversationId) {
  const id = normalizePositiveInt(conversationId);
  if (!id) return [];
  return getDb().prepare('SELECT * FROM agent_sessions WHERE conversation_id = ? ORDER BY id ASC')
    .all(id)
    .map(formatSession)
    .map(sanitizeSessionForRead);
}

function sanitizeSessionForRead(session) {
  if (!session) return null;
  const {
    session_token: _sessionToken,
    messages_checkpoint: _messagesCheckpoint,
    checkpoint_tool_use_id: _checkpointToolUseId,
    ...safeSession
  } = session;
  return safeSession;
}

function listRecentSessions({ limit = 20, conversationId = null } = {}) {
  const normalizedLimit = Math.min(Math.max(Math.floor(Number(limit) || 20), 1), 100);
  const normalizedConversationId = normalizePositiveInt(conversationId);
  const db = getDb();
  const rows = normalizedConversationId
    ? db.prepare('SELECT * FROM agent_sessions WHERE conversation_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(normalizedConversationId, normalizedLimit)
    : db.prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC, id DESC LIMIT ?').all(normalizedLimit);
  return rows.map(formatSession).map(sanitizeSessionForRead);
}

function updateSessionStatus(sessionId, status) {
  const normalized = String(status || '').trim();
  if (!normalized) throw new Error('status is required');
  const waitingSinceExpr = normalized === 'waiting_confirm' ? 'datetime(\'now\')' : 'NULL';
  getDb().prepare(`
    UPDATE agent_sessions
    SET status = ?, waiting_since = ${waitingSinceExpr}, updated_at = datetime('now')
    WHERE id = ?
  `).run(normalized, normalizePositiveInt(sessionId));
}

function updateSessionLoopCount(sessionId, loopCount) {
  getDb().prepare('UPDATE agent_sessions SET loop_count = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(Math.max(0, Number(loopCount) || 0), normalizePositiveInt(sessionId));
}

function extendHardLimit(sessionId, extraLoops = 10) {
  const increment = Math.max(1, Number(extraLoops) || 10);
  getDb().prepare('UPDATE agent_sessions SET hard_limit = hard_limit + ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(increment, normalizePositiveInt(sessionId));
  return getSession(sessionId);
}

function validateWrite(token, targetPath, operation) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_sessions WHERE session_token = ?').get(String(token || ''));
  if (!row) return { valid: false, reason: 'INVALID_TOKEN' };
  const session = formatSession(row);
  if (session.expires_at && new Date(session.expires_at) < new Date()) return { valid: false, reason: 'TOKEN_EXPIRED' };
  if (!ACTIVE_STATUSES.has(session.status)) return { valid: false, reason: 'SESSION_NOT_ACTIVE' };
  const op = String(operation || '').trim();
  if (op === 'delete') return { valid: false, reason: 'DELETE_NEVER_ALLOWED' };
  if (!session.authorized_ops.includes(op)) return { valid: false, reason: `OPERATION_NOT_AUTHORIZED: ${op}` };
  if (!isPathSafe(targetPath, session.authorized_paths, op)) return { valid: false, reason: `PATH_NOT_AUTHORIZED: ${targetPath}` };
  return { valid: true, session };
}

function validateSessionAccess(sessionId, token) {
  const session = getSession(sessionId);
  if (!token || String(session.session_token || '') !== String(token || '')) {
    return { valid: false, reason: 'INVALID_TOKEN' };
  }
  if (session.expires_at && new Date(session.expires_at) < new Date()) {
    return { valid: false, reason: 'TOKEN_EXPIRED' };
  }
  return { valid: true, session };
}

function listMarkdownFilesUnder(absPath, notesDir) {
  const results = [];
  if (!fs.existsSync(absPath)) return results;
  const stat = fs.statSync(absPath);
  if (stat.isFile()) {
    if (/\.md$/i.test(absPath)) results.push(absPath);
    return results;
  }
  if (!stat.isDirectory()) return results;
  fs.readdirSync(absPath, { withFileTypes: true }).forEach((entry) => {
    if (entry.name.startsWith('.')) return;
    const next = path.join(absPath, entry.name);
    if (entry.isDirectory()) results.push(...listMarkdownFilesUnder(next, notesDir));
    else if (entry.isFile() && /\.md$/i.test(entry.name)) results.push(next);
  });
  return results;
}

async function snapshotFiles(sessionId, notesDir = getEffectiveConfig().notesDir) {
  const session = getSession(sessionId);
  const db = getDb();
  const existing = new Set(db.prepare('SELECT file_path FROM agent_snapshots WHERE session_id = ?').all(session.id).map((row) => row.file_path));
  const files = [];
  session.authorized_paths.forEach((authPath) => {
    const target = resolveInsideNotes(notesDir, authPath, { allowRoot: true });
    listMarkdownFilesUnder(target.absolutePath, notesDir).forEach((absPath) => {
      const relPath = path.relative(path.resolve(notesDir), absPath).replace(/\\/g, '/');
      if (existing.has(relPath)) return;
      const content = fs.readFileSync(absPath, 'utf8');
      files.push({ filePath: relPath, content, hash: sha256(content) });
      existing.add(relPath);
    });
  });
  const insert = db.prepare('INSERT INTO agent_snapshots (session_id, file_path, content, file_hash) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    files.forEach((file) => insert.run(session.id, file.filePath, file.content, file.hash));
  })();
  return { snapshotCount: files.length };
}

function trackCreatedFile(sessionId, filePath, fileHash = '') {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT created_files FROM agent_sessions WHERE id = ?').get(normalizePositiveInt(sessionId));
    const files = normalizeCreatedFiles(row?.created_files);
    const normalizedPath = normalizeAgentPath(filePath, { ensureMarkdown: true });
    const nextHash = String(fileHash || '').trim();
    const existing = files.find((item) => item.path === normalizedPath);
    if (existing) existing.hash = nextHash || existing.hash;
    else files.push({ path: normalizedPath, hash: nextHash });
    db.prepare('UPDATE agent_sessions SET created_files = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(serializeCreatedFiles(files), normalizePositiveInt(sessionId));
  })();
}

async function rollbackSession(sessionId, notesDir = getEffectiveConfig().notesDir, forceDeleteCreated = false) {
  const session = getSession(sessionId);
  const db = getDb();
  const snapshots = db.prepare('SELECT * FROM agent_snapshots WHERE session_id = ? ORDER BY id ASC').all(session.id);
  let restoredCount = 0;
  const errors = [];
  const conflicts = [];
  const restoredPaths = [];
  const deletedPaths = [];

  for (const created of session.created_files) {
    try {
      const target = resolveInsideNotes(notesDir, created.path);
      if (!fs.existsSync(target.absolutePath)) continue;
      const current = fs.readFileSync(target.absolutePath, 'utf8');
      const currentHash = sha256(current);
      if (created.hash && currentHash !== created.hash && !forceDeleteCreated) conflicts.push(created.path);
    } catch (error) {
      errors.push({ path: created.path, error: error.message });
    }
  }

  if ((conflicts.length > 0 || errors.length > 0) && !forceDeleteCreated) {
    return { restored_count: 0, restoredCount: 0, errors, conflicts };
  }

  for (const snap of snapshots) {
    try {
      const target = resolveInsideNotes(notesDir, snap.file_path);
      fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
      fs.writeFileSync(target.absolutePath, snap.content, 'utf8');
      restoredCount += 1;
      restoredPaths.push(snap.file_path);
    } catch (error) {
      errors.push({ path: snap.file_path, error: error.message });
    }
  }

  for (const created of session.created_files) {
    try {
      const target = resolveInsideNotes(notesDir, created.path);
      if (!fs.existsSync(target.absolutePath)) continue;
      fs.unlinkSync(target.absolutePath);
      deletedPaths.push(created.path);
      restoredCount += 1;
    } catch (error) {
      errors.push({ path: created.path, error: error.message });
    }
  }

  restoredPaths.forEach((filePath) => {
    triggerIncrementalIndex(filePath).catch(() => {});
  });
  deletedPaths.forEach((filePath) => {
    try { removeFileFromIndex(filePath); } catch {}
  });

  if (conflicts.length === 0 && errors.length === 0) updateSessionStatus(session.id, 'rolled_back');
  return { restored_count: restoredCount, restoredCount, errors, conflicts };
}

function buildCompactSummary(result) {
  if (result?.error) return `失败：${result.error}`;
  if (Array.isArray(result?.results)) return `检索到 ${result.results.length} 条结果`;
  if (result?.content) return `读取 ${String(result.content).length} 字`;
  if (result?.path || result?.created_path) return `文件：${result.path || result.created_path}`;
  if (result?.operation_set_id) return `预览 ${result.operation_set_id}`;
  return '工具调用已完成';
}

function compactMessagesForStorage(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const keep = list.slice(-6);
  const compact = list.slice(0, -6).map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (block?.type !== 'tool_result') return block;
        const parsed = safeJsonParse(block.content, null);
        if (parsed?.error || block.is_error) return block;
        return { ...block, content: JSON.stringify({ _compacted: true, summary: buildCompactSummary(parsed) }) };
      }),
    };
  });
  return compact.concat(keep);
}

function saveMessagesCheckpoint(sessionId, messages, lastResponseContent, appliedToolUseId) {
  const checkpoint = {
    messages: compactMessagesForStorage(messages),
    last_response_content: lastResponseContent,
    saved_at: new Date().toISOString(),
  };
  getDb().prepare(`
    UPDATE agent_sessions
    SET messages_checkpoint = ?, checkpoint_tool_use_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(checkpoint), String(appliedToolUseId || ''), normalizePositiveInt(sessionId));
}

function loadMessagesCheckpoint(sessionId) {
  const row = getDb().prepare('SELECT messages_checkpoint, checkpoint_tool_use_id FROM agent_sessions WHERE id = ?')
    .get(normalizePositiveInt(sessionId));
  if (!row?.messages_checkpoint) return null;
  const checkpoint = safeJsonParse(row.messages_checkpoint, null);
  if (!checkpoint) return null;
  return {
    messages: Array.isArray(checkpoint.messages) ? checkpoint.messages : [],
    lastResponseContent: checkpoint.last_response_content || [],
    appliedToolUseId: row.checkpoint_tool_use_id || '',
  };
}

function clearMessagesCheckpoint(sessionId) {
  getDb().prepare('UPDATE agent_sessions SET messages_checkpoint = NULL, checkpoint_tool_use_id = NULL WHERE id = ?')
    .run(normalizePositiveInt(sessionId));
}

function checkAndIncrementToolCount(sessionId, toolName) {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT tool_call_counts, search_knowledge_limit FROM agent_sessions WHERE id = ?').get(normalizePositiveInt(sessionId));
    const counts = safeJsonParse(row?.tool_call_counts, {});
    const name = String(toolName || 'unknown');
    const current = Number(counts[name] || 0);
    const limit = name === 'search_knowledge' ? row.search_knowledge_limit : TOOL_HARD_LIMITS[name];
    if (limit !== null && limit !== undefined && current >= Number(limit)) return { allowed: false, count: current };
    counts[name] = current + 1;
    db.prepare('UPDATE agent_sessions SET tool_call_counts = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(counts), normalizePositiveInt(sessionId));
    return { allowed: true, count: current + 1 };
  })();
}

function summarizeToolResult(toolName, result) {
  if (result?.error) return { error: result.error, message: result.message || result.reason || '' };
  switch (toolName) {
    case 'search_knowledge': return { result_count: result?.results?.length || 0, remaining_calls: result?.remaining_calls };
    case 'web_search': return {
      query: result?.query || '',
      provider: result?.provider || '',
      result_count: result?.results?.length || 0,
      context_message_id: result?.context_message_id || null,
    };
    case 'read_file': return { file_path: result?.file_path, char_count: String(result?.content || '').length };
    case 'create_note': return { path: result?.path, created: Boolean(result?.created) };
    case 'preview_patch_files': return { operation_set_id: result?.operation_set_id, patch_count: result?.patch_count || 0 };
    case 'preview_canvas_blocks': return { operation_set_id: result?.operation_set_id, operation_count: result?.operation_count || 0 };
    case 'ask_question_card': return { interaction_id: result?.interaction_id, question_count: result?.question_count || 0 };
    case 'analyze_folder': return { file_count: result?.file_count || 0, total_count: result?.total_count || 0, truncated: Boolean(result?.truncated) };
    case 'check_links': return { orphan_count: result?.orphan_count || 0, broken_count: result?.broken_count || 0 };
    default: return { ok: true };
  }
}

function logToolCall({ sessionId, loopIndex, toolName, toolInput, toolResult, thinking = null, status = 'success', durationMs = 0 } = {}) {
  getDb().prepare(`
    INSERT INTO agent_run_logs (session_id, loop_index, tool_name, tool_input, tool_result, thinking, status, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalizePositiveInt(sessionId),
    Math.max(0, Number(loopIndex) || 0),
    toolName || null,
    JSON.stringify(toolInput || null),
    JSON.stringify(summarizeToolResult(toolName, toolResult)),
    thinking || null,
    String(status || 'success'),
    Math.max(0, Number(durationMs) || 0)
  );
}

function detectDeadloop(sessionId, toolName, toolResult) {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT last_tool_results FROM agent_sessions WHERE id = ?').get(normalizePositiveInt(sessionId));
    const results = safeJsonParse(row?.last_tool_results, {});
    const name = String(toolName || 'unknown');
    const hash = sha256(JSON.stringify(toolResult || null));
    if (!results[name] || results[name].hash !== hash) results[name] = { hash, count: 1 };
    else results[name].count = Number(results[name].count || 0) + 1;
    db.prepare('UPDATE agent_sessions SET last_tool_results = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(results), normalizePositiveInt(sessionId));
    return Number(results[name].count || 0) >= 3;
  })();
}

function recordToolFail(sessionId, toolName) {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT consecutive_fails FROM agent_sessions WHERE id = ?').get(normalizePositiveInt(sessionId));
    const fails = safeJsonParse(row?.consecutive_fails, {});
    const name = String(toolName || 'unknown');
    fails[name] = Number(fails[name] || 0) + 1;
    db.prepare('UPDATE agent_sessions SET consecutive_fails = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(fails), normalizePositiveInt(sessionId));
    return Number(fails[name] || 0) >= 2;
  })();
}

function resetToolFail(sessionId, toolName) {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT consecutive_fails FROM agent_sessions WHERE id = ?').get(normalizePositiveInt(sessionId));
    const fails = safeJsonParse(row?.consecutive_fails, {});
    fails[String(toolName || 'unknown')] = 0;
    db.prepare('UPDATE agent_sessions SET consecutive_fails = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(fails), normalizePositiveInt(sessionId));
  })();
}

function listRunLogs(sessionId) {
  return getDb().prepare('SELECT * FROM agent_run_logs WHERE session_id = ? ORDER BY loop_index ASC, id ASC')
    .all(normalizePositiveInt(sessionId))
    .map((row) => ({
      ...row,
      id: Number(row.id),
      session_id: Number(row.session_id),
      loop_index: Number(row.loop_index),
      tool_input: safeJsonParse(row.tool_input, null),
      tool_result: safeJsonParse(row.tool_result, null),
      duration_ms: Number(row.duration_ms || 0),
    }));
}

function countSnapshots(sessionId) {
  const row = getDb().prepare('SELECT COUNT(*) AS count FROM agent_snapshots WHERE session_id = ?').get(normalizePositiveInt(sessionId));
  return Number(row?.count || 0);
}

function markStaleWaitingSessions(maxAgeMs = 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString().slice(0, 19).replace('T', ' ');
  const result = getDb().prepare(`
    UPDATE agent_sessions
    SET status = 'cancelled', updated_at = datetime('now')
    WHERE status = 'waiting_confirm' AND waiting_since IS NOT NULL AND waiting_since < ?
  `).run(cutoff);
  return Number(result.changes || 0);
}

function ensureSessionActive(sessionId) {
  const session = getSession(sessionId);
  if (TERMINAL_STATUSES.has(session.status)) throw new Error('SESSION_TERMINATED');
  return session;
}

module.exports = {
  createSession,
  getSession,
  listSessionsByConversation,
  listRecentSessions,
  sanitizeSessionForRead,
  updateSessionStatus,
  updateSessionLoopCount,
  extendHardLimit,
  validateWrite,
  validateSessionAccess,
  isPathSafe,
  normalizeAgentPath,
  resolveInsideNotes,
  trackCreatedFile,
  snapshotFiles,
  rollbackSession,
  saveMessagesCheckpoint,
  loadMessagesCheckpoint,
  clearMessagesCheckpoint,
  checkAndIncrementToolCount,
  logToolCall,
  summarizeToolResult,
  detectDeadloop,
  recordToolFail,
  resetToolFail,
  listRunLogs,
  countSnapshots,
  markStaleWaitingSessions,
  ensureSessionActive,
};
