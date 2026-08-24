const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const controllerSource = fs.readFileSync(path.join(root, 'hooks/useAgentLoopController.js'), 'utf8');
const startRouteSource = fs.readFileSync(path.join(root, 'pages/api/agent/loop/start.js'), 'utf8');
const loopSource = fs.readFileSync(path.join(root, 'lib/agentLoop.js'), 'utf8');

assert.ok(
  controllerSource.includes("setActiveAgentSession({ status: 'failed', reason: 'error' });"),
  '任何请求或 SSE 错误都必须强制解除 running session，不能依赖已有 React state'
);
assert.ok(
  controllerSource.includes('sessionRef.current = next;')
    && controllerSource.includes('const previous = sessionRef.current;'),
  'SSE session state must update the token ref synchronously so an immediate question card can resume the correct session'
);
assert.ok(
  startRouteSource.includes('createTask({')
    && startRouteSource.includes('return res.status(202).json')
    && startRouteSource.includes('wakeAgentTaskWorker()'),
  '启动 API 必须只持久化入队并返回 202，不能把浏览器连接当成任务生命周期'
);
assert.ok(
  controllerSource.includes("const requestId = String(response.headers?.get('x-request-id') || '').trim();")
    && controllerSource.includes('Next.js 的兜底 500 页、反向代理错误页等非 JSON 内容不能作为聊天正文渲染。')
    && !controllerSource.includes('return parsed?.error || parsed?.code || text || fallback;'),
  '非 JSON 500 页面必须转换为受控错误提示，不能把 HTML 原文显示在 Agent 区域'
);
assert.ok(
  startRouteSource.includes("logger.error('agent.loop.start.enqueue_failed', { error });")
    && startRouteSource.includes("error: 'Agent 服务初始化失败，请稍后重试。'")
    && startRouteSource.includes('request_id: context.request_id'),
  '任务入队异常必须记录并以结构化 JSON 返回'
);
assert.ok(
  loopSource.includes('const resolveAbortResult = () => {')
    && loopSource.includes('const abortAfterModel = resolveAbortResult();')
    && loopSource.includes('const abortAfterTool = resolveAbortResult();'),
  '取消请求即使发生在模型或工具执行期间，也必须在返回后阻止任务继续完成'
);
assert.ok(
  loopSource.indexOf('recordToolReceipt(session, toolUse.name, result);') < loopSource.indexOf('const abortAfterTool = resolveAbortResult();'),
  '已返回的工具结果必须先写入审计记录，再结束已取消任务'
);

console.log('agent loop error recovery tests passed');
