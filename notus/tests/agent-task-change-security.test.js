const assert = require('assert');
const fs = require('fs');
const path = require('path');

const routeSource = fs.readFileSync(
  path.resolve(__dirname, '../pages/api/agent/sessions/[id]/changes.js'),
  'utf8'
);
const workspaceSource = fs.readFileSync(
  path.resolve(__dirname, '../components/AgentWorkspace/AgentWorkspace.js'),
  'utf8'
);

assert.ok(
  routeSource.includes("if (!controlTicket && !token)"),
  '累计 Diff 详情接口必须拒绝无读取凭据的请求。'
);
assert.ok(
  routeSource.includes("validateCapability(controlTicket, { sessionId, action: 'session_read' })"),
  '累计 Diff 详情接口必须验证只读 control ticket 与 session 归属。'
);
assert.ok(
  routeSource.includes('validateSessionAccess(sessionId, token)'),
  '累计 Diff 详情接口必须验证 session token。'
);
assert.ok(
  workspaceSource.includes("'x-agent-control-ticket': access.read_control_ticket"),
  '累计 Diff 卡读取详情时必须携带只读 control ticket。'
);

console.log('agent task change security tests passed');
