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

  const conversationDrawer = read('components/ChatArea/ConversationDrawer.js');
  assert.ok(conversationDrawer.includes('ConfirmDialog'));
  assert.ok(conversationDrawer.includes('Icons.trash'));
  assert.ok(conversationDrawer.includes('onDelete?.(pendingDelete.id, pendingDelete)'));

  console.log('ui bug regressions tests passed');
}

runTests();
