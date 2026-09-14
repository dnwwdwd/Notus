const VALID_ACTIVE_PAGES = ['files'];
const VALID_SIDEBAR_TABS = ['tree', 'toc'];

function normalizePositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next >= 0 ? Math.floor(next) : 0;
}

function normalizeFileIds(value = []) {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).reduce((ids, item) => {
    const fileId = Number(item);
    if (!Number.isFinite(fileId) || fileId <= 0 || seen.has(fileId)) return ids;
    seen.add(fileId);
    ids.push(Math.floor(fileId));
    return ids;
  }, []);
}

function normalizeSidebarScrollByTab(value = {}) {
  const tree = normalizePositiveInt(value.tree);
  const toc = normalizePositiveInt(value.toc);
  return { tree, toc };
}

function normalizeWorkspaceState(value = {}) {
  const activeFileId = Number(value.activeFileId);
  const normalizedActiveFileId = Number.isFinite(activeFileId) && activeFileId > 0 ? activeFileId : null;
  const openFileIds = normalizeFileIds(value.openFileIds);
  if (normalizedActiveFileId && !openFileIds.includes(normalizedActiveFileId)) openFileIds.push(normalizedActiveFileId);
  return {
    activeFileId: normalizedActiveFileId,
    openFileIds,
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
  normalizeFileIds,
  normalizeWorkspaceState,
};

module.exports.default = module.exports;
