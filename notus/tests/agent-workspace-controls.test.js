const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const workspace = read('components/AgentWorkspace/AgentWorkspace.js');
const resourceEvents = read('utils/agentResourceEvents.js');
const controller = read('hooks/useAgentLoopController.js');
assert.ok(workspace.includes("if (parsed?.mode === 'server') return { mode: 'auto' };"));
assert.ok(workspace.includes("const mcpLabel = 'MCP';"));
assert.ok(workspace.includes("/api/settings/mcp/servers?enabled_only=1"));
assert.ok(workspace.includes("window.addEventListener('notus-mcp-servers-changed', onChanged);"));
assert.ok(workspace.includes("if (mcpAvailable || mcpMode !== 'auto') return;"));
assert.ok(workspace.includes('disabled={busy || disabled || !mcpAvailable}'));
assert.ok(workspace.includes('content="暂无 MCP 服务"'));
assert.ok(workspace.includes('const toggleMcp = () => {'));
assert.ok(workspace.includes("onMcpSelectionChange?.({ mode: 'auto' });"));
assert.ok(workspace.includes("onMcpSelectionChange?.({ mode: 'off' });"));
assert.ok(!workspace.includes('本次任务不提供外部 MCP 工具。'));
assert.ok(!workspace.includes('允许本次任务从已启用 Server 中自动选择相关工具。'));
assert.ok(workspace.includes('自动应用修改'));
assert.ok(workspace.includes('手动应用修改'));
assert.ok(!workspace.includes('Agent 完成后自动应用所有修改'));
assert.ok(!workspace.includes('Agent 完成后需逐文件手动确认'));
assert.ok(workspace.includes('const [modelQuery, setModelQuery] = useState(\'\');'));
assert.ok(workspace.includes('搜索模型或 Provider'));
assert.ok(workspace.includes('modelLabel(config), providerLabel(config), config?.name'));
assert.ok(workspace.includes('没有匹配的模型或 Provider'));

const drawer = read('components/ChatArea/ConversationDrawer.js');
assert.ok(drawer.includes('搜索对话或消息'));
assert.ok(drawer.includes('onSearchQueryChange'));

const fileWorkspace = read('components/AgentWorkspace/FileAgentWorkspace.js');
assert.ok(fileWorkspace.includes('const [historySearchQuery, setHistorySearchQuery]'));
assert.ok(fileWorkspace.includes("params.set('q', String(query).trim())"));
assert.ok(fileWorkspace.includes('没有匹配的历史对话'));

const conversations = read('lib/conversations.js');
assert.ok(conversations.includes('LOWER(c.title) LIKE ?'));
assert.ok(conversations.includes('EXISTS ('));
assert.ok(conversations.includes("m.role IN ('user', 'assistant')"));
assert.ok(conversations.includes('LOWER(m.content) LIKE ?'));

const conversationsApi = read('pages/api/conversations/index.js');
assert.ok(conversationsApi.includes('req.query.q'));

const layout = read('components/ui/ResizableLayout.js');
const filesPage = read('pages/files/index.js');
const sidebar = read('components/Layout/Sidebar.js');
assert.ok(layout.includes('fixedRightPx = 0'));
assert.ok(layout.includes('const hasFixedRight'));
assert.ok(filesPage.includes('const FILES_AGENT_FIXED_WIDTH = 456;'));
assert.ok(filesPage.includes("const FILES_EDITOR_AUTO_COLLAPSE_QUERY = '(max-width: 640px)'"));
assert.ok(filesPage.includes('const [editorAutoCollapsed, setEditorAutoCollapsed]'));
assert.ok(filesPage.includes('fixedRightPx={agentFixedWidthViewport ? FILES_AGENT_FIXED_WIDTH : 0}'));
assert.ok(sidebar.includes('const [autoCollapsed, setAutoCollapsed]'));
assert.ok(sidebar.includes('const isSidebarCollapsed = autoCollapsed ||'));

const settings = read('components/Settings/SettingsScreen.js');
assert.ok(settings.includes("new Event('notus-mcp-servers-changed')"));
assert.ok(settings.includes("{ id: 'global-agent', label: '全局 Agent'"));
assert.ok(resourceEvents.includes("'install_skill_from_git'"));
assert.ok(resourceEvents.includes("'skill_uninstall'"));
assert.ok(resourceEvents.includes("'add_mcp_server'"));
assert.ok(resourceEvents.includes("'mcp_remove'"));
assert.ok(controller.includes("dispatchAgentResourceChange(event.tool_name)"));
assert.ok(fileWorkspace.includes("dispatchAgentResourceChange(interaction?.payload?.action)"));

console.log('agent workspace controls tests passed');
