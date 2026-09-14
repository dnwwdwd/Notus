const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-state-flow-'));
Object.assign(process.env, {
  NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: temp,
  NOTES_DIR: path.join(temp, 'notes'), ASSETS_DIR: path.join(temp, 'assets'),
  DB_PATH: path.join(temp, 'index.db'), SESSION_DIR: path.join(temp, 'session'),
  LOG_DIR: path.join(temp, 'logs'), NOTUS_AGENT_RUNTIME_MODE: 'legacy',
});
function stub(name, exports) {
  const id = require.resolve(`../lib/${name}`);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('indexer', { triggerIncrementalIndex: async () => {} });
stub('runtime', { ensureRuntime: () => ({ ok: true }) });
stub('agentTaskWorker', { wakeAgentTaskWorker: () => {} });
let materializeGate = null;
const media = require('../lib/conversationImageAssets');
stub('conversationImageAssets', {
  ...media,
  materializeConversationImages: async (input) => {
    if (materializeGate) await materializeGate;
    return { content: input.content, media_changes: input.mediaChanges || [] };
  },
});
const { getDb } = require('../lib/db');
const files = require('../lib/files');
const sessions = require('../lib/agentSession');
const queue = require('../lib/agentTaskQueue');
const control = require('../lib/agentControlPlane');
const ops = require('../lib/canvasOperationSets');
const changes = require('../lib/agentTaskChangeSets');
const agent = require('../lib/agentTools');
function context(title) {
  const conversation = require('../lib/conversations').ensureConversation({ kind: 'canvas', title });
  const session = sessions.createSession({ goal: title, authorizedPaths: [''], authorizedOps: ['modify', 'create'], conversationId: conversation.id });
  queue.createTask({ sessionId: session.sessionId, conversationId: conversation.id, approvalMode: 'manual_confirm' });
  return { conversation, session };
}
function preview(ctx, patches) {
  const set = ops.createOperationSet({ conversationId: ctx.conversation.id, agentSessionId: ctx.session.sessionId, patches });
  changes.registerOperationSet({ operationSetId: set.id, sessionId: ctx.session.sessionId, approvalMode: 'manual_confirm' });
  return set;
}
function loadRoute(relativePath) {
  const filename = path.join(root, 'pages/api', relativePath);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(filename, 'utf8').replace('export default', 'module.exports ='), filename);
  return mod.exports;
}
async function call(handler, body) {
  const result = {};
  const res = { status(n) { result.status = n; return this; }, json(body) { result.body = body; return this; }, setHeader() {}, getHeader() {} };
  await handler({ method: 'POST', body, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  return result;
}
async function run() {
  const apply = loadRoute('agent/loop/apply.js');
  const ctx = context('额度与权限');
  const body = { session_id: ctx.session.sessionId, session_token: ctx.session.token, current_conversation_id: ctx.conversation.id };
  const ticket = control.issueCapability({ sessionId: ctx.session.sessionId, action: 'extend' });
  assert.equal((await call(apply, { ...body, action: 'extend', control_ticket: ticket })).status, 409);
  assert.equal(control.validateCapability(ticket).consumed, false, '拒绝请求不能消耗额度确认票据');
  sessions.updateSessionStatus(ctx.session.sessionId, 'waiting_limit_confirmation');
  queue.updateTask(ctx.session.sessionId, { status: 'waiting_limit_confirmation' });
  assert.equal((await call(apply, { ...body, action: 'extend', control_ticket: ticket })).status, 200);
  const limit = sessions.getSession(ctx.session.sessionId).hard_limit;
  assert.equal(queue.getTaskBySession(ctx.session.sessionId).status, 'queued');
  await call(apply, { ...body, action: 'extend', control_ticket: ticket });
  assert.equal(sessions.getSession(ctx.session.sessionId).hard_limit, limit, '同票据重复请求不能重复增加额度');
  assert.equal((await call(loadRoute('agent/loop/start.js'), { ...body, subscribe_only: true })).status, 202);

  files.createFile('patch.md', '# patch\nalpha delta\n');
  const set = preview(ctx, [
    { file_path: 'patch.md', old: 'alpha', new: 'beta', change_type: 'modify' },
    { file_path: 'patch.md', old: 'delta', new: 'epsilon', change_type: 'modify' },
  ]);
  process.env.NOTUS_AGENT_RUNTIME_MODE = 'shadow';
  const operate = control.issueCapability({ sessionId: ctx.session.sessionId, action: 'operate' });
  const first = await call(apply, { ...body, action: 'apply_file', operation_set_id: set.id, patch_index: 0, control_ticket: operate });
  assert.equal(first.status, 200, 'scoped ticket 与 token 必须使用相同的已授权 session 上下文');
  let item = changes.getTaskChangeSetDetail(ctx.session.sessionId).items[0];
  assert.ok(item.applied_content.includes('beta delta'));
  assert.ok(item.pending_content.includes('beta epsilon'));
  process.env.NOTUS_AGENT_RUNTIME_MODE = 'legacy';
  await call(apply, { ...body, action: 'apply_all', operation_set_id: set.id });
  await call(apply, { ...body, action: 'rollback_file', operation_set_id: set.id, patch_index: 0 });
  item = changes.getTaskChangeSetDetail(ctx.session.sessionId).items[0];
  assert.ok(item.applied_content.includes('alpha epsilon'));
  const other = context('另一个任务');
  const rejected = await call(apply, { ...body, session_id: other.session.sessionId, session_token: other.session.token, action: 'reject', operation_set_id: set.id });
  assert.equal(rejected.status, 403, 'reject 不能跨任务操作，即使提供有效票据');
  assert.notEqual(ops.getOperationSetById(set.id).status, 'cancelled');

  files.createFile('parallel.md', '# parallel\nalpha delta\n');
  const concurrent = preview(ctx, [
    { file_path: 'parallel.md', old: 'alpha', new: 'beta', change_type: 'modify' },
    { file_path: 'parallel.md', old: 'delta', new: 'epsilon', change_type: 'modify' },
  ]);
  const results = await Promise.all([0, 1].map((patchIndex) => agent.applyPreviewPatchFile(concurrent.id, ctx.session.sessionId, { patchIndex })));
  assert.ok(results.every((result) => result.success));
  assert.ok(files.getFileByPath('parallel.md').content.includes('beta epsilon'));
  assert.deepEqual(ops.getOperationSetById(concurrent.id).patches.map((patch) => patch.status), ['applied', 'applied']);

  files.createFile('race.md', '# race\nalpha\n');
  const revision = await agent.previewFileRevision({ file_path: 'race.md', draft_content: '# race\nbeta\n' }, ctx.session.sessionId);
  let release;
  materializeGate = new Promise((resolve) => { release = resolve; });
  const pending = agent.applyFileRevision(revision.operation_set_id, ctx.session.sessionId);
  fs.writeFileSync(path.join(temp, 'notes/race.md'), '# race\nUSER EDIT\n');
  release();
  assert.equal((await pending).conflict, true);
  assert.ok(files.getFileByPath('race.md').content.includes('USER EDIT'));
  materializeGate = null;

  files.createFile('folder/child.md', '# child\nalpha\n');
  const childSet = preview(ctx, [{ file_path: 'folder/child.md', old: 'alpha', new: 'beta', change_type: 'modify' }]);
  await agent.applyPreviewPatchFile(childSet.id, ctx.session.sessionId, { patchIndex: 0 });
  changes.resolveOperationSet({ operationSetId: childSet.id, sessionId: ctx.session.sessionId, resolution: 'applied' });
  const move = preview(ctx, [{ change_type: 'move_folder', old_path: 'folder', new_path: 'parent/renamed' }]);
  assert.equal((await agent.applyPreviewPatchFile(move.id, ctx.session.sessionId, { patchIndex: 0 })).success, true);
  assert.ok(files.getFileByPath('parent/renamed/child.md'));
  item = changes.getTaskChangeSetDetail(ctx.session.sessionId).items.find((row) => row.resource_key === 'folder/child.md');
  assert.equal(item.applied_path, 'parent/renamed/child.md');

  // 另一文件的全文修订不能改变先前文件的累计结果。
  files.createFile('revision-b.md', '# revision-b\nold content\n');
  const separate = await agent.previewFileRevision({ file_path: 'revision-b.md', draft_content: '# revision-b\nnew content\n' }, ctx.session.sessionId);
  changes.registerOperationSet({ operationSetId: separate.operation_set_id, sessionId: ctx.session.sessionId });
  assert.equal((await agent.applyFileRevision(separate.operation_set_id, ctx.session.sessionId)).success, true);
  const separateDetail = changes.getTaskChangeSetDetail(ctx.session.sessionId);
  assert.ok(separateDetail.items.find((row) => row.resource_key === 'parallel.md').applied_content.includes('beta epsilon'));
  assert.equal(separateDetail.items.find((row) => row.resource_key === 'folder/child.md').applied_path, 'parent/renamed/child.md');

  const firstRespond = control.issueCapability({ sessionId: ctx.session.sessionId, interactionId: 100, action: 'respond' });
  control.issueCapability({ sessionId: ctx.session.sessionId, interactionId: 100, action: 'respond' });
  assert.equal(control.validateCapability(firstRespond).valid, true);

  const completed = context('中断后恢复最终消息');
  sessions.updateSessionStatus(completed.session.sessionId, 'completed');
  sessions.recordRunEvent({ sessionId: completed.session.sessionId, event: { type: 'final', status: 'completed', text: '已保存的最终正文' } });
  queue.recoverOrphanedTasks();
  queue.recoverOrphanedTasks();
  const task = queue.getTaskBySession(completed.session.sessionId);
  assert.ok(task.final_message_id);
  const messages = getDb().prepare("SELECT content FROM messages WHERE conversation_id=? AND role='assistant'").all(completed.conversation.id);
  assert.deepEqual(messages.map((message) => message.content), ['已保存的最终正文']);

  let stops = 0;
  let starts = 0;
  stub('runtime', { beginDataMaintenance() {}, endDataMaintenance() {}, stopRuntime: async () => { stops += 1; }, ensureRuntime: () => { starts += 1; return { ok: true }; } });
  const filename = path.join(root, 'lib/backup.js');
  const backup = new Module(filename, module);
  backup.filename = filename;
  backup.paths = Module._nodeModulePaths(path.dirname(filename));
  backup._compile(fs.readFileSync(filename, 'utf8').replace('await validateZip(zipPath, stage);', '/* 隔离测试只检查拒绝路径，不解析 ZIP */'), filename);
  await assert.rejects(backup.exports.restoreFromZip('/unused-test.zip'), { code: 'BACKUP_ACTIVE_TASKS' });
  assert.equal(stops, 0);
  assert.equal(starts, 0);
  console.log('audit state flow regressions passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
