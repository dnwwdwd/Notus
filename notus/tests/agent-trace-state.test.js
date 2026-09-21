const assert = require('assert');
(async () => {
  const { agentTraceState } = await import('../utils/agentTraceState.js');
  for (const tailStatus of ['waiting', 'action_required', 'error', 'failed', 'cancelled', 'done']) {
    assert.deepStrictEqual(agentTraceState({ sessionStatus: 'completed', tailStatus, hasError: true }), { label: '已处理', running: false, needsAction: false });
  }
  for (const sessionStatus of ['waiting_operation_confirmation', 'waiting_confirm', 'waiting_interaction', 'waiting_retry', 'waiting_model_recovery', 'failed']) {
    assert.equal(agentTraceState({ sessionStatus, tailStatus: 'done' }).needsAction, true);
  }
  assert.equal(agentTraceState({ sessionStatus: 'queued' }).label, '任务已提交');
  assert.equal(agentTraceState({ sessionStatus: 'running', tailStatus: 'error' }).running, true);
  assert.equal(agentTraceState({ sessionStatus: 'cancelled', tailStatus: 'waiting' }).label, '已取消');
  assert.equal(agentTraceState({ tailStatus: 'error' }).needsAction, true);
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync(require.resolve('../hooks/useAgentLoopController.js'), 'utf8');
  const context = { getAgentToolLabel: v => v, getAgentToolDisplayName: v => v, getAgentLoopReasonLabel: v => v };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function toPositiveInt'), source.indexOf('const FILE_MUTATION_TOOL_NAMES')).replaceAll('export function', 'function'), context);
  const events = [
    { type: 'artifact', artifact_type: 'operation_set', operation_set_id: 7, status: 'preview' },
    { type: 'artifact', artifact_type: 'operation_set', operation_set_id: 7, status: 'applied' },
    { type: 'final', status: 'completed' },
  ];
  let timeline = {};
  for (const event of events) timeline = context.applyAgentTimelineEvent(timeline, event);
  assert.equal(agentTraceState({ sessionStatus: timeline.sessionStatus, tailStatus: timeline.activeSteps.at(-1)?.status }).label, '已处理');
  const restored = context.buildRestoredAgentTimeline({ status: 'completed', run_events: events.map((payload, i) => ({ id: i + 1, payload })) });
  assert.equal(agentTraceState({ sessionStatus: 'completed', tailStatus: restored.steps.at(-1)?.status }).label, '已处理');
  const waiting = context.applyAgentTimelineEvent({}, { type: 'waiting_preview_confirm', operation_set_id: 8 });
  assert.equal(agentTraceState({ sessionStatus: waiting.sessionStatus }).needsAction, true);
  console.log('agent trace state tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
