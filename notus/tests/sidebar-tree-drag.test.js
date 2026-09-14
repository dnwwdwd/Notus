const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { canMoveTreeItem, normalizeTreePath } = require('../utils/sidebarTreeDrag');

assert.strictEqual(normalizeTreePath('/资料\\草稿/'), '资料/草稿');

const file = { type: 'file', path: '资料/草稿.md' };
const folder = { type: 'folder', path: '资料' };

assert.strictEqual(canMoveTreeItem(file, '归档'), true, '文件可以移动到另一目录');
assert.strictEqual(canMoveTreeItem(file, ''), true, '嵌套文件可以移动到根目录');
assert.strictEqual(canMoveTreeItem(file, '资料'), false, '文件不能重复移动到当前父目录');
assert.strictEqual(canMoveTreeItem(folder, '归档'), true, '目录可以移动到另一目录');
assert.strictEqual(canMoveTreeItem(folder, '资料'), false, '目录不能移动到自身');
assert.strictEqual(canMoveTreeItem(folder, '资料/子目录'), false, '目录不能移动到自身的子目录');
assert.strictEqual(canMoveTreeItem({ type: 'folder', path: '资料/子目录' }, ''), true, '嵌套目录可以移动到根目录');

const sidebar = fs.readFileSync(path.join(__dirname, '../components/Layout/Sidebar.js'), 'utf8');
assert.ok(sidebar.includes('const FileRow ='), '文件树行应保留独立组件');
assert.ok(sidebar.includes('setNodeRef: setDragNodeRef'), '整行必须注册为拖拽源');
assert.ok(sidebar.includes('const setRowNodeRef = useCallback'), '拖拽源和放置区必须绑定到同一行');
assert.ok(sidebar.includes('ref={setRowNodeRef}'), '文件树行必须整体承接拖拽');
assert.ok(!sidebar.includes('const FileMoveHandle'), '不再渲染独立拖动柄');
assert.ok(!sidebar.includes('<Icons.drag size={14} />'), '不再显示拖动图标');
assert.ok(sidebar.includes("new CustomEvent('notus:sidebar-mention-drop'"), '整行拖到 Agent 输入框时必须转交 Mention 插入事件');
assert.ok(sidebar.includes("new CustomEvent('notus:sidebar-editor-file-drop'"), '整行拖到富文本编辑器时必须转交文件链接插入事件');
assert.ok(sidebar.includes("getExternalDropPoint(event, '[data-notus-editor-drop]')"), '编辑器落点必须按实际指针位置判断');
assert.ok(sidebar.includes("touchAction: 'pan-y'"), '文件树行必须保留触屏纵向滚动');
assert.ok(!sidebar.includes("touchAction: 'none'"), '文件树整行不能禁用触屏滚动');

console.log('sidebar tree drag tests passed');
