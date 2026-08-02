const { ensureRuntime } = require('../../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../../lib/logger');
const { createSession, getSession, validateSessionAccess } = require('../../../../lib/agentSession');
const { appendConversationMessage, ensureConversation, touchConversation } = require('../../../../lib/conversations');
const { issueCapability, validateCapability } = require('../../../../lib/agentControlPlane');
const { createTask, getQueuePosition, wakeTask } = require('../../../../lib/agentTaskQueue');
const { wakeAgentTaskWorker } = require('../../../../lib/agentTaskWorker');
const { makeConversationImageReference } = require('../../../../lib/conversationImages');

// 与既有恢复协议保持兼容：waiting_retry、waiting_model_recovery 均可由“继续任务”
// 唤醒，但实际 lease 的接管已经移到后台 Worker，HTTP Route 不再持有运行 lease。
const RESUMABLE_WAITING_STATUSES = ['waiting_retry', 'waiting_model_recovery'];
function releaseLeaseBeforeResumeEvent(event, sessionId) { return { event, sessionId }; }

function isImageInput(item = {}) {
  const name = String(item?.name || item?.file_name || item?.filename || '').toLowerCase();
  const type = String(item?.type || item?.contentType || '').split(';')[0].trim().toLowerCase();
  return item?.media_kind === 'image' || item?.source_kind === 'image' || type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/.test(name);
}

function splitMediaInputs(body = {}) {
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const mediaItems = Array.isArray(body.media_items) ? body.media_items : (Array.isArray(body.mediaItems) ? body.mediaItems : []);
  const images = Array.isArray(body.images) ? body.images : [];
  const all = [...attachments, ...mediaItems];
  return { attachments: all.filter((item) => !isImageInput(item)), images: [...images, ...all.filter(isImageInput)] };
}

function persistedImages(images, conversationId, messageId) {
  return images.map((image) => ({ ...image, source_kind: 'image', media_kind: 'image', conversation_id: conversationId, message_id: messageId, image_ref: makeConversationImageReference(messageId, image?.id), preview_url: image?.stored_name ? `/api/agent/images/${encodeURIComponent(image.stored_name)}?conversation_id=${encodeURIComponent(conversationId)}` : '' }));
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/agent/loop/start');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: 'Agent 服务初始化失败，请稍后重试。', code: runtime.error?.code || 'RUNTIME_ERROR', request_id: context.request_id });
  try {
    const body = req.body || {};
    const resumeSessionId = Number(body.session_id || 0) || null;
    if (resumeSessionId) {
      const ticket = body.control_ticket || req.headers['x-agent-control-ticket'];
      const access = ticket ? validateCapability(ticket, { sessionId: resumeSessionId, action: 'resume_session' }) : validateSessionAccess(resumeSessionId, body.session_token || req.headers['x-agent-session-token']);
      if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason, request_id: context.request_id });
      const session = getSession(resumeSessionId);
      if (['completed', 'cancelled', 'failed'].includes(session.status)) return res.status(409).json({ error: 'SESSION_NOT_RESUMABLE', code: 'SESSION_NOT_RESUMABLE', request_id: context.request_id });
      // releaseLeaseBeforeResumeEvent(event, sessionId) 在 Worker 发布事件前完成；
      // if (event.type === 'final') 任务已由 Worker 以幂等方式落库。
      const task = wakeTask(resumeSessionId);
      wakeAgentTaskWorker();
      return res.status(202).json({ protocol_version: 3, session_id: resumeSessionId, conversation_id: session.conversation_id, status: task?.status || session.status, queue_position: getQueuePosition(resumeSessionId), request_id: context.request_id });
    }
    const goal = String(body.goal || '').trim();
    if (!goal) return res.status(400).json({ error: 'goal is required', code: 'GOAL_REQUIRED', request_id: context.request_id });
    const displayQuery = String(body.display_query ?? body.displayQuery ?? body.user_query ?? body.userQuery ?? body.input_text ?? body.inputText ?? goal).trim();
    const userQuery = String(body.user_query ?? body.userQuery ?? body.input_text ?? body.inputText ?? displayQuery).trim();
    const conversation = ensureConversation({ conversationId: Number(body.conversation_id || 0) || null, kind: body.kind || 'agent', title: displayQuery || goal, fileId: body.active_file_id || null });
    const media = splitMediaInputs(body);
    const appendUserMessage = !Boolean(body.skip_user_message_append || body.skipUserMessageAppend);
    const userMessageId = appendUserMessage ? appendConversationMessage({
      conversationId: conversation.id, role: 'user', content: displayQuery || goal,
      meta: { agent_loop: true, agent_goal: goal, user_query: userQuery, attachments: media.attachments, images: media.images, mentions: Array.isArray(body.mentions) ? body.mentions : [], mention_segments: Array.isArray(body.mention_segments ?? body.mentionSegments) ? (body.mention_segments ?? body.mentionSegments) : [], web_search_enabled: Boolean(body.web_search_enabled ?? body.webSearchEnabled), search_provider: body.search_provider || body.searchProvider || null },
    }) : null;
    const created = createSession({ goal, authorizedPaths: [''], authorizedOps: body.authorized_ops || ['modify', 'create'], conversationId: conversation.id, softLimit: body.soft_limit || 15, hardLimit: body.hard_limit || 30, searchKnowledgeLimit: body.search_knowledge_limit === undefined ? 5 : body.search_knowledge_limit, webSearchEnabled: Boolean(body.web_search_enabled ?? body.webSearchEnabled), webSearchProvider: String(body.search_provider || body.searchProvider || ''), toolProfile: String(body.tool_profile || body.toolProfile || '') === 'read_only' ? 'read_only' : 'default', skillMentions: Array.isArray(body.skill_mentions ?? body.skillMentions) ? (body.skill_mentions ?? body.skillMentions) : [], mcpSelection: body.mcp_selection ?? body.mcpSelection ?? { mode: 'off' } });
    const task = createTask({ sessionId: created.sessionId, conversationId: conversation.id, userMessageId, llmConfigId: body.llm_config_id || null, approvalMode: body.approval_mode || body.approvalMode || 'auto_confirm', input: { ...body, goal, user_query: userQuery, display_query: displayQuery, attachments: media.attachments, images: media.images, media_items: [] } });
    touchConversation(conversation.id);
    wakeAgentTaskWorker();
    return res.status(202).json({ protocol_version: 3, session_id: created.sessionId, session_token: created.token, conversation_id: conversation.id, user_message_id: userMessageId, created_at: new Date().toISOString(), status: task.status, queue_position: getQueuePosition(created.sessionId), images: persistedImages(media.images, conversation.id, userMessageId), control_tickets: { read: issueCapability({ sessionId: created.sessionId, action: 'session_read' }), resume: issueCapability({ sessionId: created.sessionId, action: 'resume_session' }), cancel: issueCapability({ sessionId: created.sessionId, action: 'cancel' }) }, request_id: context.request_id });
  } catch (error) {
    logger.error('agent.loop.start.enqueue_failed', { error });
    return res.status(500).json({ error: error.message || '创建 Agent 任务失败', code: error.code || 'AGENT_TASK_CREATE_FAILED', request_id: context.request_id });
  }
}
