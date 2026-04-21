// /knowledge — Knowledge base Q&A page
import { useState, useRef, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { Shell } from '../components/Layout/Shell';
import { EditorToolbar } from '../components/Editor/EditorToolbar';
import { UserBubble, AiBubble, RetrievalStatus } from '../components/ChatArea/ChatMessage';
import { InputBar } from '../components/ChatArea/InputBar';
import { ResizableLayout } from '../components/ui/ResizableLayout';
import { DropdownSelect } from '../components/ui/DropdownSelect';
import { EmptyState } from '../components/ui/EmptyState';
import { InlineError } from '../components/ui/InlineError';
import { Icons } from '../components/ui/Icons';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { SkeletonText } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { useApp } from '../contexts/AppContext';

const WysiwygEditor = dynamic(
  () => import('../components/Editor/WysiwygEditor').then((module) => module.WysiwygEditor),
  { ssr: false, loading: () => <SkeletonText lines={6} /> }
);

const SUGGESTIONS = [
  '我最近写了什么？',
  '关于缓存的三种策略有哪些差别？',
  '整理一下我对"慢"的思考',
  '读书笔记里提到过哪些决策模型？',
];

export default function KnowledgePage() {
  const router = useRouter();
  const toast = useToast();
  const { activeFile, allFiles, selectFile, getCachedContent, setCachedContent } = useApp();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState(null);
  const [retrievalStage, setRetrievalStage] = useState(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState(null);
  const [docContent, setDocContent] = useState('');
  const [docSaveState, setDocSaveState] = useState('saved');
  const [editor, setEditor] = useState(null);
  const [editorOpen, setEditorOpen] = useState(true);
  const [referenceMode, setReferenceMode] = useState('auto');
  const [manualReferenceFileIds, setManualReferenceFileIds] = useState([]);
  const saveTimer = useRef(null);
  const chatEndRef = useRef(null);

  const referenceFileOptions = allFiles.map((file) => ({
    value: file.id,
    label: file.name,
    searchText: file.path,
  }));
  const selectedReferenceFiles = manualReferenceFileIds
    .map((fileId) => allFiles.find((file) => file.id === fileId))
    .filter(Boolean);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  const loadFile = useCallback(async (fileId) => {
    const cached = getCachedContent(fileId);
    if (cached !== undefined) return { content: cached };

    const response = await fetch(`/api/files/${fileId}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '文章加载失败');
    setCachedContent(fileId, payload.content || '');
    return payload;
  }, [getCachedContent, setCachedContent]);

  useEffect(() => {
    if (!activeFile?.id) {
      setDocContent('');
      setDocError(null);
      return undefined;
    }

    let cancelled = false;
    setDocLoading(true);
    setDocError(null);
    setDocSaveState('saved');

    loadFile(activeFile.id)
      .then((file) => {
        if (cancelled) return;
        setDocContent(file.content || '');
        setDocLoading(false);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setDocError(loadError.message);
        setDocLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeFile?.id, loadFile]);

  useEffect(() => {
    if (!activeFile?.id) {
      setEditor(null);
      return;
    }
    setEditorOpen(true);
  }, [activeFile?.id]);

  const handleDocSave = useCallback(async (nextContent = docContent) => {
    if (!activeFile?.id) return;
    clearTimeout(saveTimer.current);
    setDocSaveState('saving');

    try {
      const response = await fetch(`/api/files/${activeFile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: nextContent }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存失败');

      const savedContent = payload.content || nextContent;
      setDocContent(savedContent);
      setCachedContent(activeFile.id, savedContent);
      setDocSaveState('saved');
    } catch (saveError) {
      setDocSaveState('dirty');
      toast(saveError.message || '保存失败', 'error');
    }
  }, [activeFile?.id, docContent, toast, setCachedContent]);

  const handleDocChange = useCallback((nextContent) => {
    setDocContent(nextContent);
    setDocSaveState('dirty');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      handleDocSave(nextContent);
    }, 1200);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const readSse = async (response, onEvent) => {
    if (!response.body) throw new Error('接口没有返回可读取的流');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      events.forEach((event) => {
        const line = event.split('\n').find((item) => item.startsWith('data:'));
        if (!line) return;
        onEvent(JSON.parse(line.slice(5)));
      });
    }
    if (buffer.trim()) {
      const line = buffer.split('\n').find((item) => item.startsWith('data:'));
      if (line) onEvent(JSON.parse(line.slice(5)));
    }
  };

  const handleSend = async (query, model) => {
    setError(null);
    setLoading(true);
    setRetrievalStage('searching');
    setMessages((prev) => [...prev, { id: Date.now(), role: 'user', content: query }]);
    setStreamText('');

    try {
      let answer = '';
      let citations = [];
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          model,
          reference_mode: referenceMode,
          reference_file_ids: referenceMode === 'manual' ? manualReferenceFileIds : undefined,
        }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || 'AI 请求失败');
      }

      await readSse(response, (event) => {
        if (event.type === 'chunks') {
          setRetrievalStage('found');
        } else if (event.type === 'token') {
          answer += event.text || '';
          setStreamText(answer);
          setRetrievalStage(null);
        } else if (event.type === 'citations') {
          citations = event.citations || [];
        } else if (event.type === 'done') {
          setMessages((prev) => [
            ...prev,
            { id: event.message_id || Date.now(), role: 'assistant', content: answer, citations },
          ]);
          setStreamText('');
          setLoading(false);
        } else if (event.type === 'error') {
          throw new Error(event.error || 'AI 请求失败');
        }
      });
    } catch (err) {
      setError(err.message || 'AI 请求失败，请检查网络或 API Key 设置');
      setLoading(false);
      setRetrievalStage(null);
    }
  };

  const isEmpty = messages.length === 0 && !loading;

  const handleCitationClick = useCallback((citation) => {
    const fileId = Number(citation?.file_id);
    if (!Number.isFinite(fileId)) return;

    const targetFile = allFiles.find((file) => file.id === fileId);
    if (targetFile) selectFile(targetFile);

    router.push({
      pathname: '/files',
      query: {
        fileId,
        lineStart: citation?.line_start || '',
        lineEnd: citation?.line_end || '',
        preview: citation?.preview || '',
        headingPath: citation?.heading_path || '',
      },
    });
  }, [allFiles, router, selectFile]);

  return (
    <Shell
      active="knowledge"
      fileName={activeFile?.name || null}
      saveState={activeFile ? docSaveState : undefined}
      tocDisabled
      navigateOnFileSelect={false}
    >
      {/* Chat panel content — extracted so it can be used with or without ResizableLayout */}
      {(() => {
        const editorPanel = activeFile && editorOpen ? (
          <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%', borderRight: '1px solid var(--border-subtle)' }}>
            <div style={{ height: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Icons.file size={14} />
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeFile?.name || '文章预览'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                style={{ width: 28, height: 28, borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}
              >
                <Icons.x size={14} />
              </button>
            </div>
            <EditorToolbar editor={editor} fileId={activeFile?.id} showAICreate={false} />

            {docLoading && (
              <div style={{ flex: 1, padding: '32px 28px' }}>
                <SkeletonText lines={8} />
              </div>
            )}
            {docError && !docLoading && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <InlineError
                  message={docError}
                  onRetry={() => {
                    setDocLoading(true);
                    loadFile(activeFile.id)
                      .then((file) => { setDocError(null); setDocContent(file.content || ''); setDocLoading(false); })
                      .catch((loadError) => { setDocError(loadError.message); setDocLoading(false); });
                  }}
                />
              </div>
            )}
            {!docLoading && !docError && (
              <WysiwygEditor
                key={`knowledge-${activeFile.id}`}
                value={docContent}
                onChange={handleDocChange}
                onSave={handleDocSave}
                onEditorReady={setEditor}
              />
            )}
          </div>
        ) : null;

        const chatPanel = (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                {activeFile ? `当前文章：${activeFile.name}` : '当前未选择文章，提问将默认在整个知识库中检索'}
              </div>
              {!editorOpen && activeFile && (
                <Button variant="secondary" size="sm" onClick={() => setEditorOpen(true)}>
                  显示文章
                </Button>
              )}
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>参考来源</div>
                {[
                  { value: 'auto', label: '自动匹配' },
                  { value: 'manual', label: '手动指定' },
                ].map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setReferenceMode(mode.value)}
                    style={{
                      height: 28,
                      padding: '0 12px',
                      background: referenceMode === mode.value ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                      border: `1px solid ${referenceMode === mode.value ? 'var(--accent)' : 'var(--border-primary)'}`,
                      borderRadius: 'var(--radius-md)',
                      fontSize: 11,
                      color: referenceMode === mode.value ? 'var(--accent)' : 'var(--text-secondary)',
                      cursor: 'pointer',
                    }}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>

              {referenceMode === 'manual' && (
                <>
                  <div style={{ maxWidth: 320 }}>
                    <DropdownSelect
                      value=""
                      options={referenceFileOptions.filter((option) => !manualReferenceFileIds.includes(option.value))}
                      onChange={(nextValue) => {
                        if (!nextValue) return;
                        setManualReferenceFileIds((prev) => prev.includes(nextValue) ? prev : [...prev, nextValue]);
                      }}
                      searchable
                      placement="top"
                      placeholder="添加参考文章"
                      searchPlaceholder="搜索文章标题或路径"
                      emptyText="没有更多可选文章"
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {selectedReferenceFiles.length > 0 ? selectedReferenceFiles.map((file) => (
                      <button
                        key={file.id}
                        type="button"
                        onClick={() => setManualReferenceFileIds((prev) => prev.filter((fileId) => fileId !== file.id))}
                        style={{ display: 'inline-flex', alignItems: 'center' }}
                      >
                        <Badge tone="accent">{file.name} ×</Badge>
                      </button>
                    )) : (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                        手动模式下可以固定参考某几篇文章，不再完全依赖自动检索。
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px' }}>
            <div style={{ maxWidth: 680, margin: '0 auto' }}>
              {isEmpty ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '55vh' }}>
                  <EmptyState
                    icon={<Icons.sparkles size={48} />}
                    title="向你的知识库提问"
                    subtitle="你可以一边编辑左侧文章，一边基于笔记内容发问。"
                  />
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 16 }}>
                    {SUGGESTIONS.map((s, i) => (
                      <button
                        key={i}
                        onClick={() => handleSend(s)}
                        style={{
                          height: 32, padding: '0 16px',
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border-primary)',
                          borderRadius: 'var(--radius-full)',
                          fontSize: 'var(--text-xs)',
                          color: 'var(--text-secondary)',
                          cursor: 'pointer',
                          transition: 'all var(--transition-fast)',
                        }}
                        onMouseEnter={(event) => {
                          event.currentTarget.style.borderColor = 'var(--accent)';
                          event.currentTarget.style.color = 'var(--accent)';
                        }}
                        onMouseLeave={(event) => {
                          event.currentTarget.style.borderColor = 'var(--border-primary)';
                          event.currentTarget.style.color = 'var(--text-secondary)';
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {messages.map((msg) =>
                    msg.role === 'user'
                      ? <UserBubble key={msg.id}>{msg.content}</UserBubble>
                      : <AiBubble key={msg.id} text={msg.content} citations={msg.citations} onCitationClick={handleCitationClick} />
                  )}

                  {loading && (
                    <div style={{ margin: '16px 0' }}>
                      {retrievalStage && <RetrievalStatus stage={retrievalStage} />}
                      {streamText && <AiBubble text={streamText} streaming />}
                    </div>
                  )}

                  {error && (
                    <div style={{ margin: '16px 0' }}>
                      <InlineError message={error} onRetry={() => setError(null)} />
                    </div>
                  )}

                  <div ref={chatEndRef} />
                </>
              )}
            </div>
          </div>

          <InputBar
            placeholder="从你的知识库中查找答案…"
            onSend={handleSend}
            loading={loading}
          />
        </div>
        );

        if (editorPanel) {
          return (
            <ResizableLayout
              initialLeftPercent={44}
              minLeftPercent={20}
              maxLeftPercent={75}
              left={editorPanel}
              right={chatPanel}
            />
          );
        }
        return <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>{chatPanel}</div>;
      })()}
    </Shell>
  );
}
