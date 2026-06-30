const { ensureRuntime } = require('../../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../../lib/logger');
const { resolveLlmRuntimeConfig } = require('../../../../lib/llmConfigs');
const { runAgentLoop } = require('../../../../lib/agentLoop');
const { createSession, getSession, updateSessionStatus, validateSessionAccess } = require('../../../../lib/agentSession');
const { appendConversationMessage, ensureConversation, touchConversation } = require('../../../../lib/conversations');
const { parseAgentInputSources } = require('../../../../lib/agentInputSources');
const { updateInteraction } = require('../../../../lib/conversationInteractions');

function send(res, payload) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/agent/loop/start');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).end();
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const body = req.body || {};
    let sessionId = Number(body.session_id || 0) || null;
    let conversationId = Number(body.conversation_id || 0) || null;
    const webSearchEnabled = Boolean(body.web_search_enabled ?? body.webSearchEnabled);
    const searchProvider = String(body.search_provider || body.searchProvider || '').trim();
    const toolProfile = String(body.tool_profile || body.toolProfile || '').trim() === 'read_only' ? 'read_only' : 'default';

    if (sessionId) {
      const access = validateSessionAccess(sessionId, body.session_token);
      if (!access.valid) {
        send(res, { type: 'error', error: access.reason, code: access.reason });
        return res.end();
      }
      const session = getSession(sessionId);
      if (!['waiting_confirm', 'running'].includes(session.status)) {
        send(res, { type: 'error', error: 'SESSION_NOT_RESUMABLE', code: 'SESSION_NOT_RESUMABLE' });
        return res.end();
      }
      conversationId = session.conversation_id;
      send(res, { type: 'session_resumed', session_id: sessionId, conversation_id: conversationId });
    } else {
      const goal = String(body.goal || '').trim();
      if (!goal) {
        send(res, { type: 'error', error: 'goal is required', code: 'GOAL_REQUIRED' });
        return res.end();
      }
      const userInputText = String(body.user_query ?? body.userQuery ?? body.input_text ?? body.inputText ?? body.display_query ?? body.displayQuery ?? '').trim();
      const displayQuery = String(body.display_query ?? body.displayQuery ?? userInputText).trim();
      const conversation = ensureConversation({
        conversationId,
        kind: body.kind || 'agent',
        title: displayQuery || goal,
        fileId: body.active_file_id || null,
      });
      conversationId = conversation.id;
      // Only parse sources explicitly provided by the user this turn. Do not scan
      // the full Agent goal, because it contains workspace context and block snapshots.
      const parsedAttachments = await parseAgentInputSources({
        conversationId,
        attachments: body.attachments || [],
        userInputText,
        onEvent: (event) => send(res, { ...event, conversation_id: conversationId }),
      });
      appendConversationMessage({
        conversationId,
        role: 'user',
        content: displayQuery || userInputText || goal,
        meta: {
          agent_loop: true,
          agent_goal: goal,
          user_query: userInputText,
          attachments: Array.isArray(body.attachments) ? body.attachments.map((item) => ({
            name: item?.name || '',
            size: item?.size || 0,
            type: item?.type || '',
            source_kind: item?.source_kind || 'file',
          })) : [],
          parsed_attachments: parsedAttachments,
          authorized_paths: body.authorized_paths || [],
          search_knowledge_limit: body.search_knowledge_limit === undefined ? 5 : body.search_knowledge_limit,
          web_search_enabled: webSearchEnabled,
          search_provider: searchProvider || null,
          tool_profile: toolProfile,
        },
      });
      const created = createSession({
        goal,
        authorizedPaths: body.authorized_paths || [''],
        authorizedOps: body.authorized_ops || ['modify', 'create'],
        conversationId,
        softLimit: body.soft_limit || 15,
        hardLimit: body.hard_limit || 30,
        searchKnowledgeLimit: body.search_knowledge_limit === undefined ? 5 : body.search_knowledge_limit,
        webSearchEnabled,
        webSearchProvider: searchProvider,
        toolProfile,
      });
      sessionId = created.sessionId;
      send(res, { type: 'session_created', session_id: sessionId, session_token: created.token, conversation_id: conversationId });
    }

    let assistantText = '';
    const llmConfig = resolveLlmRuntimeConfig({ llmConfigId: body.llm_config_id || undefined });
    const loopResult = await runAgentLoop({
      sessionId,
      llmConfig,
      signal: controller.signal,
      approvalMode: body.approval_mode || body.approvalMode || 'auto_confirm',
      resumeInteractionId: Number(body.interaction_id || body.interactionId || 0) || null,
      onStream: (event) => {
        if (event.type === 'thinking' && event.text) assistantText += event.text;
        send(res, { ...event, session_id: sessionId, conversation_id: conversationId });
      },
    });

    const finalSession = getSession(sessionId);
    if (conversationId && finalSession.status === 'waiting_confirm' && loopResult?.reason === 'question_card_requested' && loopResult?.interaction?.id) {
      const assistantMessage = String(loopResult.interaction?.payload?.clarify_intro || '').trim()
        || '我先生成一张提问卡片，确认后继续执行。';
      const messageId = appendConversationMessage({
        conversationId,
        role: 'assistant',
        content: assistantMessage,
        meta: {
          agent_loop: true,
          session_id: sessionId,
          status: finalSession.status,
          answer_mode: 'clarify_needed',
          interaction_id: loopResult.interaction.id,
          interaction_kind: 'clarify_card',
          reason: loopResult.reason,
        },
      });
      updateInteraction(loopResult.interaction.id, { messageId });
      touchConversation(conversationId);
    }
    if (conversationId && ['completed', 'failed', 'cancelled'].includes(finalSession.status)) {
      appendConversationMessage({
        conversationId,
        role: 'assistant',
        content: assistantText.trim() || `Agent 任务已${finalSession.status === 'completed' ? '完成' : finalSession.status === 'cancelled' ? '取消' : '结束'}。`,
        meta: {
          agent_loop: true,
          session_id: sessionId,
          status: finalSession.status,
          operation_set_id: loopResult?.operation_set_id || null,
        },
      });
      touchConversation(conversationId);
    }
  } catch (error) {
    logger.error('agent.loop.start.failed', { error });
    try { if (req.body?.session_id) updateSessionStatus(req.body.session_id, 'failed'); } catch {}
    send(res, { type: 'error', error: error.message, code: error.code || 'AGENT_LOOP_FAILED' });
  }
  return res.end();
}
