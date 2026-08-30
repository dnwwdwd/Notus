const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function runTests() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-runtime-facts-'));
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempRoot;
  process.env.DB_PATH = path.join(tempRoot, 'notus.db');
  process.env.NOTES_DIR = path.join(tempRoot, 'notes');
  process.env.ASSETS_DIR = path.join(tempRoot, 'assets');
  process.env.SESSION_DIR = path.join(tempRoot, 'session');

  const { getDb } = require('../lib/db');
  getDb();
  const { ensureConversation } = require('../lib/conversations');
  const { createSession, getSession } = require('../lib/agentSession');
  const { createTask, getTaskBySession } = require('../lib/agentTaskQueue');
  const {
    getInvocationState,
    hasUnknownToolOutcome,
    recordRuntimeFact,
    recordToolCallPrepared,
    reconcileUnresolvedToolCalls,
    shouldTreatToolFailureAsOutcomeUnknown,
  } = require('../lib/agentRuntimeFacts');
  const conversation = ensureConversation({ kind: 'knowledge', title: 'facts test' });
  const created = createSession({ goal: 'facts test', conversationId: conversation.id });
  const task = createTask({ sessionId: created.sessionId, conversationId: conversation.id, input: {} });

  const duplicateA = recordRuntimeFact({ eventKey: 'same-event', conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'runtime', factType: 'test', payload: { secret: 'sk-test-secret-1234567890' } });
  const duplicateB = recordRuntimeFact({ eventKey: 'same-event', conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'runtime', factType: 'test', payload: {} });
  assert.strictEqual(duplicateA.created, true);
  assert.strictEqual(duplicateB.created, false);
  assert.strictEqual(duplicateA.fact.payload.secret, '[REDACTED]');

  recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'model', toolCallId: 'external-1', invocationKey: 'external-1', toolName: 'external_mcp', inputDigest: 'digest', replayPolicy: 'non_replayable' });
  recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'model', toolCallId: 'read-1', invocationKey: 'read-1', toolName: 'read_file', inputDigest: 'digest', replayPolicy: 'read_only' });
  const reconciliation = reconcileUnresolvedToolCalls();
  assert.ok(reconciliation.blocked_sessions.includes(created.sessionId));
  assert.strictEqual(reconciliation.interactions.length, 1);
  assert.ok(reconciliation.interactions[0].message_id);
  assert.strictEqual(getInvocationState('external-1').terminal.fact_type, 'tool_call_outcome_unknown');
  assert.strictEqual(getInvocationState('read-1').terminal, null);
  assert.strictEqual(getSession(created.sessionId).status, 'waiting_interaction');
  assert.strictEqual(getTaskBySession(created.sessionId).status, 'waiting_interaction');
  assert.strictEqual(hasUnknownToolOutcome(created.sessionId), true);
  recordRuntimeFact({ eventKey: 'external-1:user-resolution:test', conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'user', factType: 'tool_call_outcome_resolved', toolCallId: 'external-1', invocationKey: 'external-1', payload: { tool_name: 'external_mcp', resolution: 'confirmed_success' } });
  assert.strictEqual(hasUnknownToolOutcome(created.sessionId), false);
  assert.strictEqual(getInvocationState('external-1').resolution.payload.resolution, 'confirmed_success');
  const { hasResourceChangeEvidence, isResourceMutationTool } = require('../lib/agentCompletionEvaluator');
  assert.strictEqual(isResourceMutationTool('skill_install_git'), true);
  assert.strictEqual(isResourceMutationTool('external_mcp'), false);
  assert.strictEqual(hasResourceChangeEvidence(created.sessionId), false);
  recordRuntimeFact({ eventKey: 'resource-confirmed', conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'user', factType: 'tool_call_outcome_resolved', toolCallId: 'resource-1', invocationKey: 'resource-1', payload: { tool_name: 'skill_install_git', resolution: 'confirmed_success', resource_changed: true } });
  assert.strictEqual(hasResourceChangeEvidence(created.sessionId), true);
  assert.strictEqual(shouldTreatToolFailureAsOutcomeUnknown({ replayPolicy: 'non_replayable', externalMcp: true, errorCode: 'MCP_TIMEOUT' }), true);
  assert.strictEqual(shouldTreatToolFailureAsOutcomeUnknown({ replayPolicy: 'non_replayable', externalMcp: true, errorCode: 'MCP_CONNECTION_FAILED' }), true);
  assert.strictEqual(shouldTreatToolFailureAsOutcomeUnknown({ replayPolicy: 'non_replayable', externalMcp: false, errorCode: 'MCP_TIMEOUT' }), false);
  assert.strictEqual(shouldTreatToolFailureAsOutcomeUnknown({ replayPolicy: 'read_only', externalMcp: true, errorCode: 'MCP_TIMEOUT' }), false);
  assert.strictEqual(shouldTreatToolFailureAsOutcomeUnknown({ replayPolicy: 'non_replayable', externalMcp: true, errorCode: 'INVALID_TOOL_INPUT' }), false);

  const archivedPrepared = recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'model', toolCallId: 'archived-external', invocationKey: 'archived-external', toolName: 'external_mcp', inputDigest: 'digest', replayPolicy: 'non_replayable' });
  assert.strictEqual(archivedPrepared.created, true);
  await require('../lib/agentToolResultStore').archiveToolResult({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, toolCallId: 'archived-external', invocationKey: 'archived-external', toolName: 'external_mcp', result: { ok: true } });
  reconcileUnresolvedToolCalls();
  assert.strictEqual(getInvocationState('archived-external').terminal.fact_type, 'tool_call_completed');
  assert.strictEqual(getInvocationState('archived-external').terminal.payload.recovered_from_artifact, true);

  recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'model', toolCallId: 'archived-resource', invocationKey: 'archived-resource', toolName: 'set_skill_enabled', inputDigest: 'digest', replayPolicy: 'non_replayable', effectKind: 'resource_mutation' });
  await require('../lib/agentToolResultStore').archiveToolResult({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, toolCallId: 'archived-resource', invocationKey: 'archived-resource', toolName: 'set_skill_enabled', result: { success: true } });
  reconcileUnresolvedToolCalls();
  assert.strictEqual(getInvocationState('archived-resource').terminal.payload.resource_changed, true);

  recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'runtime', toolCallId: 'archived-resource-alias', invocationKey: 'archived-resource-alias', toolName: 'skill_install_git', inputDigest: 'digest', replayPolicy: 'non_replayable', effectKind: 'resource_mutation' });
  await require('../lib/agentToolResultStore').archiveToolResult({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, toolCallId: 'archived-resource-alias', invocationKey: 'archived-resource-alias', toolName: 'skill_install_git', result: { success: true } });
  reconcileUnresolvedToolCalls();
  assert.strictEqual(getInvocationState('archived-resource-alias').terminal.payload.resource_changed, true);

  const recoveredInteraction = require('../lib/conversationInteractions').createInteraction({ conversationId: conversation.id, kind: 'resource_approval', source: 'agent_loop', reasonCode: 'test', payload: { agent_session_id: created.sessionId, action: 'skill_install' } });
  require('../lib/conversationInteractions').updateInteractionWhen(recoveredInteraction.id, ['pending'], { status: 'processing' });
  recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'runtime', toolCallId: 'resource-interaction', invocationKey: 'resource-interaction', toolName: 'skill_install', inputDigest: 'digest', replayPolicy: 'non_replayable', effectKind: 'resource_mutation', control: { interaction_id: recoveredInteraction.id, action: 'resource_approval', decision: 'confirm' } });
  await require('../lib/agentToolResultStore').archiveToolResult({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, toolCallId: 'resource-interaction', invocationKey: 'resource-interaction', toolName: 'skill_install', result: { success: true } });
  reconcileUnresolvedToolCalls();
  assert.strictEqual(require('../lib/conversationInteractions').getInteractionById(recoveredInteraction.id).status, 'answered');
  assert.ok(require('../lib/agentControlPlane').getResumeJobByInteraction(recoveredInteraction.id));

  const terminalOnlyInteraction = require('../lib/conversationInteractions').createInteraction({ conversationId: conversation.id, kind: 'resource_approval', source: 'agent_loop', reasonCode: 'test-terminal', payload: { agent_session_id: created.sessionId, action: 'skill_install' } });
  require('../lib/conversationInteractions').updateInteractionWhen(terminalOnlyInteraction.id, ['pending'], { status: 'processing' });
  recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'runtime', toolCallId: 'resource-terminal-only', invocationKey: 'resource-terminal-only', toolName: 'skill_install', inputDigest: 'digest', replayPolicy: 'non_replayable', effectKind: 'resource_mutation', control: { interaction_id: terminalOnlyInteraction.id, action: 'resource_approval', decision: 'confirm' } });
  require('../lib/agentRuntimeFacts').recordToolCallTerminal({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'runtime', toolCallId: 'resource-terminal-only', invocationKey: 'resource-terminal-only', factType: 'tool_call_completed', payload: { tool_name: 'skill_install', resource_changed: true } });
  reconcileUnresolvedToolCalls();
  assert.strictEqual(require('../lib/conversationInteractions').getInteractionById(terminalOnlyInteraction.id).status, 'answered');
  assert.ok(require('../lib/agentControlPlane').getResumeJobByInteraction(terminalOnlyInteraction.id));

  const failedTerminalInteraction = require('../lib/conversationInteractions').createInteraction({ conversationId: conversation.id, kind: 'resource_approval', source: 'agent_loop', reasonCode: 'test-failed-terminal', payload: { agent_session_id: created.sessionId, action: 'skill_install' } });
  require('../lib/conversationInteractions').updateInteractionWhen(failedTerminalInteraction.id, ['pending'], { status: 'processing' });
  recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'runtime', toolCallId: 'resource-failed-terminal', invocationKey: 'resource-failed-terminal', toolName: 'skill_install', inputDigest: 'digest', replayPolicy: 'non_replayable', effectKind: 'resource_mutation', control: { interaction_id: failedTerminalInteraction.id, action: 'resource_approval', decision: 'confirm' } });
  require('../lib/agentRuntimeFacts').recordToolCallTerminal({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'runtime', toolCallId: 'resource-failed-terminal', invocationKey: 'resource-failed-terminal', factType: 'tool_call_failed', payload: { tool_name: 'skill_install', error_code: 'RESOURCE_ACTION_FAILED' } });
  reconcileUnresolvedToolCalls();
  assert.strictEqual(require('../lib/conversationInteractions').getInteractionById(failedTerminalInteraction.id).status, 'failed');

  recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'runtime', toolCallId: 'archived-cancelled', invocationKey: 'archived-cancelled', toolName: 'skill_install', inputDigest: 'digest', replayPolicy: 'non_replayable', effectKind: 'resource_mutation' });
  await require('../lib/agentToolResultStore').archiveToolResult({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, toolCallId: 'archived-cancelled', invocationKey: 'archived-cancelled', toolName: 'skill_install', result: { cancelled: true } });
  reconcileUnresolvedToolCalls();
  assert.strictEqual(getInvocationState('archived-cancelled').terminal.fact_type, 'tool_call_cancelled');
  assert.strictEqual(getInvocationState('archived-cancelled').terminal.payload.resource_changed, false);

  recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'user', toolCallId: 'archived-rollback-conflict', invocationKey: 'archived-rollback-conflict', toolName: 'rollback_session', inputDigest: 'digest', replayPolicy: 'operation_set', control: { session_id: created.sessionId, action: 'rollback_session' } });
  await require('../lib/agentToolResultStore').archiveToolResult({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, toolCallId: 'archived-rollback-conflict', invocationKey: 'archived-rollback-conflict', toolName: 'rollback_session', result: { restored_count: 0, conflicts: ['x.md'], errors: [] } });
  reconcileUnresolvedToolCalls();
  assert.strictEqual(getInvocationState('archived-rollback-conflict').terminal.fact_type, 'tool_call_failed');
  assert.strictEqual(getInvocationState('archived-rollback-conflict').terminal.payload.error_code, 'ROLLBACK_CONFLICT');

  recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'model', toolCallId: 'archived-timeout', invocationKey: 'archived-timeout', toolName: 'external_mcp', inputDigest: 'digest', replayPolicy: 'non_replayable', externalMcp: true });
  await require('../lib/agentToolResultStore').archiveToolResult({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, toolCallId: 'archived-timeout', invocationKey: 'archived-timeout', toolName: 'external_mcp', result: { error: 'MCP_TIMEOUT', message: 'timeout' } });
  const timeoutRecovery = reconcileUnresolvedToolCalls();
  assert.strictEqual(getInvocationState('archived-timeout').terminal.fact_type, 'tool_call_outcome_unknown');
  assert.strictEqual(timeoutRecovery.interactions.filter((item) => item?.payload?.invocation_key === 'archived-timeout').length, 1);
  assert.strictEqual(reconcileUnresolvedToolCalls().interactions.filter((item) => item?.payload?.invocation_key === 'archived-timeout').length, 0);

  const operationSet = require('../lib/canvasOperationSets').createOperationSet({ conversationId: conversation.id, agentSessionId: created.sessionId, toolUseId: 'operation-prepared', articleHash: 'hash', mode: 'create_file', patches: [{ file_path: 'x.md', old: '', new: 'x', status: 'applied' }], status: 'applied' });
  recordToolCallPrepared({ conversationId: conversation.id, sessionId: created.sessionId, taskId: task.id, actor: 'user', toolCallId: 'operation-prepared', invocationKey: 'operation-prepared', toolName: 'operation_set_apply', inputDigest: 'digest', replayPolicy: 'operation_set', control: { operation_set_id: operationSet.id, action: 'apply' } });
  reconcileUnresolvedToolCalls();
  assert.strictEqual(getInvocationState('operation-prepared').terminal.fact_type, 'tool_call_completed');
  assert.strictEqual(getInvocationState('operation-prepared').terminal.payload.operation_set_id, operationSet.id);

  const rollbackCreated = createSession({ goal: 'rollback recovery', conversationId: conversation.id });
  const rollbackTask = createTask({ sessionId: rollbackCreated.sessionId, conversationId: conversation.id, input: {} });
  const rolledBackSet = require('../lib/canvasOperationSets').createOperationSet({ conversationId: conversation.id, agentSessionId: rollbackCreated.sessionId, toolUseId: 'rollback-set', articleHash: 'hash', mode: 'create_file', patches: [{ file_path: 'rolled-back.md', old: '', new: 'x', status: 'rolled_back' }], status: 'rolled_back' });
  recordToolCallPrepared({ conversationId: conversation.id, sessionId: rollbackCreated.sessionId, taskId: rollbackTask.id, actor: 'user', toolCallId: 'session-rollback', invocationKey: 'session-rollback', toolName: 'rollback_session', inputDigest: 'digest', replayPolicy: 'operation_set', control: { session_id: rollbackCreated.sessionId, action: 'rollback_session' } });
  reconcileUnresolvedToolCalls();
  assert.strictEqual(getInvocationState('session-rollback').terminal.fact_type, 'tool_call_completed');
  assert.strictEqual(getInvocationState('session-rollback').terminal.payload.recovered_from_session_rollback, true);
  assert.ok(rolledBackSet.id);
  assert.strictEqual(getSession(rollbackCreated.sessionId).status, 'rolled_back');
  assert.strictEqual(getTaskBySession(rollbackCreated.sessionId).status, 'cancelled');

  getDb().prepare("UPDATE agent_sessions SET status = 'completed' WHERE id = ?").run(rollbackCreated.sessionId);
  getDb().prepare("UPDATE agent_task_queue SET status = 'queued' WHERE session_id = ?").run(rollbackCreated.sessionId);
  reconcileUnresolvedToolCalls();
  assert.strictEqual(getSession(rollbackCreated.sessionId).status, 'rolled_back');
  assert.strictEqual(getTaskBySession(rollbackCreated.sessionId).status, 'cancelled');

  console.log('agent runtime facts tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
