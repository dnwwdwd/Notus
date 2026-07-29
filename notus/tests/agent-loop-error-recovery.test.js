const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const controllerSource = fs.readFileSync(path.join(root, 'hooks/useAgentLoopController.js'), 'utf8');
const startRouteSource = fs.readFileSync(path.join(root, 'pages/api/agent/loop/start.js'), 'utf8');

assert.ok(
  controllerSource.includes("setActiveAgentSession({ status: 'failed', reason: 'error' });"),
  '任何请求或 SSE 错误都必须强制解除 running session，不能依赖已有 React state'
);
assert.ok(
  startRouteSource.includes('let activeSessionId = null;')
    && startRouteSource.includes("if (activeSessionId) updateSessionStatus(activeSessionId, 'failed');"),
  'API 在新建 session 后遇到 LLM 400/404 等异常时必须持久化 failed 状态'
);
assert.ok(
  controllerSource.includes("const requestId = String(response.headers?.get('x-request-id') || '').trim();")
    && controllerSource.includes('Next.js 的兜底 500 页、反向代理错误页等非 JSON 内容不能作为聊天正文渲染。')
    && !controllerSource.includes('return parsed?.error || parsed?.code || text || fallback;'),
  '非 JSON 500 页面必须转换为受控错误提示，不能把 HTML 原文显示在 Agent 区域'
);
assert.ok(
  startRouteSource.includes("logger.error('agent.loop.start.runtime_failed', { error });")
    && startRouteSource.includes("logger.error('agent.loop.start.runtime_unavailable', { error: runtime.error });")
    && startRouteSource.includes("error: 'Agent 服务初始化失败，请稍后重试。'")
    && startRouteSource.includes('request_id: context.request_id'),
  'SSE 建立前的运行时异常必须记录并以结构化 JSON 返回'
);

console.log('agent loop error recovery tests passed');
