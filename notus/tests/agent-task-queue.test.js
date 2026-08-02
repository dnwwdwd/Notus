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

const { ensureConversation } = require('../lib/conversations');
const { createSession, updateSessionStatus } = require('../lib/agentSession');
const { createTask, claimRunnableTasks, getQueuePosition, updateTask, wakeTask, recoverOrphanedTasks } = require('../lib/agentTaskQueue');

const conversation = ensureConversation({ kind: 'agent', title: '队列测试' });
const first = createSession({ goal: '第一个任务', authorizedPaths: [''], conversationId: conversation.id });
const second = createSession({ goal: '第二个任务', authorizedPaths: [''], conversationId: conversation.id });
createTask({ sessionId: first.sessionId, conversationId: conversation.id, input: { goal: '第一个任务' } });
createTask({ sessionId: second.sessionId, conversationId: conversation.id, input: { goal: '第二个任务' } });

assert.equal(getQueuePosition(first.sessionId), 1);
assert.equal(getQueuePosition(second.sessionId), 2);
assert.deepEqual(claimRunnableTasks().map((task) => task.session_id), [first.sessionId], '同会话只能领取队首任务');
updateTask(first.sessionId, { status: 'completed', finished: true });
assert.deepEqual(claimRunnableTasks().map((task) => task.session_id), [second.sessionId], '前序任务终态后应领取下一任务');
updateSessionStatus(second.sessionId, 'waiting_retry');
updateTask(second.sessionId, { status: 'waiting_retry' });
assert.equal(wakeTask(second.sessionId).status, 'queued', '显式继续应把等待任务重新排队');
updateTask(second.sessionId, { status: 'running' });
assert.equal(recoverOrphanedTasks(), 1, '进程重启应恢复 orphaned running 任务');

console.log('agent task queue tests passed');
