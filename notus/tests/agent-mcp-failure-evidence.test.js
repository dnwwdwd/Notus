const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-mcp-errors-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, NOTES_DIR: path.join(root, 'notes'), ASSETS_DIR: path.join(root, 'assets'), DB_PATH: path.join(root, 'db.sqlite'), LOG_DIR: path.join(root, 'logs') });
function mock(name, exports) { const file = require.resolve(name); require.cache[file] = { id: file, filename: file, loaded: true, exports }; }
function instrument(name, suffix) {
  const filename = require.resolve(name), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(filename, 'utf8') + suffix, filename); return mod.exports;
}
let scenario, modelCalls, toolCalls;
const seenReceipts = [];
const mcp = instrument('../lib/mcp', '\nmodule.exports.setConnection = fn => { openConnection = fn; };');
mock('../lib/llmConfigs', { resolveLlmRuntimeConfig: () => ({ llmContextWindowTokens: 60000 }) });
mock('../lib/llm', { completeToolChat: async (request) => {
  modelCalls++;
  assert(!request.tools.some(t => t.name === 'web_search'));
  if (scenario.mode === 'missing_result') {
    if (modelCalls === 1) return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'missing-retry', name: 'mcp_fixture', input: {} }] };
    const blocked = request.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(b => b.type === 'tool_result' && b.tool_use_id === 'missing-retry');
    assert(blocked);
    assert.equal(JSON.parse(blocked.content).result_ref, null);
    assert.equal(JSON.parse(blocked.content).outcome_unknown, true);
    return { stopReason: 'end_turn', content: [{ type: 'text', text: '原调用中断后没有保存结果，本次未取得资料。请先排查服务连接，再继续处理；不会重复执行这次结果未知的调用。' }] };
  }
  if (scenario.mode) {
    const returns = request.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'tool_result').map(b => JSON.parse(b.content));
    if (modelCalls === (scenario.mode === 'corrected' ? 3 : 4)) assert(returns.some(r => r.repeat_warning), '触发保护后结果仍交还 Agent');
    if (modelCalls <= 3) return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: `progress-${modelCalls}`, name: 'mcp_fixture', input: { query: scenario.mode === 'corrected' && modelCalls === 3 ? 'fixed' : 'initial' } }] };
    return { stopReason: 'end_turn', content: [{ type: 'text', text: '已根据工具返回的网页取得资料：https://example.com/pricing' }] };
  }

  if (modelCalls === 1) return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: scenario.resuming ? 'mcp-retry' : 'mcp-call', name: 'mcp_fixture', input: {} }] };
  for (const message of request.messages) for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type === 'tool_result' && ['mcp-call', 'mcp-repeat', 'mcp-retry'].includes(block.tool_use_id)) {
      const receipt = JSON.parse(block.content);
      assert.equal(block.is_error, true);
      assert.equal(receipt.status, 'failed');
      assert.match(receipt.message, scenario.expected);
      assert(!JSON.stringify(receipt).includes('tiny-private-value'));
      seenReceipts.push(receipt);
    }
  }
  if (scenario.repeat && modelCalls === 2) return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'mcp-repeat', name: 'mcp_fixture', input: {} }] };
  if (scenario.repeat && modelCalls >= 3) assert(seenReceipts.some(r => r.repeat_warning), '重复失败后须向 Agent 暴露警示和错误引用');
  if (scenario.stubborn && [3, 4].includes(modelCalls)) return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: `blocked-${modelCalls}`, name: 'mcp_fixture', input: {} }] };
  if (modelCalls === (scenario.repeat ? 3 : 2) && !scenario.stubborn) {
    const receipt = seenReceipts.at(-1);
    assert.match(receipt.read_hint, /read_tool_result/);
    assert(receipt.result_ref);
    return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'read-error', name: 'read_tool_result', input: { result_ref: receipt.result_ref, json_pointer: receipt.error_pointers[0] } }] };
  }
  if (!scenario.stubborn) {
    const read = request.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).find(b => b.type === 'tool_result' && b.tool_use_id === 'read-error');
    assert(read, '错误结果必须能沿现有工具文件读取链路回到 Agent');
    assert.match(JSON.parse(read.content).content, scenario.expected);
  }
  if (scenario.stubborn) assert.equal(request.tools.length, 0, '持续原样调用后只组织原因说明，不再执行工具');
  const explanation = `${seenReceipts.at(-1)?.message}。这次未取得实时费率，请先处理该服务的上述错误，再继续查询。`;
  return { stopReason: 'end_turn', content: [{ type: 'text', text: explanation }] };
} });
(async () => {
  const db = require('../lib/db').getDb();
  const server = await mcp.saveServer({ name: 'fixture', transport: 'streamable_http', http: { url: 'https://example.com/mcp', headers: [{ name: 'X-Api-Key', value: 'tiny-private-value', secret: true }] } });
  const mapping = { serverId: server.id, toolName: 'fetchWebContent' };
  const tool = { name: 'mcp_fixture', description: '读取实时网页内容', input_schema: { type: 'object', properties: { query: { type: 'string' } } }, mcp: mapping };
  mock('../lib/mcp', { ...mcp, prepareMcpTools: async () => ({ tools: [tool], availableTools: [tool], map: { mcp_fixture: mapping }, diagnostics: [] }) });
  const worker = instrument('../lib/agentTaskWorker', '\nmodule.exports.executeForTest = execute;');
  const { ensureConversation } = require('../lib/conversations');
  const { createSession } = require('../lib/agentSession');
  const { createTask, getTaskBySession } = require('../lib/agentTaskQueue');
  const facts = require('../lib/agentRuntimeFacts');
  const store = require('../lib/agentToolResultStore');
  const scenarios = [
    { name: 'isError text', result: { isError: true, content: [{ type: 'text', text: 'token expired; token=tiny-private-value' }] }, expected: /token expired/, outcome: 'failed' },
    { name: 'repeated auth failure', repeat: true, result: { isError: true, content: [{ type: 'text', text: 'token expired; token=tiny-private-value' }] }, expected: /token expired/, outcome: 'failed' },
    { name: 'ignored repeat warning', repeat: true, stubborn: true, result: { isError: true, content: [{ type: 'text', text: 'token expired' }] }, expected: /token expired/, outcome: 'failed' },
    { name: 'structured error', result: { isError: true, structuredContent: { error: { code: 'TOKEN_EXPIRED', message: '访问令牌已过期' } } }, expected: /访问令牌已过期/, outcome: 'failed' },
    { name: 'large error', result: { isError: true, content: [{ type: 'text', text: 'token expired ' + '错误正文'.repeat(25000) }] }, expected: /token expired/, outcome: 'failed' },
    { name: 'HTTP401', exception: Object.assign(new Error('HTTP 401 token expired; Bearer tiny-private-value'), { code: 401 }), expected: /HTTP 401 token expired/, outcome: 'rejected' },
    { name: 'HTTP403', exception: Object.assign(new Error('HTTP 403 forbidden'), { status: 403 }), expected: /HTTP 403 forbidden/, outcome: 'rejected' },
    { name: 'SDK OAuth', exception: Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' }), expected: /Unauthorized/, outcome: 'rejected' },
    { name: 'connection before dispatch', connectionError: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }), expected: /connection refused/, outcome: 'not_started' },
    { name: 'SDK timeout', exception: Object.assign(new Error('Request timed out'), { code: 'MCP_TIMEOUT' }), expected: /Request timed out/, outcome: 'unknown' },
    { name: 'connection after dispatch', exception: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), expected: /socket reset/, outcome: 'unknown' },
  ];
  for (scenario of scenarios) {
    modelCalls = 0; toolCalls = 0; seenReceipts.length = 0;
    mcp.setConnection(async () => {
      if (scenario.connectionError) throw scenario.connectionError;
      return { client: { callTool: async () => { toolCalls++; if (scenario.exception) throw scenario.exception; return scenario.result; } } };
    });
    const cid = ensureConversation({ kind: 'agent', title: scenario.name }).id;
    const sid = createSession({ goal: '只用 MCP 联网调研支付费用', conversationId: cid, webSearchEnabled: false, mcpSelection: { mode: 'auto' } }).sessionId;
    await worker.executeForTest(createTask({ sessionId: sid, conversationId: cid, input: { user_query: '只用 MCP 联网调研支付费用' } }));
    const unknown = scenario.outcome === 'unknown';
    assert.equal(getTaskBySession(sid).status, 'failed', scenario.name);
    assert.equal(toolCalls, scenario.connectionError ? 0 : scenario.repeat ? 2 : 1, 'MCP 调用只能来自模型决策，重复保护后不得继续调用');
    assert.equal(facts.hasUnknownToolOutcome(sid), unknown);
    if (scenario.stubborn) assert.equal(db.prepare("SELECT count(*) AS n FROM agent_runtime_facts WHERE session_id = ? AND fact_type = 'tool_call_blocked'").get(sid).n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM conversation_interactions WHERE conversation_id = ? AND reason_code = 'tool_outcome_unknown'").get(cid).n, 0);
    const artifact = db.prepare('SELECT * FROM agent_tool_result_artifacts WHERE session_id = ?').get(sid);
    const recovered = await store.readArtifactResultForRuntime({ conversationId: cid, sessionId: sid, invocationKey: artifact.invocation_key });
    assert.match(require('../lib/agentToolFailure').describeToolFailure(recovered.result), scenario.expected);
    assert(!JSON.stringify(recovered.result).includes('tiny-private-value'));
    const logs = db.prepare('SELECT tool_result FROM agent_run_logs WHERE session_id = ? AND tool_name = ?').all(sid, 'mcp_fixture');
    assert(logs.length); assert.match(logs[0].tool_result, scenario.expected);
    {
      const finalMessage = db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(cid);
      assert(finalMessage, JSON.stringify({ scenario: scenario.name, task: getTaskBySession(sid) }));
      assert.match(finalMessage.content, scenario.expected, '最终失败说明须保留实际原因');
      assert(!finalMessage.content.includes('无法确认外部结果'));
      assert(!finalMessage.content.startsWith('任务尚未完成'));
      assert.match(finalMessage.content, /请先处理/);
      assert(seenReceipts.length, '失败原因必须直接进入主模型下一轮输入');
    }
    if (unknown) {
      const interactions = require('../lib/conversationInteractions');
      const sessions = require('../lib/agentSession');
      const card = interactions.createInteraction({ conversationId: cid, kind: 'clarify_card', source: 'agent_loop', reasonCode: 'tool_outcome_unknown', payload: { origin: 'tool_outcome_recovery', agent_session_id: sid, invocation_key: artifact.invocation_key, title: '需要核实上次工具结果', questions: [{ id: 'tool_outcome', label: '调用成功了吗？', type: 'single_select', options: [{ id: 'yes', label: '成功' }] }] } });
      // Legacy SSE dropped origin, but kept the reason code.
      const oldEvent = { type: 'artifact', artifact_type: 'interaction', reason: 'tool_outcome_unknown', interaction: { ...card, payload: { agent_session_id: sid, questions: card.payload.questions } } };
      db.prepare("INSERT INTO agent_run_events (session_id, event_type, stage, payload_json) VALUES (?, 'artifact', '', ?)").run(sid, JSON.stringify(oldEvent));
      sessions.saveMessagesCheckpoint(sid, [{ role: 'user', content: '只用 MCP 联网调研支付费用' }], [{ type: 'tool_use', id: 'mcp-call', name: 'mcp_fixture', input: {} }], 'mcp-call', null, { phase: 'waiting_interaction', nextToolIndex: 1, toolResults: [{ type: 'tool_result', tool_use_id: 'mcp-call', content: JSON.stringify(seenReceipts[0]), is_error: true }] });
      sessions.updateSessionStatus(sid, 'waiting_interaction');
      require('../lib/agentTaskQueue').updateTask(sid, { status: 'waiting_interaction' });
      if (scenario.name === 'SDK timeout') db.prepare("UPDATE agent_runtime_facts SET payload_json = json_set(payload_json, '$.input_digest', '[REDACTED]') WHERE invocation_key = ? AND fact_type = 'tool_call_prepared'").run(artifact.invocation_key);
      const recovery = facts.reconcileUnresolvedToolCalls();
      assert(recovery.retired_interactions.includes(card.id));
      assert.equal(interactions.getInteractionById(card.id).status, 'cancelled');
      assert.equal(interactions.listInteractionsByConversation(cid).length, 0);
      assert.equal(sessions.listRunEvents(sid).some(row => row.payload.artifact_type === 'interaction'), false);
      assert.equal(sessions.sanitizeRunEvent(oldEvent), null);
      assert.equal(getTaskBySession(sid).status, 'queued');
      assert.equal(sessions.getSession(sid).status, 'queued_resume');
      assert.equal(facts.hasUnknownToolOutcome(sid), true, '撤掉错误卡片不能伪造执行成功或失败');
      scenario.resuming = true; modelCalls = 0; seenReceipts.length = 0;
      const beforeResume = toolCalls;
      await worker.executeForTest(getTaskBySession(sid));
      assert.equal(getTaskBySession(sid).status, 'failed');
      assert.equal(toolCalls, beforeResume, '重启恢复不得重放结果未知的同一调用');
      assert(seenReceipts.length);
      assert.equal(interactions.listInteractionsByConversation(cid).length, 0);
      assert.equal(facts.reconcileUnresolvedToolCalls().retired_interactions.length, 0);
    }
    if (!unknown) {
      const events = db.prepare("SELECT payload_json FROM agent_runtime_facts WHERE session_id = ? AND fact_type = 'tool_call_failed'").all(sid);
      assert.equal(events.length, scenario.repeat ? 2 : 1);
      // Simulate crash after archive but before terminal fact persisted.
      db.prepare("DELETE FROM agent_runtime_facts WHERE session_id = ? AND fact_type = 'tool_call_failed'").run(sid);
      facts.reconcileUnresolvedToolCalls();
      assert.equal(facts.getInvocationState(artifact.invocation_key).terminal.fact_type, 'tool_call_failed');
      assert.equal(facts.hasUnknownToolOutcome(sid), false);
    }
  }
  for (const mode of ['corrected', 'same_success']) {
    scenario = { mode }; modelCalls = 0; toolCalls = 0;
    mcp.setConnection(async () => ({ client: { callTool: async (request) => {
      toolCalls++;
      return mode === 'corrected' && request.arguments.query !== 'fixed'
        ? { isError: true, content: [{ type: 'text', text: 'query 参数不正确' }] }
        : { content: [{ type: 'text', text: '官方支付费率说明，按每笔订单金额计费并区分接入方式。https://example.com/pricing' }] };
    } } }));
    const cid = ensureConversation({ kind: 'agent', title: mode }).id;
    const sid = createSession({ goal: '用 MCP 联网查询资料', conversationId: cid, webSearchEnabled: false, mcpSelection: { mode: 'auto' } }).sessionId;
    await worker.executeForTest(createTask({ sessionId: sid, conversationId: cid, input: { user_query: '用 MCP 联网查询资料' } }));
    assert.equal(getTaskBySession(sid).status, 'completed', JSON.stringify({mode, modelCalls, toolCalls, final: db.prepare("SELECT content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1").get(cid), facts: db.prepare("SELECT payload_json FROM agent_runtime_facts WHERE session_id=? AND fact_type='completion_incomplete'").all(sid)}));
    assert.equal(toolCalls, 3); assert.equal(modelCalls, 4);
  }
  scenario = { mode: 'missing_result' }; modelCalls = 0; toolCalls = 0;
  mcp.setConnection(async () => ({ client: { callTool: async () => { toolCalls++; throw Error('must not replay'); } } }));
  const missingCid = ensureConversation({ kind: 'agent', title: 'interrupted without result' }).id;
  const missingSid = createSession({ goal: '用 MCP 联网查询资料', conversationId: missingCid, webSearchEnabled: false, mcpSelection: { mode: 'auto' } }).sessionId;
  const missingTask = createTask({ sessionId: missingSid, conversationId: missingCid, input: { user_query: '用 MCP 联网查询资料' } });
  facts.recordToolCallPrepared({ conversationId: missingCid, sessionId: missingSid, taskId: missingTask.id, toolCallId: 'old-call', invocationKey: `${missingSid}:old-call`, toolName: 'mcp_fixture', inputDigest: require('../lib/files').sha256('{}'), replayPolicy: 'non_replayable', externalMcp: true });
  facts.reconcileUnresolvedToolCalls();
  await worker.executeForTest(missingTask);
  assert.equal(toolCalls, 0); assert.equal(modelCalls, 2);
  assert.equal(getTaskBySession(missingSid).status, 'failed');
  assert.equal(facts.hasUnknownToolOutcome(missingSid), true);
  assert.equal(require('../lib/conversationInteractions').listInteractionsByConversation(missingCid).length, 0);
  // Discovery failures must also preserve the actual authentication cause.
  scenario = { connectionError: Object.assign(new Error('token expired; token=tiny-private-value'), { code: 401 }) };
  mcp.setConnection(async () => { throw scenario.connectionError; });
  const directory = await mcp.prepareMcpTools({ mode: 'auto' }, '', {}, { forceRefresh: true });
  assert.equal(directory.tools.length, 0);
  assert.equal(directory.diagnostics[0].code, 401);
  assert.match(directory.diagnostics[0].message, /token expired/);
  assert(!JSON.stringify(directory).includes('tiny-private-value'));
  worker.stopAgentTaskWorker(); require('../lib/skills').stopSkillWatchers(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  console.log('MCP failure → model receipt / timeline / facts / recovery passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
