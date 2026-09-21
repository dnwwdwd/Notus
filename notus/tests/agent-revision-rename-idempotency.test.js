const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-rename-identity-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, NOTES_DIR: path.join(root, 'notes'), DB_PATH: path.join(root, 'notus.db'), ASSETS_DIR: path.join(root, 'assets'), LOG_DIR: path.join(root, 'logs'), SESSION_DIR: path.join(root, 'session') });
const { getDb, setSetting } = require('../lib/db');
const { createFile, getFileByPath } = require('../lib/files');
const { createSession, getSession } = require('../lib/agentSession');
const { ensureConversation } = require('../lib/conversations');
const { createOperationSet, getOperationSetById, updateOperationSet } = require('../lib/canvasOperationSets');
const { previewFileRevision, applyFileRevision, rollbackFileRevision } = require('../lib/fileRevisions');
const { executeToolSafely, applyPreviewPatchFile, applyPreviewWithConflictCheck, rollbackPreviewPatchFile } = require('../lib/agentTools');
const { registerOperationSet, resolveOperationSet, getTaskChangeSetDetail } = require('../lib/agentTaskChangeSets');

function newSession(conversationId) {
  return createSession({ goal: '修改正文并重命名文件。', conversationId, authorizedPaths: [], authorizedOps: ['create', 'modify'] }).sessionId;
}
async function fixture(label) {
  setSetting('editor_title_filename_binding_enabled', 'true');
  const original = createFile(`${label}/旧标题.md`, '# 旧标题\n\n保留正文。\n');
  const conversation = ensureConversation({ kind: 'canvas', title: label });
  const sessionId = newSession(conversation.id);
  const preview = await previewFileRevision({ file_path: original.path, draft_content: original.content.replace('# 旧标题', '# 新标题') }, sessionId);
  registerOperationSet({ operationSetId: preview.operation_set_id, sessionId, conversationId: conversation.id });
  const applied = await applyFileRevision(preview.operation_set_id, sessionId, { auto: true });
  assert.ok(applied.success && applied.applied, JSON.stringify(applied));
  resolveOperationSet({ operationSetId: preview.operation_set_id, sessionId, resolution: 'applied', toolResult: applied });
  assert.equal(applied.operation_set.revision_base_path, original.path);
  const current = getFileByPath(`${label}/新标题.md`);
  assert.equal(current.id, original.id);
  let detail = getTaskChangeSetDetail(sessionId);
  assert.equal(detail.items[0].status, 'applied');
  assert.equal(detail.items[0].applied_path, current.path);
  assert.equal(detail.items[0].applied_content, current.content);
  return { original, current, conversation, sessionId, preview };
}
function duplicate(f, overrides = {}) {
  const set = createOperationSet({ conversationId: f.conversation.id, agentSessionId: f.sessionId, patches: [{ change_type: 'move_file', old_path: f.original.path, new_path: f.current.path }], ...overrides });
  registerOperationSet({ operationSetId: set.id, sessionId: overrides.agentSessionId || f.sessionId, conversationId: f.conversation.id });
  return set;
}
async function expectConflict(f, set) {
  const result = await applyPreviewWithConflictCheck(set.id, set.agent_session_id, { auto: true });
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(result.operation_set.patches[0].status, 'failed');
  assert.ok(!result.operation_set.patches[0].already_applied);
  return result;
}
async function main() {
  const f = await fixture('正常');
  const set = duplicate(f);
  const before = fs.statSync(path.join(root, 'notes', f.current.path)).mtimeMs;
  const applied = await applyPreviewPatchFile(set.id, f.sessionId, { patchIndex: 0 });
  assert.equal(applied.already_applied, true);
  assert.equal(applied.source_operation_set_id, f.preview.operation_set_id);
  assert.deepEqual(applied.changed_files, []);
  assert.equal(fs.statSync(path.join(root, 'notes', f.current.path)).mtimeMs, before);
  assert.equal(getTaskChangeSetDetail(f.sessionId).items.length, 1);
  assert.equal(getTaskChangeSetDetail(f.sessionId).applied_count, 1);
  const again = await applyPreviewWithConflictCheck(set.id, f.sessionId);
  assert.equal(again.success, true);
  const noOpRollback = await rollbackPreviewPatchFile(set.id, f.sessionId, { patchIndex: 0 });
  assert.ok(noOpRollback.success);
  assert.deepEqual(noOpRollback.changed_files, []);
  assert.equal(getFileByPath(f.current.path).content, f.current.content);
  assert.equal(getOperationSetById(f.preview.operation_set_id).status, 'applied');
  assert.equal((await rollbackFileRevision(f.preview.operation_set_id, f.sessionId)).success, true);
  assert.ok(getFileByPath(f.original.path));
  assert.equal(getFileByPath(f.current.path), null);

  const repeated = await fixture('多次改名统计');
  let previous = repeated.current;
  const revisions = [repeated.preview.operation_set_id];
  for (const title of ['阶段稿', '终稿', '最终定稿']) {
    const preview = await previewFileRevision({ file_path: previous.path, draft_content: previous.content.replace(/^# .+$/m, `# ${title}`) }, repeated.sessionId);
    registerOperationSet({ operationSetId: preview.operation_set_id, sessionId: repeated.sessionId, conversationId: repeated.conversation.id });
    const result = await applyFileRevision(preview.operation_set_id, repeated.sessionId, { auto: true });
    assert.ok(result.success);
    resolveOperationSet({ operationSetId: preview.operation_set_id, sessionId: repeated.sessionId, resolution: 'applied', toolResult: result });
    previous = getFileByPath(result.file_path);
    revisions.push(preview.operation_set_id);
    const detail = getTaskChangeSetDetail(repeated.sessionId);
    assert.equal(detail.file_count, 1);
    assert.equal(detail.items[0].applied_path, previous.path);
    assert.equal(detail.operation_set_view.patches[0].source_batches.length, revisions.length, '累计 Diff 不能丢掉中间改名批次');
    assert.equal(detail.applied_count, 1, '同文件连续改名不能按中间文件名重复计数');
  }
  const patch = createOperationSet({ conversationId: repeated.conversation.id, agentSessionId: repeated.sessionId, patches: [{ change_type: 'modify', file_path: previous.path, old: '保留正文。', new: '保留正文并补充。' }] });
  registerOperationSet({ operationSetId: patch.id, sessionId: repeated.sessionId, conversationId: repeated.conversation.id });
  const patched = await applyPreviewWithConflictCheck(patch.id, repeated.sessionId, { auto: true });
  assert.ok(patched.success);
  resolveOperationSet({ operationSetId: patch.id, sessionId: repeated.sessionId, resolution: 'applied', toolResult: patched });
  assert.equal(getTaskChangeSetDetail(repeated.sessionId).applied_count, 1, '全文修订和局部修改同一文件仍计一次');
  assert.ok((await rollbackPreviewPatchFile(patch.id, repeated.sessionId, { patchIndex: 0 })).success);
  for (const operationSetId of revisions.reverse()) {
    assert.ok((await rollbackFileRevision(operationSetId, repeated.sessionId)).success);
    resolveOperationSet({ operationSetId, sessionId: repeated.sessionId, resolution: 'rolled_back' });
  }
  assert.equal(getTaskChangeSetDetail(repeated.sessionId).rolled_back_count, 1, '多个改名批次回滚仍属于同一文件');

  const external = await fixture('外部改动');
  fs.appendFileSync(path.join(root, 'notes', external.current.path), '\n外部新增\n');
  await expectConflict(external, duplicate(external));
  assert.ok(getFileByPath(external.current.path).content.includes('外部新增'));

  const recreated = await fixture('旧路径重建');
  setSetting('editor_title_filename_binding_enabled', 'false');
  createFile(recreated.original.path, '# 另一份文件\n');
  await expectConflict(recreated, duplicate(recreated));
  assert.ok(getFileByPath(recreated.original.path).content.includes('另一份文件'));

  const otherSession = await fixture('跨任务');
  await expectConflict(otherSession, duplicate(otherSession, { agentSessionId: newSession(otherSession.conversation.id) }));

  const otherIdentity = await fixture('不同身份');
  getDb().prepare('UPDATE canvas_operation_sets SET file_id = NULL WHERE id = ?').run(otherIdentity.preview.operation_set_id);
  await expectConflict(otherIdentity, duplicate(otherIdentity));

  const legacy = await fixture('旧记录');
  getDb().prepare("UPDATE canvas_operation_sets SET revision_base_path = '' WHERE id = ?").run(legacy.preview.operation_set_id);
  await expectConflict(legacy, duplicate(legacy));

  const differentTarget = await fixture('其他目标');
  const target = createFile('其他目标/第三份.md', '# 第三份\n');
  const destination = duplicate(differentTarget, { patches: [{ change_type: 'move_file', old_path: differentTarget.original.path, new_path: target.path }] });
  await expectConflict(differentTarget, destination);
  assert.equal(getFileByPath(target.path).content, target.content);

  const cancelled = await fixture('已废弃');
  const cancelledSet = duplicate(cancelled);
  updateOperationSet(cancelledSet.id, { status: 'cancelled' });
  assert.equal((await applyPreviewPatchFile(cancelledSet.id, cancelled.sessionId, { patchIndex: 0 })).success, false);

  const symlink = await fixture('符号链接');
  const targetPath = path.join(root, 'notes', symlink.current.path);
  fs.renameSync(targetPath, `${targetPath}.real`);
  fs.symlinkSync(`${targetPath}.real`, targetPath);
  await expectConflict(symlink, duplicate(symlink));

  // 部分成功返回真实写入列表；失败补丁可以经单项应用重试，已完成项不重放。
  const partial = await fixture('部分失败');
  const partialSet = duplicate(partial, { patches: [
    { change_type: 'create_folder', folder_path: '已建目录' },
    { change_type: 'move_file', old_path: '不存在.md', new_path: '稍后.md' },
  ] });
  const failed = await applyPreviewWithConflictCheck(partialSet.id, partial.sessionId);
  assert.equal(failed.success, false);
  assert.equal(failed.partially_applied, true);
  assert.equal(failed.operation_set.patches[0].status, 'applied');
  assert.equal(failed.operation_set.patches[1].status, 'failed');
  setSetting('editor_title_filename_binding_enabled', 'false');
  createFile('不存在.md', '# 补充来源\n');
  assert.equal((await applyPreviewWithConflictCheck(partialSet.id, partial.sessionId)).success, true);
  assert.ok(getFileByPath('稍后.md'));

  // 工具参数中的服务端回执字段不能让真实移动或正文修改跳过回滚。
  const injectedSession = newSession(partial.conversation.id);
  createFile('注入来源.md', '# 注入来源\n');
  const injected = await executeToolSafely({ id: 'injected-operation', name: 'preview_file_operations', input: { operations: [{
    change_type: 'move_file', old_path: '注入来源.md', new_path: '注入目标.md', already_applied: true, source_operation_set_id: 1, status: 'applied',
  }] } }, getSession(injectedSession), process.env.NOTES_DIR);
  assert.ok(injected.operation_set_id, JSON.stringify(injected));
  assert.equal(getOperationSetById(injected.operation_set_id).patches[0].already_applied, undefined);
  assert.equal(getOperationSetById(injected.operation_set_id).patches[0].status, 'pending');
  assert.equal((await applyPreviewWithConflictCheck(injected.operation_set_id, injectedSession)).success, true);
  assert.ok(getFileByPath('注入目标.md'));
  assert.equal((await rollbackPreviewPatchFile(injected.operation_set_id, injectedSession, { patchIndex: 0 })).success, true);
  assert.ok(getFileByPath('注入来源.md'));
  const injectedPatch = await executeToolSafely({ id: 'injected-patch', name: 'preview_patch_files', input: { patches: [{
    file_path: '注入来源.md', old: '注入来源', new: '正文更新', change_type: 'move_file', old_path: '注入来源.md', new_path: '错误目标.md', already_applied: true, status: 'applied',
  }] } }, getSession(injectedSession), process.env.NOTES_DIR);
  assert.ok(injectedPatch.operation_set_id, JSON.stringify(injectedPatch));
  assert.equal(getOperationSetById(injectedPatch.operation_set_id).patches[0].already_applied, undefined);
  assert.equal((await applyPreviewWithConflictCheck(injectedPatch.operation_set_id, injectedSession)).success, true);
  assert.ok(getFileByPath('注入来源.md').content.includes('正文更新'));
  assert.equal(getFileByPath('错误目标.md'), null);
  assert.equal((await rollbackPreviewPatchFile(injectedPatch.operation_set_id, injectedSession, { patchIndex: 0 })).success, true);
  assert.ok(getFileByPath('注入来源.md').content.includes('注入来源'));

  // 升级前 pending 预览的路径可安全回填；旧已应用记录仍不能反推。
  setSetting('editor_title_filename_binding_enabled', 'true');
  const pendingFile = createFile('升级/旧标题.md', '# 旧标题\n\n正文\n');
  const upgradedSession = newSession(partial.conversation.id);
  const pendingRevision = await previewFileRevision({ file_path: pendingFile.path, draft_content: pendingFile.content.replace('# 旧标题', '# 新标题') }, upgradedSession);
  registerOperationSet({ operationSetId: pendingRevision.operation_set_id, sessionId: upgradedSession, conversationId: partial.conversation.id });
  getDb().prepare("UPDATE canvas_operation_sets SET revision_base_path = '' WHERE id = ?").run(pendingRevision.operation_set_id);
  require('../lib/migrations/016_revision_base_path').up(getDb());
  assert.equal(getOperationSetById(pendingRevision.operation_set_id).revision_base_path, pendingFile.path);
  assert.equal(getOperationSetById(legacy.preview.operation_set_id).revision_base_path, '');
  assert.equal((await applyFileRevision(pendingRevision.operation_set_id, upgradedSession)).success, true);
  const upgradedDetail = getTaskChangeSetDetail(upgradedSession);
  assert.equal(upgradedDetail.items.length, 1);
  assert.equal(upgradedDetail.items[0].applied_path, '升级/新标题.md');
  const upgradedDuplicate = duplicate({ original: pendingFile, current: getFileByPath('升级/新标题.md'), conversation: partial.conversation, sessionId: upgradedSession });
  assert.equal((await applyPreviewPatchFile(upgradedDuplicate.id, upgradedSession, { patchIndex: 0 })).already_applied, true);
  require('../lib/migrations/016_revision_base_path').up(getDb());
  assert.equal(getOperationSetById(f.preview.operation_set_id).revision_base_path, f.original.path);
  console.log('revision rename idempotency tests passed (identity, content, scope, cancellation, rollback, partial retry, migration)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
