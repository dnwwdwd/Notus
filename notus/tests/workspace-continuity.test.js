const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const filesPage = read('pages/files/index.js');
const layout = read('components/ui/ResizableLayout.js');
const fileWorkspace = read('components/AgentWorkspace/FileAgentWorkspace.js');
const clarifyDrawer = read('components/ChatArea/ClarifyDrawer.js');
const controller = read('hooks/useAgentLoopController.js');
const startRoute = read('pages/api/agent/loop/start.js');
const agentWorkspace = read('components/AgentWorkspace/AgentWorkspace.js');
const icons = read('components/ui/Icons.js');

assert.ok(filesPage.includes('const expandEditorForFile'), '所有打开文件入口都应复用编辑器展开逻辑');
assert.ok(filesPage.includes('expandEditorForFile();\n    if (Number(activeFileId)'), 'Diff 打开当前文件时也应展开编辑器');
assert.ok(filesPage.includes('onAgentPanelLockChange={setAgentPanelLock}'), '文件页应接收 Agent 面板锁定状态');
assert.ok(layout.includes('collapseRight = false'), '双栏布局应支持隐藏右侧面板而不卸载子树');
assert.ok(fileWorkspace.includes('interactionAnswerDrafts'), '提问卡答案应保存在文件工作区内存');
assert.ok(fileWorkspace.includes('agentPanelLocked'), '运行中或待回答时应锁定 AI 面板');
assert.ok(fileWorkspace.includes('AI 正在处理当前任务，请完成或停止任务后再收起面板。'), '锁定 AI 面板时应给出友善提示');
assert.ok(clarifyDrawer.includes('answerDraftRef'), '提问卡重渲染时应从内存草稿恢复答案');
assert.ok(controller.includes('runSequenceRef'), '恢复任务应隔离过期 SSE 事件');
assert.ok(controller.includes('runSequence !== runSequenceRef.current'), '过期等待事件不能覆盖续跑终态');
assert.ok(startRoute.includes('const expectedLoopStatus'), 'Loop 收尾应校验并写回真实终态');
assert.ok(agentWorkspace.includes('content="暂无 MCP 服务"'), '无 MCP 时应显示指定 Tooltip');
assert.ok(agentWorkspace.includes('onOpenFile={openDiffFile}'), 'Diff 文件列表应可打开文件');
assert.ok(!icons.includes("skill: ({ style, ...p } = {}) => <Icon {...p} style={{ color: 'var(--accent)'"), 'Skill 图标不能在未选中时强制强调色');

console.log('workspace continuity tests passed');
