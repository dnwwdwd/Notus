const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-title-binding-'));
process.env.NOTUS_RUNTIME_TARGET = 'web';
process.env.NOTUS_DATA_ROOT = tempRoot;
process.env.NOTES_DIR = path.join(tempRoot, 'notes');
process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
process.env.DB_PATH = path.join(tempRoot, 'notus.db');
process.env.LOG_DIR = path.join(tempRoot, 'logs');
process.env.SESSION_DIR = path.join(tempRoot, 'session');

fs.mkdirSync(process.env.NOTES_DIR, { recursive: true });

const { setSetting, initDb } = require('../lib/db');
const { ensureConversation } = require('../lib/conversations');
const { createSession, updateSessionStatus } = require('../lib/agentSession');
const { getOperationSetById } = require('../lib/canvasOperationSets');
const {
  applyPreviewWithConflictCheck,
  executeCreateNote,
} = require('../lib/agentTools');
const { createFile, getAllFiles, getFileByPath } = require('../lib/files');

async function runTests() {
  initDb();

  setSetting('editor_title_filename_binding_enabled', 'false');
  createFile('懒猫搜索app/历史 Agent 文件.md', [
    '---',
    'created_by: notus_agent',
    'title: "Historical Agent Title"',
    '---',
    '',
    '## 正文',
    '',
    '这是旧 Agent 文件。',
  ].join('\n'), { titleFilenameBindingEnabled: false });
  setSetting('editor_title_filename_binding_enabled', 'true');

  getAllFiles();
  const repairedLegacy = getFileByPath('懒猫搜索app/Historical Agent Title.md');
  assert.ok(repairedLegacy, '绑定开启后应修复历史 Agent 文件的实际文件名');
  assert.strictEqual(getFileByPath('懒猫搜索app/历史 Agent 文件.md'), null);
  assert.ok(repairedLegacy.content.includes('# Historical Agent Title'), '历史 Agent 文件修复时应补回可见一级标题');

  const conversation = ensureConversation({ kind: 'canvas', title: 'Agent 标题绑定回归' });
  const session = createSession({
    goal: '用户任务：新建一篇 LazyCat Search PRD',
    authorizedPaths: [''],
    authorizedOps: ['create'],
    conversationId: conversation.id,
  });
  updateSessionStatus(session.sessionId, 'running');

  const preview = await executeCreateNote({
    path: '懒猫搜索app/懒猫搜索 PRD.md',
    title: 'LazyCat Search PRD',
    content: '## 项目背景\n\n这是 Agent 创建的正文。\n',
  }, session.sessionId);
  assert.ok(preview.operation_set_id);

  const previewSet = getOperationSetById(preview.operation_set_id);
  assert.ok(previewSet.patches[0].new.includes('# LazyCat Search PRD'), 'Agent 预览必须把标题写入可见一级标题');

  const applied = await applyPreviewWithConflictCheck(preview.operation_set_id, session.sessionId, {
    approvalMode: 'auto_confirm',
  });
  assert.strictEqual(applied.success, true);

  const expectedPath = '懒猫搜索app/LazyCat Search PRD.md';
  const created = getFileByPath(expectedPath);
  assert.ok(created, '绑定开启时 Agent 创建文件应使用可见标题作为实际文件名');
  assert.strictEqual(created.name, 'LazyCat Search PRD.md');
  assert.strictEqual(created.title, 'LazyCat Search PRD');
  assert.strictEqual(getFileByPath('懒猫搜索app/懒猫搜索 PRD.md'), null, '旧的模型生成文件名不应继续作为实际路径');
  assert.deepStrictEqual(applied.changed_files, [expectedPath]);
  assert.strictEqual(applied.operation_set.patches[0].file_path, expectedPath);

  console.log('agent title filename binding tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
