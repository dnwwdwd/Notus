const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-conversation-image-notes-'));
process.env.NOTUS_DATA_ROOT = tempRoot;
process.env.NOTES_DIR = path.join(tempRoot, 'notes');
process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
process.env.DB_PATH = path.join(tempRoot, 'notus.db');
process.env.LOG_DIR = path.join(tempRoot, 'logs');
process.env.SESSION_DIR = path.join(tempRoot, 'session');

const { getDb, initDb } = require('../lib/db');
const { appendConversationMessage } = require('../lib/conversations');
const { createSession, updateSessionStatus } = require('../lib/agentSession');
const { getFileByPath, readMarkdownFile, writeMarkdownFile } = require('../lib/files');
const {
  listConversationImages,
  makeConversationImageReference,
  resolveConversationImages,
} = require('../lib/conversationImages');
const {
  applyFileRevision,
  previewFileRevision,
  rollbackFileRevision,
} = require('../lib/fileRevisions');
const {
  applyPreviewPatchFile,
  executeCreateNote,
} = require('../lib/agentTools');
const { getOperationSetById } = require('../lib/canvasOperationSets');

function createConversation(title) {
  const result = getDb().prepare(`
    INSERT INTO conversations (kind, title, updated_at)
    VALUES ('canvas', ?, datetime('now'))
  `).run(title);
  return Number(result.lastInsertRowid);
}

async function runTests() {
  fs.mkdirSync(process.env.NOTES_DIR, { recursive: true });
  fs.mkdirSync(path.join(process.env.SESSION_DIR, 'images'), { recursive: true });
  initDb();
  writeMarkdownFile('research.md', '# 调研\n\n已有内容。\n');
  const file = getFileByPath('research.md');
  const conversationId = createConversation('图片整理');
  const storedName = 'conversation-image.png';
  fs.writeFileSync(path.join(process.env.SESSION_DIR, 'images', storedName), Buffer.from('notus-image-test'));
  const messageId = appendConversationMessage({
    conversationId,
    role: 'user',
    content: '把截图整理进调研笔记。',
    meta: {
      images: [{
        id: 'img-research',
        name: '调研截图.png',
        type: 'image/png',
        stored_name: storedName,
        size: 16,
        upload_order: 0,
      }],
    },
  });
  const imageRef = makeConversationImageReference(messageId, 'img-research');
  const listed = listConversationImages(conversationId);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].image_ref, imageRef);
  assert.strictEqual(resolveConversationImages(conversationId, [imageRef])[0].name, '调研截图.png');

  const session = createSession({
    goal: '把当前对话图片整理进 research.md',
    authorizedPaths: ['research.md'],
    authorizedOps: ['modify'],
    conversationId,
  });
  updateSessionStatus(session.sessionId, 'running');
  const base = readMarkdownFile('research.md');
  const preview = await previewFileRevision({
    file_path: 'research.md',
    draft_content: `${base}\n## 调研图片与整理\n\n![调研截图](${imageRef})\n`,
  }, session.sessionId);
  assert.ok(preview.operation_set_id);
  assert.strictEqual(preview.media_changes.length, 1);
  assert.strictEqual(preview.media_changes[0].kind, 'add');
  assert.ok(preview.media_changes[0].after.preview_src.includes('/api/agent/images/'));

  const applied = await applyFileRevision(preview.operation_set_id, session.sessionId);
  assert.strictEqual(applied.success, true);
  const materialized = readMarkdownFile('research.md');
  assert.ok(!materialized.includes('notus-conversation-image://'));
  assert.ok(materialized.includes('调研截图'));
  assert.ok(fs.readdirSync(path.join(process.env.ASSETS_DIR, 'images')).length > 0);
  assert.ok(applied.operation_set.media_changes[0].after.preview_src.includes(`/api/files/${file.id}/content-image?src=`));

  const rolledBack = await rollbackFileRevision(preview.operation_set_id, session.sessionId);
  assert.strictEqual(rolledBack.success, true);
  assert.strictEqual(readMarkdownFile('research.md'), base);

  const foreignConversationId = createConversation('其他对话');
  const foreignMessageId = appendConversationMessage({
    conversationId: foreignConversationId,
    role: 'user',
    content: '其他图片',
    meta: { images: [{ id: 'img-foreign', name: 'other.png', stored_name: storedName, type: 'image/png' }] },
  });
  assert.throws(
    () => resolveConversationImages(conversationId, [makeConversationImageReference(foreignMessageId, 'img-foreign')]),
    (error) => error.code === 'CONVERSATION_IMAGE_NOT_FOUND'
  );

  const createSessionResult = createSession({
    goal: '把对话图片整理为新笔记',
    authorizedPaths: [''],
    authorizedOps: ['create'],
    conversationId,
  });
  updateSessionStatus(createSessionResult.sessionId, 'running');
  const createPreview = await executeCreateNote({
    path: 'picture-summary.md',
    title: '图片整理',
    content: '## 调研图片与整理\n\n这里整理用户反馈。\n',
  }, createSessionResult.sessionId);
  assert.ok(createPreview.operation_set_id);
  const createOperationSet = getOperationSetById(createPreview.operation_set_id);
  assert.strictEqual(createOperationSet.media_changes.length, 1, '明确要求贴入图片时，即使 Agent 草稿遗漏引用也必须补齐图片 diff');
  assert.ok(createOperationSet.media_changes[0].after.preview_src.includes('/api/agent/images/'));
  const created = await applyPreviewPatchFile(createPreview.operation_set_id, createSessionResult.sessionId);
  assert.strictEqual(created.success, true);
  const createdFile = getFileByPath('picture-summary.md');
  assert.ok(createdFile);
  assert.ok(!readMarkdownFile('picture-summary.md').includes('notus-conversation-image://'));
  assert.ok(readMarkdownFile('picture-summary.md').includes('调研截图'));
  assert.ok(created.operation_set.media_changes[0].after.preview_src.includes(`/api/files/${createdFile.id}/content-image?src=`));

  const missingStoredName = 'missing-conversation-image.png';
  fs.writeFileSync(path.join(process.env.SESSION_DIR, 'images', missingStoredName), Buffer.from('missing-image-test'));
  const missingMessageId = appendConversationMessage({
    conversationId,
    role: 'user',
    content: '把另一张图片也加进调研笔记。',
    meta: { images: [{ id: 'img-missing', name: '缺失图片.png', type: 'image/png', stored_name: missingStoredName }] },
  });
  const missingRef = makeConversationImageReference(missingMessageId, 'img-missing');
  const missingSession = createSession({
    goal: '把缺失图片加入 research.md',
    authorizedPaths: ['research.md'],
    authorizedOps: ['modify'],
    conversationId,
  });
  updateSessionStatus(missingSession.sessionId, 'running');
  const missingPreview = await previewFileRevision({
    file_path: 'research.md',
    draft_content: `${base}\n![缺失图片](${missingRef})\n`,
  }, missingSession.sessionId);
  fs.unlinkSync(path.join(process.env.SESSION_DIR, 'images', missingStoredName));
  const missingApply = await applyFileRevision(missingPreview.operation_set_id, missingSession.sessionId);
  assert.strictEqual(missingApply.success, false);
  assert.strictEqual(missingApply.status, 'apply_failed');
  assert.strictEqual(readMarkdownFile('research.md'), base);

  console.log('conversation image note tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
