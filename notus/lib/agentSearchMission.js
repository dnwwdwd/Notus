const { executeWebSearch } = require('./agentTools');
const { archiveToolResult, buildToolResultReceipt, sanitizeArtifactValue } = require('./agentToolResultStore');
const { recordToolCallPrepared, recordToolCallTerminal } = require('./agentRuntimeFacts');
const { updateTurnFrame } = require('./agentTurnFrames');
const { sha256 } = require('./files');

const SEARCH_TOOL_NAME = /(?:search|web|browse|crawl|scrape|find)/i;
const SEARCH_TOOL_DESCRIPTION = /(?:搜索|检索|查询|网页|互联网|search|web|browse|crawl|scrape)/i;
const MCP_MANAGEMENT = /(?:server|config|install|enable|disable|remove|delete|update|管理|配置|安装|启用|停用|删除)/i;

function findAuthorizedMcpSearchTool(preparedMcpContext = {}) {
  return (Array.isArray(preparedMcpContext.tools) ? preparedMcpContext.tools : []).find((tool) => {
    const mapping = preparedMcpContext.map?.[tool.name] || tool.mcp;
    const name = `${tool.name || ''} ${mapping?.toolName || ''}`;
    const description = String(tool.description || '');
    const properties = tool.input_schema?.properties || {};
    const queryKey = ['query', 'q', 'search', 'text', 'keyword', 'keywords'].find((key) => properties[key]);
    return Boolean(mapping && queryKey && !MCP_MANAGEMENT.test(name) && (SEARCH_TOOL_NAME.test(name) || SEARCH_TOOL_DESCRIPTION.test(description)));
  }) || null;
}

function buildMcpSearchInput(tool, query) {
  const properties = tool?.input_schema?.properties || {};
  const key = ['query', 'q', 'search', 'text', 'keyword', 'keywords'].find((item) => properties[item]) || 'query';
  return { [key]: query };
}

function missionFingerprint(frame, session, query) {
  return sha256(JSON.stringify({
    normalized_query: String(query || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase(),
    task_kind: frame?.intent?.task_kind || 'general',
    source_policy: frame?.intent?.source_policy?.web || 'allowed',
    provider: session?.web_search_provider || '',
  }));
}

function sanitizeOutboundSearchQuery(query = '') {
  return String(sanitizeArtifactValue(String(query || '')) || '').replace(/\s+/g, ' ').trim();
}

function getSearchCapabilityLimitation(result = {}) {
  const errorCode = String(result?.error || result?.provider_error || '').trim();
  if (!['WEB_SEARCH_DISABLED', 'WEB_SEARCH_NOT_CONFIGURED', 'WEB_SEARCH_API_KEY_REQUIRED'].includes(errorCode)) return null;
  if (errorCode === 'WEB_SEARCH_API_KEY_REQUIRED') {
    return {
      code: errorCode,
      message: `无法完成联网搜索：${String(result?.message || '当前搜索服务缺少 API Key。').trim()}请前往“设置 → 搜索配置”补充后重试。`,
    };
  }
  return {
    code: errorCode,
    message: '无法完成联网搜索：当前没有启用可用的搜索服务。请前往“设置 → 搜索配置”启用并配置搜索服务后重试。',
  };
}

async function executeRuntimeSearchMission({ session, task, frame, userQuery, llmConfig, runId = null, preparedMcpContext = null, signal = null } = {}) {
  if (!frame || frame.intent?.source_policy?.web !== 'required') return { frame, executed: false, receipt: null };
  if (frame.facts?.runtime_search?.mission_fingerprint) {
    return { frame, executed: false, reused: true, receipt: frame.facts.runtime_search.receipt || null };
  }
  const outboundQuery = sanitizeOutboundSearchQuery(userQuery);
  const fingerprint = missionFingerprint(frame, session, outboundQuery);
  const mcpSearchTool = findAuthorizedMcpSearchTool(preparedMcpContext || {});
  const selectedToolName = mcpSearchTool?.name || 'web_search';
  const toolCallId = `runtime-web-${fingerprint.slice(0, 16)}`;
  const invocationKey = `runtime:${session.id}:web:${fingerprint}`;
  const owner = {
    conversationId: session.conversation_id,
    sessionId: session.id,
    taskId: task?.id,
    turnFrameId: frame.id,
    runId,
    actor: 'runtime',
    toolCallId,
    invocationKey,
  };
  recordToolCallPrepared({
    ...owner,
    toolName: selectedToolName,
    inputDigest: sha256(outboundQuery),
    replayPolicy: 'read_only',
  });

  let result;
  try {
    if (mcpSearchTool) {
      const { callMcpTool } = require('./mcp');
      const mapping = preparedMcpContext.map?.[mcpSearchTool.name] || mcpSearchTool.mcp;
      result = await callMcpTool(mapping, buildMcpSearchInput(mcpSearchTool, outboundQuery), {
        signal,
        timeoutMs: 30_000,
      });
      if (result?.is_error && !result.error) result = { ...result, error: 'MCP_SEARCH_FAILED' };
      if (!result?.error) {
        require('./agentResearch').recordMcpWebEvidence({
          session,
          toolName: mapping.toolName,
          result,
          query: outboundQuery,
        });
      }
    } else {
      result = await executeWebSearch({ query: outboundQuery }, session.id, undefined, {
        llmConfig,
        runId,
        missionFingerprint: fingerprint,
        maxQueries: frame.intent?.verification?.search_budget || undefined,
      });
    }
  } catch (error) {
    result = { error: error.code || 'WEB_SEARCH_FAILED', message: error.message, results: [] };
  }
  const artifact = await archiveToolResult({
    ...owner,
    toolName: selectedToolName,
    result,
  });
  const resultFailed = Boolean(result?.error || result?.provider_error || result?.success === false || result?.is_error);
  const receiptInput = resultFailed
    ? { ...result, error: result.error || result.provider_error || 'WEB_SEARCH_FAILED' }
    : result;
  const receipt = buildToolResultReceipt({ toolName: selectedToolName, result: receiptInput, artifact });
  recordToolCallTerminal({
    ...owner,
    factType: resultFailed ? 'tool_call_failed' : 'tool_call_completed',
    payload: {
      tool_name: selectedToolName,
      search_source: mcpSearchTool ? 'mcp' : 'builtin',
      result_ref: receipt.result_ref,
      artifact_status: receipt.result_status,
      result_count: Array.isArray(result?.results) ? result.results.length : 0,
      error_code: receiptInput?.error || '',
    },
  });
  const updatedFrame = updateTurnFrame(frame.id, {
    facts: {
      ...(frame.facts || {}),
      runtime_search: {
        mission_fingerprint: fingerprint,
        status: resultFailed ? 'failed' : 'completed',
        source: mcpSearchTool ? 'mcp' : 'builtin',
        tool_name: selectedToolName,
        research_subjects: frame.intent?.verification?.research_subjects || [],
        verification_questions: frame.intent?.verification?.verification_questions || [],
        receipt,
      },
    },
  });
  return { frame: updatedFrame || frame, executed: true, receipt, result };
}

module.exports = {
  executeRuntimeSearchMission,
  buildMcpSearchInput,
  findAuthorizedMcpSearchTool,
  getSearchCapabilityLimitation,
  missionFingerprint,
  sanitizeOutboundSearchQuery,
};
