const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-question-trigger-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, NOTES_DIR: path.join(root, 'notes'), ASSETS_DIR: path.join(root, 'assets'), DB_PATH: path.join(root, 'db.sqlite'), LOG_DIR: path.join(root, 'logs') });
function mock(name, exports) { const file = require.resolve(name); require.cache[file] = { id: file, filename: file, loaded: true, exports }; }
const url = 'https://www.anthropic.com/research/glm-5-3-and-the-spread-of-advanced-cyber-capabilities';
const goal = `${url} 这个文章写了啥?`;
let plannerMode = 'failure', reads = 0, turns = 0;
const config = { llmApiKey: 'test', llmBaseUrl: 'https://example.invalid', llmModel: 'test', llmContextWindowTokens: 60000 };
mock('../lib/llmConfigs', { resolveLlmRuntimeConfig: () => config });
const tool = { name: 'mcp_read_page', description: '[MCP: reader] 读取网页内容', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, mcp: { serverId: 'reader', toolName: 'read_page' } };
mock('../lib/mcp', { ...require('../lib/mcp'), prepareMcpTools: async () => ({ tools: [tool], availableTools: [tool], map: { mcp_read_page: tool.mcp }, instructions: [] }), callMcpTool: async (mapping, args) => {
  assert.equal(args.url, url); reads++;
  return { content: [{ type: 'text', text: `测试文章讨论模型的网络安全能力扩散。\n${url}` }] };
} });
mock('../lib/llm', {
  completeChat: async () => {
    if (plannerMode === 'failure') throw new Error('planner unavailable');
    return { message: { content: JSON.stringify({ task_kind: 'general', confidence: 0.1, needs_clarification: plannerMode === 'asks', missing_slots: ['primary_intent'] }) } };
  },
  completeToolChat: async () => {
    turns++;
    if (turns % 2 === 1) return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: `read-${turns}`, name: 'mcp_read_page', input: { url } }] };
    return { stopReason: 'end_turn', content: [{ type: 'text', text: '这篇文章讨论模型的网络安全能力扩散。' }] };
  },
});
(async () => {
  const db = require('../lib/db').getDb();
  const cid = require('../lib/conversations').ensureConversation({ kind: 'agent', title: '明确链接请求' }).id;
  const { createSession } = require('../lib/agentSession');
  const { createTask, getTaskBySession, updateTask } = require('../lib/agentTaskQueue');
  const { composeTurnFrame, deterministicIntent, clarificationIntent } = require('../lib/agentSemanticRuntime');
  const composedSessions = [];
  function taskFor(query) {
    const sid = createSession({ goal: query, conversationId: cid, authorizedPaths: [''], webSearchEnabled: false, mcpSelection: { mode: 'auto' } }).sessionId;
    composedSessions.push(sid);
    return { sid, task: createTask({ sessionId: sid, conversationId: cid, input: { user_query: query } }) };
  }
  assert.equal(deterministicIntent(goal).needs_planner, true, '原口语请求确实命中前置规划路径');
  for (const mode of ['failure', 'low', 'asks', 'missing_config']) {
    plannerMode = mode;
    const { task } = taskFor(goal);
    const result = await composeTurnFrame({ task, userQuery: goal, llmConfig: mode === 'missing_config' ? {} : config });
    assert.equal(result.clarification, null, `${mode} 不应拦截明确请求`);
    if (mode !== 'asks') assert.equal(result.frame.intent.needs_clarification, false);
  }
  for (const query of ['帮我找一个 Skill 然后安装', '分析这个文件']) {
    const { task } = taskFor(query);
    const result = await composeTurnFrame({ task, userQuery: query, mentions: [{ type: 'file', path: 'a.md' }, { type: 'file', path: 'b.md' }], llmConfig: config });
    assert.equal(result.clarification, null, '具体目标由主 Agent 结合上下文判断');
  }
  for (const query of ['不要联网，但请读取 https://example.com/a', '读取 https://example.com/a，https://example.com/b']) {
    const { task } = taskFor(query);
    const result = await composeTurnFrame({ task, userQuery: query, llmConfig: {} });
    assert.ok(result.clarification, '明确访问范围冲突仍须澄清');
    assert.notEqual(result.clarification.questions[0].id, 'primary_intent');
  }
  const legacy = clarificationIntent({ payload: { origin: 'turn_composer' }, status: 'answered', response: { answers: { primary_intent: { value: 'file_read' } } } }, deterministicIntent(goal));
  assert.equal(legacy.task_kind, 'file_read', '旧卡回答仍可恢复');
  composedSessions.forEach(sid => updateTask(sid, { status: 'cancelled', finished: true }));
  const filename = require.resolve('../lib/agentTaskWorker');
  const mod = new Module(filename, module); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.executeForTest=execute;', filename);
  for (const mode of ['failure', 'low', 'asks']) {
    plannerMode = mode;
    const { sid, task } = taskFor(goal);
    await mod.exports.executeForTest(task);
    assert.equal(getTaskBySession(sid).status, 'completed', JSON.stringify(getTaskBySession(sid).last_error));
  }
  assert.equal(reads, 3); assert.equal(turns, 6, '每次进入主 Loop 并完成网页读取和回答');
  mod.exports.stopAgentTaskWorker(); require('../lib/skills').stopSkillWatchers(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  console.log('question trigger: planner fallback, targeted permission conflicts, legacy resume and Worker → MCP read → answer passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
