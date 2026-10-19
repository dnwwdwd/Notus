// Summarize existing returned data for the receipt; the archived payload remains
// the source of truth and can be read with read_tool_result, including on error.
function describeToolFailure(result = {}) {
  const structured = result.structured_content || result.structuredContent || {};
  const texts = (Array.isArray(result.content) ? result.content : [])
    .filter((item) => item?.type === 'text').map((item) => item.text).filter(Boolean);
  const message = result.message || structured.error?.message || structured.message
    || (typeof structured.error === 'string' ? structured.error : '')
    || texts.join('\n') || result.reason || result.summary || result.error || '工具未提供具体错误原因。';
  return require('./agentToolPolicy').redactSecrets(String(message));
}

function toolFailurePointers(result = {}) {
  return ['message', 'content', 'structured_content', 'summary'].filter((key) =>
    Array.isArray(result[key]) ? result[key].length > 0 : Boolean(result[key])).map((key) => `/${key}`);
}

module.exports = { describeToolFailure, toolFailurePointers };
