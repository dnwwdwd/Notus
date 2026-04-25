// Shared app-level state: file tree, active file selection, file creation
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export const AppContext = createContext(null);
const FILE_TREE_CACHE_KEY = 'notus-file-tree-cache';

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

export function AppProvider({ children }) {
  const [files, setFiles] = useState(() => readCachedTree());
  const [loadingFiles, setLoadingFiles] = useState(() => readCachedTree().length === 0);
  const [hasLoadedFilesOnce, setHasLoadedFilesOnce] = useState(() => readCachedTree().length > 0);

  // In-memory file content cache (fileId → markdown string)
  const contentCache = useRef(new Map());
  const filesRef = useRef(files);
  const activeFileIdRef = useRef(null);
  const [openFolders, setOpenFolders] = useState(
    () => new Set(['技术文章', '技术文章/缓存系列', '随笔', '读书笔记'])
  );
  const [activeFileId, setActiveFileId] = useState(null);
  const [activeFile, setActiveFile] = useState(null);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    activeFileIdRef.current = activeFileId;
  }, [activeFileId]);

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
        if (!nextActiveFile) setActiveFileId(null);
      }

      return tree;
    } finally {
      setLoadingFiles(false);
    }
  }, [activeFileId]);

  useEffect(() => {
    refreshFiles({ background: filesRef.current.length > 0 }).catch(() => {});
  }, [refreshFiles]);

  const toggleFolder = useCallback((folderPath) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const selectFile = useCallback((file) => {
    setActiveFileId(file.id);
    setActiveFile(file);
    setOpenFolders((prev) => {
      const next = new Set(prev);
      getAncestorPaths(file.path).forEach((folderPath) => next.add(folderPath));
      return next;
    });
  }, []);

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
    setOpenFolders((prev) => new Set(prev).add(payload.path));
    return payload;
  }, [refreshFiles]);

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
        toggleFolder,
        activeFileId,
        activeFile,
        refreshFiles,
        selectFile,
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
