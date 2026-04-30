// /canvas — AI creation canvas page
import { useState, useRef, useEffect, useCallback } from 'react';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useRouter } from 'next/router';
import { Shell } from '../components/Layout/Shell';
import { CanvasBlock, AddBlockButton } from '../components/Canvas/CanvasBlock';
import { UserBubble, AiBubble } from '../components/ChatArea/ChatMessage';
import { ConversationDrawer } from '../components/ChatArea/ConversationDrawer';
import { InputBar } from '../components/ChatArea/InputBar';
import { OperationPreview } from '../components/AIPanel/OperationPreview';
import { ResizableLayout } from '../components/ui/ResizableLayout';
import { DropdownSelect } from '../components/ui/DropdownSelect';
import { DocumentFindBar } from '../components/ui/DocumentFindBar';
import { AiLockedState } from '../components/ui/AiLockedState';
import { IconButton } from '../components/ui/IconButton';
import { Icons } from '../components/ui/Icons';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { Tooltip } from '../components/ui/Tooltip';
import { useToast } from '../components/ui/Toast';
import { useApp } from '../contexts/AppContext';
import { useAppStatus } from '../contexts/AppStatusContext';
import { useLlmConfigs } from '../hooks/useLlmConfigs';
import { useStableAiReadiness } from '../hooks/useStableAiReadiness';
import { useDocumentFind } from '../hooks/useDocumentFind';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import { deriveAiReadiness } from '../utils/aiReadiness';
import { mapConversationMessages } from '../utils/conversations';
import { readApiResponse } from '../utils/http';
import { navigateWithFallback } from '../utils/navigation';

const RECENT_ITEMS = [
  { title: '关于慢的意义', sub: '草稿 · 5 个块 · 2 小时前' },
  { title: 'CDN 边缘计算笔记', sub: '草稿 · 12 个块 · 昨天' },
  { title: '《设计心理学》读后', sub: '已完成 · 8 个块 · 3 天前' },
];

const MOCK_BLOCKS_BY_TOPIC = {
  '关于慢的意义': [
    { id: 'b1', type: 'paragraph', content: '窗外下着雨，煮茶的水刚开始冒泡。这是我这周第四次无所事事地坐在厨房里。' },
    { id: 'b2', type: 'paragraph', content: '起初是愧疚的——有太多事情该做了。但坐久了，愧疚像水汽一样淡下去，留下一种久违的、几乎被遗忘的平静。' },
    { id: 'b3', type: 'paragraph', content: '慢从来不是效率的反义词。当我们允许自己在一件事上多停留几分钟，专注反而会悄悄重新回来。' },
    { id: 'b4', type: 'paragraph', content: '慢不是低效，是另一种专注的形态。' },
    { id: 'b5', type: 'paragraph', content: '我想起《搬家第三周》里自己写过的那句——"房子不必立刻住满，就像一段时间不必立刻填满"。' },
  ],
  default: [
    { id: 'b1', type: 'paragraph', content: '（AI 将根据你的主题和笔记风格生成大纲，每个块对应一个段落）' },
    { id: 'b2', type: 'paragraph', content: '点击任意块右上角的 ✦ 按钮，让 AI 帮你展开这一段。' },
  ],
};

function getInitialBlocks(topic) {
  return MOCK_BLOCKS_BY_TOPIC[topic] || MOCK_BLOCKS_BY_TOPIC.default;
}

function getQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function summarizeBlockPreview(content = '') {
  return String(content || '').replace(/\s+/g, ' ').trim().slice(0, 48) || '空白块';
}

function buildCanvasConversationListUrl(fileId, draftKey) {
  const params = new URLSearchParams({ kind: 'canvas', limit: '20' });
  const normalizedFileId = Number(fileId);
  if (Number.isFinite(normalizedFileId) && normalizedFileId > 0) {
    params.set('file_id', String(normalizedFileId));
  } else if (draftKey) {
    params.set('draft_key', draftKey);
  }
  return `/api/conversations?${params.toString()}`;
}

function detectCanvasBlockType(content = '') {
  if (/^#{1,6}\s/m.test(content)) return 'heading';
  if (/^```/m.test(content)) return 'code';
  if (/^\|.+\|$/m.test(content)) return 'table';
  if (/^>\s/m.test(content)) return 'blockquote';
  if (/^([-*+]|\d+\.)\s/m.test(content)) return 'list';
  return 'paragraph';
}

function buildCanvasFallbackBlocks(markdown = '') {
  const source = String(markdown || '').replace(/\r\n/g, '\n').trim();
  if (!source) return [];
  return source
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((content, index) => ({
      id: `b_${index + 1}`,
      type: detectCanvasBlockType(content),
      content,
      headingLevel: 0,
      headingPath: '',
      lineStart: null,
      lineEnd: null,
      semanticGroup: 'fallback',
    }));
}

function SortableCanvasItem({ block, index, state, onAI, onDelete, onContentChange }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.7 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <CanvasBlock
        idx={index + 1}
        blockId={block.id}
        content={block.content}
        state={state}
        onAI={onAI}
        onDelete={onDelete}
        onContentChange={onContentChange}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

async function readSse(response, onEvent) {
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
}

// ─── Entry screen ─────────────────────────────────────────────
const CanvasEntry = ({ onStart, locked, disabled = false, onOpenSettings }) => {
  const [topic, setTopic] = useState('');
  const blocked = locked || disabled;

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      background: 'var(--bg-primary)', overflow: 'auto', position: 'relative',
    }}>
      <div style={{ maxWidth: 480, margin: '16vh auto 0', padding: '0 24px', width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ display: 'inline-flex', color: 'var(--accent)', marginBottom: 16 }}>
            <Icons.sparkles size={40} />
          </div>
          <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 600, letterSpacing: -0.3, marginBottom: 8 }}>
            开始一篇新的创作
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            Notus 会参考你过往的笔记风格，生成大纲并逐段展开
          </div>
        </div>

        {/* Topic input */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
          <div style={{
            flex: 1, height: 48, padding: '0 16px',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-md)',
            display: 'flex', alignItems: 'center',
            opacity: blocked ? 0.62 : 1,
          }}>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && topic.trim() && !blocked && onStart(topic.trim())}
              placeholder="输入创作主题，如「缓存设计中的几个反直觉」"
              autoFocus
              disabled={blocked}
              style={{
                flex: 1, border: 'none', outline: 'none',
                background: 'transparent',
                fontSize: 'var(--text-base)',
                color: 'var(--text-primary)',
              }}
            />
            {topic && (
              <span style={{ width: 1.5, height: 18, background: 'var(--accent)', marginLeft: 3, animation: 'blink 1s step-end infinite', display: 'inline-block' }} />
            )}
          </div>
          <Button
            variant="primary"
            size="lg"
            icon={<Icons.sparkles size={14} />}
            disabled={!topic.trim() || blocked}
            onClick={() => topic.trim() && !blocked && onStart(topic.trim())}
          >
            生成大纲
          </Button>
        </div>

        {/* Recent items — all clickable */}
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '0 4px', marginBottom: 6 }}>
          最近创作
        </div>
        <div>
          {RECENT_ITEMS.map((r) => (
            <div
              key={r.title}
              onClick={() => !blocked && onStart(r.title)}
              style={{
                height: 40, display: 'flex', alignItems: 'center',
                padding: '0 12px', gap: 10,
                borderRadius: 'var(--radius-md)',
                cursor: blocked ? 'not-allowed' : 'pointer',
                transition: 'background var(--transition-fast)',
                opacity: blocked ? 0.55 : 1,
              }}
              onMouseEnter={(e) => { if (!blocked) e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <Icons.file size={14} color="var(--text-tertiary)" />
              <span style={{ fontSize: 'var(--text-sm)' }}>{r.title}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{r.sub}</span>
            </div>
          ))}
        </div>

        <div style={{ height: 40 }} />
        <div style={{ textAlign: 'center' }}>
          <button
            onClick={() => !blocked && onStart('')}
            style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.55 : 1 }}
          >
            或者从空白开始 →
          </button>
        </div>
      </div>
      {locked && (
        <AiLockedState
          variant="modal"
          title="创作功能尚未解锁"
          description="先完成 LLM 与 Embedding 配置后，才能生成大纲、调用 AI 改写，并继续完成整篇创作。"
          onAction={onOpenSettings}
        />
      )}
    </div>
  );
};

// ─── Main canvas ───────────────────────────────────────────────
export default function CanvasPage() {
  const router = useRouter();
  const toast = useToast();
  const { status: appStatus, loading: appStatusLoading } = useAppStatus();
  const { allFiles, activeFile, refreshFiles, selectFile, getCachedContent, setCachedContent } = useApp();
  const { configs: llmConfigs, activeConfigId, loading: llmConfigsLoading } = useLlmConfigs();
  const chatEndRef = useRef(null);
  const requestControllerRef = useRef(null);
  const canvasContentRef = useRef(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const [article, setArticle] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [conversationList, setConversationList] = useState([]);
  const [conversationListLoading, setConversationListLoading] = useState(false);
  const [, setConversationDraft] = useState(true);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [pendingOp, setPendingOp] = useState(null);
  const [styleSource, setStyleSource] = useState('auto');
  const [manualStyleFileIds, setManualStyleFileIds] = useState([]);
  const [selectedLlmConfigId, setSelectedLlmConfigId] = useState(null);
  const [aiInjected, setAiInjected] = useState('');
  const [loadingSourceFile, setLoadingSourceFile] = useState(false);
  const [saveState, setSaveState] = useState('saved');
  const [savingArticle, setSavingArticle] = useState(false);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineStatusText, setOutlineStatusText] = useState('');
  const articleFileId = Number(article?.fileId || article?.file_id) || null;
  const canvasConversationEnabled = Boolean(articleFileId);
  const conversationScopeKey = !article
    ? 'none'
    : articleFileId
      ? `file:${articleFileId}`
      : 'unsaved';

  const documentFileOptions = allFiles.map((file) => ({
    value: file.id,
    label: file.name,
    searchText: file.path,
  }));
  const styleFileOptions = documentFileOptions;
  const selectedStyleFiles = manualStyleFileIds
    .map((fileId) => allFiles.find((file) => file.id === fileId))
    .filter(Boolean);
  const mentionOptions = blocks.map((block, index) => ({
    value: block.id,
    token: `@b${index + 1}`,
    label: `第 ${index + 1} 块`,
    preview: summarizeBlockPreview(block.content),
    searchText: `${index + 1} ${block.id} ${block.content || ''}`,
  }));

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

  // Scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

  useEffect(() => () => {
    requestControllerRef.current?.abort();
  }, []);

  const handleSaveArticle = useCallback(async () => {
    if (!article) return false;
    setSavingArticle(true);
    setSaveState('saving');

    try {
      const response = await fetch('/api/articles/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article: {
            ...article,
            draft_key: article.draft_key || article.draftKey || null,
            file_id: article.file_id || article.fileId,
            blocks,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || '保存文章失败');
      }

      setArticle({
        ...(payload.article || article),
        file_id: payload.file_id,
        fileId: payload.file_id,
        draft_key: null,
        draftKey: null,
        sourcePath: payload.path,
      });
      setBlocks(payload.article?.blocks || blocks);
      await refreshFiles();
      const nextFile = allFiles.find((file) => file.id === payload.file_id) || { id: payload.file_id, path: payload.path, name: payload.title };
      if (nextFile?.id) selectFile(nextFile);
      setSaveState('saved');
      toast('文章已保存并建立索引', 'success');
      return true;
    } catch (error) {
      setSaveState('dirty');
      toast(error.message || '保存文章失败', 'error');
      return false;
    } finally {
      setSavingArticle(false);
    }
  }, [allFiles, article, blocks, refreshFiles, selectFile, toast]);

  const aiState = deriveAiReadiness({
    appStatus,
    appStatusLoading,
    llmConfigs,
    llmConfigsLoading,
  });
  const aiUiState = useStableAiReadiness(aiState);
  const aiReady = aiUiState.ready;
  const aiLockDescription = aiState.reason === 'llm'
    ? '先完成 LLM 和 Embedding 配置后，创作页 AI 才会开放。'
    : '还需要先完成 Embedding 配置后，才能生成大纲、调用 AI 改写，并继续完成整篇创作。';
  const canvasFileLabel = articleFileId ? article?.title : `${article?.title || '未命名创作'} · 未保存大纲`;
  const canvasInputDisabled = !aiReady || !canvasConversationEnabled;

  const unsavedGuard = useUnsavedChangesGuard({
    isDirty: saveState === 'dirty',
    onSave: handleSaveArticle,
    title: '离开前保存当前创作？',
    message: '当前创作还有未保存修改。你可以先保存再继续，也可以直接离开并丢弃这次编辑。',
  });
  const navigationGuard = article && saveState === 'dirty' ? unsavedGuard.request : undefined;

  const documentFind = useDocumentFind({
    enabled: Boolean(article),
    getRoot: () => canvasContentRef.current,
    selector: '[data-canvas-title="true"], [data-canvas-searchable="true"]',
    contentVersion: `${article?.fileId || article?.title || 'none'}:${blocks.map((block) => `${block.id}:${block.content}`).join('|')}`,
  });

  // Auto-save every 30s when there are unsaved changes
  useEffect(() => {
    if (saveState !== 'dirty' || savingArticle) return undefined;
    const timer = setTimeout(() => {
      handleSaveArticle();
    }, 30000);
    return () => clearTimeout(timer);
  }, [saveState, savingArticle, handleSaveArticle]);

  // Support ?fileId=X coming from editor "AI 创作" button
  useEffect(() => {
    const queryFileId = Number(getQueryValue(router.query.fileId));
    if (!Number.isFinite(queryFileId) || activeFile?.id === queryFileId) return;
    const nextFile = allFiles.find((file) => file.id === queryFileId);
    if (!nextFile) return;
    selectFile(nextFile);
  }, [activeFile?.id, allFiles, router.query.fileId, selectFile]);

  const loadSourceFileContent = useCallback(async (fileId) => {
    const cached = getCachedContent(fileId);
    if (cached !== undefined) {
      return { content: cached };
    }

    const response = await fetch(`/api/files/${fileId}`);
    const payload = await readApiResponse(response, '文章加载失败');
    setCachedContent(fileId, payload.content || '');
    return payload;
  }, [getCachedContent, setCachedContent]);

  const hydrateArticleFromPayload = useCallback((file, payload) => {
    setArticle({
      ...(payload || {}),
      title: payload?.title || file.name.replace(/\.md$/i, ''),
      file_id: payload?.file_id || file.id,
      fileId: payload?.file_id || file.id,
      draft_key: null,
      draftKey: null,
      sourcePath: file.path,
    });
    setBlocks(Array.isArray(payload?.blocks) ? payload.blocks : []);
    setActiveConversationId(null);
    setConversationDraft(true);
    setMessages([]);
    setPendingOp(null);
    setAiInjected('');
    setSaveState('saved');
    setHistoryDrawerOpen(false);
  }, []);

  const loadArticleFromFile = useCallback(async (file) => {
    if (!file?.id) return;
    setLoadingSourceFile(true);
    try {
      const response = await fetch(`/api/articles/${file.id}`);
      const payload = await readApiResponse(response, '文章加载失败');
      hydrateArticleFromPayload(file, payload);
    } catch (error) {
      try {
        const sourceFile = await loadSourceFileContent(file.id);
        hydrateArticleFromPayload(file, {
          id: `article_${file.id}`,
          file_id: file.id,
          title: file.title || file.name.replace(/\.md$/i, ''),
          blocks: buildCanvasFallbackBlocks(sourceFile.content || ''),
        });
        toast('文章结构化失败，已按原始段落打开', 'warning');
      } catch (fallbackError) {
        toast(fallbackError.message || error.message || '文章加载失败', 'error');
      }
    } finally {
      setLoadingSourceFile(false);
    }
  }, [hydrateArticleFromPayload, loadSourceFileContent, toast]);

  useEffect(() => {
    if (!activeFile?.id) return;
    if (article?.fileId === activeFile.id) return;
    loadArticleFromFile(activeFile);
  }, [activeFile?.id, article?.fileId, loadArticleFromFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStart = useCallback(async (topic) => {
    if (!aiReady) return;
    const title = topic || '未命名创作';
    setArticle({ title });
    setBlocks([]);
    setActiveConversationId(null);
    setConversationDraft(true);
    setConversationList([]);
    setMessages([]);
    setPendingOp(null);
    setSaveState('dirty');
    setHistoryDrawerOpen(false);
    if (!topic) {
      setBlocks(getInitialBlocks(topic));
      return;
    }

    try {
      setOutlineLoading(true);
      setOutlineStatusText('正在检索你的笔记并生成大纲…');
      const response = await fetch('/api/agent/outline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          active_file_id: activeFile?.id || null,
          style_mode: styleSource,
          style_file_ids: styleSource === 'manual' ? manualStyleFileIds : undefined,
        }),
      });
      if (!response.ok) throw new Error('大纲生成失败');
      const nextBlocks = [];
      await readSse(response, (event) => {
        if (event.type === 'block') {
          setOutlineStatusText('正在写入创作大纲…');
          nextBlocks.push(event.block);
          setBlocks([...nextBlocks]);
        }
        if (event.type === 'error') throw new Error(event.error);
      });
      if (nextBlocks.length === 0) setBlocks(getInitialBlocks(topic));
    } catch (error) {
      toast(error.message || '大纲生成失败', 'error');
      setBlocks(getInitialBlocks(topic));
    } finally {
      setOutlineLoading(false);
      setOutlineStatusText('');
    }
  }, [activeFile?.id, aiReady, manualStyleFileIds, styleSource, toast]);

  const fetchConversationList = useCallback(async () => {
    if (!articleFileId) return [];
    const response = await fetch(buildCanvasConversationListUrl(articleFileId, article?.draft_key || null));
    const payload = await readApiResponse(response, '读取对话列表失败');
    return Array.isArray(payload) ? payload : [];
  }, [article?.draft_key, articleFileId]);

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

  const handleConversationSelect = useCallback(async (conversationId) => {
    if (!conversationId || loading) return;
    setConversationListLoading(true);
    requestControllerRef.current?.abort();
    try {
      const payload = await fetchConversationDetail(conversationId);
      setMessages(mapConversationMessages(payload.messages, 'canvas'));
      setActiveConversationId(Number(conversationId));
      setConversationDraft(false);
      setPendingOp(null);
      setStreamText('');
      setLoading(false);
      setHistoryDrawerOpen(false);
    } catch (loadError) {
      toast(loadError.message || '读取对话详情失败', 'error');
    } finally {
      setConversationListLoading(false);
    }
  }, [fetchConversationDetail, loading, toast]);

  const handleNewConversation = useCallback(() => {
    if (!articleFileId) return;
    requestControllerRef.current?.abort();
    setActiveConversationId(null);
    setConversationDraft(true);
    setMessages([]);
    setPendingOp(null);
    setAiInjected('');
    setStreamText('');
    setLoading(false);
    setHistoryDrawerOpen(false);
  }, [articleFileId]);

  useEffect(() => {
    if (!article || !articleFileId) {
      setConversationList([]);
      setActiveConversationId(null);
      setConversationDraft(true);
      setMessages([]);
      setPendingOp(null);
      setStreamText('');
      setLoading(false);
      setConversationListLoading(false);
      return;
    }

    let cancelled = false;
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
        setMessages(mapConversationMessages(payload.messages, 'canvas'));
        setPendingOp(null);
        setStreamText('');
        setLoading(false);
      } catch (loadError) {
        if (cancelled) return;
        setConversationList([]);
        setActiveConversationId(null);
        setConversationDraft(true);
        setMessages([]);
        setPendingOp(null);
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
  }, [article, articleFileId, conversationScopeKey, fetchConversationDetail, fetchConversationList, toast]);

  const handleSend = useCallback(async (query, llmConfigId = selectedLlmConfigId) => {
    if (!articleFileId) {
      toast('先保存当前大纲为文档，再继续 AI 改写和历史对话', 'info');
      return;
    }

    if (!llmConfigId) {
      toast('请先在模型配置中新增并测试至少一个 LLM 配置', 'warning');
      return;
    }

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    setAiInjected('');
    setMessages((prev) => [...prev, { id: Date.now(), role: 'user', content: query }]);

    try {
      let assistantText = '';
      let receivedOperation = false;
      let resolvedConversationId = activeConversationId;
      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          conversation_id: activeConversationId || undefined,
          user_input: query,
          llm_config_id: llmConfigId,
          active_file_id: activeFile?.id || null,
          article: { ...article, blocks },
          style_mode: styleSource,
          style_file_ids: styleSource === 'manual' ? manualStyleFileIds : undefined,
        }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || 'AI 请求失败');
      }

      await readSse(response, (event) => {
        if (event.conversation_id) {
          resolvedConversationId = Number(event.conversation_id);
        }
        if (event.type === 'thinking') {
          assistantText = event.text || '正在处理…';
          setStreamText(assistantText);
        } else if (event.type === 'tool_call') {
          assistantText = `正在调用工具：${event.name}`;
          setStreamText(assistantText);
        } else if (event.type === 'tool_result') {
          assistantText = '工具执行完成，正在生成修改…';
          setStreamText(assistantText);
        } else if (event.type === 'operation') {
          receivedOperation = true;
          const operation = event.operation || event.op;
          const targetIndex = blocks.findIndex((block) => block.id === operation.block_id);
          const targetBlock = targetIndex >= 0 ? blocks[targetIndex] : null;
          const pending = {
            blockIdx: targetIndex >= 0 ? targetIndex + 1 : blocks.length + 1,
            oldContent: operation.old || targetBlock?.content || '',
            newContent: operation.new || '',
            operation,
          };
          setPendingOp(pending);
          setMessages((prev) => [
            ...prev,
            { id: Date.now(), role: 'assistant', content: '已生成可应用的修改。', operation: pending },
          ]);
        } else if (event.type === 'done') {
          if (!receivedOperation) {
            setMessages((prev) => [
              ...prev,
              { id: event.message_id || Date.now(), role: 'assistant', content: assistantText || '处理完成。' },
            ]);
          }
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
    } catch (error) {
      if (error.name !== 'AbortError') {
        if (error.conversationId) {
          setActiveConversationId(Number(error.conversationId));
          setConversationDraft(false);
          refreshConversationListOnly(Number(error.conversationId));
        }
        toast(error.message || 'AI 请求失败', 'error');
      }
      setStreamText('');
      setLoading(false);
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  }, [activeConversationId, activeFile?.id, article, articleFileId, blocks, manualStyleFileIds, refreshConversationListOnly, selectedLlmConfigId, styleSource, toast]);

  // Canvas block AI button → populate InputBar
  const handleBlockAI = useCallback((blockId) => {
    const idx = blocks.findIndex((b) => b.id === blockId) + 1;
    setAiInjected(`@b${idx} 请只改写这一块，保持其他块不变。`);
  }, [blocks]);

  // Inline edit save
  const handleContentChange = useCallback((blockId, newContent) => {
    setBlocks((prev) => prev.map((b) => b.id === blockId ? { ...b, content: newContent } : b));
    setSaveState('dirty');
  }, []);

  const handleDeleteBlock = useCallback((blockId) => {
    const deletedIndex = blocks.findIndex((block) => block.id === blockId);
    setBlocks((prev) => prev.filter((block) => block.id !== blockId));
    setPendingOp((prev) => (
      !prev
        ? null
        : prev?.operation?.block_id === blockId || prev.blockIdx === deletedIndex + 1
          ? null
          : prev.blockIdx > deletedIndex + 1
            ? { ...prev, blockIdx: prev.blockIdx - 1 }
            : prev
    ));
    setSaveState('dirty');
  }, [blocks]);

  // Add new empty block
  const handleAddBlock = useCallback(() => {
    const newId = `b_${Date.now()}`;
    setBlocks((prev) => [...prev, { id: newId, type: 'paragraph', content: '' }]);
    setSaveState('dirty');
  }, []);

  const handleApplyOp = useCallback(async (op) => {
    if (!op?.operation) {
      setBlocks((prev) =>
        prev.map((b, i) => i === op.blockIdx - 1 ? { ...b, content: op.newContent } : b)
      );
      setPendingOp(null);
      setSaveState('dirty');
      return;
    }

    try {
      const response = await fetch('/api/agent/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article: { ...article, blocks },
          operation: op.operation,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || '应用修改失败');
      }
      const nextArticle = payload.article
        ? {
          ...payload.article,
          file_id: payload.article.file_id || article?.file_id || article?.fileId,
          fileId: payload.article.file_id || article?.file_id || article?.fileId,
          sourcePath: article?.sourcePath,
        }
        : article;
      setArticle(nextArticle);
      setBlocks(payload.article?.blocks || blocks);
      setPendingOp(null);
      setSaveState('dirty');
      toast('修改已应用', 'success');
    } catch (error) {
      toast(error.message || '应用修改失败', 'error');
    }
  }, [article, blocks, toast]);

  const handleCancelOp = useCallback(() => setPendingOp(null), []);

  const handleDragEnd = useCallback(({ active, over }) => {
    if (!over || active.id === over.id) return;
    setBlocks((prev) => {
      const oldIndex = prev.findIndex((block) => block.id === active.id);
      const newIndex = prev.findIndex((block) => block.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
    setSaveState('dirty');
  }, []);

  // ── Entry screen ──
  if (!article) {
    return (
      <Shell active="canvas" tocDisabled requestAction={navigationGuard} navigateOnFileSelect={false}>
        <CanvasEntry
          onStart={handleStart}
          locked={aiUiState.showLockedState}
          disabled={!aiReady}
          onOpenSettings={() => navigateWithFallback(router, '/settings/model')}
        />
        {unsavedGuard.dialog}
      </Shell>
    );
  }

  // ── Canvas editor ──
  return (
    <Shell
      active="canvas"
      fileName={canvasFileLabel}
      saveState={saveState}
      onSave={handleSaveArticle}
      saveDisabled={saveState !== 'dirty'}
      tocDisabled
      requestAction={navigationGuard}
      navigateOnFileSelect={false}
    >
      <div style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }}>
        <ResizableLayout
          initialLeftPercent={62}
          minLeftPercent={30}
          maxLeftPercent={80}
          left={
        <div style={{ overflow: 'auto', background: 'var(--bg-primary)', height: '100%', position: 'relative', minHeight: 0 }} ref={canvasContentRef}>
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
          <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 32px 80px' }}>
            {/* Title bar */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
              <h1 style={{
                fontFamily: 'var(--font-editor)',
                fontSize: 'var(--text-3xl)',
                fontWeight: 700,
                margin: 0,
                flex: 1,
              }} data-canvas-title="true">
                {article.title}
              </h1>
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 28 }}>
              {loadingSourceFile ? '正在载入文章内容…' : `${saveState === 'saving' ? '正在保存' : saveState === 'dirty' ? '尚未保存' : '已保存'} · ${blocks.length} 个块`}
            </div>

            {/* Blocks */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={blocks.map((block) => block.id)} strategy={verticalListSortingStrategy}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {blocks.map((block, i) => (
                    <SortableCanvasItem
                      key={block.id}
                      block={block}
                      index={i}
                      state={pendingOp?.blockIdx === i + 1 ? 'modified' : 'default'}
                      onAI={handleBlockAI}
                      onDelete={handleDeleteBlock}
                      onContentChange={handleContentChange}
                    />
                  ))}
                  <AddBlockButton onClick={handleAddBlock} />
                </div>
              </SortableContext>
            </DndContext>
          </div>
        </div>
        }
        right={
        <div style={{
          borderLeft: '1px solid var(--border-primary)',
          background: 'var(--bg-primary)',
          display: 'flex', flexDirection: 'column',
          height: '100%',
          minHeight: 0,
          minWidth: 0,
          position: 'relative',
        }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Tooltip content="查看历史对话">
                <span style={{ display: 'inline-flex' }}>
                  <IconButton
                    label="查看历史对话"
                    active={historyDrawerOpen}
                    disabled={!canvasConversationEnabled || loading || conversationListLoading}
                    onClick={() => setHistoryDrawerOpen(true)}
                  >
                    {conversationListLoading ? <Spinner size={14} /> : <Icons.list size={15} />}
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip content="新建对话">
                <span style={{ display: 'inline-flex' }}>
                  <IconButton
                    label="新建对话"
                    disabled={!canvasConversationEnabled || loading}
                    onClick={handleNewConversation}
                  >
                    <Icons.plus size={15} />
                  </IconButton>
                </span>
              </Tooltip>
            </div>

            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6 }}>风格来源</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {[
                  { value: 'auto', label: '自动匹配' },
                  { value: 'manual', label: '手动指定' },
                ].map((mode) => (
                  <button
                    key={mode.value}
                    onClick={() => setStyleSource(mode.value)}
                    style={{
                      height: 28,
                      padding: '0 12px',
                      background: styleSource === mode.value ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                      border: `1px solid ${styleSource === mode.value ? 'var(--accent)' : 'var(--border-primary)'}`,
                      borderRadius: 'var(--radius-md)',
                      fontSize: 11,
                      color: styleSource === mode.value ? 'var(--accent)' : 'var(--text-secondary)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      transition: 'all var(--transition-fast)',
                    }}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            {styleSource === 'manual' && (
              <>
                <DropdownSelect
                  value=""
                  options={styleFileOptions}
                  onChange={(nextValue) => {
                    if (!nextValue) return;
                    setManualStyleFileIds((prev) => (
                      prev.includes(nextValue)
                        ? prev.filter((fileId) => fileId !== nextValue)
                        : [...prev, nextValue]
                    ));
                  }}
                  isOptionSelected={(option) => manualStyleFileIds.includes(option.value)}
                  closeOnSelect={false}
                  renderValue={() => (manualStyleFileIds.length > 0 ? `已选 ${manualStyleFileIds.length} 篇风格文章` : '添加风格参考文章')}
                  renderOption={(option, active) => `${option.label}${active ? ' · 已选' : ''}`}
                  searchable
                  placeholder="添加风格参考文章"
                  searchPlaceholder="按标题或路径搜索文章"
                  emptyText="没有可选文章"
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {selectedStyleFiles.length > 0 ? selectedStyleFiles.map((file) => (
                    <button
                      key={file.id}
                      type="button"
                      onClick={() => setManualStyleFileIds((prev) => prev.filter((fileId) => fileId !== file.id))}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                      <Badge tone="accent">{file.name} ×</Badge>
                    </button>
                  )) : (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                      选择 1 篇或多篇文章，AI 会优先参考这些内容的表达方式。
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '8px 16px', minHeight: 0 }}>
            {!canvasConversationEnabled && (
              <div style={{ padding: '32px 0', display: 'flex', justifyContent: 'center' }}>
                <div style={{
                  maxWidth: 420,
                  padding: '18px 20px',
                  borderRadius: 'var(--radius-lg)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-primary)',
                  boxShadow: 'var(--shadow-sm)',
                  display: 'grid',
                  gap: 10,
                }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                    当前是未保存的大纲草稿
                  </div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                    先保存为正式文档，再继续 AI 改写、查看历史对话，并把后续创作会话稳定绑定到这篇文章。
                  </div>
                  <div>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => { void handleSaveArticle(); }}
                      disabled={saveState !== 'dirty' || savingArticle}
                    >
                      {savingArticle ? '正在保存…' : '保存后继续'}
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {canvasConversationEnabled && messages.length === 0 && !loading && (
              <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>
                <div style={{ marginTop: 8 }}>向 AI 发送指令，如：<br />「让 @b2 更简洁」或「为第 3 段加上例子」</div>
              </div>
            )}
            {messages.map((msg) => (
              msg.role === 'user'
                ? <UserBubble key={msg.id}>{msg.content}</UserBubble>
                : (
                  <AiBubble key={msg.id} text={msg.content}>
                    {msg.operation && (
                      <OperationPreview
                        blockIdx={msg.operation.blockIdx}
                        oldContent={msg.operation.oldContent}
                        newContent={msg.operation.newContent}
                        onApply={() => handleApplyOp(msg.operation)}
                        onCancel={handleCancelOp}
                      />
                    )}
                  </AiBubble>
                )
            ))}
            {loading && streamText && <AiBubble text={streamText} streaming />}
            <div ref={chatEndRef} />
          </div>

          <InputBar
            isEmpty={canvasConversationEnabled && messages.length === 0 && !loading}
            placeholder={canvasConversationEnabled ? '例如：让 @b2 更简洁，或为第 3 段加一个例子…' : '先保存当前大纲为文档，再继续 AI 改写…'}
            onSend={handleSend}
            onStop={() => requestControllerRef.current?.abort()}
            loading={loading}
            injectedValue={aiInjected}
            llmConfigs={llmConfigs}
            selectedConfigId={selectedLlmConfigId}
            onConfigChange={setSelectedLlmConfigId}
            disabled={canvasInputDisabled}
            showPlusMenu={false}
            mentionOptions={mentionOptions}
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
        </div>
        }
        />
        {outlineLoading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--bg-overlay, rgba(247, 244, 238, 0.82))',
              backdropFilter: 'blur(6px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 8,
            }}
          >
            <div
              style={{
                minWidth: 280,
                padding: '24px 28px',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-primary)',
                boxShadow: 'var(--shadow-lg)',
                display: 'grid',
                justifyItems: 'center',
                gap: 12,
                textAlign: 'center',
              }}
            >
              <Spinner size={28} />
              <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-primary)' }}>
                AI 正在生成大纲
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {outlineStatusText || '正在组织结构，请稍候…'}
              </div>
            </div>
          </div>
        )}
        {aiUiState.showLockedState && (
          <AiLockedState
            variant="modal"
            title="创作功能尚未解锁"
            description={aiLockDescription}
            onAction={() => navigateWithFallback(router, '/settings/model')}
          />
        )}
      </div>
      {unsavedGuard.dialog}
    </Shell>
  );
}
