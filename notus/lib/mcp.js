const crypto = require('crypto');
const path = require('path');
const { getDb } = require('./db');
const { inferRuntimeTarget } = require('./platform/target');
const { getSkillMcpCapabilities } = require('./platform/capabilities');
const { getEffectiveConfig } = require('./config');
const { readSecret, saveSecret, removeSecret } = require('./secretStore');

const OWNER_ID = 'local-user';
const connections = new Map();
const MAX_AUTO_SERVERS = 3;
const MAX_AUTO_TOOLS = 20;
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

function parseJson(value, fallback) { try { return JSON.parse(value || ''); } catch { return fallback; } }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function caps() { return getSkillMcpCapabilities(inferRuntimeTarget(), { dataRoot: getEffectiveConfig().dataRoot }); }
function cleanHeaders(headers = []) {
  return (Array.isArray(headers) ? headers : []).map((item) => ({ name: String(item?.name || '').trim(), value: String(item?.value || ''), secretId: String(item?.secretId || ''), secret: Boolean(item?.secret) })).filter((item) => item.name);
}
function sanitizeConfig(config = {}) {
  const next = JSON.parse(JSON.stringify(config || {}));
  if (next.http?.headers) next.http.headers = next.http.headers.map((item) => ({ name: item.name, secret: Boolean(item.secretId || item.secret), configured: Boolean(item.secretId || item.value), ...(item.secretId ? { secretId: item.secretId } : item.value ? { value: item.value } : {}) }));
  if (next.stdio?.env) next.stdio.env = next.stdio.env.map((item) => ({ name: item.name, secret: Boolean(item.secretId || item.secret), configured: Boolean(item.secretId || item.value), ...(item.secretId ? { secretId: item.secretId } : item.value ? { value: item.value } : {}) }));
  return next;
}
function formatServer(row) {
  if (!row) return null;
  const { tool_policy_json: _toolPolicyJson, ...server } = row;
  return { ...server, enabled: Boolean(row.enabled), config: sanitizeConfig(parseJson(row.config_json, {})) };
}
function listServers({ includeDisabled = true } = {}) {
  const rows = getDb().prepare(`SELECT * FROM mcp_servers WHERE owner_id = ? ${includeDisabled ? '' : 'AND enabled = 1'} ORDER BY name`).all(OWNER_ID);
  // 不向不支持 stdio 的运行环境暴露历史遗留的 stdio 配置；服务层仍会在
  // 创建、更新和连接时再次校验能力，避免绕过前端。
  return rows.map(formatServer).filter((server) => server.transport !== 'stdio' || caps().mcp.stdio);
}
function getServer(id) { return formatServer(getDb().prepare('SELECT * FROM mcp_servers WHERE id = ? AND owner_id = ?').get(String(id || ''), OWNER_ID)); }
function findServerByName(name, excludeId = '') {
  const normalized = String(name || '').trim();
  if (!normalized) return null;
  return getDb().prepare(`SELECT id FROM mcp_servers
    WHERE owner_id = ? AND lower(name) = lower(?) AND id <> ? LIMIT 1`)
    .get(OWNER_ID, normalized, String(excludeId || '')) || null;
}
function assertTransport(transport) {
  if (!['stdio', 'streamable_http'].includes(transport)) throw Object.assign(new Error('MCP transport 无效'), { code: 'MCP_CONFIG_INVALID' });
  if (transport === 'stdio' && !caps().mcp.stdio) throw Object.assign(new Error('当前运行环境不支持 stdio MCP'), { code: 'MCP_TRANSPORT_UNAVAILABLE' });
}
function normalizeHostname(url) { return String(url.hostname || '').replace(/^\[|\]$/g, '').toLowerCase(); }
function isExactLoopbackHost(hostname) { return ['localhost', '127.0.0.1', '::1'].includes(hostname); }
function isLoopbackAddress(hostname) { return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname); }
function isLocalHttpServer(server) { return Boolean(server?.transport === 'streamable_http' && server?.config?.http?.allow_local_http); }
function secretIds(config = {}) {
  return new Set([...(config.http?.headers || []), ...(config.stdio?.env || [])].map((item) => String(item?.secretId || '')).filter(Boolean));
}
function referencedSecretIds() {
  const referenced = new Set();
  getDb().prepare('SELECT config_json FROM mcp_servers WHERE owner_id = ?').all(OWNER_ID)
    .forEach((row) => secretIds(parseJson(row.config_json, {})).forEach((secretId) => referenced.add(secretId)));
  return referenced;
}
async function removeUnusedSecrets(candidateIds = []) {
  const referenced = referencedSecretIds();
  await Promise.all([...new Set(candidateIds)].filter((secretId) => !referenced.has(secretId)).map((secretId) => removeSecret(secretId).catch(() => {})));
}
function validateHttpUrl(raw, { allowLocalHttp = false } = {}) {
  const url = new URL(String(raw || ''));
  const hostname = normalizeHostname(url);
  const loopback = isExactLoopbackHost(hostname);
  if (url.username || url.password) throw Object.assign(new Error('MCP HTTP 地址不能包含用户名或密码'), { code: 'MCP_HTTP_URL_BLOCKED' });
  if (isLoopbackAddress(hostname) && !loopback) throw Object.assign(new Error('本机 MCP 仅支持 localhost、127.0.0.1 或 ::1'), { code: 'MCP_HTTP_URL_BLOCKED' });
  if (loopback && !allowLocalHttp) throw Object.assign(new Error('连接本机 MCP 地址前，请明确允许本机 HTTP 地址'), { code: 'MCP_HTTP_URL_BLOCKED' });
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && allowLocalHttp)) throw Object.assign(new Error('MCP HTTP 地址必须为安全 HTTPS 地址'), { code: 'MCP_HTTP_URL_BLOCKED' });
  if (/^(0\.0\.0\.0|169\.254\.)/.test(hostname)) throw Object.assign(new Error('当前运行环境不允许访问该 MCP 地址'), { code: 'MCP_HTTP_URL_BLOCKED' });
  return url.toString();
}
async function persistSecretEntries(entries = []) {
  const next = [];
  for (const entry of cleanHeaders(entries)) {
    const output = { name: entry.name, value: entry.value, secretId: entry.secretId, secret: entry.secret };
    if (entry.secret && entry.value) { output.secretId = await saveSecret(entry.value); delete output.value; }
    next.push(output);
  }
  return next;
}
async function normalizeConfig(input = {}, existing = null) {
  const transport = String(input.transport || existing?.transport || '').trim();
  assertTransport(transport);
  const existingConfig = existing ? parseJson(existing.config_json, {}) : {};
  if (transport === 'streamable_http') {
    const http = input.http || {};
    const allowLocalHttp = http.allowLocalHttp === true || (http.allowLocalHttp === undefined && existingConfig.http?.allow_local_http === true);
    const url = validateHttpUrl(http.url || existingConfig.http?.url, { allowLocalHttp });
    return { transport, config: { http: { url, allow_local_http: allowLocalHttp, headers: await persistSecretEntries(http.headers || existingConfig.http?.headers || []), connectTimeoutMs: Math.min(Math.max(Number(http.connectTimeoutMs || existingConfig.http?.connectTimeoutMs || 15000), 1000), 60000), requestTimeoutMs: Math.min(Math.max(Number(http.requestTimeoutMs || existingConfig.http?.requestTimeoutMs || 120000), 1000), 600000) } } };
  }
  const stdio = input.stdio || {};
  const command = String(stdio.command || existingConfig.stdio?.command || '').trim();
  if (!command) throw Object.assign(new Error('请填写 stdio 命令'), { code: 'MCP_CONFIG_INVALID' });
  const cwd = String(stdio.cwd || existingConfig.stdio?.cwd || '').trim();
  if (cwd && !path.isAbsolute(cwd)) throw Object.assign(new Error('stdio 工作目录必须为绝对路径'), { code: 'MCP_CONFIG_INVALID' });
  return { transport, config: { stdio: { command, args: Array.isArray(stdio.args) ? stdio.args.map(String) : (existingConfig.stdio?.args || []), cwd, env: await persistSecretEntries(stdio.env || existingConfig.stdio?.env || []), connectTimeoutMs: Math.min(Math.max(Number(stdio.connectTimeoutMs || existingConfig.stdio?.connectTimeoutMs || 15000), 1000), 60000) } } };
}
async function saveServer(input = {}, id = '') {
  const existing = id ? getDb().prepare('SELECT * FROM mcp_servers WHERE id = ? AND owner_id = ?').get(id, OWNER_ID) : null;
  if (id && !existing) throw Object.assign(new Error('MCP Server 不存在'), { code: 'MCP_SERVER_NOT_FOUND' });
  const name = String(input.name || existing?.name || '').trim();
  if (!name || name.length > 80) throw Object.assign(new Error('请填写 MCP Server 名称'), { code: 'MCP_CONFIG_INVALID' });
  if (findServerByName(name, existing?.id)) {
    throw Object.assign(new Error(`MCP Server“${name}”已存在`), { code: 'MCP_SERVER_ALREADY_EXISTS' });
  }
  const existingConfig = existing ? parseJson(existing.config_json, {}) : {};
  const normalized = await normalizeConfig(input, existing);
  const serverId = existing?.id || crypto.randomUUID();
  // 旧版本已经写入的工具策略继续留在数据库中，避免升级时丢失数据；
  // MCP 是否可调用现在只由当前 AI 输入框的 Server 选择决定。
  const legacyPolicy = existing?.tool_policy_json || JSON.stringify({});
  const enabled = input.enabled === undefined ? (existing ? existing.enabled : true) : Boolean(input.enabled);
  getDb().prepare(`INSERT INTO mcp_servers (id,owner_id,name,transport,enabled,config_json,tool_policy_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now'))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,transport=excluded.transport,enabled=excluded.enabled,config_json=excluded.config_json,tool_policy_json=excluded.tool_policy_json,updated_at=datetime('now')`).run(serverId, OWNER_ID, name, normalized.transport, enabled ? 1 : 0, JSON.stringify(normalized.config), legacyPolicy);
  await removeUnusedSecrets([...secretIds(existingConfig)]);
  // 连接缓存以 owner:id 为键。配置更新后应清理旧连接，避免继续使用旧地址、命令或凭据。
  await disconnectServer(serverId);
  return getServer(serverId);
}
async function removeServer(id) {
  await disconnectServer(id);
  const server = getServer(id); if (!server) return { deleted: false };
  const config = parseJson(getDb().prepare('SELECT config_json FROM mcp_servers WHERE id = ?').get(id)?.config_json, {});
  getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  await removeUnusedSecrets([...secretIds(config)]);
  return { deleted: true };
}
async function resolvedEntries(entries = []) {
  const output = {};
  for (const entry of entries) output[entry.name] = entry.secretId ? await readSecret(entry.secretId) : String(entry.value || '');
  return output;
}
function connectionKey(server) { return `${OWNER_ID}:${server.id}`; }
async function openConnection(server) {
  const key = connectionKey(server);
  if (connections.has(key)) return connections.get(key);
  const raw = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(server.id);
  const config = parseJson(raw.config_json, {});
  let Client; let StdioClientTransport; let StreamableHTTPClientTransport;
  ({ Client } = await import('@modelcontextprotocol/sdk/client/index.js'));
  let transport;
  if (server.transport === 'stdio') {
    if (!caps().mcp.stdio) throw Object.assign(new Error('当前运行环境不支持 stdio MCP'), { code: 'MCP_TRANSPORT_UNAVAILABLE' });
    ({ StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js'));
    const env = await resolvedEntries(config.stdio?.env || []);
    transport = new StdioClientTransport({ command: config.stdio.command, args: config.stdio.args || [], cwd: config.stdio.cwd || undefined, env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', TMPDIR: process.env.TMPDIR || '', ...env }, stderr: 'pipe' });
  } else {
    ({ StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js'));
    transport = new StreamableHTTPClientTransport(new URL(config.http.url), { requestInit: { headers: await resolvedEntries(config.http?.headers || []), redirect: 'error' } });
  }
  const client = new Client({ name: 'notus', version: '0.1.8' });
  const timeout = Number(config.http?.connectTimeoutMs || config.stdio?.connectTimeoutMs || 15000);
  await Promise.race([client.connect(transport), new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('MCP 连接超时'), { code: 'MCP_TIMEOUT' })), timeout))]);
  const connection = { client, transport, server, instructions: typeof client.getInstructions === 'function' ? client.getInstructions() : '', close: async () => { try { if (transport.terminateSession) await transport.terminateSession(); } catch {} await client.close(); } };
  connections.set(key, connection);
  return connection;
}
async function cacheTools(server, tools = []) {
  const db = getDb();
  const remove = db.prepare('DELETE FROM mcp_tool_cache WHERE server_id = ?');
  const insert = db.prepare('INSERT INTO mcp_tool_cache (server_id,tool_name,description,input_schema_json,schema_hash,discovered_at) VALUES (?,?,?,?,?,?)');
  db.transaction(() => { remove.run(server.id); tools.forEach((tool) => insert.run(server.id, tool.name, tool.description || '', JSON.stringify(tool.inputSchema || tool.input_schema || { type: 'object', properties: {} }), hash(JSON.stringify(tool.inputSchema || tool.input_schema || {})), new Date().toISOString())); })();
}
function cachedTools(serverId) { return getDb().prepare('SELECT * FROM mcp_tool_cache WHERE server_id = ? ORDER BY tool_name').all(serverId).map((item) => ({ ...item, input_schema: parseJson(item.input_schema_json, { type: 'object', properties: {} }) })); }
function isToolCacheStale(serverId, referenceTime = Date.now()) {
  const row = getDb().prepare('SELECT MAX(discovered_at) AS discovered_at FROM mcp_tool_cache WHERE server_id = ?').get(serverId);
  const discoveredAt = Date.parse(row?.discovered_at || '');
  return !Number.isFinite(discoveredAt) || referenceTime - discoveredAt >= TOOL_CACHE_TTL_MS;
}
async function refreshTools(server) { const connection = await openConnection(server); const result = await connection.client.listTools(); const tools = result?.tools || []; await cacheTools(server, tools); return { tools, instructions: connection.instructions || '' }; }
async function testServer(id) {
  const server = getServer(id); if (!server) throw Object.assign(new Error('MCP Server 不存在'), { code: 'MCP_SERVER_NOT_FOUND' });
  const started = Date.now();
  try { const result = await refreshTools(server); await disconnectServer(id); getDb().prepare(`UPDATE mcp_servers SET last_test_status='success',last_test_at=datetime('now'),last_error_code=NULL,last_error_message=NULL WHERE id=?`).run(id); return { ok: true, tool_count: result.tools.length, duration_ms: Date.now() - started, instructions: result.instructions }; } catch (error) { await disconnectServer(id); getDb().prepare(`UPDATE mcp_servers SET last_test_status='failed',last_test_at=datetime('now'),last_error_code=?,last_error_message=? WHERE id=?`).run(error.code || 'MCP_CONNECTION_FAILED', error.message, id); throw error; }
}
async function disconnectServer(id) { const key = `${OWNER_ID}:${id}`; const connection = connections.get(key); if (!connection) return; connections.delete(key); await connection.close().catch(() => {}); }
async function closeAllConnections() { await Promise.all([...connections.values()].map((connection) => connection.close().catch(() => {}))); connections.clear(); }
function alias(serverId, toolName) { return `mcp_${hash(`${serverId}:${toolName}`).slice(0, 12)}_${String(toolName).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 36)}`.slice(0, 63); }
function intentTerms(goal = '') {
  const text = String(goal || '').toLowerCase();
  const terms = new Set(text.split(/[\s，。；、,.!?？:：/（）()\[\]{}]+/).filter((term) => term.length > 1 && term.length <= 40));
  const chineseRuns = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  chineseRuns.forEach((run) => {
    for (let size = 2; size <= Math.min(4, run.length); size += 1) {
      for (let index = 0; index <= run.length - size; index += 1) terms.add(run.slice(index, index + size));
    }
  });
  return [...terms].slice(0, 80);
}
async function prepareMcpTools(selection = {}, goal = '', sessionPermissions = {}) {
  const mode = selection.mode || 'off';
  if (mode === 'off') return { tools: [], map: {}, instructions: [] };
  const servers = listServers({ includeDisabled: false }).filter((server) => sessionPermissions.allow_local_http === true || !isLocalHttpServer(server));
  let selected = mode === 'server' ? servers.filter((item) => item.id === selection.serverId) : servers;
  // 连接测试会写入缓存；长期运行或重启后，首次任务也应在缓存过期时静默
  // 刷新，避免自动选择和工具 schema 长期停留在旧版本。
  await Promise.all(selected.filter((server) => isToolCacheStale(server.id)).map((server) => refreshTools(server).catch(() => null)));
  if (mode === 'auto') {
    const terms = intentTerms(goal);
    const ranked = selected.map((server) => ({ server, score: cachedTools(server.id).reduce((score, tool) => score + terms.reduce((sum, term) => sum + (String(`${server.name} ${tool.tool_name} ${tool.description}`).toLowerCase().includes(term) ? 1 : 0), 0), 0) })).sort((left, right) => right.score - left.score || String(left.server.name).localeCompare(String(right.server.name)));
    selected = ranked.filter((item) => item.score > 0).slice(0, MAX_AUTO_SERVERS).map((item) => item.server);
    if (selected.length === 0) selected = ranked.slice(0, MAX_AUTO_SERVERS).map((item) => item.server);
  }
  const map = {}; const tools = []; const instructions = [];
  for (const server of selected) {
    let cached = cachedTools(server.id);
    if (!cached.length) { try { await refreshTools(server); cached = cachedTools(server.id); } catch { continue; } }
    const connection = connections.get(connectionKey(server));
    if (connection?.instructions) instructions.push({ server: server.name, text: connection.instructions });
    cached.slice(0, MAX_AUTO_TOOLS).forEach((tool) => { const name = alias(server.id, tool.tool_name); map[name] = { serverId: server.id, toolName: tool.tool_name }; tools.push({ name, description: `[MCP：${server.name} / ${tool.tool_name}] ${tool.description || '无说明'}`, input_schema: tool.input_schema, mcp: map[name] }); });
  }
  return { tools: tools.slice(0, MAX_AUTO_TOOLS), map, instructions };
}
async function callMcpTool(mapping, args, options = {}) {
  const server = getServer(mapping?.serverId); if (!server || !server.enabled) return { error: 'MCP_TOOL_NOT_FOUND', message: 'MCP 工具不可用' };
  try {
    const connection = await openConnection(server);
    const result = await connection.client.callTool(
      { name: mapping.toolName, arguments: args || {} },
      undefined,
      { signal: options.signal, timeout: options.timeoutMs }
    );
    return normalizeToolResult(result);
  } catch (error) { return { error: error.code || 'MCP_CONNECTION_FAILED', message: error.message }; }
}
function normalizeToolResult(result) {
  const value = result || {}; const serialized = JSON.stringify(value); if (serialized.length > 60000) return { truncated: true, summary: serialized.slice(0, 60000), is_error: Boolean(value.isError) }; return { content: value.content || [], structured_content: value.structuredContent || null, is_error: Boolean(value.isError) };
}
module.exports = { caps, listServers, getServer, saveServer, removeServer, testServer, cachedTools, isToolCacheStale, refreshTools, disconnectServer, closeAllConnections, prepareMcpTools, callMcpTool, alias };
