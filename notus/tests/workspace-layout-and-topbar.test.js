const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const topBar = read('components/Layout/TopBar.js');
const filesPage = read('pages/files/index.js');
const agentWorkspace = read('components/AgentWorkspace/AgentWorkspace.js');

assert.ok(topBar.includes('selectedIcon = false'), 'top bar should support borderless selected icons');
assert.ok(topBar.includes('const HEADER_ICON_SIZE = 32'), 'top bar icons should share the settings button size');
assert.ok(topBar.includes('const EditorPanelIcon'), 'top bar should use a visual editor panel icon');
assert.ok(topBar.includes('const AgentPanelIcon'), 'top bar should use a visual agent panel icon');
assert.ok(topBar.includes('<Icons.search size={16} />'), 'top bar search should be icon-only');
assert.ok(!topBar.includes("搜索或跳转…"), 'top bar should not render the old search input pill');
assert.ok(topBar.includes('label="搜索文件"'), 'top bar search tooltip should describe file search');
assert.ok(topBar.includes('showSettingsButton = true'), 'top bar should allow pages to hide the redundant settings entry');
assert.ok(topBar.includes('shortcuts.editorToggle.combo'), 'top bar should bind the editor panel shortcut');
assert.ok(topBar.includes('shortcuts.agentToggle.combo'), 'top bar should bind the agent panel shortcut');

const shortcutsContext = read('contexts/ShortcutsContext.js');
assert.ok(shortcutsContext.includes("combo: 'Mod+B'"), 'editor panel should default to the Trae-style primary sidebar shortcut');
assert.ok(shortcutsContext.includes("combo: 'Mod+U'"), 'agent panel should default to the Trae Side Chat shortcut');

assert.ok(filesPage.includes('editorWidthPercent'), 'files page should persist the editor panel width');
assert.ok(filesPage.includes('agentWidthPercent'), 'files page should persist the agent panel width');
assert.ok(filesPage.includes('JSON.stringify({'), 'files page should serialize the workspace panel widths');
assert.ok(filesPage.includes('workspaceLayout.editorWidthPercent'), 'files page should apply the stored editor width on initialization');
assert.ok(filesPage.includes('renderedWorkspacePanels.editorOpen'), 'narrow workspace should derive the rendered editor state from the saved panel state');
assert.ok(filesPage.includes('collapseLeft={renderedEditorAutoCollapsed}'), 'narrow workspace should animate the editor closed inside the saved dual-panel layout');
assert.ok(filesPage.includes('fixedRightPx={agentFixedWidthViewport ? FILES_AGENT_FIXED_WIDTH : 0}'), 'narrow dual-pane workspace should keep the AI panel width fixed');
assert.ok(filesPage.includes('hasRestoredStartupFileRef'), 'files page should distinguish a restored startup file from a newly opened file');
assert.ok(filesPage.includes('面板状态应完全沿用上次关闭窗口时的记录'), 'a restored startup file should preserve the saved panel combination');
assert.ok(filesPage.includes('isWaitingForRestoredFile'), 'files page should keep the restored panel state while the startup file is resolving');

const appContext = read('contexts/AppContext.js');
assert.ok(appContext.includes('workspaceHydrated'), 'app context should expose when persisted workspace state has hydrated');
assert.ok(appContext.includes('restoredActiveFileId'), 'app context should retain the file selected when the workspace was restored');

assert.ok(agentWorkspace.includes('AGENT_INPUT_TEXTAREA_DEFAULT_ROWS = 5'), 'agent input should default to five rows');
assert.ok(agentWorkspace.includes("const AGENT_CHAT_CONTENT_WIDTH = '95%'"), 'agent input and messages should share the agreed 95% panel width');
assert.ok(agentWorkspace.includes('width: AGENT_CHAT_CONTENT_WIDTH'), 'agent input and messages should use the shared content width');
assert.ok(agentWorkspace.includes("maxWidth: '80%'"), 'user message bubbles should retain their right-aligned content width');
assert.ok(agentWorkspace.includes('const CHAT_JUMP_BUTTON_OFFSET = 240'), 'jump-to-bottom button should clear the taller agent input');

console.log('workspace layout and top bar tests passed');
