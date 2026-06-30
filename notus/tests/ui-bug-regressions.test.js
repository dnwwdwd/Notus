const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function runTests() {
  const findBar = read('components/ui/DocumentFindBar.js');
  assert.ok(!findBar.includes('搜索当前文档内容，回车或按钮切换匹配项'));
  assert.ok(!findBar.includes('输入关键词'));

  const unsavedDialog = read('components/ui/UnsavedChangesDialog.js');
  assert.ok(!unsavedDialog.includes('>取消</Button>'));
  assert.ok(unsavedDialog.includes('不保存离开'));
  assert.ok(unsavedDialog.includes('保存并继续'));

  const canvasBlock = read('components/Canvas/CanvasBlock.js');
  assert.ok(!canvasBlock.includes('onBlur={saveEdit}'));
  assert.ok(canvasBlock.includes('取消编辑'));
  assert.ok(canvasBlock.includes('完成'));

  const sidebar = read('components/Layout/Sidebar.js');
  assert.ok(!sidebar.includes('activeTocKey'));
  assert.ok(sidebar.includes('const selected = Boolean(t.active);'));
  assert.ok(sidebar.includes('var(--accent-subtle)'));

  const dropdownSelect = read('components/ui/DropdownSelect.js');
  assert.ok(dropdownSelect.includes('menuZIndex = 2100'));
  assert.ok(dropdownSelect.includes('zIndex: menuZIndex'));

  const tooltip = read('components/ui/Tooltip.js');
  assert.ok(tooltip.includes("maxWidth: 'min(280px, calc(100vw - 24px))'"));
  assert.ok(tooltip.includes("whiteSpace: 'normal'"));
  assert.ok(tooltip.includes("overflowWrap: 'anywhere'"));

  const conversationDrawer = read('components/ChatArea/ConversationDrawer.js');
  assert.ok(conversationDrawer.includes('ConfirmDialog'));
  assert.ok(conversationDrawer.includes('Icons.trash'));
  assert.ok(conversationDrawer.includes('onDelete?.(pendingDelete.id, pendingDelete)'));

  const agentWorkspace = read('components/AgentWorkspace/AgentWorkspace.js');
  assert.ok(agentWorkspace.includes('function OperationSetCard'));
  assert.ok(agentWorkspace.includes('function DiffDialog'));
  assert.ok(agentWorkspace.includes("attachmentMode === 'parsed'"));
  assert.ok(agentWorkspace.includes('pasted-text-'));
  assert.ok(agentWorkspace.includes('const LONG_PASTE_ATTACHMENT_THRESHOLD = 100;'));
  assert.ok(agentWorkspace.includes('const MAX_PARSED_ATTACHMENTS = 5;'));
  assert.ok(agentWorkspace.includes('mentionOptions = []'));
  assert.ok(agentWorkspace.includes('const activeMention = useMemo'));
  assert.ok(agentWorkspace.includes('function AgentWorkspace({'));
  assert.ok(agentWorkspace.includes('mentionOptions={mentionOptions}'));
  assert.ok(!agentWorkspace.includes('function AgentDiffCard'));

  const canvasPage = read('pages/canvas.js');
  assert.ok(canvasPage.includes('attachmentMode="parsed"'));
  assert.ok(canvasPage.includes("token: '@全文'"));
  assert.ok(canvasPage.includes('mentionOptions={[{ value: \'__all__\''));
  assert.ok(canvasPage.includes('clearCachedContent'));
  assert.ok(canvasPage.includes('function buildCanvasConversationListUrl()'));
  assert.ok(!canvasPage.includes("params.set('file_id'"));
  assert.ok(!canvasPage.includes("params.set('draft_key'"));

  const knowledgePage = read('pages/knowledge.js');
  assert.ok(!knowledgePage.includes('attachmentMode="parsed"'));

  console.log('ui bug regressions tests passed');
}

runTests();
