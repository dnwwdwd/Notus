const crypto = require('crypto');
const { getDb } = require('./db');
const { listSkills } = require('./skills');
const { listServers } = require('./mcp');
const {
  getFileByPath,
  listMarkdownFiles,
  readMarkdownFile,
  createFile,
  saveFileByPath,
  renameFile,
  getBaseName,
  getParentPath,
  ensureMarkdownPath,
} = require('./files');
const { indexFile } = require('./indexer');

const READ_PERMISSIONS = ['search_files', 'list_files', 'get_note', 'list_skills', 'list_mcp_servers'];
const WRITE_PERMISSIONS = ['create_note', 'patch_note', 'replace_note', 'move_note', 'rename_note'];
const ALL_PERMISSIONS = [...READ_PERMISSIONS, ...WRITE_PERMISSIONS, 'get_change_status'];
const DEFAULT_PERMISSIONS = READ_PERMISSIONS;

function parseJson(value, fallback) { try { return JSON.parse(value || ''); } catch { return fallback; } }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function nowId(prefix) { return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`; }
function error(message, code = 'EXTERNAL_MCP_ERROR') { return Object.assign(new Error(message), { code }); }
function cleanPermissions(input = DEFAULT_PERMISSIONS, approvalMode = 'manual') {
  const set = new Set((Array.isArray(input) ? input : []).map(String));
  const allowedPermissions = approvalMode === 'manual' ? ALL_PERMISSIONS : ALL_PERMISSIONS.filter((name) => name !== 'get_change_status');
  return allowedPermissions.filter((name) => set.has(name));
}
function normalizeApprovalMode(value) {
  const mode = String(value || '').trim();
  if (!['auto', 'manual'].includes(mode)) throw error('确认模式必须为自动应用或手动确认', 'EXTERNAL_MCP_TOKEN_INVALID');
  return mode;
}
function formatToken(row) {
  if (!row) return null;
  const approvalMode = row.approval_mode === 'auto' ? 'auto' : 'manual';
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    approval_mode: approvalMode,
    permissions: cleanPermissions(parseJson(row.permissions_json, []), approvalMode),
    last_used_at: row.last_used_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
function listTokens() {
  return getDb().prepare('SELECT * FROM external_mcp_tokens ORDER BY created_at DESC, name COLLATE NOCASE').all().map(formatToken);
}
function getToken(id) { return formatToken(getDb().prepare('SELECT * FROM external_mcp_tokens WHERE id = ?').get(String(id || ''))); }
function newRawToken() { return `ntm_${crypto.randomBytes(32).toString('base64url')}`; }
function tokenHash(raw) { return sha256(`notus-external-mcp:${String(raw || '')}`); }
function assertTokenName(name, id = '') {
  const normalized = String(name || '').trim();
  if (!normalized || normalized.length > 80) throw error('请填写 1 至 80 个字符的 Token 名称', 'EXTERNAL_MCP_TOKEN_INVALID');
  const duplicate = getDb().prepare('SELECT id FROM external_mcp_tokens WHERE lower(name) = lower(?) AND id <> ?').get(normalized, String(id || ''));
  if (duplicate) throw error(`MCP Token“${normalized}”已存在`, 'EXTERNAL_MCP_TOKEN_EXISTS');
  return normalized;
}
function createToken(input = {}) {
  const name = assertTokenName(input.name);
  const rawToken = newRawToken();
  const id = nowId('mcp_token');
  const approvalMode = normalizeApprovalMode(input.approval_mode || 'manual');
  const permissions = cleanPermissions(input.permissions === undefined ? DEFAULT_PERMISSIONS : input.permissions, approvalMode);
  getDb().prepare(`INSERT INTO external_mcp_tokens (id,name,token_hash,enabled,approval_mode,permissions_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))`).run(id, name, tokenHash(rawToken), input.enabled === false ? 0 : 1, approvalMode, JSON.stringify(permissions));
  return { token: formatToken(getDb().prepare('SELECT * FROM external_mcp_tokens WHERE id = ?').get(id)), raw_token: rawToken };
}
function updateToken(id, input = {}) {
  const existing = getToken(id);
  if (!existing) throw error('MCP Token 不存在', 'EXTERNAL_MCP_TOKEN_NOT_FOUND');
  const name = Object.prototype.hasOwnProperty.call(input, 'name') ? assertTokenName(input.name, id) : existing.name;
  const enabled = Object.prototype.hasOwnProperty.call(input, 'enabled') ? Boolean(input.enabled) : existing.enabled;
  const approvalMode = Object.prototype.hasOwnProperty.call(input, 'approval_mode') ? normalizeApprovalMode(input.approval_mode) : existing.approval_mode;
  const permissions = cleanPermissions(
    Object.prototype.hasOwnProperty.call(input, 'permissions') ? input.permissions : existing.permissions,
    approvalMode,
  );
  getDb().prepare(`UPDATE external_mcp_tokens SET name=?,enabled=?,approval_mode=?,permissions_json=?,updated_at=datetime('now') WHERE id=?`)
    .run(name, enabled ? 1 : 0, approvalMode, JSON.stringify(permissions), id);
  return getToken(id);
}
function rotateToken(id) {
  const existing = getToken(id);
  if (!existing) throw error('MCP Token 不存在', 'EXTERNAL_MCP_TOKEN_NOT_FOUND');
  const rawToken = newRawToken();
  getDb().prepare("UPDATE external_mcp_tokens SET token_hash=?,updated_at=datetime('now') WHERE id=?").run(tokenHash(rawToken), id);
  return { token: getToken(id), raw_token: rawToken };
}
function removeToken(id) {
  const result = getDb().prepare('DELETE FROM external_mcp_tokens WHERE id = ?').run(String(id || ''));
  return { deleted: Boolean(result.changes) };
}
function authenticateToken(rawToken) {
  const candidate = String(rawToken || '').trim();
  if (!candidate) throw error('缺少 MCP Token', 'EXTERNAL_MCP_UNAUTHORIZED');
  const digest = tokenHash(candidate);
  const row = getDb().prepare('SELECT * FROM external_mcp_tokens WHERE token_hash = ?').get(digest);
  if (!row || !row.enabled) throw error('MCP Token 无效或已停用', 'EXTERNAL_MCP_UNAUTHORIZED');
  const stored = Buffer.from(String(row.token_hash));
  const supplied = Buffer.from(digest);
  if (stored.length !== supplied.length || !crypto.timingSafeEqual(stored, supplied)) throw error('MCP Token 无效或已停用', 'EXTERNAL_MCP_UNAUTHORIZED');
  getDb().prepare("UPDATE external_mcp_tokens SET last_used_at=datetime('now') WHERE id=?").run(row.id);
  return formatToken(row);
}
function audit(tokenId, toolName, status, detail = {}) {
  getDb().prepare('INSERT INTO external_mcp_audit_logs (id,token_id,tool_name,status,detail_json,created_at) VALUES (?,?,?,?,?,datetime(\'now\'))')
    .run(nowId('mcp_audit'), tokenId || null, String(toolName || ''), String(status || ''), JSON.stringify(detail || {}));
}
function safeFile(file) {
  if (!file) return null;
  return { path: file.path, title: file.title || getBaseName(file.path).replace(/\.md$/i, ''), hash: sha256(file.content || ''), updated_at: file.updated_at || null };
}
function listFiles({ query = '', directory = '', limit = 100 } = {}) {
  const normalizedDirectory = String(directory || '').trim().replace(/^\/+|\/+$/g, '');
  const needle = String(query || '').trim().toLocaleLowerCase();
  const max = Math.min(Math.max(Number(limit) || 100, 1), 200);
  return listMarkdownFiles().map((filePath) => getFileByPath(filePath) || {
    path: filePath,
    title: getBaseName(filePath).replace(/\.md$/i, ''),
    content: readMarkdownFile(filePath),
  })
    .filter((file) => !normalizedDirectory || file.path === normalizedDirectory || file.path.startsWith(`${normalizedDirectory}/`))
    .filter((file) => !needle || file.path.toLocaleLowerCase().includes(needle) || String(file.title || '').toLocaleLowerCase().includes(needle))
    .slice(0, max)
    .map(safeFile);
}
function readNote(filePath) {
  const file = getFileByPath(ensureMarkdownPath(filePath));
  if (!file) throw error('文件不存在', 'EXTERNAL_MCP_FILE_NOT_FOUND');
  return { ...safeFile(file), content: file.content || '' };
}
function requireCurrentFile(filePath, expectedHash) {
  const file = getFileByPath(ensureMarkdownPath(filePath));
  if (!file) throw error('文件不存在', 'EXTERNAL_MCP_FILE_NOT_FOUND');
  const actualHash = sha256(file.content || '');
  if (!expectedHash || String(expectedHash) !== actualHash) throw error('文件内容已变化，请重新读取后再提交修改', 'EXTERNAL_MCP_HASH_MISMATCH');
  return file;
}
function checkCreate(filePath, expectedHash) {
  const normalized = ensureMarkdownPath(filePath);
  if (String(expectedHash || '') !== 'absent') throw error('新建文件的 expected_hash 必须为 absent', 'EXTERNAL_MCP_HASH_REQUIRED');
  if (getFileByPath(normalized)) throw error('目标文件已存在', 'EXTERNAL_MCP_FILE_EXISTS');
  return normalized;
}
function normalizedPatches(patches = []) {
  if (!Array.isArray(patches) || patches.length === 0 || patches.length > 100) throw error('patches 必须包含 1 至 100 项局部替换', 'EXTERNAL_MCP_PATCH_INVALID');
  return patches.map((patch) => {
    const oldText = String(patch?.old ?? '');
    if (!oldText) throw error('patch.old 不能为空', 'EXTERNAL_MCP_PATCH_INVALID');
    return { old: oldText, new: String(patch?.new ?? '') };
  });
}
function applyPatches(content, patches) {
  let next = String(content || '');
  normalizedPatches(patches).forEach((patch) => {
    const index = next.indexOf(patch.old);
    if (index < 0) throw error('patch.old 未在当前文件中精确命中', 'EXTERNAL_MCP_PATCH_MISMATCH');
    if (next.indexOf(patch.old, index + patch.old.length) >= 0) throw error('patch.old 命中多处，请提供更精确的内容', 'EXTERNAL_MCP_PATCH_AMBIGUOUS');
    next = `${next.slice(0, index)}${patch.new}${next.slice(index + patch.old.length)}`;
  });
  return next;
}
function validateWrite(toolName, input = {}) {
  const tool = String(toolName || '');
  if (tool === 'create_note') {
    const filePath = checkCreate(input.path, input.expected_hash);
    return { tool, path: filePath, expected_hash: 'absent', content: String(input.content ?? '') };
  }
  if (tool === 'patch_note') {
    const file = requireCurrentFile(input.path, input.expected_hash);
    const patches = normalizedPatches(input.patches);
    return { tool, path: file.path, expected_hash: input.expected_hash, before: file.content || '', after: applyPatches(file.content || '', patches), patches };
  }
  if (tool === 'replace_note') {
    const file = requireCurrentFile(input.path, input.expected_hash);
    return { tool, path: file.path, expected_hash: input.expected_hash, before: file.content || '', after: String(input.content ?? '') };
  }
  if (tool === 'rename_note') {
    const file = requireCurrentFile(input.path, input.expected_hash);
    const nextPath = ensureMarkdownPath(`${getParentPath(file.path) ? `${getParentPath(file.path)}/` : ''}${String(input.name || '')}`);
    if (!String(input.name || '').trim()) throw error('请填写新的文件名', 'EXTERNAL_MCP_PATH_INVALID');
    if (nextPath !== file.path && getFileByPath(nextPath)) throw error('目标文件已存在', 'EXTERNAL_MCP_FILE_EXISTS');
    return { tool, path: file.path, new_path: nextPath, name: String(input.name || '').trim(), expected_hash: input.expected_hash, before: file.content || '' };
  }
  if (tool === 'move_note') {
    const file = requireCurrentFile(input.path, input.expected_hash);
    const directory = String(input.directory || '').replace(/^\/+|\/+$/g, '');
    const nextPath = ensureMarkdownPath(directory ? `${directory}/${getBaseName(file.path)}` : getBaseName(file.path));
    if (nextPath !== file.path && getFileByPath(nextPath)) throw error('目标文件已存在', 'EXTERNAL_MCP_FILE_EXISTS');
    return { tool, path: file.path, new_path: nextPath, directory, expected_hash: input.expected_hash, before: file.content || '' };
  }
  throw error('不支持的写入工具', 'EXTERNAL_MCP_TOOL_INVALID');
}
async function applyWrite(payload = {}) {
  const checked = validateWrite(payload.tool, payload);
  let file;
  if (checked.tool === 'create_note') file = createFile(checked.path, checked.content, { titleFilenameBindingEnabled: false });
  else if (checked.tool === 'patch_note' || checked.tool === 'replace_note') file = saveFileByPath(checked.path, checked.after);
  else file = renameFile(checked.path, checked.new_path);
  indexFile(file.path).catch(() => {});
  return { path: file.path, title: file.title || '', hash: sha256(file.content || (checked.after || checked.before || '')) };
}
function createPendingChange(token, payload) {
  const id = nowId('mcp_change');
  getDb().prepare(`INSERT INTO external_mcp_changes (id,token_id,token_name,tool_name,payload_json,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'pending',datetime('now'),datetime('now'))`).run(id, token.id, token.name, payload.tool, JSON.stringify(payload));
  return getChange(id);
}
function formatChange(row, includePayload = false) {
  if (!row) return null;
  const payload = parseJson(row.payload_json, {});
  const summary = {
    id: row.id, token_id: row.token_id || null, token_name: row.token_name, tool_name: row.tool_name, status: row.status,
    error_code: row.error_code || null, error_message: row.error_message || null, applied_at: row.applied_at || null,
    rejected_at: row.rejected_at || null, created_at: row.created_at, updated_at: row.updated_at,
    path: payload.path || '', new_path: payload.new_path || '',
  };
  return includePayload ? { ...summary, payload } : summary;
}
function getChange(id, options = {}) { return formatChange(getDb().prepare('SELECT * FROM external_mcp_changes WHERE id = ?').get(String(id || '')), Boolean(options.includePayload)); }
function listChanges({ statuses = [], limit = 100, includePayload = true } = {}) {
  const allowed = Array.isArray(statuses) && statuses.length ? statuses.map(String) : ['pending', 'conflict', 'applied', 'rejected'];
  const rows = getDb().prepare(`SELECT * FROM external_mcp_changes WHERE status IN (${allowed.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT ?`).all(...allowed, Math.min(Math.max(Number(limit) || 100, 1), 200));
  return rows.map((row) => formatChange(row, includePayload));
}
async function applyChange(id) {
  const change = getChange(id, { includePayload: true });
  if (!change) throw error('待确认变更不存在', 'EXTERNAL_MCP_CHANGE_NOT_FOUND');
  if (!['pending', 'conflict'].includes(change.status)) throw error('该变更已处理', 'EXTERNAL_MCP_CHANGE_NOT_PENDING');
  try {
    const result = await applyWrite(change.payload);
    getDb().prepare("UPDATE external_mcp_changes SET status='applied',error_code=NULL,error_message=NULL,applied_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(id);
    audit(change.token_id, change.tool_name, 'applied', { change_id: id, path: result.path });
    return { change: getChange(id, { includePayload: true }), result };
  } catch (cause) {
    const status = ['EXTERNAL_MCP_HASH_MISMATCH', 'EXTERNAL_MCP_PATCH_MISMATCH', 'EXTERNAL_MCP_FILE_NOT_FOUND'].includes(cause.code) ? 'conflict' : 'pending';
    getDb().prepare('UPDATE external_mcp_changes SET status=?,error_code=?,error_message=?,updated_at=datetime(\'now\') WHERE id=?').run(status, cause.code || 'EXTERNAL_MCP_APPLY_FAILED', cause.message, id);
    audit(change.token_id, change.tool_name, status, { change_id: id, path: change.path || '' });
    throw cause;
  }
}
function rejectChange(id) {
  const change = getChange(id);
  if (!change) throw error('待确认变更不存在', 'EXTERNAL_MCP_CHANGE_NOT_FOUND');
  if (!['pending', 'conflict'].includes(change.status)) throw error('该变更已处理', 'EXTERNAL_MCP_CHANGE_NOT_PENDING');
  getDb().prepare("UPDATE external_mcp_changes SET status='rejected',rejected_at=datetime('now'),updated_at=datetime('now') WHERE id=?").run(id);
  audit(change.token_id, change.tool_name, 'rejected', { change_id: id, path: change.path || '' });
  return getChange(id, { includePayload: true });
}
async function executeWriteTool(token, toolName, input) {
  const payload = validateWrite(toolName, input);
  if (token.approval_mode === 'manual') {
    const change = createPendingChange(token, payload);
    audit(token.id, toolName, 'pending', { change_id: change.id, path: payload.path || '' });
    return { status: 'pending', change_id: change.id, path: payload.path || '', new_path: payload.new_path || '' };
  }
  const result = await applyWrite(payload);
  audit(token.id, toolName, 'applied', { path: result.path });
  return { status: 'applied', ...result };
}
function externalSkills() {
  return listSkills().filter((skill) => skill.status === 'valid').map((skill) => ({ name: skill.name, description: skill.description || '', enabled: Boolean(skill.enabled), source: skill.managed ? 'notus_managed' : 'local' }));
}
function externalServers() {
  return listServers().map((server) => ({ name: server.name, transport: server.transport, enabled: Boolean(server.enabled), last_test_status: server.last_test_status || null, tool_count: getDb().prepare('SELECT COUNT(*) AS count FROM mcp_tool_cache WHERE server_id = ?').get(server.id)?.count || 0 }));
}
function textResult(value) { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value }; }
function toolError(cause) { return { content: [{ type: 'text', text: cause.message || 'MCP 工具执行失败' }], isError: true }; }
async function createExternalMcpServer(token) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const z = require('zod');
  const server = new McpServer({ name: 'notus-external-mcp', version: '0.1.11' });
  const allowed = new Set(token.permissions || []);
  const register = (name, description, inputSchema, handler) => {
    if (!allowed.has(name)) return;
    server.registerTool(name, { description, inputSchema }, async (input) => {
      try { return textResult(await handler(input)); } catch (cause) { audit(token.id, name, 'failed', { code: cause.code || 'EXTERNAL_MCP_TOOL_FAILED' }); return toolError(cause); }
    });
  };
  register('search_files', '按文件名、标题和相对路径搜索 Notus 笔记，不读取联网或语义检索。', { query: z.string().default(''), directory: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }, async (input) => ({ files: listFiles(input) }));
  register('list_files', '列出 Notus 笔记；可按目录过滤。', { directory: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }, async (input) => ({ files: listFiles(input) }));
  register('get_note', '读取一篇 Markdown 笔记及其当前内容哈希。', { path: z.string().min(1) }, async (input) => readNote(input.path));
  register('list_skills', '列出有效 Skill，不返回 Skill 正文。', {}, async () => ({ skills: externalSkills() }));
  register('list_mcp_servers', '列出 Notus 已配置的 MCP Server 摘要，不返回连接地址或凭据。', {}, async () => ({ servers: externalServers() }));
  register('create_note', '创建 Markdown 笔记。expected_hash 必须为 absent。', { path: z.string().min(1), content: z.string(), expected_hash: z.string() }, async (input) => executeWriteTool(token, 'create_note', input));
  register('patch_note', '以精确 old 文本局部修改笔记。所有替换原子校验，expected_hash 必须来自 get_note。', { path: z.string().min(1), expected_hash: z.string(), patches: z.array(z.object({ old: z.string().min(1), new: z.string() })).min(1).max(100) }, async (input) => executeWriteTool(token, 'patch_note', input));
  register('replace_note', '以完整内容替换一篇笔记，expected_hash 必须来自 get_note。', { path: z.string().min(1), content: z.string(), expected_hash: z.string() }, async (input) => executeWriteTool(token, 'replace_note', input));
  register('move_note', '将笔记移动到目录，expected_hash 必须来自 get_note。', { path: z.string().min(1), directory: z.string(), expected_hash: z.string() }, async (input) => executeWriteTool(token, 'move_note', input));
  register('rename_note', '重命名笔记，name 为文件名或文件名.md，expected_hash 必须来自 get_note。', { path: z.string().min(1), name: z.string().min(1), expected_hash: z.string() }, async (input) => executeWriteTool(token, 'rename_note', input));
  register('get_change_status', '查询手动确认变更的当前状态。', { change_id: z.string().min(1) }, async ({ change_id: changeId }) => {
    const change = getChange(changeId);
    if (!change || change.token_id !== token.id) throw error('变更不存在', 'EXTERNAL_MCP_CHANGE_NOT_FOUND');
    return change;
  });
  return server;
}

module.exports = {
  ALL_PERMISSIONS, READ_PERMISSIONS, WRITE_PERMISSIONS, DEFAULT_PERMISSIONS,
  listTokens, getToken, createToken, updateToken, rotateToken, removeToken, authenticateToken,
  listChanges, getChange, applyChange, rejectChange, executeWriteTool, createExternalMcpServer,
};
