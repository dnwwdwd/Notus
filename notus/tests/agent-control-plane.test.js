const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function reset(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-agent-control-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = root;
  process.env.NOTES_DIR = path.join(root, 'notes');
  process.env.ASSETS_DIR = path.join(root, 'assets');
  process.env.DB_PATH = path.join(root, 'notus.db');
  process.env.LOG_DIR = path.join(root, 'logs');
  process.env.SESSION_DIR = path.join(root, 'session');

  [
    '../lib/db', '../lib/config', '../lib/files', '../lib/conversations',
    '../lib/conversationInteractions', '../lib/agentSession', '../lib/agentControlPlane',
    '../lib/platform/paths', '../lib/platform/profile', '../lib/platform/target',
  ].forEach(reset);

  const { getDb } = require('../lib/db');
  const { ensureConversation } = require('../lib/conversations');
  const { createInteraction } = require('../lib/conversationInteractions');
  const {
    createSession,
    detectDeadloop,
    getSession,
    listRunEvents,
    recordRunEvent,
    saveMessagesCheckpoint,
    updateSessionStatus,
  } = require('../lib/agentSession');
  const {
    acquireRunLease,
    createOrGetResumeJob,
    issueCapability,
    recoverStaleRunLeases,
    registerActiveRun,
    releaseRunLease,
    renewRunLease,
    validateCapability,
    requestCancellation,
  } = require('../lib/agentControlPlane');
  const { cancelTask, createTask, getTaskBySession } = require('../lib/agentTaskQueue');

  const conversation = ensureConversation({ kind: 'agent', title: 'control plane' });
  const cancellationTestSession = createSession({ goal: '控制面后续测试', conversationId: conversation.id });
  createTask({ sessionId: cancellationTestSession.sessionId, conversationId: conversation.id, input: { goal: '控制面后续测试' } });
  requestCancellation(cancellationTestSession.sessionId);
  cancelTask(cancellationTestSession.sessionId);
  assert.strictEqual(getSession(cancellationTestSession.sessionId).status, 'cancelled', '取消尚未运行的任务必须立即结束 session，不能继续被前端识别为可中断');
  assert.strictEqual(getTaskBySession(cancellationTestSession.sessionId).status, 'cancelled', '取消尚未运行的任务必须立即结束队列记录');
  const created = createSession({ goal: '测试恢复', conversationId: conversation.id });
  const interaction = createInteraction({
    conversationId: conversation.id,
    source: 'agent_loop',
    payload: { agent_session_id: created.sessionId, questions: [] },
  });
  const otherInteraction = createInteraction({
    conversationId: conversation.id,
    source: 'agent_loop',
    payload: { agent_session_id: created.sessionId, questions: [] },
  });

  recordRunEvent({
    sessionId: created.sessionId,
    runId: 'timeline-run',
    event: {
      type: 'progress',
      stage: 'tool_start',
      loop_index: 1,
      tool_name: 'read_file',
      tool_input_summary: '读取 demo.md，临时串 sk-abcdefghijklmnopqrstuvwxyz123456',
    },
  });
  recordRunEvent({
    sessionId: created.sessionId,
    runId: 'timeline-run',
    event: {
      type: 'progress',
      stage: 'model_progress',
      loop_index: 1,
      text: '已经找到目标文件，准备读取。',
      api_key: 'should-never-be-persisted',
    },
  });
  const timeline = listRunEvents(created.sessionId);
  assert.strictEqual(timeline.length, 2);
  assert.match(timeline[0].payload.tool_input_summary, /\[REDACTED\]/, '时间线必须执行高熵密钥扫描');
  assert.ok(!JSON.stringify(timeline).includes('should-never-be-persisted'), '非白名单字段不得进入时间线');
  assert.strictEqual(timeline[1].payload.text, '已经找到目标文件，准备读取。');

  const ticket = issueCapability({
    sessionId: created.sessionId,
    interactionId: interaction.id,
    action: 'respond',
    ownerId: 'future-owner',
  });
  assert.strictEqual(validateCapability(ticket, {
    sessionId: created.sessionId,
    interactionId: interaction.id,
    action: 'respond',
    ownerId: 'future-owner',
  }, { consume: true }).valid, true);
  assert.strictEqual(validateCapability(ticket, {
    sessionId: created.sessionId,
    interactionId: interaction.id,
    action: 'respond',
  }, { consume: true }).consumed, true, '重复消费必须可识别并走幂等结果');
  assert.strictEqual(validateCapability(ticket, {
    sessionId: created.sessionId,
    interactionId: otherInteraction.id,
    action: 'respond',
  }).reason, 'CAPABILITY_SCOPE_MISMATCH');
  assert.strictEqual(validateCapability(ticket, {
    sessionId: created.sessionId,
    interactionId: interaction.id,
    action: 'respond',
    ownerId: 'another-owner',
  }).reason, 'CAPABILITY_OWNER_MISMATCH');

  const shortTicket = issueCapability({
    sessionId: created.sessionId,
    interactionId: interaction.id,
    action: 'respond',
    ttlMs: 30_000,
  });
  const realNow = Date.now;
  const issuedAt = realNow();
  Date.now = () => issuedAt + 31_000;
  try {
    assert.strictEqual(validateCapability(shortTicket, {}).reason, 'CAPABILITY_EXPIRED');
  } finally {
    Date.now = realNow;
  }

  updateSessionStatus(created.sessionId, 'waiting_interaction');
  const firstJob = createOrGetResumeJob({ sessionId: created.sessionId, interactionId: interaction.id });
  const secondJob = createOrGetResumeJob({ sessionId: created.sessionId, interactionId: interaction.id });
  assert.strictEqual(firstJob.id, secondJob.id, '同一 interaction 只能创建一个 resume job');
  assert.strictEqual(getSession(created.sessionId).status, 'queued_resume');

  const firstLease = acquireRunLease(created.sessionId, { runId: 'run-a' });
  assert.strictEqual(firstLease.acquired, true);
  assert.strictEqual(acquireRunLease(created.sessionId, { runId: 'run-b' }).reason, 'SESSION_RUN_CONFLICT');
  const renewed = renewRunLease(created.sessionId, 'run-a');
  assert.strictEqual(renewed.renewed, true);
  assert.ok(renewed.stateVersion > firstLease.stateVersion);
  assert.strictEqual(releaseRunLease(created.sessionId, 'run-a', 'running'), true);

  const finishingController = new AbortController();
  getDb().prepare(`
    UPDATE agent_sessions
    SET status = 'waiting_retry', active_run_id = 'finishing-run',
        lease_expires_at = ?, state_version = state_version + 1
    WHERE id = ?
  `).run(new Date(Date.now() + 60_000).toISOString(), created.sessionId);
  registerActiveRun('finishing-run', finishingController);
  const retryLease = acquireRunLease(created.sessionId, { runId: 'run-retry' });
  assert.strictEqual(retryLease.acquired, true, 'waiting_retry 必须能接管仍在收尾的旧 lease');
  assert.strictEqual(getSession(created.sessionId).active_run_id, 'run-retry');
  assert.strictEqual(releaseRunLease(created.sessionId, 'finishing-run'), false, '旧 run 的 finally 不得释放新 run 的 lease');
  assert.strictEqual(releaseRunLease(created.sessionId, 'run-retry', 'waiting_model_recovery'), true);
  const recoveryLease = acquireRunLease(created.sessionId, { runId: 'run-model-recovery' });
  assert.strictEqual(recoveryLease.acquired, true, 'waiting_model_recovery 必须能重新获取 lease');
  assert.strictEqual(releaseRunLease(created.sessionId, 'run-model-recovery', 'running'), true);

  getDb().prepare(`
    UPDATE agent_resume_jobs
    SET status = 'running', run_id = 'abandoned-run'
    WHERE id = ?
  `).run(firstJob.id);
  getDb().prepare(`
    UPDATE agent_sessions
    SET status = 'running', active_run_id = 'abandoned-run', lease_expires_at = ?
    WHERE id = ?
  `).run(new Date(Date.now() - 60_000).toISOString(), created.sessionId);
  assert.deepStrictEqual(recoverStaleRunLeases({ conversationId: conversation.id }), [created.sessionId]);
  assert.strictEqual(getDb().prepare('SELECT status FROM agent_resume_jobs WHERE id = ?').get(firstJob.id).status, 'queued', '恢复孤儿 run 时必须把 running resume job 重新排队');
  assert.strictEqual(getDb().prepare('SELECT run_id FROM agent_resume_jobs WHERE id = ?').get(firstJob.id).run_id, null, '重新排队的 resume job 不能继续携带已失效 run');
  const recoveredSession = getSession(created.sessionId);
  assert.strictEqual(recoveredSession.status, 'queued_resume', '过期 running 必须转为可恢复状态');
  assert.strictEqual(recoveredSession.active_run_id, null);
  assert.strictEqual(recoveredSession.lease_expires_at, null);
  getDb().prepare(`
    UPDATE agent_sessions
    SET status = 'running', active_run_id = 'run-from-dead-process', lease_expires_at = ?
    WHERE id = ?
  `).run(new Date(Date.now() + 60_000).toISOString(), created.sessionId);
  assert.deepStrictEqual(recoverStaleRunLeases({ conversationId: conversation.id }), [created.sessionId]);
  assert.strictEqual(getSession(created.sessionId).status, 'queued_resume', '进程重启后内存中不存在的 run 必须立即恢复，不能等待 lease 到期');
  const disconnectController = new AbortController();
  getDb().prepare(`
    UPDATE agent_sessions
    SET status = 'running', active_run_id = 'disconnecting-run', lease_expires_at = ?
    WHERE id = ?
  `).run(new Date(Date.now() + 60_000).toISOString(), created.sessionId);
  registerActiveRun('disconnecting-run', disconnectController);
  assert.deepStrictEqual(recoverStaleRunLeases({ conversationId: conversation.id }), [], '仍在运行的 controller 不能被误恢复');
  disconnectController.abort('disconnect');
  assert.deepStrictEqual(recoverStaleRunLeases({ conversationId: conversation.id }), [created.sessionId], '已断开的本地 SSE 必须立即解除 running 锁');

  const cp1 = saveMessagesCheckpoint(created.sessionId, [{ role: 'user', content: 'a' }], [], 'tool-a', 'run-a');
  const cp2 = saveMessagesCheckpoint(created.sessionId, [{ role: 'user', content: 'b' }], [], 'tool-b', 'run-b');
  const checkpoints = getDb().prepare('SELECT id, status FROM agent_checkpoints WHERE session_id = ? ORDER BY id').all(created.sessionId);
  assert.deepStrictEqual(checkpoints, [
    { id: cp1, status: 'superseded' },
    { id: cp2, status: 'active' },
  ]);
  getDb().exec(`
    CREATE TRIGGER fail_agent_checkpoint_insert
    BEFORE INSERT ON agent_checkpoints
    BEGIN SELECT RAISE(ABORT, 'fault-injected-checkpoint-failure'); END;
  `);
  assert.throws(() => saveMessagesCheckpoint(created.sessionId, [{ role: 'user', content: 'c' }], [], 'tool-c', 'run-c'), /fault-injected/);
  assert.deepStrictEqual(
    getDb().prepare("SELECT id, status FROM agent_checkpoints WHERE session_id = ? AND status = 'active'").all(created.sessionId),
    [{ id: cp2, status: 'active' }],
    'checkpoint 数据库失败时必须保留上一条 active 记录'
  );
  getDb().exec('DROP TRIGGER fail_agent_checkpoint_insert');
  reset('../lib/agentSession');
  const reloadedCheckpoint = require('../lib/agentSession').loadMessagesCheckpoint(created.sessionId);
  assert.strictEqual(reloadedCheckpoint.id, cp2, '模拟进程重启后必须恢复最后提交的 checkpoint');

  assert.strictEqual(detectDeadloop(created.sessionId, 'read_file', { content: 'same' }), false);
  assert.strictEqual(detectDeadloop(created.sessionId, 'read_file', { content: 'same' }), false);
  assert.strictEqual(detectDeadloop(created.sessionId, 'search_knowledge', { results: [1] }), false);
  assert.strictEqual(detectDeadloop(created.sessionId, 'read_file', { content: 'same' }), false, '非连续重复不能误判');
  assert.strictEqual(detectDeadloop(created.sessionId, 'read_file', { content: 'same' }), false);
  assert.strictEqual(detectDeadloop(created.sessionId, 'read_file', { content: 'same' }), true, '连续三次相同结果必须终止');
  const nextRun = acquireRunLease(created.sessionId, { runId: 'run-next' });
  assert.strictEqual(nextRun.acquired, true);
  assert.strictEqual(detectDeadloop(created.sessionId, 'read_file', { content: 'same' }), false, '新 run 必须重置连续窗口');
  releaseRunLease(created.sessionId, 'run-next', 'running');

  console.log('agent control plane tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
