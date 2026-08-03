const { completeToolChat } = require('./llm');
const { getEffectiveConfig } = require('./config');
const { getStyleContext } = require('./style');
const { buildInitialUserMessage, buildLoopSystemPrompt } = require('./agentLoopPrompt');
const { renderAgentLoopPrompt } = require('./prompt/agent-loop/render');
const { getConversationHistory } = require('./conversations');
const { loadAttachments, formatAttachmentsForPrompt } = require('./parsedAttachmentStore');
const { formatWebSearchContextsForPrompt } = require('./webSearchContextStore');
const {
  clearMessagesCheckpoint,
  detectDeadloop,
  getSession,
  loadMessagesCheckpoint,
  recordRunEvent,
  logToolCall,
  recordToolFail,
  resetToolFail,
  saveMessagesCheckpoint,
  setSessionRuntimeVersions,
  summarizeToolResult,
  updateSessionLoopCount,
  updateSessionStatus,
} = require('./agentSession');
const { broadcast: broadcastRunEvent } = require('./agentRunEventBus');
const { applyPreviewWithConflictCheck, buildToolDefinitions, executeToolSafely, summarizeInput, validateToolUseBlock } = require('./agentTools');
const { estimateChatRequestTokens, trimTextToTokenBudget } = require('./llmBudget');
const { getSessionUsage, isCancellationRequested, issueCapability, recordRunUsage } = require('./agentControlPlane');
const { sha256 } = require('./files');
const {
  buildInteractionAnswerSummary,
  getInteractionById,
} = require('./conversationInteractions');
const { eligibleSkillSummaries } = require('./skills');
const { prepareMcpTools } = require('./mcp');
const { buildConversationResourceContext } = require('./agentResourceContext');
const { buildGlobalAgentContext } = require('./globalAgentFiles');
const {
  formatResearchReceiptsForPrompt,
  recordToolReceipt,
  recordWriteReceipt,
} = require('./agentResearch');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function buildCompactSummary(parsed) {
  if (parsed?.error) return `失败：${parsed.error}`;
  if (Array.isArray(parsed?.results)) return `检索到 ${parsed.results.length} 条结果`;
  if (parsed?.content) return `读取 ${String(parsed.content).length} 字`;
  if (parsed?.operation_set_id) return `生成预览 ${parsed.operation_set_id}`;
  if (parsed?.interaction_id) return `生成提问卡片 ${parsed.interaction_id}`;
  if (parsed?.path) return `文件 ${parsed.path}`;
  return '工具调用已完成';
}

function trimForContext(text = '', max = 1400) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max).trim() + '...';
}

function sanitizeAssistantVisibleText(text = '') {
  const raw = String(text || '');
  const withoutThinkingBlocks = raw
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<thinking>[\s\S]*$/gi, '')
    .replace(/<\/thinking>/gi, '');
  return withoutThinkingBlocks.trim();
}

function buildRecentConversationContext(session) {
  if (!session?.conversation_id) return '';
  const history = getConversationHistory(session.conversation_id, { limit: 10 });
  const currentGoal = String(session.goal || '').trim();
  const rows = history.filter((message) => {
    if (!message?.content) return false;
    if (message.role === 'user' && String(message.meta?.agent_goal || '').trim() === currentGoal) return false;
    return message.role === 'user' || message.role === 'assistant';
  }).slice(-8);
  if (rows.length === 0) return '';
  return rows.map((message) => {
    const label = message.role === 'assistant' ? 'AI' : '用户';
    return `${label}：${trimForContext(sanitizeAssistantVisibleText(message.content))}`;
  }).join('\n');
}

function compactMessages(messages = [], tokenBudget = 60000) {
  const estimated = estimateChatRequestTokens({ messages });
  const target = Math.max(1024, Number(tokenBudget) || 60000);
  if (estimated <= target) return messages;
  const list = Array.isArray(messages) ? messages : [];
  const recentStart = Math.max(1, list.length - 4);
  const compactBlock = (block) => {
    if (block?.type === 'tool_result') {
      const parsed = safeJsonParse(block.content, null);
      if (block.is_error || parsed?.error) {
        return { ...block, content: trimForContext(block.content, 2400) };
      }
      return { ...block, content: JSON.stringify({ _compacted: true, summary: buildCompactSummary(parsed) }) };
    }
    if (block?.type === 'text') return { ...block, text: trimForContext(block.text, 1800) };
    return block;
  };
  let compacted = list.map((message, index) => {
    if (index === 0 || index >= recentStart) return message;
    if (Array.isArray(message.content)) return { ...message, content: message.content.map(compactBlock) };
    if (typeof message.content === 'string') {
      return { ...message, content: trimTextToTokenBudget(message.content, 600) };
    }
    return message;
  });
  if (estimateChatRequestTokens({ messages: compacted }) <= target) return compacted;

  compacted = compacted.filter((message, index) => index === 0 || index >= recentStart);
  compacted = compacted.map((message, index) => {
    const perMessageBudget = index === 0 ? Math.max(512, Math.floor(target * 0.3)) : Math.max(512, Math.floor(target * 0.16));
    if (typeof message.content === 'string') return { ...message, content: trimTextToTokenBudget(message.content, perMessageBudget) };
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((block) => (
        block?.type === 'text'
          ? { ...block, text: trimTextToTokenBudget(block.text || '', perMessageBudget) }
          : compactBlock(block)
      )),
    };
  });
  return compacted;
}

function classifyLLMError(error = {}) {
  const status = Number(error.status || 0);
  const code = String(error.code || '').trim().toUpperCase();
  const body = typeof error.response_body === 'string' ? error.response_body : JSON.stringify(error.response_body || '');
  const fingerprint = `${code} ${body} ${String(error.message || '')}`.toLowerCase();
  const actionRequired = status === 401
    || status === 403
    || ['LLM_API_KEY_MISSING', 'LLM_BASE_URL_MISSING', 'LLM_MODEL_MISSING'].includes(code)
    || /insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|insufficient)|billing|credit|balance|invalid[_\s-]*(?:api[_\s-]*)?key|authentication|permission|model[_\s-]*(?:not[_\s-]*found|unavailable|access)/i.test(fingerprint);
  if (actionRequired) return {
    category: 'action_required', retryable: false, publicCode: 'LLM_ACTION_REQUIRED',
    publicMessage: '模型服务需要处理，请检查额度、API Key、权限或模型配置后继续任务。',
  };
  const retryable = ['LLM_REQUEST_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
    || [408, 425, 429, 500, 502, 503, 504].includes(status)
    || error.name === 'FetchError'
    || (error.name === 'TypeError' && /fetch|network|socket/i.test(String(error.message || '')));
  if (retryable) return {
    category: 'retryable', retryable: true, publicCode: 'LLM_TEMPORARILY_UNAVAILABLE',
    publicMessage: '模型服务暂时不可用，已保留当前任务进度。',
  };
  return {
    category: 'fatal', retryable: false,
    publicCode: code === 'CONTEXT_BUDGET_EXCEEDED' ? code : 'LLM_REQUEST_UNRECOVERABLE',
    publicMessage: code === 'CONTEXT_BUDGET_EXCEEDED'
      ? '当前任务上下文超出模型预算，请缩小处理范围。'
      : '模型请求无法恢复，请检查任务和模型配置。',
  };
}

async function callLLMWithRetry(request, maxRetries = 3, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await completeToolChat(request);
    } catch (error) {
      lastError = error;
      const classification = classifyLLMError(error);
      if (classification.retryable && attempt < maxRetries) {
        const delayMs = Math.max(0, Number(options.retryDelayMs?.(attempt) ?? (1000 * Math.pow(2, attempt))));
        options.onRetry?.({ attempt: attempt + 1, maxRetries, delayMs, classification });
        if (delayMs > 0) await sleep(delayMs);
        continue;
      }
      error.llmErrorCategory = classification.category;
      error.publicCode = classification.publicCode;
      error.publicMessage = classification.publicMessage;
      error.retryAttempts = attempt;
      throw error;
    }
  }
  throw lastError;
}

function parseResponse(response = {}) {
  const content = Array.isArray(response.content) ? response.content : [];
  const textBlocks = content.filter((block) => block.type === 'text' && block.text);
  const toolUseBlocks = content.filter((block) => block.type === 'tool_use' && block.name);
  return { textBlocks, toolUseBlocks, stopReason: response.stopReason || 'end_turn', content };
}

function isGoalAchieved(stopReason, toolUseBlocks = []) {
  return toolUseBlocks.length === 0 && ['end_turn', 'stop', 'stop_sequence'].includes(String(stopReason || 'end_turn'));
}

function normalizeApprovalMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'manual' || normalized === 'manual_confirm') return 'manual_confirm';
  return 'auto_confirm';
}

function buildPreviewCompletionText(toolName, {
  approvalMode = 'auto_confirm',
  applied = false,
  requiresConfirmation = false,
  result = {},
} = {}) {
  if (toolName === 'preview_file_revision') {
    if (requiresConfirmation) {
      return result.message || '全文修订预览已生成；系统检测到高风险删除、截断或遗漏，已保留给你在下方 diff 卡片中手动确认，正式文件尚未修改。';
    }
    if (approvalMode === 'auto_confirm' && applied) {
      return '全文修订已自动应用，可在下方 diff 卡片中查看或回滚。';
    }
    return '全文修订预览已生成，请在下方 diff 卡片中应用、废弃或回滚。';
  }
  if (toolName === 'create_note') {
    return approvalMode === 'auto_confirm' && applied
      ? '新文件已自动创建，可在下方 diff 卡片中查看或回滚。'
      : '新建文件预览已生成，请在下方 diff 卡片中应用或回滚。';
  }
  if (toolName === 'preview_file_operations') {
    return approvalMode === 'auto_confirm' && applied
      ? '文件/目录操作已自动应用，可在下方 diff 卡片中查看或回滚。'
      : '文件/目录操作预览已生成，请在下方 diff 卡片中应用或回滚。';
  }
  return approvalMode === 'auto_confirm' && applied
    ? '修改已自动确认并写入文件，可在下方 diff 卡片中逐文件查看或回滚。'
    : '修改预览已生成，请在下方 diff 卡片中逐文件应用或回滚。';
}

async function loadStyleContext(session) {
  try {
    const config = getEffectiveConfig();
    if (!config.canvasEnableStyleExtraction) return null;
    return await getStyleContext(session.goal, { articleTitle: session.goal });
  } catch {
    return null;
  }
}

function buildQuestionCardToolResult(interactionId, sessionId) {
  const interaction = getInteractionById(interactionId);
  if (!interaction) {
    return {
      isError: true,
      content: JSON.stringify({ error: 'INTERACTION_NOT_FOUND', message: '交互不存在或已过期' }),
    };
  }
  if (
    interaction.source !== 'agent_loop'
    || Number(interaction.payload?.agent_session_id || 0) !== Number(sessionId || 0)
  ) {
    return {
      isError: true,
      content: JSON.stringify({ error: 'INTERACTION_SESSION_MISMATCH', message: '交互不属于当前 Agent 任务' }),
    };
  }
  if (interaction.status !== 'answered') {
    return {
      isError: true,
      content: JSON.stringify({ error: 'INTERACTION_NOT_ANSWERED', message: '交互尚未完成' }),
    };
  }
  return {
    isError: false,
    content: JSON.stringify({
      answered: true,
      interaction_id: interaction.id,
      ...(interaction.kind === 'resource_approval' ? { resource_result: interaction.response || {} } : { answers: interaction.response?.answers || {}, summary: buildInteractionAnswerSummary(interaction, interaction.response || {}) }),
    }),
  };
}

function buildInteractionResumeToolResult(interactionId, sessionId) {
  return buildQuestionCardToolResult(interactionId, sessionId);
}

function buildInitialUserContent(session, options = {}) {
  const text = buildInitialUserMessage(session.goal, session, options);
  const images = Array.isArray(options.images) ? options.images : [];
  if (images.length === 0) return [{ type: 'text', text }];
  return [
    { type: 'text', text },
    ...images.flatMap((image, index) => ([
      { type: 'text', text: `图片 ${index + 1}${image?.name ? `（${image.name}）` : ''}${image?.image_ref ? `，会话图片引用：${image.image_ref}` : ''}：` },
      image,
    ])),
  ];
}

async function runAgentLoop({ sessionId, runId = null, llmConfig, onStream, signal, approvalMode = 'auto_confirm', resumeInteractionId = null, initialImages = [], currentImageRecognition = null } = {}) {
  let session = getSession(sessionId);
  const config = getEffectiveConfig();
  const rawEmit = typeof onStream === 'function' ? onStream : () => {};
  const emit = (event) => {
    // 时间线写入失败不能掩盖主任务结果；正常路径下每个用户可见的 v2 事件
    // 都会先脱敏落库，再交给 SSE。断线后可用同一批事件重建工具链。
    try {
      const eventId = recordRunEvent({ sessionId, runId, event });
      broadcastRunEvent({ sessionId, runId, event, eventId });
    } catch {}
    rawEmit(event);
  };
  const normalizedApprovalMode = normalizeApprovalMode(approvalMode);

  const styleContext = await loadStyleContext(session);
  const globalAgentContext = buildGlobalAgentContext(session.goal);
  const resourceContext = buildConversationResourceContext(session.conversation_id);
  const skillCatalog = eligibleSkillSummaries(session.goal, session.skill_mentions || []);
  const mcpContext = await prepareMcpTools(session.mcp_selection || { mode: 'off' }, session.goal, session.mcp_session_permissions || {});
  const tools = buildToolDefinitions(session, { mcpTools: mcpContext.tools });
  session = setSessionRuntimeVersions(session.id, {
    promptVersion: config.agentPromptVersion || 'agent-loop-v2',
    toolsetVersion: sha256(JSON.stringify(tools)).slice(0, 16),
    tokenBudgetTotal: Number(llmConfig?.llmContextWindowTokens || config.llmContextWindowTokens || 60000),
  });
  const attachmentContext = session.conversation_id
    ? formatAttachmentsForPrompt(loadAttachments(session.conversation_id))
    : '';
  const webSearchContext = session.conversation_id && session.web_search_enabled
    ? formatWebSearchContextsForPrompt(session.conversation_id)
    : '';
  const researchReceiptContext = formatResearchReceiptsForPrompt(session.id);
  const promptOptions = {
    styleContext,
    globalAgentContext,
    resourceContext,
    skillCatalog,
    mcpInstructions: mcpContext.instructions,
    taskMaterialContext: [attachmentContext, webSearchContext, researchReceiptContext].filter(Boolean).join('\n\n'),
    taskMaterials: [
      attachmentContext ? { sourceType: 'attachment', sourceId: `conversation-${session.conversation_id}-attachments`, content: attachmentContext } : null,
      webSearchContext ? { sourceType: 'web', sourceId: `conversation-${session.conversation_id}-web`, content: webSearchContext } : null,
      researchReceiptContext ? { sourceType: 'knowledge', sourceId: `session-${session.id}-research-receipts`, content: researchReceiptContext } : null,
    ].filter(Boolean),
    contextWindowTokens: Number(llmConfig?.llmContextWindowTokens || config.llmContextWindowTokens || 60000),
  };
  const renderedPrompt = session.prompt_version === 'legacy-v1'
    ? { text: buildLoopSystemPrompt(session, promptOptions), version: 'legacy-v1', moduleIds: ['legacy-v1'] }
    : renderAgentLoopPrompt(session, promptOptions);
  const systemPrompt = renderedPrompt.text;
  const restrictedPrompt = session.prompt_version === 'legacy-v1'
    ? systemPrompt
    : renderAgentLoopPrompt(session, {
      ...promptOptions,
      styleContext: null,
      globalAgentContext: null,
      resourceContext: null,
      skillCatalog: [],
      mcpInstructions: [],
      taskMaterials: promptOptions.taskMaterials.filter((item) => item.sourceType === 'attachment'),
      taskMaterialContext: '',
    }).text;
  logToolCall({
    sessionId: session.id,
    loopIndex: Number(session.loop_count || 0),
    toolName: '__run_metadata__',
    toolInput: { prompt_version: renderedPrompt.version, prompt_modules: renderedPrompt.moduleIds, toolset_version: session.toolset_version },
    toolResult: { ok: true },
    status: 'metadata',
  });
  const checkpoint = loadMessagesCheckpoint(session.id);
  let checkpointToCommit = checkpoint?.id || null;
  let messages;
  if (checkpoint) {
    messages = checkpoint.messages;
    if (checkpoint.appliedToolUseId) {
      const questionCardResult = resumeInteractionId
        ? buildInteractionResumeToolResult(resumeInteractionId, session.id)
        : null;
      messages.push({ role: 'assistant', content: checkpoint.lastResponseContent || [] });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: checkpoint.appliedToolUseId,
          content: questionCardResult?.content || JSON.stringify({ applied: true, message: '修改已写入文件' }),
          is_error: Boolean(questionCardResult?.isError),
        }],
      });
      if (questionCardResult?.isError) {
        updateSessionStatus(session.id, 'failed');
        emit({
          type: 'final',
          text: '提问卡片回答无法恢复，任务已停止。',
          status: 'failed',
          reason: 'question_card_resume_failed',
          loop_index: Number(session.loop_count || 0),
          usage: getSessionUsage(session.id),
        });
        return { status: 'failed', reason: 'question_card_resume_failed' };
      }
    }
  } else {
    messages = [{
      role: 'user',
      content: buildInitialUserContent(session, {
        recentConversationContext: buildRecentConversationContext(session),
        images: initialImages,
        currentImageRecognition,
      }),
    }];
  }

  let loopIndex = Number(session.loop_count || 0);
  let noToolRounds = 0;
  let budgetRestricted = false;
  // 自动应用预览后，模型通常还会生成一轮面向用户的总结。保留最近一次
  // 变更集，才能把最终消息和可回看的 Diff 卡准确关联起来。
  let latestOperationSetId = null;

  while (true) {
    if (signal?.aborted) {
      const explicitlyCancelled = signal.reason === 'cancel' || isCancellationRequested(session.id);
      if (explicitlyCancelled) {
        updateSessionStatus(session.id, 'cancelled');
        emit({ type: 'final', text: '任务已取消。', status: 'cancelled', reason: 'cancelled', usage: getSessionUsage(session.id) });
        return { status: 'cancelled' };
      }
      saveMessagesCheckpoint(session.id, messages, [], '', runId);
      updateSessionStatus(session.id, 'queued_resume');
      emit({
        type: 'artifact',
        artifact_type: 'run_error',
        status: 'queued_resume',
        error_category: 'interrupted',
        error_code: 'CONNECTION_INTERRUPTED',
        message: '连接已中断，工具链、回复草稿和任务进度已保留。',
        resumable: true,
        loop_index: loopIndex,
      });
      return { status: 'queued_resume', reason: 'connection_interrupted' };
    }

    session = getSession(session.id);
    loopIndex += 1;
    updateSessionLoopCount(session.id, loopIndex);
    emit({ type: 'progress', stage: 'loop_start', text: `正在执行第 ${loopIndex} 轮。`, loop_index: loopIndex });

    if (loopIndex === session.soft_limit || (loopIndex > session.soft_limit && (loopIndex - session.soft_limit) % 5 === 0)) {
      emit({ type: 'progress', stage: 'soft_limit_notice', text: '任务轮次较多，正在收紧上下文。', loop_index: loopIndex });
    }

    if (loopIndex > session.hard_limit) {
      saveMessagesCheckpoint(session.id, messages, [], '', runId);
      updateSessionStatus(session.id, 'waiting_limit_confirmation');
      emit({ type: 'artifact', artifact_type: 'limit_confirmation', reason: 'hard_limit_reached', loop_index: loopIndex });
      return { status: 'waiting_limit_confirmation', reason: 'hard_limit_reached' };
    }

    const usageBefore = getSessionUsage(session.id);
    const tokenBudgetTotal = Math.max(1, Number(session.token_budget_total || llmConfig?.llmContextWindowTokens || config.llmContextWindowTokens || 60000));
    if (usageBefore.total_tokens >= tokenBudgetTotal) {
      saveMessagesCheckpoint(session.id, messages, [], '', runId);
      updateSessionStatus(session.id, 'waiting_limit_confirmation');
      emit({ type: 'artifact', artifact_type: 'limit_confirmation', reason: 'token_budget_reached', loop_index: loopIndex, usage: usageBefore });
      return { status: 'waiting_limit_confirmation', reason: 'token_budget_reached', usage: usageBefore };
    }
    const contextWindow = Number(llmConfig?.llmContextWindowTokens || config.llmContextWindowTokens || 60000);
    const usageRatio = usageBefore.total_tokens / tokenBudgetTotal;
    if (usageRatio >= 0.85 && !budgetRestricted) {
      budgetRestricted = true;
      emit({ type: 'progress', stage: 'budget_restricted', text: '累计预算已超过 85%，已停止加载可选材料和可选工具。', loop_index: loopIndex });
    }
    const compactedMessages = usageBefore.total_tokens >= tokenBudgetTotal * 0.7
      ? compactMessages(messages, Math.floor(contextWindow * 0.6))
      : messages;
    const requestTools = budgetRestricted
      ? tools.filter((tool) => !tool.mcp && !['web_search', 'load_skill', 'read_skill_file', 'list_skills', 'get_skill_details', 'create_skill_draft', 'validate_skill_draft', 'install_skill_draft', 'update_skill_draft', 'set_skill_enabled', 'update_skill_from_git', 'uninstall_skill', 'install_skill_from_git', 'add_mcp_server', 'list_mcp_servers', 'get_mcp_server_details', 'update_mcp_server', 'test_mcp_server', 'set_mcp_server_enabled', 'remove_mcp_server'].includes(tool.name))
      : tools;
    let response;
    checkpointToCommit = saveMessagesCheckpoint(session.id, messages, [], '', runId);
    try {
      response = await callLLMWithRetry({
        system: budgetRestricted ? restrictedPrompt : systemPrompt,
        messages: compactedMessages,
        tools: requestTools,
        llmConfig,
        taskType: 'agent_loop',
        temperature: 0.2,
        signal,
        requestTimeoutMs: config.llmRequestTimeoutMs,
        compact: ({ messages: requestMessages, budget, mode }) => ({
          messages: compactMessages(requestMessages, Math.floor(budget.hardInputBudgetTokens * (mode === 'hard' ? 0.6 : 0.75))),
        }),
        maxRetries: 1,
      }, 3, {
        onRetry: ({ attempt, maxRetries, delayMs }) => emit({
          type: 'progress',
          stage: 'llm_retry',
          text: `模型请求暂时失败，正在进行第 ${attempt}/${maxRetries} 次重试。`,
          retry_attempt: attempt,
          retry_limit: maxRetries,
          retry_after_ms: delayMs,
          loop_index: loopIndex,
        }),
      });
    } catch (error) {
      if (error.code === 'ABORTED' || signal?.aborted) {
        const explicitlyCancelled = signal?.reason === 'cancel' || isCancellationRequested(session.id);
        if (explicitlyCancelled) {
          updateSessionStatus(session.id, 'cancelled');
          emit({ type: 'final', text: '任务已取消。', status: 'cancelled', reason: 'cancelled', usage: getSessionUsage(session.id) });
          return { status: 'cancelled', reason: 'cancelled' };
        }
        updateSessionStatus(session.id, 'queued_resume');
        emit({
          type: 'artifact',
          artifact_type: 'run_error',
          status: 'queued_resume',
          error_category: 'interrupted',
          error_code: 'CONNECTION_INTERRUPTED',
          message: '连接已中断，工具链、回复草稿和任务进度已保留。',
          resumable: true,
          loop_index: loopIndex,
        });
        return { status: 'queued_resume', reason: 'connection_interrupted' };
      }
      if (error.code === 'CONTEXT_BUDGET_EXCEEDED') {
        updateSessionStatus(session.id, 'failed');
        emit({ type: 'final', text: '当前任务上下文超出模型预算，请缩小处理范围后重试。', status: 'failed', reason: 'context_budget_exceeded', loop_index: loopIndex, usage: getSessionUsage(session.id) });
        return { status: 'failed', reason: 'context_budget_exceeded' };
      }
      const classification = classifyLLMError(error);
      const nextStatus = classification.category === 'fatal'
        ? 'failed'
        : classification.category === 'action_required' ? 'waiting_model_recovery' : 'waiting_retry';
      updateSessionStatus(session.id, nextStatus);
      emit({
        type: 'artifact',
        artifact_type: 'run_error',
        status: nextStatus,
        error_category: classification.category,
        error_code: error.publicCode || classification.publicCode,
        message: error.publicMessage || classification.publicMessage,
        retry_attempts: Number(error.retryAttempts || 0),
        resumable: classification.category !== 'fatal',
        loop_index: loopIndex,
      });
      return { status: nextStatus, reason: 'llm_request_failed', error_category: classification.category };
    }
    const responseUsage = response.usage || {
      prompt_tokens: Number(response.budget?.estimated_prompt_tokens || 0),
      completion_tokens: 0,
      total_tokens: Number(response.budget?.estimated_prompt_tokens || 0),
    };
    recordRunUsage({
      sessionId: session.id,
      runId,
      loopIndex,
      sourceType: 'llm',
      provider: llmConfig?.llmProvider || config.llmProvider,
      model: llmConfig?.llmModel || config.llmModel,
      usage: responseUsage,
      usageSource: response.usage ? 'provider' : 'estimated',
    });
    if (checkpointToCommit) {
      clearMessagesCheckpoint(session.id, checkpointToCommit);
      checkpointToCommit = null;
    }
    const { textBlocks, toolUseBlocks, stopReason, content } = parseResponse(response);
    const thinking = sanitizeAssistantVisibleText(textBlocks.map((block) => block.text).join('\n'));

    textBlocks.forEach((block) => {
      const visibleText = sanitizeAssistantVisibleText(block.text);
      if (visibleText && toolUseBlocks.length > 0) emit({ type: 'progress', stage: 'model_progress', text: visibleText, loop_index: loopIndex });
    });

    if (isGoalAchieved(stopReason, toolUseBlocks)) {
      logToolCall({ sessionId: session.id, loopIndex, toolName: null, toolInput: null, toolResult: null, thinking, status: 'success', durationMs: 0 });
      updateSessionStatus(session.id, 'completed');
      const finalText = thinking || '任务已完成。';
      const usage = getSessionUsage(session.id);
      emit({ type: 'final', text: finalText, status: 'completed', reason: 'goal_achieved', loop_index: loopIndex, operation_set_id: latestOperationSetId, usage });
      return { status: 'completed', reason: 'goal_achieved', operation_set_id: latestOperationSetId, final_text: finalText, usage };
    }

    if (toolUseBlocks.length === 0) {
      noToolRounds += 1;
      messages.push({ role: 'assistant', content });
      if (noToolRounds >= 2) {
        updateSessionStatus(session.id, 'failed');
        emit({ type: 'final', text: '任务没有继续产生可执行操作。', status: 'failed', reason: 'no_progress', loop_index: loopIndex, usage: getSessionUsage(session.id) });
        return { status: 'failed', reason: 'no_progress' };
      }
      continue;
    }
    noToolRounds = 0;

    const validation = validateToolUseBlock(toolUseBlocks);
    if (validation.error) {
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: validation.errorToolUseId, content: validation.message, is_error: true }] });
      continue;
    }

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      emit({ type: 'progress', stage: 'tool_start', text: `正在执行 ${toolUse.name}。`, tool_name: toolUse.name, tool_input_summary: summarizeInput(toolUse), loop_index: loopIndex });
      const startedAt = Date.now();
      let result = await executeToolSafely(toolUse, session, config.notesDir, {
        mcpToolMap: mcpContext.map,
        toolDefinitions: tools,
        llmConfig,
        runId,
        signal,
        toolTimeoutMs: config.agentToolTimeoutMs,
        mcpTimeoutMs: config.agentMcpTimeoutMs,
      });
      const durationMs = Date.now() - startedAt;
      const failed = Boolean(result?.error);

      logToolCall({
        sessionId: session.id,
        loopIndex,
        toolName: toolUse.name,
        toolInput: toolUse.input || {},
        toolResult: result,
        thinking,
        status: failed ? 'failed' : 'success',
        durationMs,
      });
      recordToolReceipt(session, toolUse.name, result);

      emit({ type: 'progress', stage: 'tool_done', text: failed ? `${toolUse.name} 执行失败。` : `${toolUse.name} 执行完成。`, tool_name: toolUse.name, result_summary: summarizeToolResult(toolUse.name, result), loop_index: loopIndex, failed });

      if (failed) {
        if (recordToolFail(session.id, toolUse.name)) {
          updateSessionStatus(session.id, 'failed');
          emit({ type: 'final', text: '同一工具连续失败，任务已停止。', status: 'failed', reason: 'consecutive_tool_failure', tool_name: toolUse.name, loop_index: loopIndex, usage: getSessionUsage(session.id) });
          return { status: 'failed', reason: 'consecutive_tool_failure' };
        }
      } else {
        resetToolFail(session.id, toolUse.name);
        if (detectDeadloop(session.id, toolUse.name, result)) {
          updateSessionStatus(session.id, 'failed');
          emit({ type: 'final', text: '检测到连续重复的工具结果，任务已停止。', status: 'failed', reason: 'deadloop_detected', tool_name: toolUse.name, loop_index: loopIndex, usage: getSessionUsage(session.id) });
          return { status: 'failed', reason: 'deadloop_detected' };
        }
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
        is_error: failed,
      });

      if ((toolUse.name === 'ask_question_card' || result?.approval_required) && !failed) {
        saveMessagesCheckpoint(session.id, messages, content, toolUse.id, runId);
        updateSessionStatus(session.id, 'waiting_interaction');
        const resumeTicket = issueCapability({ sessionId: session.id, interactionId: result.interaction_id, action: 'respond' });
        emit({
          type: 'artifact',
          artifact_type: 'interaction',
          loop_index: loopIndex,
          interaction: result.interaction,
          resume_ticket: resumeTicket,
          reason: toolUse.name === 'ask_question_card' ? 'question_card_requested' : 'resource_approval_requested',
        });
        return {
          status: 'waiting_interaction',
          reason: toolUse.name === 'ask_question_card' ? 'question_card_requested' : 'resource_approval_requested',
          interaction: result.interaction,
          interaction_id: result.interaction_id,
        };
      }

      if (['create_note', 'preview_patch_files', 'preview_file_revision', 'preview_file_operations'].includes(toolUse.name) && !failed && result.operation_set_id) {
        latestOperationSetId = result.operation_set_id;
        let previewResult = result;
        const canAutoApply = ['create_note', 'preview_patch_files', 'preview_file_revision', 'preview_file_operations'].includes(toolUse.name) && normalizedApprovalMode === 'auto_confirm';
        if (canAutoApply && !result.applied) {
          previewResult = await applyPreviewWithConflictCheck(result.operation_set_id, session.id, {
            approvalMode: normalizedApprovalMode,
            auto: true,
          });
          if (!previewResult.success) {
            updateSessionStatus(session.id, 'failed');
            emit({
              type: 'final',
              text: '预览自动应用失败，正式文件未修改。',
              status: 'failed',
              reason: 'preview_auto_apply_failed',
              tool_name: toolUse.name,
              loop_index: loopIndex,
              operation_set_id: result.operation_set_id,
            });
            return { status: 'failed', reason: 'preview_auto_apply_failed', operation_set_id: result.operation_set_id };
          }
        }
        const actualApplied = Boolean(previewResult.applied || result.applied);
        const requiresConfirmation = Boolean(previewResult.requires_confirmation || result.requires_confirmation);
        const mergedPreviewResult = {
          ...result,
          ...previewResult,
          approval_mode: normalizedApprovalMode,
          applied: actualApplied,
          requires_confirmation: requiresConfirmation,
          changed_files: previewResult.changed_files || [],
        };
        recordWriteReceipt(session, previewResult.operation_set || result.operation_set || {
          id: result.operation_set_id,
          patches: [],
          status: actualApplied ? 'applied' : 'pending',
        }, actualApplied ? 'applied' : 'pending');

        toolResults[toolResults.length - 1] = {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(mergedPreviewResult),
          is_error: false,
        };
        const finalThinking = buildPreviewCompletionText(toolUse.name, {
          approvalMode: normalizedApprovalMode,
          applied: actualApplied,
          requiresConfirmation,
          result: mergedPreviewResult,
        });
        logToolCall({
          sessionId: session.id,
          loopIndex,
          toolName: null,
          toolInput: null,
          toolResult: { operation_set_id: result.operation_set_id, approval_mode: normalizedApprovalMode },
          thinking: finalThinking,
          status: 'success',
          durationMs: 0,
        });
        emit({
          type: 'artifact',
          artifact_type: 'operation_set',
          operation_set_id: result.operation_set_id,
          status: actualApplied ? 'applied' : 'pending',
          loop_index: loopIndex,
        });
        if (!actualApplied) {
          updateSessionStatus(session.id, 'completed');
          const usage = getSessionUsage(session.id);
          emit({
            type: 'final',
            text: finalThinking,
            status: 'completed',
            reason: 'goal_achieved',
            loop_index: loopIndex,
            operation_set_id: result.operation_set_id,
            usage,
          });
          return { status: 'completed', reason: 'goal_achieved', operation_set_id: result.operation_set_id, final_text: finalThinking, usage };
        }
      }
    }

    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: toolResults });
  }
}

module.exports = {
  compactMessages,
  classifyLLMError,
  callLLMWithRetry,
  parseResponse,
  runAgentLoop,
  sanitizeAssistantVisibleText,
};
