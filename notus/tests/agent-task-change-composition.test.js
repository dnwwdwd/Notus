const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-change-composition-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempRoot;
  process.env.NOTES_DIR = path.join(tempRoot, 'notes');
  process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
  process.env.DB_PATH = path.join(tempRoot, 'notus.db');
  process.env.LOG_DIR = path.join(tempRoot, 'logs');
  process.env.SESSION_DIR = path.join(tempRoot, 'session');

  const { setSetting } = require('../lib/db');
  const { createFile, getFileByPath } = require('../lib/files');
  const { ensureConversation } = require('../lib/conversations');
  const { createSession } = require('../lib/agentSession');
  const { createOperationSet, getOperationSetById } = require('../lib/canvasOperationSets');
  const { applyPreviewPatchFile, discardPreviewPatchFile } = require('../lib/agentTools');
  const { getTaskChangeSetDetail, registerOperationSet, resolveOperationSet } = require('../lib/agentTaskChangeSets');

  const file = createFile('mixed.md', '# Mixed\n\nalpha\n');
  const moving = createFile('old.md', '# Move\n\ncontent\n');
  const conversation = ensureConversation({ kind: 'canvas', title: '累计修改组合测试', fileId: file.id });
  const session = createSession({
    goal: '分别修改文件并移动文件。',
    authorizedPaths: ['mixed.md', 'old.md', 'new.md'],
    authorizedOps: ['modify'],
    conversationId: conversation.id,
  });

  const mixedSet = createOperationSet({
    conversationId: conversation.id,
    agentSessionId: session.sessionId,
    mode: 'multiple_files',
    patches: [
      { file_path: 'mixed.md', old: 'alpha', new: 'beta', change_type: 'modify' },
      { file_path: 'mixed.md', old: 'beta', new: 'gamma', change_type: 'modify' },
    ],
  });
  registerOperationSet({ operationSetId: mixedSet.id, sessionId: session.sessionId, conversationId: conversation.id, approvalMode: 'manual_confirm' });
  assert.strictEqual((await applyPreviewPatchFile(mixedSet.id, session.sessionId, { patchIndex: 0 })).success, true);
  assert.strictEqual((await discardPreviewPatchFile(mixedSet.id, session.sessionId, { patchIndex: 1 })).success, true);
  assert.strictEqual(getOperationSetById(mixedSet.id).status, 'partial');
  resolveOperationSet({ operationSetId: mixedSet.id, sessionId: session.sessionId, resolution: 'applied' });
  assert.ok(getFileByPath('mixed.md').content.includes('beta'));
  assert.ok(!getFileByPath('mixed.md').content.includes('gamma'));
  let detail = getTaskChangeSetDetail(session.sessionId);
  const mixedItem = detail.items.find((item) => item.resource_key === 'mixed.md');
  assert.ok(mixedItem);
  assert.ok(mixedItem.applied_content.includes('beta'));
  assert.ok(!mixedItem.applied_content.includes('gamma'));
  assert.strictEqual(detail.applied_count, 1, '累计摘要必须统计已应用的文件修订');
  assert.strictEqual(detail.discarded_count, 1, '累计摘要必须统计已废弃的文件修订');

  const conflictSet = createOperationSet({
    conversationId: conversation.id,
    agentSessionId: session.sessionId,
    mode: 'single_file',
    patches: [{ file_path: 'mixed.md', old: 'beta', new: 'delta', change_type: 'modify' }],
  });
  registerOperationSet({ operationSetId: conflictSet.id, sessionId: session.sessionId, conversationId: conversation.id, approvalMode: 'manual_confirm' });
  assert.strictEqual((await applyPreviewPatchFile(conflictSet.id, session.sessionId, { patchIndex: 0 })).success, true);
  fs.writeFileSync(path.join(process.env.NOTES_DIR, 'mixed.md'), '# Mixed\n\nexternal edit\n', 'utf8');
  resolveOperationSet({ operationSetId: conflictSet.id, sessionId: session.sessionId, resolution: 'applied' });
  detail = getTaskChangeSetDetail(session.sessionId);
  const conflictItem = detail.items.find((item) => item.resource_key === 'mixed.md');
  assert.strictEqual(conflictItem.status, 'conflict');
  assert.ok(conflictItem.applied_content.includes('beta'));
  assert.ok(conflictItem.pending_content.includes('delta'));
  assert.ok(!conflictItem.pending_content.includes('external edit'));

  const moveSet = createOperationSet({
    conversationId: conversation.id,
    agentSessionId: session.sessionId,
    mode: 'single_file_operation',
    patches: [{ change_type: 'move_file', old_path: moving.path, new_path: 'new.md' }],
  });
  registerOperationSet({ operationSetId: moveSet.id, sessionId: session.sessionId, conversationId: conversation.id, approvalMode: 'manual_confirm' });
  assert.strictEqual((await applyPreviewPatchFile(moveSet.id, session.sessionId, { patchIndex: 0 })).success, true);
  resolveOperationSet({ operationSetId: moveSet.id, sessionId: session.sessionId, resolution: 'applied' });
  detail = getTaskChangeSetDetail(session.sessionId);
  const moveItem = detail.items.find((item) => item.resource_key === 'old.md');
  assert.ok(moveItem);
  assert.strictEqual(moveItem.resource_kind, 'file');
  assert.strictEqual(moveItem.applied_path, 'new.md');
  assert.ok(moveItem.applied_content.includes('content'));
  assert.ok(detail.operation_set_view, '累计详情必须返回可直接渲染的 Diff 视图');

  setSetting('editor_title_filename_binding_enabled', 'true');
  const boundFile = createFile('legacy-name.md', '# 旧标题\n\n正文\n', { titleFilenameBindingEnabled: false });
  const boundSet = createOperationSet({
    conversationId: conversation.id,
    agentSessionId: session.sessionId,
    mode: 'single_file',
    patches: [{ file_path: boundFile.path, old: '# 旧标题', new: '# 新标题', change_type: 'modify' }],
  });
  registerOperationSet({ operationSetId: boundSet.id, sessionId: session.sessionId, conversationId: conversation.id, approvalMode: 'manual_confirm' });
  const boundApply = await applyPreviewPatchFile(boundSet.id, session.sessionId, { patchIndex: 0 });
  assert.strictEqual(boundApply.success, true);
  assert.deepStrictEqual(boundApply.changed_files, ['新标题.md']);
  assert.strictEqual(getFileByPath('legacy-name.md'), null, 'Agent 修改既有文件时也必须执行标题—文件名绑定');
  assert.ok(getFileByPath('新标题.md'));
  assert.strictEqual(getOperationSetById(boundSet.id).patches[0].file_path, '新标题.md', 'Diff 必须保留重命名后的真实路径');
  resolveOperationSet({ operationSetId: boundSet.id, sessionId: session.sessionId, resolution: 'applied' });
  detail = getTaskChangeSetDetail(session.sessionId);
  const boundItem = detail.items.find((item) => item.resource_key === 'legacy-name.md');
  assert.ok(boundItem);
  assert.strictEqual(boundItem.applied_path, '新标题.md', '累计 Diff 必须使用 Agent 应用后的真实文件路径');

  const boundRollback = await require('../lib/agentTools').rollbackPreviewPatchFile(boundSet.id, session.sessionId, { patchIndex: 0 });
  assert.strictEqual(boundRollback.success, true);
  assert.deepStrictEqual(boundRollback.changed_files, ['旧标题.md']);
  assert.ok(getFileByPath('旧标题.md'));
  assert.strictEqual(getFileByPath('新标题.md'), null);

  console.log('agent task change composition tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
