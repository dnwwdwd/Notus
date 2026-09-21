const { completeToolChat } = require('./llm');
const { getEffectiveConfig } = require('./config');
const { getStyleContext } = require('./style');
const { buildInitialUserMessage, buildLoopSystemPrompt } = require('./agentLoopPrompt');
const { renderAgentLoopPrompt } = require('./prompt/agent-loop/render');
const { buildConversationContext } = require('./agentConversationContext');
const { compactMessages, migrateCheckpointResults, INLINE_READ_TOOLS } = require('./agentMessageProjection');
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
const { getOperationSetByToolUse, getOperationSetById } = require('./canvasOperationSets');
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
const { eligibleSkillSummaries, scanAllSkills } = require('./skills');
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

function trimForContext(text = '', max = 1400) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max).trim() + '...';
}

function sanitizeAssistantVisibleText(text = '') {
  return require('./assistantVisibleText').visibleText(text).trim();
}

function llmFailureReason(error = {}) {
  const text = `${error.code || ''} ${error.message || ''} ${typeof error.response_body === 'string' ? error.response_body : JSON.stringify(error.response_body || '')}`;
  if (/context|maximum.{0,20}tokens|too.{0,10}(?:long|large)/i.test(text)) return 'context_limit';
  if (/tool[_ -]?(?:use|call|result)|reasoning_content|thinking.{0,30}(?:signature|block)|message.{0,30}(?:role|alternat)/i.test(text)) return 'history_protocol';
  if (/quota|billing|credit|balance|payment/i.test(text) || Number(error.status) === 402) return 'quota';
  if ([401,403].includes(Number(error.status))) return 'authentication';
  if (/model.{0,30}(?:not.found|unsupported|unavailable)/i.test(text)) return 'model_unavailable';
  if (/parameter|schema|invalid.request/i.test(text)) return 'request_parameters';
  return 'unknown';
}

function classifyLLMError(error = {}) {
  const status = Number(error.status || 0);
  const code = String(error.code || '').trim().toUpperCase();
  const body = typeof error.response_body === 'string' ? error.response_body : JSON.stringify(error.response_body || '');
  const fingerprint = `${code} ${body} ${String(error.message || '')}`.toLowerCase();
  if (code === 'CONTEXT_BUDGET_EXCEEDED') return {
    category: 'action_required', retryable: false, publicCode: code,
    publicMessage: '当前任务超出模型上下文预算，已保留进度。请换用更大上下文的模型后继续。',
  };
  const actionRequired = status === 402
    || status === 401
    || status === 403
    || ['LLM_API_KEY_MISSING', 'LLM_BASE_URL_MISSING', 'LLM_MODEL_MISSING'].includes(code)
    || /insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|insufficient)|billing|credit|balance|invalid[_\s-]*(?:api[_\s-]*)?key|authentication|permission|model[_\s-]*(?:not[_\s-]*found|unavailable|access)/i.test(fingerprint);
  if (actionRequired) return {
    category: 'action_required', retryable: false, publicCode: 'LLM_ACTION_REQUIRED',
    publicMessage: '模型服务需要处理，请检查额度、API Key、权限或模型配置后继续任务。',
  };
  if ([400, 404, 413, 422].includes(status)) return {
    category: 'action_required', retryable: false, publicCode: 'LLM_REQUEST_REJECTED',
    publicMessage: `模型拒绝了当前请求（HTTP ${status}），已保留任务进度。请检查模型协议、上下文长度或更换兼容模型后继续。`,
  };
  const transportCodes = new Set(['LLM_REQUEST_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
  let transportError = error;
  let transportFailure = false;
  for (let depth = 0; transportError && depth < 5; depth += 1) {
    if (transportCodes.has(String(transportError.code || '').toUpperCase())) transportFailure = true;
    transportError = transportError.cause;
  }
  const retryable = transportFailure
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

async function runAgentLoop({ sessionId, taskId = null, turnFrame = null, runId = null, llmConfig, onStream, signal, approvalMode = 'auto_confirm', resumeInteractionId = null, initialImages = [], currentImageRecognition = null, preparedMcpContext = null, llmRetryDelayMs = null, llmRetryWait = null } = {}) {
  let session = getSession(sessionId);
  const config = getEffectiveConfig();
  const runtimeMode = getAgentRuntimeMode();
  let effectiveFrame = turnFrame || (agentRuntimeAtLeast('shadow', runtimeMode) ? getSessionTurnFrame(sessionId) : null);
  const { resolveFailedFileContinuation, formatFailedFileContinuation } = require('./agentTaskContinuation');
  const fileContinuation = effectiveFrame?.facts?.failed_file_continuation || resolveFailedFileContinuation(session);
  const completionFrame = fileContinuation
    ? { intent: { completion_criteria: { ...effectiveFrame?.intent?.completion_criteria, requires_write: true, requires_applied_write: normalizeApprovalMode(approvalMode) === 'auto_confirm', requires_answer: true } } }
    : null;
  const rawEmit = typeof onStream === 'function' ? onStream : () => {};
  const emit = (event) => {
    // 时间线写入失败不能掩盖主任务结果；正常路径下每个用户可见的 v2 事件
    // 都会先脱敏落库，再交给 SSE。断线后可用同一批事件重建工具链。
    const safeEvent = sanitizeRunEvent(event);
    if (!safeEvent) return;
    try {
      const eventId = require('./db').getDb().transaction(() => {
        const id = recordRunEvent({ sessionId, runId, event: safeEvent });
        if (safeEvent.type === 'final' && safeEvent.status === 'completed') updateSessionStatus(sessionId, 'completed');
        return id;
      })();
      broadcastRunEvent({ sessionId, runId, event: safeEvent, eventId });
    } catch (error) {
      if (safeEvent.type === 'final') throw error;
    }
    rawEmit(safeEvent);
  };
  const normalizedApprovalMode = normalizeApprovalMode(approvalMode);

  const styleContext = !agentRuntimeAtLeast('profile', runtimeMode) || effectiveFrame?.intent?.task_kind === 'file_write'
    ? await loadStyleContext(session)
    : null;
  const resourceContext = agentRuntimeAtLeast('context', runtimeMode) ? null : buildConversationResourceContext(session.conversation_id);
  scanAllSkills();
  const skillCatalog = !agentRuntimeAtLeast('profile', runtimeMode) || effectiveFrame?.intent?.source_policy?.local_skills !== 'forbidden'
    ? eligibleSkillSummaries(session.goal, session.skill_mentions || [])
    : [];
  const mcpSelection = session.mcp_selection || { mode: 'off' };
  const mcpContext = preparedMcpContext || await prepareMcpTools(
    mcpSelection, session.goal, session.mcp_session_permissions || {}, { forceRefresh: true },
  );
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
      globalAgentContext: buildGlobalAgentContext(session.goal, { memoryTokens: restricted ? 800 : Math.min(4800, Math.floor(basePromptOptions.contextWindowTokens * 0.08)) }),
      taskMaterialContext: [projectedContext?.taskMaterialContext || [attachmentContext, webSearchContext, researchReceiptContext].filter(Boolean).join('\n\n'), require('./agentMaterials').materialDirectoryPrompt(session)].filter(Boolean).join('\n\n'),
      taskMaterials: projectedContext?.taskMaterials || [
        attachmentContext ? { sourceType: 'attachment', sourceId: `conversation-${session.conversation_id}-attachments`, content: attachmentContext } : null,
        webSearchContext ? { sourceType: 'web', sourceId: `conversation-${session.conversation_id}-web`, content: webSearchContext } : null,
        researchReceiptContext ? { sourceType: 'knowledge', sourceId: `session-${session.id}-research-receipts`, content: researchReceiptContext } : null,
      ].filter(Boolean),
    };
    const options = restricted ? {
      ...promptOptions,
      styleContext: null,
      globalAgentContext: { ...promptOptions.globalAgentContext, soul: '', style: '', writing: false },
      resourceContext: null,
      skillCatalog: [],
      mcpInstructions: [],
      taskMaterials: agentRuntimeAtLeast('context', runtimeMode)
        ? promptOptions.taskMaterials
        : promptOptions.taskMaterials.filter((item) => item.sourceType === 'attachment'),
      taskMaterialContext: require('./agentMaterials').materialDirectoryPrompt(session),
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
  let checkpoint;
  try { checkpoint = await migrateCheckpointResults(loadMessagesCheckpoint(session.id), session); }
  catch (error) {
    updateSessionStatus(session.id, 'failed');
    emit({ type: 'final', text: error.message, status: 'failed', reason: 'checkpoint_result_archive_failed' });
    return { status: 'failed', reason: 'checkpoint_result_archive_failed' };
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
      // 审批/确认结果可能刚由恢复入口写入，必须再次经过同一归档契约。
      try {
        const projected = await migrateCheckpointResults({ ...checkpoint, toolResults: restoredResults }, session);
        restoredResults.splice(0, restoredResults.length, ...projected.toolResults);
      } catch (error) {
        updateSessionStatus(session.id, 'failed');
        emit({ type: 'final', text: error.message, status: 'failed', reason: 'checkpoint_result_archive_failed' });
        return { status: 'failed', reason: 'checkpoint_result_archive_failed' };
      }
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
    const conversationContext = await buildConversationContext({ session, llmConfig, signal, remainingTokens: Math.max(0, Number(session.token_budget_total || llmConfig?.llmContextWindowTokens || config.llmContextWindowTokens || 60000) - getSessionUsage(session.id).total_tokens), onUsage: (usage) => recordRunUsage({ sessionId: session.id, runId, sourceType: 'conversation_summary', usage, usageSource: 'provider' }) });
    if (conversationContext.degraded) emit({ type: 'progress', stage: 'context_degraded', text: '较早对话摘要暂不可用，原始记录仍可按需查询。' });
    messages = [{
      role: 'user',
      content: buildInitialUserContent(session, {
        recentConversationContext: [conversationContext.text, formatFailedFileContinuation(fileContinuation)].filter(Boolean).join('\n\n'),
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
    let emittedDraft = '';
    const emitResponseDraft = (rawText, complete = false) => {
      const text = require('./agentToolPolicy').redactStreamingText(rawText, { complete });
      if (text === emittedDraft && text) return;
      const append = Boolean(text) && text.startsWith(emittedDraft);
      emit({
        type: append ? 'assistant_text_delta' : 'assistant_text_replace',
        text: append ? text.slice(emittedDraft.length) : text,
        loop_index: loopIndex,
        execution_segment_id: activeExecutionSegment?.id,
        segment_sequence_no: activeExecutionSegment?.sequence_no,
      });
      emittedDraft = text;
    };
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

    // Historical soft_limit/hard_limit fields remain for storage compatibility.
    // Completion and independent budget/safety checks govern execution, not round count.
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
    const compactedMessages = compactMessages(messages, requestPressure >= 0.72 ? Math.floor(contextWindow * 0.6) : contextWindow);
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
    emitResponseDraft('');
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
        onVisibleText: () => {
          // 文本块可能先于 tool_use 到达。响应完成前不能把它认作正式答案。
          // 保留 Provider 流读取与取消能力，只在下方分类后发布可见文字。
        },
      }, DEFAULT_LLM_RETRY_LIMIT, {
        ...(typeof llmRetryDelayMs === 'function' ? { retryDelayMs: llmRetryDelayMs } : {}),
        ...(typeof llmRetryWait === 'function' ? { waitForRetry: llmRetryWait } : {}),
        onRetry: ({ attempt, maxRetries, delayMs, classification }) => {
          emitResponseDraft('');
          recordRequestRetry(activeRequestWindow.id, attempt, classification);
          emit({
            type: 'progress',
            stage: 'llm_retry',
            text: `模型请求暂时失败，将在 ${Math.ceil(delayMs / 1000)} 秒后进行第 ${attempt}/${maxRetries} 次重试。`,
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
      const classification = classifyLLMError(error);
      // Never persist provider bodies: they can echo credentials, note contents or signed URLs.
      require('./logger').createLogger('agent.loop').warn('agent.llm.request_failed', {
        session_id: session.id, request_window_id: activeRequestWindow?.id,
        llm_config_id: llmConfig?.llmConfigId || llmConfig?.id || null,
        http_status: Number(error.status || 0), error_code: classification.publicCode,
        reason: llmFailureReason(error),
        failure_code: /^[A-Z][A-Z0-9_]{0,79}$/.test(String(error.code || '')) ? error.code : 'UNKNOWN',
        error_category: classification.category, retry_attempts: Number(error.retryAttempts || 0),
      });
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

    if (!isResumingDispatch) {
      // A tool prelude belongs to the execution timeline; a final answer stays
      // only after completion checks. Never accumulate previous tool preludes.
      // 正式正文只在完成检查后通过 final 发布，避免草稿与最终消息双重挂载。
      emitResponseDraft('');
      if (toolUseBlocks.length && thinking) emit({
        type: 'progress', stage: 'model_progress', text: thinking,
        loop_index: loopIndex,
        execution_segment_id: activeExecutionSegment.id,
        segment_sequence_no: activeExecutionSegment.sequence_no,
        request_window_no: activeRequestWindow?.window_no || 0,
      });
    }

    if (isGoalAchieved(stopReason, toolUseBlocks)) {
      logToolCall({ sessionId: session.id, loopIndex, toolName: null, toolInput: null, toolResult: null, thinking, status: 'success', durationMs: 0 });
      if (agentRuntimeAtLeast('enforced', runtimeMode) || fileContinuation) {
        const completion = evaluateCompletion({
          sessionId: session.id,
          frame: completionFrame || effectiveFrame,
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
      const memoryDisplayName = toolUse.input?.file === 'memory' && ['read_global_agent_file', 'update_global_agent_file'].includes(toolUse.name)
        ? (toolUse.name === 'read_global_agent_file' ? '读取记忆' : '更新记忆') : '';
      const invocationKey = `${session.id}:${toolUse.id}`;
      const externalMcp = Boolean(mcpContext.map?.[toolUse.name]);
      const replayPolicy = toolReplayPolicy(toolUse.name, { externalMcp });
      emit({
        type: 'progress',
        stage: 'tool_start',
        text: `正在执行 ${toolUse.name}。`,
        tool_name: toolUse.name,
        tool_display_name: memoryDisplayName || toolDisplayName,
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
          operation_set: existingOperationSet,
          ...(existingOperationSet.revision_type === 'file_revision' ? { file_id: existingOperationSet.file_id, file_path: existingOperationSet.revision_file_path } : {}),
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
      if (!INLINE_READ_TOOLS.has(toolUse.name) && !recoveredInvocation) {
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
      if (!INLINE_READ_TOOLS.has(toolUse.name)) {
        modelVisibleResult = projectToolResultForModel({
          useReceipt: true,
          toolName: toolUse.name,
          result,
          artifact: resultArtifact,
        });
      }
      const durationMs = Date.now() - startedAt;
      const failed = Boolean(result?.error);
      if (externalMcp && !failed && !recoveredInvocation) {
        require('./agentResearch').recordMcpWebEvidence({ session, toolName: mcpContext.map[toolUse.name].toolName, result: rawResult, query: String(toolUse.input?.query || '') });
      }
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
            artifact_status: resultArtifact?.status || (INLINE_READ_TOOLS.has(toolUse.name) ? 'inline' : 'archive_failed'),
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
        tool_display_name: memoryDisplayName || toolDisplayName,
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

      if (!INLINE_READ_TOOLS.has(toolUse.name) && resultArtifact?.status !== 'ready') {
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
        if (detectDeadloop(session.id, toolUse.name, result, toolUse.input || {})) {
          updateExecutionSegment(activeExecutionSegment.id, { status: 'failed', completed: true });
          updateSessionStatus(session.id, 'failed');
          emit({ type: 'final', text: '同一工具连续三次使用相同参数且未获得新结果，任务已停止以避免无效重复。', status: 'failed', reason: 'deadloop_detected', tool_name: toolUse.name, loop_index: loopIndex, usage: getSessionUsage(session.id) });
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
            // 应用按补丁逐项写入，失败不能否认此前批次或本批已完成的写入。
            const failedSet = getOperationSetById(result.operation_set_id);
            const appliedCount = (failedSet?.patches || []).filter(patch => ['applied', 'auto_applied'].includes(patch.status)).length;
            const unfinishedCount = Math.max(1, (failedSet?.patches || []).filter(patch => ['pending', 'failed'].includes(patch.status)).length);
            const failureSummary = `本批已应用 ${appliedCount} 项，${unfinishedCount} 项未完成。`;
            const failureResult = {
              ...result,
              ...previewResult,
              success: false,
              error: previewResult.error || 'PREVIEW_APPLY_FAILED',
              operation_set: failedSet,
              applied_count: appliedCount,
              unfinished_count: unfinishedCount,
            };
            const failureArtifact = await archiveToolResult({
              conversationId: session.conversation_id,
              sessionId: session.id,
              taskId,
              turnFrameId: effectiveFrame?.id,
              toolCallId: toolUse.id,
              invocationKey,
              toolName: toolUse.name,
              actor: 'model',
              result: failureResult,
              replace: true,
            });
            const conflictReason = String(previewResult.conflicting_files?.[0]?.reason || previewResult.error || '');
            const failureHint = /FILE_ALREADY_EXISTS|FOLDER_ALREADY_EXISTS|目标文件已存在/.test(conflictReason)
              ? '目标路径已存在。'
              : /FILE_NOT_FOUND|ENOENT|file not found/.test(conflictReason)
                ? '原路径已不存在，文件可能已被重命名或移动。'
                : /STALE|OLD_NOT_FOUND/.test(conflictReason)
                  ? '文件内容已变化，需要重新生成预览。'
                  : '请在修改详情中核对文件状态。';
            emit({
              type: 'progress', stage: 'tool_done',
              tool_name: toolUse.name, tool_display_name: toolDisplayName,
              loop_index: loopIndex, tool_index: toolIndex,
              execution_segment_id: activeExecutionSegment.id,
              segment_sequence_no: activeExecutionSegment.sequence_no,
              failed: true,
              result_summary: { operation_set_id: result.operation_set_id, preview_generated: true, apply_success: false, message: failureHint + failureSummary, result_ref: failureArtifact?.result_ref || null },
            });
            emit({
              type: 'artifact',
              artifact_type: 'operation_set',
              operation_set_id: result.operation_set_id,
              task_change_set_id: changeSet.id,
              task_change_set_version: changeSet.version,
              status: 'apply_failed',
              message: failureHint + failureSummary,
              loop_index: loopIndex,
              execution_segment_id: activeExecutionSegment.id,
              segment_sequence_no: activeExecutionSegment.sequence_no,
            });
            updateExecutionSegment(activeExecutionSegment.id, { status: 'failed', completed: true });
            updateSessionStatus(session.id, 'failed');
            markTaskChangeSetFinished(session.id, 'failed');
            emit({
              type: 'final',
              text: `预览已生成，但本批次未完成应用。${failureHint}${failureSummary}已保存的修改会保留，请查看下方修改详情。${failureArtifact?.status === 'ready' ? '' : '应用结果记录保存失败，请同时核对实际文件。'}`,
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

        {
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
        if (resultArtifact?.status !== 'ready') {
          updateExecutionSegment(activeExecutionSegment.id, { status: 'failed', completed: true });
          updateSessionStatus(session.id, 'failed');
          emit({ type: 'final', text: '文件操作已经执行，但完整结果无法安全保存，后续步骤已停止。请根据文件预览和执行记录核实结果。', status: 'failed', reason: 'tool_result_payload_unavailable', tool_name: toolUse.name, loop_index: loopIndex, operation_set_id: result.operation_set_id });
          return { status: 'failed', reason: 'tool_result_payload_unavailable', operation_set_id: result.operation_set_id };
        }
        const mergedModelVisibleResult = projectToolResultForModel({ useReceipt: true, toolName: toolUse.name, result: mergedPreviewResult, artifact: resultArtifact });
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
          : (Array.isArray(result.operation_set?.patches) ? result.operation_set.patches : (getOperationSetById(result.operation_set_id)?.patches || []));
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
