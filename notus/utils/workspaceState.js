const VALID_ACTIVE_PAGES = ['files', 'knowledge', 'canvas'];
const VALID_SIDEBAR_TABS = ['tree', 'toc'];

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next >= 0 ? Math.floor(next) : 0;
}

function normalizeSidebarScrollByTab(value = {}) {
  const tree = normalizePositiveInt(value.tree);
  const toc = normalizePositiveInt(value.toc);
  return { tree, toc };
}

function normalizeWorkspaceState(value = {}) {
  const activeFileId = Number(value.activeFileId);
  return {
    activeFileId: Number.isFinite(activeFileId) && activeFileId > 0 ? activeFileId : null,
    activePage: VALID_ACTIVE_PAGES.includes(value.activePage) ? value.activePage : 'files',
    openFolders: Array.isArray(value.openFolders)
      ? [...new Set(value.openFolders.map((item) => String(item || '')).filter(Boolean))]
      : [],
    sidebarCollapsed: Boolean(value.sidebarCollapsed),
    sidebarActiveTab: VALID_SIDEBAR_TABS.includes(value.sidebarActiveTab) ? value.sidebarActiveTab : 'tree',
    sidebarScrollByTab: normalizeSidebarScrollByTab(value.sidebarScrollByTab),
    pendingCitation: value.pendingCitation && typeof value.pendingCitation === 'object'
      ? {
        fileId: Number(value.pendingCitation.fileId) || null,
        preview: String(value.pendingCitation.preview || ''),
        headingPath: String(value.pendingCitation.headingPath || ''),
        lineStart: Number(value.pendingCitation.lineStart) || null,
        lineEnd: Number(value.pendingCitation.lineEnd) || null,
      }
      : null,
  };
}

module.exports = {
  VALID_ACTIVE_PAGES,
  VALID_SIDEBAR_TABS,
  normalizeSidebarScrollByTab,
  normalizeWorkspaceState,
};

module.exports.default = module.exports;
