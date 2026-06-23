// /knowledge — Knowledge base Q&A page
import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { Shell } from '../components/Layout/Shell';
import { EditorToolbar } from '../components/Editor/EditorToolbar';
import { ClarifyDrawer } from '../components/ChatArea/ClarifyDrawer';
import { UserBubble, AiBubble } from '../components/ChatArea/ChatMessage';
import { ConversationDrawer } from '../components/ChatArea/ConversationDrawer';
import { InputBar } from '../components/ChatArea/InputBar';
import { AgentWorkspace } from '../components/AgentWorkspace/AgentWorkspace';
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
import { useAgentLoopController } from '../hooks/useAgentLoopController';
import { useStableAiReadiness } from '../hooks/useStableAiReadiness';
import { useDocumentFind } from '../hooks/useDocumentFind';
import { useEditorToc } from '../hooks/useEditorToc';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import { deriveAiReadiness } from '../utils/aiReadiness';
import { getVisibleDocumentLabel } from '../lib/documentLabels';
import { mergeEditorVisibleMarkdown, splitEditorVisibleMarkdown } from '../lib/markdownMeta';
import {
  attachCitationHighlight,
  clearCitationHighlights,
  getEditorRoot,
  getEditorScrollContainer,
  observePersistentCitationHighlight,
  getQueryValue,
  previewFromLines,
  retryFocusCitationTarget,
} from '../utils/documentNavigation';
import {
  readViewPosition,
  retryRestoreViewPosition,
  restoreEditorViewPosition,
  writeEditorViewPosition,
} from '../utils/viewPosition';
import { mapConversationMessages } from '../utils/conversations';
import {
  buildConversationExportFileName,
  downloadTextFile,
  formatConversationExportMarkdown,
} from '../utils/conversationExport';
import { readApiResponse } from '../utils/http';
import { navigateWithFallback } from '../utils/navigation';
import { classifyKnowledgeTaskIntent, shouldAuthorizeCurrentFile } from '../utils/agentLoopRouting';
import { getAgentAuthorizedDirectory } from '../utils/agentPaths';

const WysiwygEditor = dynamic(
  () => import('../components/Editor/WysiwygEditor').then((module) => module.WysiwygEditor),
  { ssr: false, loading: () => <SkeletonText lines={6} /> }
);

const KNOWLEDGE_LAYOUT_STORAGE_KEY = 'notus-layout-knowledge-left-percent';
const KNOWLEDGE_LAYOUT_DEFAULT = 44;
const KNOWLEDGE_LAYOUT_MIN = 32;
const KNOWLEDGE_LAYOUT_MAX = 64;
const KNOWLEDGE_EDITOR_MIN_WIDTH = 600;
const KNOWLEDGE_CHAT_MIN_WIDTH = 456;
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function clampKnowledgeLayoutPercent(value) {
  const parsed = Number.parseFloat(value);
  const base = Number.isFinite(parsed) ? parsed : KNOWLEDGE_LAYOUT_DEFAULT;
  return Math.min(Math.max(base, KNOWLEDGE_LAYOUT_MIN), KNOWLEDGE_LAYOUT_MAX);
}

function readKnowledgeLayoutCache() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KNOWLEDGE_LAYOUT_STORAGE_KEY);
    if (raw === null) return null;
    return clampKnowledgeLayoutPercent(raw);
  } catch {
    return null;
  }
}

function writeKnowledgeLayoutCache(value) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      KNOWLEDGE_LAYOUT_STORAGE_KEY,
      String(clampKnowledgeLayoutPercent(value))
    );
  } catch {}
}

function buildAnswerStage(event = {}) {
  const sectionCount = Array.isArray(event.sections) ? event.sections.length : 0;
  const matchedFileCount = Array.isArray(event.matched_files) ? event.matched_files.length : 0;
  const chunkCount = Array.isArray(event.chunks) ? event.chunks.length : 0;
  const citationCount = Number(event.citation_count || 0);
  const sources = citationCount || sectionCount || matchedFileCount || chunkCount;
  return {
    stage: event.sufficiency === false || event.answer_mode === 'no_evidence' ? 'insufficient' : 'found',
    sources,
  };
}

function buildKnowledgeAgentSteps(stage, done = false) {
  if (done) {
    return [
      {
        id: 'search_knowledge',
        label: '检索知识库',
        status: 'done',
        detail: '已完成知识库召回、证据聚合和回答模式判断。',
        tool: '检索知识库',
        input: 'scope: 本地知识库',
        result: stage?.sources ? '找到 ' + stage.sources + ' 条可用来源' : '已完成',
      },
      {
        id: 'answer',
        label: '生成回答',
        status: 'done',
        detail: '已输出回答内容。',
      },
    ];
  }
  if (!stage) {
    return [
      {
        id: 'answer',
        label: '生成回答',
        status: 'running',
        detail: '正在根据检索结果组织回答。',
      },
    ];
  }
  return [
    {
      id: 'search_knowledge',
      label: stage.stage === 'insufficient' ? '检查证据充分性' : '检索知识库',
      status: 'running',
      detail: stage.sources ? '当前找到 ' + stage.sources + ' 条候选来源。' : '正在召回相关笔记。',
      tool: '检索知识库',
      input: 'scope: 本地知识库',
    },
  ];
}

function buildAssistantNote(message) {
  const answerMode = String(message?.answerMode || message?.meta?.answer_mode || '').trim();
  const meta = message?.meta || {};
  if (answerMode === 'clarify_needed') {
    return '这条消息是在补充问题范围，还没有开始检索知识库。';
  }
  if (answerMode === 'weak_evidence') {
    return meta.weak_evidence_reason || '相关证据偏弱，这次回答只保留了可确认部分。';
  }
  if (answerMode === 'conflicting_evidence') {
    return meta.conflict_summary
      ? `笔记里存在不同说法：${meta.conflict_summary}`
      : '笔记里存在不同说法，这次没有合并成单一结论。';
  }
  if (answerMode === 'no_evidence') {
    return '这次没有在知识库里找到足够证据，所以没有给出事实性结论。';
  }
  return '';
}

function buildConversationListUrl() {
  const params = new URLSearchParams({ kind: 'knowledge', limit: '20' });
  return `/api/conversations?${params.toString()}`;
}

function upsertInteraction(list = [], interaction = null) {
  if (!interaction?.id) return list;
  const next = Array.isArray(list) ? [...list] : [];
  const index = next.findIndex((item) => Number(item.id) === Number(interaction.id));
  if (interaction.status === 'answered' || interaction.status === 'cancelled') {
    if (index >= 0) next.splice(index, 1);
    return next.sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  }
  if (index >= 0) next[index] = interaction;
  else next.push(interaction);
  return next.sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
}

function upsertMessage(list = [], message = null) {
  if (!message?.id) return list;
  const next = Array.isArray(list) ? [...list] : [];
  const index = next.findIndex((item) => String(item.id) === String(message.id));
  if (index >= 0) next[index] = message;
  else next.push(message);
  return next;
}

function shouldHideInteractionSummaryMessage(message) {
  if (message?.role !== 'user') return false;
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
  return Boolean(meta.interaction_id && meta.interaction_resolution_status);
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
    refreshFiles,
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
  const [deletingConversationId, setDeletingConversationId] = useState(null);
  const [exportingConversationId, setExportingConversationId] = useState(null);
  const [, setConversationDraft] = useState(true);
  const [pendingInteractions, setPendingInteractions] = useState([]);
  const [interactionSubmittingId, setInteractionSubmittingId] = useState(null);
  const [clarifyDrawerPhase, setClarifyDrawerPhase] = useState('expanded-question');
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
  const [editorLayoutLeftPercent, setEditorLayoutLeftPercent] = useState(KNOWLEDGE_LAYOUT_DEFAULT);
  const docContentRef = useRef('');
  const persistedDocContentRef = useRef('');
  const hiddenDocFrontmatterRef = useRef('');
  const restoreDocPositionRef = useRef(false);
  const saveDocPositionTimerRef = useRef(null);
  const chatEndRef = useRef(null);
  const requestControllerRef = useRef(null);
  const inputTextareaRef = useRef(null);
  const layoutChangeCountRef = useRef(0);
  const persistedLayoutLeftPercentRef = useRef(null);

  const referenceFileOptions = allFiles.map((file) => ({
    value: file.id,
    label: getVisibleDocumentLabel(file, '未命名文档'),
    searchText: `${file.title || ''} ${file.name || ''} ${file.path || ''}`,
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

  useIsomorphicLayoutEffect(() => {
    const cached = readKnowledgeLayoutCache();
    if (cached === null) return;
    setEditorLayoutLeftPercent(cached);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const baselineChangeCount = layoutChangeCountRef.current;

    fetch('/api/settings', { cache: 'no-store' })
      .then((response) => readApiResponse(response, '读取布局设置失败'))
      .then((settings) => {
        if (cancelled) return;
        if (layoutChangeCountRef.current !== baselineChangeCount) return;
        const savedPercent = settings?.layout?.knowledge_left_percent;
        if (savedPercent === undefined || savedPercent === null) return;
        const normalized = clampKnowledgeLayoutPercent(savedPercent);
        persistedLayoutLeftPercentRef.current = normalized;
        writeKnowledgeLayoutCache(normalized);
        setEditorLayoutLeftPercent(normalized);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const handleEditorLayoutChange = useCallback((nextPercent) => {
    layoutChangeCountRef.current += 1;
    setEditorLayoutLeftPercent(clampKnowledgeLayoutPercent(nextPercent));
  }, []);

  const handleEditorLayoutCommit = useCallback(async (nextPercent) => {
    const normalized = clampKnowledgeLayoutPercent(nextPercent);
    writeKnowledgeLayoutCache(normalized);
    setEditorLayoutLeftPercent(normalized);

    if (
      persistedLayoutLeftPercentRef.current !== null
      && Math.abs(persistedLayoutLeftPercentRef.current - normalized) < 0.01
    ) {
      return;
    }

    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layout: {
            knowledge_left_percent: normalized,
          },
        }),
        keepalive: true,
      });
      const payload = await readApiResponse(response, '知识库分栏宽度保存失败');
      const confirmedPercent = payload?.layout?.knowledge_left_percent;
      const confirmed = confirmedPercent === undefined || confirmedPercent === null
        ? normalized
        : clampKnowledgeLayoutPercent(confirmedPercent);
      persistedLayoutLeftPercentRef.current = confirmed;
      writeKnowledgeLayoutCache(confirmed);
      setEditorLayoutLeftPercent(confirmed);
    } catch (error) {
      toast(error.message || '知识库分栏宽度保存失败', 'danger');
    }
  }, [toast]);

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
    if (!Number.isFinite(requestedFileId)) return;
    if (activeFile?.id === requestedFileId) return;
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
      hiddenDocFrontmatterRef.current = '';
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
        const { visibleContent, hiddenFrontmatter } = splitEditorVisibleMarkdown(file.content || '');
        const nextContent = visibleContent || '';
        setDocContent(nextContent);
        docContentRef.current = nextContent;
        persistedDocContentRef.current = nextContent;
        hiddenDocFrontmatterRef.current = hiddenFrontmatter || '';
        restoreDocPositionRef.current = true;
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
      { persistent: true, markdown: docContent, maxAttempts: 20, retryDelay: 80 },
      {
        onResolved: (matched) => {
          if (!matched) {
            setActiveCitationSelection(null);
            clearPendingCitation();
            toast('无法定位到来源段落，文档内容可能已变更', 'warning');
            return;
          }
          setActiveCitationTarget(target);
          clearPendingCitation();
        },
      }
    );
  }, [activeFile?.id, clearPendingCitation, docContent, docError, docLoading, editor, editorReadyFileId, pendingCitation, toast]);

  useEffect(() => {
    if (!editor || !activeFile?.id || docLoading || docError) return undefined;
    const container = getEditorScrollContainer(editor);
    if (!container) return undefined;
    const hasPendingCitationNav = Number(pendingCitation?.fileId) === activeFile.id;

    if (restoreDocPositionRef.current && !hasPendingCitationNav && readViewPosition('knowledge', activeFile.id)) {
      return retryRestoreViewPosition(
        () => restoreEditorViewPosition('knowledge', activeFile.id, container),
        {
          onComplete: () => {
            restoreDocPositionRef.current = false;
          },
        }
      );
    }

    restoreDocPositionRef.current = false;
    return undefined;
  }, [activeFile?.id, docContent, docError, docLoading, editor, pendingCitation]);

  useEffect(() => {
    if (!editor || !activeFile?.id || docLoading || docError) return undefined;
    const container = getEditorScrollContainer(editor);
    if (!container) return undefined;

    const savePosition = () => {
      if (!activeFile?.id || restoreDocPositionRef.current) return;
      writeEditorViewPosition('knowledge', activeFile.id, container);
    };

    const handleScroll = () => {
      if (saveDocPositionTimerRef.current) {
        window.clearTimeout(saveDocPositionTimerRef.current);
      }
      saveDocPositionTimerRef.current = window.setTimeout(savePosition, 240);
    };

    const flushPosition = () => {
      if (saveDocPositionTimerRef.current) {
        window.clearTimeout(saveDocPositionTimerRef.current);
        saveDocPositionTimerRef.current = null;
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
      if (saveDocPositionTimerRef.current) {
        window.clearTimeout(saveDocPositionTimerRef.current);
        saveDocPositionTimerRef.current = null;
      }
      savePosition();
    };
  }, [activeFile?.id, docError, docLoading, editor, router.events]);

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
      const contentToSave = mergeEditorVisibleMarkdown(nextContent, hiddenDocFrontmatterRef.current);
      const response = await fetch(`/api/files/${activeFile.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: contentToSave }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存失败');

      const { visibleContent, hiddenFrontmatter } = splitEditorVisibleMarkdown(payload.content || contentToSave);
      const savedContent = visibleContent || nextContent;
      persistedDocContentRef.current = savedContent;
      docContentRef.current = savedContent;
      hiddenDocFrontmatterRef.current = hiddenFrontmatter || hiddenDocFrontmatterRef.current || '';
      setDocContent(savedContent);
      setCachedContent(activeFile.id, payload.content || contentToSave);
      await refreshFiles({ background: true });
      if (payload.title_binding_warning) {
        toast(payload.title_binding_warning, 'warning');
      }
      setDocSaveState('saved');
      return true;
    } catch (saveError) {
      setDocSaveState('dirty');
      toast(saveError.message || '保存失败', 'error');
      return false;
    }
  }, [activeFile?.id, refreshFiles, setCachedContent, toast]);

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

  const readSse = useCallback(async (response, onEvent) => {
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
  }, []);

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

  const refreshActiveDocumentAfterAgentWrite = useCallback(async () => {
    try {
      await refreshFiles();
      if (!activeFile?.id) return;
      const response = await fetch(`/api/files/${activeFile.id}`, { cache: 'no-store' });
      const payload = await readApiResponse(response, '刷新当前文档失败');
      setCachedContent(activeFile.id, payload.content || '');
      const { visibleContent, hiddenFrontmatter } = splitEditorVisibleMarkdown(payload.content || '');
      const nextContent = visibleContent || '';
      setDocContent(nextContent);
      docContentRef.current = nextContent;
      persistedDocContentRef.current = nextContent;
      hiddenDocFrontmatterRef.current = hiddenFrontmatter || '';
      setDocSaveState('saved');
    } catch (writeRefreshError) {
      toast(writeRefreshError.message || '刷新当前文档失败', 'error');
    }
  }, [activeFile?.id, refreshFiles, setCachedContent, toast]);

  const handleAgentLoopOperationSetHandled = useCallback((operationSetId) => {
    setMessages((prev) => prev.map((message) => (
      Number(message?.meta?.operation_set_id || 0) === Number(operationSetId)
        ? {
          ...message,
          operationSet: null,
          meta: {
            ...(message.meta || {}),
            operation_set_id: null,
          },
        }
        : message
    )));
  }, []);

  const agentLoop = useAgentLoopController({
    onAppendUserMessage: (message) => setMessages((prev) => [...prev, message]),
    onAppendAssistantMessage: (message) => setMessages((prev) => upsertMessage(prev, message)),
    onConversationId: (conversationId) => {
      if (!conversationId) return;
      setActiveConversationId(Number(conversationId));
      setConversationDraft(false);
    },
    onConversationSettled: (conversationId) => {
      if (conversationId) refreshConversationListOnly(Number(conversationId));
    },
    onOperationSetHandled: handleAgentLoopOperationSetHandled,
    onApplySuccess: refreshActiveDocumentAfterAgentWrite,
    onRollbackSuccess: refreshActiveDocumentAfterAgentWrite,
    onError: (loopError) => {
      const message = loopError.message || 'Agent Loop 请求失败';
      setError(message);
      toast(message, 'error');
    },
  });
  const aiRequestLoading = loading || agentLoop.loading;
  const agentLoopInteractionLocked = Boolean(agentLoop.pendingAgentTask)
    || ['running', 'waiting_confirm'].includes(agentLoop.activeAgentSession?.status);

  const focusKnowledgeInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      inputTextareaRef.current?.focus?.();
    });
  }, []);

  const respondToInteraction = useCallback(async (interaction, body, options = {}) => {
    if (!interaction?.id) return null;
    if (options.setSubmitting !== false) setInteractionSubmittingId(interaction.id);
    try {
      const response = await fetch(`/api/interactions/${interaction.id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          schema_version: interaction.schema_version,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (payload.interaction) {
          setPendingInteractions((prev) => upsertInteraction(prev, payload.interaction));
        }
        throw new Error(payload.error || '回答提问抽屉失败');
      }
      if (payload.interaction) {
        setPendingInteractions((prev) => upsertInteraction(prev, payload.interaction));
      }
      if (payload.answer_message) {
        const mappedMessage = mapConversationMessages([payload.answer_message], 'knowledge')[0] || null;
        if (mappedMessage) {
          setMessages((prev) => upsertMessage(prev, mappedMessage));
        }
      }
      if (payload.interaction?.conversation_id) {
        setActiveConversationId(Number(payload.interaction.conversation_id));
        setConversationDraft(false);
        refreshConversationListOnly(Number(payload.interaction.conversation_id));
      }
      return payload;
    } finally {
      if (options.setSubmitting !== false) setInteractionSubmittingId(null);
    }
  }, [refreshConversationListOnly]);

  const cancelInteraction = useCallback(async (interaction, options = {}) => {
    if (!interaction?.id) return null;
    try {
      return await respondToInteraction(interaction, { action: 'cancel' }, { setSubmitting: false });
    } catch (cancelError) {
      if (!options.silent) {
        toast(cancelError.message || '关闭提问抽屉失败', 'error');
      }
      throw cancelError;
    }
  }, [respondToInteraction, toast]);

  const runInteractionResume = useCallback(async (interaction, llmConfigId = selectedLlmConfigId) => {
    if (!interaction?.id || !llmConfigId) {
      if (!llmConfigId) {
      toast('请先在模型配置中新增至少一个 LLM 配置', 'warning');
      }
      return;
    }

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setError(null);
    setLoading(true);
    setRetrievalStage({ stage: 'searching', sources: 0 });
    setStreamText('');

    try {
      let answer = '';
      let citations = [];
      let documents = [];
      let documentStats = null;
      let sourceCount = 0;
      let assistantMeta = null;
      let resolvedConversationId = activeConversationId;
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          conversation_id: activeConversationId || undefined,
          interaction_id: interaction.id,
          llm_config_id: llmConfigId,
          active_file_id: activeFile?.id || null,
          reference_mode: referenceMode,
          reference_file_ids: referenceMode === 'manual' ? manualReferenceFileIds : undefined,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || '继续检索失败');
      }

      await readSse(response, (event) => {
        if (event.conversation_id) {
          resolvedConversationId = Number(event.conversation_id);
        }
        if (event.type === 'chunks') {
          documents = Array.isArray(event.documents) ? event.documents : [];
          documentStats = event.document_stats || null;
          setRetrievalStage(buildAnswerStage(event));
        } else if (event.type === 'assistant_meta') {
          assistantMeta = event;
          documentStats = event.document_stats || documentStats;
          if (event.interaction) {
            setPendingInteractions((prev) => upsertInteraction(prev, event.interaction));
          }
          if (event.answer_mode === 'clarify_needed') {
            setRetrievalStage(null);
          }
        } else if (event.type === 'token') {
          answer += event.text || '';
          setStreamText(answer);
          setRetrievalStage(null);
        } else if (event.type === 'citations') {
          citations = event.citations || [];
          sourceCount = Number(event.source_count || event.citations?.length || 0);
        } else if (event.type === 'done') {
          const finalMeta = event.meta || assistantMeta;
          documentStats = event.document_stats || finalMeta?.document_stats || documentStats;
          if (event.interaction) {
            setPendingInteractions((prev) => upsertInteraction(prev, event.interaction));
          }
          setMessages((prev) => upsertMessage(prev, {
            id: event.message_id || Date.now(),
            role: 'assistant',
            content: answer,
            citations,
            documents,
            documentStats,
            sourceCount: Number(event.source_count || finalMeta?.source_count || sourceCount || citations.length || 0),
            meta: finalMeta,
            answerMode: event.answer_mode || finalMeta?.answer_mode || null,
          }));
          if (resolvedConversationId) {
            setActiveConversationId(resolvedConversationId);
            setConversationDraft(false);
            refreshConversationListOnly(resolvedConversationId);
          }
          setStreamText('');
          setLoading(false);
        } else if (event.type === 'error') {
          const nextError = new Error(event.error || '继续检索失败');
          nextError.conversationId = event.conversation_id ? Number(event.conversation_id) : resolvedConversationId;
          throw nextError;
        }
      });
    } catch (resumeError) {
      if (resumeError.name !== 'AbortError') {
        if (resumeError.conversationId) {
          setActiveConversationId(Number(resumeError.conversationId));
          setConversationDraft(false);
          refreshConversationListOnly(Number(resumeError.conversationId));
        }
        setError(resumeError.message || '继续检索失败');
      }
      setLoading(false);
      setRetrievalStage(null);
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  }, [
    activeConversationId,
    activeFile?.id,
    manualReferenceFileIds,
    readSse,
    referenceMode,
    refreshConversationListOnly,
    selectedLlmConfigId,
    toast,
  ]);

  const handleNewConversation = useCallback(() => {
    requestControllerRef.current?.abort();
    clearActiveCitationState();
    setActiveConversationId(null);
    setConversationDraft(true);
    setMessages([]);
    setPendingInteractions([]);
    agentLoop.cancelAgentTask();
    setStreamText('');
    setError(null);
    setLoading(false);
    setRetrievalStage(null);
    setHistoryDrawerOpen(false);
  }, [agentLoop, clearActiveCitationState]);

  const handleConversationDelete = useCallback(async (conversationId) => {
    const normalizedConversationId = Number(conversationId);
    if (!Number.isFinite(normalizedConversationId) || deletingConversationId) return;
    setDeletingConversationId(normalizedConversationId);
    requestControllerRef.current?.abort();
    try {
      const response = await fetch(`/api/conversations/${normalizedConversationId}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || '删除历史对话失败');
      }
      if (Number(activeConversationId) === normalizedConversationId) {
        clearActiveCitationState();
        setActiveConversationId(null);
        setConversationDraft(true);
        setMessages([]);
        setPendingInteractions([]);
        setStreamText('');
        setError(null);
        setLoading(false);
        setRetrievalStage(null);
      }
      const rows = await fetchConversationList();
      setConversationList(rows);
      toast('历史对话已删除', 'success');
    } catch (deleteError) {
      toast(deleteError.message || '删除历史对话失败', 'error');
    } finally {
      setDeletingConversationId(null);
    }
  }, [activeConversationId, clearActiveCitationState, deletingConversationId, fetchConversationList, toast]);

  const handleConversationExport = useCallback(async (conversationId, conversation = null) => {
    const normalizedConversationId = Number(conversationId);
    if (!Number.isFinite(normalizedConversationId) || exportingConversationId) return;
    setExportingConversationId(normalizedConversationId);
    try {
      const payload = await fetchConversationDetail(normalizedConversationId);
      const isActive = Number(activeConversationId) === normalizedConversationId;
      const exportMessages = isActive && messages.length > 0
        ? messages
        : (Array.isArray(payload.messages) ? payload.messages : []);
      const exportPayload = {
        conversation: { ...(conversation || {}), ...(payload || {}) },
        messages: exportMessages,
        agentSessions: Array.isArray(payload.agent_sessions) ? payload.agent_sessions : [],
        pendingOperationSets: Array.isArray(payload.pending_operation_sets) ? payload.pending_operation_sets : [],
        source: 'Notus 知识库页',
      };
      const content = formatConversationExportMarkdown(exportPayload);
      downloadTextFile(buildConversationExportFileName(exportPayload.conversation), content);
      toast('对话已导出为 Markdown 文件', 'success');
    } catch (exportError) {
      toast(exportError.message || '导出历史对话失败', 'error');
    } finally {
      setExportingConversationId(null);
    }
  }, [
    activeConversationId,
    exportingConversationId,
    fetchConversationDetail,
    messages,
    toast,
  ]);

  const handleConversationAgentLogs = useCallback((conversationId) => {
    if (!conversationId) return;
    navigateWithFallback(router, `/settings/logs?conversation_id=${encodeURIComponent(conversationId)}`);
  }, [router]);

  const handleConversationSelect = useCallback(async (conversationId) => {
    if (!conversationId || aiRequestLoading || agentLoopInteractionLocked) return;
    setConversationListLoading(true);
    requestControllerRef.current?.abort();
    clearActiveCitationState();
    try {
      const payload = await fetchConversationDetail(conversationId);
      setMessages(mapConversationMessages(payload.messages, 'knowledge'));
      setPendingInteractions(Array.isArray(payload.pending_interactions) ? payload.pending_interactions : []);
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
  }, [agentLoopInteractionLocked, aiRequestLoading, clearActiveCitationState, fetchConversationDetail, toast]);

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
        setActiveConversationId(null);
        setConversationDraft(true);
        setMessages([]);
        setPendingInteractions([]);
      } catch (loadError) {
        if (cancelled) return;
        setConversationList([]);
        setActiveConversationId(null);
        setConversationDraft(true);
        setMessages([]);
        setPendingInteractions([]);
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

  const handleSend = async (query, optionsOrLlmConfigId = selectedLlmConfigId) => {
    const sendOptions = optionsOrLlmConfigId && typeof optionsOrLlmConfigId === 'object'
      ? optionsOrLlmConfigId
      : { llmConfigId: optionsOrLlmConfigId };
    const llmConfigId = sendOptions.llmConfigId || selectedLlmConfigId;
    if (!llmConfigId) {
      toast('请先在模型配置中新增至少一个 LLM 配置', 'warning');
      return;
    }

    const currentInteraction = [...pendingInteractions].reverse().find((item) => ['pending', 'failed', 'stale'].includes(item.status)) || null;
    if (currentInteraction && clarifyDrawerPhase === 'collapsed') {
      try {
        await cancelInteraction(currentInteraction, { silent: true });
      } catch {}
    }

    const routeDecision = classifyKnowledgeTaskIntent(query);
    if (routeDecision.route === 'loop') {
      const authorizeCurrentFile = shouldAuthorizeCurrentFile(query);
      const currentPath = authorizeCurrentFile ? (activeFile?.path || '') : '';
      const goal = currentPath
        ? `用户任务：${query}\n\n当前文档路径：${currentPath}`
        : query;
      setError(null);
      setRetrievalStage(null);
      agentLoop.createAgentTask({
        goal,
        display_query: query,
        kind: 'knowledge',
        conversation_id: activeConversationId || undefined,
        active_file_id: activeFile?.id || undefined,
        llm_config_id: llmConfigId,
        authorized_paths: [getAgentAuthorizedDirectory(currentPath)],
        authorized_ops: ['modify', 'create'],
        search_knowledge_limit: 5,
        attachments: sendOptions.attachments || [],
        route_reason: routeDecision.reason,
      });
      return;
    }

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setError(null);
    setLoading(true);
    setRetrievalStage({ stage: 'searching', sources: 0 });
    setMessages((prev) => [...prev, {
      id: Date.now(),
      role: 'user',
      content: query,
      attachments: sendOptions.attachments || [],
      meta: {
        web_search_enabled: Boolean(sendOptions.webSearchEnabled),
        search_provider: sendOptions.searchProvider || null,
        search_providers: sendOptions.searchProviders || undefined,
      },
    }]);
    setStreamText('');

    try {
      let answer = '';
      let citations = [];
      let documents = [];
      let documentStats = null;
      let sourceCount = 0;
      let assistantMeta = null;
      let resolvedConversationId = activeConversationId;
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          conversation_id: activeConversationId || undefined,
          query,
          llm_config_id: llmConfigId,
          modelConfigId: llmConfigId,
          active_file_id: activeFile?.id || null,
          reference_mode: referenceMode,
          reference_file_ids: referenceMode === 'manual' ? manualReferenceFileIds : undefined,
          webSearchEnabled: Boolean(sendOptions.webSearchEnabled),
          searchProvider: sendOptions.searchProvider || null,
          attachments: sendOptions.attachments || [],
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
          documents = Array.isArray(event.documents) ? event.documents : [];
          documentStats = event.document_stats || null;
          setRetrievalStage(buildAnswerStage(event));
        } else if (event.type === 'assistant_meta') {
          assistantMeta = event;
          documentStats = event.document_stats || documentStats;
          if (event.interaction) {
            setPendingInteractions((prev) => upsertInteraction(prev, event.interaction));
          }
          if (event.answer_mode === 'clarify_needed') {
            setRetrievalStage(null);
          }
        } else if (event.type === 'token') {
          answer += event.text || '';
          setStreamText(answer);
          setRetrievalStage(null);
        } else if (event.type === 'citations') {
          citations = event.citations || [];
          sourceCount = Number(event.source_count || event.citations?.length || 0);
        } else if (event.type === 'done') {
          const finalMeta = event.meta || assistantMeta;
          documentStats = event.document_stats || finalMeta?.document_stats || documentStats;
          if (event.interaction) {
            setPendingInteractions((prev) => upsertInteraction(prev, event.interaction));
          }
          setMessages((prev) => upsertMessage(prev, {
            id: event.message_id || Date.now(),
            role: 'assistant',
            content: answer,
            citations,
            documents,
            documentStats,
            sourceCount: Number(event.source_count || finalMeta?.source_count || sourceCount || citations.length || 0),
            meta: finalMeta,
            answerMode: event.answer_mode || finalMeta?.answer_mode || null,
            toolSteps: buildKnowledgeAgentSteps(buildAnswerStage({ citation_count: Number(event.source_count || finalMeta?.source_count || sourceCount || citations.length || 0) }), true),
          }));
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

  const handleApplyOperationSet = async (operationSet) => {
    try {
      await agentLoop.applyOperationSet(operationSet);
      toast('修改已应用', 'success');
    } catch (applyError) {
      toast(applyError.message || '应用修改失败', 'error');
    }
  };

  const handleCancelOperationSet = async (operationSet) => {
    try {
      await agentLoop.rejectOperationSet(operationSet);
    } catch (rejectError) {
      toast(rejectError.message || '撤销预览失败', 'error');
    }
  };

  const activeClarifyInteraction = aiRequestLoading
    ? null
    : ([...pendingInteractions].reverse().find((item) => item.status === 'pending')
      || [...pendingInteractions].reverse().find((item) => item.status === 'failed')
      || [...pendingInteractions].reverse().find((item) => item.status === 'stale')
      || null);
  const hiddenInteractionIds = new Set(
    pendingInteractions
      .filter((item) => item && ['pending', 'failed', 'stale'].includes(item.status))
      .map((item) => String(item.id))
  );
  const visibleMessages = messages.filter((msg) => {
    if (shouldHideInteractionSummaryMessage(msg)) return false;
    if (msg.role !== 'assistant') return true;
    const meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : {};
    const retryInteractionId = String(meta.retry_interaction_id || '');
    if (meta.retry_available && hiddenInteractionIds.has(retryInteractionId)) {
      return false;
    }
    return true;
  });
  const isEmpty = visibleMessages.length === 0 && !aiRequestLoading;

  const handleClarifyDrawerSubmit = useCallback(async (interaction, answers) => {
    try {
      const payload = await respondToInteraction(interaction, { response: { answers } });
      if (!payload?.should_continue) return;
      await runInteractionResume(payload.interaction || interaction, selectedLlmConfigId);
    } catch (submitError) {
      toast(submitError.message || '回答提问抽屉失败', 'error');
    }
  }, [respondToInteraction, runInteractionResume, selectedLlmConfigId, toast]);

  const handleRetryInteraction = useCallback(async (interaction) => {
    if (!interaction?.id) return;
    await runInteractionResume(interaction, selectedLlmConfigId);
  }, [runInteractionResume, selectedLlmConfigId]);
  const aiState = deriveAiReadiness({
    appStatus,
    appStatusLoading,
    llmConfigs,
    llmConfigsLoading,
    requireIndexedFiles: true,
  });
  const aiUiState = useStableAiReadiness(aiState);
  const aiReady = aiUiState.ready;
  const knowledgeInputDisabled = !aiReady
    || (Boolean(activeClarifyInteraction) && clarifyDrawerPhase !== 'collapsed');
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

  useEffect(() => {
    setClarifyDrawerPhase('expanded-question');
  }, [activeClarifyInteraction?.id]);

  const getDocumentFindRoot = useCallback(() => getEditorRoot(editor), [editor]);

  const documentFind = useDocumentFind({
    enabled: Boolean(activeFile && editor && editorOpen),
    getRoot: getDocumentFindRoot,
    selector: 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th',
    contentVersion: `${activeFile?.id || 'none'}:${docContent}`,
  });
  const tocItems = useEditorToc({
    editor: editorOpen ? editor : null,
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
      fileName={getVisibleDocumentLabel(activeFile, '未命名文档')}
      saveState={activeFile ? docSaveState : undefined}
      onSave={activeFile ? handleDocSave : undefined}
      saveDisabled={!activeFile || docSaveState !== 'dirty'}
      tocDisabled={!activeFile || !editorOpen}
      tocItems={tocItems}
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
                  {getVisibleDocumentLabel(activeFile, '文章预览')}
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
                      .then((file) => {
                        const { visibleContent, hiddenFrontmatter } = splitEditorVisibleMarkdown(file.content || '');
                        const nextContent = visibleContent || '';
                        setDocError(null);
                        setDocContent(nextContent);
                        docContentRef.current = nextContent;
                        persistedDocContentRef.current = nextContent;
                        hiddenDocFrontmatterRef.current = hiddenFrontmatter || '';
                        setDocLoading(false);
                      })
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
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>参考来源</div>
                {[
                  { value: 'auto', label: '自动匹配' },
                  { value: 'manual', label: '手动指定' },
                ].map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setReferenceMode(mode.value)}
                    style={{
                      height: 26,
                      padding: '0 10px',
                      background: referenceMode === mode.value ? 'var(--accent-subtle)' : 'transparent',
                      border: `1px solid ${referenceMode === mode.value ? 'color-mix(in srgb, var(--accent) 35%, var(--border-primary))' : 'var(--border-subtle)'}`,
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
                {!editorOpen && activeFile && (
                  <Button variant="secondary" size="sm" onClick={() => setEditorOpen(true)} style={{ height: 30 }}>
                    显示文章
                  </Button>
                )}
                <Tooltip content="查看历史对话">
                  <span style={{ display: 'inline-flex' }}>
                    <IconButton
                      label="查看历史对话"
                      size={30}
                      active={historyDrawerOpen}
                      disabled={aiRequestLoading || conversationListLoading || agentLoopInteractionLocked}
                      onClick={() => setHistoryDrawerOpen(true)}
                    >
                      {conversationListLoading ? <Icons.refresh size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Icons.clock size={14} />}
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip content="新建对话">
                  <span style={{ display: 'inline-flex' }}>
                    <IconButton
                      label="新建对话"
                      size={30}
                      disabled={aiRequestLoading || agentLoopInteractionLocked}
                      onClick={handleNewConversation}
                    >
                      <Icons.plus size={14} />
                    </IconButton>
                  </span>
                </Tooltip>
              </div>
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
                        <Badge tone="accent">{getVisibleDocumentLabel(file, '未命名文档')} ×</Badge>
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
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <AgentWorkspace
              messages={visibleMessages}
              streamText={agentLoop.loading || agentLoop.streamText ? agentLoop.streamText : streamText}
              loading={aiRequestLoading}
              error={agentLoop.error || error}
              activeSteps={agentLoop.activeSteps.length > 0 ? agentLoop.activeSteps : buildKnowledgeAgentSteps(retrievalStage)}
              llmConfigs={llmConfigs}
              selectedConfigId={selectedLlmConfigId}
              onConfigChange={setSelectedLlmConfigId}
              onSend={handleSend}
              onStop={() => {
                if (agentLoop.loading) agentLoop.stopAgentLoop();
                else requestControllerRef.current?.abort();
              }}
              onCitationClick={handleCitationClick}
              onApplyOperationSet={handleApplyOperationSet}
              onCancelOperationSet={handleCancelOperationSet}
              pendingAgentTask={agentLoop.pendingAgentTask}
              activeAgentSession={agentLoop.activeAgentSession}
              onConfirmAgentTask={agentLoop.confirmAgentTask}
              onCancelAgentTask={agentLoop.cancelAgentTask}
              onRollbackAgentSession={agentLoop.rollbackAgentSession}
              onExtendAgentSession={agentLoop.extendAgentSession}
              disabled={knowledgeInputDisabled || aiRequestLoading || agentLoopInteractionLocked}
              placeholder="从你的知识库中查找答案…"
            />
          </div>
          <div style={{ display: 'none' }}>
          <div style={{ flex: 1, overflow: 'auto', padding: '24px 32px' }}>
            <div style={{ maxWidth: 680, margin: '0 auto' }}>
              {isEmpty ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '55vh' }}>
                  <EmptyState
                    icon={<Icons.sparkles size={48} />}
                    title="向你的知识库提问"
                    subtitle="你可以一边编辑左侧文章，一边基于笔记内容发问。"
                  />
                </div>
              ) : (
                <>
                  {visibleMessages.map((msg) =>
                    msg.role === 'user'
                      ? <UserBubble key={msg.id}>{msg.content}</UserBubble>
                      : (
                        <div key={msg.id}>
                          <AiBubble
                            text={msg.content}
                            citations={msg.citations}
                            sourceCount={msg.sourceCount || msg.meta?.source_count || 0}
                            assistantNote={buildAssistantNote(msg)}
                            documents={msg.documents || msg.meta?.documents || []}
                            documentStats={msg.documentStats || msg.meta?.document_stats || null}
                            onCitationClick={handleCitationClick}
                            citationSelection={activeCitationSelection}
                            messageId={msg.id}
                            answerMode={msg.answerMode}
                          />
                        </div>
                      )
                  )}

                  {loading && (
                    <div style={{ margin: '16px 0' }}>
                      <AiBubble text={streamText} streaming retrievalStage={retrievalStage} />
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
            onStop={() => {
              if (agentLoop.loading) agentLoop.stopAgentLoop();
              else requestControllerRef.current?.abort();
            }}
            loading={aiRequestLoading}
            llmConfigs={llmConfigs}
            selectedConfigId={selectedLlmConfigId}
            onConfigChange={setSelectedLlmConfigId}
            disabled={knowledgeInputDisabled || aiRequestLoading || agentLoopInteractionLocked}
            showPlusMenu={false}
            textareaRef={inputTextareaRef}
          />
          </div>
          {activeClarifyInteraction ? (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 10,
                pointerEvents: 'none',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
              }}
            >
              <div
                style={{
                  padding: '56px 12px 12px',
                  background: 'linear-gradient(180deg, rgba(247, 244, 238, 0) 0%, var(--bg-primary) 28%)',
                  pointerEvents: 'none',
                  position: 'relative',
                  zIndex: 1,
                }}
              >
                <div style={{ pointerEvents: 'auto' }}>
                  <ClarifyDrawer
                    interaction={activeClarifyInteraction}
                    onSubmit={handleClarifyDrawerSubmit}
                    onRetry={handleRetryInteraction}
                    onCancel={(interaction) => { void cancelInteraction(interaction); }}
                    onPhaseChange={setClarifyDrawerPhase}
                    onFocusInput={focusKnowledgeInput}
                    submitting={interactionSubmittingId === Number(activeClarifyInteraction?.id)}
                    submitLabel={activeClarifyInteraction?.payload?.submit_label || '开始检索'}
                    retryLabel="重试"
                  />
                </div>
              </div>
            </div>
          ) : null}
          <ConversationDrawer
            open={historyDrawerOpen}
            onClose={() => setHistoryDrawerOpen(false)}
            conversations={conversationList}
            activeConversationId={activeConversationId}
            loading={conversationListLoading}
            emptyText="暂无历史对话"
            onSelect={handleConversationSelect}
            onDelete={handleConversationDelete}
            onExport={handleConversationExport}
            onViewAgentLogs={handleConversationAgentLogs}
            deletingConversationId={deletingConversationId}
            exportingConversationId={exportingConversationId}
          />
          {aiUiState.showLockedState && (
            <AiLockedState
              variant="panel"
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
              initialLeftPercent={KNOWLEDGE_LAYOUT_DEFAULT}
              minLeftPercent={KNOWLEDGE_LAYOUT_MIN}
              maxLeftPercent={KNOWLEDGE_LAYOUT_MAX}
              minLeftPx={KNOWLEDGE_EDITOR_MIN_WIDTH}
              minRightPx={KNOWLEDGE_CHAT_MIN_WIDTH}
              leftPercent={editorLayoutLeftPercent}
              onLeftPercentChange={handleEditorLayoutChange}
              onLeftPercentCommit={handleEditorLayoutCommit}
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
