const assert = require('assert');
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

console.log('sidebar tree drag tests passed');
