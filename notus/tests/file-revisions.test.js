const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-file-revisions-'));
process.env.NOTUS_DATA_ROOT = tempRoot;
process.env.NOTES_DIR = path.join(tempRoot, 'notes');
process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
process.env.DB_PATH = path.join(tempRoot, 'notus.db');
process.env.LOG_DIR = path.join(tempRoot, 'logs');
process.env.SESSION_DIR = path.join(tempRoot, 'session');

const { getDb, initDb } = require('../lib/db');
const { createSession, updateSessionStatus } = require('../lib/agentSession');
const { createOperationSet, getOperationSetById } = require('../lib/canvasOperationSets');
const { getFileByPath, readMarkdownFile, writeMarkdownFile } = require('../lib/files');
const {
  applyFileRevision,
  previewFileRevision,
  rollbackFileRevision,
} = require('../lib/fileRevisions');

function createConversation(fileId) {
  const result = getDb().prepare(`
    INSERT INTO conversations (kind, title, file_id, updated_at)
    VALUES ('canvas', 'File Revision Test', ?, datetime('now'))
  `).run(fileId);
  return Number(result.lastInsertRowid);
}

function createRunningSession(conversationId, authorizedPaths = ['case.md'], goal = '测试单文件暂存修订') {
  const session = createSession({
    goal,
    authorizedPaths,
    authorizedOps: ['modify'],
    conversationId,
  });
  updateSessionStatus(session.sessionId, 'running');
  return session;
}

async function runTests() {
  fs.mkdirSync(process.env.NOTES_DIR, { recursive: true });
  fs.mkdirSync(process.env.ASSETS_DIR, { recursive: true });
  initDb();

  const baseContent = '# Title\n\nalpha\nbeta\n';
  const draftContent = '# Title\n\nalpha changed\nbeta\n';
  writeMarkdownFile('case.md', baseContent);
  const file = getFileByPath('case.md');
  const conversationId = createConversation(file.id);
  const session = createRunningSession(conversationId);

  const preview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: draftContent,
  }, session.sessionId);

  assert.ifError(preview.error);
  assert.strictEqual(preview.status, 'pending');
  assert.ok(preview.operation_set_id > 0);
  assert.ok(Array.isArray(preview.diff_hunks));
  assert.ok(preview.diff_hunks.length > 0);
  assert.strictEqual(readMarkdownFile('case.md'), baseContent);

  const apply = await applyFileRevision(preview.operation_set_id, session.sessionId);
  assert.strictEqual(apply.success, true);
  assert.strictEqual(apply.status, 'applied');
  assert.strictEqual(readMarkdownFile('case.md'), draftContent);

  const rollback = await rollbackFileRevision(preview.operation_set_id, session.sessionId);
  assert.strictEqual(rollback.success, true);
  assert.strictEqual(rollback.status, 'rolled_back');
  assert.strictEqual(readMarkdownFile('case.md'), baseContent);

  const stalePreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: '# Title\n\nagent draft\n',
  }, session.sessionId);
  assert.strictEqual(stalePreview.status, 'pending');
  writeMarkdownFile('case.md', '# Title\n\nexternal edit\n');
  const staleApply = await applyFileRevision(stalePreview.operation_set_id, session.sessionId);
  assert.strictEqual(staleApply.success, false);
  assert.strictEqual(staleApply.status, 'stale');
  assert.strictEqual(readMarkdownFile('case.md'), '# Title\n\nexternal edit\n');

  const firstPending = await previewFileRevision({
    file_path: 'case.md',
    draft_content: '# Title\n\nfirst pending\n',
  }, session.sessionId);
  const secondPending = await previewFileRevision({
    file_path: 'case.md',
    draft_content: '# Title\n\nsecond pending\n',
  }, session.sessionId);
  assert.strictEqual(secondPending.status, 'pending');
  assert.strictEqual(getOperationSetById(firstPending.operation_set_id).status, 'superseded');

  const noChange = await previewFileRevision({
    file_path: 'case.md',
    draft_content: readMarkdownFile('case.md'),
  }, session.sessionId);
  assert.strictEqual(noChange.status, 'no_change');
  assert.strictEqual(noChange.no_change, true);

  const llmModeAutoPreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: '# Title\n\nllm requested auto mode\n',
    mode: 'auto',
  }, session.sessionId);
  assert.strictEqual(llmModeAutoPreview.status, 'pending');
  assert.strictEqual(llmModeAutoPreview.applied, false);
  assert.strictEqual(readMarkdownFile('case.md'), '# Title\n\nexternal edit\n');

  const implicitPathPreview = await previewFileRevision({
    draft_content: '# Title\n\nimplicit path revision\n',
  }, session.sessionId);
  assert.ifError(implicitPathPreview.error);
  assert.strictEqual(implicitPathPreview.status, 'pending');
  assert.strictEqual(implicitPathPreview.file_path, 'case.md');
  assert.ok(implicitPathPreview.operation_set_id > 0);

  const emptyDraftPreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: '',
  }, session.sessionId);
  assert.ifError(emptyDraftPreview.error);
  assert.strictEqual(emptyDraftPreview.status, 'pending');
  assert.ok(emptyDraftPreview.operation_set_id > 0);
  assert.strictEqual(readMarkdownFile('case.md'), '# Title\n\nexternal edit\n');

  const unsafeOperationSet = createOperationSet({
    conversationId,
    agentSessionId: session.sessionId,
    fileId: file.id,
    articleHash: 'unsafe-empty-draft-test',
    mode: 'file_revision',
    operations: [],
    patches: [],
    status: 'pending',
    revisionType: 'file_revision',
    revisionFilePath: 'case.md',
    revisionBaseHash: emptyDraftPreview.base_hash,
    revisionDraftHash: emptyDraftPreview.draft_hash,
    revisionBaseContent: readMarkdownFile('case.md'),
    revisionDraftContent: '',
  });
  const unsafeAutoApply = await applyFileRevision(unsafeOperationSet.id, session.sessionId, { auto: true });
  assert.strictEqual(unsafeAutoApply.success, true);
  assert.strictEqual(unsafeAutoApply.applied, false);
  assert.strictEqual(unsafeAutoApply.requires_confirmation, true);
  assert.strictEqual(readMarkdownFile('case.md'), '# Title\n\nexternal edit\n');
  const unsafeManualApply = await applyFileRevision(unsafeOperationSet.id, session.sessionId);
  assert.strictEqual(unsafeManualApply.success, true);
  assert.strictEqual(unsafeManualApply.applied, true);
  assert.strictEqual(readMarkdownFile('case.md'), '');

  const longBaseContent = [
    '# Long Draft Safety',
    '',
    ...Array.from({ length: 36 }, (_, index) => `第 ${index + 1} 段：这是一段用于测试全文修订安全护栏的正文，包含足够多的内容，避免短草稿被误认为完整文章。`),
  ].join('\n');
  writeMarkdownFile('case.md', longBaseContent);
  const riskySession = createRunningSession(conversationId, ['case.md'], '请润色当前文章，让表达更自然');
  const riskyPreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: '# Long Draft Safety\n\n已完成润色。',
  }, riskySession.sessionId);
  assert.ifError(riskyPreview.error);
  assert.strictEqual(riskyPreview.status, 'pending');
  assert.strictEqual(riskyPreview.requires_confirmation, true);
  assert.strictEqual(riskyPreview.safety.requires_confirmation, true);
  const riskyAutoApply = await applyFileRevision(riskyPreview.operation_set_id, riskySession.sessionId, { auto: true });
  assert.strictEqual(riskyAutoApply.success, true);
  assert.strictEqual(riskyAutoApply.applied, false);
  assert.strictEqual(riskyAutoApply.requires_confirmation, true);
  assert.strictEqual(readMarkdownFile('case.md'), longBaseContent);

  const truncatedPreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: `${longBaseContent.slice(0, 240)}\n[已截断]`,
  }, riskySession.sessionId);
  assert.strictEqual(truncatedPreview.requires_confirmation, true);
  const truncatedAutoApply = await applyFileRevision(truncatedPreview.operation_set_id, riskySession.sessionId, { auto: true });
  assert.strictEqual(truncatedAutoApply.success, true);
  assert.strictEqual(truncatedAutoApply.applied, false);
  assert.strictEqual(readMarkdownFile('case.md'), longBaseContent);

  writeMarkdownFile('case.md', '# Title\n\nexplicit clear target\n');
  const explicitSession = createRunningSession(conversationId, ['case.md'], '请清空当前文章正文');
  const explicitEmptyPreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: '',
  }, explicitSession.sessionId);
  assert.strictEqual(explicitEmptyPreview.status, 'pending');
  const explicitAutoApply = await applyFileRevision(explicitEmptyPreview.operation_set_id, explicitSession.sessionId, { auto: true });
  assert.strictEqual(explicitAutoApply.success, true);
  assert.strictEqual(explicitAutoApply.applied, true);
  assert.strictEqual(readMarkdownFile('case.md'), '');

  console.log('file revision tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
