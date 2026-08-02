const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const conversations = read('lib/conversations.js');
const drawer = read('components/ChatArea/ConversationDrawer.js');
const workspace = read('components/AgentWorkspace/FileAgentWorkspace.js');

assert.ok(conversations.includes('const ACTIVE_AGENT_SESSION_STATUSES = ['), '会话列表必须集中定义非终态 Agent session');
assert.ok(conversations.includes("WHEN 'waiting_interaction' THEN 0"), '等待回答必须是会话列表的最高任务状态');
assert.ok(conversations.includes('AS active_agent_status'), '会话列表 API 必须返回任务状态摘要');
assert.ok(conversations.includes('AS active_agent_session_count'), '会话列表 API 必须返回未完成任务数量');
assert.ok(conversations.includes('...ACTIVE_AGENT_SESSION_STATUSES, ...ACTIVE_AGENT_SESSION_STATUSES'), '状态查询必须为两个相关子查询绑定完整参数');

assert.ok(drawer.includes('const AGENT_TASK_STATUS_META = {'), '历史抽屉必须定义会话任务状态文案');
assert.ok(drawer.includes("waiting_interaction: { label: '等待回答'"), '等待回答必须显示明确状态');
assert.ok(drawer.includes("running: { label: '正在执行'"), '运行中的任务必须显示明确状态');
assert.ok(drawer.includes('ariaLabel: `Agent 任务${meta.label}'), '状态标记必须提供可访问名称');
assert.ok(drawer.includes('<Icons.clock size={11} aria-hidden="true" />'), '状态标记必须使用现有时钟图标');

assert.ok(workspace.includes('refreshConversationList(accepted?.conversationId || null).catch(() => {});'), '任务创建后必须刷新会话列表状态');
assert.ok(workspace.includes('refreshConversationList().catch(() => {});'), '进入提问卡等待状态后必须刷新会话列表状态');
assert.ok(workspace.includes('window.setInterval(() => {'), '历史抽屉打开期间必须定时刷新后台任务状态');

console.log('conversation list agent status tests passed');
