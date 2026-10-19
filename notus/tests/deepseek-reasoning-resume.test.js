const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-deepseek-reasoning-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root,
  DB_PATH: path.join(root, 'db.sqlite'), NOTES_DIR: path.join(root, 'notes'),
  ASSETS_DIR: path.join(root, 'assets'), LOG_DIR: path.join(root, 'logs'), SESSION_DIR: path.join(root, 'session') });
const requests = [];
const expectedReasoning = new Map();
let scripts = [];
let serverError;
const secret = 'PRIVATE_NATIVE_REASONING';
const tool = (id, name, input) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });
const reply = (content, calls = [], finish = 'stop') => {
  const reasoning = `${secret}\nfull signed reasoning ${expectedReasoning.size}\n${'长推理'.repeat(5000)}`;
  const result = { content, reasoning_content: reasoning, ...(calls.length ? { tool_calls: calls } : {}) };
  expectedReasoning.set(content || calls[0]?.id, reasoning);
  return { message: result, finish: calls.length ? 'tool_calls' : finish };
};
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ url: req.url, body });
    if (body.model === 'deepseek-v4-flash' && body.tools?.length) {
      for (const message of body.messages.filter(m => m.role === 'assistant')) {
        assert(message.reasoning_content === expectedReasoning.get(message.content || message.tool_calls?.[0]?.id), `所有保留的助手轮次必须传回完整推理 (${message.content})`);
        assert.equal(typeof message.reasoning_content, 'string', '缺字段应像真实DeepSeek一样拒绝');
      }
    } else if (body.model !== 'deepseek-v4-flash') {
      assert(!JSON.stringify(body).includes(secret), '切换模型/协议不能发送旧推理');
    }
    assert(scripts.length, 'unexpected model request');
    const result = scripts.shift()(body);
    if (result.error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture rejected request', type: 'invalid_request_error' } }));
      return;
    }
    if (req.url.endsWith('/messages')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: 'text_delta', text: '其他协议已完成。' } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' } })}\n\n`);
    } else if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const reasoning = result.message.reasoning_content;
      for (const fragment of [reasoning.slice(0, 11), reasoning.slice(11)]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: fragment } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: result.message.content, tool_calls: result.message.tool_calls?.map((call, index) => ({ ...call, index })) }, finish_reason: result.finish }] })}\n\n`);
      res.end('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":10,"total_tokens":20}}\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: result.message, finish_reason: result.finish }] }));
    }
  } catch (error) {
    console.error('fixture assertion:', error.message);
    serverError = error;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'The reasoning_content in the thinking mode must be passed back to the API.' } }));
  }
});

function handler(relative) {
  const filename = path.resolve(__dirname, relative);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = name => name.endsWith('/lib/runtime') ? { ensureRuntime: () => ({ ok: true }) }
    : name.endsWith('/lib/agentTaskWorker') ? { wakeAgentTaskWorker() {} } : originalRequire(name);
  mod._compile(fs.readFileSync(filename, 'utf8').replace('export default', 'module.exports ='), filename);
  return mod.exports;
}
function response() {
  return { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { llmApiKey: 'fixture-key', llmBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    llmApiProtocol: 'openai', llmModel: 'deepseek-v4-flash', llmContextWindowTokens: 800000, llmMaxOutputTokens: 1024 };
  const { completeToolChat, toOpenAiMessages, toAnthropicMessages } = require('../lib/llm');
  const { estimateMessagesTokens } = require('../lib/llmBudget');
  const { compactMessages } = require('../lib/agentMessageProjection');
  const { providerSource } = require('../lib/llmProviderState');
  const tools = [{ name: 'read_file', description: 'read', input_schema: { type: 'object' } }];
  const initial = [{ role: 'user', content: '测试' }];
  scripts = [() => reply('JSON 回复', [tool('json-read', 'read_file', { path: 'a.md' })])];
  const parsed = await completeToolChat({ llmConfig: config, messages: initial, tools });
  assert.equal(parsed.providerState.reasoningContent, expectedReasoning.get('JSON 回复'));
  assert(!JSON.stringify(parsed.content).includes(secret));
  const history = [...initial, parsed, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'json-read', content: 'done' }] }];
  let visible = '';
  scripts = [() => reply('无工具补轮', [], 'length')];
  const streamed = await completeToolChat({ llmConfig: config, messages: history, tools, onVisibleText: s => { visible += s; } });
  assert.equal(visible, '无工具补轮');
  assert.equal(streamed.providerState.reasoningContent, expectedReasoning.get('无工具补轮'));
  history.push(streamed);
  scripts = [() => reply('续轮完成')];
  await completeToolChat({ llmConfig: config, messages: history, tools });
  assert(estimateMessagesTokens(history) > estimateMessagesTokens(history.map(({ providerState: _state, ...message }) => message)) + 10000);
  assert.equal(compactMessages(history, 800000)[1].providerState.reasoningContent, parsed.providerState.reasoningContent);
  for (const message of compactMessages(history, 18000)) {
    if (message.providerState) assert.equal(message.providerState.reasoningContent, expectedReasoning.get(message.content.find(block => block.type === 'text')?.text));
  }
  assert(!JSON.stringify(toAnthropicMessages(history)).includes(secret));
  assert(!JSON.stringify(toOpenAiMessages('', history, providerSource({ ...config, llmBaseUrl: config.llmBaseUrl + '/other' }))).includes(secret));
  scripts = [body => {
    assert(!JSON.stringify(body).includes(secret));
    assert.equal(body.messages.filter(message => message.role === 'tool').length, 0);
    return reply('新端点已完成');
  }];
  await completeToolChat({ llmConfig: { ...config, llmBaseUrl: config.llmBaseUrl + '/other' }, messages: history, tools });
  scripts = [body => {
    assert.equal(body.messages.filter(m => m.role === 'assistant').length, 0);
    assert.equal(body.messages.filter(m => m.role === 'tool').length, 0);
    assert(JSON.stringify(body.messages).includes('json-read'));
    return reply('旧记录已兼容');
  }];
  await completeToolChat({ llmConfig: config, messages: history.map(({ providerState: _state, ...message }) => message), tools });

  const { ensureConversation } = require('../lib/conversations');
  const sessions = require('../lib/agentSession');
  const { runAgentLoop } = require('../lib/agentLoop');
  const { createTask } = require('../lib/agentTaskQueue');
  const { composeTurnFrame } = require('../lib/agentSemanticRuntime');
  const { createFile, getFileByPath } = require('../lib/files');
  const conversation = ensureConversation({ kind: 'canvas', title: 'DeepSeek 续轮' });
  const events = [];
  async function task(goal, approvalMode = 'auto_confirm') {
    const created = sessions.createSession({ goal, conversationId: conversation.id, authorizedPaths: ['*'], authorizedOps: ['create', 'modify'], approvalMode });
    const task = createTask({ sessionId: created.sessionId, conversationId: conversation.id, input: { user_query: goal, approval_mode: approvalMode } });
    const { frame } = await composeTurnFrame({ session: sessions.getSession(created.sessionId), task, userQuery: goal, allowSemanticPlanner: false });
    return { ...created, taskId: task.id, turnFrame: frame, approvalMode, llmConfig: config, onStream: event => events.push(event) };
  }
  // One response, two writes; disconnect after the first successful application.
  const automatic = await task('创建 first.md 和 second.md');
  scripts = [() => reply('创建两份文件', [tool('create-first', 'create_note', { path: 'first.md', content: '# First' }), tool('create-second', 'create_note', { path: 'second.md', content: '# Second' })]), () => reply('两份文件已创建。')];
  const abort = new AbortController();
  const interrupted = await runAgentLoop({ ...automatic, signal: abort.signal, onStream: event => {
    events.push(event);
    if (event.artifact_type === 'operation_set') abort.abort('connection_lost');
  } });
  assert.equal(interrupted.status, 'queued_resume');
  const checkpoint = sessions.loadMessagesCheckpoint(automatic.sessionId);
  assert.equal(checkpoint.nextToolIndex, 1);
  assert.equal(checkpoint.lastResponseProviderState.reasoningContent, expectedReasoning.get('创建两份文件'));
  assert.equal((await runAgentLoop(automatic)).status, 'completed');
  assert(getFileByPath('first.md')); assert(getFileByPath('second.md'));
  assert.equal(events.filter(e => e.stage === 'tool_start' && e.text.includes('create_note')).length, 2, '成功写入不重放');

  // Legacy array checkpoint: preserve existing tool facts when native reasoning was lost.
  const legacy = await task('根据已有执行记录总结');
  const legacyMessages = [{ role: 'user', content: [{ type: 'text', text: '原任务' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'legacy-write', name: 'create_note', input: { path: 'first.md' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'legacy-write', content: JSON.stringify({ tool_name: 'create_note', status: 'success', summary: 'first.md 已创建' }) }] }];
  sessions.saveMessagesCheckpoint(legacy.sessionId, legacyMessages, [], '');
  scripts = [body => {
    assert.equal(body.messages.filter(message => ['assistant', 'tool'].includes(message.role)).length, 0);
    assert(JSON.stringify(body.messages).includes('legacy-write'));
    return reply('已有文件保持，任务完成。');
  }];
  assert.equal((await runAgentLoop(legacy)).status, 'completed');
  assert.equal(sessions.listRunLogs(legacy.sessionId).filter(log => log.tool_name === 'create_note').length, 0);
  // The inline fallback uses the same private state while the public loader stays array-compatible.
  const fallback = await task('checkpoint 兼容检查');
  sessions.saveMessagesCheckpoint(fallback.sessionId, initial, parsed.content, '', '', { lastResponseProviderState: parsed.providerState });
  const db = require('../lib/db').getDb();
  db.prepare("UPDATE agent_checkpoints SET status = 'superseded' WHERE session_id = ?").run(fallback.sessionId);
  const loadedFallback = sessions.loadMessagesCheckpoint(fallback.sessionId);
  assert(Array.isArray(loadedFallback.lastResponseContent));
  assert.equal(loadedFallback.lastResponseProviderState.reasoningContent, parsed.providerState.reasoningContent);

  // Manual confirmation must preserve the pending response, including remaining tools.
  createFile('manual.md', '# 原文');
  const manual = await task('修改 manual.md', 'manual_confirm');
  scripts = [() => reply('准备修改', [tool('manual-edit', 'preview_file_revision', { file_path: 'manual.md', draft_content: '# 修改后' }), tool('manual-read', 'read_file', { path: 'manual.md' })]), () => reply('修改已保存。')];
  const waiting = await runAgentLoop(manual);
  assert.equal(waiting.status, 'waiting_operation_confirmation');
  assert.equal(sessions.loadMessagesCheckpoint(manual.sessionId).lastResponseProviderState.reasoningContent, expectedReasoning.get('准备修改'));
  const applied = response();
  await handler('../pages/api/agent/loop/apply.js')({ method: 'POST', headers: {}, body: {
    session_id: manual.sessionId, session_token: manual.token, operation_set_id: waiting.operation_set_id, action: 'apply',
    current_conversation_id: conversation.id,
  } }, applied);
  assert.equal(applied.code, 200, JSON.stringify(applied.body));
  assert(applied.body.success); assert(applied.body.task_resumed);
  assert(!JSON.stringify(applied.body).includes(secret));
  assert(!('messages_checkpoint' in applied.body.session));
  assert.equal((await runAgentLoop(manual)).status, 'completed');
  assert.match(getFileByPath('manual.md').content, /^---\nid: "notus_[a-f0-9]+"\n---\n\n# 修改后$/);

  // Answer card, then resume using the exact response reasoning.
  const question = await task('请确认目标用户后给出建议');
  scripts = [() => reply('确认目标用户', [tool('question', 'ask_question_card', { title: '目标用户', questions: [{ id: 'audience', label: '目标用户', question: '目标用户是谁？' }] })]), body => {
    assert(JSON.stringify(body.messages).includes('个人用户'));
    return reply('已收到目标用户。');
  }];
  const questionWaiting = await runAgentLoop(question);
  assert.equal(questionWaiting.status, 'waiting_interaction');
  const sessionHandler = handler('../pages/api/agent/sessions/[id].js');
  const { issueCapability } = require('../lib/agentControlPlane');
  for (const headers of [{ 'x-agent-session-token': question.token }, { 'x-agent-control-ticket': issueCapability({ sessionId: question.sessionId, action: 'session_read' }) }]) {
    const res = response();
    await sessionHandler({ method: 'GET', query: { id: question.sessionId }, headers }, res);
    assert.equal(res.code, 200);
    assert(!JSON.stringify(res.body).includes(secret));
    assert(!('messages_checkpoint' in res.body.session));
  }
  const { getInteractionById, normalizeInteractionResponse, updateInteractionWhen } = require('../lib/conversationInteractions');
  const interaction = getInteractionById(questionWaiting.interaction_id);
  const answer = normalizeInteractionResponse(interaction, { answers: { audience: { value: '个人用户' } } });
  updateInteractionWhen(interaction.id, ['pending'], { status: 'answered', response: answer, answeredAt: new Date().toISOString() });
  assert.equal((await runAgentLoop({ ...question, resumeInteractionId: interaction.id })).status, 'completed');

  // Resource approval can pause a no-tool reply, or resolve while a reply is arriving.
  const { createInteraction } = require('../lib/conversationInteractions');
  const resource = await task('等待资源确认后继续总结');
  const approval = createInteraction({ conversationId: conversation.id, kind: 'resource_approval',
    payload: { agent_session_id: resource.sessionId, action: 'fixture_resource' } });
  scripts = [() => reply('等待资源结果')];
  assert.equal((await runAgentLoop(resource)).status, 'waiting_interaction');
  assert(sessions.loadMessagesCheckpoint(resource.sessionId).messages.some(message => message.providerState?.reasoningContent === expectedReasoning.get('等待资源结果')));
  scripts = [body => {
    assert(JSON.stringify(body.messages).includes('fixture_resource'));
    return reply('资源结果已确认。');
  }];
  updateInteractionWhen(approval.id, ['pending'], { status: 'answered', response: { success: true }, answeredAt: new Date().toISOString() });
  assert.equal((await runAgentLoop(resource)).status, 'completed');
  const concurrentResource = await task('根据资源执行回执继续');
  const concurrentApproval = createInteraction({ conversationId: conversation.id, kind: 'resource_approval',
    payload: { agent_session_id: concurrentResource.sessionId, action: 'fixture_concurrent' } });
  scripts = [() => {
    updateInteractionWhen(concurrentApproval.id, ['pending'], { status: 'answered', response: { success: true }, answeredAt: new Date().toISOString() });
    return reply('等待期间的回复');
  }, body => {
    assert(body.messages.some(message => message.content === '等待期间的回复'));
    return reply('资源并行完成。');
  }];
  assert.equal((await runAgentLoop(concurrentResource)).status, 'completed');

  // Completion correction also needs the no-tool assistant response in history.
  const correction = await task('创建 correction.md');
  correction.turnFrame.intent.completion_criteria = { requires_write: true, requires_applied_write: true, requires_answer: true };
  scripts = [() => reply('已创建 correction.md。'), body => {
    assert(body.messages.some(m => m.content === '已创建 correction.md。' && m.reasoning_content === expectedReasoning.get('已创建 correction.md。')));
    return reply('补充实际写入', [tool('correction-write', 'create_note', { path: 'correction.md', content: '# Corrected' })]);
  }, () => reply('文件已实际创建。')];
  assert.equal((await runAgentLoop(correction)).status, 'completed');
  assert(getFileByPath('correction.md'));

  // The ordinary no-tool continuation and rejected control batch keep native state too.
  const continuation = await task('读取 first.md 并总结内容');
  scripts = [() => reply('尚在继续', [], 'length'), () => reply('不合法混合调用', [
    tool('invalid-read', 'read_file', { path: 'first.md' }), tool('invalid-question', 'ask_question_card', {})]),
  body => {
    assert.equal(body.messages.filter(message => message.role === 'tool').length, 2);
    return reply('使用合法读取', [tool('valid-read', 'read_file', { path: 'first.md' })]);
  }, () => reply('读取总结已完成。')];
  assert.equal((await runAgentLoop(continuation)).status, 'completed');
  assert.equal(sessions.listRunLogs(continuation.sessionId).filter(log => log.tool_name === 'read_file' && log.status === 'success').length, 1);

  // A saved failed request switches model without replaying the successful read.
  const switched = await task('读取 first.md 后总结');
  scripts = [() => reply('先读取', [tool('switch-read', 'read_file', { path: 'first.md' })]), () => ({ error: true })];
  assert.equal((await runAgentLoop(switched)).status, 'waiting_model_recovery');
  scripts = [() => reply('切换模型已完成。')];
  assert.equal((await runAgentLoop({ ...switched, llmConfig: { ...config, llmModel: 'other-model' } })).status, 'completed');
  scripts = [() => reply('其他协议已完成。')];
  assert.equal((await runAgentLoop({ ...switched, llmConfig: { ...config, llmApiProtocol: 'anthropic', llmModel: 'other-protocol' } })).status, 'completed');
  assert.equal(sessions.listRunLogs(switched.sessionId).filter(log => log.tool_name === 'read_file').length, 1);

  assert.equal(serverError, undefined, serverError?.stack);
  assert.equal(scripts.length, 0);
  assert(!JSON.stringify(events).includes(secret), 'SSE不能泄漏推理');
  for (const sessionId of [automatic.sessionId, legacy.sessionId, manual.sessionId, question.sessionId, resource.sessionId, concurrentResource.sessionId, correction.sessionId, continuation.sessionId, switched.sessionId]) {
    assert(!JSON.stringify(sessions.listRunLogs(sessionId)).includes(secret));
    assert(!JSON.stringify(sessions.listRunEvents(sessionId)).includes(secret));
  }
  const logs = fs.readdirSync(path.join(root, 'logs')).map(name => fs.readFileSync(path.join(root, 'logs', name), 'utf8')).join('');
  assert(!logs.includes(secret));
  console.log(`DeepSeek reasoning HTTP/JSON/SSE/checkpoint/privacy regression passed (${requests.length} requests)`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await new Promise(resolve => server.close(resolve));
  await require('../lib/runtime').stopRuntime();
  fs.rmSync(root, { recursive: true, force: true });
});
