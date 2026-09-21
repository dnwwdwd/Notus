const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-preview-failure-'));
Object.assign(process.env, {
  NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: root,
  NOTES_DIR: path.join(root, 'notes'), DB_PATH: path.join(root, 'notus.db'),
  ASSETS_DIR: path.join(root, 'assets'), LOG_DIR: path.join(root, 'logs'),
  SESSION_DIR: path.join(root, 'session'), NOTUS_AGENT_RUNTIME_MODE: 'legacy',
});
let calls = [];
let requests = [];
const llmPath = require.resolve('../lib/llm');
require.cache[llmPath] = { id: llmPath, filename: llmPath, loaded: true, exports: {
  completeToolChat: async (request) => {
    requests.push(request);
    const next = calls.shift();
    assert.ok(next, '失败后不得继续调用模型');
    return { content: [next], stopReason: next.type === 'text' ? 'end_turn' : 'tool_use', usage: {} };
  },
} };
const { createFile, getFileByPath } = require('../lib/files');
const { getDb, setSetting } = require('../lib/db');
const { ensureConversation } = require('../lib/conversations');
const { createSession, updateSessionStatus } = require('../lib/agentSession');
const { runAgentLoop } = require('../lib/agentLoop');
const { getTaskChangeSetDetail } = require('../lib/agentTaskChangeSets');
const { readToolResult, buildToolResultReceipt } = require('../lib/agentToolResultStore');
function tool(name, input, id) { return { type: 'tool_use', id, name, input }; }

async function run(name, planned, interruptAfterFirstApply = false) {
  calls = planned;
  requests = [];
  const conversation = ensureConversation({ kind: 'canvas', title: name });
  const session = createSession({ goal: '用户任务：修改文件并重命名。', authorizedPaths: [], authorizedOps: ['create', 'modify'], conversationId: conversation.id });
  updateSessionStatus(session.sessionId, 'running');
  const events = [];
  const controller = new AbortController();
  let result = await runAgentLoop({ sessionId: session.sessionId, approvalMode: 'auto_confirm', llmConfig: { llmContextWindowTokens: 60000 }, signal: controller.signal, onStream: e => {
    events.push(e);
    if (interruptAfterFirstApply && e.artifact_type === 'operation_set' && e.status === 'applied') controller.abort('connection_lost');
  } });
  if (interruptAfterFirstApply) {
    assert.equal(result.status, 'queued_resume');
    result = await runAgentLoop({ sessionId: session.sessionId, approvalMode: 'auto_confirm', llmConfig: { llmContextWindowTokens: 60000 }, onStream: e => events.push(e) });
  }
  return { result, events, session, conversation };
}
async function main() {
  createFile('occupied.md', '# 保留目标\n');
  const first = await run('前批已保存', [
    tool('create_note', { path: 'saved.md', content: '# 已保存\n' }, 'create'),
    tool('preview_file_operations', { operations: [{ change_type: 'move_file', old_path: 'saved.md', new_path: 'occupied.md' }] }, 'move'),
  ]);
  assert.equal(first.result.reason, 'preview_auto_apply_failed');
  assert.ok(getFileByPath('saved.md').content.includes('已保存'));
  assert.ok(getFileByPath('occupied.md').content.includes('保留目标'));
  const final = first.events.find(e => e.type === 'final');
  assert.ok(!final.text.includes('正式文件未修改'), final.text);
  assert.ok(final.text.includes('已生成') && final.text.includes('已保存'), final.text);
  assert.equal(first.events.filter(e => e.artifact_type === 'operation_set').length, 2);
  assert.equal(first.events.filter(e => e.artifact_type === 'operation_set').at(-1).status, 'apply_failed');
  const failedTool = first.events.filter(e => e.stage === 'tool_done').at(-1);
  assert.equal(failedTool.failed, true);
  assert.equal(failedTool.result_summary.preview_generated, true);
  assert.equal(failedTool.result_summary.apply_success, false);
  const row = getDb().prepare('SELECT id FROM agent_tool_result_artifacts WHERE session_id = ? AND tool_name = ?').get(first.session.sessionId, 'preview_file_operations');
  const saved = await readToolResult({ conversationId: first.conversation.id, sessionId: first.session.sessionId, resultRef: `tool-result://${row.id}`, jsonPointer: '/success' });
  assert.equal(saved.content, 'false');
  const detail = getTaskChangeSetDetail(first.session.sessionId);
  assert.equal(detail.operation_sets.length, 2);

  const second = await run('首批失败', [tool('preview_file_operations', { operations: [{ change_type: 'move_file', old_path: 'missing.md', new_path: 'other.md' }] }, 'missing')]);
  assert.equal(second.result.status, 'failed');
  assert.ok(second.events.find(e => e.type === 'final').text.includes('未完成应用'));

  createFile('partial.md', '# 部分成功\n');
  const third = await run('同批部分应用', [tool('preview_file_operations', { operations: [
    { change_type: 'move_file', old_path: 'partial.md', new_path: 'moved.md' },
    { change_type: 'move_file', old_path: 'missing.md', new_path: 'other.md' },
  ] }, 'partial')]);
  assert.equal(third.result.status, 'failed');
  assert.ok(getFileByPath('moved.md'));
  assert.ok(!third.events.find(e => e.type === 'final').text.includes('正式文件未修改'));

  setSetting('editor_title_filename_binding_enabled', 'true');
  await run('标题绑定的实际路径', [tool('create_note', { path: 'old.md', content: '# 实际标题\n' }, 'binding'), { type: 'text', text: '已创建。' }]);
  assert.ok(getFileByPath('实际标题.md'));
  const requestText = JSON.stringify(requests[1]);
  assert.ok(requestText.includes('实际标题.md'), '后续模型请求必须携带实际写入路径');
  const source = createFile('介绍.md', '# 介绍\n\n保留正文。\n');
  const revisionRun = await run('全文修订后标题绑定', [
    tool('preview_file_revision', { file_path: source.path, draft_content: source.content.replace('# 介绍', '# 正式版发布') }, 'revision'),
    tool('preview_file_operations', { operations: [{ change_type: 'move_file', old_path: source.path, new_path: '正式版发布.md' }] }, 'duplicate-rename'),
    { type: 'text', text: '正文与文件名已更新。' },
  ]);
  assert.equal(revisionRun.result.status, 'completed', '已经由标题绑定完成的同任务重命名不得再次失败');
  assert.ok(getFileByPath('正式版发布.md'), JSON.stringify(revisionRun.result));
  assert.ok(!getFileByPath('介绍.md'));
  const actualReceipts = requests[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result').map(block => JSON.parse(block.content));
  const cumulative = getTaskChangeSetDetail(revisionRun.session.sessionId);
  assert.equal(cumulative.items.length, 1);
  assert.equal(cumulative.items[0].status, 'applied');
  assert.equal(cumulative.items[0].applied_path, '正式版发布.md');
  assert.ok(actualReceipts.some(receipt => receipt.changed_files?.includes('正式版发布.md')), '全文修订应用回执必须直接携带新路径');
  assert.equal(buildToolResultReceipt({ toolName: 'preview_file_operations', result: { success: false, conflict: true } }).status, 'failed');
  const resumeFile = createFile('恢复旧标题.md', '# 恢复旧标题\n\n保留正文。\n');
  const resumed = await run('改名后中断恢复', [
    tool('preview_file_revision', { file_path: resumeFile.path, draft_content: resumeFile.content.replace('# 恢复旧标题', '# 恢复新标题') }, 'resume-revision'),
    tool('preview_file_operations', { operations: [{ change_type: 'move_file', old_path: resumeFile.path, new_path: '恢复新标题.md' }] }, 'resume-rename'),
    { type: 'text', text: '已完成剩余操作。' },
  ], true);
  assert.equal(resumed.result.status, 'completed');
  assert.equal(getTaskChangeSetDetail(resumed.session.sessionId).operation_sets.length, 2);
  assert.equal(getTaskChangeSetDetail(resumed.session.sessionId).items.length, 1);
  assert.ok(getFileByPath('恢复新标题.md'));
  const vm = require('vm');
  const hookSource = fs.readFileSync(require.resolve('../hooks/useAgentLoopController'), 'utf8');
  const hookStart = hookSource.indexOf('function buildEventStep(');
  const hookEnd = hookSource.indexOf('export function buildRestoredAgentTimeline', hookStart);
  const hookContext = { executionSegmentFields: () => ({}) };
  vm.createContext(hookContext);
  vm.runInContext(hookSource.slice(hookStart, hookEnd), hookContext);
  const batchStep = hookContext.buildEventStep(first.events.filter(e => e.artifact_type === 'operation_set').at(-1));
  assert.equal(batchStep.status, 'error');
  assert.equal(batchStep.label, '修改批次应用未完成');
  assert.ok(!batchStep.detail.includes('等待你决定'));
  console.log('agent preview apply failure tests passed (prior batch, first failure, partial batch, actual path, failed receipt)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
