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
const taskWorker = read('lib/agentTaskWorker.js');
const agentWorkspace = read('components/AgentWorkspace/AgentWorkspace.js');
const icons = read('components/ui/Icons.js');

assert.ok(filesPage.includes('const expandEditorForFile'), '所有打开文件入口都应复用编辑器展开逻辑');
assert.ok(filesPage.includes('expandEditorForFile();\n    if (Number(activeFileId)'), 'Diff 打开当前文件时也应展开编辑器');
assert.ok(filesPage.includes('onAgentPanelLockChange={setAgentPanelLock}'), '文件页应接收 Agent 面板锁定状态');
assert.ok(filesPage.includes("beforeAgentRun={() => (activeFile && saveState === 'dirty' ? handleSave() : true)}"), '未打开文件时不能因残留的保存状态阻断 Agent 发送');
assert.ok(layout.includes('collapseRight = false'), '双栏布局应支持隐藏右侧面板而不卸载子树');
assert.ok(fileWorkspace.includes('interactionAnswerDrafts'), '提问卡答案应保存在文件工作区内存');
assert.ok(fileWorkspace.includes('agentPanelLocked'), '提交提问卡答案时应短暂锁定 AI 面板');
assert.ok(fileWorkspace.includes('正在保存提问卡片回答，请稍候。'), '锁定 AI 面板时应给出友善提示');
assert.ok(fileWorkspace.includes("onViewAgentLogs={(conversationId) => openSettings('logs', { conversationId })}"), '历史对话中的日志入口必须把对应会话传给日志面板');
assert.ok(clarifyDrawer.includes('answerDraftRef'), '提问卡重渲染时应从内存草稿恢复答案');
assert.ok(controller.includes('runSequenceRef'), '恢复任务应隔离过期 SSE 事件');
assert.ok(controller.includes('runSequence !== runSequenceRef.current'), '过期等待事件不能覆盖续跑终态');
assert.ok(startRoute.includes('wakeAgentTaskWorker();'), '路由创建任务后必须唤醒后台 Worker');
assert.ok(taskWorker.includes('const finalSession = getSession(sessionId);'), '后台 Worker 收尾时必须读取真实会话状态');
assert.ok(taskWorker.includes("const status = finalSession.status || loopResult?.status || 'failed';"), '后台 Worker 必须写回真实终态');
assert.ok(agentWorkspace.includes('content="暂无 MCP 服务"'), '无 MCP 时应显示指定 Tooltip');
assert.ok(agentWorkspace.includes('onOpenFile={openDiffFile}'), 'Diff 文件列表应可打开文件');
assert.ok(!icons.includes("skill: ({ style, ...p } = {}) => <Icon {...p} style={{ color: 'var(--accent)'"), 'Skill 图标不能在未选中时强制强调色');

console.log('workspace continuity tests passed');
