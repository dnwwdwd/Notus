const assert = require('assert');
const fs = require('fs');
const path = require('path');

const route = fs.readFileSync(path.join(__dirname, '..', 'pages/api/agent/sessions/[id]/changes.js'), 'utf8');

assert.ok(route.includes("action: 'session_read'"), '累计 Diff 详情必须校验 session_read capability');
assert.ok(route.includes('validateSessionAccess(sessionId, token)'), '累计 Diff 详情必须兼容 session token');
assert.ok(route.includes('getTaskChangeSetDetail(sessionId)'), '累计 Diff 详情必须读取任务级累计变更集');
assert.ok(route.includes('TASK_CHANGE_SET_NOT_FOUND'), '没有累计变更集时必须返回明确的 404 错误');

console.log('agent task changes route tests passed');
