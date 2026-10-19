const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// 覆盖：手动确认任务在所有批次处置完成后，时间线必须收敛为完成，
// 工具链才能折叠并把“需要处理”换成“已处理”。
const source = fs.readFileSync(require.resolve('../hooks/useAgentLoopController.js'), 'utf8');
const context = { getAgentToolLabel: v => v, getAgentToolDisplayName: v => v, getAgentLoopReasonLabel: v => v };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function toPositiveInt'), source.indexOf('const FILE_MUTATION_TOOL_NAMES')).replaceAll('export function', 'function'), context);
const { applyAgentTimelineEvent: apply, buildEventStep } = context;

const waitingStep = (segmentId) => buildEventStep({
  type: 'artifact', artifact_type: 'operation_confirmation', execution_segment_id: segmentId, operation_set_id: segmentId,
});
const resolution = (segmentId, status = 'applied', extra = {}) => ({
  type: 'artifact', artifact_type: 'operation_resolution', execution_segment_id: segmentId, operation_set_id: segmentId, status, ...extra,
});

// 单批次：应用后收敛为完成，工具链可以折叠。
let timeline = apply(
  { activeSteps: [waitingStep(11)], sessionStatus: 'waiting_operation_confirmation', loading: true },
  resolution(11),
);
assert.strictEqual(timeline.sessionStatus, 'completed');
assert.strictEqual(timeline.loading, false);
assert.ok(timeline.finishedAt, '收敛为完成时必须补齐结束时间');
assert.ok(timeline.activeSteps.every((step) => step.status !== 'waiting'), '收敛后不得残留等待步骤');

// 多批次：还有一批未处置时保持等待，不能提前收敛。
timeline = apply(
  { activeSteps: [waitingStep(11), waitingStep(12)], sessionStatus: 'waiting_confirm', loading: true },
  resolution(11),
);
assert.strictEqual(timeline.sessionStatus, 'waiting_confirm');
assert.strictEqual(timeline.loading, true);

// 服务端已续跑：保持等待展示，由续跑事件接管状态。
timeline = apply(
  { activeSteps: [waitingStep(11)], sessionStatus: 'waiting_operation_confirmation', loading: true },
  resolution(11, 'applied', { task_resumed: true }),
);
assert.strictEqual(timeline.sessionStatus, 'waiting_operation_confirmation');
const resumed = apply(timeline, { type: 'loop_start', loop_index: 3, execution_segment_id: 13 });
assert.strictEqual(resumed.sessionStatus, 'running');
assert.strictEqual(resumed.loading, true);

// 废弃：任务不再续跑，同样收敛为完成。
timeline = apply(
  { activeSteps: [waitingStep(21)], sessionStatus: 'waiting_confirm', loading: true },
  resolution(21, 'discarded'),
);
assert.strictEqual(timeline.sessionStatus, 'completed');

// 已完成的会话不受 operation_resolution 影响。
timeline = apply(
  { activeSteps: [], sessionStatus: 'completed', loading: false, finishedAt: '2026-10-10T00:00:00.000Z' },
  resolution(31),
);
assert.strictEqual(timeline.sessionStatus, 'completed');
assert.strictEqual(timeline.finishedAt, '2026-10-10T00:00:00.000Z');

console.log('agent operation resolution settle tests passed');
