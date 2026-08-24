const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-queue-'));
process.env.NOTUS_RUNTIME_TARGET = 'web';
process.env.NOTUS_DATA_ROOT = tempDir;

['../lib/db', '../lib/config', '../lib/agentTaskQueue', '../lib/agentSession', '../lib/conversations'].forEach((modulePath) => {
  delete require.cache[require.resolve(modulePath)];
});

const { appendConversationMessage, ensureConversation, rewriteConversationFromMessage } = require('../lib/conversations');
const { getDb } = require('../lib/db');
const { createSession, updateSessionStatus } = require('../lib/agentSession');
const { createTask, claimRunnableTasks, getQueuePosition, updateTask, wakeTask, recoverOrphanedTasks, supersedePendingUserActionTasks } = require('../lib/agentTaskQueue');

const conversation = ensureConversation({ kind: 'agent', title: '队列测试' });
const first = createSession({ goal: '第一个任务', authorizedPaths: [''], conversationId: conversation.id });
const second = createSession({ goal: '第二个任务', authorizedPaths: [''], conversationId: conversation.id });
createTask({ sessionId: first.sessionId, conversationId: conversation.id, input: { goal: '第一个任务' } });
createTask({ sessionId: second.sessionId, conversationId: conversation.id, input: { goal: '第二个任务' }, llmConfigId: 'old-model-config' });

assert.equal(getQueuePosition(first.sessionId), 1);
assert.equal(getQueuePosition(second.sessionId), 2);
assert.deepEqual(claimRunnableTasks().map((task) => task.session_id), [first.sessionId], '同会话只能领取队首任务');
updateTask(first.sessionId, { status: 'completed', finished: true });
assert.deepEqual(claimRunnableTasks().map((task) => task.session_id), [second.sessionId], '前序任务终态后应领取下一任务');
updateSessionStatus(second.sessionId, 'waiting_retry');
updateTask(second.sessionId, { status: 'waiting_retry' });
const resumedTask = wakeTask(second.sessionId, { llmConfigId: 'replacement-model-config' });
assert.equal(resumedTask.status, 'queued', '显式继续应把等待任务重新排队');
assert.equal(resumedTask.llm_config_id, 'replacement-model-config', '继续任务切换模型时必须覆盖队列任务的旧模型配置');
updateTask(second.sessionId, { status: 'running' });
assert.equal(recoverOrphanedTasks(), 1, '进程重启应恢复 orphaned running 任务');
updateTask(second.sessionId, { status: 'completed', finished: true });

const staleSession = createSession({ goal: '过期取消任务', authorizedPaths: [''], conversationId: conversation.id });
createTask({ sessionId: staleSession.sessionId, conversationId: conversation.id, input: { goal: '过期取消任务' } });
updateSessionStatus(staleSession.sessionId, 'cancelled');
recoverOrphanedTasks();
assert.equal(getDb().prepare('SELECT status FROM agent_task_queue WHERE session_id = ?').get(staleSession.sessionId).status, 'cancelled', '恢复 Worker 必须清理 session 已终态但队列仍等待的旧任务');

const rewriteConversation = ensureConversation({ kind: 'agent', title: '改写队列测试' });
const anchor = appendConversationMessage({ conversationId: rewriteConversation.id, role: 'user', content: '原始 prompt' });
const failedSession = createSession({ goal: '原始 prompt', authorizedPaths: [''], conversationId: rewriteConversation.id });
createTask({ sessionId: failedSession.sessionId, conversationId: rewriteConversation.id, input: { goal: '原始 prompt' } });
updateSessionStatus(failedSession.sessionId, 'waiting_retry');
updateTask(failedSession.sessionId, { status: 'waiting_retry' });
const rewriteResult = rewriteConversationFromMessage({
  conversationId: rewriteConversation.id,
  messageId: anchor,
  content: '修改后的 prompt',
});
assert.ok(rewriteResult.cancelled_session_ids.includes(failedSession.sessionId), '改写必须返回被取消的旧 session');
assert.equal(getDb().prepare('SELECT status FROM agent_task_queue WHERE session_id = ?').get(failedSession.sessionId).status, 'cancelled', '改写必须同步结束旧队列任务，不能继续阻塞同会话 FIFO');
updateTask(failedSession.sessionId, { status: 'waiting_retry' });
assert.equal(getDb().prepare('SELECT status FROM agent_task_queue WHERE session_id = ?').get(failedSession.sessionId).status, 'cancelled', 'Worker 收尾写回时不能复活已取消的旧队列任务');
const nextSession = createSession({ goal: '修改后的 prompt', authorizedPaths: [''], conversationId: rewriteConversation.id });
createTask({ sessionId: nextSession.sessionId, conversationId: rewriteConversation.id, input: { goal: '修改后的 prompt' } });
const claimedAfterRewrite = claimRunnableTasks().map((task) => task.session_id);
assert.ok(claimedAfterRewrite.includes(nextSession.sessionId), '旧失败任务取消后，改写生成的新任务必须可以被 Worker 领取');
assert.ok(!claimedAfterRewrite.includes(failedSession.sessionId), '已取消的旧失败任务不能再次被 Worker 领取');

const continuedConversation = ensureConversation({ kind: 'agent', title: '继续对话队列测试' });
const waitingSession = createSession({ goal: '失败后等待继续', authorizedPaths: [''], conversationId: continuedConversation.id });
createTask({ sessionId: waitingSession.sessionId, conversationId: continuedConversation.id, input: { goal: '失败后等待继续' } });
updateSessionStatus(waitingSession.sessionId, 'waiting_retry');
updateTask(waitingSession.sessionId, { status: 'waiting_retry' });
const queuedSession = createSession({ goal: '旧的排队任务', authorizedPaths: [''], conversationId: continuedConversation.id });
createTask({ sessionId: queuedSession.sessionId, conversationId: continuedConversation.id, input: { goal: '旧的排队任务' } });
updateSessionStatus(queuedSession.sessionId, 'queued');
assert.deepEqual(supersedePendingUserActionTasks(continuedConversation.id), [waitingSession.sessionId, queuedSession.sessionId], '发送新 prompt 必须结束同一对话内等待和排队的旧任务');
assert.equal(getDb().prepare('SELECT status FROM agent_sessions WHERE id = ?').get(waitingSession.sessionId).status, 'cancelled', '被新 prompt 替代的旧 session 必须终态');
assert.equal(getDb().prepare('SELECT status FROM agent_task_queue WHERE session_id = ?').get(waitingSession.sessionId).status, 'cancelled', '被新 prompt 替代的旧队列任务必须终态');
assert.equal(getDb().prepare('SELECT status FROM agent_sessions WHERE id = ?').get(queuedSession.sessionId).status, 'cancelled', '新 prompt 必须同时结束重复排队的旧 session');
assert.equal(getDb().prepare('SELECT status FROM agent_task_queue WHERE session_id = ?').get(queuedSession.sessionId).status, 'cancelled', '新 prompt 必须同时结束重复排队的旧队列任务');
const continuedSession = createSession({ goal: '继续对话的新 prompt', authorizedPaths: [''], conversationId: continuedConversation.id });
createTask({ sessionId: continuedSession.sessionId, conversationId: continuedConversation.id, input: { goal: '继续对话的新 prompt' } });
assert.deepEqual(claimRunnableTasks().map((task) => task.session_id), [continuedSession.sessionId], '结束旧等待任务后，新 prompt 必须可被 Worker 领取');
updateTask(continuedSession.sessionId, { status: 'completed', finished: true });

const questionSession = createSession({ goal: '等待提问回答', authorizedPaths: [''], conversationId: continuedConversation.id });
createTask({ sessionId: questionSession.sessionId, conversationId: continuedConversation.id, input: { goal: '等待提问回答' } });
updateSessionStatus(questionSession.sessionId, 'waiting_interaction');
updateTask(questionSession.sessionId, { status: 'waiting_interaction' });
const pendingInteraction = getDb().prepare(`
  INSERT INTO conversation_interactions (conversation_id, kind, source, reason_code, article_hash, payload_json)
  VALUES (?, 'clarify_card', 'agent_loop', 'question_card_requested', '', '{}')
`).run(continuedConversation.id);
assert.deepEqual(supersedePendingUserActionTasks(continuedConversation.id), [questionSession.sessionId], '新 prompt 也必须结束等待回答的提问任务');
assert.equal(getDb().prepare('SELECT status FROM conversation_interactions WHERE id = ?').get(pendingInteraction.lastInsertRowid).status, 'cancelled', '替代提问任务时必须同时关闭旧提问卡片');

console.log('agent task queue tests passed');
