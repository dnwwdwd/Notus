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

console.log('agent loop error recovery tests passed');
