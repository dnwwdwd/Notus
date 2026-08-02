const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const llmPath = require.resolve('../lib/llm');
const loopPath = require.resolve('../lib/agentLoop');
let mode = 'temporary';
let calls = 0;

require.cache[llmPath] = {
  id: llmPath,
  filename: llmPath,
  loaded: true,
  exports: {
    completeToolChat: async () => {
      calls += 1;
      if (mode === 'temporary' && calls < 4) {
        const error = new Error('temporary provider failure');
        error.code = 'LLM_API_ERROR';
        error.status = 503;
        throw error;
      }
      if (mode === 'quota') {
        const error = new Error('provider rejected request');
        error.code = 'LLM_API_ERROR';
        error.status = 429;
        error.response_body = JSON.stringify({ error: { code: 'insufficient_quota' } });
        throw error;
      }
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  },
};
delete require.cache[loopPath];
const { callLLMWithRetry, classifyLLMError } = require('../lib/agentLoop');

(async () => {
  const retries = [];
  const response = await callLLMWithRetry({}, 3, {
    retryDelayMs: () => 0,
    onRetry: (event) => retries.push(event.attempt),
  });
  assert.equal(calls, 4, '首次请求后应最多额外重试 3 次');
  assert.deepEqual(retries, [1, 2, 3]);
  assert.equal(response.content[0].text, 'ok');

  mode = 'quota';
  calls = 0;
  await assert.rejects(
    () => callLLMWithRetry({}, 3, { retryDelayMs: () => 0 }),
    (error) => error.llmErrorCategory === 'action_required' && error.publicCode === 'LLM_ACTION_REQUIRED'
  );
  assert.equal(calls, 1, '余额不足不应盲目自动重试');

  assert.equal(classifyLLMError({ status: 429, response_body: 'rate_limit_exceeded' }).category, 'retryable');
  assert.equal(classifyLLMError({ status: 401 }).category, 'action_required');
  assert.equal(classifyLLMError({ status: 400, message: 'invalid request schema' }).category, 'fatal');

  const loopSource = fs.readFileSync(path.join(root, 'lib/agentLoop.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(root, 'pages/api/agent/loop/start.js'), 'utf8');
  const interactionResumeSource = fs.readFileSync(path.join(root, 'pages/api/agent/sessions/[id]/resume-interaction.js'), 'utf8');
  const controlPlaneSource = fs.readFileSync(path.join(root, 'lib/agentControlPlane.js'), 'utf8');
  const controllerSource = fs.readFileSync(path.join(root, 'hooks/useAgentLoopController.js'), 'utf8');
  const workspaceSource = fs.readFileSync(path.join(root, 'components/AgentWorkspace/FileAgentWorkspace.js'), 'utf8');
  assert.ok(loopSource.includes('checkpointToCommit = saveMessagesCheckpoint(session.id, messages'), '每次 LLM 请求前必须保存 checkpoint');
  assert.ok(loopSource.includes('recordRunEvent({ sessionId, runId, event })'), 'SSE 语义事件必须先脱敏持久化');
  assert.ok(loopSource.includes("artifact_type: 'run_error'") && loopSource.includes("'waiting_model_recovery'") && loopSource.includes("'waiting_retry'"));
  assert.ok(routeSource.includes("'waiting_retry', 'waiting_model_recovery'"), '恢复 API 必须允许两种 LLM 等待状态');
  assert.ok(controlPlaneSource.includes("'running', 'waiting_retry', 'waiting_model_recovery'"), '可恢复状态必须能重新获取 run lease');
  assert.ok(controlPlaneSource.includes('!leaseExpired && !resumableHandoff'), '真实 running 冲突保留，可恢复等待态允许接管收尾 lease');
  assert.ok(routeSource.indexOf('releaseLeaseBeforeResumeEvent(event, sessionId)') < routeSource.indexOf("if (event.type === 'final')"), '普通续跑必须先释放 lease 再发送可恢复错误');
  assert.ok(interactionResumeSource.indexOf('releaseLeaseBeforeResumeEvent(event)') < interactionResumeSource.indexOf("if (event.type === 'final')"), 'interaction 续跑必须先释放 lease 再发送可恢复错误');
  assert.ok(controllerSource.includes("action: event.resumable ? 'resume_agent' : ''") && controllerSource.includes("artifact_type === 'run_error'"));
  assert.ok(controllerSource.includes('if (!event.resumable) setLoading(false);'), '可恢复按钮必须等 SSE 收尾后才解除 loading');
  assert.ok(workspaceSource.includes('resumeAgentTaskInFlightRef.current'), '继续任务必须同步拦截重复点击');
  assert.ok(!loopSource.includes("type: 'final', text: '\u6a21\u578b\u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528"), '可恢复 LLM 错误不应写成最终助手消息');
  assert.ok(routeSource.includes('getLatestRunEventId'), '继续任务必须记录恢复前的事件游标，不能从头回放历史终态');
  assert.ok(routeSource.includes('event_cursor: eventCursor'), '继续接口必须把恢复前的事件游标返回给前端订阅');
  assert.ok(controllerSource.includes('after=${encodeURIComponent(String(accepted.event_cursor || 0))}'), '前端续跑订阅必须从服务端返回的事件游标之后开始');
  assert.ok(routeSource.includes('wakeTask(resumeSessionId, { llmConfigId: body.llm_config_id || null })'), '继续任务切换模型时必须更新目标队列任务的模型配置');
  console.log('agent llm retry and resume tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
