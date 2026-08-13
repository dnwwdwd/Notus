const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const loop = fs.readFileSync(path.join(root, 'lib/agentLoop.js'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'hooks/useAgentLoopController.js'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'components/AgentWorkspace/AgentWorkspace.js'), 'utf8');
const taskChangeSets = fs.readFileSync(path.join(root, 'lib/agentTaskChangeSets.js'), 'utf8');

assert.ok(loop.includes("stage: 'model_requesting'"), '执行段开始后必须持久化模型请求中的真实状态。');
assert.ok(loop.includes('execution_segment_id: activeExecutionSegment.id'), '工具开始和完成事件必须带稳定执行段标识。');
assert.ok(loop.includes('tool_index: toolIndex'), '同一执行段内重复调用同一工具时必须使用稳定序号区分。');
assert.ok(controller.includes("if (event.type === 'loop_start')"), '前端必须把执行段开始事件还原为可见记录。');
assert.ok(controller.includes("if (event.type === 'model_requesting')"), '前端必须显示等待模型响应，而非只显示笼统运行状态。');
assert.ok(controller.includes("kind: 'operation_batch'"), '文件变更批次必须归入触发它的执行段。');
assert.ok(!workspace.includes('groupTimelineStepsBySegment'), '工具链不得向用户显示内部执行段分组。');
assert.ok(workspace.includes("step?.kind !== 'segment'"), '工具链必须隐藏内部执行段步骤，只保留真实工具与可见状态。');
assert.ok(controller.includes("if (event.type === 'model_progress')"), '模型可见执行说明必须作为独立的持久化时间线步骤。');
assert.ok(controller.includes("label: '正在思考'"), '模型可见执行说明在工具链中必须显示为“正在思考”。');
assert.ok(workspace.includes('正在思考'), '工具链必须提供可展开的“正在思考”步骤。');
assert.ok(controller.includes('本执行段已完成。'), '任务结束后，最后一个执行段不能继续显示等待模型响应。');
assert.ok(controller.includes('recoverPersistedSession'), '订阅中断后必须以持久化任务状态恢复界面，不能直接标记任务失败。');
assert.ok(controller.includes('payload.task_resumed && !controllerRef.current'), '手动确认后的任务在订阅已断开时必须重新订阅继续过程。');
assert.ok(workspace.includes('来源：{sourceBatchLabel}'), '累计 Diff 的文件详情必须显示执行段和批次来源。');
assert.ok(workspace.includes('source_batches: Array.isArray(patch.source_batches)'), '累计 Diff 组装文件项时不能丢弃执行段和批次来源。');
assert.ok(taskChangeSets.includes('execution_segment_sequence_no'), '累计 Diff 详情必须从持久化批次读取执行段顺序。');

console.log('agent execution segment timeline tests passed');
