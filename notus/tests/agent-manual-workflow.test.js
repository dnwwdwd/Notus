const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-manual-workflow-'));
Object.assign(process.env, { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root, NOTES_DIR: path.join(root, 'notes'), ASSETS_DIR: path.join(root, 'assets'), DB_PATH: path.join(root, 'notus.db'), LOG_DIR: path.join(root, 'logs'), SESSION_DIR: path.join(root, 'session'), CANVAS_ENABLE_STYLE_EXTRACTION: 'false' });
const indexPath = require.resolve('../lib/indexer');
require.cache[indexPath] = { id: indexPath, filename: indexPath, loaded: true, exports: { triggerIncrementalIndex: async () => {}, removeFile: () => {} } };
let plan = [], calls = 0;
const llmPath = require.resolve('../lib/llm');
require.cache[llmPath] = { id: llmPath, filename: llmPath, loaded: true, exports: { completeToolChat: async () => {
  calls += 1;
  return { content: plan.length ? [plan.shift()] : [{ type: 'text', text: '已完成全部步骤。' }], stopReason: plan.length ? 'tool_use' : 'end_turn', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
} } };
const { createFile, getFileByPath, updateFile } = require('../lib/files');
const { createSession, getSession, updateSessionStatus, loadMessagesCheckpoint } = require('../lib/agentSession');
const { ensureConversation } = require('../lib/conversations');
const { createTask, settleTaskRun, getTaskBySession } = require('../lib/agentTaskQueue');
const { runAgentLoop } = require('../lib/agentLoop');
const tools = require('../lib/agentTools');
const { getOperationSetById, createOperationSet } = require('../lib/canvasOperationSets');
const { getTaskChangeSetDetail } = require('../lib/agentTaskChangeSets');
const { resolveManualConfirmation } = require('../lib/agentManualConfirmation');
const { createDiffHunks } = require('../lib/fileRevisionDiff');
const { getDb } = require('../lib/db');
function tool(name, input) { return { type: 'tool_use', id: `tool-${Math.random()}`, name, input }; }
function task(approvalMode = 'manual_confirm') {
  const c = ensureConversation({ kind: 'canvas', title: 'manual regression' });
  const s = createSession({ goal: '用户任务：完成目录与文章的全部操作', conversationId: c.id, authorizedPaths: ['*'], authorizedOps: ['create', 'modify'] });
  createTask({ sessionId: s.sessionId, conversationId: c.id, approvalMode, input: {} });
  return { id: s.sessionId, conversationId: c.id, approvalMode };
}
async function run(t) {
  const r = await runAgentLoop({ sessionId: t.id, approvalMode: t.approvalMode, llmConfig: { llmContextWindowTokens: 60000 }, onStream: () => {} });
  settleTaskRun(t.id, r.status, { finished: r.status === 'completed' });
  return r;
}
async function apply(t, r, action = 'apply_all', patchIndex) {
  const result = action === 'apply_file' ? await tools.applyPreviewPatchFile(r.operation_set_id, t.id, { patchIndex }) : await tools.applyPreviewWithConflictCheck(r.operation_set_id, t.id);
  return { result, completion: resolveManualConfirmation({ sessionId: t.id, operationSetId: r.operation_set_id, action, toolResult: result }) };
}
async function main() {
  let t = task();
  plan = [tool('preview_file_operations', { operations: [{ change_type: 'create_folder', path: '公众号' }] }), tool('create_note', { path: '公众号/自我介绍.md', content: '# 自我介绍\n\n我是汉堡🍔。' }), tool('preview_file_operations', { operations: [{ change_type: 'move_file', old_path: '公众号/自我介绍.md', new_path: '公众号/介绍.md' }] }), tool('preview_patch_files', { patches: [{ file_path: '公众号/介绍.md', old: '我是汉堡🍔。', new: '我是汉堡🍔，欢迎关注。' }] })];
  const originalCalls = calls;
  for (let batch = 0; batch < 4; batch += 1) {
    const r = await run(t);
    assert.equal(r.status, 'waiting_operation_confirmation');
    assert.equal(loadMessagesCheckpoint(t.id).pendingOperationSetId, r.operation_set_id);
    if (!batch) assert(!fs.existsSync(path.join(root, 'notes/公众号')));
    if (batch === 1) assert(!getFileByPath('公众号/自我介绍.md'));
    const { result, completion } = await apply(t, r);
    assert(result.success, JSON.stringify(result));
    assert(completion.resumed);
    assert.equal(getTaskBySession(t.id).status, 'queued');
    assert.equal(resolveManualConfirmation({ sessionId: t.id, operationSetId: r.operation_set_id, action: 'apply_all', toolResult: result }).resumed, false);
  }
  assert.equal((await run(t)).status, 'completed');
  assert.equal(calls - originalCalls, 5);
  assert(getFileByPath('公众号/介绍.md').content.includes('汉堡🍔，欢迎关注'));
  assert.equal(getTaskChangeSetDetail(t.id).operation_sets.length, 4);
  assert.equal(getTaskChangeSetDetail(t.id).conflict_count, 0);
  assert(getTaskChangeSetDetail(t.id).items.every(item => item.applied_exists));

  // 120 个文件与 120 个目录，分批执行；逐项后仍等待，刷新重读的 checkpoint 不丢失。
  const patches = Array.from({ length: 120 }, (_, i) => {
    createFile(`batch/${i}.md`, `# File ${i}\n\nbefore-${i}\n`, { titleFilenameBindingEnabled: false });
    return { file_path: `batch/${i}.md`, old: `before-${i}`, new: `after-${i}` };
  });
  t = task();
  plan = [tool('preview_patch_files', { patches: patches.slice(0, 60) }), tool('preview_patch_files', { patches: patches.slice(60) }), ...[0, 60].map(start => tool('preview_file_operations', { operations: Array.from({ length: 60 }, (_, i) => ({ change_type: 'create_folder', path: `folders/${start + i}` })) }))];
  for (let batch = 0; batch < 4; batch += 1) {
    const r = await run(t);
    assert.equal(r.status, 'waiting_operation_confirmation');
    const one = await apply(t, r, 'apply_file', 0);
    assert(one.result.success);
    assert(!one.completion.resumed);
    const all = await apply(t, r);
    assert(all.result.success);
    assert(all.completion.resumed);
  }
  assert.equal((await run(t)).status, 'completed');
  patches.forEach((patch, i) => { assert(getFileByPath(patch.file_path).content.includes(`after-${i}`)); assert(fs.existsSync(path.join(root, 'notes/folders', String(i)))); });
  const detail = getTaskChangeSetDetail(t.id);
  assert.equal(detail.file_count, 120);
  assert.equal(detail.directory_count, 120);
  assert.equal(detail.operation_set_view.patches.length, 240);

  // 无效项与超限均整批拒绝，不能静默漏项。
  const countSets = () => getDb().prepare('SELECT COUNT(*) AS n FROM canvas_operation_sets').get().n;
  const before = countSets();
  let bad = await tools.executePreviewPatchFiles({ patches: [patches[0], { file_path: '../escape.md', old: 'a', new: 'b' }] }, t.id);
  assert.equal(bad.error, 'INVALID_PREVIEW_ITEM'); assert.equal(bad.item_index, 1);
  bad = await tools.executePreviewFileOperations({ operations: [{ change_type: 'create_folder', path: 'valid' }, { change_type: 'unknown' }] }, t.id);
  assert.equal(bad.error, 'INVALID_PREVIEW_ITEM');
  bad = await tools.executePreviewPatchFiles({ patches }, t.id); assert.equal(bad.error, 'PREVIEW_BATCH_TOO_LARGE');
  bad = await tools.executePreviewPatchFiles({ patches: [{ file_path: 'batch/0.md', old: 'a', new: 'x'.repeat(1024 * 1024) }] }, t.id); assert.equal(bad.error, 'PREVIEW_BATCH_TOO_LARGE');
  assert.equal(countSets(), before);

  // 同文件连续修改按前项结果校验；按文件路径定位不能误选第 0 项。
  t = task();
  createFile('sequence.md', '# Sequence\n\nalpha');
  const sequential = await tools.executePreviewPatchFiles({ patches: [{ file_path: 'sequence.md', old: 'alpha', new: 'beta' }, { file_path: 'sequence.md', old: 'beta', new: 'gamma' }] }, t.id);
  assert(sequential.operation_set_id);
  assert.equal((await tools.applyPreviewPatchFile(sequential.operation_set_id, t.id, { patchIndex: 1 })).error, 'PREVIOUS_OPERATION_PENDING');
  assert((await tools.applyPreviewWithConflictCheck(sequential.operation_set_id, t.id)).success);
  assert(getFileByPath('sequence.md').content.includes('gamma'));
  const selected = await tools.executePreviewPatchFiles({ patches: [0, 1].map(i => ({ file_path: `batch/${i}.md`, old: `after-${i}`, new: `selected-${i}` })) }, t.id);
  assert((await tools.applyPreviewPatchFile(selected.operation_set_id, t.id, { filePath: 'batch/1.md' })).success);
  assert(getFileByPath('batch/0.md').content.includes('after-0'));
  assert(getFileByPath('batch/1.md').content.includes('selected-1'));

  // 部分失败持久化，修正外部冲突后重试不会重复成功项。
  t = task();
  plan = [tool('preview_patch_files', { patches: [2, 3].map(i => ({ file_path: `batch/${i}.md`, old: `after-${i}`, new: `finished-${i}` })) })];
  let r = await run(t);
  const file = getFileByPath('batch/3.md');
  updateFile(file.id, file.content.replace('after-3', 'external-change'));
  let a = await apply(t, r);
  assert(!a.result.success); assert(a.result.partially_applied); assert(!a.completion.resumed);
  assert.equal(a.result.changed_files.length, 1);
  assert.equal(getOperationSetById(r.operation_set_id).patches[1].status, 'failed');
  updateFile(file.id, file.content);
  a = await apply(t, r); assert(a.result.success); assert(a.completion.resumed); assert.equal(a.result.changed_files.length, 1);
  await run(t);

  // 废弃、回滚停止等待任务；旧 completed 与 cancelled 任务不复活。
  for (const action of ['discard_pending', 'rollback_file']) {
    t = task(); plan = [tool('create_note', { path: `${action}.md`, content: '# Pending' })]; r = await run(t);
    const result = action === 'discard_pending' ? await tools.discardPendingPreviewPatches(r.operation_set_id, t.id) : await tools.rollbackPreviewPatchFile(r.operation_set_id, t.id, { patchIndex: 0 });
    assert(result.success);
    assert(!resolveManualConfirmation({ sessionId: t.id, operationSetId: r.operation_set_id, action, toolResult: result }).resumed);
    assert.equal(getSession(t.id).status, 'cancelled'); assert.equal(getTaskBySession(t.id).status, 'cancelled');
    assert(!getFileByPath(`${action}.md`));
  }
  for (const status of ['completed', 'cancelled']) {
    t = task(); plan = [tool('create_note', { path: `legacy-${status}.md`, content: '# Legacy' })]; r = await run(t);
    updateSessionStatus(t.id, status); settleTaskRun(t.id, status, { finished: true });
    a = await apply(t, r); assert(!a.completion.resumed); assert.equal(getSession(t.id).status, status);
  }

  // 磁盘目标存在但尚未入索引时也不能覆盖；异常须保存失败状态。
  t = task();
  const preview = await tools.executeCreateNote({ path: 'collision.md', content: '# New' }, t.id);
  fs.writeFileSync(path.join(root, 'notes/collision.md'), 'external');
  const collision = await tools.applyPreviewWithConflictCheck(preview.operation_set_id, t.id);
  assert(!collision.success); assert.equal(fs.readFileSync(path.join(root, 'notes/collision.md'), 'utf8'), 'external');

  // 同大小、恢复原时间戳的外部修改仍被同步识别。
  const externalPath = path.join(root, 'notes/batch/4.md');
  const oldStat = fs.statSync(externalPath);
  const original = getFileByPath('batch/4.md');
  fs.writeFileSync(externalPath, original.content.replace('after-4', 'other-4'));
  fs.utimesSync(externalPath, oldStat.atime, oldStat.mtime);
  assert(getFileByPath('batch/4.md').content.includes('other-4'));
  assert.notEqual(getFileByPath('batch/4.md').hash, original.hash);

  // 全文应用遇到暂时 I/O 错误，修复后可重试；冲突仍不能跳过。
  const revisionFile = createFile('retry-revision.md', '# Retry\n\n原文');
  const revision = await tools.previewFileRevision({ file_path: revisionFile.path, draft_content: revisionFile.content.replace('原文', '修订后正文') }, t.id);
  const renameSync = fs.renameSync;
  fs.renameSync = (source, target) => { if (String(target).endsWith('retry-revision.md')) throw Object.assign(new Error('test I/O failure'), { code: 'EACCES' }); return renameSync(source, target); };
  try { assert.equal((await tools.applyFileRevision(revision.operation_set_id, t.id)).success, false); }
  finally { fs.renameSync = renameSync; }
  assert.equal(getOperationSetById(revision.operation_set_id).status, 'apply_failed');
  assert((await tools.applyFileRevision(revision.operation_set_id, t.id)).success);
  assert(getFileByPath('retry-revision.md').content.includes('修订后正文'));

  // 原生文件写入失败不得抛出导致整批状态丢失。
  const failSet = createOperationSet({ conversationId: t.conversationId, agentSessionId: t.id, mode: 'create_file', patches: [{ file_path: 'fail-parent/child.md', old: '', new: '# Fail', change_type: 'create' }] });
  fs.writeFileSync(path.join(root, 'notes/fail-parent'), 'blocking file');
  const failure = await tools.applyPreviewWithConflictCheck(failSet.id, t.id);
  assert(!failure.success); assert.equal(getOperationSetById(failSet.id).patches[0].status, 'failed');

  // 自动模式连续两步照常完成；手动直接嵌套路径创建父目录。
  t = task('auto_confirm'); plan = [tool('preview_file_operations', { operations: [{ change_type: 'create_folder', path: 'auto' }] }), tool('create_note', { path: 'auto/article.md', content: '# Auto' })];
  assert.equal((await run(t)).status, 'completed'); assert(getFileByPath('auto/article.md'));
  t = task(); plan = [tool('create_note', { path: 'nested/deep/article.md', content: '# Nested' })]; r = await run(t);
  assert(!fs.existsSync(path.join(root, 'notes/nested'))); assert((await apply(t, r)).result.success); assert(getFileByPath('nested/deep/article.md')); await run(t);

  // 超过 JS 参数展开上限的全文 Diff，包含大量相同后缀。
  const long = Array.from({ length: 150000 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(createDiffHunks('', long)[0].newLines, 150000);
  const suffixDiff = createDiffHunks(`old\n${long}`, `new\n${long}`);
  assert(suffixDiff[0].lines.some(line => line.type === 'insert' && line.content === 'new'));
  console.log('manual workflow tests passed: dependent batches, 120 files + 120 folders, partial failures, rejection, recovery, limits, 150000-line diff, auto regression');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
