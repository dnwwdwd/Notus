const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-write-policy-'));
process.env.NOTUS_RUNTIME_TARGET = 'web';
process.env.NOTUS_DATA_ROOT = tempRoot;
process.env.NOTES_DIR = path.join(tempRoot, 'notes');
process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
process.env.DB_PATH = path.join(tempRoot, 'notus.db');
process.env.LOG_DIR = path.join(tempRoot, 'logs');
process.env.SESSION_DIR = path.join(tempRoot, 'session');

const { getDb, initDb } = require('../lib/db');
const { createSession, updateSessionStatus, validateWrite } = require('../lib/agentSession');
const { executeAnalyzeFolder, executePreviewFileOperations } = require('../lib/agentTools');

async function runTests() {
  fs.mkdirSync(process.env.NOTES_DIR, { recursive: true });
  fs.mkdirSync(process.env.ASSETS_DIR, { recursive: true });
  fs.mkdirSync(path.join(process.env.NOTES_DIR, 'typora_files', '工作'), { recursive: true });
  fs.mkdirSync(path.join(process.env.NOTES_DIR, 'typora_files', 'AI工作流'), { recursive: true });
  fs.mkdirSync(path.join(process.env.NOTES_DIR, 'typora_files', '专利'), { recursive: true });
  initDb();

  const conversation = getDb().prepare(`
    INSERT INTO conversations (kind, title, updated_at)
    VALUES ('agent', 'Agent Write Policy Test', datetime('now'))
  `).run();

  const session = createSession({
    goal: '将根目录下的“专利”目录重命名为“专利1”',
    authorizedPaths: ['typora_files'],
    authorizedOps: ['modify', 'create'],
    conversationId: Number(conversation.lastInsertRowid),
  });
  updateSessionStatus(session.sessionId, 'running');

  const crossScopeModify = validateWrite(session.token, '专利', 'modify');
  assert.strictEqual(crossScopeModify.valid, true);

  const renamePreview = await executePreviewFileOperations({
    operations: [
      { change_type: 'rename_folder', old_path: '专利', name: '专利1' },
    ],
  }, session.sessionId);
  assert.ifError(renamePreview.error);
  assert.ok(renamePreview.operation_set_id > 0);
  assert.strictEqual(renamePreview.operations[0].old_path, '专利');
  assert.strictEqual(renamePreview.operations[0].new_path, '专利1');

  const movePreview = await executePreviewFileOperations({
    operations: [
      { change_type: 'move_file', old_path: '专利/a.md', new_path: '归档/a.md' },
      { change_type: 'move_folder', old_path: '专利', dest: '归档' },
    ],
  }, session.sessionId);
  assert.ifError(movePreview.error);
  assert.strictEqual(movePreview.patch_count, 2);

  const deleteCheck = validateWrite(session.token, '专利/a.md', 'delete');
  assert.strictEqual(deleteCheck.valid, false);
  assert.strictEqual(deleteCheck.reason, 'DELETE_NEVER_ALLOWED');

  const deletePreview = await executePreviewFileOperations({
    operations: [
      { change_type: 'delete_folder', old_path: '专利' },
    ],
  }, session.sessionId);
  assert.strictEqual(deletePreview.error, 'DELETE_NOT_SUPPORTED');

  const rootFolders = executeAnalyzeFolder({ folder_path: 'typora_files' }, session.sessionId);
  assert.ifError(rootFolders.error);
  assert.ok(rootFolders.folders.includes('typora_files/工作'), 'analyze_folder 应返回空目录');
  assert.ok(rootFolders.folders.includes('typora_files/AI工作流'), 'analyze_folder 应返回相近名称目录，供模型精确区分');
  assert.ok(rootFolders.folders.includes('typora_files/专利'), 'analyze_folder 应返回源目录');
  assert.strictEqual(rootFolders.files.length, 0, '空目录场景不应依赖 Markdown 文件列表判断目录是否存在');

  console.log('agent write policy tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
