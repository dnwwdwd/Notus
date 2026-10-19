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

const { getDb, initDb, setSetting } = require('../lib/db');
const { createSession, updateSessionStatus } = require('../lib/agentSession');
const { createOperationSet, getOperationSetById } = require('../lib/canvasOperationSets');
const { getFileByPath, readMarkdownFile, writeMarkdownFile, renameFile } = require('../lib/files');
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

  // 应用后文件被外部改动：默认要求二次确认，force 时允许覆盖回滚。
  writeMarkdownFile('case.md', draftContent);
  const conflictPreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: '# Title\n\nexternal conflict draft\n',
  }, session.sessionId);
  const conflictApply = await applyFileRevision(conflictPreview.operation_set_id, session.sessionId);
  assert.strictEqual(conflictApply.applied, true);
  writeMarkdownFile('case.md', '# Title\n\nuser edited after apply\n');
  const blockedRollback = await rollbackFileRevision(conflictPreview.operation_set_id, session.sessionId);
  assert.strictEqual(blockedRollback.success, false);
  assert.strictEqual(blockedRollback.error, 'ROLLBACK_CONFLICT');
  assert.strictEqual(blockedRollback.requires_force_confirmation, true);
  assert.strictEqual(readMarkdownFile('case.md'), '# Title\n\nuser edited after apply\n');
  const forcedRollback = await rollbackFileRevision(conflictPreview.operation_set_id, session.sessionId, { force: true });
  assert.strictEqual(forcedRollback.success, true);
  assert.strictEqual(forcedRollback.status, 'rolled_back');
  assert.strictEqual(readMarkdownFile('case.md'), draftContent);

  setSetting('editor_title_filename_binding_enabled', 'true');
  writeMarkdownFile('legacy-revision.md', '# 旧修订标题\n\n正文\n');
  const boundRevisionFile = getFileByPath('legacy-revision.md');
  const boundConversationId = createConversation(boundRevisionFile.id);
  const boundSession = createRunningSession(boundConversationId, ['legacy-revision.md', '新修订标题.md']);
  const boundPreview = await previewFileRevision({
    file_path: 'legacy-revision.md',
    draft_content: '# 新修订标题\n\n正文已更新\n',
  }, boundSession.sessionId);
  const boundApply = await applyFileRevision(boundPreview.operation_set_id, boundSession.sessionId);
  assert.strictEqual(boundApply.success, true);
  assert.deepStrictEqual(boundApply.changed_files, ['新修订标题.md']);
  assert.strictEqual(getFileByPath('legacy-revision.md'), null);
  assert.ok(getFileByPath('新修订标题.md'));
  assert.strictEqual(getOperationSetById(boundPreview.operation_set_id).revision_file_path, '新修订标题.md');
  const boundRollback = await rollbackFileRevision(boundPreview.operation_set_id, boundSession.sessionId);
  assert.strictEqual(boundRollback.success, true);
  assert.deepStrictEqual(boundRollback.changed_files, ['旧修订标题.md']);
  assert.ok(getFileByPath('旧修订标题.md'));
  assert.strictEqual(getFileByPath('新修订标题.md'), null);
  setSetting('editor_title_filename_binding_enabled', 'false');

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
  // 自动模式一律应用；安全分析只作为提示，不再降级为人工确认。
  const unsafeAutoApply = await applyFileRevision(unsafeOperationSet.id, session.sessionId);
  assert.strictEqual(unsafeAutoApply.success, true);
  assert.strictEqual(unsafeAutoApply.applied, true);
  assert.strictEqual(readMarkdownFile('case.md'), '');
  const unsafeRollback = await rollbackFileRevision(unsafeOperationSet.id, session.sessionId);
  assert.strictEqual(unsafeRollback.success, true);
  assert.strictEqual(readMarkdownFile('case.md'), '# Title\n\nexternal edit\n');
  // 已回滚的修订不能再次应用，仍保持原终态约束。
  const unsafeReapply = await applyFileRevision(unsafeOperationSet.id, session.sessionId);
  assert.strictEqual(unsafeReapply.success, false);
  assert.strictEqual(unsafeReapply.error, 'REVISION_NOT_PENDING');
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
  assert.strictEqual(riskyPreview.requires_confirmation, false);
  assert.ok(riskyPreview.safety.warnings.length > 0, '异常草稿仍应记录安全提示');
  const riskyAutoApply = await applyFileRevision(riskyPreview.operation_set_id, riskySession.sessionId);
  assert.strictEqual(riskyAutoApply.success, true);
  assert.strictEqual(riskyAutoApply.applied, true);
  assert.strictEqual(readMarkdownFile('case.md'), '# Long Draft Safety\n\n已完成润色。');
  const riskyRollback = await rollbackFileRevision(riskyPreview.operation_set_id, riskySession.sessionId);
  assert.strictEqual(riskyRollback.success, true);
  assert.strictEqual(readMarkdownFile('case.md'), longBaseContent);

  const truncatedPreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: `${longBaseContent.slice(0, 240)}\n[已截断]`,
  }, riskySession.sessionId);
  assert.strictEqual(truncatedPreview.requires_confirmation, false);
  assert.ok(truncatedPreview.safety.warnings.some((item) => /截断/.test(item)));
  const truncatedAutoApply = await applyFileRevision(truncatedPreview.operation_set_id, riskySession.sessionId);
  assert.strictEqual(truncatedAutoApply.success, true);
  assert.strictEqual(truncatedAutoApply.applied, true);
  const truncatedRollback = await rollbackFileRevision(truncatedPreview.operation_set_id, riskySession.sessionId);
  assert.strictEqual(truncatedRollback.success, true);
  assert.strictEqual(readMarkdownFile('case.md'), longBaseContent);

  // 自动模式：原文带 frontmatter、草稿只提交正文时，应保留原文元数据并自动应用。
  const frontmatterBase = ['---', 'id: "notus_frontmatter_case"', 'created_by: notus_agent', 'title: "带元数据的文章"', '---', '', longBaseContent].join('\n');
  writeMarkdownFile('case.md', frontmatterBase);
  const frontmatterSession = createRunningSession(conversationId, ['case.md'], '请把文章整体改写得更自然');
  const frontmatterPreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: longBaseContent.replace(/这是一段用于测试全文修订安全护栏的正文，包含足够多的内容，避免短草稿被误认为完整文章。/g, '这是改写后的正文，内容完整且保留了全部段落。'),
  }, frontmatterSession.sessionId);
  assert.ifError(frontmatterPreview.error);
  assert.strictEqual(frontmatterPreview.requires_confirmation, false);
  const frontmatterAutoApply = await applyFileRevision(frontmatterPreview.operation_set_id, frontmatterSession.sessionId);
  assert.strictEqual(frontmatterAutoApply.success, true);
  assert.strictEqual(frontmatterAutoApply.applied, true);
  assert.match(readMarkdownFile('case.md'), /^---\nid: "notus_frontmatter_case"/);
  assert.match(readMarkdownFile('case.md'), /这是改写后的正文，内容完整且保留了全部段落。/);

  // 模型自己提交 frontmatter 但漏掉 Notus 内部 id 时，必须补齐，避免编辑器把系统元数据当正文。
  writeMarkdownFile('case.md', frontmatterBase);
  const draftFrontmatterSession = createRunningSession(conversationId, ['case.md'], '请更新文章标题并润色正文');
  const draftFrontmatterPreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: ['---', 'title: "新标题"', '---', '', '# 新标题', '', '润色后的正文。'].join('\n'),
  }, draftFrontmatterSession.sessionId);
  assert.ifError(draftFrontmatterPreview.error);
  const draftFrontmatterApply = await applyFileRevision(draftFrontmatterPreview.operation_set_id, draftFrontmatterSession.sessionId);
  assert.strictEqual(draftFrontmatterApply.applied, true);
  const draftFrontmatterSaved = readMarkdownFile('case.md');
  assert.match(draftFrontmatterSaved, /^---\n/);
  assert.match(draftFrontmatterSaved, /id: "notus_frontmatter_case"/);
  assert.match(draftFrontmatterSaved, /created_by: notus_agent/);
  assert.match(draftFrontmatterSaved, /title: "新标题"/);
  assert.match(draftFrontmatterSaved, /润色后的正文。/);

  // 自动模式：用户明确要求大范围改写时，比例变化不应被误判为截断。
  writeMarkdownFile('case.md', longBaseContent);
  const rewriteSession = createRunningSession(conversationId, ['case.md'], '请大范围改写这篇文章，合并重复段落并精简表达');
  const condensedDraft = ['# Long Draft Safety', '', ...Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 段：合并后的精简正文，保留原意。`)].join('\n');
  const rewritePreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: condensedDraft,
  }, rewriteSession.sessionId);
  assert.ifError(rewritePreview.error);
  assert.strictEqual(rewritePreview.requires_confirmation, false);
  const rewriteAutoApply = await applyFileRevision(rewritePreview.operation_set_id, rewriteSession.sessionId);
  assert.strictEqual(rewriteAutoApply.success, true);
  assert.strictEqual(rewriteAutoApply.applied, true);
  assert.strictEqual(readMarkdownFile('case.md'), condensedDraft);

  writeMarkdownFile('case.md', '# Title\n\nexplicit clear target\n');
  const explicitSession = createRunningSession(conversationId, ['case.md'], '请清空当前文章正文');
  const explicitEmptyPreview = await previewFileRevision({
    file_path: 'case.md',
    draft_content: '',
  }, explicitSession.sessionId);
  assert.strictEqual(explicitEmptyPreview.status, 'pending');
  const explicitAutoApply = await applyFileRevision(explicitEmptyPreview.operation_set_id, explicitSession.sessionId);
  assert.strictEqual(explicitAutoApply.success, true);
  assert.strictEqual(explicitAutoApply.applied, true);
  assert.strictEqual(readMarkdownFile('case.md'), '');

  // M10：apply/rollback 之间文件被改名时，应回退按 file_id 定位继续执行。
  writeMarkdownFile('rename-fallback.md', '# Rename Fallback\n\noriginal\n');
  const fallbackFile = getFileByPath('rename-fallback.md');
  const fallbackConversationId = createConversation(fallbackFile.id);
  const fallbackSession = createRunningSession(fallbackConversationId, ['rename-fallback.md', '改名后.md']);
  const fallbackPreview = await previewFileRevision({
    file_path: 'rename-fallback.md',
    draft_content: '# Rename Fallback\n\nupdated\n',
  }, fallbackSession.sessionId);
  assert.strictEqual(fallbackPreview.status, 'pending');
  renameFile('rename-fallback.md', '改名后.md');
  const fallbackApply = await applyFileRevision(fallbackPreview.operation_set_id, fallbackSession.sessionId);
  assert.strictEqual(fallbackApply.success, true);
  assert.strictEqual(fallbackApply.status, 'applied');
  assert.deepStrictEqual(fallbackApply.changed_files, ['改名后.md']);
  assert.strictEqual(readMarkdownFile('改名后.md'), '# Rename Fallback\n\nupdated\n');
  const fallbackRollback = await rollbackFileRevision(fallbackPreview.operation_set_id, fallbackSession.sessionId);
  assert.strictEqual(fallbackRollback.success, true);
  assert.strictEqual(fallbackRollback.status, 'rolled_back');
  assert.strictEqual(readMarkdownFile('改名后.md'), '# Rename Fallback\n\noriginal\n');

  console.log('file revision tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
