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
  const { buildTree, createFile, getFileByPath, getFileById } = require('../lib/files');
  const { buildToolDefinitions, executeCreateNote, executeReadFile, executeToolSafely, applyFileRevision, applyPreviewWithConflictCheck, rollbackFileRevision } = require('../lib/agentTools');
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
  const { getOperationSetById } = require('../lib/canvasOperationSets');
  const { setSetting } = require('../lib/db');
  const { createDiffHunks } = require('../utils/lineDiff');
  const query = '在文章开头要求读者为此项目点点 star，你的✨才是我的更新动力';
  assert.equal(deterministicIntent(query).task_kind, 'file_write');
  for (const text of ['不要修改文章，只查看内容', '查看我之前是不是写过一个 api key 的管理工具', '不要在文章开头要求读者点 star']) {
    assert(!deterministicIntent(text).allowed_actions.includes('write'), text);
  }
  let original = '# 管理工具\n\n原文第一段\n\n原文第二段\n';
  const filePath = 'typora_files/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/管理工具.md';
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
    ({ messages }) => {
      const receipt = JSON.parse(messages.at(-1).content[0].content);
      assert.equal(receipt.file_refs[0].file_path, filePath, '合法长路径应保持可用于定位');
      return response([tool('window1', 'read_tool_result', { result_ref: receipt.result_ref })]);
    },
    ({ messages }) => {
      const window = JSON.parse(messages.at(-1).content[0].content);
      assert.equal(JSON.parse(window.content).file_path, filePath, '归档和读取窗口不得再次损坏路径');
      return response([tool('w1', 'preview_file_revision', { file_path: `notus://file/${file.id}`, draft_content: edited }), tool('r2', 'read_file', { path: filePath })]);
    },
    ({ messages }) => {
      const results = messages[messages.length - 1].content;
      assert.deepEqual(results.map(b => b.tool_use_id), ['w1', 'r2']);
      assert.equal(JSON.parse(results[0].content).applied, true, results[0].content);
      assert.equal(getFileByPath(filePath).content, edited);
      return response([{ type: 'text', text: '已在开头添加 Star 提示。' }]);
    },
  ];
  const done = await runAgentLoop(run);
  assert.equal(done.status, 'completed'); assert.equal(requests.length, 5);
  const detail = getTaskChangeSetDetail(run.sessionId);
  const patch = detail.operation_set_view.patches[0];
  assert.equal(patch.file_path, filePath, 'ID 修订应产生真实路径的 Diff');
  assert.equal(createDiffHunks(patch.old, patch.new).flatMap(h => h.lines).filter(l => l.type === 'delete').length, 0);
  // Manual confirmation in the middle of a multi-tool response resumes the remaining read.
  const manual = await task('修改文章结尾', 'manual_confirm');
  const next = edited + '\n追加结尾\n';
  scripts = [() => response([tool('m1', 'preview_file_revision', { file_path: `notus://file/${file.id}`, draft_content: next }), tool('m2', 'read_file', { path: filePath })]),
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
  // Resolve IDs against the current database path and retain operation permissions.
  const moved = createFile('移动前.md', '# 移动笔记\n旧内容', { titleFilenameBindingEnabled: false });
  require('../lib/files').renameFile(moved.path, '新目录/移动后.md');
  const movedRef = `notus://file/${moved.id}`;
  assert.equal(executeReadFile({ path: movedRef }).file_path, '新目录/移动后.md');
  const deniedSession = createSession({ goal: '创建文件', conversationId: conversation.id, authorizedOps: ['create'] });
  for (const name of ['preview_file_revision', 'preview_patch_files']) {
    const input = name === 'preview_file_revision' ? { file_path: movedRef, draft_content: '# 移动笔记\n新内容' }
      : { patches: [{ file_path: movedRef, old: '旧内容', new: '新内容' }] };
    const denied = await executeToolSafely({ name, input }, getSession(deniedSession.sessionId));
    assert.equal(denied.error, 'PERMISSION_DENIED', JSON.stringify(denied));
    const missingInput = name === 'preview_file_revision' ? { ...input, file_path: 'notus://file/999999999' }
      : { patches: [{ ...input.patches[0], file_path: 'notus://file/999999999' }] };
    assert.equal((await executeToolSafely({ name, input: missingInput }, getSession(run.sessionId))).error, 'FILE_NOT_FOUND');
  }
  const partial = await task('修改移动笔记内容');
  scripts = [() => response([tool('partial', 'preview_patch_files', { patches: [{ file_path: movedRef, old: '旧内容', new: '新内容' }] })]),
    () => response([{ type: 'text', text: '已修改移动后的笔记。' }])];
  assert.equal((await runAgentLoop(partial)).status, 'completed');
  assert(getFileById(moved.id).content.includes('新内容'));
  assert.equal(getTaskChangeSetDetail(partial.sessionId).operation_set_view.patches[0].file_path, '新目录/移动后.md');
  // A new file occupying the old path must never receive an ID-targeted preview or rollback.
  for (const name of ['preview_file_revision', 'preview_patch_files']) {
    const guarded = await task('修改文件内容');
    const sourcePath = `身份校验/${name}.md`;
    const source = createFile(sourcePath, '# 身份校验\n旧正文', { titleFilenameBindingEnabled: false });
    const input = name === 'preview_file_revision' ? { file_path: `notus://file/${source.id}`, draft_content: source.content.replace('旧正文', '新正文') }
      : { patches: [{ file_path: `notus://file/${source.id}`, old: '旧正文', new: '新正文' }] };
    const preview = await executeToolSafely({ name, input }, getSession(guarded.sessionId));
    assert(preview.operation_set_id, JSON.stringify(preview));
    const movedPath = `身份校验/已移动-${name}.md`;
    require('../lib/files').renameFile(sourcePath, movedPath);
    const replacement = createFile(sourcePath, '# 同路径新文件\n旧正文', { titleFilenameBindingEnabled: false });
    const refused = await applyPreviewWithConflictCheck(preview.operation_set_id, guarded.sessionId);
    assert.equal(refused.error || refused.conflicting_files?.[0]?.reason, 'FILE_IDENTITY_CHANGED', JSON.stringify(refused));
    assert.equal(getFileById(replacement.id).content, replacement.content);
    require('../lib/files').renameFile(sourcePath, `身份校验/替代文件-${name}.md`);
    require('../lib/files').renameFile(movedPath, sourcePath);
    const refreshed = name === 'preview_file_revision' ? await executeToolSafely({ name, input }, getSession(guarded.sessionId)) : preview;
    const appliedGuarded = await applyPreviewWithConflictCheck(refreshed.operation_set_id, guarded.sessionId);
    assert(appliedGuarded.success, JSON.stringify(appliedGuarded));
    require('../lib/files').renameFile(sourcePath, movedPath);
    const rollbackTarget = createFile(sourcePath, '# 同路径另一文件\n新正文', { titleFilenameBindingEnabled: false });
    const rollback = name === 'preview_file_revision' ? await rollbackFileRevision(refreshed.operation_set_id, guarded.sessionId)
      : await require('../lib/agentTools').rollbackPreviewPatchFile(refreshed.operation_set_id, guarded.sessionId);
    assert.equal(rollback.error || rollback.conflicting_files?.[0]?.reason, 'FILE_IDENTITY_CHANGED', JSON.stringify(rollback));
    assert.equal(getFileById(rollbackTarget.id).content, rollbackTarget.content);
  }
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
    const finalEvents = [];
    planning.onStream = (event) => { if (event.type === 'final') finalEvents.push(event); };
    const plannedTools = projectToolDefinitions(buildToolDefinitions(getSession(planning.sessionId)), planning.turnFrame);
    assert(plannedTools.some((item) => item.name === 'create_note'), `${mode} 应提供创建文件工具`);
    const target = `项目/礼品卡网站/${mode}.md`;
    scripts = [({ tools }) => {
      assert(tools.some((item) => item.name === 'create_note'));
      return response([tool(`${mode}-create`, 'create_note', { path: target, content: '# 产品需求\n\n充值与手续费规则。' })]);
    }, ({ messages }) => {
      const saved = getFileByPath(target);
      const receipt = JSON.parse(messages[messages.length - 1].content[0].content);
      assert.deepEqual(receipt.file_refs, [{ file_id: saved.id, file_path: saved.path }], '首次创建后的模型回执必须给出实际落盘 ID');
      return response([{ type: 'text', text: '产品需求文档已创建：[查看文件](notus://file/999999)' }]);
    }];
    const first = await runAgentLoop(planning);
    if (mode === 'manual_confirm') {
      assert.equal(first.status, 'waiting_operation_confirmation');
      assert.equal(getFileByPath(target), null);
      const appliedCreate = await applyPreviewWithConflictCheck(first.operation_set_id, planning.sessionId);
      assert(appliedCreate.success, JSON.stringify(appliedCreate));
      assert(resolveManualConfirmation({ operationSetId: first.operation_set_id, sessionId: planning.sessionId, action: 'apply_all', toolResult: appliedCreate }).resumed);
      assert.equal((await runAgentLoop(planning)).status, 'completed');
    } else assert.equal(first.status, 'completed');
    const createdFile = getFileByPath(target);
    assert(createdFile?.content.includes('充值与手续费规则'));
    const canonicalLink = `[查看文件](notus://file/${createdFile.id})`;
    assert(finalEvents.some(event => event.text.includes(canonicalLink)), '最终事件必须按已应用文件修正模型生成的失效链接');
    const { normalizeFinalAgentFileLinks } = require('../lib/agentFileLinkResolver');
    assert.equal(normalizeFinalAgentFileLinks('[查看文件](notus://file/999999)', planning.sessionId),
      canonicalLink, '刷新后仍可按同一任务记录的文件 ID 校正消息');
    assert.equal(normalizeFinalAgentFileLinks(canonicalLink, planning.sessionId), canonicalLink, '再次归一必须幂等');
    const { persistTaskFinalMessage } = require('../lib/agentTaskQueue');
    const finalMessageId = persistTaskFinalMessage(planning.sessionId, { content: '已完成：[查看文件](notus://file/999999)', status: 'completed' });
    assert.equal(require('../lib/db').getDb().prepare('SELECT content FROM messages WHERE id = ?').get(finalMessageId).content,
      `已完成：${canonicalLink}`, '入库前也必须校正失效链接');
    assert.equal(persistTaskFinalMessage(planning.sessionId, { content: '重复写入', status: 'completed' }), finalMessageId,
      '重复保存最终回复不得创建第二条消息');
    require('../lib/db').getDb().prepare('UPDATE messages SET content = ? WHERE id = ?')
      .run('历史回复：[查看文件](notus://file/999999)', finalMessageId);
    const restoredMessage = require('../lib/conversations').getConversationMessages(conversation.id).find(message => message.id === finalMessageId);
    assert.equal(restoredMessage.content, `历史回复：${canonicalLink}`, '旧消息读取时应根据任务已记录的文件 ID 校正链接');
    assert.equal(require('../lib/conversations').getConversationMessages(conversation.id).find(message => message.id === finalMessageId).content,
      restoredMessage.content, '重复读取历史消息必须得到相同文件 ID');
    assert.equal(require('../lib/db').getDb().prepare('SELECT content FROM messages WHERE id = ?').get(finalMessageId).content,
      '历史回复：[查看文件](notus://file/999999)', '历史读取不得回写消息或改动笔记');
    assert.equal(getFileById(createdFile.id)?.path, createdFile.path);
    assert.equal(buildTree().find(node => node.path === '项目')?.children.find(node => node.path === '项目/礼品卡网站')?.children.find(node => node.id === createdFile.id)?.path, createdFile.path);
    const replay = await applyPreviewWithConflictCheck(first.operation_set_id, planning.sessionId);
    assert(replay.success && replay.applied, JSON.stringify(replay));
    assert.equal(getFileByPath(target)?.id, createdFile.id, '重复应用不得创建新的数据库 ID');
    assert.throws(() => createFile(target, '# 其他内容'), /文件已存在/);
    assert.equal(getFileByPath(target)?.id, createdFile.id, '重复创建不得覆盖已应用文件');
    const invalid = await executeToolSafely({ name: 'create_note', input: { path: '缺正文.md' } }, getSession(planning.sessionId), undefined, { toolDefinitions: plannedTools });
    assert.equal(invalid.error, 'INVALID_TOOL_INPUT');
    assert(invalid.message.includes('Schema'));
    const unavailable = await executeToolSafely({ name: 'create_note', input: { path: '禁止.md', content: '# 禁止' } }, getSession(planning.sessionId), undefined, { toolDefinitions: [] });
    assert.equal(unavailable.error, 'UNKNOWN_TOOL');
    assert(!unavailable.message.includes('Schema'));
  }
  setSetting('editor_title_filename_binding_enabled', 'true');
  const interrupted = createSession({ goal: '新建恢复笔记', conversationId: conversation.id, authorizedPaths: ['*'], authorizedOps: ['create', 'modify'] });
  const interruptedPreview = await executeCreateNote({ path: '恢复前.md', content: '# 恢复后的标题\n\n正文' }, interrupted.sessionId);
  const pendingCreate = getOperationSetById(interruptedPreview.operation_set_id).patches[0];
  const writtenBeforeReceipt = createFile(pendingCreate.file_path, pendingCreate.new);
  assert.equal(getOperationSetById(interruptedPreview.operation_set_id).patches[0].status, 'pending');
  const recoveredCreate = await applyPreviewWithConflictCheck(interruptedPreview.operation_set_id, interrupted.sessionId);
  assert(recoveredCreate.success && recoveredCreate.applied, JSON.stringify(recoveredCreate));
  assert.equal(recoveredCreate.operation_set.patches[0].file_id, writtenBeforeReceipt.id, '写盘后回执前中断必须恢复同一文件身份');
  assert.equal(getFileById(writtenBeforeReceipt.id)?.path, writtenBeforeReceipt.path);
  assert.equal(getFileByPath('恢复前.md'), null, '标题绑定改名后不能重新创建旧路径');
  setSetting('editor_title_filename_binding_enabled', 'false');
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
