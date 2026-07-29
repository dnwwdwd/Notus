const { ensureRuntime } = require('../../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../../lib/logger');
const { resolveLlmRuntimeConfig } = require('../../../../lib/llmConfigs');
const { runAgentLoop, buildWriteTargetPreflight } = require('../../../../lib/agentLoop');
const { createSession, getSession, saveMessagesCheckpoint, updateSessionStatus, validateSessionAccess } = require('../../../../lib/agentSession');
const { appendConversationMessage, ensureConversation, touchConversation } = require('../../../../lib/conversations');
const { parseAgentInputSources } = require('../../../../lib/agentInputSources');
const { loadAttachments } = require('../../../../lib/parsedAttachmentStore');
const { recognizeConversationImages } = require('../../../../lib/imageRecognition');
const { executeAskQuestionCard } = require('../../../../lib/agentTools');
const {
  buildResearchSummary,
  buildWriteSummary,
  correctConflictingSourceClaims,
  registerParsedInputSources,
} = require('../../../../lib/agentResearch');
const { updateInteraction } = require('../../../../lib/conversationInteractions');
const {
  assertAttachmentLimits,
  assertImageContextSize,
  assertImageLimits,
  getImageInputBlocks,
  MAX_ANTHROPIC_IMAGE_CONTEXT_BYTES,
  makeConversationImageReference,
} = require('../../../../lib/conversationImages');

function send(res, payload) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function isImageInput(item = {}) {
  const name = String(item?.name || item?.file_name || item?.filename || '').toLowerCase();
  const type = String(item?.type || item?.contentType || '').split(';')[0].trim().toLowerCase();
  const extension = String(item?.extension || name.match(/(\.[^.]+)$/)?.[1] || '').toLowerCase();
  return item?.media_kind === 'image'
    || item?.source_kind === 'image'
    || type.startsWith('image/')
    || ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension);
}

function splitMediaInputs(body = {}) {
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  const rawImages = Array.isArray(body.images) ? body.images : [];
  const rawMediaItems = Array.isArray(body.media_items)
    ? body.media_items
    : (Array.isArray(body.mediaItems) ? body.mediaItems : []);
  const mediaCandidates = [...rawAttachments, ...rawMediaItems];
  const deduplicate = (items = []) => items.filter((item, index, list) => {
    const key = String(item?.id || item?.stored_name || item?.storedName || `${item?.name || ''}:${index}`);
    return list.findIndex((candidate, candidateIndex) => {
      const candidateKey = String(candidate?.id || candidate?.stored_name || candidate?.storedName || `${candidate?.name || ''}:${candidateIndex}`);
      return candidateKey === key;
    }) === index;
  });
  return {
    attachments: deduplicate(mediaCandidates.filter((item) => !isImageInput(item))),
    images: deduplicate([...rawImages, ...mediaCandidates.filter(isImageInput)]),
  };
}

function buildPersistedImages(images = [], conversationId, messageId) {
  const normalizedConversationId = Number(conversationId) || null;
  const normalizedMessageId = Number(messageId) || null;
  return (Array.isArray(images) ? images : []).map((image) => ({
    ...image,
    source_kind: 'image',
    media_kind: 'image',
    conversation_id: normalizedConversationId,
    message_id: normalizedMessageId,
    image_ref: makeConversationImageReference(normalizedMessageId, image?.id),
    preview_url: normalizedConversationId && image?.stored_name
      ? `/api/agent/images/${encodeURIComponent(image.stored_name)}?conversation_id=${encodeURIComponent(normalizedConversationId)}`
      : '',
  }));
}

function buildWriteTargetQuestion(preflight = {}) {
  const candidates = Array.isArray(preflight.candidates) ? preflight.candidates.slice(0, 3) : [];
  return {
    title: '确认写作目标',
    intro: '当前对话里有近期文章候选。请确认这轮是修改哪篇文章，还是新建一篇。',
    submit_label: '确认后继续',
    questions: [{
      id: 'write_target',
      label: '这轮要处理哪篇文章？',
      type: 'single_select',
      allow_custom: false,
      options: [
        ...candidates.map((candidate, index) => ({
          id: `modify_candidate_${index + 1}`,
          label: `修改《${candidate.title || candidate.filePath}》`,
          description: `${candidate.filePath} · 上次状态：${candidate.status}`,
          answer_value: candidate.filePath,
        })),
        {
          id: 'new_article',
          label: '新建一篇文章',
          description: '保留现有文章，另建新的 Markdown 文件。',
          answer_value: '__new_article__',
        },
      ],
    }],
  };
}

export default async function handler(req, res) {
  const context = createRequestContext(req, res, '/api/agent/loop/start');
  const logger = createLogger(context);
  if (req.method !== 'POST') return res.status(405).end();
  let runtime;
  try {
    runtime = ensureRuntime();
  } catch (error) {
    logger.error('agent.loop.start.runtime_failed', { error });
    return res.status(500).json({
      error: 'Agent 服务初始化失败，请稍后重试。',
      code: error?.code || 'RUNTIME_ERROR',
      request_id: context.request_id,
    });
  }
  if (!runtime.ok) {
    logger.error('agent.loop.start.runtime_unavailable', { error: runtime.error });
    return res.status(500).json({
      error: 'Agent 服务初始化失败，请稍后重试。',
      code: runtime.error?.code || 'RUNTIME_ERROR',
      request_id: context.request_id,
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  let initialImages = [];
  let currentImageRecognition = null;
  let llmConfig = null;
  let activeSessionId = null;
  let userMessageId = null;
  let userMessageCreatedAt = null;

  try {
    const body = req.body || {};
    let sessionId = Number(body.session_id || 0) || null;
    let conversationId = Number(body.conversation_id || 0) || null;
    const webSearchEnabled = Boolean(body.web_search_enabled ?? body.webSearchEnabled);
    const searchProvider = String(body.search_provider || body.searchProvider || '').trim();
    const toolProfile = String(body.tool_profile || body.toolProfile || '').trim() === 'read_only' ? 'read_only' : 'default';
    const skillMentions = Array.isArray(body.skill_mentions ?? body.skillMentions) ? (body.skill_mentions ?? body.skillMentions).map(String).filter(Boolean) : [];
    const mcpSelection = body.mcp_selection ?? body.mcpSelection ?? { mode: 'off' };

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
      activeSessionId = sessionId;
      conversationId = session.conversation_id;
      send(res, { type: 'session_resumed', session_id: sessionId, conversation_id: conversationId });
    } else {
      const rawGoal = String(body.goal || '').trim();
      if (!rawGoal) {
        send(res, { type: 'error', error: 'goal is required', code: 'GOAL_REQUIRED' });
        return res.end();
      }
      const appendUserMessage = !Boolean(body.skip_user_message_append || body.skipUserMessageAppend);
      const userInputText = String(body.user_query ?? body.userQuery ?? body.input_text ?? body.inputText ?? body.display_query ?? body.displayQuery ?? '').trim();
      const displayQuery = String(body.display_query ?? body.displayQuery ?? userInputText).trim();
      const mentions = Array.isArray(body.mentions) ? body.mentions : [];
      const mentionSegments = Array.isArray(body.mention_segments ?? body.mentionSegments) ? (body.mention_segments ?? body.mentionSegments) : [];
      const conversation = ensureConversation({
        conversationId,
        kind: body.kind || 'agent',
        title: displayQuery || rawGoal,
        fileId: body.active_file_id || null,
      });
      conversationId = conversation.id;
      const goal = rawGoal;
      // 服务端再次分流，防止旧客户端或非标准调用把图片塞进 attachments，
      // 进而触发文档解析并让模型收不到视觉内容。
      const mediaInputs = splitMediaInputs(body);
      const attachments = assertAttachmentLimits(conversationId, mediaInputs.attachments);
      const images = assertImageLimits(conversationId, mediaInputs.images);
      llmConfig = resolveLlmRuntimeConfig({ llmConfigId: body.llm_config_id || undefined });
      if (String(llmConfig.llmApiProtocol || '').trim().toLowerCase() === 'anthropic') {
        assertImageContextSize(images, MAX_ANTHROPIC_IMAGE_CONTEXT_BYTES);
      }
      // 先写入用户消息并建立 session，再做可能耗时的附件解析和图片识别。
      // 这样前端可立即回显本轮 prompt 与受控图片预览，不会把用户消息的显示
      // 错误地绑定到视觉模型的返回速度。
      let parsedAttachments = [];
      if (appendUserMessage) {
        const messageId = appendConversationMessage({
          conversationId,
          role: 'user',
          content: displayQuery || userInputText || rawGoal,
          meta: {
            agent_loop: true,
            agent_goal: goal,
            user_query: userInputText,
            attachments,
            images,
            mentions,
            mention_segments: mentionSegments,
            parsed_attachments: parsedAttachments,
            authorized_paths: body.authorized_paths || [],
            search_knowledge_limit: body.search_knowledge_limit === undefined ? 5 : body.search_knowledge_limit,
            web_search_enabled: webSearchEnabled,
            search_provider: searchProvider || null,
            tool_profile: toolProfile,
            skill_mentions: skillMentions,
            mcp_selection: mcpSelection,
          },
        });
        userMessageId = messageId;
        userMessageCreatedAt = new Date().toISOString();
        initialImages = getImageInputBlocks(images, { messageId });
      } else {
        initialImages = getImageInputBlocks(images);
      }
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
        skillMentions,
        mcpSelection,
      });
      sessionId = created.sessionId;
      activeSessionId = sessionId;
      send(res, {
        type: 'session_created',
        session_id: sessionId,
        session_token: created.token,
        conversation_id: conversationId,
        user_message_id: userMessageId,
        created_at: userMessageCreatedAt,
        images: buildPersistedImages(images, conversationId, userMessageId),
      });

      // Only parse sources explicitly provided by the user this turn. Do not scan
      // the full Agent goal, because it contains workspace context and block snapshots.
      parsedAttachments = await parseAgentInputSources({
        conversationId,
        attachments,
        userInputText,
        onEvent: (event) => send(res, { ...event, conversation_id: conversationId }),
      });
      registerParsedInputSources({
        sessionId,
        conversationId,
        parsedAttachments,
        attachments: loadAttachments(conversationId),
      });
      if (appendUserMessage && images.length > 0) {
        try {
          const recognition = await recognizeConversationImages({
            conversationId,
            messageId: userMessageId,
            images,
            llmConfig,
          });
          currentImageRecognition = recognition;
          send(res, {
            type: 'image_recognition_done',
            conversation_id: conversationId,
            message_id: userMessageId,
            image_count: images.length,
            source: recognition?.source || '',
          });
          // 识别结果已落库并会按附件上下文注入主 Agent；避免把同一张图的
          // Base64 再发送一次，后续历史轮次也只使用这份持久化文字上下文。
          initialImages = [];
        } catch (error) {
          logger.warn('agent.images.recognition.failed', { conversation_id: conversationId, message_id: userMessageId, error });
          send(res, {
            type: 'image_recognition_done',
            conversation_id: conversationId,
            message_id: userMessageId,
            image_count: images.length,
            status: 'error',
            error: error.code || 'IMAGE_RECOGNITION_FAILED',
          });
        }
      }

      const freshSession = getSession(sessionId);
      const preflight = buildWriteTargetPreflight(freshSession);
      if (preflight) {
        const card = executeAskQuestionCard(buildWriteTargetQuestion(preflight), sessionId);
        if (!card?.error && card.interaction?.id) {
          const preflightInteraction = updateInteraction(card.interaction.id, {
            reasonCode: 'write_target_ambiguous',
            payload: {
              ...card.interaction.payload,
              clarify_reason: 'write_target_ambiguous',
              write_target_preflight: true,
              write_target_candidates: preflight.candidates,
            },
          });
          const toolUseId = `preflight-write-target-${sessionId}`;
          saveMessagesCheckpoint(sessionId, [], [{
            type: 'tool_use',
            id: toolUseId,
            name: 'ask_question_card',
            input: { preflight: 'write_target' },
          }], toolUseId);
          updateSessionStatus(sessionId, 'waiting_confirm');
          const assistantMessage = String(preflightInteraction?.payload?.clarify_intro || '').trim() || '请先确认这轮的写作目标。';
          const messageId = appendConversationMessage({
            conversationId,
            role: 'assistant',
            content: assistantMessage,
            meta: {
              agent_loop: true,
              session_id: sessionId,
              status: 'waiting_confirm',
              answer_mode: 'clarify_needed',
              interaction_id: preflightInteraction.id,
              interaction_kind: preflightInteraction.kind || 'clarify_card',
              reason: 'write_target_ambiguous',
              research_summary: buildResearchSummary(sessionId),
              write_summary: buildWriteSummary(sessionId),
            },
          });
          updateInteraction(preflightInteraction.id, { messageId });
          touchConversation(conversationId);
          send(res, { type: 'assistant_text_replace', text: assistantMessage, session_id: sessionId, conversation_id: conversationId });
          send(res, {
            type: 'interaction_request',
            session_id: sessionId,
            conversation_id: conversationId,
            interaction: preflightInteraction,
            reason: 'question_card_requested',
          });
          send(res, {
            type: 'loop_done',
            session_id: sessionId,
            conversation_id: conversationId,
            reason: 'question_card_requested',
            interaction_id: preflightInteraction.id,
            research_summary: buildResearchSummary(sessionId),
            write_summary: buildWriteSummary(sessionId),
          });
          return res.end();
        }
      }
    }

    let assistantText = '';
    llmConfig = llmConfig || resolveLlmRuntimeConfig({ llmConfigId: body.llm_config_id || undefined });
    const loopResult = await runAgentLoop({
      sessionId,
      llmConfig,
      signal: controller.signal,
      approvalMode: body.approval_mode || body.approvalMode || 'auto_confirm',
      resumeInteractionId: Number(body.interaction_id || body.interactionId || 0) || null,
      initialImages,
      currentImageRecognition,
      onStream: (event) => {
        if (event.type === 'thinking' && event.text) assistantText += event.text;
        if (event.type === 'loop_done') {
          const correction = correctConflictingSourceClaims(assistantText, sessionId);
          if (correction.corrected) {
            assistantText = correction.text;
            send(res, { type: 'assistant_text_replace', text: assistantText, session_id: sessionId, conversation_id: conversationId });
          }
          event = {
            ...event,
            research_summary: buildResearchSummary(sessionId),
            write_summary: buildWriteSummary(sessionId),
          };
        }
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
          interaction_kind: loopResult.interaction.kind || 'clarify_card',
          reason: loopResult.reason,
          research_summary: buildResearchSummary(sessionId),
          write_summary: buildWriteSummary(sessionId),
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
          research_summary: buildResearchSummary(sessionId),
          write_summary: buildWriteSummary(sessionId),
        },
      });
      touchConversation(conversationId);
    }
  } catch (error) {
    logger.error('agent.loop.start.failed', { error });
    try { if (activeSessionId) updateSessionStatus(activeSessionId, 'failed'); } catch {}
    send(res, { type: 'error', error: error.message, code: error.code || 'AGENT_LOOP_FAILED' });
  }
  return res.end();
}
