const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const logList = fs.readFileSync(path.join(root, 'components/AgentLoop/AgentLoopLogList.js'), 'utf8');
const sessionsRoute = fs.readFileSync(path.join(root, 'pages/api/agent/sessions/index.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'components/Settings/SettingsScreen.js'), 'utf8');

assert.ok(logList.includes("log.tool_name !== '__run_metadata__'"), '运行配置元数据不能伪装成工具调用显示。');
assert.ok(logList.includes("import { formatFullTimestamp, parseMessageTimestamp } from '../../utils/messageTimestamps';"), '日志页必须复用 SQLite UTC 时间解析。');
assert.ok(logList.includes('已运行 ${elapsed}'), '运行中的日志必须显示累计运行时长。');
assert.ok(logList.includes('正在等待模型响应'), '运行中的日志必须说明正在等待模型响应。');
assert.ok(logList.includes('正在执行工具'), '运行中的日志必须说明工具执行阶段。');
assert.ok(sessionsRoute.includes('task: getTaskBySession(session.id)'), '日志接口必须返回后台任务的开始与结束时间。');
assert.ok(sessionsRoute.includes('execution_segments: listExecutionSegments(session.id)'), '日志接口必须返回当前执行段和模型请求窗口。');
assert.ok(settings.includes("import { formatFullTimestamp } from '../../utils/messageTimestamps';"), '设置页时间必须复用统一 UTC 格式化方法。');

console.log('agent loop log list tests passed');
