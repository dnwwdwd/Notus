const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-mcp-directory-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, DB_PATH: path.join(root, 'db.sqlite'), NOTES_DIR: path.join(root, 'notes'), ASSETS_DIR: path.join(root, 'assets') });
(async () => {
  const { getDb } = require('../lib/db'); const db = getDb();
  const { saveServer, prepareMcpTools } = require('../lib/mcp');
  const schema = { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] };
  const insert = db.prepare('INSERT INTO mcp_tool_cache (server_id,tool_name,description,input_schema_json,schema_hash,discovered_at) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < 4; i++) {
    const server = await saveServer({ name: `资料服务 ${i}`, transport: 'streamable_http', http: { url: `https://example.com/mcp${i}` } });
    for (let j = 0; j < 8; j++) insert.run(server.id, `lookup_${j}`, `读取资料 ${i}-${j}`, JSON.stringify(schema), 'test', new Date().toISOString());
  }
  const local = await saveServer({ name: '本机服务', transport: 'streamable_http', http: { url: 'http://127.0.0.1:39999/mcp', allowLocalHttp: true } });
  insert.run(local.id, 'secret_local', '本机资料', JSON.stringify(schema), 'test', new Date().toISOString());
  const prepared = await prepareMcpTools({ mode: 'auto' }, '资料');
  assert.equal(prepared.tools.length, 20);
  assert.equal(prepared.availableTools.length, 32, '第 4 个服务与第 21 个工具仍可发现');
  assert(prepared.diagnostics.some(d => d.code === 'MCP_LOCAL_HTTP_NOT_AUTHORIZED'));
  assert(!prepared.availableTools.some(t => t.name.includes('secret_local')));
  assert(prepared.availableTools.every(t => t.input_schema.required[0] === 'topic'));
  const { createSession, getSession } = require('../lib/agentSession');
  const sid = createSession({ goal: '资料', mcpSelection: { mode: 'auto' } }).sessionId;
  const session = getSession(sid);
  const { executeToolSafely, buildToolDefinitions } = require('../lib/agentTools');
  const collected = [];
  for (let offset = 0; offset < 32; offset += 10) {
    const result = await executeToolSafely({ id: `list-${offset}`, name: 'list_available_mcp_tools', input: { offset } }, session, undefined, { availableMcpTools: prepared.availableTools, mcpDiagnostics: prepared.diagnostics, toolDefinitions: buildToolDefinitions(session) });
    assert.equal(result.total, 32); collected.push(...result.tools.map(t => t.name));
  }
  assert.equal(new Set(collected).size, 32);
  const off = getSession(createSession({ goal: '资料', mcpSelection: { mode: 'off' } }).sessionId);
  const denied = await executeToolSafely({ name: 'list_available_mcp_tools', input: {} }, off, undefined, { availableMcpTools: prepared.availableTools });
  assert.equal(denied.error, 'UNKNOWN_TOOL');
  // 高危1：外部 MCP readOnlyHint 是服务端自报值，不得作为免确认依据。
  // 即使旧映射仍携带 readOnly: true，手动模式也必须生成资源确认卡。
  const { createTask } = require('../lib/agentTaskQueue');
  const { ensureConversation } = require('../lib/conversations');
  const manualConversation = ensureConversation({ kind: 'canvas', title: 'mcp manual confirm' });
  const manualSession = getSession(createSession({ goal: 'mcp manual confirm', conversationId: manualConversation.id, mcpSelection: { mode: 'auto' } }).sessionId);
  createTask({ sessionId: manualSession.id, conversationId: manualConversation.id, approvalMode: 'manual', input: {} });
  const guarded = await executeToolSafely(
    { name: 'lookup_0', input: { topic: 'x' } },
    manualSession,
    undefined,
    {
      mcpToolMap: { lookup_0: { serverId: local.id, toolName: 'lookup_0', readOnly: true } },
      toolDefinitions: buildToolDefinitions(manualSession).concat([{ name: 'lookup_0', description: '外部 MCP 只读工具', input_schema: schema }]),
    },
  );
  assert.equal(guarded.approval_required, true, '手动模式下外部 MCP 工具不得因 readOnlyHint 免确认');
  db.close(); fs.rmSync(root, { recursive: true, force: true });
  console.log('MCP directory pagination, uncropped catalog, full schemas, off and local authorization boundaries passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
