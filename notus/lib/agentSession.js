const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { getEffectiveConfig } = require('./config');
const { sha256 } = require('./files');
const { triggerIncrementalIndex, removeFile: removeFileFromIndex } = require('./indexer');
const { redactSecrets } = require('./agentToolPolicy');
const {
  isPathSafe,
  normalizeAgentPath,
  normalizeAuthorizedPaths,
  resolveInsideNotes,
} = require('./agentPathRules');

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed', 'rolled_back']);
const ACTIVE_STATUSES = new Set(['created', 'running', 'waiting_interaction', 'queued_resume', 'waiting_limit_confirmation']);

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

function normalizeMcpSelection(value) {
  if (value?.mode === 'auto') return { mode: 'auto' };
  if (value?.mode === 'server' && String(value.serverId || '').trim()) return { mode: 'server', serverId: String(value.serverId).trim() };
  return { mode: 'off' };
}

function normalizeMcpSessionPermissions(value) {
  return value?.allow_local_http === true ? { allow_local_http: true } : {};
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
  skillMentions = [],
  mcpSelection = { mode: 'off' },
  mcpSessionPermissions = {},
  promptVersion = 'agent-loop-v2',
  tokenBudgetTotal = null,
} = {}) {
  const normalizedGoal = String(goal || '').trim();
  if (!normalizedGoal) throw new Error('goal is required');
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`
    INSERT INTO agent_sessions (
      status, goal, authorized_paths, authorized_ops, session_token, expires_at,
      soft_limit, hard_limit, search_knowledge_limit, conversation_id,
      web_search_enabled, web_search_provider, web_search_mode, web_search_count, tool_profile,
      skill_mentions_json, mcp_selection_json, mcp_session_permissions_json,
      prompt_version, token_budget_total, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    'created',
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
    normalizeToolProfile(toolProfile),
    JSON.stringify(Array.isArray(skillMentions) ? skillMentions.map(String).filter(Boolean) : []),
    JSON.stringify(normalizeMcpSelection(mcpSelection)),
    JSON.stringify(normalizeMcpSessionPermissions(mcpSessionPermissions)),
    String(promptVersion || 'agent-loop-v2'),
    tokenBudgetTotal === null || tokenBudgetTotal === undefined ? null : Math.max(1, Number(tokenBudgetTotal) || 1)
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
    skill_mentions: safeJsonParse(row.skill_mentions_json, []),
    mcp_selection: normalizeMcpSelection(safeJsonParse(row.mcp_selection_json, { mode: 'off' })),
    mcp_session_permissions: normalizeMcpSessionPermissions(safeJsonParse(row.mcp_session_permissions_json, {})),
    tool_call_counts: safeJsonParse(row.tool_call_counts, {}),
    consecutive_fails: safeJsonParse(row.consecutive_fails, {}),
    last_tool_results: safeJsonParse(row.last_tool_results, {}),
    research_state: safeJsonParse(row.research_state_json, { version: 1, sources: {} }),
    state_version: Number(row.state_version || 0),
    active_run_id: row.active_run_id || null,
    lease_expires_at: row.lease_expires_at || null,
    cancel_requested_at: row.cancel_requested_at || null,
    last_committed_checkpoint_id: normalizePositiveInt(row.last_committed_checkpoint_id),
    prompt_version: String(row.prompt_version || 'legacy-v1'),
    toolset_version: String(row.toolset_version || ''),
    token_budget_total: row.token_budget_total === null || row.token_budget_total === undefined ? null : Number(row.token_budget_total),
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
    research_state: _researchState,
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
  const requested = String(status || '').trim();
  const normalized = requested === 'waiting_confirm' ? 'waiting_interaction' : requested;
  if (!normalized) throw new Error('status is required');
  const waitingSinceExpr = ['waiting_interaction', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery'].includes(normalized) ? 'datetime(\'now\')' : 'NULL';
  getDb().prepare(`
    UPDATE agent_sessions
    SET status = ?, waiting_since = ${waitingSinceExpr}, state_version = state_version + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(normalized, normalizePositiveInt(sessionId));
}

function updateSessionLoopCount(sessionId, loopCount) {
  getDb().prepare('UPDATE agent_sessions SET loop_count = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(Math.max(0, Number(loopCount) || 0), normalizePositiveInt(sessionId));
}

function setSessionWriteTarget(sessionId, target = null) {
  const id = normalizePositiveInt(sessionId);
  if (!id) throw new Error('session_id is required');
  const row = getDb().prepare('SELECT research_state_json FROM agent_sessions WHERE id = ?').get(id);
  const state = safeJsonParse(row?.research_state_json, { version: 1, sources: {} });
  state.write_target = target && typeof target === 'object' ? {
    mode: String(target.mode || '').trim() === 'new' ? 'new' : 'modify',
    file_path: String(target.file_path || '').replace(/\\/g, '/').trim(),
    operation_set_id: normalizePositiveInt(target.operation_set_id),
  } : null;
  getDb().prepare("UPDATE agent_sessions SET research_state_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(state), id);
  return getSession(id);
}

function setSessionMcpPermission(sessionId, permissionKey, permission) {
  const id = normalizePositiveInt(sessionId);
  if (!id || !String(permissionKey || '').trim()) throw new Error('MCP permission key is required');
  const row = getDb().prepare('SELECT mcp_session_permissions_json FROM agent_sessions WHERE id = ?').get(id);
  const permissions = safeJsonParse(row?.mcp_session_permissions_json, {});
  permissions[String(permissionKey)] = String(permission || 'deny');
  getDb().prepare("UPDATE agent_sessions SET mcp_session_permissions_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(permissions), id);
  return getSession(id);
}

function consumeSessionMcpPermission(sessionId, permissionKey) {
  const id = normalizePositiveInt(sessionId);
  const key = String(permissionKey || '');
  const row = getDb().prepare('SELECT mcp_session_permissions_json FROM agent_sessions WHERE id = ?').get(id);
  const permissions = safeJsonParse(row?.mcp_session_permissions_json, {});
  if (permissions[key] !== 'allow_once') return false;
  delete permissions[key];
  getDb().prepare("UPDATE agent_sessions SET mcp_session_permissions_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(permissions), id);
  return true;
}

function extendHardLimit(sessionId, extraLoops = 10) {
  const increment = Math.max(1, Number(extraLoops) || 10);
  getDb().prepare('UPDATE agent_sessions SET hard_limit = hard_limit + ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(increment, normalizePositiveInt(sessionId));
  return getSession(sessionId);
}

function extendTokenBudget(sessionId, ratio = 0.25) {
  const id = normalizePositiveInt(sessionId);
  const row = getDb().prepare('SELECT token_budget_total FROM agent_sessions WHERE id = ?').get(id);
  const current = Math.max(1, Number(row?.token_budget_total) || 1);
  const increment = Math.max(1, Math.floor(current * Math.max(0.05, Number(ratio) || 0.25)));
  getDb().prepare(`
    UPDATE agent_sessions
    SET token_budget_total = token_budget_total + ?, status = 'queued_resume',
        state_version = state_version + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(increment, id);
  return getSession(id);
}

function setSessionRuntimeVersions(sessionId, { promptVersion, toolsetVersion, tokenBudgetTotal } = {}) {
  const id = normalizePositiveInt(sessionId);
  const sets = [];
  const values = [];
  if (promptVersion) { sets.push('prompt_version = ?'); values.push(String(promptVersion)); }
  if (toolsetVersion) { sets.push('toolset_version = ?'); values.push(String(toolsetVersion)); }
  if (tokenBudgetTotal !== undefined && tokenBudgetTotal !== null) {
    sets.push('token_budget_total = COALESCE(token_budget_total, ?)');
    values.push(Math.max(1, Number(tokenBudgetTotal) || 1));
  }
  if (sets.length === 0) return getSession(id);
  sets.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE agent_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  return getSession(id);
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
  if (!targetPath && op !== 'create') return { valid: false, reason: 'PATH_REQUIRED' };
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

function saveMessagesCheckpoint(sessionId, messages, lastResponseContent, appliedToolUseId, runId = '') {
  const checkpoint = {
    messages: compactMessagesForStorage(messages),
    last_response_content: lastResponseContent,
    saved_at: new Date().toISOString(),
  };
  const db = getDb();
  return db.transaction(() => {
    const sid = normalizePositiveInt(sessionId);
    const result = db.prepare(`
      INSERT INTO agent_checkpoints (
        session_id, run_id, messages_json, last_response_content_json, tool_use_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      sid,
      String(runId || '') || null,
      JSON.stringify(checkpoint.messages),
      JSON.stringify(lastResponseContent || []),
      String(appliedToolUseId || '') || null
    );
    const checkpointId = Number(result.lastInsertRowid);
    db.prepare(`
      UPDATE agent_checkpoints
      SET status = 'superseded', superseded_at = datetime('now')
      WHERE session_id = ? AND status = 'active' AND id <> ?
    `).run(sid, checkpointId);
    db.prepare(`
      UPDATE agent_sessions
      SET last_committed_checkpoint_id = ?, messages_checkpoint = ?, checkpoint_tool_use_id = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(checkpointId, JSON.stringify(checkpoint), String(appliedToolUseId || ''), sid);
    return checkpointId;
  })();
}

function loadMessagesCheckpoint(sessionId) {
  const db = getDb();
  const sid = normalizePositiveInt(sessionId);
  const current = db.prepare(`
    SELECT * FROM agent_checkpoints
    WHERE session_id = ? AND status = 'active'
    ORDER BY id DESC LIMIT 1
  `).get(sid);
  if (current) {
    return {
      id: Number(current.id),
      messages: safeJsonParse(current.messages_json, []),
      lastResponseContent: safeJsonParse(current.last_response_content_json, []),
      appliedToolUseId: current.tool_use_id || '',
    };
  }
  const row = db.prepare('SELECT messages_checkpoint, checkpoint_tool_use_id FROM agent_sessions WHERE id = ?').get(sid);
  if (!row?.messages_checkpoint) return null;
  const checkpoint = safeJsonParse(row.messages_checkpoint, null);
  if (!checkpoint) return null;
  return {
    id: null,
    messages: Array.isArray(checkpoint.messages) ? checkpoint.messages : [],
    lastResponseContent: checkpoint.last_response_content || [],
    appliedToolUseId: row.checkpoint_tool_use_id || '',
  };
}

function clearMessagesCheckpoint(sessionId, checkpointId = null) {
  const db = getDb();
  const sid = normalizePositiveInt(sessionId);
  db.transaction(() => {
    if (checkpointId) {
      db.prepare(`
        UPDATE agent_checkpoints SET status = 'superseded', superseded_at = datetime('now')
        WHERE id = ? AND session_id = ?
      `).run(normalizePositiveInt(checkpointId), sid);
    } else {
      db.prepare(`
        UPDATE agent_checkpoints SET status = 'superseded', superseded_at = datetime('now')
        WHERE session_id = ? AND status = 'active'
      `).run(sid);
    }
    db.prepare(`
      UPDATE agent_sessions
      SET messages_checkpoint = NULL, checkpoint_tool_use_id = NULL,
          last_committed_checkpoint_id = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(sid);
  })();
}

function summarizeToolResult(toolName, result) {
  if (result?.error) return { error: result.error, message: result.message || result.reason || '' };
  switch (toolName) {
    case 'search_knowledge': return {
      query: result?.query || '',
      result_count: result?.results?.length || 0,
      budget: result?.budget || null,
      query_records: Array.isArray(result?.query_records) ? result.query_records.map((item) => ({ query: item.query, phase: item.phase, status: item.status, result_count: item.result_count })) : [],
    };
    case 'web_search': return {
      query: result?.query || '',
      provider: result?.provider || '',
      result_count: result?.results?.length || 0,
      context_message_id: result?.context_message_id || null,
      budget: result?.budget || null,
      query_records: Array.isArray(result?.query_records) ? result.query_records.map((item) => ({ query: item.query, phase: item.phase, status: item.status, result_count: item.result_count })) : [],
    };
    case 'read_file': return { file_path: result?.file_path, char_count: String(result?.content || '').length };
    case 'create_note': return { path: result?.path, created: Boolean(result?.created) };
    case 'preview_patch_files': return { operation_set_id: result?.operation_set_id, patch_count: result?.patch_count || 0 };
    case 'preview_file_revision': return {
      operation_set_id: result?.operation_set_id,
      file_path: result?.file_path,
      status: result?.status || '',
      no_change: Boolean(result?.no_change),
    };
    case 'preview_file_operations': return { operation_set_id: result?.operation_set_id, patch_count: result?.patch_count || 0 };
    case 'ask_question_card': return { interaction_id: result?.interaction_id, question_count: result?.question_count || 0 };
    case 'analyze_folder': return { file_count: result?.file_count || 0, total_count: result?.total_count || 0, truncated: Boolean(result?.truncated) };
    case 'check_links': return { orphan_count: result?.orphan_count || 0, broken_count: result?.broken_count || 0 };
    case 'get_task_activity': return { receipt_count: result?.research_receipts?.length || 0, tool_count: result?.tool_records?.length || 0 };
    case 'load_skill': return { id: result?.id || '', name: result?.name || '', source_label: result?.source_label || '' };
    case 'get_skill_details': return {
      id: result?.id || '', name: result?.name || '', enabled: Boolean(result?.enabled), managed: Boolean(result?.managed), status: result?.status || '',
    };
    case 'create_skill_draft': return { draft_id: result?.draft_id || '', valid: Boolean(result?.valid), validation_count: result?.validation?.length || 0 };
    case 'validate_skill_draft': return { draft_id: result?.draft_id || '', valid: Boolean(result?.valid), status: result?.status || '', validation_count: result?.validation?.length || 0 };
    case 'install_skill_draft': return { approval_required: Boolean(result?.approval_required), interaction_id: result?.interaction_id || null };
    case 'update_skill_draft': return { draft_id: result?.draft_id || '', valid: Boolean(result?.valid), pending_confirmation: Boolean(result?.pending_confirmation) };
    case 'set_skill_enabled': return { skill: result?.skill ? { id: result.skill.id, name: result.skill.name, enabled: Boolean(result.skill.enabled), managed: Boolean(result.skill.managed) } : null };
    case 'update_skill_from_git': return { job_id: result?.job_id || '', skill: result?.skill ? { id: result.skill.id, name: result.skill.name, enabled: Boolean(result.skill.enabled) } : null };
    case 'uninstall_skill': return { approval_required: Boolean(result?.approval_required), interaction_id: result?.interaction_id || null };
    case 'install_skill_from_git': return { installed: (result?.installed || []).map((item) => ({ id: item.id, name: item.name, enabled: Boolean(item.enabled) })) };
    case 'add_mcp_server': return {
      server: result?.server ? { id: result.server.id, name: result.server.name, transport: result.server.transport, enabled: Boolean(result.server.enabled) } : null,
      test: result?.test ? { ok: Boolean(result.test.ok), tool_count: Number(result.test.tool_count || 0), error_code: result.test.error_code || '', message: result.test.message || '' } : null,
    };
    case 'get_mcp_server_details': return { server: result?.server ? { id: result.server.id, name: result.server.name, transport: result.server.transport, enabled: Boolean(result.server.enabled) } : null };
    case 'update_mcp_server': return { server: result?.server ? { id: result.server.id, name: result.server.name, transport: result.server.transport, enabled: Boolean(result.server.enabled) } : null };
    case 'test_mcp_server': return { test: result?.test ? { ok: Boolean(result.test.ok), tool_count: Number(result.test.tool_count || 0), duration_ms: Number(result.test.duration_ms || 0) } : null };
    case 'set_mcp_server_enabled': return { server: result?.server ? { id: result.server.id, name: result.server.name, transport: result.server.transport, enabled: Boolean(result.server.enabled) } : null };
    case 'remove_mcp_server': return { approval_required: Boolean(result?.approval_required), interaction_id: result?.interaction_id || null };
    default: return { ok: true };
  }
}

function sanitizeToolInputForLog(toolName, toolInput) {
  if (toolName === 'add_mcp_server') {
    const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
    const sanitizeEntries = (entries = []) => (Array.isArray(entries) ? entries : []).map((entry) => ({ name: String(entry?.name || '').trim(), configured: Boolean(String(entry?.value || '').trim() || entry?.secretId) })).filter((entry) => entry.name);
    return {
      name: String(input.name || '').trim(),
      transport: String(input.transport || '').trim(),
      ...(input.http ? { http: { url: String(input.http.url || '').trim(), headers: sanitizeEntries(input.http.headers), connectTimeoutMs: input.http.connectTimeoutMs, requestTimeoutMs: input.http.requestTimeoutMs } } : {}),
      ...(input.stdio ? { stdio: { command: String(input.stdio.command || '').trim(), args: Array.isArray(input.stdio.args) ? input.stdio.args.map(String) : [], cwd: String(input.stdio.cwd || '').trim(), env: sanitizeEntries(input.stdio.env), connectTimeoutMs: input.stdio.connectTimeoutMs } } : {}),
    };
  }
  return toolInput || null;
}

function redactToolSecretsFromThinking(toolName, toolInput, thinking) {
  if (toolName !== 'add_mcp_server' || !thinking) return thinking || null;
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const entries = [...(Array.isArray(input.http?.headers) ? input.http.headers : []), ...(Array.isArray(input.stdio?.env) ? input.stdio.env : [])];
  return entries.reduce((text, entry) => {
    const value = String(entry?.value || '');
    return value ? String(text).split(value).join('[已隐藏]') : text;
  }, String(thinking));
}

function logToolCall({ sessionId, loopIndex, toolName, toolInput, toolResult, thinking = null, status = 'success', durationMs = 0 } = {}) {
  getDb().prepare(`
    INSERT INTO agent_run_logs (session_id, loop_index, tool_name, tool_input, tool_result, thinking, status, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalizePositiveInt(sessionId),
    Math.max(0, Number(loopIndex) || 0),
    toolName || null,
    JSON.stringify(sanitizeToolInputForLog(toolName, toolInput)),
    JSON.stringify(summarizeToolResult(toolName, toolResult)),
    redactToolSecretsFromThinking(toolName, toolInput, thinking),
    String(status || 'success'),
    Math.max(0, Number(durationMs) || 0)
  );
}

function updateToolGuard(sessionId, toolName, toolResult, failed) {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT last_tool_results FROM agent_sessions WHERE id = ?').get(normalizePositiveInt(sessionId));
    const stored = safeJsonParse(row?.last_tool_results, {});
    const previous = stored?.last_event || null;
    const name = String(toolName || 'unknown');
    const hash = sha256(JSON.stringify(toolResult || null));
    const sameSuccessfulResult = !failed && !previous?.failed && previous?.tool_name === name && previous?.result_hash === hash;
    const consecutiveFailure = failed && previous?.failed && previous?.tool_name === name;
    const next = {
      last_event: {
        tool_name: name,
        result_hash: hash,
        failed: Boolean(failed),
        consecutive_same_result: sameSuccessfulResult ? Number(previous.consecutive_same_result || 1) + 1 : (failed ? 0 : 1),
        consecutive_failures: consecutiveFailure ? Number(previous.consecutive_failures || 1) + 1 : (failed ? 1 : 0),
      },
    };
    db.prepare('UPDATE agent_sessions SET last_tool_results = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(next), normalizePositiveInt(sessionId));
    return next.last_event;
  })();
}

function detectDeadloop(sessionId, toolName, toolResult) {
  return updateToolGuard(sessionId, toolName, toolResult, false).consecutive_same_result >= 3;
}

function recordToolFail(sessionId, toolName) {
  return updateToolGuard(sessionId, toolName, { error: true }, true).consecutive_failures >= 2;
}

function resetToolFail() {
  // 成功工具由 detectDeadloop() 记录，它会同时清空全局连续失败窗口。
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

function truncateTimelineText(value, maxBytes = 16 * 1024) {
  const text = String(value || '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString('utf8') + '\n[内容已截断]';
}

const IMAGE_VIEW_STAGES = new Set(['image_view_start', 'image_view_done', 'image_recognition_done']);
const ATTACHMENT_PARSE_STAGES = new Set(['attachment_parse_start', 'attachment_parse_done']);
const CONTROLLED_IMAGE_PREVIEW_PATTERN = /^\/api\/agent\/images\/([^/?]+)\?conversation_id=(\d+)$/;

function normalizeAttachmentSourceKind(value) {
  return String(value || '').trim().toLowerCase() === 'url' ? 'url' : 'file';
}

function sanitizeAttachmentSource(value, sourceKind) {
  const source = String(value || '').trim();
  if (!source) return '';
  if (sourceKind === 'url') {
    try {
      const url = new URL(source);
      // 解析记录只需要告诉用户读取了哪个页面，查询参数和 hash 可能包含临时凭据。
      return truncateTimelineText(`${url.protocol}//${url.host}${url.pathname}`, 2 * 1024);
    } catch {
      return '';
    }
  }
  // 不把上传临时目录或任意路径重新带回时间线，只保留文件名。
  return truncateTimelineText(source.split(/[\\/]/).pop().replace(/[\x00-\x1F]/g, '_'), 512);
}

function normalizeTimelineCount(value, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(maximum, Math.floor(parsed));
}

function isImageInput(item = {}) {
  const name = String(item?.name || item?.file_name || item?.filename || '').toLowerCase();
  const type = String(item?.type || item?.contentType || '').split(';')[0].trim().toLowerCase();
  return item?.media_kind === 'image' || item?.source_kind === 'image' || type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/.test(name);
}

function imageIdentityKeys(item = {}) {
  return [item?.id, item?.stored_name, item?.storedName]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function sanitizeViewedImages(images = [], conversationId = null) {
  const normalizedConversationId = normalizePositiveInt(conversationId);
  const seen = new Set();
  return (Array.isArray(images) ? images : []).reduce((result, image, index) => {
    const id = String(image?.id || image?.stored_name || image?.storedName || '').trim();
    const previewUrl = String(image?.preview_url || image?.previewUrl || '').trim();
    const matched = previewUrl.match(CONTROLLED_IMAGE_PREVIEW_PATTERN);
    if (!id || !normalizedConversationId || !matched || Number(matched[2]) !== normalizedConversationId || seen.has(id)) return result;
    seen.add(id);
    result.push({
      id,
      name: truncateTimelineText(image?.name || `图片 ${index + 1}`, 512),
      alt: truncateTimelineText(image?.alt || image?.name || `已查看图片 ${index + 1}`, 512),
      preview_url: previewUrl,
    });
    return result;
  }, []).slice(0, 30);
}

function sanitizeRunEvent(event = {}) {
  const type = String(event.type || '').trim();
  if (!['progress', 'artifact', 'final'].includes(type)) return null;
  const stage = String(event.stage || '').trim();
  const isImageViewEvent = type === 'progress' && IMAGE_VIEW_STAGES.has(stage);
  const isAttachmentParseEvent = type === 'progress' && ATTACHMENT_PARSE_STAGES.has(stage);
  const sourceKind = isAttachmentParseEvent ? normalizeAttachmentSourceKind(event.source_kind) : '';
  const conversationId = normalizePositiveInt(event.conversation_id || event.conversationId);
  const viewedImages = isImageViewEvent ? sanitizeViewedImages(event.images, conversationId) : [];
  const payload = {
    type,
    stage,
    text: truncateTimelineText(event.text || event.final_text || '', type === 'final' ? 64 * 1024 : 16 * 1024),
    loop_index: Math.max(0, Number(event.loop_index || 0)),
    tool_name: String(event.tool_name || '').trim(),
    tool_input_summary: truncateTimelineText(event.tool_input_summary || '', 4 * 1024),
    result_summary: redactSecrets(event.result_summary ?? null),
    failed: Boolean(event.failed),
    retry_attempt: Math.max(0, Number(event.retry_attempt || 0)),
    retry_limit: Math.max(0, Number(event.retry_limit || 0)),
    retry_after_ms: Math.max(0, Number(event.retry_after_ms || 0)),
    artifact_type: String(event.artifact_type || '').trim(),
    status: String(event.status || '').trim(),
    reason: String(event.reason || '').trim(),
    error_category: String(event.error_category || '').trim(),
    error_code: String(event.error_code || '').trim(),
    error: isImageViewEvent ? truncateTimelineText(event.error || '', 512) : '',
    message: truncateTimelineText(event.message || '', 8 * 1024),
    retry_attempts: Math.max(0, Number(event.retry_attempts || 0)),
    resumable: Boolean(event.resumable),
    operation_set_id: normalizePositiveInt(event.operation_set_id),
    interaction_id: normalizePositiveInt(event.interaction?.id || event.interaction_id),
    conversation_id: isImageViewEvent ? conversationId : null,
    message_id: isImageViewEvent ? normalizePositiveInt(event.message_id) : null,
    image_count: isImageViewEvent ? (viewedImages.length || Math.min(30, Math.max(0, Number(event.image_count || 0)))) : 0,
    images: viewedImages,
    source: isAttachmentParseEvent ? sanitizeAttachmentSource(event.source, sourceKind) : '',
    source_kind: sourceKind,
    textLength: isAttachmentParseEvent ? normalizeTimelineCount(event.textLength, 1_000_000) : 0,
    pageCount: isAttachmentParseEvent ? normalizeTimelineCount(event.pageCount, 100_000) : 0,
    warning: isAttachmentParseEvent ? truncateTimelineText(event.warning || '', 2 * 1024) : '',
    errorCode: isAttachmentParseEvent ? truncateTimelineText(event.errorCode || '', 512) : '',
    duplicate: isAttachmentParseEvent && Boolean(event.duplicate),
    usage: type === 'final' ? redactSecrets(event.usage ?? null) : null,
  };
  const redacted = redactSecrets(payload);
  // 图片预览地址只允许由 sanitizeViewedImages 校验后的同源受控路径组成。
  // 随机存储文件名会被通用高熵脱敏误判，恢复时会变成无效地址；在最终脱敏后复原
  // 这一个已验证字段，其余文本、参数和结果仍继续执行脱敏。
  if (isImageViewEvent && Array.isArray(redacted.images)) {
    redacted.images = redacted.images.map((image, index) => ({
      ...image,
      preview_url: viewedImages[index]?.preview_url || '',
    })).filter((image) => image.preview_url);
  }
  return redacted;
}

function restoreViewedImagePreviews(event = {}, { conversationId = null, messageId = null, input = {} } = {}) {
  const stage = String(event?.stage || '').trim();
  const normalizedConversationId = normalizePositiveInt(conversationId);
  if (!IMAGE_VIEW_STAGES.has(stage) || !normalizedConversationId) return event;
  const candidates = [
    ...(Array.isArray(input?.images) ? input.images : []),
    ...(Array.isArray(input?.media_items) ? input.media_items.filter(isImageInput) : []),
    ...(Array.isArray(input?.attachments) ? input.attachments.filter(isImageInput) : []),
  ];
  const sourcesByKey = new Map();
  candidates.forEach((image) => imageIdentityKeys(image).forEach((key) => sourcesByKey.set(key, image)));
  const originalImages = Array.isArray(event?.images) && event.images.length > 0 ? event.images : candidates;
  const seenStoredNames = new Set();
  const images = originalImages.reduce((result, image, index) => {
    const source = imageIdentityKeys(image).map((key) => sourcesByKey.get(key)).find(Boolean);
    const storedName = String(source?.stored_name || source?.storedName || '').trim();
    if (!source || !storedName || seenStoredNames.has(storedName)) return result;
    seenStoredNames.add(storedName);
    result.push({
      id: String(source.id || storedName),
      name: String(image?.name || source?.name || `图片 ${index + 1}`),
      alt: String(image?.alt || `已查看图片 ${index + 1}`),
      preview_url: `/api/agent/images/${encodeURIComponent(storedName)}?conversation_id=${normalizedConversationId}`,
    });
    return result;
  }, []);
  return {
    ...event,
    message_id: normalizePositiveInt(event.message_id) || normalizePositiveInt(messageId),
    image_count: images.length || Math.min(30, Math.max(0, Number(event.image_count || 0))),
    images,
  };
}

function recordRunEvent({ sessionId, runId = null, event = null } = {}) {
  const payload = sanitizeRunEvent(event || {});
  if (!payload) return null;
  const serialized = JSON.stringify(payload);
  const result = getDb().prepare(`
    INSERT INTO agent_run_events (session_id, run_id, event_type, stage, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    normalizePositiveInt(sessionId),
    runId ? String(runId) : null,
    payload.type,
    payload.stage || payload.artifact_type || '',
    serialized
  );
  return Number(result.lastInsertRowid);
}

function listRunEvents(sessionId) {
  const database = getDb();
  const task = database.prepare('SELECT conversation_id, user_message_id, input_json FROM agent_task_queue WHERE session_id = ?').get(normalizePositiveInt(sessionId));
  const taskInput = safeJsonParse(task?.input_json, {});
  return database.prepare(`
    SELECT id, session_id, run_id, event_type, stage, payload_json, created_at
    FROM agent_run_events WHERE session_id = ? ORDER BY id ASC
  `).all(normalizePositiveInt(sessionId)).map((row) => ({
    id: Number(row.id),
    session_id: Number(row.session_id),
    run_id: row.run_id || null,
    event_type: row.event_type,
    stage: row.stage || '',
    payload: restoreViewedImagePreviews(safeJsonParse(row.payload_json, {}), {
      conversationId: task?.conversation_id,
      messageId: task?.user_message_id,
      input: taskInput,
    }),
    created_at: row.created_at,
  }));
}

function getLatestRunEventId(sessionId) {
  const row = getDb().prepare('SELECT COALESCE(MAX(id), 0) AS id FROM agent_run_events WHERE session_id = ?')
    .get(normalizePositiveInt(sessionId));
  return Number(row?.id || 0);
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
    WHERE status IN ('waiting_interaction', 'waiting_limit_confirmation', 'waiting_confirm')
      AND waiting_since IS NOT NULL AND waiting_since < ?
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
  setSessionWriteTarget,
  setSessionMcpPermission,
  consumeSessionMcpPermission,
  extendHardLimit,
  extendTokenBudget,
  setSessionRuntimeVersions,
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
  logToolCall,
  summarizeToolResult,
  detectDeadloop,
  recordToolFail,
  resetToolFail,
  listRunLogs,
  listRunEvents,
  getLatestRunEventId,
  recordRunEvent,
  sanitizeRunEvent,
  restoreViewedImagePreviews,
  countSnapshots,
  markStaleWaitingSessions,
  ensureSessionActive,
};
