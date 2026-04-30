// Shared app-level state: file tree, active file selection, file creation
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export const AppContext = createContext(null);
const FILE_TREE_CACHE_KEY = 'notus-file-tree-cache';
const WORKSPACE_STATE_KEY = 'notus-workspace-state';
const DEFAULT_WORKSPACE_STATE = {
  activeFileId: null,
  activePage: 'files',
  openFolders: [],
  sidebarCollapsed: false,
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

function normalizeWorkspaceState(value = {}) {
  const activeFileId = Number(value.activeFileId);
  return {
    activeFileId: Number.isFinite(activeFileId) && activeFileId > 0 ? activeFileId : null,
    activePage: ['files', 'knowledge', 'canvas'].includes(value.activePage) ? value.activePage : 'files',
    openFolders: Array.isArray(value.openFolders) ? [...new Set(value.openFolders.map((item) => String(item || '')).filter(Boolean))] : [],
    sidebarCollapsed: Boolean(value.sidebarCollapsed),
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
  const initialWorkspaceState = useMemo(() => readWorkspaceState(), []);
  const [files, setFiles] = useState(() => readCachedTree());
  const [loadingFiles, setLoadingFiles] = useState(() => readCachedTree().length === 0);
  const [hasLoadedFilesOnce, setHasLoadedFilesOnce] = useState(() => readCachedTree().length > 0);

  // In-memory file content cache (fileId → markdown string)
  const contentCache = useRef(new Map());
  const filesRef = useRef(files);
  const activeFileIdRef = useRef(initialWorkspaceState.activeFileId);
  const activePageRef = useRef(initialWorkspaceState.activePage);
  const openFoldersRef = useRef(new Set(initialWorkspaceState.openFolders));
  const sidebarCollapsedRef = useRef(initialWorkspaceState.sidebarCollapsed);
  const pendingCitationRef = useRef(initialWorkspaceState.pendingCitation);
  const [openFolders, setOpenFolders] = useState(() => new Set(initialWorkspaceState.openFolders));
  const [activeFileId, setActiveFileId] = useState(initialWorkspaceState.activeFileId);
  const [activeFile, setActiveFile] = useState(null);
  const [activePage, setActivePage] = useState(initialWorkspaceState.activePage);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialWorkspaceState.sidebarCollapsed);
  const [pendingCitation, setPendingCitation] = useState(initialWorkspaceState.pendingCitation);

  const persistWorkspaceState = useCallback((patch = {}) => {
    const nextState = normalizeWorkspaceState({
      activeFileId: activeFileIdRef.current,
      activePage: activePageRef.current,
      openFolders: [...openFoldersRef.current],
      sidebarCollapsed: sidebarCollapsedRef.current,
      pendingCitation: pendingCitationRef.current,
      ...patch,
    });
    writeWorkspaceState(nextState);
    return nextState;
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

  const createFile = useCallback(async ({ parentPath = '', name, content = '' }) => {
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
    if (nextActiveFile) {
      selectFile(nextActiveFile);
    }

    return payload;
  }, [refreshFiles, selectFile]);

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
        pendingCitation,
        workspaceState: {
          activeFileId,
          activePage,
          openFolders: [...openFolders],
          sidebarCollapsed,
          pendingCitation,
        },
        refreshFiles,
        selectFile,
        clearPendingCitation,
        setActiveWorkspacePage,
        setSidebarCollapsed: setSidebarCollapsedState,
        toggleSidebarCollapsed,
        setPendingCitation: setPendingCitationState,
        createFile,
        createFolder,
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
