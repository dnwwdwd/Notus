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
      if (mode === 'temporary' && calls < 6) {
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
const { callLLMWithRetry, classifyLLMError, DEFAULT_LLM_RETRY_LIMIT } = require('../lib/agentLoop');

(async () => {
  const retries = [];
  assert.equal(DEFAULT_LLM_RETRY_LIMIT, 5, 'LLM 临时错误的默认自动重试上限应为 5 次');
  const response = await callLLMWithRetry({}, DEFAULT_LLM_RETRY_LIMIT, {
    retryDelayMs: () => 0,
    onRetry: (event) => retries.push(event.attempt),
  });
  assert.equal(calls, 6, '首次请求后应最多额外重试 5 次');
  assert.deepEqual(retries, [1, 2, 3, 4, 5]);
  assert.equal(response.content[0].text, 'ok');

  mode = 'quota';
  calls = 0;
  await assert.rejects(
    () => callLLMWithRetry({}, DEFAULT_LLM_RETRY_LIMIT, { retryDelayMs: () => 0 }),
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
  assert.ok(loopSource.includes('const DEFAULT_LLM_RETRY_LIMIT = 5'), '主 LLM 自动重试上限必须集中定义为 5 次');
  assert.ok(loopSource.includes('}, DEFAULT_LLM_RETRY_LIMIT, {'), 'Agent 主循环必须使用统一的 LLM 重试上限');
  assert.ok(controllerSource.includes('event.retry_limit || 5'), '旧事件缺少上限时，工具链默认显示必须为 5 次');
  assert.ok(loopSource.includes('checkpointToCommit = saveMessagesCheckpoint(session.id, messages'), '每次 LLM 请求前必须保存 checkpoint');
  assert.ok(loopSource.includes('recordRunEvent({ sessionId, runId, event: safeEvent })'), 'SSE 语义事件必须先脱敏持久化');
  assert.ok(loopSource.includes("artifact_type: 'run_error'") && loopSource.includes("'waiting_model_recovery'") && loopSource.includes("'waiting_retry'"));
  assert.ok(routeSource.includes("'waiting_retry', 'waiting_model_recovery'"), '恢复 API 必须允许两种 LLM 等待状态');
  assert.ok(controlPlaneSource.includes("'running', 'waiting_retry', 'waiting_model_recovery'"), '可恢复状态必须能重新获取 run lease');
  assert.ok(controlPlaneSource.includes('!leaseExpired && !resumableHandoff'), '真实 running 冲突保留，可恢复等待态允许接管收尾 lease');
  assert.ok(routeSource.indexOf('releaseLeaseBeforeResumeEvent(event, sessionId)') < routeSource.indexOf("if (event.type === 'final')"), '普通续跑必须先释放 lease 再发送可恢复错误');
  assert.ok(interactionResumeSource.includes("code: 'RESUME_INTERACTION_ROUTE_RETIRED'"), '旧版 interaction 直连续跑接口必须明确停用');
  assert.ok(!interactionResumeSource.includes('runAgentLoop'), '旧版 interaction 续跑接口不得绕过队列直接执行 Agent Loop');
  assert.ok(controllerSource.includes("action: event.resumable ? 'resume_agent' : ''") && controllerSource.includes("artifact_type === 'run_error'"));
  assert.ok(
    controllerSource.includes("sessionStatus = event.status || (event.resumable ? 'waiting_retry' : 'failed');\n    loading = false;"),
    'run_error 事件到达后 SSE 可能继续保持心跳，但前端必须立即解除 loading，允许用户改写或发送新任务'
  );
  assert.ok(
    !controllerSource.includes('if (!event.resumable) setLoading(false);'),
    '可恢复错误不能继续把 loading 永久保持为 true'
  );
  assert.ok(workspaceSource.includes('resumeAgentTaskInFlightRef.current'), '继续任务必须同步拦截重复点击');
  assert.ok(!loopSource.includes("type: 'final', text: '\u6a21\u578b\u670d\u52a1\u6682\u65f6\u4e0d\u53ef\u7528"), '可恢复 LLM 错误不应写成最终助手消息');
  assert.ok(routeSource.includes('getLatestRunEventId'), '继续任务必须记录恢复前的事件游标，不能从头回放历史终态');
  assert.ok(routeSource.includes('event_cursor: eventCursor'), '继续接口必须把恢复前的事件游标返回给前端订阅');
  assert.ok(controllerSource.includes('after=${encodeURIComponent(String(eventCursor))}'), '前端续跑订阅必须从服务端返回的事件游标之后开始');
  assert.ok(routeSource.includes('wakeTask(resumeSessionId, {') && routeSource.includes('resumeJobId: resumeJob.id'), '继续任务必须把指定的 resume job 绑定到目标队列任务');
  console.log('agent llm retry and resume tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
