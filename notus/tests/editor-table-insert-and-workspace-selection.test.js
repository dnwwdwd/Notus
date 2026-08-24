const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const toolbar = read('components/Editor/EditorToolbar.js');
const sidebar = read('components/Layout/Sidebar.js');
const appContext = read('contexts/AppContext.js');
const settings = read('components/Settings/SettingsScreen.js');

assert.ok(toolbar.includes('const TableDialog ='), 'toolbar should provide a table size dialog');
assert.ok(toolbar.includes('insertTable({ rows, cols: columns, withHeaderRow: true })'), 'toolbar should insert a real Tiptap table');
assert.ok(toolbar.includes('title="插入表格"'), 'toolbar should expose the table insertion action');

assert.ok(appContext.includes('const clearFileSelection = useCallback'), 'workspace context should expose file deselection');
assert.ok(appContext.includes('activeFileId: null, pendingCitation: null'), 'file deselection should clear persisted selection');
assert.ok(sidebar.includes('clearFileSelection();'), 'sidebar should clear the selected file when clicked again');
assert.ok(sidebar.includes("navigateWithFallback(router, `/${currentPage}`, { mode: 'router' })"), 'sidebar should remove the fileId route state after deselection');

assert.ok(settings.includes('<SegmentedTabs value={selectedProvider}'), 'image storage should use the shared segmented control');
assert.ok(settings.includes('ariaLabel="图床服务商"'), 'image storage provider selector should keep an accessible label');
assert.ok(settings.includes('onSaved={applySettings}'), 'image storage provider save should refresh the active configuration');
assert.ok(settings.includes("if (!isConfiguredImageTarget(target))") && settings.indexOf('setImageTarget(target);') > settings.indexOf("if (!isConfiguredImageTarget(target))"), '未配置图床只提示，不应切换当前上传位置');

console.log('editor table insert and workspace selection tests passed');
