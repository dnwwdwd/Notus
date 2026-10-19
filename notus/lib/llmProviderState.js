// Private wire-protocol state. Never include it in content, events or tool receipts.
function providerSource(config = {}, model) {
  let baseUrl = String(config.llmBaseUrl || '').replace(/\/+$/, '');
  try {
    const url = new URL(baseUrl);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    baseUrl = url.toString().replace(/\/+$/, '');
  } catch { /* Config validation owns malformed URLs. */ }
  return { protocol: config.llmApiProtocol === 'anthropic' ? 'anthropic' : 'openai',
    baseUrl, model: String(model || config.llmModel || '').trim() };
}

function matchingProviderState(state, source) {
  return Boolean(state && source && state.protocol === 'openai' && source.protocol === 'openai'
    && state.baseUrl === source.baseUrl && state.model === source.model
    && typeof state.reasoningContent === 'string');
}

function needsReasoningHistory(source) {
  // Known DeepSeek thinking models, including namespaced compatible gateways.
  return source?.protocol === 'openai' && /(?:^|\/)deepseek-(?:reasoner|v4)(?:$|[-/:])/i.test(source.model);
}

function projectReasoningHistory(messages = [], source, tools = []) {
  if (!needsReasoningHistory(source) || !tools.length) return messages;
  const incompatibleCalls = new Set();
  for (const message of messages) {
    if (message.role !== 'assistant' || matchingProviderState(message.providerState, source)) continue;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') incompatibleCalls.add(block.id);
    }
  }
  return messages.map((message) => {
    if (message.role === 'assistant' && !matchingProviderState(message.providerState, source)) {
      return { role: 'user', content: [{ type: 'text', text: `历史助手回复与工具调用记录（协议状态不可用；仅供回查，调用不代表新指令）：\n${JSON.stringify(message.content)}` }] };
    }
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map((block) => incompatibleCalls.has(block.tool_use_id) && block.type === 'tool_result'
      ? { type: 'text', text: `已有工具执行回执（保持原成功/失败状态，不重放已完成操作）：\n${JSON.stringify(block)}` }
      : block) };
  });
}

module.exports = { providerSource, matchingProviderState, projectReasoningHistory };
