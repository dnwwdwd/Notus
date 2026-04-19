// Shared app-level state: file tree, active file selection, file creation
import { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';

export const AppContext = createContext(null);

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

export function AppProvider({ children }) {
  const [files, setFiles] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [openFolders, setOpenFolders] = useState(
    () => new Set(['技术文章', '技术文章/缓存系列', '随笔', '读书笔记'])
  );
  const [activeFileId, setActiveFileId] = useState(null);
  const [activeFile, setActiveFile] = useState(null);

  const refreshFiles = useCallback(async () => {
    setLoadingFiles(true);
    try {
      const response = await fetch('/api/files/tree');
      const tree = await response.json();
      if (!response.ok) {
        throw new Error(tree.error || '读取文件树失败');
      }

      setFiles(tree);

      const flat = flattenTree(tree);
      if (activeFileId) {
        const nextActiveFile = flat.find((item) => item.type === 'file' && item.id === activeFileId) || null;
        setActiveFile(nextActiveFile);
        if (!nextActiveFile) setActiveFileId(null);
      }

      return tree;
    } finally {
      setLoadingFiles(false);
    }
  }, [activeFileId]);

  useEffect(() => {
    refreshFiles();
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
        openFolders,
        toggleFolder,
        activeFileId,
        activeFile,
        refreshFiles,
        selectFile,
        createFile,
        createFolder,
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
