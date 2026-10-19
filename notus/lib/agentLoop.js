const { completeToolChat } = require('./llm');
const { getEffectiveConfig } = require('./config');
const { getStyleContext } = require('./style');
const { buildInitialUserMessage } = require('./agentLoopPrompt');
const { renderAgentLoopPrompt } = require('./prompt/agent-loop/render');
const { buildConversationContext } = require('./agentConversationContext');
const { compactMessages, evictOldToolResults, migrateCheckpointResults, INLINE_READ_TOOLS } = require('./agentMessageProjection');
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
const { estimateChatRequestTokens, resolveLlmBudget, trimTextToTokenBudget } = require('./llmBudget');
const { getSessionUsage, isCancellationRequested, recordRunUsage } = require('./agentControlPlane');
const { sha256 } = require('./files');
const {
  buildInteractionAnswerSummary,
  getInteractionById,
} = require('./conversationInteractions');
const { eligibleSkillSummaries, scanAllSkills } = require('./skills');
const { prepareMcpTools } = require('./mcp');
const { buildGlobalAgentContext } = require('./globalAgentFiles');
const {
  recordToolReceipt,
  recordWriteReceipt,
} = require('./agentResearch');
const { getSessionTurnFrame } = require('./agentTurnFrames');
const { projectAgentContext } = require('./agentContextProjector');
const {
  MAX_AUTO_COMPACTS_PER_RUN,
  autoCompactTaskMessages,
  autoCompactTriggerTokens,
} = require('./agentTaskCompaction');
const { projectToolDefinitions, requiredToolNames, toolReplayPolicy } = require('./agentToolProfile');
const { getInvocationState, listRuntimeFacts, listUnknownToolCalls, recordRuntimeFact, recordToolCallPrepared, recordToolCallTerminal, shouldTreatToolFailureAsOutcomeUnknown } = require('./agentRuntimeFacts');
const { archiveToolResult, projectToolResultForModel, readArtifactResultForRuntime } = require('./agentToolResultStore');
const { evaluateCompletion } = require('./agentCompletionEvaluator');

const DEFAULT_LLM_RETRY_LIMIT = 5;
const DEFAULT_LLM_RETRY_DELAY_MS = 30_000;

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
    || [408, 425, 429, 500, 502, 503, 504, 529].includes(status)
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
      : '模型请求失败，请检查任务和模型配置后继续。',
  };
}

async function callLLMWithRetry(request, maxRetries = DEFAULT_LLM_RETRY_LIMIT, options = {}) {
  let lastError;
  const retryWait = typeof options.waitForRetry === 'function' ? options.waitForRetry : waitForRetry;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await completeToolChat({ ...request, requestAttempt: attempt + 1 });
    } catch (error) {
      lastError = error;
      const classification = classifyLLMError(error);
      if (classification.retryable && attempt < maxRetries) {
        const delayMs = Math.max(0, Number(options.retryDelayMs?.(attempt) ?? DEFAULT_LLM_RETRY_DELAY_MS));
        options.onRetry?.({ attempt: attempt + 1, maxRetries, delayMs, classification, error });
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
  result = {},
} = {}) {
  if (toolName === 'preview_file_revision') {
    if (approvalMode === 'auto_confirm' && applied) {
      const warnings = Array.isArray(result?.safety?.warnings) ? result.safety.warnings.filter(Boolean) : [];
      return warnings.length > 0
        ? `全文修订已自动应用；请注意：${warnings.join('；')}。可在下方 diff 卡片中核对或回滚。`
        : '全文修订已自动应用，可在下方 diff 卡片中查看或回滚。';
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
  if (interaction.kind === 'resource_approval' && interaction.status === 'failed') {
    return { isError: false, content: JSON.stringify({ interaction_id: interaction.id, resource_result: interaction.response || { error: 'RESOURCE_ACTION_FAILED', message: '资源操作失败；请说明原因，不要重复提交旧确认卡。' } }) };
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
  let effectiveFrame = turnFrame || getSessionTurnFrame(sessionId);
  const { resolveFailedFileContinuation, formatFailedFileContinuation } = require('./agentTaskContinuation');
  const fileContinuation = effectiveFrame?.facts?.failed_file_continuation || resolveFailedFileContinuation(session);
  const completionFrame = fileContinuation || effectiveFrame?.intent?.completion_criteria?.requires_write
    ? { ...effectiveFrame, intent: { ...effectiveFrame?.intent, completion_criteria: { ...effectiveFrame?.intent?.completion_criteria, requires_write: true, requires_applied_write: normalizeApprovalMode(approvalMode) === 'auto_confirm', requires_answer: true } } }
    : null;
  const rawEmit = typeof onStream === 'function' ? onStream : () => {};
  const emit = (event) => {
    // 时间线写入失败不能掩盖主任务结果；正常路径下每个用户可见的 v2 事件
    // 都会先脱敏落库，再交给 SSE。断线后可用同一批事件重建工具链。
    const linkedEvent = event?.type === 'final' && typeof event.text === 'string'
      ? { ...event, text: require('./agentFileLinkResolver').safeNormalizeFinalAgentFileLinks(event.text, sessionId) }
      : event;
    const safeEvent = sanitizeRunEvent(linkedEvent);
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

  const styleContext = effectiveFrame?.intent?.task_kind === 'file_write'
    ? await loadStyleContext(session)
    : null;
  scanAllSkills();
  const skillCatalog = effectiveFrame?.intent?.source_policy?.local_skills !== 'forbidden'
    ? eligibleSkillSummaries(session.goal, session.skill_mentions || [])
    : [];
  const mcpSelection = session.mcp_selection || { mode: 'off' };
  const mcpContext = preparedMcpContext || (effectiveFrame?.intent?.verification?.network_allowed === false
    ? { tools: [], availableTools: [], map: {}, instructions: [] }
    : await prepareMcpTools(mcpSelection, session.goal, session.mcp_session_permissions || {}, { forceRefresh: true }));
  const allTools = buildToolDefinitions(session, { mcpTools: mcpContext.tools });
  const availableMcpTools = mcpContext.availableTools || mcpContext.tools || [];
  function exposeDiscoveredTools(result) {
    for (const item of result?.tools || []) {
      const definition = availableMcpTools.find((tool) => tool.name === item.name);
      if (definition && !allTools.some((tool) => tool.name === definition.name)) allTools.push(definition);
    }
  }

  const tools = projectToolDefinitions(allTools, effectiveFrame);
  let dispatchToolDefinitions = tools;
  session = setSessionRuntimeVersions(session.id, {
    promptVersion: config.agentPromptVersion || 'agent-loop-v2',
    toolsetVersion: sha256(JSON.stringify(tools)).slice(0, 16),
    tokenBudgetTotal: Number(llmConfig?.llmContextWindowTokens || config.llmContextWindowTokens || 200000),
  });
  const basePromptOptions = {
    styleContext,
    resourceContext: null,
    skillCatalog,
    mcpInstructions: [...(mcpContext.instructions || []), ...(mcpContext.diagnostics || []).map((item) => ({ server: item.server, text: `本次 MCP 发现状态：${item.code}。${item.message}` }))],
    intentContract: effectiveFrame ? require('./agentSemanticRuntime').formatTurnFrameForPrompt(effectiveFrame) : '',
    contextWindowTokens: Number(llmConfig?.llmContextWindowTokens || config.llmContextWindowTokens || 200000),
  };
  const renderRequestPrompt = ({ restricted = false, completionCorrection = '' } = {}) => {
    effectiveFrame = getSessionTurnFrame(session.id) || effectiveFrame;
    const projectedContext = projectAgentContext(effectiveFrame);
    const promptOptions = {
      ...basePromptOptions,
      globalAgentContext: buildGlobalAgentContext(session.goal, { memoryTokens: restricted ? 800 : Math.min(4800, Math.floor(basePromptOptions.contextWindowTokens * 0.08)) }),
      taskMaterialContext: [projectedContext?.taskMaterialContext || '', require('./agentMaterials').materialDirectoryPrompt(session)].filter(Boolean).join('\n\n'),
      taskMaterials: projectedContext?.taskMaterials || [],
    };
    const options = restricted ? {
      ...promptOptions,
      styleContext: null,
      globalAgentContext: { ...promptOptions.globalAgentContext, soul: '', style: '', writing: false },
      resourceContext: null,
      skillCatalog: [],
      mcpInstructions: [],
      taskMaterials: promptOptions.taskMaterials,
      taskMaterialContext: require('./agentMaterials').materialDirectoryPrompt(session),
      completionCorrection,
    } : { ...promptOptions, completionCorrection };
    return renderAgentLoopPrompt(session, options);
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
  // Restore only previously selected names against the current authorized catalog.
  const priorCalls = new Map();
  for (const message of [...(checkpoint?.messages || []), { content: checkpoint?.lastResponseContent || [] }, { content: checkpoint?.toolResults || [] }]) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') {
        priorCalls.set(block.id, block.name);
        exposeDiscoveredTools({ tools: [{ name: block.name }] });
      }
      if (block.type === 'tool_result' && priorCalls.get(block.tool_use_id) === 'list_available_mcp_tools') {
        try { exposeDiscoveredTools(JSON.parse(block.content)); } catch {}
      }
    }
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
              is_error: Boolean(questionCardResult ? questionCardResult.isError : resumeToolResult ? resumeToolResult.is_error : item.is_error),
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
        messages.push({ role: 'assistant', content: checkpoint.lastResponseContent || [],
          ...(checkpoint.lastResponseProviderState ? { providerState: checkpoint.lastResponseProviderState } : {}) });
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
    const conversationContext = await buildConversationContext({ session, llmConfig, signal, remainingTokens: Math.max(0, resolveLlmBudget(llmConfig, 'agent_loop').hardInputBudgetTokens - getSessionUsage(session.id).total_tokens), onUsage: (usage) => recordRunUsage({ sessionId: session.id, runId, sourceType: 'conversation_summary', usage, usageSource: 'provider' }) });
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

  const imageCache = new Map();
  let loopIndex = Number(session.loop_count || 0);
  let noToolRounds = 0;
  let budgetRestricted = false;
  let autoCompactCount = 0;
  const repeatedCalls = new Map();
  for (const fact of listUnknownToolCalls(session.id)) {
    const unknownName = priorCalls.get(fact.tool_call_id) || fact.payload.tool_name;
    if (!unknownName) continue;
    const unknownDigest = /^[a-f0-9]{64}$/.test(fact.prepared.input_digest || '') ? fact.prepared.input_digest : '*';
    repeatedCalls.set(`${unknownName}:${unknownDigest}`, { blocked: 0, receipt: {
      tool_name: fact.payload.tool_name, status: 'failed', outcome_unknown: true,
      error_code: fact.payload.error_code || 'TOOL_OUTCOME_UNKNOWN',
      message: fact.payload.error_message || '该调用没有留下可确认的执行结果，不能自动重放。',
      result_ref: fact.payload.result_ref || null,
      error_pointers: [''],
      read_hint: fact.payload.result_ref ? '用 read_tool_result 读取已有错误；由你说明原因与继续步骤，不向用户询问工具是否成功。' : '没有已保存的结果正文。根据执行记录说明限制，不推断成功，不向用户询问工具是否成功。',
    } });
  }
  // 恢复种子除 outcome_unknown 外，还纳入历史 tool_call_blocked 事实：
  // 崩溃后内存 repeatedCalls 丢失时，被拦截过的相同调用也不会真实重放。
  // 缺少可靠 input_digest 的旧事实不能按工具名整体拦截，直接跳过。
  for (const fact of listRuntimeFacts({ sessionId: session.id, factTypes: ['tool_call_blocked'] })) {
    const blockedName = String(fact.payload?.tool_name || '');
    if (!blockedName) continue;
    if (!/^[a-f0-9]{64}$/.test(String(fact.payload?.input_digest || ''))) continue;
    const blockedKey = `${blockedName}:${fact.payload.input_digest}`;
    if (repeatedCalls.has(blockedKey)) continue;
    repeatedCalls.set(blockedKey, { blocked: 0, receipt: {
      tool_name: blockedName, status: 'failed', error_code: 'TOOL_REPEAT_BLOCKED',
      not_executed: true,
      message: '该调用此前已被运行时拦截（相同调用重复出现）。请先读取已有结果，按实际原因更正参数或方法后再继续，不要原样重放。',
      result_ref: fact.payload?.result_ref || null,
    } });
  }
  let explainRepeatedStop = false;
  let completionCorrection = '';
  let completionCorrectionCount = 0;
  // 自动应用预览后，模型通常还会生成一轮面向用户的总结。保留最近一次
  // 变更集，才能把最终消息和可回看的 Diff 卡准确关联起来。
  let latestOperationSetId = null;
  let activeExecutionSegment = null;
  let activeRequestWindow = null;
  const recordedModelFailures = new WeakMap();
  const recordModelFailure = (error, classification, retryAttempt = 0, loopIndex = 0) => {
    if (recordedModelFailures.has(error)) return recordedModelFailures.get(error);
    const diagnostics = require('./llmDiagnostics').buildLlmFailureDiagnostics(error, { ...config, ...llmConfig });
    recordedModelFailures.set(error, diagnostics);
    try { logToolCall({
      sessionId: session.id, loopIndex, toolName: '__llm_request__', status: 'failed',
      toolInput: { request_window_id: activeRequestWindow?.id, llm_config_id: llmConfig?.llmConfigId || llmConfig?.id || null, retry_attempt: retryAttempt },
      toolResult: { error: classification.publicCode, message: classification.publicMessage, diagnostics },
      durationMs: diagnostics.request?.duration_ms || 0,
    }); } catch { /* Diagnostic storage must not interrupt checkpoint recovery. */ }
    try { require('./logger').createLogger({ scope: 'agent.loop' }).warn('agent.llm.request_failed', {
      session_id: session.id, request_window_id: activeRequestWindow?.id,
      llm_config_id: llmConfig?.llmConfigId || llmConfig?.id || null,
      http_status: diagnostics.http_status, error_code: classification.publicCode,
      reason: llmFailureReason(error), error_category: classification.category,
      retry_attempts: retryAttempt, diagnostics,
      message: classification.publicMessage,
    }); } catch { /* The SSE event still carries sanitized diagnostics. */ }
    return diagnostics;
  };
  let pendingDispatch = checkpoint?.phase === 'dispatching_tools' && !checkpoint.appliedToolUseId
    ? {
      content: Array.isArray(checkpoint.lastResponseContent) ? checkpoint.lastResponseContent : [],
      providerState: checkpoint.lastResponseProviderState,
      toolResults: Array.isArray(checkpoint.toolResults) ? checkpoint.toolResults : [],
      nextToolIndex: Math.max(0, Number(checkpoint.nextToolIndex || 0)),
      executionSegmentId: checkpoint.executionSegmentId,
      llmRequestWindowId: checkpoint.llmRequestWindowId,
    }
    : null;
  let currentDispatchContent = pendingDispatch?.content || null;
  let currentDispatchProviderState = pendingDispatch?.providerState || null;
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
      lastResponseProviderState: currentDispatchProviderState,
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

  const resourceResultVersions = new Map();
  const resourceInteractions = () => require('./conversationInteractions').listInteractionsByConversation(session.conversation_id, { statuses: ['pending', 'processing', 'answered', 'failed', 'cancelled'] }).filter(item => item.kind === 'resource_approval' && Number(item.payload?.agent_session_id) === Number(session.id));
  // 注入模型的资源回执正文要有长度上限：异常超长的 result 会撑爆上下文。
  // 截断只作用于注入文本，完整响应仍保存在 interaction 上，去重版本键不受影响。
  const RESOURCE_RESULT_TEXT_LIMIT = 1600;
  const truncateResourceResponse = (response) => {
    let serialized = '';
    try { serialized = JSON.stringify(response ?? null) ?? ''; } catch { return { truncated: true, preview: '', original_chars: 0, message: '资源结果无法序列化，已省略正文。' }; }
    if (serialized.length <= RESOURCE_RESULT_TEXT_LIMIT) return response;
    return {
      truncated: true,
      preview: serialized.slice(0, RESOURCE_RESULT_TEXT_LIMIT),
      original_chars: serialized.length,
      message: '资源结果过长已截断；完整结果以持久化回执为准。',
    };
  };
  const appendResourceResults = () => {
    let changed = false;
    for (const item of resourceInteractions().filter(item => ['answered', 'failed', 'cancelled'].includes(item.status))) {
      const version = `${item.status}:${item.updated_at}`;
      if (resourceResultVersions.get(item.id) === version) continue;
      resourceResultVersions.set(item.id, version);
      messages.push({ role: 'user', content: [{ type: 'text', text: `资源确认执行回执（运行时提供）：${JSON.stringify({ interaction_id: item.id, action: item.payload.action, status: item.status, result: truncateResourceResponse(item.response) })}。根据真实结果继续；失败或取消不得声称已执行，不要重复申请相同操作。` }] });
      changed = true;
    }
    return changed;
  };
  while (true) {
    appendResourceResults();
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
      response = { content: pendingDispatch.content, providerState: pendingDispatch.providerState, stop_reason: 'tool_use' };
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

    // 累计 token 预算闸门已移除（REQ-20261010-007 收口）：预算不再是任何形式的
    // 停止或扩展触发器，成本核算完全依赖 agent_run_usage 逐笔记录与 final 用量。
    // 单次请求安全由 llmBudget 硬预算与两级上下文压缩保障。历史 soft_limit/
    // hard_limit/token_budget_total 字段仅作存量兼容，Loop 不再读写。
    const contextWindow = Number(llmConfig?.llmContextWindowTokens || config.llmContextWindowTokens || 200000);
    const normalPrompt = renderRequestPrompt({ completionCorrection });
    const normalTools = projectToolDefinitions(allTools, effectiveFrame);
    const preRequestEstimate = estimateChatRequestTokens({ system: normalPrompt.text, messages, tools: normalTools });
    const preRequestPressure = preRequestEstimate / Math.max(contextWindow, 1);
    // Claude Code 式两级压缩。第一级 microcompact：把较早的大段读取窗口驱逐为
    // 引用回执；第二级 auto-compact：仍逼近预算时用一次摘要请求把较早轮次转为
    // 结构化摘要后继续任务。摘要失败或收益不足才回退整体机械压缩（原路径）。
    let compaction = null;
    if (preRequestPressure >= 0.72 && !explainRepeatedStop && autoCompactCount < MAX_AUTO_COMPACTS_PER_RUN) {
      const evictedMessages = evictOldToolResults(messages, Math.floor(contextWindow * 0.6));
      if (estimateChatRequestTokens({ messages: evictedMessages }) >= autoCompactTriggerTokens(llmConfig)) {
        emit({
          type: 'progress',
          stage: 'context_compacting',
          text: '较早执行过程较长，正在生成结构化摘要以继续任务。',
          loop_index: loopIndex,
          execution_segment_id: activeExecutionSegment.id,
          segment_sequence_no: activeExecutionSegment.sequence_no,
        });
        compaction = await autoCompactTaskMessages({
          messages: evictedMessages,
          llmConfig,
          signal,
          autoCompactCount,
          onUsage: (usage) => recordRunUsage({ sessionId: session.id, runId, sourceType: 'task_compaction', usage, usageSource: 'provider' }),
        });
        if (compaction.performed) {
          messages = compaction.messages;
          autoCompactCount += 1;
          emit({
            type: 'progress',
            stage: 'context_compacted',
            text: `已压缩任务上下文：约 ${compaction.tokensBefore} → ${compaction.tokensAfter} tokens，较早过程已转为摘要，完整工具结果仍可按引用读取。`,
            loop_index: loopIndex,
            result_summary: {
              performed: true,
              context_before: compaction.tokensBefore,
              context_after: compaction.tokensAfter,
              middle_exchange_count: compaction.middleExchangeCount,
              tail_exchange_count: compaction.tailExchangeCount,
            },
            execution_segment_id: activeExecutionSegment.id,
            segment_sequence_no: activeExecutionSegment.sequence_no,
          });
        } else {
          emit({
            type: 'progress',
            stage: 'context_compacted',
            text: compaction.reason === 'summary_failed'
              ? '上下文压缩未执行：摘要生成失败，已保留原上下文并按既有压缩方式继续。'
              : '上下文压缩未执行：未满足压缩条件，按既有压缩方式继续。',
            loop_index: loopIndex,
            result_summary: { performed: false, reason: compaction.reason },
            execution_segment_id: activeExecutionSegment.id,
            segment_sequence_no: activeExecutionSegment.sequence_no,
          });
        }
      }
    }
    const compactedMessages = compaction?.performed
      ? compactMessages(messages, contextWindow)
      : compactMessages(messages, preRequestPressure >= 0.72 ? Math.floor(contextWindow * 0.6) : contextWindow);
    const estimatedRequestTokens = estimateChatRequestTokens({ system: normalPrompt.text, messages, tools: normalTools });
    const requestPressure = estimatedRequestTokens / Math.max(contextWindow, 1);
    const nextBudgetRestricted = requestPressure >= 0.85;
    if (nextBudgetRestricted && !budgetRestricted) {
      emit({ type: 'progress', stage: 'budget_restricted', text: '本次请求上下文接近模型上限，已停止加载可选材料和可选工具。', loop_index: loopIndex });
    }
    budgetRestricted = nextBudgetRestricted;
    const requiredNames = requiredToolNames(effectiveFrame?.intent || {});
    if (String(mcpSelection.mode || 'off') !== 'off') {
      Object.keys(mcpContext.map || {}).forEach((name) => requiredNames.add(name));
    }
    const pressureOptionalNames = new Set(['web_search', 'fetch_web_url', 'load_skill', 'read_skill_file', 'list_skills', 'get_skill_details', 'create_skill_draft', 'validate_skill_draft', 'install_skill_draft', 'update_skill_draft', 'set_skill_enabled', 'update_skill_from_git', 'uninstall_skill', 'install_skill_from_git', 'add_mcp_server', 'list_mcp_servers', 'get_mcp_server_details', 'update_mcp_server', 'test_mcp_server', 'set_mcp_server_enabled', 'remove_mcp_server']);
    const requestTools = explainRepeatedStop ? [] : budgetRestricted
      ? normalTools.filter((tool) => requiredNames.has(tool.name) || (!tool.mcp && !pressureOptionalNames.has(tool.name)))
      : normalTools;
    dispatchToolDefinitions = requestTools;
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
        messages: await require('./agentImageContext').projectImageMessages(compactedMessages, session, { llmConfig, signal, imageCache }),
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
        onRequestFailure: (error) => {
          if (error.code !== 'ABORTED' && !signal?.aborted) recordModelFailure(error, classifyLLMError(error),
            Math.max(0, Number(error.llm_request?.attempt || 1) - 1), loopIndex);
        },
        onVisibleText: () => {
          // 文本块可能先于 tool_use 到达。响应完成前不能把它认作正式答案。
          // 保留 Provider 流读取与取消能力，只在下方分类后发布可见文字。
        },
      }, DEFAULT_LLM_RETRY_LIMIT, {
        ...(typeof llmRetryDelayMs === 'function' ? { retryDelayMs: llmRetryDelayMs } : {}),
        ...(typeof llmRetryWait === 'function' ? { waitForRetry: llmRetryWait } : {}),
        onRetry: ({ attempt, maxRetries, delayMs, classification, error }) => {
          recordModelFailure(error, classification, attempt, loopIndex);
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
      const diagnostics = recordModelFailure(error, classification, Number(error.retryAttempts || 0), loopIndex);
      // 模型请求失败一律进入可恢复等待态：任务进度已保留，处理后可从保存点继续（含未知 fatal 错误）
      const nextStatus = classification.category === 'action_required' ? 'waiting_model_recovery' : 'waiting_retry';
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
        diagnostics,
        message: error.publicMessage || classification.publicMessage,
        retry_attempts: Number(error.retryAttempts || 0),
        resumable: true,
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
    const assistantMessage = { role: 'assistant', content,
      ...(response.providerState ? { providerState: response.providerState } : {}) };
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

    if (explainRepeatedStop) {
      const finalText = thinking.trim() || [...repeatedCalls.values()].map((entry) => entry.receipt.message || entry.receipt.summary).filter(Boolean).join('\n');
      updateSessionStatus(session.id, 'failed');
      updateExecutionSegment(activeExecutionSegment.id, { status: 'failed', completed: true });
      emit({ type: 'final', text: finalText, status: 'failed', reason: 'repeated_tool_calls_unresolved', loop_index: loopIndex, usage: getSessionUsage(session.id) });
      return { status: 'failed', reason: 'repeated_tool_calls_unresolved', final_text: finalText };
    }

    if (isGoalAchieved(stopReason, toolUseBlocks)) {
      messages.push(assistantMessage);
      if (appendResourceResults()) continue;
      const pendingResource = resourceInteractions().find(item => ['pending', 'processing'].includes(item.status));
      if (pendingResource) {
        saveMessagesCheckpoint(session.id, messages, [], '', runId, { phase: 'waiting_interaction', executionSegmentId: activeExecutionSegment.id });
        updateSessionStatus(session.id, 'waiting_interaction');
        emit({ type: 'artifact', artifact_type: 'interaction', interaction: pendingResource, reason: 'resource_approval_requested', non_blocking: false });
        return { status: 'waiting_interaction', reason: 'resource_approval_requested', interaction: pendingResource, interaction_id: pendingResource.id };
      }
      logToolCall({ sessionId: session.id, loopIndex, toolName: null, toolInput: null, toolResult: null, thinking, status: 'success', durationMs: 0 });
      {
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
          const finalText = thinking.trim() || (completion.failureDetails?.length ? completion.failureDetails : completion.reasons).join('\n\n');
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
      messages.push(assistantMessage);
      if (noToolRounds >= 2) {
        updateSessionStatus(session.id, 'failed');
        emit({ type: 'final', text: '模型连续返回空操作，未能继续处理当前请求。可以继续原任务或更换模型后重试，已有工具结果会保留。', status: 'failed', reason: 'no_progress', loop_index: loopIndex, usage: getSessionUsage(session.id) });
        return { status: 'failed', reason: 'no_progress' };
      }
      continue;
    }
    noToolRounds = 0;

    const validation = validateToolUseBlock(toolUseBlocks);
    if (validation.error) {
      messages.push(assistantMessage);
      messages.push({ role: 'user', content: toolUseBlocks.map((toolUse) => ({ type: 'tool_result', tool_use_id: toolUse.id, content: validation.message, is_error: true })) });
      if (checkpointToCommit) clearMessagesCheckpoint(session.id, checkpointToCommit);
      checkpointToCommit = null;
      pendingDispatch = null;
      currentDispatchContent = null;
      continue;
    }

    const toolResults = isResumingDispatch ? [...pendingDispatch.toolResults] : [];
    const startToolIndex = isResumingDispatch ? Math.min(pendingDispatch.nextToolIndex, toolUseBlocks.length) : 0;
    currentDispatchContent = content;
    currentDispatchProviderState = response.providerState || null;
    currentToolResults = toolResults;
    currentNextToolIndex = startToolIndex;
    checkpointToCommit = saveMessagesCheckpoint(session.id, messages, content, '', runId, {
      lastResponseProviderState: currentDispatchProviderState,
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
      const repeatDigest = sha256(JSON.stringify(toolUse.input || {}));
      const repeatKey = `${toolUse.name}:${repeatDigest}`;
      const repeated = repeatedCalls.get(repeatKey) || repeatedCalls.get(`${toolUse.name}:*`);
      if (repeated) {
        repeated.blocked += 1;
        const blockedResult = {
          ...repeated.receipt, status: 'failed', error_code: 'TOOL_REPEAT_BLOCKED',
          not_executed: true,
          repeat_warning: '这次相同调用未执行。先读取之前的结果文件；按实际原因更正参数、选择用户允许的方法，或说明阻塞与继续步骤后结束。',
        };
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(blockedResult), is_error: true });
        recordRuntimeFact({ eventKey: `${invocationKey}:repeat-blocked`, conversationId: session.conversation_id, sessionId: session.id, taskId, runId, actor: 'runtime', factType: 'tool_call_blocked', toolCallId: toolUse.id, invocationKey, payload: { tool_name: toolUse.name, input_digest: repeatDigest, reason: 'repeated_identical_call', result_ref: repeated.receipt.result_ref || null } });
        emit({ type: 'progress', stage: 'tool_done', tool_name: toolUse.name, tool_display_name: toolDisplayName, text: '该调用与之前相同，已返回已有结果供继续判断。', result_summary: blockedResult, failed: true, loop_index: loopIndex, tool_index: toolIndex });
        // 拦截不产生真实执行，但回执必须立刻落入 dispatching_tools 检查点：
        // 崩溃恢复后 nextToolIndex 已越过被拦截调用，不会真实重放。
        const saveBlockedCheckpoint = (nextIndex) => {
          currentToolResults = toolResults;
          currentNextToolIndex = nextIndex;
          checkpointToCommit = saveMessagesCheckpoint(session.id, messages, content, '', runId, {
            lastResponseProviderState: currentDispatchProviderState,
            phase: 'dispatching_tools',
            executionSegmentId: activeExecutionSegment.id,
            llmRequestWindowId: activeRequestWindow?.id,
            toolResults,
            nextToolIndex: currentNextToolIndex,
          });
        };
        if (repeated.blocked >= 2) {
          explainRepeatedStop = true;
          completionCorrection = '相同调用已多次被拦截，仍未找到可推进的方法。本轮只向用户说明具体失败原因、已有结果与下一步怎么继续，不再调用工具，不声称任务已完成。依据前面的错误文件与回执组织回复，不照搬内部状态码。';
          for (const skipped of toolUseBlocks.slice(toolIndex + 1)) toolResults.push({ type: 'tool_result', tool_use_id: skipped.id, content: JSON.stringify({ error: 'NOT_EXECUTED', message: '该调用未执行，正在说明当前阻塞。' }), is_error: true });
          saveBlockedCheckpoint(toolUseBlocks.length);
          break;
        }
        saveBlockedCheckpoint(toolIndex + 1);
        continue;
      }
      const startedAt = Date.now();
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
      const existingOperationSet = getOperationSetByToolUse(session.id, toolUse.id);
      const invocationState = getInvocationState(invocationKey);
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
          imageCache, availableMcpTools, mcpDiagnostics: mcpContext.diagnostics || [],
          toolDefinitions: dispatchToolDefinitions,
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
      if (toolUse.name === 'list_available_mcp_tools' && !failed) exposeDiscoveredTools(result);
      if (externalMcp && !failed && !recoveredInvocation) {
        require('./agentResearch').recordMcpWebEvidence({ session, toolName: mcpContext.map[toolUse.name].toolName, description: dispatchToolDefinitions.find((tool) => tool.name === toolUse.name)?.description || '', result: rawResult, query: String(toolUse.input?.query || toolUse.input?.q || toolUse.input?.search_query || toolUse.input?.keywords || '') });
      }
      const outcomeUnknown = failed && shouldTreatToolFailureAsOutcomeUnknown({
        replayPolicy,
        externalMcp,
        errorCode: result?.error,
        result: rawResult,
      });

      {
        const resourceChangeTools = new Set([
          'install_skill_from_git', 'install_skill_draft', 'set_skill_enabled',
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
            error_message: failed ? require('./agentToolFailure').describeToolFailure(result).slice(0, 400) : '',
            tool_display_name: mcpContext.map[toolUse.name]?.toolName || toolUse.name,
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
        modelVisibleResult = {
          ...modelVisibleResult, outcome_unknown: true,
          recovery_hint: '本次没有取得可确认的工具结果。请读取已有错误文件和执行记录，由你解释具体原因与下一步；不要生成提问卡询问用户是否调用成功，也不能原样重放可能已产生外部影响的调用。',
        };
        repeatedCalls.set(repeatKey, { receipt: modelVisibleResult, blocked: 0 });
      }

      if (!INLINE_READ_TOOLS.has(toolUse.name) && resultArtifact?.status !== 'ready') {
        updateExecutionSegment(activeExecutionSegment.id, { status: 'failed', completed: true });
        updateSessionStatus(session.id, 'failed');
        emit({ type: 'final', text: '工具已经执行，但完整结果无法安全保存，后续步骤已停止。外部操作状态以执行记录为准。', status: 'failed', reason: 'tool_result_payload_unavailable', tool_name: toolUse.name, loop_index: loopIndex, usage: getSessionUsage(session.id) });
        return { status: 'failed', reason: 'tool_result_payload_unavailable' };
      }

      const repeatDetected = failed
        ? recordToolFail(session.id, toolUse.name, toolUse.input || {}, result)
        : (resetToolFail(session.id, toolUse.name), detectDeadloop(session.id, toolUse.name, result, toolUse.input || {}));
      if (repeatDetected) {
        modelVisibleResult = {
          ...modelVisibleResult,
          repeat_warning: failed
            ? '相同工具和参数已连续失败。请先读取错误结果文件，按具体原因修正或选择用户允许的方法；无法继续时解释原因与用户下一步怎么做。不要原样重复调用。'
            : '相同调用已连续返回相同结果。请使用已有结果推进，或调整参数/方法；无法继续时解释阻塞，不要原样重复调用。',
        };
        repeatedCalls.set(repeatKey, { receipt: modelVisibleResult, blocked: 0 });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(modelVisibleResult),
        is_error: failed,
      });
      if (result?.approval_required && !failed) {
        emit({ type: 'artifact', artifact_type: 'interaction', interaction: result.interaction, reason: 'resource_approval_requested', non_blocking: true, loop_index: loopIndex });
      }
      if (toolUse.name === 'ask_question_card' && !failed) {
        currentToolResults = toolResults;
        currentNextToolIndex = toolIndex + 1;
        saveMessagesCheckpoint(session.id, messages, content, toolUse.id, runId, {
          lastResponseProviderState: currentDispatchProviderState,
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
        // 自动模式一律应用；requires_confirmation 只在真正未应用时（例如手动模式）为真。
        const requiresConfirmation = !actualApplied && normalizedApprovalMode !== 'auto_confirm';
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
            lastResponseProviderState: currentDispatchProviderState,
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
        lastResponseProviderState: currentDispatchProviderState,
        phase: 'dispatching_tools',
        executionSegmentId: activeExecutionSegment.id,
        llmRequestWindowId: activeRequestWindow?.id,
        toolResults,
        nextToolIndex: currentNextToolIndex,
      });
      const abortAfterTool = resolveAbortResult();
      if (abortAfterTool) return abortAfterTool;
    }

    messages.push(assistantMessage);
    messages.push({ role: 'user', content: toolResults });
    if (checkpointToCommit) clearMessagesCheckpoint(session.id, checkpointToCommit);
    checkpointToCommit = null;
    currentDispatchContent = null;
    currentDispatchProviderState = null;
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
