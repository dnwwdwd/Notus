const assert = require('assert');
const fs = require('fs');
const path = require('path');

const route = fs.readFileSync(path.join(__dirname, '..', 'pages/api/agent/sessions/[id].js'), 'utf8');

assert.ok(route.includes("action: 'session_read'"), '累计 Diff 详情必须校验 session_read capability');
assert.ok(route.includes('validateSessionAccess(sessionId, token)'), '累计 Diff 详情必须兼容 session token');
assert.ok(route.includes('getTaskChangeSetBySession(sessionId)'), '会话详情必须读取任务级累计变更集摘要');
assert.ok(route.includes('task_change_set:'), '会话详情必须返回任务级累计变更集字段');

console.log('agent task changes route tests passed');
