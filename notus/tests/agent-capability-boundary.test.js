const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const conversationRoute = read('pages/api/conversations/[id].js');
const workspace = read('components/AgentWorkspace/FileAgentWorkspace.js');
const controller = read('hooks/useAgentLoopController.js');
const tokenStore = read('utils/agentSessionTokens.js');

assert.ok(conversationRoute.includes("const raw = req.headers['x-agent-session-tokens'];"), '会话详情必须读取浏览器提交的 session token。');
assert.ok(conversationRoute.includes('validateSessionAccess(session.id, sessionTokens.get(String(session.id))).valid'), '会话详情必须逐个验证 session token。');
assert.ok(conversationRoute.includes('control_tickets: canControl ? {'), '无 session token 的详情不得签发控制票据。');
assert.ok(conversationRoute.includes('!controllableSessionIds.has(sessionId)'), '无 session token 的待答 interaction 不得签发回答票据。');
assert.ok(workspace.includes("'x-agent-session-tokens': sessionTokenHeader"), '恢复对话时必须带回本机 session token。');
assert.ok(workspace.includes('token: readAgentSessionToken(session.id)'), '恢复后的 session 必须绑定本机 token。');
assert.ok(controller.includes('rememberAgentSessionToken(acceptedSessionId, acceptedToken)'), '新任务 token 必须写入浏览器会话存储。');
assert.ok(controller.includes("'x-agent-session-token': acceptedToken"), 'SSE 应优先使用原始 session token。');
assert.ok(tokenStore.includes('window.sessionStorage'), 'Agent token 只能保存在浏览器会话存储中。');
assert.ok(!tokenStore.includes('window.localStorage'), 'Agent token 不能长期写入 localStorage。');

console.log('agent capability boundary tests passed');
