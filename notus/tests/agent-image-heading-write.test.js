const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-image-heading-write-'));
Object.assign(process.env, {
  NOTUS_RUNTIME_TARGET: 'web',
  NOTUS_DATA_ROOT: root,
  NOTES_DIR: path.join(root, 'notes'),
  DB_PATH: path.join(root, 'db.sqlite'),
  ASSETS_DIR: path.join(root, 'assets'),
  LOG_DIR: path.join(root, 'logs'),
  SESSION_DIR: path.join(root, 'session'),
});

async function runTests() {
  const { ensureConversation } = require('../lib/conversations');
  const { createSession, updateSessionStatus } = require('../lib/agentSession');
  const { getFileByPath } = require('../lib/files');
  const { getOperationSetById } = require('../lib/canvasOperationSets');
  const {
    executeCreateNote,
    executePreviewPatchFiles,
    applyPreviewPatchFile,
    previewFileRevision,
    applyFileRevision,
  } = require('../lib/agentTools');

  const conversation = ensureConversation({ kind: 'canvas', title: '图片与标题写入回归' });
  const { sessionId } = createSession({
    goal: '创建并修改有图片和标题的笔记',
    conversationId: conversation.id,
    authorizedPaths: ['*'],
    authorizedOps: ['create', 'modify'],
  });
  updateSessionStatus(sessionId, 'running');
  const filePath = '图片标题.md';

  const created = await executeCreateNote({
    path: filePath,
    content: '# 笔记\n\n![图](https://example.com/a.png)## 二级',
  }, sessionId);
  assert.ifError(created.error);
  assert(getOperationSetById(created.operation_set_id).patches[0].new.includes('![图](https://example.com/a.png)\n\n## 二级'));
  assert((await applyPreviewPatchFile(created.operation_set_id, sessionId)).success);
  assert(getFileByPath(filePath).content.includes('![图](https://example.com/a.png)\n\n## 二级'));

  const patched = await executePreviewPatchFiles({ patches: [{
    file_path: filePath,
    old: '## 二级',
    new: '![图二](https://example.com/b.png)### 三级',
  }] }, sessionId);
  assert.ifError(patched.error);
  assert(getOperationSetById(patched.operation_set_id).patches[0].new.includes('![图二](https://example.com/b.png)\n\n### 三级'));
  assert((await applyPreviewPatchFile(patched.operation_set_id, sessionId)).success);
  assert(getFileByPath(filePath).content.includes('![图二](https://example.com/b.png)\n\n### 三级'));

  const draft = `${getFileByPath(filePath).content}\n![图三](https://example.com/c.png)#### 四级`;
  const revised = await previewFileRevision({ file_path: filePath, draft_content: draft }, sessionId);
  assert.ifError(revised.error);
  const revisionRow = require('../lib/db').getDb()
    .prepare('SELECT revision_draft_content FROM canvas_operation_sets WHERE id = ?')
    .get(revised.operation_set_id);
  assert(revisionRow.revision_draft_content.includes('![图三](https://example.com/c.png)\n\n#### 四级'));
  assert((await applyFileRevision(revised.operation_set_id, sessionId)).success);
  assert(getFileByPath(filePath).content.includes('![图三](https://example.com/c.png)\n\n#### 四级'));

  console.log('agent image heading write tests passed');
}

runTests().catch((error) => { console.error(error); process.exitCode = 1; });
