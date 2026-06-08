const assert = require('assert');

const {
  normalizeSidebarScrollByTab,
  normalizeWorkspaceState,
} = require('../utils/workspaceState');

function runTests() {
  assert.deepStrictEqual(normalizeSidebarScrollByTab({ tree: 24.8, toc: '19' }), {
    tree: 24,
    toc: 19,
  });

  assert.deepStrictEqual(normalizeSidebarScrollByTab({ tree: -4, toc: 'bad' }), {
    tree: 0,
    toc: 0,
  });

  const normalized = normalizeWorkspaceState({
    activeFileId: '12',
    activePage: 'knowledge',
    openFolders: ['a', 'a', '', null, 'b/c'],
    sidebarCollapsed: 1,
    sidebarActiveTab: 'toc',
    sidebarScrollByTab: { tree: 120, toc: 48 },
    pendingCitation: {
      fileId: '12',
      preview: 'hello',
      headingPath: 'A > B',
      lineStart: '7',
      lineEnd: '9',
    },
  });

  assert.strictEqual(normalized.activeFileId, 12);
  assert.strictEqual(normalized.activePage, 'knowledge');
  assert.deepStrictEqual(normalized.openFolders, ['a', 'b/c']);
  assert.strictEqual(normalized.sidebarCollapsed, true);
  assert.strictEqual(normalized.sidebarActiveTab, 'toc');
  assert.deepStrictEqual(normalized.sidebarScrollByTab, { tree: 120, toc: 48 });
  assert.deepStrictEqual(normalized.pendingCitation, {
    fileId: 12,
    preview: 'hello',
    headingPath: 'A > B',
    lineStart: 7,
    lineEnd: 9,
  });

  const fallback = normalizeWorkspaceState({
    activeFileId: -1,
    activePage: 'settings',
    sidebarActiveTab: 'bad',
    sidebarScrollByTab: { tree: -10, toc: Infinity },
  });

  assert.strictEqual(fallback.activeFileId, null);
  assert.strictEqual(fallback.activePage, 'files');
  assert.strictEqual(fallback.sidebarActiveTab, 'tree');
  assert.deepStrictEqual(fallback.sidebarScrollByTab, { tree: 0, toc: 0 });

  console.log('workspace state tests passed');
}

runTests();
