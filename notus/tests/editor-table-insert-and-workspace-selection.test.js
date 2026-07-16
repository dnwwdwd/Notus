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

assert.ok(settings.includes("background: '#F9F9F8'"), 'image storage options should use the search settings segmented control style');
assert.ok(settings.includes("fontFamily: 'Georgia, Songti SC, STSong, serif'"), 'image storage should use the search settings heading style');
assert.ok(settings.includes('保存</Button>'), 'image storage should use the compact search settings save action');

console.log('editor table insert and workspace selection tests passed');
