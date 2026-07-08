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
const { executePreviewFileOperations } = require('../lib/agentTools');

async function runTests() {
  fs.mkdirSync(process.env.NOTES_DIR, { recursive: true });
  fs.mkdirSync(process.env.ASSETS_DIR, { recursive: true });
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

  console.log('agent write policy tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
