const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-edit-flow-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, NOTES_DIR: path.join(root, 'notes'), DB_PATH: path.join(root, 'db.sqlite'), ASSETS_DIR: path.join(root, 'assets'), LOG_DIR: path.join(root, 'logs'), SESSION_DIR: path.join(root, 'session') });
let scripts = [], requests = [];
const llmPath = require.resolve('../lib/llm');
require.cache[llmPath] = { id: llmPath, filename: llmPath, loaded: true, exports: {
  completeToolChat: async request => { requests.push(request); assert(scripts.length, '不得无进展循环'); try { return scripts.shift()(request); } catch (error) { console.error("scripted model assertion", error); throw error; } },
} };
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const response = content => ({ content, stopReason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn' });
async function main() {
  const { createFile, getFileByPath } = require('../lib/files');
  const { buildToolDefinitions, executeReadFile, executeToolSafely, applyFileRevision, applyPreviewWithConflictCheck, rollbackFileRevision } = require('../lib/agentTools');
  const { ensureConversation } = require('../lib/conversations');
  const { createSession, getSession, updateSessionStatus } = require('../lib/agentSession');
  const { createTask } = require('../lib/agentTaskQueue');
  const { composeTurnFrame, compileIntent, deterministicIntent } = require('../lib/agentSemanticRuntime');
  const { projectToolDefinitions } = require('../lib/agentToolProfile');
  const { updateTurnFrame } = require('../lib/agentTurnFrames');
  const { resolveFailedFileContinuation } = require('../lib/agentTaskContinuation');
  const { resolveManualConfirmation } = require('../lib/agentManualConfirmation');
  const { runAgentLoop } = require('../lib/agentLoop');
  const { getTaskChangeSetDetail } = require('../lib/agentTaskChangeSets');
  const { createDiffHunks } = require('../utils/lineDiff');
  const query = '在文章开头要求读者为此项目点点 star，你的✨才是我的更新动力';
  assert.equal(deterministicIntent(query).task_kind, 'file_write');
  for (const text of ['不要修改文章，只查看内容', '查看我之前是不是写过一个 api key 的管理工具', '不要在文章开头要求读者点 star']) {
    assert(!deterministicIntent(text).allowed_actions.includes('write'), text);
  }
  let original = '# 管理工具\n\n原文第一段\n\n原文第二段\n';
  const filePath = 'typora_files/项目/管理工具.md';
  createFile(filePath, original);
  const file = getFileByPath(filePath); original = file.content;
  assert.equal(executeReadFile({ path: '管理工具.md' }).file_path, filePath);
  assert.equal(executeReadFile({ path: `notus://file/${file.id}` }).file_id, file.id);
  createFile('其他/管理工具.md', '# 重名');
  const ambiguity = executeReadFile({ path: '管理工具.md' });
  assert.equal(ambiguity.error, 'FILE_PATH_AMBIGUOUS'); assert.equal(ambiguity.candidates.length, 2);
  assert(executeReadFile({ path: '不存在.md' }).message.includes('analyze_folder'));
  assert.equal(executeReadFile({ path: '../outside.md' }).error, 'INVALID_PATH');
  const conversation = ensureConversation({ kind: 'canvas', title: '查询转修改回归' });
  async function task(goal, mode = 'auto_confirm') {
    const { sessionId } = createSession({ goal, conversationId: conversation.id, authorizedPaths: ['*'], authorizedOps: ['create', 'modify'], approvalMode: mode });
    const session = getSession(sessionId);
    const task = createTask({ sessionId, conversationId: conversation.id, input: { user_query: goal, approval_mode: mode } });
    const { frame } = await composeTurnFrame({ session, task, userQuery: goal, allowSemanticPlanner: false });
    return { sessionId, taskId: task.id, turnFrame: frame, approvalMode: mode, llmConfig: { llmContextWindowTokens: 60000 } };
  }
  // Control-call batch rejection must return one result for every advertised tool.
  const run = await task(query);
  const edited = original.replace('# 管理工具\n', '# 管理工具\n\n欢迎点 Star！\n');
  scripts = [
    () => response([tool('r0', 'read_file', { path: filePath }), tool('q0', 'ask_question_card', {})]),
    ({ messages }) => {
      const last = messages[messages.length - 1];
      assert.deepEqual(last.content.map(b => b.tool_use_id), ['r0', 'q0']);
      assert(last.content.every(b => b.is_error));
      return response([tool('r1', 'read_file', { path: `notus://file/${file.id}` })]);
    },
    () => response([tool('w1', 'preview_file_revision', { file_path: filePath, draft_content: edited }), tool('r2', 'read_file', { path: filePath })]),
    ({ messages }) => {
      const results = messages[messages.length - 1].content;
      assert.deepEqual(results.map(b => b.tool_use_id), ['w1', 'r2']);
      assert.equal(JSON.parse(results[0].content).applied, true, results[0].content);
      assert.equal(getFileByPath(filePath).content, edited);
      return response([{ type: 'text', text: '已在开头添加 Star 提示。' }]);
    },
  ];
  const done = await runAgentLoop(run);
  assert.equal(done.status, 'completed'); assert.equal(requests.length, 4);
  const detail = getTaskChangeSetDetail(run.sessionId);
  const patch = detail.operation_set_view.patches[0];
  assert.equal(createDiffHunks(patch.old, patch.new).flatMap(h => h.lines).filter(l => l.type === 'delete').length, 0);
  // Manual confirmation in the middle of a multi-tool response resumes the remaining read.
  const manual = await task('修改文章结尾', 'manual_confirm');
  const next = edited + '\n追加结尾\n';
  scripts = [() => response([tool('m1', 'preview_file_revision', { file_path: filePath, draft_content: next }), tool('m2', 'read_file', { path: filePath })]),
    ({ messages }) => { assert.deepEqual(messages[messages.length - 1].content.map(b => b.tool_use_id), ['m1', 'm2']); return response([{ type: 'text', text: '修改已应用。' }]); }];
  const waiting = await runAgentLoop(manual);
  assert.equal(waiting.status, 'waiting_operation_confirmation'); assert.equal(getFileByPath(filePath).content, edited);
  const applied = await applyFileRevision(waiting.operation_set_id, manual.sessionId);
  assert(applied.success);
  const resolution = resolveManualConfirmation({ operationSetId: waiting.operation_set_id, sessionId: manual.sessionId, action: 'apply', toolResult: applied });
  assert(resolution.resumed);
  const resumed = await runAgentLoop(manual);
  assert.equal(resumed.status, 'completed'); assert.equal(getFileByPath(filePath).content, next);
  const rolled = await rollbackFileRevision(waiting.operation_set_id, manual.sessionId);
  assert(rolled.success); assert.equal(getFileByPath(filePath).content, edited);
  // A broad planning request may produce a workspace document in either confirmation mode.
  const planningGoal = '我想做一个 Apple 礼品卡代充网站，帮我理一下这个需求并拓展功能；不清楚的地方用提问卡片问我。';
  const planningIntent = deterministicIntent(planningGoal);
  assert.equal(planningIntent.task_kind, 'general');
  assert(planningIntent.allowed_actions.includes('write'));
  assert.equal(planningIntent.completion_criteria.requires_write, false, '讨论需求本身不强制创建文件');
  assert(compileIntent('general', planningIntent).allowed_actions.includes('write'));
  assert(deterministicIntent('请整理一份产品需求文档。').allowed_actions.includes('write'));
  for (const mode of ['auto_confirm', 'manual_confirm']) {
    const planning = await task(planningGoal, mode);
    const plannedTools = projectToolDefinitions(buildToolDefinitions(getSession(planning.sessionId)), planning.turnFrame);
    assert(plannedTools.some((item) => item.name === 'create_note'), `${mode} 应提供创建文件工具`);
    const target = `项目/礼品卡网站/${mode}.md`;
    scripts = [({ tools }) => {
      assert(tools.some((item) => item.name === 'create_note'));
      return response([tool(`${mode}-create`, 'create_note', { path: target, content: '# 产品需求\n\n充值与手续费规则。' })]);
    }, () => response([{ type: 'text', text: '产品需求文档已创建。' }])];
    const first = await runAgentLoop(planning);
    if (mode === 'manual_confirm') {
      assert.equal(first.status, 'waiting_operation_confirmation');
      assert.equal(getFileByPath(target), null);
      const appliedCreate = await applyPreviewWithConflictCheck(first.operation_set_id, planning.sessionId);
      assert(appliedCreate.success, JSON.stringify(appliedCreate));
      assert(resolveManualConfirmation({ operationSetId: first.operation_set_id, sessionId: planning.sessionId, action: 'apply_all', toolResult: appliedCreate }).resumed);
      assert.equal((await runAgentLoop(planning)).status, 'completed');
    } else assert.equal(first.status, 'completed');
    assert(getFileByPath(target)?.content.includes('充值与手续费规则'));
    const invalid = await executeToolSafely({ name: 'create_note', input: { path: '缺正文.md' } }, getSession(planning.sessionId), undefined, { toolDefinitions: plannedTools });
    assert.equal(invalid.error, 'INVALID_TOOL_INPUT');
    assert(invalid.message.includes('Schema'));
    const unavailable = await executeToolSafely({ name: 'create_note', input: { path: '禁止.md', content: '# 禁止' } }, getSession(planning.sessionId), undefined, { toolDefinitions: [] });
    assert.equal(unavailable.error, 'UNKNOWN_TOOL');
    assert(!unavailable.message.includes('Schema'));
  }
  const oldGeneral = await task(planningGoal);
  updateTurnFrame(oldGeneral.turnFrame.id, { intent: { ...oldGeneral.turnFrame.intent, allowed_actions: ['read'] } });
  const restoredGeneral = await composeTurnFrame({
    session: getSession(oldGeneral.sessionId), task: { id: oldGeneral.taskId },
    userQuery: planningGoal, allowSemanticPlanner: false,
  });
  assert(restoredGeneral.reused);
  assert(restoredGeneral.frame.intent.allowed_actions.includes('write'), '旧普通任务继续时应修正旧版只读误判');
  // A changed Turn Frame must change both the next Provider tool list and dispatch validation.
  const narrowed = await task(planningGoal);
  const forbiddenPath = '项目/礼品卡网站/不应创建.md';
  scripts = [() => {
    updateTurnFrame(narrowed.turnFrame.id, { intent: { ...narrowed.turnFrame.intent, allowed_actions: ['read'] } });
    return response([tool('narrow-read', 'read_file', { path: filePath })]);
  }, ({ tools }) => {
    assert(!tools.some((item) => item.name === 'create_note'));
    return response([tool('narrow-create', 'create_note', { path: forbiddenPath, content: '# 不应创建' })]);
  }, ({ messages }) => {
    const result = JSON.parse(messages[messages.length - 1].content[0].content);
    assert.equal(result.error_code, 'UNKNOWN_TOOL', JSON.stringify(result));
    return response([{ type: 'text', text: '当前没有创建文件。' }]);
  }];
  assert.equal((await runAgentLoop(narrowed)).status, 'completed');
  assert.equal(getFileByPath(forbiddenPath), null);
  const explicitReadOnly = deterministicIntent('只输出一段需求建议，不要修改文件。');
  assert(!explicitReadOnly.allowed_actions.includes('write'));
  assert(!deterministicIntent('只输出产品需求文档内容。').allowed_actions.includes('write'));
  assert(!projectToolDefinitions(buildToolDefinitions(getSession(run.sessionId)), { intent: explicitReadOnly }).some((item) => item.name === 'create_note'));
  // A normal completion with a real operation must not be repeated on a bare confirmation.
  const confirmed = await task('确认');
  assert.equal(resolveFailedFileContinuation(getSession(confirmed.sessionId)), null);
  // A legacy oral completion without an operation may carry forward only the explicit write goal.
  const oral = await task(query); updateSessionStatus(oral.sessionId, 'completed');
  const confirmation = await task('确认');
  assert(confirmation.turnFrame.intent.allowed_actions.includes('write'));
  assert.equal(confirmation.turnFrame.facts.failed_file_continuation.source_session_id, oral.sessionId);
  console.log('agent file edit flow tests passed');
  require('../lib/db').getDb().close();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
