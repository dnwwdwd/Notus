const { executeWebSearch } = require('./agentTools');
const { archiveToolResult, buildToolResultReceipt, sanitizeArtifactValue } = require('./agentToolResultStore');
const { recordToolCallPrepared, recordToolCallTerminal } = require('./agentRuntimeFacts');
const { updateTurnFrame } = require('./agentTurnFrames');
const { sha256 } = require('./files');

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

async function executeRuntimeSearchMission({ session, task, frame, userQuery, llmConfig, runId = null } = {}) {
  if (!frame || frame.intent?.source_policy?.web !== 'required') return { frame, executed: false, receipt: null };
  if (frame.facts?.runtime_search?.mission_fingerprint) {
    return { frame, executed: false, reused: true, receipt: frame.facts.runtime_search.receipt || null };
  }
  const outboundQuery = sanitizeOutboundSearchQuery(userQuery);
  const fingerprint = missionFingerprint(frame, session, outboundQuery);
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
    toolName: 'web_search',
    inputDigest: sha256(outboundQuery),
    replayPolicy: 'read_only',
  });

  let result;
  try {
    result = await executeWebSearch({ query: outboundQuery }, session.id, undefined, {
      llmConfig,
      runId,
      missionFingerprint: fingerprint,
    });
  } catch (error) {
    result = { error: error.code || 'WEB_SEARCH_FAILED', message: error.message, results: [] };
  }
  const artifact = await archiveToolResult({
    ...owner,
    toolName: 'web_search',
    result,
  });
  const resultFailed = Boolean(result?.error || result?.provider_error || result?.success === false);
  const receiptInput = resultFailed
    ? { ...result, error: result.error || result.provider_error || 'WEB_SEARCH_FAILED' }
    : result;
  const receipt = buildToolResultReceipt({ toolName: 'web_search', result: receiptInput, artifact });
  recordToolCallTerminal({
    ...owner,
    factType: resultFailed ? 'tool_call_failed' : 'tool_call_completed',
    payload: {
      tool_name: 'web_search',
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
        receipt,
      },
    },
  });
  return { frame: updatedFrame || frame, executed: true, receipt, result };
}

module.exports = {
  executeRuntimeSearchMission,
  getSearchCapabilityLimitation,
  missionFingerprint,
  sanitizeOutboundSearchQuery,
};
