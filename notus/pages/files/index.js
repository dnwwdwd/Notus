// /files — File management + WYSIWYG markdown editor (Tiptap)
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Shell } from '../../components/Layout/Shell';
import { EditorToolbar } from '../../components/Editor/EditorToolbar';
import { EmptyState } from '../../components/ui/EmptyState';
import { SkeletonText } from '../../components/ui/Skeleton';
import { InlineError } from '../../components/ui/InlineError';
import { Icons } from '../../components/ui/Icons';
import { useToast } from '../../components/ui/Toast';
import { useApp } from '../../contexts/AppContext';

// WysiwygEditor: SSR-incompatible (Tiptap uses DOM APIs)
// onEditorReady lifts the editor instance up so the toolbar can use it
const WysiwygEditor = dynamic(
  () => import('../../components/Editor/WysiwygEditor').then((m) => m.WysiwygEditor),
  { ssr: false, loading: () => <SkeletonText lines={7} /> }
);

// Extract headings for TOC (from markdown string)
function extractToc(markdown) {
  if (!markdown) return [];
  return markdown.split('\n')
    .filter((line) => /^#{1,3}\s/.test(line))
    .map((line) => {
      const m = line.match(/^(#{1,3})\s+(.+)/);
      return m ? { level: m[1].length - 1, text: m[2].trim() } : null;
    })
    .filter(Boolean);
}

export default function FilesPage() {
  const toast = useToast();
  const { activeFile } = useApp();
  const activeFileId = activeFile?.id;
  const saveTimer = useRef(null);

  const [editor, setEditor] = useState(null);      // Tiptap editor instance
  const [content, setContent] = useState('');       // markdown string
  const [saveState, setSaveState] = useState('saved');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showIndexToast, setShowIndexToast] = useState(false);

  const loadFile = useCallback(async (fileId) => {
    const response = await fetch(`/api/files/${fileId}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || '文件加载失败');
    }

    return payload;
  }, []);

  useEffect(() => {
    if (!activeFileId) {
      setContent('');
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaveState('saved');

    loadFile(activeFileId)
      .then((file) => {
        if (cancelled) return;
        setContent(file.content || '');
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

  const handleChange = useCallback((newContent) => {
    setContent(newContent);
    setSaveState('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      handleSave(newContent);
    }, 1200);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(async (nextContent = content) => {
    if (!activeFile) return;
    clearTimeout(saveTimer.current);
    setSaveState('saving');
    try {
      const response = await fetch(`/api/files/${activeFile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: nextContent }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || '保存失败');
      }

      setContent(payload.content || nextContent);
      setSaveState('saved');
      setShowIndexToast(true);
      setTimeout(() => setShowIndexToast(false), 4000);
    } catch (saveError) {
      setSaveState('dirty');
      toast(saveError.message || '保存失败', 'error');
    }
  }, [activeFile, content, toast]);

  const tocItems = useMemo(() => extractToc(content), [content]);

  return (
    <Shell
      active="files"
      fileName={activeFile?.name || null}
      saveState={activeFile ? saveState : undefined}
      tocDisabled={!activeFile}
      tocItems={tocItems}
    >
      <EditorToolbar
        editor={editor}
        fileId={activeFile?.id}
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
    </Shell>
  );
}
