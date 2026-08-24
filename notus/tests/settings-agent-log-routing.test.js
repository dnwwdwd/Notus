const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const settingsContext = read('contexts/SettingsDialogContext.js');
const settingsScreen = read('components/Settings/SettingsScreen.js');

assert.ok(settingsContext.includes("conversationId: options.conversationId || ''"), '设置弹窗必须保留调用方指定的会话 ID');
assert.ok(settingsContext.includes('conversationId={settings.conversationId}'), '设置弹窗必须传递会话 ID');
assert.ok(settingsScreen.includes("const Logs = ({ agentConversationId: suppliedAgentConversationId = '' })"), '日志面板必须接收指定会话 ID');
assert.ok(settingsScreen.includes("String(suppliedAgentConversationId || router.query.conversation_id || '').trim()"), '弹窗会话 ID 应优先于路由参数');
assert.ok(settingsScreen.includes('agentConversationId={conversationId}'), '设置弹窗必须把会话 ID 提供给日志面板');

console.log('settings agent log routing tests passed');
