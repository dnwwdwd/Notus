const { estimateChatRequestTokens, trimTextToTokenBudget } = require('./llmBudget');
const { sha256 } = require('./files');
const { archiveToolResult, buildToolResultReceipt } = require('./agentToolResultStore');
const INLINE_READ_TOOLS = new Set(['read_tool_result', 'read_conversation_history', 'list_tool_results']);
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

function evictOldReadWindows(messages) {
  const names = new Map();
  const recentStart = Math.max(1, messages.length - 4);
  return messages.map((message, index) => {
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map((block) => {
      if (block.type === 'tool_use') names.set(block.id, { name: block.name, input: block.input });
      const call = names.get(block.tool_use_id);
      if (index >= recentStart || block.type !== 'tool_result' || !INLINE_READ_TOOLS.has(call?.name)) return block;
      const result = parse(block.content);
      if (block.is_error || result?.error) return block;
      return { ...block, content: JSON.stringify({ status: 'read_window_evicted', tool_name: call.name,
        result_ref: result?.result_ref || result?.history_ref, read_arguments: call.input,
        summary: '此前按需读取的片段已移出活跃上下文，需要细节时用相同参数重新读取。' }) };
    }) };
  });
}

function compactMessages(messages = [], tokenBudget = 60000) {
  const projected = evictOldReadWindows(messages);
  if (!projected.length || estimateChatRequestTokens({ messages: projected }) <= tokenBudget) return projected;
  // 以完整assistant/tool_result交换为单位压缩；未解决的调用不丢弃、不拆对。
  const groups = [];
  let group = [];
  let pending = new Set();
  for (const message of projected.slice(1)) {
    group.push(message);
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') pending.add(block.id);
      if (block.type === 'tool_result') pending.delete(block.tool_use_id);
    }
    if (!pending.size) { groups.push(group); group = []; }
  }
  if (group.length) groups.push(group);
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
module.exports = { INLINE_READ_TOOLS, migrateCheckpointResults, evictOldReadWindows, compactMessages };
