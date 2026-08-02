const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const workspace = read('components/AgentWorkspace/AgentWorkspace.js');
const controller = read('hooks/useAgentLoopController.js');
const startRoute = read('pages/api/agent/loop/start.js');
const conversations = read('lib/conversations.js');

assert.ok(workspace.includes('function getClipboardFiles(clipboard)'), '剪贴板图片应回退读取 DataTransfer.items');
assert.ok(workspace.includes("IMAGE_MIME_TYPES.has(String(file?.type || '').trim().toLowerCase())"), '图片分类应兼容 MIME 类型');
assert.ok(workspace.includes('const pastedFiles = getClipboardFiles(clipboard);'), '粘贴流程必须使用兼容后的文件列表');

assert.ok(startRoute.includes('const userMessageId = appendUserMessage ? appendConversationMessage({'), '新建 Agent 消息必须保存真实数据库 ID');
assert.ok(startRoute.includes('user_message_id: userMessageId,'), 'session_created 必须回传真实用户消息 ID');
assert.ok(controller.includes("id: Number(event.user_message_id || event.userMessageId || 0) || makeMessageId('agent-loop-user')"), '前端应优先使用服务端用户消息 ID');
assert.ok(controller.includes('conversationId: Number(event.conversation_id || event.conversationId || 0) || null,'), '前端消息必须带会话归属');

const truncateIndex = workspace.indexOf('const response = await fetch(`/api/conversations/${conversationId}/truncate`');
const rewriteIndex = workspace.indexOf('setRewrittenMessages((prev) => ({ ...prev, [sourceKey]: nextContent }));');
assert.ok(truncateIndex > -1 && rewriteIndex > truncateIndex, '改写前必须先完成服务端截断，不能只在界面隐藏旧消息');
assert.ok(workspace.includes('当前消息尚未完成服务端保存，无法改写。请稍后重试。'), '未持久化消息不得绕过服务端截断');

assert.ok(conversations.includes('DELETE FROM messages\n      WHERE conversation_id = ? AND id > ?'), '改写必须删除锚点后的全部消息');
assert.ok(conversations.includes('nextMeta.user_query = nextContent;'), '改写必须同步更新用户输入元数据');
assert.ok(conversations.includes('nextMeta.agent_goal = `${previousGoal.slice(0, -previousUserQuery.length)}${nextContent}`;'), '改写必须同步更新 Agent 目标，避免历史筛选继续使用旧 prompt');

console.log('agent message rewrite context tests passed');
