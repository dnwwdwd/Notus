const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const workspaceSource = read('components/AgentWorkspace/AgentWorkspace.js');
const fileWorkspaceSource = read('components/AgentWorkspace/FileAgentWorkspace.js');
const filesPageSource = read('pages/files/index.js');
const styleSource = read('styles/globals.css');
const traceStatusSource = read('components/AgentWorkspace/TraceStatus.js');

// 1. 模型输出期间不得自动滚动：只保留对话切换与用户消息两个锚点。
assert.ok(
  workspaceSource.includes('}, [conversationScrollKey, userMessageScrollKey]);'),
  '滚动锚点必须只由对话切换和用户消息决定'
);
assert.ok(
  !workspaceSource.includes('activeStepsScrollKey'),
  '工具步骤变化不得再触发自动滚动'
);
assert.ok(
  !workspaceSource.includes('messageScrollKey'),
  '流式正文长度不得再触发自动滚动'
);
assert.ok(
  !workspaceSource.includes("querySelector('.notus-agent-workspace__content')"),
  '内容尺寸变化（ResizeObserver 贴底）不得再自动滚动'
);
assert.ok(
  workspaceSource.includes('const conversationScrollKey = String(conversationId || \'\');'),
  '切换对话仍应滚到底部'
);
assert.ok(
  workspaceSource.includes('const userMessages = visibleMessages.filter((message) => message?.role === \'user\');'),
  '用户自己发出消息时仍应滚到底部'
);
assert.ok(
  workspaceSource.includes("aria-label=\"滚动到最新消息\"") && workspaceSource.includes("scrollContainerToBottom(container, 'smooth')"),
  '手动“滚动到最新消息”按钮必须保留'
);

// 2. 任务结束后一律折叠工具链，包含已查看图片的记录；仍在运行或需要处理时保持展开。
assert.ok(
  workspaceSource.includes('if (!liveSession && !hasActionRequired) setTraceExpanded(false);'),
  '任务结束后必须自动折叠工具链'
);
assert.ok(
  !workspaceSource.includes('hasViewedImages'),
  '图片记录不再阻止自动折叠'
);
assert.ok(
  workspaceSource.includes('const [traceExpanded, setTraceExpanded] = useState(() => liveSession || hasActionRequired);'),
  '初始展开状态只由运行中与需要处理决定'
);

// 3. 状态文案的擦亮只表示“正在运行”，任务结束后必须停止，且覆盖整行（含“N 秒”）。
const baseStatusRule = (styleSource.match(/\.notus-agent-trace-status \{[\s\S]*?\n\}/) || [''])[0];
const runningStatusRule = (styleSource.match(/\.notus-agent-trace-status\[data-running\] \{[\s\S]*?\n\}/) || [''])[0];
assert.ok(
  runningStatusRule.includes('background-clip: text;') && runningStatusRule.includes('var(--text-primary) 50%'),
  '运行中的状态行必须使用窄而平滑的渐变裁剪擦亮效果'
);
assert.ok(
  !baseStatusRule.includes('animation') && !baseStatusRule.includes('background-image') && !baseStatusRule.includes('color: transparent'),
  '擦亮不能无条件生效，否则任务结束后“已处理”还在持续擦亮'
);
assert.ok(
  !styleSource.includes('.notus-agent-trace-status__phase {'),
  '擦亮不能只挂在“正在处理”这一个片段上，否则“N 秒”没有高光'
);
assert.ok(
  runningStatusRule.includes('background-repeat: repeat-x;'),
  '擦亮背景必须横向平铺，避免位移时文字落到渐变之外而消失'
);
assert.ok(
  runningStatusRule.includes('animation: notus-trace-shine 2.4s linear infinite;'),
  '擦亮动画必须持续循环且速度适中'
);
assert.ok(
  styleSource.includes('0% { background-position: 150% 0; }') && styleSource.includes('62% { background-position: -50% 0; }'),
  '擦亮必须反复从左到右，并在每次擦过后留出停顿'
);
assert.ok(
  traceStatusSource.includes('data-running={running || undefined}'),
  '状态行必须只在运行中带上 data-running，任务结束后停止擦亮'
);
assert.ok(
  traceStatusSource.includes('className="notus-agent-trace-status__elapsed"'),
  '秒数与状态文案必须同处一个状态行，才能一起被擦亮覆盖'
);
assert.ok(
  !traceStatusSource.includes('data-animate') && !traceStatusSource.includes('key={phase}'),
  '状态行不再按片段重挂载，擦亮由整行统一承担'
);
assert.ok(
  styleSource.includes('prefers-reduced-motion: reduce') && styleSource.includes('-webkit-text-fill-color: currentColor;'),
  '减少动态效果时必须恢复普通文字颜色，不能留下透明文字'
);

// 4. 网页标题优先级：编辑器打开用文章标题，编辑器收起、AI 面板打开用已打开对话标题。
assert.ok(
  fileWorkspaceSource.includes('onActiveConversationChange'),
  '文件工作区必须把当前对话标题上报给文件页'
);
assert.ok(
  fileWorkspaceSource.includes('getConversationTitle(active)'),
  '对话标题必须与历史对话列表使用同一取值规则'
);
assert.ok(
  filesPageSource.includes('const [activeConversation, setActiveConversation] = useState({ id: null, title: \'\' });'),
  '文件页必须保存当前打开的对话信息'
);
assert.ok(
  filesPageSource.includes('onActiveConversationChange={setActiveConversation}'),
  '文件页必须接入对话标题上报'
);
assert.ok(
  filesPageSource.includes('const pageTitle = renderedWorkspacePanels.editorOpen')
    && filesPageSource.includes('? (articlePageTitle || (workspacePanels.agentOpen ? conversationPageTitle : \'\') || \'Notus\')')
    && filesPageSource.includes(': (workspacePanels.agentOpen && conversationPageTitle ? conversationPageTitle : \'Notus\');'),
  '网页标题必须按编辑器优先、其次已打开对话、最后 Notus 的优先级取值'
);

console.log('agent ui scroll, toolchain collapse, status shine and page title priority tests passed');
