const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function reset(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-question-card-concurrency-'));
process.env.NOTUS_RUNTIME_TARGET = 'web';
process.env.NOTUS_DATA_ROOT = tempDir;
process.env.NOTES_DIR = path.join(tempDir, 'notes');
process.env.ASSETS_DIR = path.join(tempDir, 'assets');
process.env.DB_PATH = path.join(tempDir, 'notus.db');
process.env.LOG_DIR = path.join(tempDir, 'logs');
process.env.SESSION_DIR = path.join(tempDir, 'session');

[
  '../lib/db', '../lib/config', '../lib/files', '../lib/conversations',
  '../lib/conversationInteractions', '../lib/agentSession', '../lib/agentControlPlane',
  '../lib/agentTaskQueue', '../lib/platform/paths', '../lib/platform/profile', '../lib/platform/target',
].forEach(reset);

const { ensureConversation } = require('../lib/conversations');
const {
  claimInteractionProcessing,
  createInteraction,
  getInteractionById,
  updateInteractionWhen,
} = require('../lib/conversationInteractions');
const { createSession, updateSessionStatus } = require('../lib/agentSession');
const {
  createOrGetResumeJob,
  getResumeJob,
  issueCapability,
  settleResumeJob,
  validateCapability,
} = require('../lib/agentControlPlane');
const { createTask, getTaskBySession, updateTask, wakeTask } = require('../lib/agentTaskQueue');

const conversation = ensureConversation({ kind: 'agent', title: '提问卡并发回归' });
const session = createSession({ goal: '回答 A 后必须等待 B', authorizedPaths: [''], conversationId: conversation.id });
createTask({ sessionId: session.sessionId, conversationId: conversation.id, input: { goal: '回答 A 后必须等待 B' } });
updateSessionStatus(session.sessionId, 'waiting_interaction');
updateTask(session.sessionId, { status: 'waiting_interaction' });

const interactionA = createInteraction({
  conversationId: conversation.id,
  source: 'agent_loop',
  payload: { agent_session_id: session.sessionId, questions: [] },
});

// SSE 重连会重新签发票据，但旧票据不得继续有效，也不能据此产生第二次回答。
const firstTicket = issueCapability({ sessionId: session.sessionId, interactionId: interactionA.id, action: 'respond' });
const secondTicket = issueCapability({ sessionId: session.sessionId, interactionId: interactionA.id, action: 'respond' });
assert.strictEqual(
  validateCapability(firstTicket, { sessionId: session.sessionId, interactionId: interactionA.id, action: 'respond' }).reason,
  'CAPABILITY_INVALID',
  '新的 SSE 回放票据必须使旧回答票据失效'
);
assert.strictEqual(
  validateCapability(secondTicket, { sessionId: session.sessionId, interactionId: interactionA.id, action: 'respond' }).valid,
  true,
  '最新回答票据必须保持可用'
);

const claimedA = claimInteractionProcessing(interactionA.id);
assert.ok(claimedA, '第一个回答请求必须取得 interaction 处理权');
assert.strictEqual(claimInteractionProcessing(interactionA.id), null, '第二个回答请求不得重复取得处理权');
const answeredA = updateInteractionWhen(interactionA.id, ['processing'], { status: 'answered', response: { answers: {} } });
assert.strictEqual(answeredA.status, 'answered');
assert.strictEqual(getInteractionById(interactionA.id).status, 'answered');

const resumeA = createOrGetResumeJob({ sessionId: session.sessionId, interactionId: interactionA.id });
const duplicateResumeA = createOrGetResumeJob({ sessionId: session.sessionId, interactionId: interactionA.id });
assert.strictEqual(resumeA.id, duplicateResumeA.id, '同一张卡片只能有一个 resume job');
const firstResumeTicket = issueCapability({
  sessionId: session.sessionId,
  interactionId: interactionA.id,
  resumeJobId: resumeA.id,
  action: 'resume',
});
const secondResumeTicket = issueCapability({
  sessionId: session.sessionId,
  interactionId: interactionA.id,
  resumeJobId: resumeA.id,
  action: 'resume',
});
assert.strictEqual(
  validateCapability(firstResumeTicket, {
    sessionId: session.sessionId,
    interactionId: interactionA.id,
    resumeJobId: resumeA.id,
    action: 'resume',
  }).reason,
  'CAPABILITY_INVALID',
  '对话刷新生成的新恢复票据必须使旧恢复票据失效'
);
assert.strictEqual(
  validateCapability(secondResumeTicket, {
    sessionId: session.sessionId,
    interactionId: interactionA.id,
    resumeJobId: resumeA.id,
    action: 'resume',
  }).valid,
  true,
  '最新恢复票据必须保持可用'
);
const queuedTask = wakeTask(session.sessionId, { resumeJobId: resumeA.id });
assert.strictEqual(queuedTask.resume_job_id, resumeA.id, '队列必须显式绑定本次 resume job');

// 模拟 A 的续跑已经启动，随后又停在新的 B 卡。A 的 job 必须完成并从队列解绑，
// 刷新页面时不能把 B 自动排队。
const { getDb } = require('../lib/db');
getDb().prepare("UPDATE agent_resume_jobs SET status = 'running' WHERE id = ?").run(resumeA.id);
const settledA = settleResumeJob(resumeA.id, 'waiting_interaction');
assert.strictEqual(settledA.status, 'completed', 'A 续跑再次生成提问卡后，A job 必须终态');
updateTask(session.sessionId, { status: 'waiting_interaction', resumeJobId: null });
const interactionB = createInteraction({
  conversationId: conversation.id,
  source: 'agent_loop',
  payload: { agent_session_id: session.sessionId, questions: [] },
});
assert.strictEqual(getTaskBySession(session.sessionId).resume_job_id, null, '等待 B 卡时队列不能保留 A 的恢复绑定');
assert.strictEqual(getResumeJob(resumeA.id).status, 'completed');
assert.strictEqual(getInteractionById(interactionB.id).status, 'pending', 'B 卡必须保持待回答，不能被 A 的旧 job 跳过');

console.log('agent question-card concurrency tests passed');
