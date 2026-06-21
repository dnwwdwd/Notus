const { completeToolChat } = require('./llm');
const { getEffectiveConfig } = require('./config');
const { getStyleContext } = require('./style');
const { buildInitialUserMessage, buildLoopSystemPrompt } = require('./agentLoopPrompt');
const {
  clearMessagesCheckpoint,
  detectDeadloop,
  getSession,
  loadMessagesCheckpoint,
  logToolCall,
  recordToolFail,
  resetToolFail,
  saveMessagesCheckpoint,
  snapshotFiles,
  summarizeToolResult,
  updateSessionLoopCount,
  updateSessionStatus,
} = require('./agentSession');
const { buildToolDefinitions, executeToolSafely, summarizeInput, validateToolUseBlock } = require('./agentTools');
const { estimateChatRequestTokens } = require('./llmBudget');

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
  if (parsed?.path) return `文件 ${parsed.path}`;
  return '工具调用已完成';
}

function compactMessages(messages = [], tokenBudget = 60000) {
  const estimated = estimateChatRequestTokens({ messages });
  if (estimated < tokenBudget * 0.7) return messages;
  const keep = messages.slice(-8);
  const older = messages.slice(0, -8).map((message) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (block?.type !== 'tool_result') return block;
        const parsed = safeJsonParse(block.content, null);
        if (block.is_error || parsed?.error) return block;
        return { ...block, content: JSON.stringify({ _compacted: true, summary: buildCompactSummary(parsed) }) };
      }),
    };
  });
  return older.concat(keep);
}

async function callLLMWithRetry(request, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await completeToolChat(request);
    } catch (error) {
      lastError = error;
      if (error.status === 429 && attempt < maxRetries) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      if (['ETIMEDOUT', 'ECONNRESET'].includes(error.code) && attempt < maxRetries) continue;
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

async function loadStyleContext(session) {
  try {
    const config = getEffectiveConfig();
    if (!config.canvasEnableStyleExtraction) return null;
    return await getStyleContext(session.goal, { articleTitle: session.goal });
  } catch {
    return null;
  }
}

async function runAgentLoop({ sessionId, llmConfig, onStream, signal } = {}) {
  let session = getSession(sessionId);
  const config = getEffectiveConfig();
  const emit = typeof onStream === 'function' ? onStream : () => {};

  const { snapshotCount } = await snapshotFiles(session.id, config.notesDir);
  emit({ type: 'snapshot_done', snapshot_count: snapshotCount });
  updateSessionStatus(session.id, 'running');
  session = getSession(session.id);

  const styleContext = await loadStyleContext(session);
  const tools = buildToolDefinitions(session);
  const systemPrompt = buildLoopSystemPrompt(session, { styleContext });
  const checkpoint = loadMessagesCheckpoint(session.id);
  let messages;
  if (checkpoint) {
    messages = checkpoint.messages;
    if (checkpoint.appliedToolUseId) {
      messages.push({ role: 'assistant', content: checkpoint.lastResponseContent || [] });
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: checkpoint.appliedToolUseId,
          content: JSON.stringify({ applied: true, message: '修改已写入文件' }),
        }],
      });
    }
    clearMessagesCheckpoint(session.id);
  } else {
    messages = [{ role: 'user', content: buildInitialUserMessage(session.goal, session) }];
  }

  let loopIndex = Number(session.loop_count || 0);
  let noToolRounds = 0;

  while (true) {
    if (signal?.aborted) {
      updateSessionStatus(session.id, 'cancelled');
      emit({ type: 'cancelled' });
      return { status: 'cancelled' };
    }

    session = getSession(session.id);
    loopIndex += 1;
    updateSessionLoopCount(session.id, loopIndex);
    emit({ type: 'loop_start', loop_index: loopIndex });

    if (loopIndex === session.soft_limit || (loopIndex > session.soft_limit && (loopIndex - session.soft_limit) % 5 === 0)) {
      emit({ type: 'soft_limit_notice', loop_index: loopIndex });
    }

    if (loopIndex > session.hard_limit) {
      saveMessagesCheckpoint(session.id, messages, [], '');
      updateSessionStatus(session.id, 'waiting_confirm');
      emit({ type: 'loop_done', reason: 'hard_limit_reached', loop_index: loopIndex });
      return { status: 'waiting_confirm', reason: 'hard_limit_reached' };
    }

    const compactedMessages = compactMessages(messages, Number(llmConfig?.llmContextWindowTokens || config.llmContextWindowTokens || 60000));
    const response = await callLLMWithRetry({
      system: systemPrompt,
      messages: compactedMessages,
      tools,
      llmConfig,
      taskType: 'agent_loop',
      temperature: 0.2,
    });
    const { textBlocks, toolUseBlocks, stopReason, content } = parseResponse(response);
    const thinking = textBlocks.map((block) => block.text).join('\n').trim();

    textBlocks.forEach((block) => emit({ type: 'thinking', text: block.text, loop_index: loopIndex }));

    if (isGoalAchieved(stopReason, toolUseBlocks)) {
      logToolCall({ sessionId: session.id, loopIndex, toolName: null, toolInput: null, toolResult: null, thinking, status: 'success', durationMs: 0 });
      updateSessionStatus(session.id, 'completed');
      emit({ type: 'loop_done', reason: 'goal_achieved', loop_index: loopIndex, usage: response.usage || null });
      return { status: 'completed', reason: 'goal_achieved' };
    }

    if (toolUseBlocks.length === 0) {
      noToolRounds += 1;
      messages.push({ role: 'assistant', content });
      if (noToolRounds >= 2) {
        updateSessionStatus(session.id, 'failed');
        emit({ type: 'loop_done', reason: 'no_progress', loop_index: loopIndex });
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
      emit({ type: 'tool_start', tool_name: toolUse.name, tool_input_summary: summarizeInput(toolUse), loop_index: loopIndex });
      const startedAt = Date.now();
      const result = await executeToolSafely(toolUse, session, config.notesDir);
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

      emit({ type: 'tool_done', tool_name: toolUse.name, result_summary: summarizeToolResult(toolUse.name, result), loop_index: loopIndex, failed });

      if (failed) {
        if (recordToolFail(session.id, toolUse.name)) {
          updateSessionStatus(session.id, 'failed');
          emit({ type: 'loop_done', reason: 'consecutive_tool_failure', tool_name: toolUse.name, loop_index: loopIndex });
          return { status: 'failed', reason: 'consecutive_tool_failure' };
        }
      } else {
        resetToolFail(session.id, toolUse.name);
        if (detectDeadloop(session.id, toolUse.name, result)) {
          updateSessionStatus(session.id, 'failed');
          emit({ type: 'loop_done', reason: 'deadloop_detected', tool_name: toolUse.name, loop_index: loopIndex });
          return { status: 'failed', reason: 'deadloop_detected' };
        }
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
        is_error: failed,
      });

      if (toolUse.name === 'preview_patch_files' && !failed) {
        updateSessionStatus(session.id, 'waiting_confirm');
        saveMessagesCheckpoint(session.id, messages, content, toolUse.id);
        emit({ type: 'waiting_preview_confirm', operation_set_id: result.operation_set_id, loop_index: loopIndex });
        return { status: 'waiting_confirm', operation_set_id: result.operation_set_id };
      }
    }

    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: toolResults });
  }
}

module.exports = {
  compactMessages,
  callLLMWithRetry,
  parseResponse,
  runAgentLoop,
};
