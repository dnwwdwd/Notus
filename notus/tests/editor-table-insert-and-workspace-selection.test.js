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

assert.ok(appContext.includes('const clearFileSelection = useCallback'), 'workspace context should retain explicit file deselection support');
assert.ok(appContext.includes('activeFileId: null, pendingCitation: null'), 'explicit file deselection should clear persisted selection');
assert.ok(!sidebar.includes('clearFileSelection();'), '再次点击当前文件不应关闭或取消当前标签');
assert.ok(sidebar.includes('if (Number(file?.id) === Number(activeFileId))'), '当前文件点击应被识别为不创建重复标签的操作');

assert.ok(settings.includes('<SegmentedTabs value={selectedProvider}'), 'image storage should use the shared segmented control');
assert.ok(settings.includes('ariaLabel="图床服务商"'), 'image storage provider selector should keep an accessible label');
assert.ok(settings.includes('onSaved={applySettings}'), 'image storage provider save should refresh the active configuration');
assert.ok(settings.includes("if (!isConfiguredImageTarget(target))") && settings.indexOf('setImageTarget(target);') > settings.indexOf("if (!isConfiguredImageTarget(target))"), '未配置图床只提示，不应切换当前上传位置');

console.log('editor table insert and workspace selection tests passed');
