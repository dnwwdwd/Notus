const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-failed-continuation-'));
process.env.NOTUS_RUNTIME_TARGET = 'web';
process.env.NOTUS_DATA_ROOT = root;
process.env.DB_PATH = path.join(root, 'notus.db');
process.env.NOTES_DIR = path.join(root, 'notes');
process.env.ASSETS_DIR = path.join(root, 'assets');
process.env.SESSION_DIR = path.join(root, 'session');
process.env.NOTUS_AGENT_RUNTIME_MODE = 'enforced';
let calls = 0;
let scripted = [];
const llmPath = require.resolve('../lib/llm');
require.cache[llmPath] = { id: llmPath, filename: llmPath, loaded: true, exports: {
  completeToolChat: async () => { calls++; if (scripted.length) return scripted.shift(); return { content: [{ type: 'text', text: '数量已整理，即将写入。' }], stopReason: 'end_turn' }; },
} };
async function main() {
  const { ensureConversation } = require('../lib/conversations');
  const { createSession, getSession, updateSessionStatus } = require('../lib/agentSession');
  const { createTask } = require('../lib/agentTaskQueue');
  const { composeTurnFrame } = require('../lib/agentSemanticRuntime');
  const { runAgentLoop } = require('../lib/agentLoop');
  const conversation = ensureConversation({ kind: 'canvas', title: '失败任务承接回归' });
  function make(goal, cid = conversation.id) {
    const { sessionId } = createSession({ goal, conversationId: cid, authorizedPaths: [], authorizedOps: ['create', 'modify'] });
    return { session: getSession(sessionId), task: createTask({ sessionId, conversationId: cid, input: { user_query: goal } }) };
  }
  const original = make('创建《故障清单》，再读回文档，为各项补充数量并保存。');
  await composeTurnFrame({ ...original, userQuery: original.session.goal, allowSemanticPlanner: false });
  updateSessionStatus(original.session.id, 'failed');
  const next = make('继续完成刚才的任务。');
  const { frame } = await composeTurnFrame({ ...next, userQuery: next.session.goal, allowSemanticPlanner: false });
  assert.strictEqual(frame.intent.completion_criteria.requires_write, true, '继续失败文件任务必须保留写入完成条件');
  assert.ok(frame.intent.allowed_actions.includes('write'), '不能投影为只读工具');
  for (const mode of ['enforced', 'legacy']) {
    process.env.NOTUS_AGENT_RUNTIME_MODE = mode;
    calls = 0;
    updateSessionStatus(next.session.id, 'running');
    const result = await runAgentLoop({ sessionId: next.session.id, turnFrame: mode === 'enforced' ? frame : null, llmConfig: { llmContextWindowTokens: 60000 }, signal: new AbortController().signal });
    assert.strictEqual(result.status, 'failed', `${mode}不能将口头保存当完成`);
    assert.strictEqual(result.reason, 'incomplete');
    assert.strictEqual(calls, 2, '纠正一次后仍未写入必须停止');
  }
  const { resolveFailedFileContinuation } = require('../lib/agentTaskContinuation');
  for (const status of ['completed', 'cancelled', 'waiting_interaction', 'waiting_model_recovery']) {
    updateSessionStatus(original.session.id, status);
    assert.strictEqual(resolveFailedFileContinuation(next.session), null, status);
  }
  updateSessionStatus(original.session.id, 'failed');
  for (const goal of ['不要继续刚才的任务。', '继续解释景深。', '继续，但不要保存。']) {
    assert.strictEqual(resolveFailedFileContinuation({ ...next.session, goal }), null, goal);
  }
  const other = ensureConversation({ kind: 'canvas', title: '隔离对话' });
  assert.strictEqual(resolveFailedFileContinuation({ ...next.session, conversation_id: other.id }), null);
  const { createFile, getFileByPath } = require('../lib/files');
  for (const mode of ['legacy', 'enforced']) {
    process.env.NOTUS_AGENT_RUNTIME_MODE = mode;
    const cid = ensureConversation({ kind: 'canvas', title: `实际写入-${mode}` }).id;
    const filePath = `继续-${mode}.md`;
    createFile(filePath, '# 清单\n\n- 帐篷\n');
    const before = make(`创建${filePath}，再读回并补充数量后保存。`, cid);
    await composeTurnFrame({ ...before, userQuery: before.session.goal, allowSemanticPlanner: false });
    updateSessionStatus(before.session.id, 'failed');
    const after = make('继续完成刚才的任务。', cid);
    const composed = await composeTurnFrame({ ...after, userQuery: after.session.goal, allowSemanticPlanner: false });
    const tool = (name, input, id) => ({ content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use' });
    scripted = [
      tool('read_file', { path: filePath }, `read-${mode}`),
      tool('preview_patch_files', { patches: [{ file_path: filePath, old: '- 帐篷', new: '- 帐篷 2 顶' }] }, `patch-${mode}`),
      { content: [{ type: 'text', text: '数量已保存。' }], stopReason: 'end_turn' },
    ];
    const result = await runAgentLoop({ sessionId: after.session.id, turnFrame: mode === 'enforced' ? composed.frame : null, llmConfig: { llmContextWindowTokens: 60000 }, signal: new AbortController().signal });
    assert.strictEqual(result.status, 'completed', mode);
    assert.ok(getFileByPath(filePath).content.includes('帐篷 2 顶'));
    assert.strictEqual(scripted.length, 0);
    const { getDb } = require('../lib/db');
    const { evaluateCompletion } = require('../lib/agentCompletionEvaluator');
    getDb().prepare("UPDATE canvas_operation_sets SET status = 'pending' WHERE agent_session_id = ?").run(after.session.id);
    const check = evaluateCompletion({ sessionId: after.session.id, frame: { intent: { completion_criteria: { requires_write: true, requires_applied_write: true } } }, finalText: '已完成' });
    assert.strictEqual(check.complete, false, '自动保存不能把仅有预览当作已应用');
    getDb().prepare("UPDATE canvas_operation_sets SET status = 'applied' WHERE agent_session_id = ?").run(after.session.id);
  }
  console.log('failed task continuation tests passed');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
