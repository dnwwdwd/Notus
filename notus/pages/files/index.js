// /files — File management + WYSIWYG markdown editor (Tiptap)
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { Shell } from '../../components/Layout/Shell';
import { EditorToolbar } from '../../components/Editor/EditorToolbar';
import { DocumentTabs } from '../../components/Editor/DocumentTabs';
import { FileAgentWorkspace } from '../../components/AgentWorkspace/FileAgentWorkspace';
import { UnindexedFilesDialog } from '../../components/Indexing/UnindexedFilesDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { SkeletonText } from '../../components/ui/Skeleton';
import { InlineError } from '../../components/ui/InlineError';
import { DocumentFindBar } from '../../components/ui/DocumentFindBar';
import { Icons } from '../../components/ui/Icons';
import { ResizableLayout } from '../../components/ui/ResizableLayout';
import { useToast } from '../../components/ui/Toast';
import { useApp } from '../../contexts/AppContext';
import { useDocumentFind } from '../../hooks/useDocumentFind';
import { useEditorToc } from '../../hooks/useEditorToc';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import {
  getEditorRoot,
  getEditorScrollContainer,
  getQueryValue,
  previewFromLines,
  retryFocusCitationTarget,
} from '../../utils/documentNavigation';
import {
  readViewPosition,
  retryRestoreViewPosition,
  restoreEditorViewPosition,
  writeEditorViewPosition,
} from '../../utils/viewPosition';
import { getFileNameLabel } from '../../lib/documentLabels';
import { mergeEditorVisibleMarkdown, splitEditorVisibleMarkdown } from '../../lib/markdownMeta';

// WysiwygEditor: SSR-incompatible (Tiptap uses DOM APIs)
// onEditorReady lifts the editor instance up so the toolbar can use it
const WysiwygEditor = dynamic(
  () => import('../../components/Editor/WysiwygEditor').then((m) => m.WysiwygEditor),
  { ssr: false, loading: () => <SkeletonText lines={7} /> }
);

const FILES_LAYOUT_STORAGE_KEY = 'notus-files-workspace-layout';
const FILES_PANELS_STORAGE_KEY = 'notus-files-workspace-panels';
const FILES_LAYOUT_DEFAULT = 60;
const FILES_LAYOUT_MIN = 38;
const FILES_LAYOUT_MAX = 70;
const FILES_EDITOR_MIN_WIDTH = 560;
const FILES_AGENT_MIN_WIDTH = 456;
const FILES_AGENT_FIXED_WIDTH = 456;
const FILES_AGENT_FIXED_WIDTH_QUERY = '(max-width: 1280px)';
const FILES_EDITOR_AUTO_COLLAPSE_QUERY = '(max-width: 760px)';

function splitEditorTitleAndBody(visibleContent = '', fallbackTitle = '') {
  const source = String(visibleContent || '').replace(/\r\n/g, '\n').replace(/^\n+/, '');
  const heading = source.match(/^#\s+([^\n]+)(?:\n|$)/);
  if (!heading) {
    return {
      title: String(fallbackTitle || '').trim(),
      body: source,
    };
  }
  return {
    title: String(heading[1] || '').trim(),
    body: source.slice(heading[0].length).replace(/^\n+/, ''),
  };
}

function clampFilesLayout(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return FILES_LAYOUT_DEFAULT;
  return Math.min(Math.max(parsed, FILES_LAYOUT_MIN), FILES_LAYOUT_MAX);
}

function findFileInTree(nodes = [], path = '') {
  const normalizedPath = String(path || '').replace(/\\/g, '/').trim();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.type === 'file' && String(node.path || '').replace(/\\/g, '/') === normalizedPath) return node;
    const nested = findFileInTree(node?.children || [], normalizedPath);
    if (nested) return nested;
  }
  return null;
}

function findFileByIdInTree(nodes = [], fileId) {
  const targetFileId = Number(fileId);
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node?.type === 'file' && Number(node.id) === targetFileId) return node;
    const nested = findFileByIdInTree(node?.children || [], targetFileId);
    if (nested) return nested;
  }
  return null;
}

function readFilesWorkspaceLayout() {
  if (typeof window === 'undefined') return { editorWidthPercent: FILES_LAYOUT_DEFAULT, agentWidthPercent: 100 - FILES_LAYOUT_DEFAULT };
  try {
    const raw = window.localStorage.getItem(FILES_LAYOUT_STORAGE_KEY);
    const parsed = JSON.parse(raw || 'null');
    const legacyValue = Number.parseFloat(raw);
    const editorWidthPercent = clampFilesLayout(
      parsed && typeof parsed === 'object'
        ? (parsed.editorWidthPercent ?? parsed.editorPercent ?? parsed.leftPercent)
        : legacyValue
    );
    return { editorWidthPercent, agentWidthPercent: 100 - editorWidthPercent };
  } catch {
    return { editorWidthPercent: FILES_LAYOUT_DEFAULT, agentWidthPercent: 100 - FILES_LAYOUT_DEFAULT };
  }
}

function writeFilesWorkspaceLayout(value) {
  if (typeof window === 'undefined') return;
  const editorWidthPercent = clampFilesLayout(
    typeof value === 'object' ? value.editorWidthPercent : value
  );
  try {
    window.localStorage.setItem(FILES_LAYOUT_STORAGE_KEY, JSON.stringify({
      editorWidthPercent,
      agentWidthPercent: 100 - editorWidthPercent,
    }));
  } catch {}
}

function readFilesWorkspacePanels() {
  if (typeof window === 'undefined') return { editorOpen: true, agentOpen: true };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(FILES_PANELS_STORAGE_KEY) || '{}');
    return {
      editorOpen: parsed?.editorOpen !== false,
      agentOpen: parsed?.agentOpen !== false,
    };
  } catch {
    return { editorOpen: true, agentOpen: true };
  }
}

function writeFilesWorkspacePanels(panels) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(FILES_PANELS_STORAGE_KEY, JSON.stringify(panels)); } catch {}
}

export default function FilesPage() {
  const router = useRouter();
  const toast = useToast();
  const {
    activeFile,
    activeFileId: workspaceActiveFileId,
    openFileIds,
    allFiles,
    files,
    pendingCitation,
    clearPendingCitation,
    selectFile,
    closeFileTab,
    refreshFiles,
    getCachedContent,
    setCachedContent,
    clearCachedContent,
    workspaceHydrated,
    hasLoadedFilesOnce,
    restoredActiveFileId,
  } = useApp();
  const activeFileId = workspaceActiveFileId;
  const activeFileIdRef = useRef(activeFileId);
  activeFileIdRef.current = activeFileId;
  const loadedFileIdRef = useRef(null);
  const savePromiseRef = useRef(null);
  const contentRef = useRef('');
  const persistedContentRef = useRef('');
  const documentTitleRef = useRef('');
  const persistedTitleRef = useRef('');
  const hiddenFrontmatterRef = useRef('');
  const pendingNavRef = useRef(null);
  const routeSyncFileIdRef = useRef(null);
  const missingFileGuardRef = useRef(null);
  const restorePositionRef = useRef(false);
  const savePositionTimerRef = useRef(null);

  const [editor, setEditor] = useState(null);      // Tiptap editor instance
  const [content, setContent] = useState('');       // markdown string
  const [documentTitle, setDocumentTitle] = useState('');
  const [saveState, setSaveState] = useState('saved');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showIndexToast, setShowIndexToast] = useState(false);
  const [workspacePanels, setWorkspacePanels] = useState(() => readFilesWorkspacePanels());
  const [workspaceLayout, setWorkspaceLayout] = useState(() => readFilesWorkspaceLayout());
  const [workspaceDefaults, setWorkspaceDefaults] = useState(null);
  const [agentFileChangeVersion, setAgentFileChangeVersion] = useState(0);
  const [agentFixedWidthViewport, setAgentFixedWidthViewport] = useState(false);
  const [editorAutoCollapsed, setEditorAutoCollapsed] = useState(false);
  const [agentPanelLock, setAgentPanelLock] = useState({ locked: false, message: '' });
  const workspacePanelsRef = useRef(workspacePanels);
  const hasOpenedFileRef = useRef(false);
  const hasRestoredStartupFileRef = useRef(false);
  const lastSelectedFileIdRef = useRef(null);
  const requestOpenFileRef = useRef(null);

  const loadFile = useCallback(async (fileId) => {
    // Check in-memory cache first for instant navigation
    const cached = getCachedContent(fileId);
    if (cached !== undefined) return { content: cached };

    const response = await fetch(`/api/files/${fileId}`);

    if (!response.ok) {
      let errMsg = '文件加载失败';
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const payload = await response.json();
        errMsg = payload.error || errMsg;
      }
      throw new Error(errMsg);
    }

    const payload = await response.json();
    setCachedContent(fileId, payload.content || '');
    return payload;
  }, [getCachedContent, setCachedContent]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings', { cache: 'no-store' })
      .then((response) => response.json())
      .then((settings) => {
        if (cancelled) return;
        setWorkspaceDefaults({
          editorOpen: settings?.editor?.default_editor_open !== false,
          agentOpen: settings?.editor?.default_agent_open !== false,
        });
      })
      .catch(() => {
        if (!cancelled) setWorkspaceDefaults({ editorOpen: true, agentOpen: true });
      });
    return () => { cancelled = true; };
  }, []);

  const updateWorkspacePanels = useCallback((patch) => {
    setWorkspacePanels((previous) => {
      const next = { ...previous, ...patch };
      writeFilesWorkspacePanels(next);
      return next;
    });
  }, []);

  useEffect(() => {
    workspacePanelsRef.current = workspacePanels;
  }, [workspacePanels]);

  useEffect(() => {
    const query = window.matchMedia(FILES_EDITOR_AUTO_COLLAPSE_QUERY);
    const updateViewport = () => {
      if (query.matches && workspacePanelsRef.current.editorOpen && workspacePanelsRef.current.agentOpen) setEditorAutoCollapsed(true);
    };
    updateViewport();
    query.addEventListener('change', updateViewport);
    return () => query.removeEventListener('change', updateViewport);
  }, []);

  useEffect(() => {
    const query = window.matchMedia(FILES_AGENT_FIXED_WIDTH_QUERY);
    const updateViewport = () => setAgentFixedWidthViewport(query.matches);
    updateViewport();
    query.addEventListener('change', updateViewport);
    return () => query.removeEventListener('change', updateViewport);
  }, []);

  useEffect(() => {
    if (hasRestoredStartupFileRef.current || !workspaceHydrated) return;

    const restoredFileId = Number(restoredActiveFileId);
    if (!Number.isFinite(restoredFileId) || restoredFileId <= 0) return;
    if (Number(workspaceActiveFileId) !== restoredFileId) return;

    // 应用启动时已有选中文档，面板状态应完全沿用上次关闭窗口时的记录。
    hasRestoredStartupFileRef.current = true;
    hasOpenedFileRef.current = true;
  }, [restoredActiveFileId, workspaceActiveFileId, workspaceHydrated]);

  useEffect(() => {
    if (!activeFile?.id) {
      const restoredFileId = Number(restoredActiveFileId);
      const isWaitingForRestoredFile = workspaceHydrated
        && Number.isFinite(restoredFileId)
        && restoredFileId > 0
        && Number(workspaceActiveFileId) === restoredFileId;
      if (isWaitingForRestoredFile) return;
      hasOpenedFileRef.current = false;
      return;
    }
    if (hasOpenedFileRef.current || !workspaceDefaults) return;
    hasOpenedFileRef.current = true;
    // 启动恢复沿用上次关窗时的组合；用户主动打开的首个文件始终需要可见编辑器。
    updateWorkspacePanels({
      ...workspaceDefaults,
      editorOpen: hasRestoredStartupFileRef.current ? workspaceDefaults.editorOpen : true,
    });
  }, [activeFile?.id, restoredActiveFileId, updateWorkspacePanels, workspaceActiveFileId, workspaceDefaults, workspaceHydrated]);

  const handleFilesLayoutChange = useCallback((nextPercent) => {
    const editorWidthPercent = clampFilesLayout(nextPercent);
    setWorkspaceLayout({ editorWidthPercent, agentWidthPercent: 100 - editorWidthPercent });
  }, []);

  const handleFilesLayoutCommit = useCallback((nextPercent) => {
    const editorWidthPercent = clampFilesLayout(nextPercent);
    const nextLayout = { editorWidthPercent, agentWidthPercent: 100 - editorWidthPercent };
    setWorkspaceLayout(nextLayout);
    writeFilesWorkspaceLayout(nextLayout);
  }, []);

  const handleAgentFilesChanged = useCallback(async () => {
    if (activeFileId) clearCachedContent(activeFileId);
    if (contentRef.current !== persistedContentRef.current || documentTitleRef.current !== persistedTitleRef.current || savePromiseRef.current) {
      toast('文件已更新，当前未保存的编辑已保留。', 'info');
      return;
    }
    setAgentFileChangeVersion((previous) => previous + 1);
  }, [activeFileId, clearCachedContent, toast]);

  const expandEditorForFile = useCallback(() => {
    setEditorAutoCollapsed(false);
    if (!workspacePanelsRef.current.editorOpen) updateWorkspacePanels({ editorOpen: true });
  }, [updateWorkspacePanels]);

  useEffect(() => {
    const nextFileId = Number(activeFile?.id || 0);
    if (!nextFileId) {
      lastSelectedFileIdRef.current = null;
      return;
    }
    const isRestoredStartupFile = hasRestoredStartupFileRef.current && lastSelectedFileIdRef.current === null;
    if (!isRestoredStartupFile && Number(lastSelectedFileIdRef.current) !== nextFileId) {
      expandEditorForFile();
    }
    lastSelectedFileIdRef.current = nextFileId;
  }, [activeFile?.id, expandEditorForFile]);

  const handleOpenDiffFile = useCallback(async (filePath) => {
    const normalizedPath = String(filePath || '').replace(/\\/g, '/').trim();
    let targetFile = allFiles.find((file) => String(file?.path || '').replace(/\\/g, '/') === normalizedPath);
    if (!targetFile) {
      try {
        targetFile = findFileInTree(await refreshFiles({ background: true }), normalizedPath);
      } catch {}
    }
    if (!targetFile) {
      toast('该文档已删除或不存在', 'info');
      return;
    }
    requestOpenFileRef.current?.(targetFile);
  }, [allFiles, refreshFiles, toast]);

  useEffect(() => {
    if (!activeFileId) {
      setContent('');
      contentRef.current = '';
      persistedContentRef.current = '';
      setDocumentTitle('');
      documentTitleRef.current = '';
      persistedTitleRef.current = '';
      hiddenFrontmatterRef.current = '';
      return undefined;
    }

    // 外部删除文件时，先由未保存确认流程决定是否关闭，避免覆盖内存中的编辑内容。
    if (!activeFile) return undefined;

    if (loadedFileIdRef.current === activeFileId && (contentRef.current !== persistedContentRef.current || documentTitleRef.current !== persistedTitleRef.current || savePromiseRef.current)) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaveState('saved');

    loadFile(activeFileId)
      .then((file) => {
        if (cancelled) return;
        loadedFileIdRef.current = activeFileId;
        const { visibleContent, hiddenFrontmatter, hiddenFrontmatterData } = splitEditorVisibleMarkdown(file.content || '');
        const editorDocument = splitEditorTitleAndBody(
          visibleContent || '',
          hiddenFrontmatterData?.title || file.title || file.name?.replace(/\.md$/i, '')
        );
        setContent(visibleContent || '');
        contentRef.current = visibleContent || '';
        persistedContentRef.current = visibleContent || '';
        setDocumentTitle(editorDocument.title);
        documentTitleRef.current = editorDocument.title;
        persistedTitleRef.current = editorDocument.title;
        hiddenFrontmatterRef.current = hiddenFrontmatter || '';
        restorePositionRef.current = true;
        setLoading(false);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError.message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeFile, activeFileId, agentFileChangeVersion, loadFile]);

  // Parse #L24-L28 hash on mount and store as pending navigation
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const match = window.location.hash.match(/^#L(\d+)(?:-L?(\d+))?$/);
    if (!match) return;
    pendingNavRef.current = {
      lineStart: parseInt(match[1], 10),
      lineEnd: match[2] ? parseInt(match[2], 10) : parseInt(match[1], 10),
    };
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  const tocItems = useEditorToc({
    editor,
    contentVersion: `${activeFileId || 'none'}:${content}`,
  });

  useEffect(() => {
    if (!router.isReady || !editor || !activeFile?.id) return;

    const requestedFileId = Number(getQueryValue(router.query.fileId));
    const hasQueryNav = Number.isFinite(requestedFileId)
      && requestedFileId === activeFile.id
      && (
        getQueryValue(router.query.lineStart)
        || getQueryValue(router.query.lineEnd)
        || getQueryValue(router.query.preview)
        || getQueryValue(router.query.headingPath)
      );
    const hasPendingHashNav = Boolean(pendingNavRef.current);
    const hasPendingCitationNav = Number(pendingCitation?.fileId) === activeFile.id;

    if (!hasQueryNav && !hasPendingHashNav && !hasPendingCitationNav) return;

    let lineStart, lineEnd, preview, headingPath;

    if (hasPendingCitationNav) {
      lineStart = Number(pendingCitation?.lineStart);
      lineEnd = Number(pendingCitation?.lineEnd);
      preview = previewFromLines(content, lineStart, lineEnd) || pendingCitation?.preview || '';
      headingPath = pendingCitation?.headingPath || '';
    } else if (hasQueryNav) {
      lineStart = Number(getQueryValue(router.query.lineStart));
      lineEnd = Number(getQueryValue(router.query.lineEnd));
      preview = getQueryValue(router.query.preview) || previewFromLines(content, lineStart, lineEnd);
      headingPath = getQueryValue(router.query.headingPath) || '';
    } else {
      // Hash nav: #L24-L28 — apply to current active file
      lineStart = pendingNavRef.current.lineStart;
      lineEnd = pendingNavRef.current.lineEnd;
      preview = previewFromLines(content, lineStart, lineEnd);
      headingPath = '';
    }

    if (hasPendingHashNav) pendingNavRef.current = null;

    return retryFocusCitationTarget(
      editor,
      { preview, headingPath, lineStart, lineEnd },
      { persistent: false, duration: 3000, markdown: content, maxAttempts: 20, retryDelay: 80 },
      {
        onResolved: () => {
          if (hasPendingCitationNav) {
            clearPendingCitation();
          }

          if (hasQueryNav) {
            const nextQuery = { ...router.query };
            delete nextQuery.fileId;
            delete nextQuery.lineStart;
            delete nextQuery.lineEnd;
            delete nextQuery.preview;
            delete nextQuery.headingPath;
            router.replace({ pathname: '/files', query: nextQuery }, undefined, { shallow: true });
          }
        },
      }
    );
  }, [activeFile?.id, clearPendingCitation, content, editor, pendingCitation, router]);

  useEffect(() => {
    if (!router.isReady || !editor || !activeFile?.id || loading || error) return undefined;
    const container = getEditorScrollContainer(editor);
    if (!container) return undefined;

    const requestedFileId = Number(getQueryValue(router.query.fileId));
    const hasQueryNav = Number.isFinite(requestedFileId)
      && requestedFileId === activeFile.id
      && (
        getQueryValue(router.query.lineStart)
        || getQueryValue(router.query.lineEnd)
        || getQueryValue(router.query.preview)
        || getQueryValue(router.query.headingPath)
      );
    const hasPendingHashNav = Boolean(pendingNavRef.current);
    const hasPendingCitationNav = Number(pendingCitation?.fileId) === activeFile.id;
    const skipRestore = hasQueryNav || hasPendingHashNav || hasPendingCitationNav;

    if (restorePositionRef.current && !skipRestore && readViewPosition('files', activeFile.id)) {
      return retryRestoreViewPosition(
        () => restoreEditorViewPosition('files', activeFile.id, container),
        {
          onComplete: () => {
            restorePositionRef.current = false;
          },
        }
      );
    }

    restorePositionRef.current = false;
    return undefined;
  }, [activeFile?.id, content, editor, error, loading, pendingCitation, router.isReady, router.query.fileId, router.query.headingPath, router.query.lineEnd, router.query.lineStart, router.query.preview]);

  useEffect(() => {
    if (!editor || !activeFile?.id || loading || error) return undefined;
    const container = getEditorScrollContainer(editor);
    if (!container) return undefined;

    const savePosition = () => {
      if (!activeFile?.id || restorePositionRef.current) return;
      writeEditorViewPosition('files', activeFile.id, container);
    };

    const handleScroll = () => {
      if (savePositionTimerRef.current) {
        window.clearTimeout(savePositionTimerRef.current);
      }
      savePositionTimerRef.current = window.setTimeout(savePosition, 240);
    };

    const flushPosition = () => {
      if (savePositionTimerRef.current) {
        window.clearTimeout(savePositionTimerRef.current);
        savePositionTimerRef.current = null;
      }
      savePosition();
    };

    const handlePageHide = () => {
      flushPosition();
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    router.events.on('routeChangeStart', flushPosition);
    window.addEventListener('beforeunload', flushPosition);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      container.removeEventListener('scroll', handleScroll);
      router.events.off('routeChangeStart', flushPosition);
      window.removeEventListener('beforeunload', flushPosition);
      window.removeEventListener('pagehide', handlePageHide);
      if (savePositionTimerRef.current) {
        window.clearTimeout(savePositionTimerRef.current);
        savePositionTimerRef.current = null;
      }
      savePosition();
    };
  }, [activeFile?.id, editor, error, loading, router.events]);

  const handleSave = useCallback(async (nextContent = contentRef.current) => {
    if (!activeFileId) return false;
    while (savePromiseRef.current) await savePromiseRef.current;
    if (activeFileIdRef.current !== activeFileId) return false;
    const nextTitle = splitEditorTitleAndBody(nextContent, documentTitleRef.current).title;
    documentTitleRef.current = nextTitle;
    if (nextContent === persistedContentRef.current && nextTitle === persistedTitleRef.current) {
      setSaveState('saved');
      return true;
    }
    setSaveState('saving');
    const task = (async () => {
      try {
        const contentToSave = mergeEditorVisibleMarkdown(nextContent, hiddenFrontmatterRef.current);
        const response = await fetch(`/api/files/${activeFileId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: contentToSave, title: nextTitle }),
        });
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || '保存失败');
        }

        const { visibleContent, hiddenFrontmatter, hiddenFrontmatterData } = splitEditorVisibleMarkdown(payload.content || contentToSave);
        const savedDocument = splitEditorTitleAndBody(visibleContent || '', hiddenFrontmatterData?.title || nextTitle);
        setCachedContent(activeFileId, payload.content || contentToSave);
        if (activeFileIdRef.current !== activeFileId) return true;
        const unchanged = contentRef.current === nextContent && documentTitleRef.current === nextTitle;
        persistedContentRef.current = visibleContent || '';
        if (unchanged) contentRef.current = visibleContent || '';
        persistedTitleRef.current = savedDocument.title;
        if (unchanged) documentTitleRef.current = savedDocument.title;
        hiddenFrontmatterRef.current = hiddenFrontmatter || hiddenFrontmatterRef.current || '';
        if (unchanged) {
          setContent(visibleContent || '');
          setDocumentTitle(savedDocument.title);
        }
        setSaveState(unchanged ? 'saved' : 'dirty');
        await refreshFiles({ background: true });
        if (payload.title_binding_warning) {
          toast(payload.title_binding_warning, 'warning');
        }
        if (activeFileIdRef.current !== activeFileId) return true;
        setShowIndexToast(Boolean(payload.indexed));
        if (!payload.indexed) toast('正文已保存，但知识库索引未完成。可在索引状态中查看并重试。', 'warning');
        setTimeout(() => setShowIndexToast(false), 4000);
        return contentRef.current === persistedContentRef.current && documentTitleRef.current === persistedTitleRef.current;
      } catch (saveError) {
        if (activeFileIdRef.current === activeFileId) setSaveState('dirty');
        toast(saveError.message || '保存失败', 'error');
        return false;
      }
    })();
    savePromiseRef.current = task;
    try { return await task; } finally {
      if (savePromiseRef.current === task) savePromiseRef.current = null;
    }
  }, [activeFileId, refreshFiles, setCachedContent, toast]);

  const handleChange = useCallback((newContent) => {
    if (newContent === contentRef.current) return;

    contentRef.current = newContent;
    setContent(newContent);

    const nextTitle = splitEditorTitleAndBody(newContent, documentTitleRef.current).title;
    documentTitleRef.current = nextTitle;
    setDocumentTitle(nextTitle);

    if (newContent === persistedContentRef.current && documentTitleRef.current === persistedTitleRef.current) {
      setSaveState('saved');
      return;
    }

    setSaveState('dirty');
  }, []);

  const unsavedGuard = useUnsavedChangesGuard({
    isDirty: saveState !== 'saved',
    onSave: handleSave,
    title: '离开前保存当前文档？',
    message: '当前文档还有未保存修改。你可以先保存再切换页面或文件，也可以直接离开并丢弃这次编辑。',
  });
  const navigationGuard = activeFile && saveState !== 'saved' ? unsavedGuard.request : undefined;

  const syncWorkspaceRoute = useCallback((file, replace = false) => {
    const href = file ? `/files?fileId=${encodeURIComponent(file.id)}` : '/files';
    if (router.asPath === href && !routeSyncFileIdRef.current) return;
    // 状态先更新、地址后提交；期间不能按旧地址重新打开刚关闭的标签。
    const navigation = {};
    routeSyncFileIdRef.current = navigation;
    const release = () => {
      if (routeSyncFileIdRef.current === navigation) routeSyncFileIdRef.current = null;
    };
    (replace ? router.replace(href, undefined, { shallow: true }) : router.push(href))
      .then(release, release);
  }, [router]);

  const openWorkspaceFile = useCallback((targetFile) => {
    if (!targetFile?.id) return;
    expandEditorForFile();
    if (Number(activeFileId) !== Number(targetFile.id)) selectFile(targetFile);
    syncWorkspaceRoute(targetFile);
  }, [activeFileId, expandEditorForFile, selectFile, syncWorkspaceRoute]);

  const requestOpenWorkspaceFile = useCallback((targetFile) => {
    if (!targetFile?.id) return false;
    const action = () => openWorkspaceFile(targetFile);
    if (Number(activeFileId) === Number(targetFile.id)) {
      action();
      return true;
    }
    if (navigationGuard) {
      return navigationGuard(action);
    }
    action();
    return true;
  }, [activeFileId, navigationGuard, openWorkspaceFile]);
  requestOpenFileRef.current = requestOpenWorkspaceFile;

  useEffect(() => {
    if (!router.isReady || routeSyncFileIdRef.current) return;
    const requestedFileId = Number(getQueryValue(router.query.fileId));
    if (!Number.isFinite(requestedFileId) || requestedFileId <= 0) return;
    if (Number(activeFileId) === requestedFileId) {
      return;
    }
    const targetFile = allFiles.find((file) => Number(file.id) === requestedFileId);
    if (!targetFile) return;
    const opened = requestOpenWorkspaceFile(targetFile);
    if (opened) return;
    const currentHref = activeFileId ? `/files?fileId=${encodeURIComponent(activeFileId)}` : '/files';
    if (router.asPath !== currentHref) {
      router.replace(currentHref, undefined, { shallow: true }).catch(() => {});
    }
  }, [activeFileId, allFiles, requestOpenWorkspaceFile, router, router.isReady, router.query.fileId]);

  useEffect(() => {
    router.beforePopState(({ as }) => {
      const requestedFileId = Number(getQueryValue(new URL(as, window.location.origin).searchParams.get('fileId')));
      if (!Number.isFinite(requestedFileId) || requestedFileId <= 0 || Number(activeFileIdRef.current) === requestedFileId) return true;
      const targetFile = allFiles.find((file) => Number(file.id) === requestedFileId);
      if (!targetFile || !navigationGuard) return true;
      navigationGuard(() => openWorkspaceFile(targetFile));
      return false;
    });
    return () => router.beforePopState(() => true);
  }, [allFiles, navigationGuard, openWorkspaceFile, router]);

  useEffect(() => {
    if (!workspaceHydrated || !hasLoadedFilesOnce || !activeFileId || activeFile) {
      missingFileGuardRef.current = null;
      return;
    }
    if (missingFileGuardRef.current === Number(activeFileId)) return;
    missingFileGuardRef.current = Number(activeFileId);
    const closeMissingFile = () => {
      const nextActiveFile = closeFileTab(activeFileId);
      syncWorkspaceRoute(nextActiveFile, true);
    };
    if (navigationGuard) {
      navigationGuard(closeMissingFile);
      return;
    }
    closeMissingFile();
  }, [activeFile, activeFileId, closeFileTab, hasLoadedFilesOnce, navigationGuard, syncWorkspaceRoute, workspaceHydrated]);

  const handleOpenEditorLink = useCallback(async (fileId) => {
    const targetFileId = Number(fileId);
    let targetFile = allFiles.find((file) => Number(file?.id) === targetFileId);
    if (!targetFile) {
      try {
        targetFile = findFileByIdInTree(await refreshFiles({ background: true }), targetFileId);
      } catch {}
    }
    if (!targetFile || Number(targetFile.id) !== targetFileId) {
      toast('该文件已删除或不存在', 'info');
      return;
    }
    requestOpenWorkspaceFile(targetFile);
  }, [allFiles, refreshFiles, requestOpenWorkspaceFile, toast]);

  const openFiles = useMemo(() => {
    const filesById = new Map(allFiles.map((file) => [Number(file.id), file]));
    return openFileIds.map((fileId) => filesById.get(Number(fileId))).filter(Boolean);
  }, [allFiles, openFileIds]);

  const handleCloseTab = useCallback((file) => {
    if (!file?.id) return;
    const close = () => {
      const nextActiveFile = closeFileTab(file.id);
      syncWorkspaceRoute(nextActiveFile);
    };
    if (Number(file.id) === Number(activeFileId) && navigationGuard) {
      navigationGuard(close);
      return;
    }
    close();
  }, [activeFileId, closeFileTab, navigationGuard, syncWorkspaceRoute]);

  const handleRenameTab = useCallback(async (file, name) => {
    if (!file?.id || !String(name || '').trim()) return false;
    if (Number(file.id) === Number(activeFileId) && saveState !== 'saved') {
      const saved = await handleSave();
      if (!saved) return false;
    }
    try {
      const response = await fetch('/api/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: file.id, name: String(name).trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '重命名失败');
      if (Number(file.id) === Number(activeFileId) && payload.content !== undefined) {
        const { visibleContent, hiddenFrontmatter, hiddenFrontmatterData } = splitEditorVisibleMarkdown(payload.content || '');
        const editorDocument = splitEditorTitleAndBody(
          visibleContent || '',
          hiddenFrontmatterData?.title || payload.title || payload.name?.replace(/\.md$/i, '')
        );
        setContent(visibleContent || '');
        contentRef.current = visibleContent || '';
        persistedContentRef.current = visibleContent || '';
        setDocumentTitle(editorDocument.title);
        documentTitleRef.current = editorDocument.title;
        persistedTitleRef.current = editorDocument.title;
        hiddenFrontmatterRef.current = hiddenFrontmatter || hiddenFrontmatterRef.current || '';
        setSaveState('saved');
      }
      setCachedContent(file.id, payload.content || getCachedContent(file.id) || '');
      await refreshFiles({ background: true });
      toast('文件已重命名', 'success');
      return true;
    } catch (renameError) {
      toast(renameError.message || '重命名失败', 'error');
      return false;
    }
  }, [activeFileId, getCachedContent, handleSave, refreshFiles, saveState, setCachedContent, toast]);

  const getDocumentFindRoot = useCallback(() => getEditorRoot(editor), [editor]);

  const documentFind = useDocumentFind({
    enabled: Boolean(activeFile && editor),
    getRoot: getDocumentFindRoot,
    selector: 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th',
    contentVersion: `${activeFileId || 'none'}:${content}`,
  });

  const editorPanel = (
    <div id="notus-editor-tabpanel" className="notus-editor-panel" role="tabpanel" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', background: 'var(--bg-primary)' }}>
      <DocumentTabs
        files={openFiles}
        activeFileId={activeFileId}
        onActivate={requestOpenWorkspaceFile}
        onClose={handleCloseTab}
        onRename={handleRenameTab}
      />
      {activeFile ? <EditorToolbar editor={editor} fileId={activeFile.id} isDirty={saveState === 'dirty'} /> : null}
      {!activeFile ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <EmptyState icon={<Icons.edit size={48} />} title="选择一篇文章开始编辑" subtitle="也可以不打开文件，直接在右侧与 AI 协作" />
        </div>
      ) : null}
      {activeFile && loading ? (
        <div className="notus-editor-panel__loading" style={{ flex: 1, padding: '48px 60px', maxWidth: 780, margin: '0 auto', width: '100%' }}><SkeletonText lines={8} /></div>
      ) : null}
      {activeFile && error ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <InlineError
            message={error || '文件加载失败'}
            onRetry={() => {
              setLoading(true);
              loadFile(activeFile.id)
                .then((file) => {
                  setError(null);
                  const { visibleContent, hiddenFrontmatter, hiddenFrontmatterData } = splitEditorVisibleMarkdown(file.content || '');
                  const editorDocument = splitEditorTitleAndBody(
                    visibleContent || '',
                    hiddenFrontmatterData?.title || file.title || file.name?.replace(/\.md$/i, '')
                  );
                  setContent(visibleContent || '');
                  contentRef.current = visibleContent || '';
                  persistedContentRef.current = visibleContent || '';
                  setDocumentTitle(editorDocument.title);
                  documentTitleRef.current = editorDocument.title;
                  persistedTitleRef.current = editorDocument.title;
                  hiddenFrontmatterRef.current = hiddenFrontmatter || '';
                  setLoading(false);
                })
                .catch((loadError) => {
                  setError(loadError.message);
                  setLoading(false);
                });
            }}
          />
        </div>
      ) : null}
      {activeFile && !loading && !error ? (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
          <DocumentFindBar
            open={documentFind.open}
            query={documentFind.query}
            total={documentFind.total}
            current={documentFind.currentIndex}
            onChange={documentFind.setQuery}
            onPrev={documentFind.prev}
            onNext={documentFind.next}
            onClose={documentFind.close}
          />
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <WysiwygEditor
              key={activeFile.id}
              value={content}
              onChange={handleChange}
              onSave={handleSave}
              onEditorReady={setEditor}
              onOpenFileLink={handleOpenEditorLink}
              fileId={activeFile.id}
            />
          </div>
          {showIndexToast ? (
            <div style={{ position: 'absolute', right: 20, bottom: 20, display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', boxShadow: 'var(--shadow-lg)', borderRadius: 'var(--radius-md)', padding: '10px 14px', fontSize: 'var(--text-sm)', color: 'var(--text-primary)', animation: 'slideUp var(--transition-normal)', zIndex: 50 }}>
              <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--success)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icons.check size={11} /></span>
              <span>已保存并索引到知识库</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const renderedEditorAutoCollapsed = editorAutoCollapsed && workspacePanels.editorOpen && workspacePanels.agentOpen;
  const renderedWorkspacePanels = {
    editorOpen: workspacePanels.editorOpen && !renderedEditorAutoCollapsed,
    agentOpen: workspacePanels.agentOpen,
  };

  const agentPanel = (
    <FileAgentWorkspace
      allFiles={allFiles}
      fileTree={files}
      activeFileId={activeFile?.id || null}
      refreshFiles={refreshFiles}
      onFilesChanged={handleAgentFilesChanged}
      onAgentPanelLockChange={setAgentPanelLock}
      beforeAgentRun={() => (activeFile && saveState !== 'saved' ? handleSave() : true)}
      fullWidth={!renderedWorkspacePanels.editorOpen}
      onOpenDiffFile={handleOpenDiffFile}
      onOpenFileLink={handleOpenEditorLink}
    />
  );

  const hasVisibleWorkspacePanel = renderedWorkspacePanels.editorOpen || renderedWorkspacePanels.agentOpen;
  const workspaceContent = hasVisibleWorkspacePanel ? (
    <ResizableLayout
      collapseLeft={!renderedWorkspacePanels.editorOpen}
      collapseRight={!renderedWorkspacePanels.agentOpen}
      left={editorPanel}
      right={agentPanel}
      leftPercent={workspaceLayout.editorWidthPercent}
      onLeftPercentChange={handleFilesLayoutChange}
      onLeftPercentCommit={handleFilesLayoutCommit}
      minLeftPercent={FILES_LAYOUT_MIN}
      maxLeftPercent={FILES_LAYOUT_MAX}
      minLeftPx={agentFixedWidthViewport ? 0 : FILES_EDITOR_MIN_WIDTH}
      minRightPx={FILES_AGENT_MIN_WIDTH}
      fixedRightPx={agentFixedWidthViewport ? FILES_AGENT_FIXED_WIDTH : 0}
    />
  ) : (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>使用顶部按钮展开富文本编辑器或 AI 聊天面板。</div>
  );

  const handleToggleAgentPanel = () => {
    if (workspacePanelsRef.current.agentOpen && agentPanelLock.locked) {
      toast(agentPanelLock.message || 'AI 正在处理当前任务，请完成后再收起面板。', 'info');
      return;
    }
    updateWorkspacePanels({ agentOpen: !workspacePanelsRef.current.agentOpen });
  };

  return (
    <Shell
      active="files"
      fileName={getFileNameLabel(activeFile, '未命名文档')}
      saveState={activeFile ? saveState : undefined}
      onSave={activeFile ? handleSave : undefined}
      saveDisabled={!activeFile || saveState !== 'dirty'}
      tocDisabled={!activeFile || !renderedWorkspacePanels.editorOpen}
      tocItems={tocItems}
      requestAction={navigationGuard}
      editorOpen={renderedWorkspacePanels.editorOpen}
      agentOpen={workspacePanels.agentOpen}
      onToggleEditor={() => {
        if (editorAutoCollapsed) {
          setEditorAutoCollapsed(false);
          updateWorkspacePanels({ editorOpen: true });
          return;
        }
        updateWorkspacePanels({ editorOpen: !workspacePanels.editorOpen });
      }}
      onToggleAgent={handleToggleAgentPanel}
    >
      {workspaceContent}
      <UnindexedFilesDialog />
      {unsavedGuard.dialog}
    </Shell>
  );
}
