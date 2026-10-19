const { estimateChatRequestTokens, trimTextToTokenBudget } = require('./llmBudget');
const { sha256 } = require('./files');
const { archiveToolResult, buildToolResultReceipt } = require('./agentToolResultStore');
const INLINE_READ_TOOLS = new Set(['list_available_mcp_tools', 'read_tool_result', 'read_conversation_history', 'list_tool_results', 'list_materials', 'read_attachment', 'list_file_images']);
function parse(value) { try { return JSON.parse(value); } catch { return null; } }

async function migrateCheckpointResults(checkpoint, session) {
  if (!checkpoint) return checkpoint;
  const names = new Map();
  for (const message of checkpoint.messages || []) for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type === 'tool_use') names.set(block.id, block.name);
  }
  for (const block of checkpoint.lastResponseContent || []) if (block.type === 'tool_use') names.set(block.id, block.name);
  const migrated = new Map();
  async function project(block) {
    if (block?.type !== 'tool_result') return block;
    const result = parse(block.content);
    if (result?.result_ref && result?.tool_name) return block;
    const name = names.get(block.tool_use_id) || 'restored_tool';
    // The resumed question card is the user's answer to this tool call. A generic
    // archive receipt only says that an interaction completed and hides the
    // answers from the model, causing it to ask the same questions again.
    if (name === 'ask_question_card' && result?.interaction_id
      && (result.answered === true || result.cancelled === true)) return block;
    if (INLINE_READ_TOOLS.has(name)) return block;
    const key = `${block.tool_use_id}:${sha256(String(block.content))}`;
    if (!migrated.has(key)) {
      const artifact = await archiveToolResult({ conversationId: session.conversation_id, sessionId: session.id,
        toolCallId: block.tool_use_id, invocationKey: `checkpoint:${key}`, toolName: name,
        result: result ?? { content: block.content } });
      if (artifact.status !== 'ready') throw Object.assign(new Error('旧工具结果无法归档，任务进度已保留。'), { code: 'CHECKPOINT_RESULT_ARCHIVE_FAILED' });
      migrated.set(key, JSON.stringify(buildToolResultReceipt({ toolName: name, result: result || {}, artifact })));
    }
    return { ...block, content: migrated.get(key) };
  }
  const messages = [];
  for (const message of checkpoint.messages || []) messages.push({ ...message, content: Array.isArray(message.content) ? await Promise.all(message.content.map(project)) : message.content });
  const toolResults = await Promise.all((checkpoint.toolResults || []).map(project));
  let resumeToolResult = checkpoint.resumeToolResult;
  if (resumeToolResult?.content && checkpoint.appliedToolUseId) {
    resumeToolResult = await project({ type: 'tool_result', tool_use_id: checkpoint.appliedToolUseId, ...resumeToolResult });
  }
  return { ...checkpoint, messages, toolResults, resumeToolResult, toolResultProjectionVersion: 2 };
}

// 参考 Claude Code 的 microcompact：预算超限时保留最近 N 个工具结果原文，
// 更早的无论大小一律替换为占位回执。提问卡答案没有归档正文，永不驱逐。
const KEEP_RECENT_TOOL_RESULTS = 8;
const EVICTED_STATUSES = new Set(['read_window_evicted', 'tool_result_evicted']);

function evictOldToolResults(messages, tokenBudget = 60000) {
  let estimated = estimateChatRequestTokens({ messages });
  if (estimated <= tokenBudget) return messages;
  const names = new Map();
  const blocks = [];
  messages.forEach((message, index) => {
    for (const [blockIndex, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
      if (block.type === 'tool_use') names.set(block.id, { name: block.name, input: block.input });
      if (block.type !== 'tool_result') continue;
      const call = names.get(block.tool_use_id);
      if (call?.name === 'ask_question_card') continue;
      const result = parse(block.content);
      if (result && EVICTED_STATUSES.has(result.status)) continue;
      blocks.push({ index, blockIndex, block, call, result });
    }
  });
  const keepCount = Math.max(0, Number(KEEP_RECENT_TOOL_RESULTS) || 0);
  const evictable = blocks.slice(0, Math.max(0, blocks.length - keepCount));
  const projected = messages.slice();
  for (const { index, blockIndex, block, call, result } of evictable) {
    const cost = estimateChatRequestTokens({ messages: [{ role: 'user', content: [block] }] });
    const replacement = { ...block, content: JSON.stringify({
      status: 'tool_result_evicted', tool_name: call?.name || 'unknown_tool',
      result_ref: result?.result_ref || result?.history_ref || null,
      read_arguments: call?.input || null,
      next_offset: result?.next_offset, total_bytes: result?.total_bytes,
      summary: '较早的工具结果已按上下文预算移出；需要正文时用 read_tool_result 按 result_ref 读取，继续分页使用 next_offset，索引不足用 list_tool_results 查找。',
    }) };
    projected[index] = { ...projected[index], content: projected[index].content.slice() };
    projected[index].content[blockIndex] = replacement;
    estimated -= cost - estimateChatRequestTokens({ messages: [{ role: 'user', content: [replacement] }] });
  }
  return projected;
}

// 兼容旧调用名：语义已升级为按最近 N 个工具结果驱逐。
const evictOldReadWindows = evictOldToolResults;

// 以完整assistant/tool_result交换为单位分组；未解决的调用不丢弃、不拆对。
function groupCompleteExchanges(messages = []) {
  const groups = [];
  let group = [];
  let pending = new Set();
  for (const message of messages) {
    group.push(message);
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') pending.add(block.id);
      if (block.type === 'tool_result') pending.delete(block.tool_use_id);
    }
    if (!pending.size) { groups.push(group); group = []; }
  }
  if (group.length) groups.push(group);
  return groups;
}

function compactMessages(messages = [], tokenBudget = 60000) {
  const projected = evictOldToolResults(messages, tokenBudget);
  if (!projected.length || estimateChatRequestTokens({ messages: projected }) <= tokenBudget) return projected;
  const groups = groupCompleteExchanges(projected.slice(1));
  const tail = [];
  let budgetUsed = estimateChatRequestTokens({ messages: [projected[0]] });
  let firstKept = groups.length;
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const cost = estimateChatRequestTokens({ messages: groups[i] });
    if (tail.length && budgetUsed + cost > tokenBudget * 0.8) break;
    tail.unshift(...groups[i]); budgetUsed += cost; firstKept = i;
  }
  if (firstKept === 0) return projected;
  const receipts = [];
  for (const message of groups.slice(0, firstKept).flat()) for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block.type !== 'tool_result') continue;
    const value = parse(block.content);
    if (value) receipts.push({ tool_name: value.tool_name, status: value.status, summary: value.summary, result_ref: value.result_ref,
      operation_set_id: value.operation_set_id, error_code: value.error_code });
  }
  const summary = trimTextToTokenBudget(JSON.stringify(receipts), Math.max(128, Math.floor(tokenBudget * 0.1)));
  return [projected[0], { role: 'assistant', content: [{ type: 'text', text: `较早已完成工具交换已压缩。原始结果仍在文件中，可用read_tool_result读取；索引不足时用list_tool_results查找本会话全部结果引用；不能重复执行已完成写入。回执索引：${summary}` }] }, ...tail];
}
module.exports = { INLINE_READ_TOOLS, migrateCheckpointResults, evictOldToolResults, evictOldReadWindows, compactMessages, groupCompleteExchanges, KEEP_RECENT_TOOL_RESULTS };
