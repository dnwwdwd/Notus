const { ensureRuntime } = require('../../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../../lib/logger');
const { createSession, getSession, getLatestRunEventId, validateSessionAccess } = require('../../../../lib/agentSession');
const { appendConversationMessage, ensureConversation, getConversationMessageById, touchConversation } = require('../../../../lib/conversations');
const { getResumeJob, issueCapability, validateCapability } = require('../../../../lib/agentControlPlane');
const { createTask, getQueuePosition, wakeTask, supersedePendingUserActionTasks } = require('../../../../lib/agentTaskQueue');
const { wakeAgentTaskWorker } = require('../../../../lib/agentTaskWorker');
const { makeConversationImageReference } = require('../../../../lib/conversationImages');
const { allowsLocalHttpMcp } = require('../../../../lib/directLoopbackRequest');
const { mergeAgentMedia } = require('../../../../lib/agentMedia');

// 与既有恢复协议保持兼容：模型重试和已确认的轮次上限均可由“继续任务”唤醒。
// 提问卡、资源确认、文件修改确认必须各自走确认接口，不能用通用会话票据绕过。
const RESUMABLE_WAITING_STATUSES = ['waiting_retry', 'waiting_model_recovery', 'waiting_limit_confirmation'];
function releaseLeaseBeforeResumeEvent(event, sessionId) { return { event, sessionId }; }
function splitMediaInputs(body = {}) {
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const mediaItems = Array.isArray(body.media_items) ? body.media_items : (Array.isArray(body.mediaItems) ? body.mediaItems : []);
  const images = Array.isArray(body.images) ? body.images : [];
  return mergeAgentMedia({ attachments, mediaItems, images });
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
      const subscribeOnly = Boolean(body.subscribe_only || body.subscribeOnly);
      const readTicket = body.read_ticket || body.readTicket || req.headers['x-agent-read-ticket'];
      const controlTicket = body.control_ticket || req.headers['x-agent-control-ticket'];
      const ticket = subscribeOnly ? (readTicket || controlTicket) : controlTicket;
      const access = ticket
        ? validateCapability(ticket, {
          sessionId: resumeSessionId,
          action: subscribeOnly && readTicket ? 'session_read' : 'resume_session',
        })
        : validateSessionAccess(resumeSessionId, body.session_token || req.headers['x-agent-session-token']);
      if (!access.valid) return res.status(403).json({ error: access.reason, code: access.reason, request_id: context.request_id });
      const session = getSession(resumeSessionId);
      if (!subscribeOnly && ['completed', 'cancelled', 'failed'].includes(session.status)) return res.status(409).json({ error: 'SESSION_NOT_RESUMABLE', code: 'SESSION_NOT_RESUMABLE', request_id: context.request_id });
      // releaseLeaseBeforeResumeEvent(event, sessionId) 在 Worker 发布事件前完成；
      // if (event.type === 'final') 任务已由 Worker 以幂等方式落库。
      const eventCursor = getLatestRunEventId(resumeSessionId);
      if (subscribeOnly) {
        // 页面刷新后提交卡片只需要重新接收 SSE。任务已由回答接口唤醒；这里绝不
        // 调队列，避免续跑已经停在下一张提问卡片时被错误地再次唤醒。
        return res.status(202).json({
          protocol_version: 3,
          session_id: resumeSessionId,
          conversation_id: session.conversation_id,
          status: session.status,
          queue_position: getQueuePosition(resumeSessionId),
          event_cursor: eventCursor,
          subscribe_only: true,
          request_id: context.request_id,
        });
      }

      const resumeJobId = String(body.resume_job_id || body.resumeJobId || '').trim();
      let resumeJob = null;
      if (resumeJobId) {
        resumeJob = getResumeJob(resumeJobId);
        if (!resumeJob || Number(resumeJob.session_id) !== resumeSessionId) {
          return res.status(404).json({ error: 'RESUME_JOB_NOT_FOUND', code: 'RESUME_JOB_NOT_FOUND', request_id: context.request_id });
        }
        const resumeCapability = validateCapability(body.resume_ticket || body.resumeTicket || req.headers['x-agent-resume-ticket'], {
          sessionId: resumeSessionId,
          interactionId: resumeJob.interaction_id,
          resumeJobId: resumeJob.id,
          action: 'resume',
        }, { consume: true });
        if (!resumeCapability.valid) {
          return res.status(403).json({ error: resumeCapability.reason, code: resumeCapability.reason, request_id: context.request_id });
        }
        // 同一 job 已被别的连接接管时只返回当前状态，不再把 session 重新入队。
        if (resumeCapability.consumed || resumeJob.status !== 'queued') {
          return res.status(202).json({
            protocol_version: 3,
            session_id: resumeSessionId,
            conversation_id: session.conversation_id,
            status: session.status,
            queue_position: getQueuePosition(resumeSessionId),
            event_cursor: eventCursor,
            idempotent_replay: true,
            request_id: context.request_id,
          });
        }
        if (session.status !== 'queued_resume') {
          return res.status(409).json({ error: 'RESUME_JOB_STATE_CONFLICT', code: 'RESUME_JOB_STATE_CONFLICT', request_id: context.request_id });
        }
      } else if (!RESUMABLE_WAITING_STATUSES.includes(session.status)) {
        // 普通会话恢复票据只能处理模型重试等待态。提问卡、资源确认和文件
        // 修改确认都必须走各自的确认接口；否则持有会话票据即可跳过用户决定。
        return res.status(409).json({
          error: '当前任务需要先完成确认，不能直接继续执行',
          code: 'INTERACTION_RESPONSE_REQUIRED',
          request_id: context.request_id,
        });
      }

      const task = wakeTask(resumeSessionId, {
        llmConfigId: body.llm_config_id || null,
        ...(resumeJob ? { resumeJobId: resumeJob.id } : {}),
      });
      wakeAgentTaskWorker();
      return res.status(202).json({ protocol_version: 3, session_id: resumeSessionId, conversation_id: session.conversation_id, status: task?.status || session.status, queue_position: getQueuePosition(resumeSessionId), event_cursor: eventCursor, request_id: context.request_id });
    }
    const goal = String(body.goal || '').trim();
    if (!goal) return res.status(400).json({ error: 'goal is required', code: 'GOAL_REQUIRED', request_id: context.request_id });
    const displayQuery = String(body.display_query ?? body.displayQuery ?? body.user_query ?? body.userQuery ?? body.input_text ?? body.inputText ?? goal).trim();
    const userQuery = String(body.user_query ?? body.userQuery ?? body.input_text ?? body.inputText ?? displayQuery).trim();
    const conversation = ensureConversation({ conversationId: Number(body.conversation_id || 0) || null, kind: body.kind || 'agent', title: displayQuery || goal, fileId: body.active_file_id || null });
    // “继续任务/重试”会恢复原 session；用户在输入框发起新 prompt 则明确放弃该对话
    // 中等待决定的模型失败任务，避免 FIFO 永久停在等待态。
    const supersededSessionIds = supersedePendingUserActionTasks(conversation.id);
    const media = splitMediaInputs(body);
    const requestedMcpSelection = body.mcp_selection ?? body.mcpSelection ?? { mode: 'off' };
    const appendUserMessage = !Boolean(body.skip_user_message_append || body.skipUserMessageAppend);
    const existingUserMessageId = Number(body.existing_user_message_id || body.existingUserMessageId || 0) || null;
    const existingUserMessage = existingUserMessageId ? getConversationMessageById(existingUserMessageId) : null;
    const reusableUserMessageId = existingUserMessage
      && Number(existingUserMessage.conversation_id) === Number(conversation.id)
      && existingUserMessage.role === 'user'
      ? existingUserMessage.id
      : null;
    const userMessageId = appendUserMessage ? appendConversationMessage({
      conversationId: conversation.id, role: 'user', content: displayQuery || goal,
      meta: { agent_loop: true, agent_goal: goal, user_query: userQuery, attachments: media.attachments, images: media.images, media_items: media.media_items, mentions: Array.isArray(body.mentions) ? body.mentions : [], mention_segments: Array.isArray(body.mention_segments ?? body.mentionSegments) ? (body.mention_segments ?? body.mentionSegments) : [], web_search_enabled: Boolean(body.web_search_enabled ?? body.webSearchEnabled), search_provider: body.search_provider || body.searchProvider || null, mcp_selection: requestedMcpSelection, hide_user_message_bubble: Boolean(body.hide_user_message_bubble ?? body.hideUserMessageBubble) },
    }) : reusableUserMessageId;
    const created = createSession({ goal, authorizedPaths: [''], authorizedOps: body.authorized_ops || ['modify', 'create'], conversationId: conversation.id, softLimit: body.soft_limit || 15, hardLimit: body.hard_limit || 30, searchKnowledgeLimit: body.search_knowledge_limit === undefined ? 5 : body.search_knowledge_limit, webSearchEnabled: Boolean(body.web_search_enabled ?? body.webSearchEnabled), webSearchProvider: String(body.search_provider || body.searchProvider || ''), toolProfile: String(body.tool_profile || body.toolProfile || '') === 'read_only' ? 'read_only' : 'default', skillMentions: Array.isArray(body.skill_mentions ?? body.skillMentions) ? (body.skill_mentions ?? body.skillMentions) : [], mcpSelection: requestedMcpSelection, mcpSessionPermissions: { allow_local_http: allowsLocalHttpMcp(req) } });
    const task = createTask({
      sessionId: created.sessionId,
      conversationId: conversation.id,
      userMessageId: userMessageId,
      llmConfigId: body.llm_config_id || null,
      approvalMode: body.approval_mode || body.approvalMode || 'auto_confirm',
      input: { ...body, goal, user_query: userQuery, display_query: displayQuery, attachments: media.attachments, images: media.images, media_items: media.media_items },
    });
    touchConversation(conversation.id);
    wakeAgentTaskWorker();
    return res.status(202).json({ protocol_version: 3, session_id: created.sessionId, session_token: created.token, conversation_id: conversation.id, user_message_id: userMessageId, created_at: new Date().toISOString(), status: task.status, queue_position: getQueuePosition(created.sessionId), superseded_session_ids: supersededSessionIds, images: persistedImages(media.images, conversation.id, userMessageId), control_tickets: { read: issueCapability({ sessionId: created.sessionId, action: 'session_read' }), resume: issueCapability({ sessionId: created.sessionId, action: 'resume_session' }), cancel: issueCapability({ sessionId: created.sessionId, action: 'cancel' }) }, request_id: context.request_id });
  } catch (error) {
    logger.error('agent.loop.start.enqueue_failed', { error });
    return res.status(500).json({ error: error.message || '创建 Agent 任务失败', code: error.code || 'AGENT_TASK_CREATE_FAILED', request_id: context.request_id });
  }
}
