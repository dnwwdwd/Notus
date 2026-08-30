const { getDb } = require('./db');
const { sha256 } = require('./files');
const { redactSecrets } = require('./agentToolPolicy');

const MAX_FACT_PAYLOAD_BYTES = 64 * 1024;
const TERMINAL_TOOL_FACTS = new Set([
  'tool_call_completed',
  'tool_call_failed',
  'tool_call_cancelled',
  'tool_call_outcome_unknown',
]);
const UNKNOWN_OUTCOME_ERROR_CODES = new Set([
  'ABORTED',
  'MCP_CONNECTION_FAILED',
  'MCP_TIMEOUT',
  'TOOL_TIMEOUT',
  'ECONNABORTED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'FETCH_FAILED',
  'UND_ERR_SOCKET',
]);
const RESOURCE_MUTATION_TOOLS = new Set([
  'install_skill_from_git', 'install_skill_draft', 'update_skill_draft',
  'set_skill_enabled', 'update_skill_from_git', 'uninstall_skill',
  'add_mcp_server', 'update_mcp_server', 'set_mcp_server_enabled', 'remove_mcp_server',
  'skill_install_git', 'skill_install', 'skill_update', 'skill_uninstall', 'skill_disable', 'mcp_remove',
]);

function asId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? Math.floor(id) : null;
}

function safeJsonParse(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function boundedPayload(payload = {}) {
  const redacted = redactSecrets(payload && typeof payload === 'object' ? payload : { value: payload });
  const serialized = JSON.stringify(redacted || {});
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= MAX_FACT_PAYLOAD_BYTES) return serialized;
  return JSON.stringify({
    truncated: true,
    original_bytes: bytes,
    digest: sha256(serialized),
  });
}

function formatFact(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    conversation_id: asId(row.conversation_id),
    session_id: asId(row.session_id),
    task_id: asId(row.task_id),
    turn_frame_id: asId(row.turn_frame_id),
    execution_segment_id: asId(row.execution_segment_id),
    request_window_id: asId(row.request_window_id),
    model_visible: Boolean(row.model_visible),
    payload: safeJsonParse(row.payload_json, {}),
  };
}

function recordRuntimeFact(input = {}, database = getDb()) {
  const eventKey = String(input.eventKey || input.event_key || '').trim();
  const conversationId = asId(input.conversationId || input.conversation_id);
  if (!eventKey || !conversationId) return { fact: null, created: false };
  const actor = ['runtime', 'model', 'user', 'system'].includes(String(input.actor || 'runtime'))
    ? String(input.actor || 'runtime')
    : 'runtime';
  const result = database.prepare(`
    INSERT OR IGNORE INTO agent_runtime_facts (
      event_key, conversation_id, session_id, task_id, turn_frame_id, run_id,
      execution_segment_id, request_window_id, actor, fact_type, tool_call_id,
      invocation_key, model_visible, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventKey,
    conversationId,
    asId(input.sessionId || input.session_id),
    asId(input.taskId || input.task_id),
    asId(input.turnFrameId || input.turn_frame_id),
    String(input.runId || input.run_id || '').trim() || null,
    asId(input.executionSegmentId || input.execution_segment_id),
    asId(input.requestWindowId || input.request_window_id),
    actor,
    String(input.factType || input.fact_type || '').trim() || 'runtime_event',
    String(input.toolCallId || input.tool_call_id || '').trim() || null,
    String(input.invocationKey || input.invocation_key || '').trim() || null,
    input.modelVisible || input.model_visible ? 1 : 0,
    boundedPayload(input.payload || {})
  );
  const row = database.prepare('SELECT * FROM agent_runtime_facts WHERE event_key = ?').get(eventKey);
  return { fact: formatFact(row), created: Boolean(result.changes) };
}

function listRuntimeFacts({ sessionId = null, conversationId = null, factTypes = [], limit = 500 } = {}) {
  const conditions = [];
  const params = [];
  if (asId(sessionId)) { conditions.push('session_id = ?'); params.push(asId(sessionId)); }
  if (asId(conversationId)) { conditions.push('conversation_id = ?'); params.push(asId(conversationId)); }
  const types = (Array.isArray(factTypes) ? factTypes : []).map(String).filter(Boolean);
  if (types.length) {
    conditions.push(`fact_type IN (${types.map(() => '?').join(',')})`);
    params.push(...types);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return getDb().prepare(`SELECT * FROM agent_runtime_facts ${where} ORDER BY id ASC LIMIT ?`)
    .all(...params, Math.min(Math.max(Number(limit) || 500, 1), 2000))
    .map(formatFact);
}

function recordToolCallPrepared({ conversationId, sessionId, taskId, turnFrameId, runId, executionSegmentId, requestWindowId, actor = 'model', toolCallId, invocationKey, toolName, inputDigest, replayPolicy, externalMcp = false, effectKind = '', control = null } = {}) {
  return recordRuntimeFact({
    eventKey: `${invocationKey}:prepared`,
    conversationId,
    sessionId,
    taskId,
    turnFrameId,
    runId,
    executionSegmentId,
    requestWindowId,
    actor,
    factType: 'tool_call_prepared',
    toolCallId,
    invocationKey,
    payload: {
      tool_name: String(toolName || ''),
      input_digest: String(inputDigest || ''),
      replay_policy: String(replayPolicy || 'non_replayable'),
      external_mcp: Boolean(externalMcp),
      effect_kind: String(effectKind || (RESOURCE_MUTATION_TOOLS.has(String(toolName || '')) ? 'resource_mutation' : '')),
      control: control && typeof control === 'object' ? control : null,
    },
  });
}

function recordToolCallTerminal({ conversationId, sessionId, taskId, turnFrameId, runId, executionSegmentId, requestWindowId, actor = 'model', toolCallId, invocationKey, factType, payload = {} } = {}, database = getDb()) {
  const normalizedType = TERMINAL_TOOL_FACTS.has(String(factType)) ? String(factType) : 'tool_call_completed';
  return recordRuntimeFact({
    eventKey: `${invocationKey}:${normalizedType}`,
    conversationId,
    sessionId,
    taskId,
    turnFrameId,
    runId,
    executionSegmentId,
    requestWindowId,
    actor,
    factType: normalizedType,
    toolCallId,
    invocationKey,
    payload,
  }, database);
}

function getInvocationState(invocationKey) {
  const key = String(invocationKey || '').trim();
  if (!key) return { prepared: null, terminal: null };
  const rows = getDb().prepare('SELECT * FROM agent_runtime_facts WHERE invocation_key = ? ORDER BY id ASC').all(key).map(formatFact);
  return {
    prepared: rows.find((row) => row.fact_type === 'tool_call_prepared') || null,
    terminal: [...rows].reverse().find((row) => TERMINAL_TOOL_FACTS.has(row.fact_type)) || null,
    resolution: [...rows].reverse().find((row) => row.fact_type === 'tool_call_outcome_resolved') || null,
  };
}

function listUnresolvedToolCalls() {
  return getDb().prepare(`
    SELECT prepared.*
    FROM agent_runtime_facts prepared
    WHERE prepared.fact_type = 'tool_call_prepared'
      AND prepared.invocation_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_runtime_facts terminal
        WHERE terminal.invocation_key = prepared.invocation_key
          AND terminal.fact_type IN ('tool_call_completed','tool_call_failed','tool_call_cancelled','tool_call_outcome_unknown')
      )
    ORDER BY prepared.id ASC
  `).all().map(formatFact);
}

function classifyRecoveredResult(result) {
  const value = result && typeof result === 'object' ? result : {};
  const cancelled = value.cancelled === true || String(value.status || '').toLowerCase() === 'cancelled';
  const conflictCount = Array.isArray(value.conflicts) ? value.conflicts.length : 0;
  const errorCount = Array.isArray(value.errors) ? value.errors.length : 0;
  const errorCode = String(
    value.error
    || (conflictCount ? 'ROLLBACK_CONFLICT' : '')
    || (errorCount ? 'ROLLBACK_FAILED' : '')
    || (value.success === false ? 'TOOL_REPORTED_FAILURE' : '')
  );
  return { cancelled, failed: Boolean(errorCode), errorCode };
}

function reconcileRecoveredResourceInteraction(row, classified, artifact) {
  const interactionId = asId(row.payload?.control?.interaction_id);
  if (!interactionId || row.payload?.effect_kind !== 'resource_mutation') return null;
  const database = getDb();
  return database.transaction(() => {
    const { getInteractionById, updateInteractionWhen } = require('./conversationInteractions');
    const interaction = getInteractionById(interactionId);
    if (!interaction || interaction.status !== 'processing') return null;
    const updated = updateInteractionWhen(interactionId, ['processing'], {
      status: classified.failed ? 'failed' : 'answered',
      response: {
        recovered: true,
        cancelled: classified.cancelled,
        error: classified.errorCode || '',
        result_ref: artifact?.result_ref || null,
      },
      answeredAt: new Date().toISOString(),
    });
    if (!updated || !row.session_id || classified.failed) return updated;
    const { createOrGetResumeJob } = require('./agentControlPlane');
    const { wakeTask } = require('./agentTaskQueue');
    const resumeJob = createOrGetResumeJob({ sessionId: row.session_id, interactionId });
    if (resumeJob?.id) wakeTask(row.session_id, { resumeJobId: resumeJob.id });
    return updated;
  })();
}

function reconcileUnresolvedToolCalls() {
  const rows = listUnresolvedToolCalls();
  const blockedSessions = new Set();
  const interactions = [];
  rows.forEach((row) => {
    const replayPolicy = String(row.payload?.replay_policy || 'non_replayable');
    const recovered = require('./agentToolResultStore').readArtifactResultForReconciliation({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      invocationKey: row.invocation_key,
    });
    if (replayPolicy !== 'operation_set' && recovered.artifact?.status === 'ready' && recovered.result !== null) {
      const classified = classifyRecoveredResult(recovered.result);
      const { failed, cancelled, errorCode } = classified;
      const outcomeUnknown = failed && shouldTreatToolFailureAsOutcomeUnknown({
        replayPolicy,
        externalMcp: Boolean(row.payload?.external_mcp),
        errorCode,
      });
      const resourceChanged = !failed
        && !cancelled
        && !recovered.result?.approval_required
        && (row.payload?.effect_kind === 'resource_mutation' || RESOURCE_MUTATION_TOOLS.has(String(row.payload?.tool_name || '')));
      recordToolCallTerminal({
        conversationId: row.conversation_id,
        sessionId: row.session_id,
        taskId: row.task_id,
        turnFrameId: row.turn_frame_id,
        runId: row.run_id,
        actor: row.actor,
        toolCallId: row.tool_call_id,
        invocationKey: row.invocation_key,
        factType: outcomeUnknown ? 'tool_call_outcome_unknown' : cancelled ? 'tool_call_cancelled' : failed ? 'tool_call_failed' : 'tool_call_completed',
        payload: {
          tool_name: row.payload?.tool_name || '',
          result_ref: recovered.artifact.result_ref,
          artifact_status: 'ready',
          error_code: errorCode,
          resource_changed: resourceChanged,
          recovered_from_artifact: true,
        },
      });
      reconcileRecoveredResourceInteraction(row, classified, recovered.artifact);
      return;
    }
    if (replayPolicy === 'operation_set') {
      const toolName = String(row.payload?.tool_name || '');
      if (toolName === 'rollback_session' || row.payload?.control?.action === 'rollback_session') {
        if (recovered.artifact?.status === 'ready' && recovered.result !== null) {
          const classified = classifyRecoveredResult(recovered.result);
          recordToolCallTerminal({
            conversationId: row.conversation_id,
            sessionId: row.session_id,
            taskId: row.task_id,
            turnFrameId: row.turn_frame_id,
            runId: row.run_id,
            actor: row.actor,
            toolCallId: row.tool_call_id,
            invocationKey: row.invocation_key,
            factType: classified.cancelled ? 'tool_call_cancelled' : classified.failed ? 'tool_call_failed' : 'tool_call_completed',
            payload: {
              tool_name: toolName,
              result_ref: recovered.artifact.result_ref,
              artifact_status: 'ready',
              resource_changed: !classified.cancelled && !classified.failed && Number(recovered.result?.restored_count || recovered.result?.restoredCount || 0) > 0,
              recovered_from_session_rollback_artifact: true,
              error_code: classified.errorCode,
            },
          });
          return;
        }
        const operationSets = getDb().prepare('SELECT status FROM canvas_operation_sets WHERE agent_session_id = ?').all(row.session_id);
        const statuses = operationSets.map((item) => String(item.status || ''));
        const hasConflict = statuses.includes('rollback_conflict');
        const stillApplied = statuses.some((status) => ['applied', 'partial'].includes(status));
        const rolledBack = statuses.some((status) => status === 'rolled_back');
        const sessionStatus = String(getDb().prepare('SELECT status FROM agent_sessions WHERE id = ?').get(row.session_id)?.status || '');
        const completed = sessionStatus === 'rolled_back' || (rolledBack && !hasConflict && !stillApplied);
        recordToolCallTerminal({
          conversationId: row.conversation_id,
          sessionId: row.session_id,
          taskId: row.task_id,
          turnFrameId: row.turn_frame_id,
          runId: row.run_id,
          actor: row.actor,
          toolCallId: row.tool_call_id,
          invocationKey: row.invocation_key,
          factType: completed ? 'tool_call_completed' : hasConflict ? 'tool_call_failed' : 'tool_call_outcome_unknown',
          payload: {
            tool_name: toolName,
            operation_set_statuses: statuses,
            session_status: sessionStatus,
            resource_changed: completed && rolledBack,
            recovered_from_session_rollback: true,
            error_code: completed ? '' : hasConflict ? 'ROLLBACK_CONFLICT' : 'ROLLBACK_OUTCOME_UNKNOWN',
          },
        });
        return;
      }
      const operationSetId = asId(row.payload?.control?.operation_set_id);
      const operationSet = operationSetId
        ? getDb().prepare('SELECT status FROM canvas_operation_sets WHERE id = ? AND agent_session_id = ?').get(operationSetId, row.session_id)
        : null;
      const status = String(operationSet?.status || '');
      const completed = ['applied', 'partial', 'rolled_back', 'discarded', 'cancelled'].includes(status);
      const cancelled = ['discarded', 'cancelled'].includes(status);
      recordToolCallTerminal({
        conversationId: row.conversation_id,
        sessionId: row.session_id,
        taskId: row.task_id,
        turnFrameId: row.turn_frame_id,
        runId: row.run_id,
        actor: row.actor,
        toolCallId: row.tool_call_id,
        invocationKey: row.invocation_key,
        factType: completed ? (cancelled ? 'tool_call_cancelled' : 'tool_call_completed') : 'tool_call_failed',
        payload: {
          tool_name: row.payload?.tool_name || '',
          operation_set_id: operationSetId,
          operation_set_status: status || 'missing',
          resource_changed: completed && !cancelled,
          recovered_from_operation_set: true,
          error_code: completed ? '' : 'OPERATION_SET_NOT_RESOLVED',
        },
      });
      return;
    }
    if (['read_only', 'idempotent'].includes(replayPolicy)) return;
    recordToolCallTerminal({
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      taskId: row.task_id,
      turnFrameId: row.turn_frame_id,
      runId: row.run_id,
      actor: row.actor,
      toolCallId: row.tool_call_id,
      invocationKey: row.invocation_key,
      factType: 'tool_call_outcome_unknown',
      payload: {
        tool_name: row.payload?.tool_name || '',
        replay_policy: replayPolicy,
        reason: 'process_interrupted_after_prepare',
      },
    });
    if (row.session_id) blockedSessions.add(row.session_id);
  });
  const completedResourceInteractions = getDb().prepare(`
    SELECT prepared.*, terminal.fact_type AS terminal_fact_type, terminal.payload_json AS terminal_payload_json
    FROM agent_runtime_facts prepared
    INNER JOIN agent_runtime_facts terminal ON terminal.invocation_key = prepared.invocation_key
    INNER JOIN conversation_interactions interactions
      ON interactions.id = json_extract(prepared.payload_json, '$.control.interaction_id')
    WHERE prepared.fact_type = 'tool_call_prepared'
      AND json_extract(prepared.payload_json, '$.effect_kind') = 'resource_mutation'
      AND terminal.fact_type IN ('tool_call_completed', 'tool_call_cancelled', 'tool_call_failed')
      AND interactions.status = 'processing'
  `).all();
  completedResourceInteractions.forEach((rawRow) => {
    const row = formatFact(rawRow);
    const terminalPayload = safeJsonParse(rawRow.terminal_payload_json, {});
    reconcileRecoveredResourceInteraction(row, {
      failed: rawRow.terminal_fact_type === 'tool_call_failed',
      cancelled: rawRow.terminal_fact_type === 'tool_call_cancelled',
      errorCode: terminalPayload.error_code || '',
    }, { result_ref: terminalPayload.result_ref || null });
  });
  getDb().transaction(() => {
    const completedRollbacks = getDb().prepare(`
      SELECT DISTINCT facts.session_id
      FROM agent_runtime_facts facts
      INNER JOIN agent_sessions sessions ON sessions.id = facts.session_id
      WHERE facts.fact_type = 'tool_call_completed'
        AND json_extract(facts.payload_json, '$.tool_name') = 'rollback_session'
        AND sessions.status != 'rolled_back'
    `).all();
    completedRollbacks.forEach(({ session_id: sessionId }) => {
      getDb().prepare("UPDATE agent_sessions SET status = 'rolled_back', waiting_since = NULL, state_version = state_version + 1, updated_at = datetime('now') WHERE id = ?").run(sessionId);
      getDb().prepare("UPDATE agent_task_queue SET status = 'cancelled', run_id = NULL, resume_requested = 0, finished_at = COALESCE(finished_at, datetime('now')), updated_at = datetime('now') WHERE session_id = ?").run(sessionId);
    });
  })();
  const unknownRows = getDb().prepare(`
    SELECT unknown_fact.*
    FROM agent_runtime_facts unknown_fact
    WHERE unknown_fact.fact_type = 'tool_call_outcome_unknown'
      AND unknown_fact.invocation_key IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_runtime_facts resolved
        WHERE resolved.invocation_key = unknown_fact.invocation_key
          AND resolved.fact_type = 'tool_call_outcome_resolved'
      )
    ORDER BY unknown_fact.id ASC
  `).all().map(formatFact);
  unknownRows.forEach((row) => blockedSessions.add(row.session_id));
  unknownRows.forEach((row) => {
    if (!row.session_id) return;
    const { createInteraction, updateInteraction } = require('./conversationInteractions');
    const { appendConversationMessage } = require('./conversations');
    const createdInteraction = getDb().transaction(() => {
      const alreadyRequested = getDb().prepare(`
        SELECT 1 FROM agent_runtime_facts
        WHERE invocation_key = ? AND fact_type = 'tool_outcome_confirmation_requested'
        LIMIT 1
      `).get(row.invocation_key);
      if (alreadyRequested) return null;
      const interaction = createInteraction({
        conversationId: row.conversation_id,
        kind: 'clarify_card',
        source: 'agent_loop',
        reasonCode: 'tool_outcome_unknown',
        payload: {
          origin: 'tool_outcome_recovery',
          agent_session_id: row.session_id,
          invocation_key: row.invocation_key,
          tool_call_id: row.tool_call_id,
          tool_name: row.payload?.tool_name || '',
          title: '需要核实上次工具结果',
          intro: `上次执行 ${row.payload?.tool_name || '外部工具'} 时进程中断，Notus 无法确认外部结果。请核实后选择实际状态。`,
          submit_label: '继续任务',
          questions: [{ id: 'tool_outcome', slot: 'tool_outcome', label: '该操作在外部系统中的实际结果是什么？', type: 'single_select', required: true, options: [
            { id: 'confirmed_success', label: '已经成功', answer_value: 'confirmed_success' },
            { id: 'confirmed_failed', label: '确认未成功', answer_value: 'confirmed_failed' },
            { id: 'still_unknown', label: '仍无法确认', answer_value: 'still_unknown' },
          ], allow_custom: false }],
        },
      });
      const messageId = appendConversationMessage({ conversationId: row.conversation_id, role: 'assistant', content: interaction.payload.intro, meta: { agent_loop: true, session_id: row.session_id, status: 'waiting_interaction', answer_mode: 'clarify_needed', interaction_id: interaction.id, interaction_kind: interaction.kind, reason: 'tool_outcome_unknown' } });
      const updatedInteraction = updateInteraction(interaction.id, { messageId });
      recordRuntimeFact({ eventKey: `${row.invocation_key}:confirmation-requested`, conversationId: row.conversation_id, sessionId: row.session_id, taskId: row.task_id, turnFrameId: row.turn_frame_id, actor: 'runtime', factType: 'tool_outcome_confirmation_requested', toolCallId: row.tool_call_id, invocationKey: row.invocation_key, payload: { interaction_id: interaction.id, tool_name: row.payload?.tool_name || '' } });
      return updatedInteraction || { ...interaction, message_id: messageId };
    })();
    if (createdInteraction) interactions.push(createdInteraction);
  });
  if (blockedSessions.size) {
    const { updateSessionStatus } = require('./agentSession');
    const { updateTask } = require('./agentTaskQueue');
    blockedSessions.forEach((sessionId) => {
      updateSessionStatus(sessionId, 'waiting_interaction');
      updateTask(sessionId, {
        status: 'waiting_interaction',
        lastError: {
          code: 'TOOL_OUTCOME_UNKNOWN',
          message: '上次工具调用的外部结果无法确认，已停止自动重试。',
        },
      });
    });
  }
  return { unresolved: rows.length, blocked_sessions: [...blockedSessions], interactions };
}

function shouldTreatToolFailureAsOutcomeUnknown({ replayPolicy, externalMcp = false, errorCode = '' } = {}) {
  return String(replayPolicy || '') === 'non_replayable'
    && Boolean(externalMcp)
    && UNKNOWN_OUTCOME_ERROR_CODES.has(String(errorCode || '').trim().toUpperCase());
}

function hasUnknownToolOutcome(sessionId) {
  return Boolean(getDb().prepare(`
    SELECT 1 FROM agent_runtime_facts unknown_fact
    WHERE unknown_fact.session_id = ? AND unknown_fact.fact_type = 'tool_call_outcome_unknown'
      AND NOT EXISTS (
        SELECT 1 FROM agent_runtime_facts resolved
        WHERE resolved.invocation_key = unknown_fact.invocation_key
          AND resolved.fact_type = 'tool_call_outcome_resolved'
      )
    LIMIT 1
  `).get(asId(sessionId)));
}

module.exports = {
  MAX_FACT_PAYLOAD_BYTES,
  TERMINAL_TOOL_FACTS,
  getInvocationState,
  hasUnknownToolOutcome,
  listRuntimeFacts,
  listUnresolvedToolCalls,
  recordRuntimeFact,
  recordToolCallPrepared,
  recordToolCallTerminal,
  reconcileUnresolvedToolCalls,
  shouldTreatToolFailureAsOutcomeUnknown,
};
