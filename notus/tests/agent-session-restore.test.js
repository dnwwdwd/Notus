const assert = require('assert');
const { shouldClearAgentPresentation } = require('../utils/agentSessionRestore');

assert.strictEqual(
  shouldClearAgentPresentation({
    restoredSession: null,
    activeSession: { id: 42, status: 'queued' },
    activeSteps: [{ id: 'task-42', status: 'running' }],
  }),
  false,
  '新任务已回显、历史会话尚未刷新时，恢复逻辑不得清空消息气泡和工具链'
);

assert.strictEqual(
  shouldClearAgentPresentation({
    restoredSession: null,
    activeSession: null,
    activeSteps: [],
    streamText: '',
  }),
  true,
  '没有已恢复会话和实时任务时，应清空旧的 Agent UI 状态'
);

assert.strictEqual(
  shouldClearAgentPresentation({
    restoredSession: { id: 7, status: 'running' },
    activeSession: { id: 42, status: 'queued' },
  }),
  false,
  '读取到历史会话时，由恢复路径接管，不能走清空分支'
);

console.log('agent session restore tests passed');
