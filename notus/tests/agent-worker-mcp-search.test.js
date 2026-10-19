const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-worker-mcp-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, NOTES_DIR: path.join(root, 'notes'), ASSETS_DIR: path.join(root, 'assets'), DB_PATH: path.join(root, 'db.sqlite'), LOG_DIR: path.join(root, 'logs') });
let calls = 0, discoveries = 0, modelCalls = 0;
function mock(name, exports) { const file = require.resolve(name); require.cache[file] = { id: file, filename: file, loaded: true, exports }; }
// Neither the name nor the required inputs match the former runtime heuristics.
const tool = { name: 'mcp_lookup', description: '[MCP: 懒猫] 实时搜索互联网网页', input_schema: { type: 'object', properties: { search_query: { type: 'string' }, category: { type: 'string', enum: ['web'] } }, required: ['search_query', 'category'] }, mcp: { serverId: 'server', toolName: 'lookup' } };
mock('../lib/llmConfigs', { resolveLlmRuntimeConfig: () => ({ llmContextWindowTokens: 60000 }) });
mock('../lib/mcp', { ...require('../lib/mcp'), prepareMcpTools: async (selection, goal, permissions, options) => {
  assert.equal(options.forceRefresh, true); discoveries++;
  if (selection.mode === 'off') return { tools: [], availableTools: [], map: {}, instructions: [] };
  return { tools: [], availableTools: [tool], map: { mcp_lookup: tool.mcp }, instructions: [] };
}, callMcpTool: async (mapping, args) => {
  assert.equal(mapping.toolName, 'lookup'); assert.equal(args.category, 'web'); calls++;
  if (calls === 1) { assert.equal(args.search_query, '第三方支付 个人费率'); return { content: [{ type: 'text', text: '没有结果' }] }; }
  assert.equal(args.search_query, '虎皮椒 个人接入 收费 官网');
  return { content: [{ type: 'text', text: '虎皮椒官方收费说明，按订单金额计费，需要区分个人接入条件。\nhttps://example.com/pricing' }] };
} });
mock('../lib/llm', { completeToolChat: async (request) => {
  modelCalls++;
  assert(!request.tools.some(t => t.name === 'web_search'), '未开放内置搜索时不得注入该工具');
  const call = (name, input) => ({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: `call-${modelCalls}`, name, input }] });
  if (modelCalls === 1) { assert.equal(calls, 0, 'Loop 前不得替主模型执行搜索'); return call('list_available_mcp_tools', {}); }
  if (modelCalls === 2) { assert(request.tools.some(t => t.name === 'mcp_lookup')); return call('mcp_lookup', { search_query: '第三方支付 个人费率', category: 'web' }); }
  if (modelCalls === 3) return call('mcp_lookup', { search_query: '虎皮椒 个人接入 收费 官网', category: 'web' });
  return { stopReason: 'end_turn', content: [{ type: 'text', text: '已通过指定 MCP 查询；当前仅查到一家来源，仍不能给出完整市场比较。' }] };
} });
(async () => {
  const { getDb } = require('../lib/db'); const db = getDb();
  const { ensureConversation } = require('../lib/conversations');
  const { createSession, getSession } = require('../lib/agentSession');
  const { createTask, getTaskBySession } = require('../lib/agentTaskQueue');
  const cid = ensureConversation({ kind: 'agent', title: 'MCP discovery' }).id;
  const goal = '用懒猫 MCP 联网搜索第三方支付手续费，并查看 https://example.com/pricing';
  const sid = createSession({ goal, conversationId: cid, authorizedPaths: [''], webSearchEnabled: false, mcpSelection: { mode: 'auto' } }).sessionId;
  const task = createTask({ sessionId: sid, conversationId: cid, input: { user_query: goal } });
  const filename = require.resolve('../lib/agentTaskWorker'); const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.executeForTest=execute;', filename);
  await mod.exports.executeForTest(task);
  assert.equal(discoveries, 1); assert.equal(calls, 2); assert.equal(modelCalls, 4);
  assert.equal(getTaskBySession(sid).status, 'completed', JSON.stringify(getTaskBySession(sid).last_error));
  const { hasSuccessfulResearch } = require('../lib/agentCompletionEvaluator');
  assert.equal(hasSuccessfulResearch(sid, 'web'), true, '按描述识别的 MCP Markdown 来源应计入证据');
  const offId = createSession({ goal: '联网搜索新闻', conversationId: cid, webSearchEnabled: false, mcpSelection: { mode: 'off' } }).sessionId;
  const before = modelCalls;
  await mod.exports.executeForTest(createTask({ sessionId: offId, conversationId: cid, input: { user_query: '联网搜索新闻' } }));
  assert(modelCalls > before, '没有工具也须由同一 Loop 依据实际清单说明能力，不在 Worker 提前返回设置模板');
  assert.equal(getTaskBySession(offId).status, 'failed'); assert.equal(calls, 2);
  const { recordMcpWebEvidence } = require('../lib/agentResearch');
  for (const [toolName, result] of [['list_notes', { results: [{ url: 'https://example.com', content: 'local note' }] }], ['web_search', { is_error: true, results: [{ url: 'https://example.com', content: 'error' }] }], ['web_search', { content: [{ type: 'text', text: 'https://example.com' }] }]]) recordMcpWebEvidence({ session: getSession(offId), toolName, result });
  assert.equal(hasSuccessfulResearch(offId, 'web'), false);
  const { projectToolDefinitions } = require('../lib/agentToolProfile');
  assert.equal(projectToolDefinitions([tool], { intent: { verification: { network_allowed: false } } }).length, 0);
  mod.exports.stopAgentTaskWorker(); require('../lib/skills').stopSkillWatchers(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  console.log('Worker → MCP directory → model-selected schema → empty result → changed query passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
