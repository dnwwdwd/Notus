const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const workspace = read('components/AgentWorkspace/AgentWorkspace.js');
const fileWorkspace = read('components/AgentWorkspace/FileAgentWorkspace.js');
const controller = read('hooks/useAgentLoopController.js');
const startRoute = read('pages/api/agent/loop/start.js');
const conversations = read('lib/conversations.js');

assert.ok(workspace.includes('function getClipboardFiles(clipboard)'), '剪贴板图片应回退读取 DataTransfer.items');
assert.ok(workspace.includes("IMAGE_MIME_TYPES.has(String(file?.type || '').trim().toLowerCase())"), '图片分类应兼容 MIME 类型');
assert.ok(workspace.includes('const pastedFiles = getClipboardFiles(clipboard);'), '粘贴流程必须使用兼容后的文件列表');

assert.ok(startRoute.includes('const userMessageId = appendUserMessage ? appendConversationMessage({'), '新建 Agent 消息必须保存真实数据库 ID');
assert.ok(startRoute.includes('user_message_id: userMessageId,'), 'session_created 必须回传真实用户消息 ID');
assert.ok(controller.includes("id: Number(event.user_message_id || event.userMessageId || 0) || optimisticUserMessageId || makeMessageId('agent-loop-user')"), '前端应优先使用服务端用户消息 ID，并允许发送前先渲染临时消息');
assert.ok(controller.includes('conversationId: Number(event.conversation_id || event.conversationId || 0) || null,'), '前端消息必须带会话归属');

const truncateIndex = workspace.indexOf('const response = await fetch(`/api/conversations/${conversationId}/truncate`');
const rewriteIndex = workspace.indexOf('setRewrittenMessages((prev) => ({ ...prev, [sourceKey]: nextContent }));');
assert.ok(truncateIndex > -1 && rewriteIndex > truncateIndex, '改写前必须先完成服务端截断，不能只在界面隐藏旧消息');
assert.ok(
  workspace.includes("const replacesConversation = isRewrite || options.reason === 'retry';"),
  '重试也必须从原用户消息截断并覆盖后续消息，不能另追加一轮相同对话'
);
assert.ok(
  workspace.includes('if (replacesConversation) {')
    && workspace.includes('skipUserMessageAppend: replacesConversation && Number(sourceMessage?.id || 0) > 0')
    && workspace.includes('rewriteUserMessageId: replacesConversation && Number(sourceMessage?.id || 0) > 0 ? Number(sourceMessage.id) : null,'),
  '重试必须复用被截断的真实用户消息，而不是新增相同用户消息'
);
assert.ok(workspace.includes('当前消息尚未完成服务端保存，无法改写。请稍后重试。'), '未持久化消息不得绕过服务端截断');
assert.ok(
  workspace.includes("mentionSegments: isRewrite ? [{ type: 'text', text: nextContent }] : (Array.isArray(sourceMessage?.mentionSegments) ? sourceMessage.mentionSegments : []),"),
  '改写后不能把旧消息的 Mention 文本当作新的 Agent 目标'
);
assert.ok(
  workspace.includes('rewriteUserMessageId: replacesConversation && Number(sourceMessage?.id || 0) > 0 ? Number(sourceMessage.id) : null,'),
  '改写或重试任务必须携带被截断的真实用户消息 ID'
);
assert.ok(
  fileWorkspace.includes('rewriteUserMessageId: Number(options.rewriteUserMessageId || 0) || null,'),
  '文件工作区组装任务时不能丢失改写用户消息关联'
);
assert.ok(
  controller.includes('existing_user_message_id: input?.rewriteUserMessageId || undefined,'),
  '控制器必须把改写用户消息关联交给启动路由'
);
assert.ok(
  startRoute.includes('getConversationMessageById(existingUserMessageId)'),
  '启动路由必须校验并复用已改写的用户消息'
);
assert.ok(
  startRoute.includes('userMessageId: userMessageId,'),
  '改写任务队列必须把真实用户消息 ID 交给 Worker 和时间线'
);
assert.ok(
  workspace.includes('.sort((left, right) => Number(right?.sessionId || 0) - Number(left?.sessionId || 0))[0] || null;'),
  '同一条用户消息被再次改写时，工具链必须展示最新 session'
);
assert.ok(
  workspace.includes('onConversationRewritten?.(payload);'),
  '截断成功后必须通知工作区清理旧 session 的前端状态'
);
assert.ok(
  conversations.includes('cancelled_session_ids: cancelledSessionIds'),
  '截断接口必须返回实际取消的 session，供前端精确清理旧记录'
);
assert.ok(
  fileWorkspace.includes('agentLoop.discardAgentSessions([...cancelledSessionIds]);') && fileWorkspace.includes('setLiveSessionTimelines((previous) => Object.fromEntries'),
  '改写后必须仅断开被取消 session 的 SSE 并清理其工具时间线，不能让已删除 prompt 的记录回流'
);

assert.ok(conversations.includes('DELETE FROM messages\n      WHERE conversation_id = ? AND id > ?'), '改写必须删除锚点后的全部消息');
assert.ok(conversations.includes('nextMeta.user_query = nextContent;'), '改写必须同步更新用户输入元数据');
assert.ok(conversations.includes('nextMeta.agent_goal = `${previousGoal.slice(0, -previousUserQuery.length)}${nextContent}`;'), '改写必须同步更新 Agent 目标，避免历史筛选继续使用旧 prompt');

console.log('agent message rewrite context tests passed');
