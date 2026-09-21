const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../hooks/useAgentLoopController.js'), 'utf8');
const context = { getAgentToolLabel: (v) => v, getAgentToolDisplayName: (v) => v, getAgentLoopReasonLabel: (v) => v };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function toPositiveInt'), source.indexOf('const FILE_MUTATION_TOOL_NAMES')).replaceAll('export function', 'function'), context);
const { applyAgentTimelineEvent: apply, buildRestoredAgentTimeline: restore, buildAgentSubscriptionSnapshot: snapshot } = context;
const error = { type: 'artifact', artifact_type: 'run_error', resumable: true, message: '旧错误', execution_segment_id: 'a' };
const hasError = (steps) => steps.some((s) => s.errorType === 'agent');
const failedTool = { id: 'failed-tool', kind: 'tool', status: 'error' };
for (const event of [{type:'session_resumed'}, {type:'progress',stage:'model_requesting'}, {type:'progress',stage:'llm_retry',execution_segment_id:'a'}, {type:'task_state',status:'queued'}]) {
  const failed = apply({activeSteps:[failedTool]}, error);
  assert.ok(hasError(failed.activeSteps));
  const running = apply(failed,event);
  assert.ok(!hasError(running.activeSteps));
  assert.ok(running.activeSteps.some((s) => s.id === failedTool.id));
  assert.ok(hasError(failed.activeSteps), '另一份任务状态不应被原地修改');
  const again = apply(running,{...error,message:'新错误'});
  assert.ok(hasError(again.activeSteps));
  assert.equal(again.loading,false);
}
const rows = [error,{type:'session_resumed'}, {...error,message:'新错误'}].map((payload,i) => ({id:i+1,payload}));
assert.ok(hasError(restore({status:'waiting_retry',run_events:rows}).steps));
assert.ok(!hasError(restore({status:'waiting_retry',run_events:rows.slice(0,2)}).steps));
for (const status of ['running','queued','completed']) assert.ok(!hasError(restore({status,run_events:rows.slice(0,1)}).steps));
assert.ok(!hasError(snapshot({run_events:rows},1).steps));
assert.ok(hasError(apply({}, {type:'error',error:'继续请求失败'}).activeSteps));
console.log('agent error resume visibility tests passed');
