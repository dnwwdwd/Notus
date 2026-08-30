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
  sanitizeRunEvent,
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
const { getOperationSetByToolUse } = require('./canvasOperationSets');
const {
  beginExecutionSegment,
  beginRequestWindow,
  finishRequestWindow,
  getExecutionSegment,
  recordRequestRetry,
  updateExecutionSegment,
} = require('./agentExecutionSegments');
const {
  markTaskChangeSetFinished,
  registerOperationSet,
  resolveOperationSet,
} = require('./agentTaskChangeSets');
const { estimateChatRequestTokens, trimTextToTokenBudget } = require('./llmBudget');
const { getSessionUsage, isCancellationRequested, recordRunUsage } = require('./agentControlPlane');
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
const { agentRuntimeAtLeast, getAgentRuntimeMode } = require('./agentRuntimeMode');
const { getSessionTurnFrame } = require('./agentTurnFrames');
const { projectAgentContext } = require('./agentContextProjector');
const { projectToolDefinitions, requiredToolNames, toolReplayPolicy } = require('./agentToolProfile');
const { getInvocationState, reconcileUnresolvedToolCalls, recordRuntimeFact, recordToolCallPrepared, recordToolCallTerminal, shouldTreatToolFailureAsOutcomeUnknown } = require('./agentRuntimeFacts');
const { archiveToolResult, projectToolResultForModel, readArtifactResultForRuntime } = require('./agentToolResultStore');
const { evaluateCompletion } = require('./agentCompletionEvaluator');

const DEFAULT_LLM_RETRY_LIMIT = 5;
const DEFAULT_LLM_RETRY_DELAY_MS = 30_000;

function repeatedToolFailureText(toolUse = {}, result = {}, mcpToolMap = {}) {
  const mappedName = mcpToolMap?.[toolUse.name]?.toolName;
  const toolName = mappedName || toolUse.name || '工具';
  const details = Array.isArray(result?.details)
    ? result.details.slice(0, 3).map((item) => `${item.path || '/'}：${item.message || item.keyword || '参数无效'}`).filter(Boolean)
    : [];
  const reason = result?.error === 'INVALID_TOOL_INPUT'
    ? `参数未通过 Schema 校验${details.length ? `（${details.join('；')}）` : ''}`
    : `错误码：${result?.error || 'TOOL_EXECUTION_ERROR'}`;
  const fallback = String(toolUse.name || '').startsWith('mcp_')
    ? '已停止重复相同的 MCP 调用；可改正参数，或改用内置链接读取、联网搜索继续。'
    : '已停止重复相同调用，请调整参数后再继续。';
  return `${toolName} 连续两次使用相同参数失败：${reason}。${fallback}`;
}

function waitForRetry(ms, signal) {
  const delayMs = Math.max(0, Number(ms) || 0);
  if (delayMs === 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('模型请求已取消'), { code: 'ABORTED' }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(Object.assign(new Error('模型请求已取消'), { code: 'ABORTED' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function safeJsonParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function checkpointContainsToolResults(checkpoint = {}) {
  if ((Array.isArray(checkpoint.toolResults) ? checkpoint.toolResults : []).some((item) => item?.type === 'tool_result')) return true;
  return (Array.isArray(checkpoint.messages) ? checkpoint.messages : []).some((message) => (
    Array.isArray(message?.content) && message.content.some((item) => item?.type === 'tool_result')
  ));
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

async function callLLMWithRetry(request, maxRetries = DEFAULT_LLM_RETRY_LIMIT, options = {}) {
  let lastError;
  const retryWait = typeof options.waitForRetry === 'function' ? options.waitForRetry : waitForRetry;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await completeToolChat(request);
    } catch (error) {
      lastError = error;
      const classification = classifyLLMError(error);
      if (classification.retryable && attempt < maxRetries) {
        const delayMs = Math.max(0, Number(options.retryDelayMs?.(attempt) ?? DEFAULT_LLM_RETRY_DELAY_MS));
        options.onRetry?.({ attempt: attempt + 1, maxRetries, delayMs, classification });
        if (delayMs > 0) await retryWait(delayMs, request.signal);
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
  if (interaction.status === 'cancelled') {
    return {
      isError: false,
      content: JSON.stringify({
        answered: false,
        cancelled: true,
        action: 'cancel',
        interaction_id: interaction.id,
      }),
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

async function runAgentLoop({ sessionId, taskId = null, turnFrame = null, runId = null, llmConfig, onStream, signal, approvalMode = 'auto_confirm', resumeInteractionId = null, initialImages = [], currentImageRecognition = null } = {}) {
  let session = getSession(sessionId);
  const config = getEffectiveConfig();
  const runtimeMode = getAgentRuntimeMode();
  let effectiveFrame = turnFrame || (agentRuntimeAtLeast('shadow', runtimeMode) ? getSessionTurnFrame(sessionId) : null);
  const rawEmit = typeof onStream === 'function' ? onStream : () => {};
  const emit = (event) => {
    // 时间线写入失败不能掩盖主任务结果；正常路径下每个用户可见的 v2 事件
    // 都会先脱敏落库，再交给 SSE。断线后可用同一批事件重建工具链。
    const safeEvent = sanitizeRunEvent(event);
    if (!safeEvent) return;
    try {
      const eventId = recordRunEvent({ sessionId, runId, event: safeEvent });
      broadcastRunEvent({ sessionId, runId, event: safeEvent, eventId });
    } catch {}
    rawEmit(safeEvent);
  };
  const normalizedApprovalMode = normalizeApprovalMode(approvalMode);

  const styleContext = !agentRuntimeAtLeast('profile', runtimeMode) || effectiveFrame?.intent?.task_kind === 'file_write'
    ? await loadStyleContext(session)
    : null;
  const globalAgentContext = buildGlobalAgentContext(session.goal);
  const resourceContext = agentRuntimeAtLeast('context', runtimeMode) ? null : buildConversationResourceContext(session.conversation_id);
  const skillCatalog = !agentRuntimeAtLeast('profile', runtimeMode) || effectiveFrame?.intent?.source_policy?.local_skills !== 'forbidden'
    ? eligibleSkillSummaries(session.goal, session.skill_mentions || [])
    : [];
  const mcpSelection = session.mcp_selection || { mode: 'off' };
  const mcpDisallowedByFrame = effectiveFrame?.intent?.source_policy?.web === 'required'
    || ['skill_discovery', 'web_research'].includes(String(effectiveFrame?.intent?.task_kind || ''));
  const mcpContext = agentRuntimeAtLeast('profile', runtimeMode)
    && (String(mcpSelection.mode || 'off') === 'off' || mcpDisallowedByFrame)
    ? { tools: [], map: {}, instructions: [] }
    : await prepareMcpTools(mcpSelection, session.goal, session.mcp_session_permissions || {});
  const allTools = buildToolDefinitions(session, { mcpTools: mcpContext.tools });
  const tools = agentRuntimeAtLeast('profile', runtimeMode)
    ? projectToolDefinitions(allTools, effectiveFrame)
    : allTools;
  session = setSessionRuntimeVersions(session.id, {
    promptVersion: config.agentPromptVersion || 'agent-loop-v2',
    toolsetVersion: sha256(JSON.stringify(tools)).slice(0, 16),
    tokenBudgetTotal: Number(llmConfig?.llmContextWindowTokens || config.llmContextWindowTokens || 60000),
  });
  const attachmentContext = !agentRuntimeAtLeast('context', runtimeMode) && session.conversation_id
    ? formatAttachmentsForPrompt(loadAttachments(session.conversation_id))
    : '';
  const webSearchContext = !agentRuntimeAtLeast('context', runtimeMode) && session.conversation_id && session.web_search_enabled
    ? formatWebSearchContextsForPrompt(session.conversation_id)
    : '';
  const researchReceiptContext = agentRuntimeAtLeast('context', runtimeMode) ? '' : formatResearchReceiptsForPrompt(session.id);
  const basePromptOptions = {
    styleContext,
    globalAgentContext,
    resourceContext,
    skillCatalog,
    mcpInstructions: mcpContext.instructions,
    intentContract: effectiveFrame ? require('./agentSemanticRuntime').formatTurnFrameForPrompt(effectiveFrame) : '',
    contextWindowTokens: Number(llmConfig?.llmContextWindowTokens || config.llmContextWindowTokens || 60000),
  };
  const renderRequestPrompt = ({ restricted = false, completionCorrection = '' } = {}) => {
    if (agentRuntimeAtLeast('context', runtimeMode)) {
      effectiveFrame = getSessionTurnFrame(session.id) || effectiveFrame;
    }
    const projectedContext = agentRuntimeAtLeast('context', runtimeMode)
      ? projectAgentContext(effectiveFrame)
      : null;
    const promptOptions = {
      ...basePromptOptions,
      taskMaterialContext: projectedContext?.taskMaterialContext || [attachmentContext, webSearchContext, researchReceiptContext].filter(Boolean).join('\n\n'),
      taskMaterials: projectedContext?.taskMaterials || [
        attachmentContext ? { sourceType: 'attachment', sourceId: `conversation-${session.conversation_id}-attachments`, content: attachmentContext } : null,
        webSearchContext ? { sourceType: 'web', sourceId: `conversation-${session.conversation_id}-web`, content: webSearchContext } : null,
        researchReceiptContext ? { sourceType: 'knowledge', sourceId: `session-${session.id}-research-receipts`, content: researchReceiptContext } : null,
      ].filter(Boolean),
    };
    const options = restricted ? {
      ...promptOptions,
      styleContext: null,
      globalAgentContext: null,
      resourceContext: null,
      skillCatalog: [],
      mcpInstructions: [],
      taskMaterials: agentRuntimeAtLeast('context', runtimeMode)
        ? promptOptions.taskMaterials
        : promptOptions.taskMaterials.filter((item) => item.sourceType === 'attachment'),
      taskMaterialContext: '',
      completionCorrection,
    } : { ...promptOptions, completionCorrection };
    return session.prompt_version === 'legacy-v1'
      ? { text: buildLoopSystemPrompt(session, options), version: 'legacy-v1', moduleIds: ['legacy-v1'] }
      : renderAgentLoopPrompt(session, options);
  };
  const renderedPrompt = renderRequestPrompt();
  logToolCall({
    sessionId: session.id,
    loopIndex: Number(session.loop_count || 0),
    toolName: '__run_metadata__',
    toolInput: { prompt_version: renderedPrompt.version, prompt_modules: renderedPrompt.moduleIds, toolset_version: session.toolset_version },
    toolResult: { ok: true },
    status: 'metadata',
  });
  const checkpoint = loadMessagesCheckpoint(session.id);
  if (
    checkpoint
    && agentRuntimeAtLeast('context', runtimeMode)
    && Number(checkpoint.toolResultProjectionVersion || 0) < 1
    && checkpointContainsToolResults(checkpoint)
  ) {
    updateSessionStatus(session.id, 'failed');
    const finalText = '旧任务检查点包含未外置的工具结果，无法在当前安全上下文模式下继续。请从原用户消息重新发起任务。';
    emit({ type: 'final', text: finalText, status: 'failed', reason: 'checkpoint_projection_incompatible', usage: getSessionUsage(session.id) });
    return { status: 'failed', reason: 'checkpoint_projection_incompatible', final_text: finalText };
  }
  let checkpointToCommit = checkpoint?.id || null;
  let messages;
  if (checkpoint) {
    messages = checkpoint.messages;
    if (checkpoint.appliedToolUseId) {
      const questionCardResult = resumeInteractionId
        ? buildInteractionResumeToolResult(resumeInteractionId, session.id)
        : null;
      const savedToolResults = Array.isArray(checkpoint.toolResults) ? checkpoint.toolResults : [];
      const resumeToolResult = checkpoint.resumeToolResult;
      const restoredResults = savedToolResults.length > 0
        ? savedToolResults.map((item) => (
          String(item?.tool_use_id || '') === String(checkpoint.appliedToolUseId)
            ? {
              ...item,
              content: questionCardResult?.content || resumeToolResult?.content || item.content,
              is_error: Boolean(questionCardResult?.isError || resumeToolResult?.is_error),
            }
            : item
        ))
        : [{
          type: 'tool_result',
          tool_use_id: checkpoint.appliedToolUseId,
          content: questionCardResult?.content || resumeToolResult?.content || JSON.stringify({ applied: true, message: '修改已写入文件' }),
          is_error: Boolean(questionCardResult?.isError || resumeToolResult?.is_error),
        }];
      const restoredToolCount = parseResponse({ content: checkpoint.lastResponseContent || [] }).toolUseBlocks.length;
      if (Math.max(0, Number(checkpoint.nextToolIndex || 0)) < restoredToolCount) {
        checkpoint.phase = 'dispatching_tools';
        checkpoint.appliedToolUseId = '';
        checkpoint.toolResults = restoredResults;
      } else {
        messages.push({ role: 'assistant', content: checkpoint.lastResponseContent || [] });
        messages.push({ role: 'user', content: restoredResults });
      }
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
  let completionCorrection = '';
  let completionCorrectionCount = 0;
  // 自动应用预览后，模型通常还会生成一轮面向用户的总结。保留最近一次
  // 变更集，才能把最终消息和可回看的 Diff 卡准确关联起来。
  let latestOperationSetId = null;
  let activeExecutionSegment = null;
  let activeRequestWindow = null;
  let pendingDispatch = checkpoint?.phase === 'dispatching_tools' && !checkpoint.appliedToolUseId
    ? {
      content: Array.isArray(checkpoint.lastResponseContent) ? checkpoint.lastResponseContent : [],
      toolResults: Array.isArray(checkpoint.toolResults) ? checkpoint.toolResults : [],
      nextToolIndex: Math.max(0, Number(checkpoint.nextToolIndex || 0)),
      executionSegmentId: checkpoint.executionSegmentId,
      llmRequestWindowId: checkpoint.llmRequestWindowId,
    }
    : null;
  let currentDispatchContent = pendingDispatch?.content || null;
  let currentToolResults = pendingDispatch?.toolResults || [];
  let currentNextToolIndex = pendingDispatch?.nextToolIndex || 0;
  const resolveAbortResult = () => {
    if (!signal?.aborted && !isCancellationRequested(session.id)) return null;
    const explicitlyCancelled = signal?.reason === 'cancel' || isCancellationRequested(session.id);
    if (explicitlyCancelled) {
      updateExecutionSegment(activeExecutionSegment?.id || pendingDispatch?.executionSegmentId, { status: 'cancelled', completed: true });
      markTaskChangeSetFinished(session.id, 'cancelled');
      updateSessionStatus(session.id, 'cancelled');
      emit({ type: 'final', text: '任务已取消。', status: 'cancelled', reason: 'cancelled', usage: getSessionUsage(session.id) });
      return { status: 'cancelled', reason: 'cancelled' };
    }
    saveMessagesCheckpoint(session.id, messages, currentDispatchContent || [], '', runId, currentDispatchContent ? {
      phase: 'dispatching_tools',
      executionSegmentId: activeExecutionSegment?.id || pendingDispatch?.executionSegmentId,
      llmRequestWindowId: activeRequestWindow?.id || pendingDispatch?.llmRequestWindowId,
      toolResults: currentToolResults,
      nextToolIndex: currentNextToolIndex,
    } : {});
    updateExecutionSegment(activeExecutionSegment?.id || pendingDispatch?.executionSegmentId, { status: 'queued_resume' });
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
      execution_segment_id: activeExecutionSegment?.id || pendingDispatch?.executionSegmentId,
      segment_sequence_no: activeExecutionSegment?.sequence_no || 0,
    });
    return { status: 'queued_resume', reason: 'connection_interrupted' };
  };

  while (true) {
    const abortResult = resolveAbortResult();
    if (abortResult) return abortResult;

    session = getSession(session.id);
    const isResumingDispatch = Boolean(pendingDispatch);
    let response;
    let receivedVisibleModelText = false;
    if (isResumingDispatch) {
      activeExecutionSegment = getExecutionSegment(pendingDispatch.executionSegmentId)
        || beginExecutionSegment(session.id, loopIndex, { reuseOpen: true });
      activeRequestWindow = pendingDispatch.llmRequestWindowId
        ? { id: pendingDispatch.llmRequestWindowId }
        : null;
      loopIndex = Math.max(loopIndex, Number(activeExecutionSegment.loop_index || loopIndex));
      response = { content: pendingDispatch.content, stop_reason: 'tool_use' };
      emit({
        type: 'progress',
        stage: 'tool_resume',
        text: `正在继续第 ${activeExecutionSegment.sequence_no} 个子任务。`,
        loop_index: loopIndex,
        execution_segment_id: activeExecutionSegment.id,
        segment_sequence_no: activeExecutionSegment.sequence_no,
      });
    } else {
      loopIndex += 1;
      updateSessionLoopCount(session.id, loopIndex);
      activeExecutionSegment = beginExecutionSegment(session.id, loopIndex, { reuseOpen: true });
      emit({
        type: 'progress',
        stage: 'loop_start',
        text: `正在执行第 ${activeExecutionSegment.sequence_no} 个子任务。`,
        loop_index: loopIndex,
        execution_segment_id: activeExecutionSegment.id,
        segment_sequence_no: activeExecutionSegment.sequence_no,
      });

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
    const normalPrompt = renderRequestPrompt({ completionCorrection });
    const normalTools = agentRuntimeAtLeast('profile', runtimeMode)
      ? projectToolDefinitions(allTools, effectiveFrame)
      : tools;
    const estimatedRequestTokens = estimateChatRequestTokens({ system: normalPrompt.text, messages, tools: normalTools });
    const requestPressure = estimatedRequestTokens / Math.max(contextWindow, 1);
    const nextBudgetRestricted = requestPressure >= 0.85;
    if (nextBudgetRestricted && !budgetRestricted) {
      emit({ type: 'progress', stage: 'budget_restricted', text: '本次请求上下文接近模型上限，已停止加载可选材料和可选工具。', loop_index: loopIndex });
    }
    budgetRestricted = nextBudgetRestricted;
    const compactedMessages = requestPressure >= 0.72
      ? compactMessages(messages, Math.floor(contextWindow * 0.6))
      : messages;
    const requiredNames = requiredToolNames(effectiveFrame?.intent || {});
    if (String(mcpSelection.mode || 'off') === 'server') {
      Object.keys(mcpContext.map || {}).forEach((name) => requiredNames.add(name));
    }
    const pressureOptionalNames = new Set(['web_search', 'fetch_web_url', 'load_skill', 'read_skill_file', 'list_skills', 'get_skill_details', 'create_skill_draft', 'validate_skill_draft', 'install_skill_draft', 'update_skill_draft', 'set_skill_enabled', 'update_skill_from_git', 'uninstall_skill', 'install_skill_from_git', 'add_mcp_server', 'list_mcp_servers', 'get_mcp_server_details', 'update_mcp_server', 'test_mcp_server', 'set_mcp_server_enabled', 'remove_mcp_server']);
    const requestTools = budgetRestricted
      ? normalTools.filter((tool) => requiredNames.has(tool.name) || (!tool.mcp && !pressureOptionalNames.has(tool.name)))
      : normalTools;
    const requestPrompt = budgetRestricted
      ? renderRequestPrompt({ restricted: true, completionCorrection })
      : normalPrompt;
    activeRequestWindow = beginRequestWindow(activeExecutionSegment.id, {
      runId,
      llmConfigId: llmConfig?.id || llmConfig?.llmConfigId || null,
      retryLimit: DEFAULT_LLM_RETRY_LIMIT,
    });
    emit({
      type: 'progress',
      stage: 'model_requesting',
      text: '正在等待模型响应。',
      loop_index: loopIndex,
      execution_segment_id: activeExecutionSegment.id,
      segment_sequence_no: activeExecutionSegment.sequence_no,
      request_window_no: activeRequestWindow.window_no,
    });
    checkpointToCommit = saveMessagesCheckpoint(session.id, messages, [], '', runId, {
      phase: 'before_llm',
      executionSegmentId: activeExecutionSegment.id,
      llmRequestWindowId: activeRequestWindow.id,
    });
    try {
      response = await callLLMWithRetry({
        system: requestPrompt.text,
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
        onVisibleText: (text) => {
          const visibleText = sanitizeAssistantVisibleText(text);
          if (!visibleText) return;
          receivedVisibleModelText = true;
          emit({
            type: 'progress',
            stage: 'model_progress',
            text: visibleText,
            loop_index: loopIndex,
            execution_segment_id: activeExecutionSegment.id,
            segment_sequence_no: activeExecutionSegment.sequence_no,
            request_window_no: activeRequestWindow.window_no,
          });
        },
      }, DEFAULT_LLM_RETRY_LIMIT, {
        onRetry: ({ attempt, maxRetries, delayMs, classification }) => {
          recordRequestRetry(activeRequestWindow.id, attempt, classification);
          emit({
            type: 'progress',
            stage: 'llm_retry',
            text: `模型请求暂时失败，正在进行第 ${attempt}/${maxRetries} 次重试。`,
            retry_attempt: attempt,
            retry_limit: maxRetries,
            retry_after_ms: delayMs,
            loop_index: loopIndex,
            execution_segment_id: activeExecutionSegment.id,
            segment_sequence_no: activeExecutionSegment.sequence_no,
            request_window_no: activeRequestWindow.window_no,
          });
        },
      });
      finishRequestWindow(activeRequestWindow.id, 'completed');
    } catch (error) {
      if (error.code === 'ABORTED' || signal?.aborted) {
        const explicitlyCancelled = signal?.reason === 'cancel' || isCancellationRequested(session.id);
        finishRequestWindow(activeRequestWindow?.id, explicitlyCancelled ? 'cancelled' : 'interrupted', {
          category: explicitlyCancelled ? 'cancelled' : 'interrupted',
          code: explicitlyCancelled ? 'CANCELLED' : 'CONNECTION_INTERRUPTED',
        });
        if (explicitlyCancelled) {
          updateExecutionSegment(activeExecutionSegment?.id, { status: 'cancelled', completed: true });
          updateSessionStatus(session.id, 'cancelled');
          emit({ type: 'final', text: '任务已取消。', status: 'cancelled', reason: 'cancelled', usage: getSessionUsage(session.id) });
          return { status: 'cancelled', reason: 'cancelled' };
        }
        updateExecutionSegment(activeExecutionSegment?.id, { status: 'queued_resume' });
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
          execution_segment_id: activeExecutionSegment?.id,
          segment_sequence_no: activeExecutionSegment?.sequence_no || 0,
        });
        return { status: 'queued_resume', reason: 'connection_interrupted' };
      }
      if (error.code === 'CONTEXT_BUDGET_EXCEEDED') {
        finishRequestWindow(activeRequestWindow?.id, 'failed', {
          category: 'context_budget',
          code: 'CONTEXT_BUDGET_EXCEEDED',
        });
        updateExecutionSegment(activeExecutionSegment?.id, { status: 'failed', completed: true });
        updateSessionStatus(session.id, 'failed');
        emit({ type: 'final', text: '当前任务上下文超出模型预算，请缩小处理范围后重试。', status: 'failed', reason: 'context_budget_exceeded', loop_index: loopIndex, usage: getSessionUsage(session.id) });
        return { status: 'failed', reason: 'context_budget_exceeded' };
      }
      const classification = classifyLLMError(error);
      const nextStatus = classification.category === 'fatal'
        ? 'failed'
        : classification.category === 'action_required' ? 'waiting_model_recovery' : 'waiting_retry';
      updateSessionStatus(session.id, nextStatus);
      finishRequestWindow(activeRequestWindow?.id, 'failed', {
        category: classification.category,
        code: error.publicCode || classification.publicCode,
      });
      updateExecutionSegment(activeExecutionSegment?.id, { status: nextStatus });
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
        execution_segment_id: activeExecutionSegment?.id,
        segment_sequence_no: activeExecutionSegment?.sequence_no,
        request_window_no: activeRequestWindow?.window_no,
      });
      return { status: nextStatus, reason: 'llm_request_failed', error_category: classification.category };
    }
    const abortAfterModel = resolveAbortResult();
    if (abortAfterModel) return abortAfterModel;
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
    }
    const { textBlocks, toolUseBlocks, stopReason, content } = parseResponse(response);
    if (!isResumingDispatch && toolUseBlocks.length === 0 && checkpointToCommit) {
      clearMessagesCheckpoint(session.id, checkpointToCommit);
      checkpointToCommit = null;
    }
    const thinking = sanitizeAssistantVisibleText(textBlocks.map((block) => block.text).join('\n'));
    updateExecutionSegment(activeExecutionSegment.id, {
      status: toolUseBlocks.length > 0 ? 'dispatching_tools' : 'completed',
      label: thinking.slice(0, 120),
      toolNames: toolUseBlocks.map((block) => block.name),
      completed: toolUseBlocks.length === 0,
    });

    if (!isResumingDispatch && !receivedVisibleModelText && toolUseBlocks.length > 0) {
      textBlocks.forEach((block) => {
        const visibleText = sanitizeAssistantVisibleText(block.text);
        if (!visibleText) return;
        emit({
          type: 'progress',
          stage: 'model_progress',
          text: visibleText,
          loop_index: loopIndex,
          execution_segment_id: activeExecutionSegment.id,
          segment_sequence_no: activeExecutionSegment.sequence_no,
          request_window_no: activeRequestWindow?.window_no || 0,
        });
      });
    }

    if (isGoalAchieved(stopReason, toolUseBlocks)) {
      logToolCall({ sessionId: session.id, loopIndex, toolName: null, toolInput: null, toolResult: null, thinking, status: 'success', durationMs: 0 });
      if (agentRuntimeAtLeast('enforced', runtimeMode)) {
        const completion = evaluateCompletion({
          sessionId: session.id,
          frame: effectiveFrame,
          finalText: thinking,
          correctionCount: completionCorrectionCount,
        });
        if (!completion.complete && completion.correctable) {
          completionCorrection = completion.feedback;
          completionCorrectionCount += 1;
          recordRuntimeFact({
            eventKey: `task:${taskId || session.id}:completion-correction:${completionCorrectionCount}`,
            conversationId: session.conversation_id,
            sessionId: session.id,
            taskId,
            turnFrameId: effectiveFrame?.id,
            runId,
            actor: 'runtime',
            factType: 'completion_correction_requested',
            modelVisible: true,
            payload: { reasons: completion.reasons },
          });
          emit({ type: 'progress', stage: 'completion_check', text: '完成检查发现仍有缺失步骤，正在补充一次。', loop_index: loopIndex });
          continue;
        }
        if (!completion.complete) {
          const finalText = `任务尚未完成：${completion.reasons.join('；')}。`;
          updateSessionStatus(session.id, 'failed');
          recordRuntimeFact({ eventKey: `task:${taskId || session.id}:completion-incomplete`, conversationId: session.conversation_id, sessionId: session.id, taskId, turnFrameId: effectiveFrame?.id, runId, actor: 'runtime', factType: 'completion_incomplete', payload: { reasons: completion.reasons } });
          emit({ type: 'final', text: finalText, status: 'failed', reason: 'incomplete', loop_index: loopIndex, operation_set_id: latestOperationSetId, usage: getSessionUsage(session.id) });
          return { status: 'failed', reason: 'incomplete', final_text: finalText, operation_set_id: latestOperationSetId, usage: getSessionUsage(session.id) };
        }
      }
      updateSessionStatus(session.id, 'completed');
      markTaskChangeSetFinished(session.id, 'completed');
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
      if (checkpointToCommit) clearMessagesCheckpoint(session.id, checkpointToCommit);
      checkpointToCommit = null;
      pendingDispatch = null;
      currentDispatchContent = null;
      continue;
    }

    const toolResults = isResumingDispatch ? [...pendingDispatch.toolResults] : [];
    const startToolIndex = isResumingDispatch ? Math.min(pendingDispatch.nextToolIndex, toolUseBlocks.length) : 0;
    currentDispatchContent = content;
    currentToolResults = toolResults;
    currentNextToolIndex = startToolIndex;
    checkpointToCommit = saveMessagesCheckpoint(session.id, messages, content, '', runId, {
      phase: 'dispatching_tools',
      executionSegmentId: activeExecutionSegment.id,
      llmRequestWindowId: activeRequestWindow?.id,
      toolResults,
      nextToolIndex: startToolIndex,
    });
    pendingDispatch = null;
    for (let toolIndex = startToolIndex; toolIndex < toolUseBlocks.length; toolIndex += 1) {
      const toolUse = toolUseBlocks[toolIndex];
      const toolDisplayName = mcpContext.map?.[toolUse.name]?.toolName || toolUse.name;
      const invocationKey = `${session.id}:${toolUse.id}`;
      const externalMcp = Boolean(mcpContext.map?.[toolUse.name]);
      const replayPolicy = toolReplayPolicy(toolUse.name, { externalMcp });
      emit({
        type: 'progress',
        stage: 'tool_start',
        text: `正在执行 ${toolUse.name}。`,
        tool_name: toolUse.name,
        tool_display_name: toolDisplayName,
        tool_input_summary: summarizeInput(toolUse),
        loop_index: loopIndex,
        execution_segment_id: activeExecutionSegment.id,
        segment_sequence_no: activeExecutionSegment.sequence_no,
        request_window_no: activeRequestWindow?.window_no || 0,
        tool_index: toolIndex,
      });
      const startedAt = Date.now();
      if (agentRuntimeAtLeast('shadow', runtimeMode)) {
        recordToolCallPrepared({
          conversationId: session.conversation_id,
          sessionId: session.id,
          taskId,
          turnFrameId: effectiveFrame?.id,
          runId,
          executionSegmentId: activeExecutionSegment.id,
          requestWindowId: activeRequestWindow?.id,
          actor: 'model',
          toolCallId: toolUse.id,
          invocationKey,
          toolName: toolUse.name,
          inputDigest: sha256(JSON.stringify(toolUse.input || {})),
          replayPolicy,
          externalMcp,
          effectKind: [
            'install_skill_from_git', 'install_skill_draft', 'update_skill_draft', 'set_skill_enabled',
            'update_skill_from_git', 'uninstall_skill', 'add_mcp_server', 'update_mcp_server',
            'set_mcp_server_enabled', 'remove_mcp_server',
          ].includes(toolUse.name) ? 'resource_mutation' : '',
        });
      }
      const existingOperationSet = getOperationSetByToolUse(session.id, toolUse.id);
      const invocationState = agentRuntimeAtLeast('facts', runtimeMode) ? getInvocationState(invocationKey) : { terminal: null };
      const recoveredInvocation = invocationState.terminal && replayPolicy === 'non_replayable'
        && invocationState.terminal.fact_type !== 'tool_call_outcome_unknown'
        ? await readArtifactResultForRuntime({
          conversationId: session.conversation_id,
          sessionId: session.id,
          invocationKey,
        })
        : null;
      let rawResult = null;
      let result = invocationState.terminal?.fact_type === 'tool_call_outcome_unknown'
        ? invocationState.resolution?.payload?.resolution === 'confirmed_success'
          ? { recovered: true, outcome_confirmed: 'success', message: '用户已核实该外部操作成功；未自动重放。' }
          : invocationState.resolution?.payload?.resolution === 'confirmed_failed'
          ? { error: 'TOOL_OUTCOME_CONFIRMED_FAILED', recovered: true, message: '用户已核实该外部操作没有成功；未自动重放。' }
          : { error: 'TOOL_OUTCOME_UNKNOWN', message: '该工具上次执行后的外部结果无法确认，不能自动重放。' }
        : recoveredInvocation?.result !== null && recoveredInvocation?.result !== undefined
        ? recoveredInvocation.result
        : recoveredInvocation
        ? { error: 'TOOL_RESULT_PAYLOAD_UNAVAILABLE', message: '该工具已经执行，但保存的结果载荷无法读取，不能自动重放。' }
        : existingOperationSet
        ? {
          operation_set_id: existingOperationSet.id,
          patch_count: existingOperationSet.patches.length,
          operation_count: existingOperationSet.operations.length,
          preview: existingOperationSet.status === 'pending',
          applied: existingOperationSet.status === 'applied',
          recovered: true,
        }
        : await executeToolSafely(toolUse, session, config.notesDir, {
          mcpToolMap: mcpContext.map,
          toolDefinitions: tools,
          llmConfig,
          runId,
          turnFrame: effectiveFrame,
          toolUseId: toolUse.id,
          executionSegmentId: activeExecutionSegment.id,
          signal,
          toolTimeoutMs: config.agentToolTimeoutMs,
          mcpTimeoutMs: config.agentMcpTimeoutMs,
          onRawResult: (value) => { rawResult = value; },
        });
      if (rawResult === null) rawResult = existingOperationSet ? { ...result, operation_set: existingOperationSet } : result;
      let resultArtifact = recoveredInvocation?.artifact || null;
      let modelVisibleResult = result;
      if (agentRuntimeAtLeast('shadow', runtimeMode) && toolUse.name !== 'read_tool_result' && !recoveredInvocation) {
        resultArtifact = await archiveToolResult({
          conversationId: session.conversation_id,
          sessionId: session.id,
          taskId,
          turnFrameId: effectiveFrame?.id,
          toolCallId: toolUse.id,
          invocationKey,
          toolName: toolUse.name,
          actor: 'model',
          result: rawResult,
        });
      }
      if (toolUse.name !== 'read_tool_result') {
        modelVisibleResult = projectToolResultForModel({
          useReceipt: agentRuntimeAtLeast('context', runtimeMode),
          toolName: toolUse.name,
          result,
          artifact: resultArtifact,
        });
      }
      const durationMs = Date.now() - startedAt;
      const failed = Boolean(result?.error);
      const outcomeUnknown = failed && shouldTreatToolFailureAsOutcomeUnknown({
        replayPolicy,
        externalMcp,
        errorCode: result?.error,
      });

      if (agentRuntimeAtLeast('shadow', runtimeMode)) {
        const resourceChangeTools = new Set([
          'install_skill_from_git', 'install_skill_draft', 'update_skill_draft', 'set_skill_enabled',
          'update_skill_from_git', 'uninstall_skill', 'add_mcp_server', 'update_mcp_server',
          'set_mcp_server_enabled', 'remove_mcp_server', 'update_global_agent_file',
        ]);
        recordToolCallTerminal({
          conversationId: session.conversation_id,
          sessionId: session.id,
          taskId,
          turnFrameId: effectiveFrame?.id,
          runId,
          executionSegmentId: activeExecutionSegment.id,
          requestWindowId: activeRequestWindow?.id,
          actor: 'model',
          toolCallId: toolUse.id,
          invocationKey,
          factType: outcomeUnknown ? 'tool_call_outcome_unknown' : failed ? 'tool_call_failed' : 'tool_call_completed',
          payload: {
            tool_name: toolUse.name,
            result_ref: resultArtifact?.status === 'ready' ? resultArtifact.result_ref : null,
            artifact_status: resultArtifact?.status || (toolUse.name === 'read_tool_result' ? 'inline' : 'archive_failed'),
            error_code: result?.error || '',
            resource_changed: !failed && !result?.approval_required && resourceChangeTools.has(toolUse.name),
            operation_set_id: result?.operation_set_id || null,
          },
        });
      }

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

      emit({
        type: 'progress',
        stage: 'tool_done',
        text: failed ? `${toolUse.name} 执行失败。` : `${toolUse.name} 执行完成。`,
        tool_name: toolUse.name,
        tool_display_name: toolDisplayName,
        result_summary: summarizeToolResult(toolUse.name, result),
        loop_index: loopIndex,
        execution_segment_id: activeExecutionSegment.id,
        segment_sequence_no: activeExecutionSegment.sequence_no,
        request_window_no: activeRequestWindow?.window_no || 0,
        tool_index: toolIndex,
        failed,
      });

      if (outcomeUnknown) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(modelVisibleResult),
          is_error: true,
        });
        const reconciliation = reconcileUnresolvedToolCalls();
        const interaction = reconciliation.interactions.find((item) => item?.payload?.invocation_key === invocationKey) || null;
        currentToolResults = toolResults;
        currentNextToolIndex = toolIndex + 1;
        saveMessagesCheckpoint(session.id, messages, content, toolUse.id, runId, {
          phase: 'waiting_interaction',
          executionSegmentId: activeExecutionSegment.id,
          llmRequestWindowId: activeRequestWindow?.id,
          toolResults,
          nextToolIndex: currentNextToolIndex,
        });
        updateExecutionSegment(activeExecutionSegment.id, { status: 'completed', completed: true });
        updateSessionStatus(session.id, 'waiting_interaction');
        if (interaction) {
          emit({
            type: 'artifact',
            artifact_type: 'interaction',
            loop_index: loopIndex,
            interaction,
            reason: 'tool_outcome_unknown',
            execution_segment_id: activeExecutionSegment.id,
            segment_sequence_no: activeExecutionSegment.sequence_no,
          });
        }
        return { status: 'waiting_interaction', reason: 'tool_outcome_unknown', interaction, interaction_id: interaction?.id || null };
      }

      if (agentRuntimeAtLeast('context', runtimeMode) && toolUse.name !== 'read_tool_result' && resultArtifact?.status !== 'ready') {
        updateExecutionSegment(activeExecutionSegment.id, { status: 'failed', completed: true });
        updateSessionStatus(session.id, 'failed');
        emit({ type: 'final', text: '工具已经执行，但完整结果无法安全保存，后续步骤已停止。外部操作状态以执行记录为准。', status: 'failed', reason: 'tool_result_payload_unavailable', tool_name: toolUse.name, loop_index: loopIndex, usage: getSessionUsage(session.id) });
        return { status: 'failed', reason: 'tool_result_payload_unavailable' };
      }

      if (failed) {
        if (recordToolFail(session.id, toolUse.name, toolUse.input || {}, result)) {
          updateExecutionSegment(activeExecutionSegment.id, { status: 'failed', completed: true });
          updateSessionStatus(session.id, 'failed');
          emit({ type: 'final', text: repeatedToolFailureText(toolUse, result, mcpContext.map), status: 'failed', reason: 'consecutive_tool_failure', tool_name: toolUse.name, loop_index: loopIndex, usage: getSessionUsage(session.id) });
          return { status: 'failed', reason: 'consecutive_tool_failure' };
        }
      } else {
        resetToolFail(session.id, toolUse.name);
        if (detectDeadloop(session.id, toolUse.name, result)) {
          updateExecutionSegment(activeExecutionSegment.id, { status: 'failed', completed: true });
          updateSessionStatus(session.id, 'failed');
          emit({ type: 'final', text: '检测到连续重复的工具结果，任务已停止。', status: 'failed', reason: 'deadloop_detected', tool_name: toolUse.name, loop_index: loopIndex, usage: getSessionUsage(session.id) });
          return { status: 'failed', reason: 'deadloop_detected' };
        }
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(modelVisibleResult),
        is_error: failed,
      });
      if ((toolUse.name === 'ask_question_card' || result?.approval_required) && !failed) {
        currentToolResults = toolResults;
        currentNextToolIndex = toolIndex + 1;
        saveMessagesCheckpoint(session.id, messages, content, toolUse.id, runId, {
          phase: 'waiting_interaction',
          executionSegmentId: activeExecutionSegment.id,
          llmRequestWindowId: activeRequestWindow?.id,
          toolResults,
          nextToolIndex: currentNextToolIndex,
        });
        updateExecutionSegment(activeExecutionSegment.id, { status: 'completed', completed: true });
        updateSessionStatus(session.id, 'waiting_interaction');
        emit({
          type: 'artifact',
          artifact_type: 'interaction',
          loop_index: loopIndex,
          interaction: result.interaction,
          reason: toolUse.name === 'ask_question_card' ? 'question_card_requested' : 'resource_approval_requested',
          execution_segment_id: activeExecutionSegment.id,
          segment_sequence_no: activeExecutionSegment.sequence_no,
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
        const changeSet = registerOperationSet({
          operationSetId: result.operation_set_id,
          sessionId: session.id,
          conversationId: session.conversation_id,
          approvalMode: normalizedApprovalMode,
          executionSegmentId: activeExecutionSegment.id,
          toolUseId: toolUse.id,
        });
        let previewResult = result;
        const canAutoApply = ['create_note', 'preview_patch_files', 'preview_file_revision', 'preview_file_operations'].includes(toolUse.name) && normalizedApprovalMode === 'auto_confirm';
        if (canAutoApply && !result.applied) {
          previewResult = await applyPreviewWithConflictCheck(result.operation_set_id, session.id, {
            approvalMode: normalizedApprovalMode,
            auto: true,
          });
          if (!previewResult.success) {
            updateExecutionSegment(activeExecutionSegment.id, { status: 'failed', completed: true });
            updateSessionStatus(session.id, 'failed');
            markTaskChangeSetFinished(session.id, 'failed');
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
        if (actualApplied) {
          resolveOperationSet({
            operationSetId: result.operation_set_id,
            sessionId: session.id,
            resolution: 'applied',
            toolResult: mergedPreviewResult,
          });
        }
        recordWriteReceipt(session, previewResult.operation_set || result.operation_set || {
          id: result.operation_set_id,
          patches: [],
          status: actualApplied ? 'applied' : 'pending',
        }, actualApplied ? 'applied' : 'pending');

        if (agentRuntimeAtLeast('shadow', runtimeMode)) {
          resultArtifact = await archiveToolResult({
            conversationId: session.conversation_id,
            sessionId: session.id,
            taskId,
            turnFrameId: effectiveFrame?.id,
            toolCallId: toolUse.id,
            invocationKey,
            toolName: toolUse.name,
            actor: 'model',
            result: mergedPreviewResult,
            replace: true,
          });
        }
        if (agentRuntimeAtLeast('context', runtimeMode) && resultArtifact?.status !== 'ready') {
          updateExecutionSegment(activeExecutionSegment.id, { status: 'failed', completed: true });
          updateSessionStatus(session.id, 'failed');
          emit({ type: 'final', text: '文件操作已经执行，但完整结果无法安全保存，后续步骤已停止。请根据文件预览和执行记录核实结果。', status: 'failed', reason: 'tool_result_payload_unavailable', tool_name: toolUse.name, loop_index: loopIndex, operation_set_id: result.operation_set_id });
          return { status: 'failed', reason: 'tool_result_payload_unavailable', operation_set_id: result.operation_set_id };
        }
        const mergedModelVisibleResult = agentRuntimeAtLeast('context', runtimeMode)
          ? projectToolResultForModel({ useReceipt: true, toolName: toolUse.name, result: mergedPreviewResult, artifact: resultArtifact })
          : mergedPreviewResult;
        toolResults[toolResults.length - 1] = {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(mergedModelVisibleResult),
          is_error: false,
        };
        const finalThinking = buildPreviewCompletionText(toolUse.name, {
          approvalMode: normalizedApprovalMode,
          applied: actualApplied,
          requiresConfirmation,
          result: mergedPreviewResult,
        });
        const batchPatches = Array.isArray(mergedPreviewResult.operation_set?.patches)
          ? mergedPreviewResult.operation_set.patches
          : (Array.isArray(result.operation_set?.patches) ? result.operation_set.patches : []);
        const directoryChangeTypes = new Set(['create_folder', 'rename_folder', 'move_folder', 'delete_folder']);
        const directoryChangeCount = batchPatches.filter((patch) => directoryChangeTypes.has(String(patch?.change_type || ''))).length;
        const fileChangeCount = Math.max(0, batchPatches.length - directoryChangeCount);
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
          task_change_set_id: changeSet.id,
          task_change_set_version: changeSet.version,
          status: actualApplied ? 'applied' : 'pending',
          loop_index: loopIndex,
          execution_segment_id: activeExecutionSegment.id,
          segment_sequence_no: activeExecutionSegment.sequence_no,
          change_file_count: fileChangeCount,
          change_directory_count: directoryChangeCount,
        });
        if (!actualApplied && normalizedApprovalMode === 'manual_confirm') {
          // 手动模式的边界是生成 Diff，而不是用户应用后的下一轮模型调用。
          // 保留 operation set 与任务变更集供用户随时应用、废弃或回滚，但不再保存
          // 可恢复 checkpoint 或阻塞同会话队列，避免应用后再额外请求模型生成收尾总结。
          updateExecutionSegment(activeExecutionSegment.id, { status: 'completed', completed: true });
          updateSessionStatus(session.id, 'completed');
          markTaskChangeSetFinished(session.id, 'completed');
          if (checkpointToCommit) clearMessagesCheckpoint(session.id, checkpointToCommit);
          checkpointToCommit = null;
          const usage = getSessionUsage(session.id);
          emit({
            type: 'final',
            text: finalThinking,
            status: 'completed',
            reason: 'manual_preview_generated',
            loop_index: loopIndex,
            operation_set_id: result.operation_set_id,
            task_change_set_id: changeSet.id,
            task_change_set_version: changeSet.version,
            usage,
          });
          return {
            status: 'completed',
            reason: 'manual_preview_generated',
            operation_set_id: result.operation_set_id,
            task_change_set_id: changeSet.id,
            final_text: finalThinking,
            usage,
          };
        }
        if (!actualApplied) {
          saveMessagesCheckpoint(session.id, messages, content, toolUse.id, runId, {
            phase: 'waiting_operation_confirmation',
            executionSegmentId: activeExecutionSegment.id,
            llmRequestWindowId: activeRequestWindow?.id,
            toolResults,
            nextToolIndex: toolResults.length,
            pendingOperationSetId: result.operation_set_id,
          });
          updateExecutionSegment(activeExecutionSegment.id, { status: 'waiting_operation_confirmation' });
          updateSessionStatus(session.id, 'waiting_operation_confirmation');
          emit({
            type: 'artifact',
            artifact_type: 'operation_confirmation',
            text: finalThinking,
            status: 'waiting_operation_confirmation',
            reason: 'operation_confirmation_required',
            loop_index: loopIndex,
            operation_set_id: result.operation_set_id,
            task_change_set_id: changeSet.id,
            task_change_set_version: changeSet.version,
            execution_segment_id: activeExecutionSegment.id,
            segment_sequence_no: activeExecutionSegment.sequence_no,
          });
          return {
            status: 'waiting_operation_confirmation',
            reason: 'operation_confirmation_required',
            operation_set_id: result.operation_set_id,
            task_change_set_id: changeSet.id,
          };
        }
      }
      currentToolResults = toolResults;
      currentNextToolIndex = toolIndex + 1;
      checkpointToCommit = saveMessagesCheckpoint(session.id, messages, content, '', runId, {
        phase: 'dispatching_tools',
        executionSegmentId: activeExecutionSegment.id,
        llmRequestWindowId: activeRequestWindow?.id,
        toolResults,
        nextToolIndex: currentNextToolIndex,
      });
      const abortAfterTool = resolveAbortResult();
      if (abortAfterTool) return abortAfterTool;
    }

    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: toolResults });
    if (checkpointToCommit) clearMessagesCheckpoint(session.id, checkpointToCommit);
    checkpointToCommit = null;
    currentDispatchContent = null;
    currentToolResults = [];
    currentNextToolIndex = 0;
    updateExecutionSegment(activeExecutionSegment.id, { status: 'completed', completed: true });
  }
}

module.exports = {
  compactMessages,
  classifyLLMError,
  callLLMWithRetry,
  DEFAULT_LLM_RETRY_DELAY_MS,
  DEFAULT_LLM_RETRY_LIMIT,
  parseResponse,
  runAgentLoop,
  sanitizeAssistantVisibleText,
};
