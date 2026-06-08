// Shared app-level state: file tree, active file selection, file creation
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import workspaceState from '../utils/workspaceState';

const { normalizeWorkspaceState } = workspaceState;

export const AppContext = createContext(null);
const FILE_TREE_CACHE_KEY = 'notus-file-tree-cache';
const WORKSPACE_STATE_KEY = 'notus-workspace-state';
const DEFAULT_WORKSPACE_STATE = {
  activeFileId: null,
  activePage: 'files',
  openFolders: [],
  sidebarCollapsed: false,
  sidebarActiveTab: 'tree',
  sidebarScrollByTab: { tree: 0, toc: 0 },
  pendingCitation: null,
};

function flattenTree(nodes = []) {
  return nodes.flatMap((node) => {
    if (node.type === 'folder') {
      return [node, ...flattenTree(node.children || [])];
    }
    return [node];
  });
}

function collectFolderPaths(nodes = []) {
  return flattenTree(nodes)
    .filter((item) => item.type === 'folder')
    .map((item) => item.path);
}

function getAncestorPaths(targetPath) {
  const parts = String(targetPath || '').split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

function getTopLevelFolderPath(targetPath) {
  const parts = String(targetPath || '').split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts[0];
}

function normalizeImportedPaths(paths = []) {
  return [...new Set(
    (Array.isArray(paths) ? paths : [])
      .map((item) => String(item || '').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
  )];
}

function collectImportedFolderPaths(paths = [], options = {}) {
  const normalizedPaths = normalizeImportedPaths(paths);
  const folders = new Set();

  normalizedPaths.forEach((targetPath) => {
    if (options.rootsOnly) {
      const rootFolder = getTopLevelFolderPath(targetPath);
      if (rootFolder) folders.add(rootFolder);
      return;
    }

    getAncestorPaths(targetPath).forEach((folderPath) => folders.add(folderPath));
  });

  return [...folders];
}

function readCachedTree() {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(FILE_TREE_CACHE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeCachedTree(tree) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(FILE_TREE_CACHE_KEY, JSON.stringify(Array.isArray(tree) ? tree : []));
  } catch {}
}

function readWorkspaceState() {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE_STATE;
  try {
    return normalizeWorkspaceState(JSON.parse(window.localStorage.getItem(WORKSPACE_STATE_KEY) || '{}'));
  } catch {
    return DEFAULT_WORKSPACE_STATE;
  }
}

function writeWorkspaceState(nextState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(WORKSPACE_STATE_KEY, JSON.stringify(normalizeWorkspaceState(nextState)));
  } catch {}
}

export function AppProvider({ children }) {
  const initialWorkspaceState = DEFAULT_WORKSPACE_STATE;
  const [files, setFiles] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [hasLoadedFilesOnce, setHasLoadedFilesOnce] = useState(false);

  // In-memory file content cache (fileId → markdown string)
  const contentCache = useRef(new Map());
  const filesRef = useRef(files);
  const workspaceHydratedRef = useRef(false);
  const activeFileIdRef = useRef(initialWorkspaceState.activeFileId);
  const activePageRef = useRef(initialWorkspaceState.activePage);
  const openFoldersRef = useRef(new Set(initialWorkspaceState.openFolders));
  const sidebarCollapsedRef = useRef(initialWorkspaceState.sidebarCollapsed);
  const sidebarActiveTabRef = useRef(initialWorkspaceState.sidebarActiveTab);
  const sidebarScrollByTabRef = useRef(initialWorkspaceState.sidebarScrollByTab);
  const pendingCitationRef = useRef(initialWorkspaceState.pendingCitation);
  const [openFolders, setOpenFolders] = useState(() => new Set(initialWorkspaceState.openFolders));
  const [activeFileId, setActiveFileId] = useState(initialWorkspaceState.activeFileId);
  const [activeFile, setActiveFile] = useState(null);
  const [activePage, setActivePage] = useState(initialWorkspaceState.activePage);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialWorkspaceState.sidebarCollapsed);
  const [sidebarActiveTab, setSidebarActiveTab] = useState(initialWorkspaceState.sidebarActiveTab);
  const [sidebarScrollByTab, setSidebarScrollByTab] = useState(() => ({
    tree: Number(initialWorkspaceState.sidebarScrollByTab?.tree) || 0,
    toc: Number(initialWorkspaceState.sidebarScrollByTab?.toc) || 0,
  }));
  const [pendingCitation, setPendingCitation] = useState(initialWorkspaceState.pendingCitation);

  const persistWorkspaceState = useCallback((patch = {}) => {
    const baseState = workspaceHydratedRef.current
      ? {
        activeFileId: activeFileIdRef.current,
        activePage: activePageRef.current,
        openFolders: [...openFoldersRef.current],
        sidebarCollapsed: sidebarCollapsedRef.current,
        sidebarActiveTab: sidebarActiveTabRef.current,
        sidebarScrollByTab: sidebarScrollByTabRef.current,
        pendingCitation: pendingCitationRef.current,
      }
      : readWorkspaceState();
    const nextState = normalizeWorkspaceState({ ...baseState, ...patch });
    writeWorkspaceState(nextState);
    return nextState;
  }, []);

  useEffect(() => {
    const cachedTree = readCachedTree();
    const nextWorkspaceState = readWorkspaceState();

    if (cachedTree.length > 0) {
      filesRef.current = cachedTree;
      setFiles(cachedTree);
      setLoadingFiles(false);
      setHasLoadedFilesOnce(true);
    }

    activeFileIdRef.current = nextWorkspaceState.activeFileId;
    activePageRef.current = nextWorkspaceState.activePage;
    openFoldersRef.current = new Set(nextWorkspaceState.openFolders);
    sidebarCollapsedRef.current = nextWorkspaceState.sidebarCollapsed;
    sidebarActiveTabRef.current = nextWorkspaceState.sidebarActiveTab;
    sidebarScrollByTabRef.current = nextWorkspaceState.sidebarScrollByTab;
    pendingCitationRef.current = nextWorkspaceState.pendingCitation;
    workspaceHydratedRef.current = true;

    setActiveFileId(nextWorkspaceState.activeFileId);
    setActivePage(nextWorkspaceState.activePage);
    setOpenFolders(new Set(nextWorkspaceState.openFolders));
    setSidebarCollapsed(nextWorkspaceState.sidebarCollapsed);
    setSidebarActiveTab(nextWorkspaceState.sidebarActiveTab);
    setSidebarScrollByTab({
      tree: Number(nextWorkspaceState.sidebarScrollByTab?.tree) || 0,
      toc: Number(nextWorkspaceState.sidebarScrollByTab?.toc) || 0,
    });
    setPendingCitation(nextWorkspaceState.pendingCitation);
  }, []);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    activeFileIdRef.current = activeFileId;
  }, [activeFileId]);

  useEffect(() => {
    openFoldersRef.current = openFolders;
  }, [openFolders]);

  useEffect(() => {
    activePageRef.current = activePage;
  }, [activePage]);

  useEffect(() => {
    sidebarCollapsedRef.current = sidebarCollapsed;
  }, [sidebarCollapsed]);

  useEffect(() => {
    sidebarActiveTabRef.current = sidebarActiveTab;
  }, [sidebarActiveTab]);

  useEffect(() => {
    sidebarScrollByTabRef.current = sidebarScrollByTab;
  }, [sidebarScrollByTab]);

  useEffect(() => {
    pendingCitationRef.current = pendingCitation;
  }, [pendingCitation]);

  const refreshFiles = useCallback(async (options = {}) => {
    const hasExistingTree = filesRef.current.length > 0;
    const background = options.background ?? hasExistingTree;
    if (!background || !hasExistingTree) {
      setLoadingFiles(true);
    }
    try {
      const response = await fetch('/api/files/tree');
      const tree = await response.json();
      if (!response.ok) {
        throw new Error(tree.error || '读取文件树失败');
      }

      setFiles(tree);
      writeCachedTree(tree);
      setHasLoadedFilesOnce(true);

      const flat = flattenTree(tree);
      if (activeFileIdRef.current) {
        const nextActiveFile = flat.find((item) => item.type === 'file' && item.id === activeFileIdRef.current) || null;
        setActiveFile(nextActiveFile);
        if (!nextActiveFile) {
          setActiveFileId(null);
          persistWorkspaceState({ activeFileId: null, pendingCitation: null });
        }
      }

      return tree;
    } finally {
      setLoadingFiles(false);
    }
  }, [persistWorkspaceState]);

  useEffect(() => {
    refreshFiles({ background: filesRef.current.length > 0 }).catch(() => {});
  }, [refreshFiles]);

  useEffect(() => {
    const flat = flattenTree(files);
    if (!activeFileId) {
      setActiveFile(null);
      return;
    }
    const nextActiveFile = flat.find((item) => item.type === 'file' && item.id === activeFileId) || null;
    setActiveFile(nextActiveFile);
  }, [activeFileId, files]);

  const toggleFolder = useCallback((folderPath) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      persistWorkspaceState({ openFolders: [...next] });
      return next;
    });
  }, [persistWorkspaceState]);

  const clearPendingCitation = useCallback(() => {
    setPendingCitation(null);
    persistWorkspaceState({ pendingCitation: null });
  }, [persistWorkspaceState]);

  const selectFile = useCallback((file, options = {}) => {
    const nextFileId = Number(file?.id);
    if (!Number.isFinite(nextFileId) || nextFileId <= 0) return;
    const nextPendingCitation = options.pendingCitation
      ? {
        fileId: nextFileId,
        preview: options.pendingCitation.preview || '',
        headingPath: options.pendingCitation.headingPath || '',
        lineStart: options.pendingCitation.lineStart || null,
        lineEnd: options.pendingCitation.lineEnd || null,
      }
      : null;

    setActiveFileId(nextFileId);
    setActiveFile(file);
    setPendingCitation(nextPendingCitation);
    setOpenFolders((prev) => {
      const next = new Set(prev);
      getAncestorPaths(file.path).forEach((folderPath) => next.add(folderPath));
      persistWorkspaceState({
        activeFileId: nextFileId,
        openFolders: [...next],
        pendingCitation: nextPendingCitation,
      });
      return next;
    });
  }, [persistWorkspaceState]);

  const setActiveWorkspacePage = useCallback((page) => {
    const nextPage = ['files', 'knowledge', 'canvas'].includes(page) ? page : 'files';
    setActivePage(nextPage);
    persistWorkspaceState({ activePage: nextPage });
  }, [persistWorkspaceState]);

  const setSidebarCollapsedState = useCallback((collapsed) => {
    setSidebarCollapsed(Boolean(collapsed));
    persistWorkspaceState({ sidebarCollapsed: Boolean(collapsed) });
  }, [persistWorkspaceState]);

  const setSidebarActiveTabState = useCallback((tab) => {
    const nextTab = tab === 'toc' ? 'toc' : 'tree';
    setSidebarActiveTab(nextTab);
    persistWorkspaceState({ sidebarActiveTab: nextTab });
  }, [persistWorkspaceState]);

  const setSidebarScrollState = useCallback((tab, scrollTop) => {
    const nextTab = tab === 'toc' ? 'toc' : 'tree';
    const nextScrollTop = Math.max(Number(scrollTop) || 0, 0);
    setSidebarScrollByTab((prev) => {
      const next = {
        tree: Number(prev.tree) || 0,
        toc: Number(prev.toc) || 0,
      };
      next[nextTab] = nextScrollTop;
      persistWorkspaceState({ sidebarScrollByTab: next });
      return next;
    });
  }, [persistWorkspaceState]);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      persistWorkspaceState({ sidebarCollapsed: next });
      return next;
    });
  }, [persistWorkspaceState]);

  const setPendingCitationState = useCallback((citation) => {
    const nextCitation = citation && typeof citation === 'object'
      ? {
        fileId: Number(citation.fileId) || null,
        preview: String(citation.preview || ''),
        headingPath: String(citation.headingPath || ''),
        lineStart: Number(citation.lineStart) || null,
        lineEnd: Number(citation.lineEnd) || null,
      }
      : null;
    setPendingCitation(nextCitation);
    persistWorkspaceState({ pendingCitation: nextCitation });
  }, [persistWorkspaceState]);

  const allFiles = useMemo(
    () => flattenTree(files).filter((item) => item.type === 'file'),
    [files]
  );

  const folderOptions = useMemo(() => ([
    { value: '', label: '根目录' },
    ...collectFolderPaths(files).map((folderPath) => ({
      value: folderPath,
      label: folderPath,
    })),
  ]), [files]);

  const createFolder = useCallback(async ({ parentPath = '', name }) => {
    const folderPath = [parentPath, name].filter(Boolean).join('/');
    const response = await fetch('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'folder', path: folderPath }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || '创建目录失败');
    }

    await refreshFiles();
    setOpenFolders((prev) => {
      const next = new Set(prev).add(payload.path);
      persistWorkspaceState({ openFolders: [...next] });
      return next;
    });
    return payload;
  }, [persistWorkspaceState, refreshFiles]);

  const getCachedContent = useCallback((fileId) => contentCache.current.get(fileId), []);
  const setCachedContent = useCallback((fileId, content) => { contentCache.current.set(fileId, content); }, []);
  const clearCachedContent = useCallback((fileId) => { contentCache.current.delete(fileId); }, []);

  const createFile = useCallback(async ({ parentPath = '', name, content = '' }, options = {}) => {
    const filePath = [parentPath, name].filter(Boolean).join('/');
    const response = await fetch('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'file', path: filePath, content }),
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || '创建文件失败');
    }

    const nextTree = await refreshFiles();
    const nextActiveFile = flattenTree(nextTree).find((item) => item.type === 'file' && item.id === payload.id);
    if (nextActiveFile && options.autoSelect !== false) {
      selectFile(nextActiveFile);
    }

    return {
      ...payload,
      selectedFile: nextActiveFile || null,
    };
  }, [refreshFiles, selectFile]);

  const syncImportedPaths = useCallback(async (paths = [], options = {}) => {
    const normalizedPaths = normalizeImportedPaths(paths);
    const nextTree = await refreshFiles({ background: false });

    if (normalizedPaths.length === 0) {
      return nextTree;
    }

    const folderPaths = collectImportedFolderPaths(normalizedPaths, {
      rootsOnly: Boolean(options.rootsOnly),
    });

    if (folderPaths.length > 0) {
      setOpenFolders((prev) => {
        const next = new Set(prev);
        folderPaths.forEach((folderPath) => next.add(folderPath));
        persistWorkspaceState({ openFolders: [...next] });
        return next;
      });
    }

    if (options.selectPath) {
      const targetPath = String(options.selectPath || '');
      const nextActiveFile = flattenTree(nextTree).find((item) => item.type === 'file' && item.path === targetPath);
      if (nextActiveFile) {
        selectFile(nextActiveFile);
      }
    }

    return nextTree;
  }, [persistWorkspaceState, refreshFiles, selectFile]);

  return (
    <AppContext.Provider
      value={{
        files,
        allFiles,
        folderOptions,
        loadingFiles,
        hasLoadedFilesOnce,
        openFolders,
        activePage,
        toggleFolder,
        activeFileId,
        activeFile,
        sidebarCollapsed,
        sidebarActiveTab,
        sidebarScrollByTab,
        pendingCitation,
        workspaceState: {
          activeFileId,
          activePage,
          openFolders: [...openFolders],
          sidebarCollapsed,
          sidebarActiveTab,
          sidebarScrollByTab,
          pendingCitation,
        },
        refreshFiles,
        selectFile,
        clearPendingCitation,
        setActiveWorkspacePage,
        setSidebarCollapsed: setSidebarCollapsedState,
        setSidebarActiveTab: setSidebarActiveTabState,
        setSidebarScroll: setSidebarScrollState,
        toggleSidebarCollapsed,
        setPendingCitation: setPendingCitationState,
        createFile,
        createFolder,
        syncImportedPaths,
        getCachedContent,
        setCachedContent,
        clearCachedContent,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
