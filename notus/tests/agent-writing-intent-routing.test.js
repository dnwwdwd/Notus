const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const startRoute = read('pages/api/agent/loop/start.js');
const loop = read('lib/agentLoop.js');
const prompt = read('lib/agentLoopPrompt.js');

assert.ok(!startRoute.includes('write_target_ambiguous'), '启动 Agent 时不得以近期文章候选自动创建写作目标确认卡');
assert.ok(!startRoute.includes('buildWriteTargetPreflight'), '写作目标不得在服务端预检阶段由关键词规则裁决');
assert.ok(!loop.includes('isExplicitNewFileTask'), '不得以明确新建关键词规则决定新建或修改文件');
assert.ok(!loop.includes('buildContinuationFileContext'), '不得根据正则强制复用上一轮文件或移除 create_note 工具');
assert.ok(
  prompt.includes('根据当前输入和最近对话判断本轮是新建文件、修改已有文件，还是继续讨论'),
  'Agent Prompt 必须明确将写作目标判断交给 LLM'
);
assert.ok(
  prompt.includes('目标、范围或操作仍无法定位时才调用 ask_question_card 追问'),
  '只有 LLM 无法定位目标时才允许主动提问'
);

console.log('agent writing intent routing tests passed');
