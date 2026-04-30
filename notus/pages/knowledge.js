// /knowledge — Knowledge base Q&A page
import { useState, useRef, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { Shell } from '../components/Layout/Shell';
import { EditorToolbar } from '../components/Editor/EditorToolbar';
import { UserBubble, AiBubble, RetrievalStatus } from '../components/ChatArea/ChatMessage';
import { ConversationDrawer } from '../components/ChatArea/ConversationDrawer';
import { InputBar } from '../components/ChatArea/InputBar';
import { ResizableLayout } from '../components/ui/ResizableLayout';
import { DropdownSelect } from '../components/ui/DropdownSelect';
import { DocumentFindBar } from '../components/ui/DocumentFindBar';
import { AiLockedState } from '../components/ui/AiLockedState';
import { EmptyState } from '../components/ui/EmptyState';
import { IconButton } from '../components/ui/IconButton';
import { InlineError } from '../components/ui/InlineError';
import { Icons } from '../components/ui/Icons';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { SkeletonText } from '../components/ui/Skeleton';
import { Tooltip } from '../components/ui/Tooltip';
import { useToast } from '../components/ui/Toast';
import { useApp } from '../contexts/AppContext';
import { useAppStatus } from '../contexts/AppStatusContext';
import { useLlmConfigs } from '../hooks/useLlmConfigs';
import { useStableAiReadiness } from '../hooks/useStableAiReadiness';
import { useDocumentFind } from '../hooks/useDocumentFind';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import { deriveAiReadiness } from '../utils/aiReadiness';
import {
  attachCitationHighlight,
  clearCitationHighlights,
  getEditorRoot,
  observePersistentCitationHighlight,
  getQueryValue,
  previewFromLines,
  retryFocusCitationTarget,
} from '../utils/documentNavigation';
import { mapConversationMessages } from '../utils/conversations';
import { readApiResponse } from '../utils/http';
import { navigateWithFallback } from '../utils/navigation';

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

function buildConversationListUrl() {
  const params = new URLSearchParams({ kind: 'knowledge', limit: '20' });
  return `/api/conversations?${params.toString()}`;
}

export default function KnowledgePage() {
  const router = useRouter();
  const toast = useToast();
  const {
    activeFile,
    allFiles,
    pendingCitation,
    clearPendingCitation,
    selectFile,
    getCachedContent,
    setCachedContent,
  } = useApp();
  const { status: appStatus, loading: appStatusLoading } = useAppStatus();
  const { configs: llmConfigs, activeConfigId, loading: llmConfigsLoading } = useLlmConfigs();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [error, setError] = useState(null);
  const [retrievalStage, setRetrievalStage] = useState(null);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [conversationList, setConversationList] = useState([]);
  const [conversationListLoading, setConversationListLoading] = useState(false);
  const [, setConversationDraft] = useState(true);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState(null);
  const [docContent, setDocContent] = useState('');
  const [docSaveState, setDocSaveState] = useState('saved');
  const [editor, setEditor] = useState(null);
  const [editorReadyFileId, setEditorReadyFileId] = useState(null);
  const [editorOpen, setEditorOpen] = useState(true);
  const [activeCitationTarget, setActiveCitationTarget] = useState(null);
  const [activeCitationSelection, setActiveCitationSelection] = useState(null);
  const [referenceMode, setReferenceMode] = useState('auto');
  const [manualReferenceFileIds, setManualReferenceFileIds] = useState([]);
  const [selectedLlmConfigId, setSelectedLlmConfigId] = useState(null);
  const docContentRef = useRef('');
  const persistedDocContentRef = useRef('');
  const chatEndRef = useRef(null);
  const requestControllerRef = useRef(null);

  const referenceFileOptions = allFiles.map((file) => ({
    value: file.id,
    label: file.name,
    searchText: file.path,
  }));
  const selectedReferenceFiles = manualReferenceFileIds
    .map((fileId) => allFiles.find((file) => file.id === fileId))
    .filter(Boolean);

  useEffect(() => {
    if (llmConfigs.length === 0) {
      setSelectedLlmConfigId(null);
      return;
    }

    setSelectedLlmConfigId((prev) => {
      if (prev && llmConfigs.some((item) => String(item.id) === String(prev))) {
        return prev;
      }
      if (activeConfigId && llmConfigs.some((item) => String(item.id) === String(activeConfigId))) {
        return activeConfigId;
      }
      return llmConfigs[0]?.id || null;
    });
  }, [activeConfigId, llmConfigs]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  useEffect(() => () => {
    requestControllerRef.current?.abort();
  }, []);

  const clearActiveCitationState = useCallback(() => {
    clearCitationHighlights(editor);
    setActiveCitationTarget(null);
    setActiveCitationSelection(null);
  }, [editor]);

  const loadFile = useCallback(async (fileId) => {
    const cached = getCachedContent(fileId);
    if (cached !== undefined) return { content: cached };

    const response = await fetch(`/api/files/${fileId}`);
    const payload = await readApiResponse(response, '文章加载失败');
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
  }, [activeFile?.id, allFiles, router.isReady, router.query.fileId, selectFile]);

  useEffect(() => {
    if (!activeFile?.id) {
      setDocContent('');
      setDocError(null);
      docContentRef.current = '';
      persistedDocContentRef.current = '';
      setEditorReadyFileId(null);
      setActiveCitationTarget(null);
      setActiveCitationSelection(null);
      return undefined;
    }

    let cancelled = false;
    setDocLoading(true);
    setDocError(null);
    setDocSaveState('saved');

    loadFile(activeFile.id)
      .then((file) => {
        if (cancelled) return;
        const nextContent = file.content || '';
        setDocContent(nextContent);
        docContentRef.current = nextContent;
        persistedDocContentRef.current = nextContent;
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
      setEditorReadyFileId(null);
      return;
    }
    setEditorOpen(true);
    setEditorReadyFileId((prev) => (prev === activeFile.id ? prev : null));
    if (activeCitationTarget && Number(activeCitationTarget?.fileId) !== activeFile.id) {
      setActiveCitationTarget(null);
      if (Number(pendingCitation?.fileId) !== activeFile.id) {
        setActiveCitationSelection(null);
      }
    }
  }, [activeCitationTarget, activeFile?.id, pendingCitation]);

  const handleEditorReady = useCallback((nextEditor) => {
    setEditor(nextEditor);
    setEditorReadyFileId(nextEditor && activeFile?.id ? activeFile.id : null);
  }, [activeFile?.id]);

  useEffect(() => {
    if (!editor || !activeFile?.id) return;
    if (editorReadyFileId !== activeFile.id) return;
    if (docLoading || docError) return;
    if (Number(pendingCitation?.fileId) !== activeFile.id) return;

    const lineStart = Number(pendingCitation?.lineStart) || null;
    const lineEnd = Number(pendingCitation?.lineEnd) || null;
    const target = {
      fileId: activeFile.id,
      preview: previewFromLines(docContent, lineStart, lineEnd) || pendingCitation?.preview || '',
      headingPath: pendingCitation?.headingPath || '',
      lineStart,
      lineEnd,
    };
    setEditorOpen(true);
    return retryFocusCitationTarget(
      editor,
      target,
      { persistent: true, markdown: docContent, maxAttempts: 12, retryDelay: 60 },
      {
        onResolved: (matched) => {
          if (!matched) {
            setActiveCitationSelection(null);
            return;
          }
          setActiveCitationTarget(target);
          clearPendingCitation();
        },
      }
    );
  }, [activeFile?.id, clearPendingCitation, docContent, docError, docLoading, editor, editorReadyFileId, pendingCitation]);

  useEffect(() => {
    if (!editor || !activeFile?.id) return;
    if (editorReadyFileId !== activeFile.id) return;
    if (docLoading || docError) return;
    if (Number(activeCitationTarget?.fileId) !== activeFile.id) return;

    attachCitationHighlight(editor, activeCitationTarget, { persistent: true, markdown: docContent });
    return observePersistentCitationHighlight(editor, activeCitationTarget, { persistent: true, markdown: docContent });
  }, [activeCitationTarget, activeFile?.id, docContent, docError, docLoading, editor, editorReadyFileId]);

  const handleDocSave = useCallback(async (nextContent = docContentRef.current) => {
    if (!activeFile?.id) return false;
    if (nextContent === persistedDocContentRef.current) {
      setDocSaveState('saved');
      return true;
    }
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
      persistedDocContentRef.current = savedContent;
      docContentRef.current = savedContent;
      setDocContent(savedContent);
      setCachedContent(activeFile.id, savedContent);
      setDocSaveState('saved');
      return true;
    } catch (saveError) {
      setDocSaveState('dirty');
      toast(saveError.message || '保存失败', 'error');
      return false;
    }
  }, [activeFile?.id, toast, setCachedContent]);

  const handleDocChange = useCallback((nextContent) => {
    if (nextContent === docContentRef.current) return;

    docContentRef.current = nextContent;
    setDocContent(nextContent);

    if (nextContent === persistedDocContentRef.current) {
      setDocSaveState('saved');
      return;
    }

    setDocSaveState('dirty');
  }, []);

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

  const fetchConversationList = useCallback(async () => {
    const response = await fetch(buildConversationListUrl());
    const payload = await readApiResponse(response, '读取对话列表失败');
    return Array.isArray(payload) ? payload : [];
  }, []);

  const fetchConversationDetail = useCallback(async (conversationId) => {
    const response = await fetch(`/api/conversations/${conversationId}`);
    const payload = await readApiResponse(response, '读取对话详情失败');
    return payload;
  }, []);

  const refreshConversationListOnly = useCallback(async (preferredConversationId = null) => {
    try {
      const rows = await fetchConversationList();
      setConversationList(rows);
      if (preferredConversationId && rows.some((item) => Number(item.id) === Number(preferredConversationId))) {
        setActiveConversationId(Number(preferredConversationId));
      }
    } catch {}
  }, [fetchConversationList]);

  const handleNewConversation = useCallback(() => {
    requestControllerRef.current?.abort();
    clearActiveCitationState();
    setActiveConversationId(null);
    setConversationDraft(true);
    setMessages([]);
    setStreamText('');
    setError(null);
    setLoading(false);
    setRetrievalStage(null);
    setHistoryDrawerOpen(false);
  }, [clearActiveCitationState]);

  const handleConversationSelect = useCallback(async (conversationId) => {
    if (!conversationId || loading) return;
    setConversationListLoading(true);
    requestControllerRef.current?.abort();
    clearActiveCitationState();
    try {
      const payload = await fetchConversationDetail(conversationId);
      setMessages(mapConversationMessages(payload.messages, 'knowledge'));
      setActiveConversationId(Number(conversationId));
      setConversationDraft(false);
      setStreamText('');
      setError(null);
      setLoading(false);
      setRetrievalStage(null);
      setHistoryDrawerOpen(false);
    } catch (loadError) {
      toast(loadError.message || '读取对话详情失败', 'error');
    } finally {
      setConversationListLoading(false);
    }
  }, [clearActiveCitationState, fetchConversationDetail, loading, toast]);

  useEffect(() => {
    let cancelled = false;
    requestControllerRef.current?.abort();
    setLoading(false);
    setStreamText('');
    setError(null);
    setRetrievalStage(null);
    setConversationListLoading(true);

    (async () => {
      try {
        const rows = await fetchConversationList();
        if (cancelled) return;
        setConversationList(rows);
        if (rows.length === 0) {
          setActiveConversationId(null);
          setConversationDraft(true);
          setMessages([]);
          return;
        }

        const initialConversationId = Number(rows[0].id);
        const payload = await fetchConversationDetail(initialConversationId);
        if (cancelled) return;
        setActiveConversationId(initialConversationId);
        setConversationDraft(false);
        setMessages(mapConversationMessages(payload.messages, 'knowledge'));
      } catch (loadError) {
        if (cancelled) return;
        setConversationList([]);
        setActiveConversationId(null);
        setConversationDraft(true);
        setMessages([]);
        toast(loadError.message || '读取对话历史失败', 'error');
      } finally {
        if (!cancelled) {
          setConversationListLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchConversationDetail, fetchConversationList, toast]);

  const handleSend = async (query, llmConfigId = selectedLlmConfigId) => {
    if (!llmConfigId) {
      toast('请先在模型配置中新增并测试至少一个 LLM 配置', 'warning');
      return;
    }

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setError(null);
    setLoading(true);
    setRetrievalStage('searching');
    setMessages((prev) => [...prev, { id: Date.now(), role: 'user', content: query }]);
    setStreamText('');

    try {
      let answer = '';
      let citations = [];
      let resolvedConversationId = activeConversationId;
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          conversation_id: activeConversationId || undefined,
          query,
          llm_config_id: llmConfigId,
          active_file_id: activeFile?.id || null,
          reference_mode: referenceMode,
          reference_file_ids: referenceMode === 'manual' ? manualReferenceFileIds : undefined,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const statusMessages = {
          401: 'API Key 无效，请前往设置检查密钥配置',
          429: '请求过于频繁，请稍后再试',
          503: '服务暂时不可用，请稍后再试',
        };
        throw new Error(payload.error || statusMessages[response.status] || 'AI 请求失败');
      }

      await readSse(response, (event) => {
        if (event.conversation_id) {
          resolvedConversationId = Number(event.conversation_id);
        }
        if (event.type === 'chunks') {
          setRetrievalStage(event.sufficiency === false ? 'insufficient' : 'found');
        } else if (event.type === 'token') {
          answer += event.text || '';
          setStreamText(answer);
          setRetrievalStage(null);
        } else if (event.type === 'citations') {
          citations = event.citations || [];
        } else if (event.type === 'done') {
          setMessages((prev) => [
            ...prev,
            { id: event.message_id || Date.now(), role: 'assistant', content: answer, citations, noContext: citations.length === 0 },
          ]);
          if (resolvedConversationId) {
            setActiveConversationId(resolvedConversationId);
            setConversationDraft(false);
            refreshConversationListOnly(resolvedConversationId);
          }
          setStreamText('');
          setLoading(false);
        } else if (event.type === 'error') {
          const nextError = new Error(event.error || 'AI 请求失败');
          nextError.conversationId = event.conversation_id ? Number(event.conversation_id) : resolvedConversationId;
          throw nextError;
        }
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        setError(null);
        toast('已停止生成', 'info');
      } else {
        if (err.conversationId) {
          setActiveConversationId(Number(err.conversationId));
          setConversationDraft(false);
          refreshConversationListOnly(Number(err.conversationId));
        }
        setError(err.message || 'AI 请求失败，请检查网络或 API Key 设置');
      }
      setLoading(false);
      setRetrievalStage(null);
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  };

  const isEmpty = messages.length === 0 && !loading;
  const aiState = deriveAiReadiness({
    appStatus,
    appStatusLoading,
    llmConfigs,
    llmConfigsLoading,
    requireIndexedFiles: true,
  });
  const aiUiState = useStableAiReadiness(aiState);
  const aiReady = aiUiState.ready;
  const aiLockDescription = aiState.reason === 'llm'
    ? '先完成 LLM 和 Embedding 配置后，知识库问答才会开放。'
    : aiState.reason === 'embedding'
      ? '还需要先完成 Embedding 配置，知识库问答和语义检索才会开放。'
      : '还需要先完成至少一次有效索引，知识库问答和检索结果才会开放。';

  const unsavedGuard = useUnsavedChangesGuard({
    isDirty: docSaveState === 'dirty',
    onSave: handleDocSave,
    title: '离开前保存当前文档？',
    message: '当前文章还有未保存修改。你可以先保存再继续跳转，也可以直接离开并丢弃这次编辑。',
  });
  const navigationGuard = activeFile && docSaveState === 'dirty' ? unsavedGuard.request : undefined;

  const documentFind = useDocumentFind({
    enabled: Boolean(activeFile && editor && editorOpen),
    getRoot: () => getEditorRoot(editor),
    selector: 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th',
    contentVersion: `${activeFile?.id || 'none'}:${docContent}`,
  });

  const handleCitationClick = useCallback((citation, selection = null) => {
    const fileId = Number(citation?.file_id);
    if (!Number.isFinite(fileId)) return;

    const targetFile = allFiles.find((file) => file.id === fileId);
    if (!targetFile) {
      setActiveCitationSelection(null);
      return;
    }
    const nextCitationTarget = {
      fileId,
      preview: citation?.preview || citation?.quote || '',
      headingPath: citation?.heading_path || citation?.path || '',
      lineStart: Number(citation?.line_start) || null,
      lineEnd: Number(citation?.line_end) || null,
    };

    unsavedGuard.request(() => {
      setActiveCitationSelection(selection);
      setEditorOpen(true);
      selectFile(targetFile, { pendingCitation: nextCitationTarget });
    });
  }, [allFiles, selectFile, unsavedGuard]);

  return (
    <Shell
      active="knowledge"
      fileName={activeFile?.name || null}
      saveState={activeFile ? docSaveState : undefined}
      onSave={activeFile ? handleDocSave : undefined}
      saveDisabled={!activeFile || docSaveState !== 'dirty'}
      tocDisabled
      requestAction={navigationGuard}
      navigateOnFileSelect={false}
    >
      {/* Chat panel content — extracted so it can be used with or without ResizableLayout */}
      {(() => {
        const editorPanel = activeFile && editorOpen ? (
          <div
            style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%', borderRight: '1px solid var(--border-subtle)', position: 'relative' }}
          >
            <div style={{ height: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Icons.file size={14} />
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeFile?.name || '文章预览'}
                </span>
                {activeCitationTarget && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={clearActiveCitationState}
                  >
                    关闭高亮
                  </Button>
                )}
              </div>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                style={{ width: 28, height: 28, borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}
              >
                <Icons.x size={14} />
              </button>
            </div>
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
            {activeFile && (
              <EditorToolbar editor={editor} fileId={activeFile?.id} showAICreate={false} />
            )}

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
                onEditorReady={handleEditorReady}
              />
            )}
          </div>
        ) : null;

        const chatPanel = (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
                {activeFile ? `当前文章：${activeFile.name}（仅影响优先检索，不切换历史对话）` : '当前未选择文章，提问将默认在整个知识库中检索'}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {!editorOpen && activeFile && (
                  <Button variant="secondary" size="sm" onClick={() => setEditorOpen(true)}>
                    显示文章
                  </Button>
                )}
                <Tooltip content="查看历史对话">
                  <span style={{ display: 'inline-flex' }}>
                    <IconButton
                      label="查看历史对话"
                      active={historyDrawerOpen}
                      disabled={loading || conversationListLoading}
                      onClick={() => setHistoryDrawerOpen(true)}
                    >
                      {conversationListLoading ? <Icons.refresh size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Icons.list size={15} />}
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip content="新建对话">
                  <span style={{ display: 'inline-flex' }}>
                    <IconButton
                      label="新建对话"
                      disabled={loading}
                      onClick={handleNewConversation}
                    >
                      <Icons.plus size={15} />
                    </IconButton>
                  </span>
                </Tooltip>
              </div>
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
                      options={referenceFileOptions}
                      onChange={(nextValue) => {
                        if (!nextValue) return;
                        setManualReferenceFileIds((prev) => (
                          prev.includes(nextValue)
                            ? prev.filter((fileId) => fileId !== nextValue)
                            : [...prev, nextValue]
                        ));
                      }}
                      isOptionSelected={(option) => manualReferenceFileIds.includes(option.value)}
                      closeOnSelect={false}
                      renderValue={() => (manualReferenceFileIds.length > 0 ? `已选 ${manualReferenceFileIds.length} 篇参考文章` : '添加参考文章')}
                      renderOption={(option, active) => `${option.label}${active ? ' · 已选' : ''}`}
                      searchable
                      placement="top"
                      placeholder="添加参考文章"
                      searchPlaceholder="搜索文章标题或路径"
                      emptyText="没有可选文章"
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
                        onClick={() => handleSend(s, selectedLlmConfigId)}
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
                      : (
                        <div key={msg.id}>
                          <AiBubble
                            text={msg.content}
                            citations={msg.citations}
                            onCitationClick={handleCitationClick}
                            citationSelection={activeCitationSelection}
                            messageId={msg.id}
                          />
                          {msg.noContext && (
                            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: -4, marginBottom: 12, paddingLeft: 2 }}>
                              未在知识库中找到相关文档，以上回答来自模型自身知识
                            </div>
                          )}
                        </div>
                      )
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
            isEmpty={isEmpty}
            placeholder="从你的知识库中查找答案…"
            onSend={handleSend}
            onStop={() => requestControllerRef.current?.abort()}
            loading={loading}
            llmConfigs={llmConfigs}
            selectedConfigId={selectedLlmConfigId}
            onConfigChange={setSelectedLlmConfigId}
            disabled={!aiReady}
            showPlusMenu={false}
          />
          <ConversationDrawer
            open={historyDrawerOpen}
            onClose={() => setHistoryDrawerOpen(false)}
            conversations={conversationList}
            activeConversationId={activeConversationId}
            loading={conversationListLoading}
            emptyText="暂无历史对话"
            onSelect={handleConversationSelect}
          />
          {aiUiState.showLockedState && (
            <AiLockedState
              variant="modal"
              title="知识库功能尚未解锁"
              description={aiLockDescription}
              onAction={() => navigateWithFallback(router, '/settings/model')}
            />
          )}
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
      {unsavedGuard.dialog}
    </Shell>
  );
}
