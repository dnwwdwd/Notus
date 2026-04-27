// /files — File management + WYSIWYG markdown editor (Tiptap)
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { Shell } from '../../components/Layout/Shell';
import { EditorToolbar } from '../../components/Editor/EditorToolbar';
import { EmptyState } from '../../components/ui/EmptyState';
import { SkeletonText } from '../../components/ui/Skeleton';
import { InlineError } from '../../components/ui/InlineError';
import { DocumentFindBar } from '../../components/ui/DocumentFindBar';
import { Icons } from '../../components/ui/Icons';
import { useToast } from '../../components/ui/Toast';
import { useApp } from '../../contexts/AppContext';
import { useDocumentFind } from '../../hooks/useDocumentFind';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';

// WysiwygEditor: SSR-incompatible (Tiptap uses DOM APIs)
// onEditorReady lifts the editor instance up so the toolbar can use it
const WysiwygEditor = dynamic(
  () => import('../../components/Editor/WysiwygEditor').then((m) => m.WysiwygEditor),
  { ssr: false, loading: () => <SkeletonText lines={7} /> }
);

function getQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function previewFromLines(markdown, lineStart, lineEnd) {
  const start = Number(lineStart);
  const end = Number(lineEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) return '';
  const lines = String(markdown || '').split('\n');
  return normalizeText(lines.slice(start - 1, end).join(' '));
}

function getEditorRoot(editor) {
  try {
    return editor?.view?.dom || null;
  } catch {
    return null;
  }
}

function getEditorScrollContainer(editor) {
  return getEditorRoot(editor)?.closest('.wysiwyg-root') || null;
}

function findBestMatchElement(editor, options = {}) {
  const root = getEditorRoot(editor);
  if (!root) return null;

  const preview = normalizeText(options.preview);
  const headingPath = normalizeText(options.headingPath);

  if (headingPath) {
    const headingParts = headingPath.split('>').map((item) => normalizeText(item)).filter(Boolean);
    const lastHeading = headingParts[headingParts.length - 1];
    if (lastHeading) {
      const headingNodes = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')];
      const headingMatch = headingNodes.find((node) => normalizeText(node.textContent).includes(lastHeading));
      if (headingMatch) return headingMatch;
    }
  }

  if (!preview) return null;
  const candidates = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,li,pre')];
  let bestNode = null;
  let bestScore = -1;

  candidates.forEach((node) => {
    const text = normalizeText(node.textContent);
    if (!text) return;
    let score = 0;
    if (text.includes(preview)) score = preview.length;
    else if (preview.includes(text)) score = text.length;
    else {
      const previewWords = preview.split(' ').filter(Boolean);
      score = previewWords.reduce((count, word) => (text.includes(word) ? count + word.length : count), 0);
    }
    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  });

  return bestScore > 0 ? bestNode : null;
}

export default function FilesPage() {
  const router = useRouter();
  const toast = useToast();
  const { activeFile, allFiles, selectFile, getCachedContent, setCachedContent } = useApp();
  const activeFileId = activeFile?.id;
  const contentRef = useRef('');
  const persistedContentRef = useRef('');
  const pendingNavRef = useRef(null);

  const [editor, setEditor] = useState(null);      // Tiptap editor instance
  const [content, setContent] = useState('');       // markdown string
  const [saveState, setSaveState] = useState('saved');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showIndexToast, setShowIndexToast] = useState(false);
  const [tocHeadings, setTocHeadings] = useState([]);
  const [activeHeadingIndex, setActiveHeadingIndex] = useState(-1);

  const loadFile = useCallback(async (fileId) => {
    // Check in-memory cache first for instant navigation
    const cached = getCachedContent(fileId);
    if (cached !== undefined) return { content: cached };

    const response = await fetch(`/api/files/${fileId}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || '文件加载失败');
    }

    setCachedContent(fileId, payload.content || '');
    return payload;
  }, [getCachedContent, setCachedContent]);

  useEffect(() => {
    if (!router.isReady) return;
    const requestedFileId = Number(getQueryValue(router.query.fileId));
    if (!Number.isFinite(requestedFileId) || activeFile?.id === requestedFileId) return;
    const targetFile = allFiles.find((file) => file.id === requestedFileId);
    if (!targetFile) return;
    selectFile(targetFile);
  }, [activeFile?.id, allFiles, router, router.isReady, router.query.fileId, selectFile]);

  useEffect(() => {
    if (!activeFileId) {
      setContent('');
      contentRef.current = '';
      persistedContentRef.current = '';
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaveState('saved');

    loadFile(activeFileId)
      .then((file) => {
        if (cancelled) return;
        const nextContent = file.content || '';
        setContent(nextContent);
        contentRef.current = nextContent;
        persistedContentRef.current = nextContent;
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
  }, [activeFileId, loadFile]);

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

  const jumpToHeading = useCallback((index) => {
    if (!editor) return;
    const container = getEditorScrollContainer(editor);
    const root = getEditorRoot(editor);
    const headings = root ? [...root.querySelectorAll('h1,h2,h3')] : [];
    const target = headings[index];
    if (!container || !target) return;
    container.scrollTo({ top: Math.max(target.offsetTop - 48, 0), behavior: 'smooth' });
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      setTocHeadings([]);
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      const root = getEditorRoot(editor);
      const headings = root
        ? [...root.querySelectorAll('h1,h2,h3')]
          .map((heading) => ({
            level: Number(heading.tagName.slice(1)) - 1,
            text: normalizeText(heading.textContent),
          }))
          .filter((item) => item.text)
        : [];
      setTocHeadings(headings);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [content, editor]);

  useEffect(() => {
    if (!editor) return undefined;
    const container = getEditorScrollContainer(editor);
    const root = getEditorRoot(editor);
    if (!container || !root) return undefined;

    const syncActiveHeading = () => {
      const nextRoot = getEditorRoot(editor);
      const headings = nextRoot ? [...nextRoot.querySelectorAll('h1,h2,h3')] : [];
      if (headings.length === 0) {
        setActiveHeadingIndex(-1);
        return;
      }

      const threshold = container.scrollTop + 96;
      let nextIndex = 0;
      headings.forEach((heading, index) => {
        if (heading.offsetTop <= threshold) nextIndex = index;
      });
      setActiveHeadingIndex(nextIndex);
    };

    syncActiveHeading();
    container.addEventListener('scroll', syncActiveHeading, { passive: true });
    window.addEventListener('resize', syncActiveHeading);
    return () => {
      container.removeEventListener('scroll', syncActiveHeading);
      window.removeEventListener('resize', syncActiveHeading);
    };
  }, [editor, tocHeadings]);

  useEffect(() => {
    if (!router.isReady || !editor || !activeFile?.id) return;

    const requestedFileId = Number(getQueryValue(router.query.fileId));
    const hasQueryNav = Number.isFinite(requestedFileId) && requestedFileId === activeFile.id;
    const hasPendingHashNav = Boolean(pendingNavRef.current);

    if (!hasQueryNav && !hasPendingHashNav) return;

    let lineStart, lineEnd, preview, headingPath;

    if (hasQueryNav) {
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

    const container = getEditorScrollContainer(editor);
    const target = findBestMatchElement(editor, { preview, headingPath });
    if (container && target) {
      container.scrollTo({ top: Math.max(target.offsetTop - 56, 0), behavior: 'smooth' });
      target.classList.add('citation-highlight');
      try {
        const pos = editor.view.posAtDOM(target, 0);
        editor.commands.setTextSelection(pos);
      } catch { /* cursor positioning is best-effort */ }
      window.setTimeout(() => target.classList.remove('citation-highlight'), 3000);
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
  }, [activeFile?.id, content, editor, router]);

  const handleSave = useCallback(async (nextContent = contentRef.current) => {
    if (!activeFileId) return false;
    if (nextContent === persistedContentRef.current) {
      setSaveState('saved');
      return true;
    }
    setSaveState('saving');
    try {
      const response = await fetch(`/api/files/${activeFileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: nextContent }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || '保存失败');
      }

      const savedContent = payload.content || nextContent;
      persistedContentRef.current = savedContent;
      contentRef.current = savedContent;
      setContent(savedContent);
      setCachedContent(activeFileId, savedContent);
      setSaveState('saved');
      setShowIndexToast(true);
      setTimeout(() => setShowIndexToast(false), 4000);
      return true;
    } catch (saveError) {
      setSaveState('dirty');
      toast(saveError.message || '保存失败', 'error');
      return false;
    }
  }, [activeFileId, toast, setCachedContent]);

  const handleChange = useCallback((newContent) => {
    if (newContent === contentRef.current) return;

    contentRef.current = newContent;
    setContent(newContent);

    if (newContent === persistedContentRef.current) {
      setSaveState('saved');
      return;
    }

    setSaveState('dirty');
  }, []);

  const unsavedGuard = useUnsavedChangesGuard({
    isDirty: saveState === 'dirty',
    onSave: handleSave,
    title: '离开前保存当前文档？',
    message: '当前文档还有未保存修改。你可以先保存再切换页面或文件，也可以直接离开并丢弃这次编辑。',
  });

  const documentFind = useDocumentFind({
    enabled: Boolean(activeFile && editor),
    getRoot: () => getEditorRoot(editor),
    selector: 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th',
    contentVersion: `${activeFileId || 'none'}:${content}`,
  });

  const tocItems = useMemo(
    () => tocHeadings.map((item, index) => ({
      ...item,
      active: index === activeHeadingIndex,
      onJump: () => jumpToHeading(index),
    })),
    [activeHeadingIndex, jumpToHeading, tocHeadings]
  );

  return (
    <Shell
      active="files"
      fileName={activeFile?.name || null}
      saveState={activeFile ? saveState : undefined}
      onSave={activeFile ? handleSave : undefined}
      saveDisabled={!activeFile || saveState !== 'dirty'}
      tocDisabled={!activeFile}
      tocItems={tocItems}
      requestAction={unsavedGuard.request}
    >
      <EditorToolbar
        editor={editor}
        fileId={activeFile?.id}
        isDirty={saveState === 'dirty'}
        requestAction={unsavedGuard.request}
      />

      {/* Empty state */}
      {!activeFile && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)' }}>
          <EmptyState
            icon={<Icons.edit size={48} />}
            title="选择一篇文章开始编辑"
            subtitle="从左侧文件树中选择文件，或从顶部搜索框快速查找"
          />
        </div>
      )}

      {/* Loading skeleton */}
      {activeFile && loading && (
        <div style={{ flex: 1, padding: '48px 60px', maxWidth: 780, margin: '0 auto', width: '100%' }}>
          <SkeletonText lines={8} />
        </div>
      )}

      {/* Error state */}
      {activeFile && error && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <InlineError
            message={error || '文件加载失败'}
            onRetry={() => {
              setLoading(true);
              loadFile(activeFile.id)
                .then((file) => {
                  setError(null);
                  setContent(file.content || '');
                  setLoading(false);
                })
                .catch((loadError) => {
                  setError(loadError.message);
                  setLoading(false);
                });
            }}
          />
        </div>
      )}

      {/* Editor area */}
      {activeFile && !loading && !error && (
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
          <WysiwygEditor
            key={activeFile.id}
            value={content}
            onChange={handleChange}
            onSave={handleSave}
            onEditorReady={setEditor}
          />

          {/* Save + index toast */}
          {showIndexToast && (
            <div style={{
              position: 'absolute', right: 20, bottom: 20,
              display: 'flex', alignItems: 'center', gap: 10,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-primary)',
              boxShadow: 'var(--shadow-lg)',
              borderRadius: 'var(--radius-md)',
              padding: '10px 14px',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-primary)',
              animation: 'slideUp var(--transition-normal)',
              zIndex: 50,
            }}>
              <span style={{
                width: 18, height: 18, borderRadius: '50%',
                background: 'var(--success)', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icons.check size={11} />
              </span>
              <span>已保存并索引到知识库</span>
              <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)', marginLeft: 4 }}>刚刚</span>
            </div>
          )}
        </div>
      )}
      {unsavedGuard.dialog}
    </Shell>
  );
}
