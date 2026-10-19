// 验证弹窗初始聚焦的调度顺序，以及主要“修改类”弹窗都使用它。
// 背景：Radix DropdownMenu 关闭时会在 setTimeout(0) 中把焦点还给触发元素，
// 只在挂载时 autoFocus 的输入框会被抢走（标签右键 → 重命名）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

(async () => {
  const { scheduleInitialFocus } = await import('../components/ui/dialogFocus.js');

  const timers = [];
  let active = null;
  const node = {
    focus(options) { active = { target: 'input', options }; },
    select() { active = { target: 'input', selected: true }; },
  };
  const ref = { current: node };
  global.window = {
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  };

  // 菜单关闭时注册的焦点恢复先入队。
  timers.push({ callback: () => { active = { target: 'trigger' }; }, delay: 0 });
  const cancel = scheduleInitialFocus(ref, { select: true });
  assert.strictEqual(typeof cancel, 'function', '必须返回可取消的清理函数');

  // 按注册顺序执行，弹窗聚焦必须排在菜单恢复之后。
  while (timers.length) timers.shift().callback();
  assert.deepStrictEqual(active, { target: 'input', selected: true }, '弹窗输入框必须最终获得焦点并被全选');

  // 没有 ref / 已卸载时不应抛错。
  scheduleInitialFocus({ current: null }, { select: true });
  while (timers.length) timers.shift().callback();

  const dialog = read('components/ui/Dialog.js');
  assert.ok(dialog.includes("import { scheduleInitialFocus } from './dialogFocus';"), 'Dialog 必须复用统一的初始聚焦工具');
  assert.ok(dialog.includes('initialFocusRef'), 'Dialog 必须支持显式初始聚焦目标');
  assert.ok(dialog.includes('selectInitialFocus'), 'Dialog 必须支持打开时全选输入内容');

  const documentTabs = read('components/Editor/DocumentTabs.js');
  assert.ok(documentTabs.includes('const renameInputRef = useRef(null);'));
  assert.ok(documentTabs.includes('initialFocusRef={renameInputRef}'), '标签重命名弹窗必须显式指定输入框为初始焦点');
  assert.ok(documentTabs.includes('selectInitialFocus'), '标签重命名弹窗打开时应全选文件名');
  assert.ok(!documentTabs.includes('autoFocus'), '标签重命名不应依赖会被菜单抢走的 autoFocus');

  const sidebar = read('components/Layout/Sidebar.js');
  assert.ok(sidebar.includes('renameNameInputRef'), '侧边栏重命名弹窗必须显式指定输入框为初始焦点');
  assert.ok(sidebar.includes('initialFocusRef={renameNameInputRef}'));
  assert.ok(sidebar.includes('initialFocusRef={createNameInputRef}'), '新建文件/目录弹窗必须显式指定输入框为初始焦点');

  const toolbar = read('components/Editor/EditorToolbar.js');
  assert.ok(toolbar.includes('initialFocusRef={urlInputRef}'), '插入链接弹窗必须显式聚焦地址输入框');
  assert.ok(toolbar.includes('initialFocusRef={rowsInputRef}'), '插入表格弹窗必须显式聚焦行数输入框');
  assert.ok(toolbar.includes('initialFocusRef={imageUrlInputRef}'), '插入图片弹窗必须显式聚焦链接输入框');

  const editor = read('components/Editor/WysiwygEditor.js');
  assert.ok(editor.includes('initialFocusRef={mathInputRef}'), '公式弹窗必须显式聚焦内容输入框');

  const settings = read('components/Settings/SettingsScreen.js');
  assert.ok(settings.includes('initialFocusRef={tokenNameInputRef}'), 'MCP Token 弹窗必须显式聚焦名称输入框');
  assert.ok(settings.includes('initialFocusRef={serverNameInputRef}'), 'MCP Server 弹窗必须显式聚焦名称输入框');
  assert.ok(settings.includes('initialFocusRef={repositoryUrlInputRef}'), 'Git 安装 Skill 弹窗必须显式聚焦仓库地址输入框');

  console.log('dialog initial focus tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
