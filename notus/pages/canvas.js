// /canvas — AI creation canvas page
import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useRouter } from 'next/router';
import { Shell } from '../components/Layout/Shell';
import { CanvasBlock, AddBlockButton } from '../components/Canvas/CanvasBlock';
import { UserBubble, AiBubble } from '../components/ChatArea/ChatMessage';
import { ClarifyDrawer } from '../components/ChatArea/ClarifyDrawer';
import { ConversationDrawer } from '../components/ChatArea/ConversationDrawer';
import { InputBar } from '../components/ChatArea/InputBar';
import { BatchOperationCard } from '../components/AIPanel/BatchOperationCard';
import { AgentWorkspace } from '../components/AgentWorkspace/AgentWorkspace';
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
import { useAgentLoopController } from '../hooks/useAgentLoopController';
import { useStableAiReadiness } from '../hooks/useStableAiReadiness';
import { useDocumentFind } from '../hooks/useDocumentFind';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard';
import { shouldKeepCanvasRoutePending, shouldSyncCanvasQueryFile } from '../lib/canvasRouting';
import { getVisibleDocumentLabel } from '../lib/documentLabels';
import { splitEditorVisibleMarkdown } from '../lib/markdownMeta';
import { deriveAiReadiness } from '../utils/aiReadiness';
import { mapConversationMessages } from '../utils/conversations';
import {
  buildConversationExportFileName,
  downloadTextFile,
  formatConversationExportMarkdown,
} from '../utils/conversationExport';
import { readApiResponse } from '../utils/http';
import { getAgentAuthorizedDirectory } from '../utils/agentPaths';
import { navigateWithFallback } from '../utils/navigation';
import {
  readViewPosition,
  retryRestoreViewPosition,
  restoreCanvasViewPosition,
  writeCanvasViewPosition,
} from '../utils/viewPosition';

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

const CANVAS_LAYOUT_STORAGE_KEY = 'notus-layout-canvas-left-percent';
const CANVAS_AGENT_CONFIRM_MODE_STORAGE_KEY = 'notus-canvas-agent-confirm-mode';
const CANVAS_AGENT_CONFIRM_AUTO_CONFIRM = 'auto_confirm';
const CANVAS_AGENT_CONFIRM_MANUAL_CONFIRM = 'manual_confirm';
const CANVAS_LAYOUT_DEFAULT = 62;
const CANVAS_LAYOUT_MIN = 48;
const CANVAS_LAYOUT_MAX = 64;
const CANVAS_EDITOR_MIN_WIDTH = 660;
const CANVAS_CHAT_MIN_WIDTH = 456;
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function getInitialBlocks(topic) {
  return MOCK_BLOCKS_BY_TOPIC[topic] || MOCK_BLOCKS_BY_TOPIC.default;
}

function clampCanvasLayoutPercent(value) {
  const parsed = Number.parseFloat(value);
  const base = Number.isFinite(parsed) ? parsed : CANVAS_LAYOUT_DEFAULT;
  return Math.min(Math.max(base, CANVAS_LAYOUT_MIN), CANVAS_LAYOUT_MAX);
}

function readCanvasLayoutCache() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CANVAS_LAYOUT_STORAGE_KEY);
    if (raw === null) return null;
    return clampCanvasLayoutPercent(raw);
  } catch {
    return null;
  }
}

function writeCanvasLayoutCache(value) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      CANVAS_LAYOUT_STORAGE_KEY,
      String(clampCanvasLayoutPercent(value))
    );
  } catch {}
}

function normalizeCanvasAgentConfirmMode(value) {
  if (value === 'manual' || value === CANVAS_AGENT_CONFIRM_MANUAL_CONFIRM) return CANVAS_AGENT_CONFIRM_MANUAL_CONFIRM;
  return CANVAS_AGENT_CONFIRM_AUTO_CONFIRM;
}

function readCanvasAgentConfirmMode() {
  if (typeof window === 'undefined') return CANVAS_AGENT_CONFIRM_AUTO_CONFIRM;
  try {
    return normalizeCanvasAgentConfirmMode(window.localStorage.getItem(CANVAS_AGENT_CONFIRM_MODE_STORAGE_KEY));
  } catch {
    return CANVAS_AGENT_CONFIRM_AUTO_CONFIRM;
  }
}

function writeCanvasAgentConfirmMode(value) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CANVAS_AGENT_CONFIRM_MODE_STORAGE_KEY, normalizeCanvasAgentConfirmMode(value));
  } catch {}
}

function getQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function getCanvasRouteFileId(router) {
  const fromQuery = Number(getQueryValue(router?.query?.fileId));
  if (Number.isFinite(fromQuery) && fromQuery > 0) return fromQuery;
  const asPath = typeof router?.asPath === 'string' ? router.asPath : '';
  const queryText = asPath.includes('?') ? asPath.split('?')[1].split('#')[0] : '';
  if (!queryText) return null;
  const fromPath = Number(new URLSearchParams(queryText).get('fileId'));
  return Number.isFinite(fromPath) && fromPath > 0 ? fromPath : null;
}

function summarizeBlockPreview(content = '') {
  return String(content || '').replace(/\s+/g, ' ').trim().slice(0, 48) || '空白块';
}

function formatCanvasBlocksForAgent(blocks = []) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (list.length === 0) return '';
  return [
    '当前创作页文本块快照（用户可用 @b1、@b2 指定块；如需按块改写，优先调用 preview_canvas_blocks）：',
    ...list.map((block, index) => {
      const content = String(block?.content || '').replace(/\r\n/g, '\n');
      const clipped = content.length > 1800 ? `${content.slice(0, 1800)}\n...[已截断]` : content;
      return `@b${index + 1} (${block?.type || 'paragraph'}, block_id=${block?.id || ''})\n${clipped}`;
    }),
  ].join('\n\n');
}

function buildCanvasConversationListUrl() {
  const params = new URLSearchParams({ kind: 'canvas', limit: '20' });
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

function buildCanvasFileHref(fileId) {
  return `/canvas?fileId=${encodeURIComponent(fileId)}`;
}

function flattenFileTree(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).flatMap((node) => (
    node?.type === 'folder'
      ? [node, ...flattenFileTree(node.children || [])]
      : [node]
  ));
}

async function computeClientArticleHash(article) {
  if (typeof window === 'undefined' || !window.crypto?.subtle || typeof window.TextEncoder === 'undefined') {
    return '';
  }
  const payload = JSON.stringify({
    title: article?.title || '',
    file_id: article?.file_id || article?.fileId || null,
    blocks: Array.isArray(article?.blocks)
      ? article.blocks.map((block) => ({
        id: block.id,
        type: block.type,
        content: block.content || '',
      }))
      : [],
  });
  const digest = await window.crypto.subtle.digest('SHA-256', new window.TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function upsertOperationSet(list = [], operationSet = null) {
  if (!operationSet?.id) return list;
  const next = Array.isArray(list) ? [...list] : [];
  const index = next.findIndex((item) => Number(item.id) === Number(operationSet.id));
  if (index >= 0) next[index] = operationSet;
  else next.push(operationSet);
  return next.sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
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

function mapSingleConversationMessage(message, kind = 'canvas') {
  return mapConversationMessages([message], kind)[0] || null;
}

const DECISION_CORRECTION_ACTIONS = {
  continue_discussion: {
    label: '继续讨论',
    prompt: '继续讨论，不要直接改文档。',
    correctionState: {
      wrong_intent: 'edit',
      preferred_primary_intent: 'text',
    },
  },
  direct_edit: {
    label: '直接改文档',
    prompt: '直接改文档，继续生成预览。',
    correctionState: {
      wrong_intent: 'text',
      preferred_primary_intent: 'edit',
    },
  },
  wrong_target: {
    label: '目标不对',
    prompt: '目标不对，请重新确认要修改的段落。',
    correctionState: {
      wrong_target: true,
    },
  },
  wrong_source: {
    label: '来源不对',
    prompt: '来源不对，不要用刚才识别的那段内容。',
    correctionState: {
      wrong_source: true,
    },
  },
  wrong_write_action: {
    label: '写入方式不对',
    prompt: '写入方式不对，请重新确认是追加、替换还是写到前面。',
    correctionState: {
      wrong_write_action: true,
    },
  },
};

function DecisionSummaryCard({ summary = '' }) {
  if (!summary) return null;
  return (
    <div style={{
      marginTop: 12,
      padding: '10px 12px',
      borderRadius: 12,
      border: '1px solid color-mix(in srgb, var(--accent) 18%, var(--border-primary))',
      background: 'color-mix(in srgb, var(--accent-subtle) 62%, var(--bg-primary))',
      display: 'grid',
      gap: 4,
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>当前理解</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', lineHeight: 1.7 }}>
        {summary}
      </div>
    </div>
  );
}

function CorrectionChipBar({ onSelect, disabled = false }) {
  return (
    <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>如果这次理解不对，可以直接纠正</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {Object.entries(DECISION_CORRECTION_ACTIONS).map(([id, item]) => (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect?.(id)}
            style={{
              minHeight: 32,
              padding: '0 12px',
              borderRadius: 999,
              border: '1px solid var(--border-primary)',
              background: disabled ? 'var(--bg-muted)' : 'var(--bg-primary)',
              color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
              fontSize: 12,
              cursor: disabled ? 'not-allowed' : 'pointer',
              transition: 'background var(--transition-fast), border-color var(--transition-fast), transform var(--transition-fast)',
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SortableCanvasItem({ block, index, state, onAI, onDelete, onContentChange }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id });
  const style = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.7 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} data-canvas-block-id={block.id}>
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

const CanvasRouteLoading = ({ missing = false, onBack }) => (
  <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(360px, 38%)', background: 'var(--bg-primary)', minHeight: 0 }}>
    <div style={{ minHeight: 0, overflow: 'hidden', borderRight: '1px solid var(--border-primary)', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 32px 80px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <div style={{ width: 32, height: 32, borderRadius: 10, background: 'var(--accent-subtle)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            {missing ? <Icons.warn size={16} /> : <Spinner size={16} />}
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--text-primary)' }}>
              {missing ? '未找到要打开的文档' : '正在打开文档…'}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 4 }}>
              {missing ? '请从左侧文件列表重新选择一篇文章进入创作页。' : '正在加载文章结构和对话上下文。'}
            </div>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 14 }}>
          {[0, 1, 2, 3, 4].map((item) => (
            <div key={item} style={{ display: 'grid', gap: 8 }}>
              <div style={{ width: item === 0 ? '52%' : `${72 - item * 7}%`, height: item === 0 ? 26 : 16, borderRadius: 8, background: 'var(--bg-muted)' }} />
              <div style={{ width: `${94 - item * 8}%`, height: 12, borderRadius: 999, background: 'var(--bg-hover)' }} />
            </div>
          ))}
        </div>
        {missing ? (
          <Button variant="ghost" onClick={onBack} style={{ marginTop: 28 }}>
            返回创作首页
          </Button>
        ) : null}
      </div>
    </div>
    <div style={{ minHeight: 0, background: 'var(--bg-secondary)', display: 'grid', gridTemplateRows: '1fr auto' }}>
      <div style={{ padding: 24, display: 'grid', alignContent: 'end', gap: 12 }}>
        <div style={{ width: '70%', height: 12, borderRadius: 999, background: 'var(--bg-hover)' }} />
        <div style={{ width: '44%', height: 12, borderRadius: 999, background: 'var(--bg-hover)' }} />
      </div>
      <div style={{ padding: '0 16px 24px' }}>
        <div style={{ height: 104, borderRadius: 22, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }} />
      </div>
    </div>
  </div>
);

// ─── Main canvas ───────────────────────────────────────────────
export default function CanvasPage() {
  const router = useRouter();
  const toast = useToast();
  const { status: appStatus, loading: appStatusLoading } = useAppStatus();
  const { allFiles, activeFile, refreshFiles, selectFile, getCachedContent, setCachedContent, clearCachedContent, loadingFiles } = useApp();
  const { configs: llmConfigs, activeConfigId, loading: llmConfigsLoading } = useLlmConfigs();
  const chatEndRef = useRef(null);
  const requestControllerRef = useRef(null);
  const canvasContentRef = useRef(null);
  const inputTextareaRef = useRef(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const [article, setArticle] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [activeSteps] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [conversationList, setConversationList] = useState([]);
  const [conversationListLoading, setConversationListLoading] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState(null);
  const [exportingConversationId, setExportingConversationId] = useState(null);
  const [, setConversationDraft] = useState(true);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [pendingOperationSets, setPendingOperationSets] = useState([]);
  const [pendingInteractions, setPendingInteractions] = useState([]);
  const [interactionSubmittingId, setInteractionSubmittingId] = useState(null);
  const [clarifyDrawerPhase, setClarifyDrawerPhase] = useState('expanded-question');
  const [styleSource, setStyleSource] = useState('auto');
  const [manualStyleFileIds, setManualStyleFileIds] = useState([]);
  const [selectedLlmConfigId, setSelectedLlmConfigId] = useState(null);
  const [aiInjected, setAiInjected] = useState('');
  const [loadingSourceFile, setLoadingSourceFile] = useState(false);
  const [saveState, setSaveState] = useState('saved');
  const [savingArticle, setSavingArticle] = useState(false);
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineStatusText, setOutlineStatusText] = useState('');
  const [canvasLayoutLeftPercent, setCanvasLayoutLeftPercent] = useState(CANVAS_LAYOUT_DEFAULT);
  const [agentConfirmMode, setAgentConfirmModeState] = useState(() => readCanvasAgentConfirmMode());
  const layoutChangeCountRef = useRef(0);
  const persistedLayoutLeftPercentRef = useRef(null);
  const dirtyStateRef = useRef(false);
  const pendingRouteFileIdRef = useRef(null);
  const hiddenArticleFrontmatterRef = useRef('');
  const restoreCanvasPositionRef = useRef(false);
  const saveCanvasPositionTimerRef = useRef(null);
  const pageAliveRef = useRef(true);
  const activeConversationIdRef = useRef(null);
  const agentLoopControlRef = useRef({ loading: false, stopAgentLoop: null });
  const clearAgentLoopSessionRef = useRef(null);
  const articleFileId = Number(article?.fileId || article?.file_id) || null;
  const routeFileId = router.isReady ? getCanvasRouteFileId(router) : null;
  const routeTargetFile = routeFileId ? allFiles.find((file) => Number(file.id) === Number(routeFileId)) : null;
  const routeFileMissing = Boolean(routeFileId && router.isReady && !loadingFiles && !routeTargetFile && !articleFileId);
  const canvasConversationEnabled = Boolean(articleFileId);
  const documentFileOptions = allFiles.map((file) => ({
    value: file.id,
    label: getVisibleDocumentLabel(file, '未命名文档'),
    searchText: `${file.title || ''} ${file.name || ''} ${file.path || ''}`,
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

  useIsomorphicLayoutEffect(() => {
    const cached = readCanvasLayoutCache();
    if (cached === null) return;
    setCanvasLayoutLeftPercent(cached);
  }, []);

  useEffect(() => {
    setAgentConfirmModeState(readCanvasAgentConfirmMode());
  }, []);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  const setAgentConfirmMode = useCallback((value) => {
    const normalized = normalizeCanvasAgentConfirmMode(value);
    setAgentConfirmModeState(normalized);
    writeCanvasAgentConfirmMode(normalized);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const baselineChangeCount = layoutChangeCountRef.current;

    fetch('/api/settings', { cache: 'no-store' })
      .then((response) => readApiResponse(response, '读取布局设置失败'))
      .then((settings) => {
        if (cancelled) return;
        if (layoutChangeCountRef.current !== baselineChangeCount) return;
        const savedPercent = settings?.layout?.canvas_left_percent;
        if (savedPercent === undefined || savedPercent === null) return;
        const normalized = clampCanvasLayoutPercent(savedPercent);
        persistedLayoutLeftPercentRef.current = normalized;
        writeCanvasLayoutCache(normalized);
        setCanvasLayoutLeftPercent(normalized);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCanvasLayoutChange = useCallback((nextPercent) => {
    layoutChangeCountRef.current += 1;
    setCanvasLayoutLeftPercent(clampCanvasLayoutPercent(nextPercent));
  }, []);

  const handleCanvasLayoutCommit = useCallback(async (nextPercent) => {
    const normalized = clampCanvasLayoutPercent(nextPercent);
    writeCanvasLayoutCache(normalized);
    setCanvasLayoutLeftPercent(normalized);

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
            canvas_left_percent: normalized,
          },
        }),
        keepalive: true,
      });
      const payload = await readApiResponse(response, '创作页分栏宽度保存失败');
      const confirmedPercent = payload?.layout?.canvas_left_percent;
      const confirmed = confirmedPercent === undefined || confirmedPercent === null
        ? normalized
        : clampCanvasLayoutPercent(confirmedPercent);
      persistedLayoutLeftPercentRef.current = confirmed;
      writeCanvasLayoutCache(confirmed);
      setCanvasLayoutLeftPercent(confirmed);
    } catch (error) {
      toast(error.message || '创作页分栏宽度保存失败', 'danger');
    }
  }, [toast]);

  useEffect(() => () => {
    requestControllerRef.current?.abort();
  }, []);

  const handleSaveArticle = useCallback(async (overrideBlocks = null) => {
    if (!article) return false;
    const effectiveBlocks = Array.isArray(overrideBlocks) ? overrideBlocks : blocks;
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
            hidden_frontmatter: hiddenArticleFrontmatterRef.current,
            blocks: effectiveBlocks,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || '保存文章失败');
      }

      setArticle({
        ...(payload.article || article),
        title: getVisibleDocumentLabel(payload.article || article, '未命名创作'),
        file_id: payload.file_id,
        fileId: payload.file_id,
        draft_key: null,
        draftKey: null,
        sourcePath: payload.path,
      });
      hiddenArticleFrontmatterRef.current = payload.article?.hidden_frontmatter || hiddenArticleFrontmatterRef.current || '';
      setBlocks(payload.article?.blocks || effectiveBlocks);
      await refreshFiles();
      const nextFile = allFiles.find((file) => file.id === payload.file_id) || { id: payload.file_id, path: payload.path, name: payload.title };
      if (nextFile?.id) selectFile(nextFile);
      if (payload.file_id) {
        pendingRouteFileIdRef.current = payload.file_id;
        router.replace(buildCanvasFileHref(payload.file_id), undefined, { shallow: true })
          .then(() => {
            pendingRouteFileIdRef.current = null;
          })
          .catch(() => {
            pendingRouteFileIdRef.current = null;
          });
      }
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
  }, [allFiles, article, blocks, refreshFiles, router, selectFile, toast]);

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
  const articleTitleLabel = getVisibleDocumentLabel(article, '未命名创作');
  const canvasFileLabel = articleFileId ? articleTitleLabel : `${articleTitleLabel} · 未保存大纲`;
  const rawClarifyInteraction = loading
    ? null
    : ([...pendingInteractions].reverse().find((item) => item.status === 'pending')
      || [...pendingInteractions].reverse().find((item) => item.status === 'failed')
      || [...pendingInteractions].reverse().find((item) => item.status === 'stale')
      || null);
  const canvasInputDisabled = !aiReady
    || !canvasConversationEnabled
    || (Boolean(rawClarifyInteraction) && clarifyDrawerPhase !== 'collapsed');

  const unsavedGuard = useUnsavedChangesGuard({
    isDirty: saveState === 'dirty',
    onSave: handleSaveArticle,
    title: '离开前保存当前创作？',
    message: '当前创作还有未保存修改。你可以先保存再继续，也可以直接离开并丢弃这次编辑。',
  });
  const navigationGuard = article && saveState === 'dirty' ? unsavedGuard.request : undefined;

  useEffect(() => {
    dirtyStateRef.current = saveState === 'dirty';
  }, [saveState]);

  useEffect(() => {
    setClarifyDrawerPhase('expanded-question');
  }, [rawClarifyInteraction?.id]);

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
    if (!router.isReady) return;
    if (!shouldSyncCanvasQueryFile({
      requestedFileId: routeFileId,
      activeFileId: activeFile?.id,
      articleFileId,
      pendingRouteFileId: pendingRouteFileIdRef.current,
    })) {
      if (
        pendingRouteFileIdRef.current
        && Number(pendingRouteFileIdRef.current) === Number(routeFileId)
        && !shouldKeepCanvasRoutePending({
          pendingRouteFileId: pendingRouteFileIdRef.current,
          articleFileId,
        })
      ) {
        pendingRouteFileIdRef.current = null;
      }
      return;
    }
    const nextFile = allFiles.find((file) => Number(file.id) === Number(routeFileId));
    if (!nextFile) return;
    selectFile(nextFile);
  }, [activeFile?.id, allFiles, articleFileId, routeFileId, router.isReady, selectFile]);

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
      title: getVisibleDocumentLabel(payload || file, '未命名创作'),
      file_id: payload?.file_id || file.id,
      fileId: payload?.file_id || file.id,
      draft_key: null,
      draftKey: null,
      sourcePath: file.path,
    });
    hiddenArticleFrontmatterRef.current = payload?.hidden_frontmatter || payload?.hiddenFrontmatter || '';
    setBlocks(Array.isArray(payload?.blocks) ? payload.blocks : []);
    restoreCanvasPositionRef.current = true;
    setActiveConversationId(null);
    setConversationDraft(true);
    setMessages([]);
    setPendingOperationSets([]);
    setPendingInteractions([]);
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
        const { visibleContent, hiddenFrontmatter } = splitEditorVisibleMarkdown(sourceFile.content || '');
        hydrateArticleFromPayload(file, {
          id: `article_${file.id}`,
          file_id: file.id,
          title: getVisibleDocumentLabel(file, '未命名创作'),
          hidden_frontmatter: hiddenFrontmatter || '',
          blocks: buildCanvasFallbackBlocks(visibleContent || ''),
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

  useEffect(() => {
    if (!router.isReady) return;
    if (!articleFileId) return;
    if (shouldKeepCanvasRoutePending({
      pendingRouteFileId: pendingRouteFileIdRef.current,
      articleFileId,
    })) {
      return;
    }
    if (pendingRouteFileIdRef.current && Number(pendingRouteFileIdRef.current) === Number(articleFileId)) {
      pendingRouteFileIdRef.current = null;
    }
    const expectedHref = articleFileId ? buildCanvasFileHref(articleFileId) : '/canvas';
    if (router.asPath === expectedHref) return;
    pendingRouteFileIdRef.current = articleFileId;
    router.replace(expectedHref, undefined, { shallow: true })
      .then(() => {
        pendingRouteFileIdRef.current = null;
      })
      .catch(() => {
        pendingRouteFileIdRef.current = null;
      });
  }, [articleFileId, router, router.asPath, router.isReady]);

  const requestCanvasFileSwitch = useCallback((fileOrAction, _fallbackAction) => {
    if (typeof fileOrAction === 'function') {
      if (dirtyStateRef.current) {
        unsavedGuard.request(fileOrAction);
        return;
      }
      fileOrAction();
      return;
    }

    const file = fileOrAction;
    if (!file?.id) return;
    const action = () => {
      pendingRouteFileIdRef.current = file.id;
      selectFile(file);
      router.replace(buildCanvasFileHref(file.id), undefined, { shallow: true })
        .then(() => {})
        .catch(() => {
          pendingRouteFileIdRef.current = null;
        });
    };
    if (dirtyStateRef.current) {
      unsavedGuard.request(action);
      return;
    }
    action();
  }, [router, selectFile, unsavedGuard]);

  const handleStart = useCallback(async (topic) => {
    if (!aiReady) return;
    const title = topic || '未命名创作';
    hiddenArticleFrontmatterRef.current = '';
    setArticle({ title });
    setBlocks([]);
    setActiveConversationId(null);
    setConversationDraft(true);
    setConversationList([]);
    setMessages([]);
    setPendingOperationSets([]);
    setPendingInteractions([]);
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
    const response = await fetch(buildCanvasConversationListUrl());
    const payload = await readApiResponse(response, '读取对话列表失败');
    return Array.isArray(payload) ? payload : [];
  }, []);

  const fetchConversationDetail = useCallback(async (conversationId, articleSnapshot = null) => {
    const articleHash = await computeClientArticleHash(articleSnapshot);
    const suffix = articleHash ? `?article_hash=${encodeURIComponent(articleHash)}` : '';
    const response = await fetch(`/api/conversations/${conversationId}${suffix}`);
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

  const refreshCurrentArticleAfterAgentWrite = useCallback(async () => {
    const targetFileId = Number(articleFileId || activeFile?.id || 0);
    if (!targetFileId) {
      await refreshFiles({ background: true });
      return;
    }
    try {
      clearCachedContent?.(targetFileId);
      const nextTree = await refreshFiles();
      const nextTargetFile = flattenFileTree(nextTree).find((file) => (
        file?.type === 'file' && Number(file.id) === targetFileId
      )) || null;
      if (!nextTargetFile) {
        setArticle(null);
        setBlocks([]);
        hiddenArticleFrontmatterRef.current = '';
        restoreCanvasPositionRef.current = false;
        pendingRouteFileIdRef.current = null;
        setActiveConversationId(null);
        setConversationDraft(true);
        setMessages([]);
        setPendingOperationSets([]);
        setPendingInteractions([]);
        setAiInjected('');
        setSaveState('saved');
        setHistoryDrawerOpen(false);
        clearAgentLoopSessionRef.current?.();
        router.replace('/canvas', undefined, { shallow: true }).catch(() => {});
        toast('您打开的文档已被删除', 'warning');
        return;
      }
      const response = await fetch(`/api/articles/${targetFileId}`, { cache: 'no-store' });
      const payload = await readApiResponse(response, '刷新文章内容失败');
      setArticle((prev) => ({
        ...(prev || {}),
        ...(payload || {}),
        title: getVisibleDocumentLabel(payload || nextTargetFile, '未命名创作'),
        file_id: payload?.file_id || targetFileId,
        fileId: payload?.file_id || targetFileId,
        draft_key: null,
        draftKey: null,
        sourcePath: nextTargetFile.path || prev?.sourcePath || '',
      }));
      hiddenArticleFrontmatterRef.current = payload?.hidden_frontmatter || payload?.hiddenFrontmatter || hiddenArticleFrontmatterRef.current || '';
      if (Array.isArray(payload?.blocks)) setBlocks(payload.blocks);
      setSaveState('saved');
    } catch (error) {
      toast(error.message || '刷新文章内容失败', 'error');
    }
  }, [activeFile?.id, articleFileId, clearCachedContent, refreshFiles, router, toast]);

  const refreshFilesAfterAgentMayHaveChanged = useCallback(async () => {
    try {
      await refreshFiles({ background: true });
    } catch {}
  }, [refreshFiles]);

  const handleAgentLoopOperationSets = useCallback((operationSets = []) => {
    setPendingOperationSets((prev) => (
      (Array.isArray(operationSets) ? operationSets : []).reduce((next, item) => upsertOperationSet(next, item), prev)
    ));
  }, []);

  const handleAgentLoopOperationSetHandled = useCallback((operationSetId, _action, operationSet = null) => {
    if (operationSet) {
      setPendingOperationSets((prev) => upsertOperationSet(prev, operationSet));
    }
    setMessages((prev) => prev.map((message) => (
      Number(message?.meta?.operation_set_id || 0) === Number(operationSetId)
        ? {
          ...message,
          operationSet: operationSet || message.operationSet || null,
          meta: {
            ...(message.meta || {}),
            operation_set_id: operationSetId,
          },
        }
        : message
    )));
  }, []);

  const agentLoop = useAgentLoopController({
    onAppendUserMessage: (message) => setMessages((prev) => [...prev, message]),
    onAppendAssistantMessage: (message) => setMessages((prev) => upsertMessage(prev, message)),
    onInteractionRequest: (interaction) => {
      setPendingInteractions((prev) => upsertInteraction(prev, interaction));
    },
    onConversationId: (conversationId) => {
      if (!conversationId) return;
      setActiveConversationId(Number(conversationId));
      setConversationDraft(false);
    },
    onConversationSettled: (conversationId) => {
      if (conversationId) refreshConversationListOnly(Number(conversationId));
    },
    onOperationSets: handleAgentLoopOperationSets,
    onOperationSetHandled: handleAgentLoopOperationSetHandled,
    onApplySuccess: refreshCurrentArticleAfterAgentWrite,
    onRollbackSuccess: refreshCurrentArticleAfterAgentWrite,
    onFilesMayHaveChanged: refreshFilesAfterAgentMayHaveChanged,
    onError: (error) => toast(error.message || 'Agent Loop 请求失败', 'error'),
  });
  const clearAgentLoopSession = agentLoop.clearActiveAgentSession;

  useEffect(() => {
    clearAgentLoopSessionRef.current = clearAgentLoopSession;
  }, [clearAgentLoopSession]);

  useEffect(() => {
    agentLoopControlRef.current = {
      loading: agentLoop.loading,
      stopAgentLoop: agentLoop.stopAgentLoop,
    };
  }, [agentLoop.loading, agentLoop.stopAgentLoop]);

  useEffect(() => {
    pageAliveRef.current = true;
    const handleLeave = () => {
      pageAliveRef.current = false;
      const control = agentLoopControlRef.current || {};
      if (control.loading) control.stopAgentLoop?.();
    };
    const handleRouteError = () => {
      pageAliveRef.current = true;
    };

    router.events.on('routeChangeStart', handleLeave);
    router.events.on('routeChangeError', handleRouteError);
    window.addEventListener('pagehide', handleLeave);
    window.addEventListener('beforeunload', handleLeave);
    return () => {
      router.events.off('routeChangeStart', handleLeave);
      router.events.off('routeChangeError', handleRouteError);
      window.removeEventListener('pagehide', handleLeave);
      window.removeEventListener('beforeunload', handleLeave);
      handleLeave();
    };
  }, [router.events]);

  const aiRequestLoading = loading || agentLoop.loading;
  const activeClarifyInteraction = aiRequestLoading ? null : rawClarifyInteraction;
  const agentLoopInteractionLocked = ['running', 'waiting_confirm'].includes(agentLoop.activeAgentSession?.status);
  const effectiveCanvasInputDisabled = canvasInputDisabled || aiRequestLoading || agentLoopInteractionLocked;

  const assertCurrentOperationSet = useCallback((operationSet) => {
    const currentConversationId = Number(activeConversationId || 0);
    const operationConversationId = Number(operationSet?.conversation_id || 0);
    if (!currentConversationId || !operationConversationId || currentConversationId !== operationConversationId) {
      throw new Error('这组修改不属于当前对话，已不能继续应用或回滚。');
    }
    return currentConversationId;
  }, [activeConversationId]);

  const handleConversationSelect = useCallback(async (conversationId) => {
    if (!conversationId || aiRequestLoading || agentLoopInteractionLocked) return;
    setConversationListLoading(true);
    requestControllerRef.current?.abort();
    clearAgentLoopSession();
    try {
      const payload = await fetchConversationDetail(conversationId, { ...article, blocks });
      setMessages(mapConversationMessages(payload.messages, 'canvas'));
      setPendingOperationSets(Array.isArray(payload.pending_operation_sets) ? payload.pending_operation_sets : []);
      setPendingInteractions(Array.isArray(payload.pending_interactions) ? payload.pending_interactions : []);
      setActiveConversationId(Number(conversationId));
      setConversationDraft(false);
      setStreamText('');
      setLoading(false);
      setHistoryDrawerOpen(false);
    } catch (loadError) {
      toast(loadError.message || '读取对话详情失败', 'error');
    } finally {
      setConversationListLoading(false);
    }
  }, [agentLoopInteractionLocked, aiRequestLoading, article, blocks, clearAgentLoopSession, fetchConversationDetail, toast]);

  const handleNewConversation = useCallback(() => {
    if (!articleFileId) return;
    if (aiRequestLoading || agentLoopInteractionLocked) {
      toast('当前 Agent 任务还在执行，请先停止或等待完成后再新建对话', 'info');
      return;
    }
    requestControllerRef.current?.abort();
    setActiveConversationId(null);
    setConversationDraft(true);
    setMessages([]);
    setPendingOperationSets([]);
    setPendingInteractions([]);
    setAiInjected('');
    clearAgentLoopSession();
    setStreamText('');
    setLoading(false);
    setHistoryDrawerOpen(false);
  }, [agentLoopInteractionLocked, aiRequestLoading, articleFileId, clearAgentLoopSession, toast]);

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
        setActiveConversationId(null);
        setConversationDraft(true);
        setMessages([]);
        setPendingOperationSets([]);
        setPendingInteractions([]);
        setAiInjected('');
        clearAgentLoopSession();
        setStreamText('');
        setLoading(false);
        setHistoryDrawerOpen(false);
      }
      const rows = await fetchConversationList();
      setConversationList(rows);
      toast('历史对话已删除', 'success');
    } catch (deleteError) {
      toast(deleteError.message || '删除历史对话失败', 'error');
    } finally {
      setDeletingConversationId(null);
    }
  }, [activeConversationId, clearAgentLoopSession, deletingConversationId, fetchConversationList, toast]);

  const handleConversationExport = useCallback(async (conversationId, conversation = null) => {
    const normalizedConversationId = Number(conversationId);
    if (!Number.isFinite(normalizedConversationId) || exportingConversationId) return;
    setExportingConversationId(normalizedConversationId);
    try {
      const payload = await fetchConversationDetail(normalizedConversationId, { ...article, blocks });
      const isActive = Number(activeConversationId) === normalizedConversationId;
      const exportMessages = isActive && messages.length > 0
        ? messages
        : (Array.isArray(payload.messages) ? payload.messages : []);
      const exportPayload = {
        conversation: { ...(conversation || {}), ...(payload || {}) },
        messages: exportMessages,
        agentSessions: Array.isArray(payload.agent_sessions) ? payload.agent_sessions : [],
        pendingOperationSets: isActive
          ? pendingOperationSets
          : (Array.isArray(payload.pending_operation_sets) ? payload.pending_operation_sets : []),
        source: 'Notus 创作页',
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
    article,
    blocks,
    exportingConversationId,
    fetchConversationDetail,
    messages,
    pendingOperationSets,
    toast,
  ]);

  const handleConversationAgentLogs = useCallback((conversationId) => {
    if (!conversationId) return;
    navigateWithFallback(router, `/settings/logs?conversation_id=${encodeURIComponent(conversationId)}`);
  }, [router]);

  useEffect(() => {
    if (!article || !articleFileId) {
      setConversationList([]);
      setActiveConversationId(null);
      setConversationDraft(true);
      setMessages([]);
      setPendingOperationSets([]);
      setPendingInteractions([]);
      clearAgentLoopSession();
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
          setPendingOperationSets([]);
          setPendingInteractions([]);
          clearAgentLoopSession();
          return;
        }

        const initialConversationId = Number(rows[0].id);
        const payload = await fetchConversationDetail(initialConversationId, { ...article, blocks });
        if (cancelled) return;
        setActiveConversationId(initialConversationId);
        setConversationDraft(false);
        setMessages(mapConversationMessages(payload.messages, 'canvas'));
        setPendingOperationSets(Array.isArray(payload.pending_operation_sets) ? payload.pending_operation_sets : []);
        setPendingInteractions(Array.isArray(payload.pending_interactions) ? payload.pending_interactions : []);
        setStreamText('');
        setLoading(false);
      } catch (loadError) {
        if (cancelled) return;
        setConversationList([]);
        setActiveConversationId(null);
        setConversationDraft(true);
        setMessages([]);
        setPendingOperationSets([]);
        setPendingInteractions([]);
        clearAgentLoopSession();
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
  }, [article, articleFileId, fetchConversationDetail, fetchConversationList, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!article || pendingOperationSets.length === 0) return;
    let cancelled = false;
    computeClientArticleHash({ ...article, blocks }).then((hash) => {
      if (cancelled || !hash) return;
      setPendingOperationSets((prev) => prev.map((item) => (
        item.article_hash && item.article_hash !== hash && item.status === 'pending'
          ? { ...item, status: 'stale' }
          : item
      )));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [article, blocks, pendingOperationSets.length]);

  useEffect(() => {
    if (!article || pendingInteractions.length === 0) return;
    let cancelled = false;
    computeClientArticleHash({ ...article, blocks }).then((hash) => {
      if (cancelled || !hash) return;
      setPendingInteractions((prev) => prev.map((item) => (
        item.article_hash && item.article_hash !== hash && (item.status === 'pending' || item.status === 'failed')
          ? { ...item, status: 'stale' }
          : item
      )));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [article, blocks, pendingInteractions.length]);

  const buildCanvasAgentTask = useCallback((query, options = {}) => {
    const filePath = article?.sourcePath || activeFile?.path || '';
    const currentArticleFile = articleFileId
      ? allFiles.find((file) => Number(file.id) === Number(articleFileId))
      : null;
    const currentDocumentLabel = getVisibleDocumentLabel({
      title: currentArticleFile?.title || article?.title || activeFile?.title || '',
      name: currentArticleFile?.name || article?.name || activeFile?.name || '',
      path: currentArticleFile?.path || filePath,
      sourcePath: filePath,
    }, '未命名文档');
    const currentDocumentContext = [
      `当前打开文档：${currentDocumentLabel}`,
      filePath ? `当前文章路径：${filePath}` : '',
    ].filter(Boolean).join('\n');
    const blockContext = formatCanvasBlocksForAgent(blocks);
    const goal = currentDocumentContext
      ? `用户任务：${query}\n\n${currentDocumentContext}${blockContext ? `\n\n${blockContext}` : ''}`
      : `${query}${blockContext ? `\n\n${blockContext}` : ''}`;
    return {
      goal,
      user_query: query,
      display_query: query,
      kind: 'canvas',
      conversation_id: activeConversationId || undefined,
      active_file_id: activeFile?.id || articleFileId || undefined,
      llm_config_id: options.llmConfigId || selectedLlmConfigId,
      authorized_paths: [getAgentAuthorizedDirectory(filePath)],
      authorized_ops: ['modify', 'create'],
      search_knowledge_limit: 5,
      attachments: options.attachments || [],
      web_search_enabled: Boolean(options.webSearchEnabled),
      search_provider: options.searchProvider || null,
      route_reason: options.routeReason || 'canvas_main_input',
    };
  }, [
    activeConversationId,
    activeFile?.id,
    activeFile?.name,
    activeFile?.path,
    activeFile?.title,
    article?.name,
    article?.sourcePath,
    article?.title,
    articleFileId,
    allFiles,
    blocks,
    selectedLlmConfigId,
  ]);

  const discardPendingAgentDiffs = useCallback(async () => {
    const targets = pendingOperationSets.filter((operationSet) => (
      Number(operationSet?.agent_session_id || 0) > 0
      && Array.isArray(operationSet?.patches)
      && operationSet.patches.some((patch) => ['pending', 'failed'].includes(String(patch?.status || 'pending')))
    ));
    for (const operationSet of targets) {
      try {
        await agentLoop.discardPendingOperationSet(operationSet);
      } catch {}
    }
  }, [agentLoop, pendingOperationSets]);

  const prepareCanvasAgentTask = useCallback(async (query, options = {}) => {
    const task = buildCanvasAgentTask(query, options);
    setAiInjected('');
    await discardPendingAgentDiffs();
    agentLoop.confirmAgentTask({
      ...task,
      approval_mode: normalizeCanvasAgentConfirmMode(agentConfirmMode),
    });
  }, [
    agentConfirmMode,
    agentLoop,
    buildCanvasAgentTask,
    discardPendingAgentDiffs,
  ]);

  const focusCanvasInput = useCallback(() => {
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
          article: { ...article, blocks },
          schema_version: interaction.schema_version,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (payload.interaction) {
          setPendingInteractions((prev) => upsertInteraction(prev, payload.interaction));
        }
        throw new Error(payload.error || '回答提问卡片失败');
      }

      if (payload.interaction) {
        setPendingInteractions((prev) => upsertInteraction(prev, payload.interaction));
      }
      if (payload.answer_message) {
        const mappedMessage = mapSingleConversationMessage(payload.answer_message, 'canvas');
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
  }, [article, blocks, refreshConversationListOnly]);

  const cancelInteraction = useCallback(async (interaction, options = {}) => {
    if (!interaction?.id) return null;
    try {
      return await respondToInteraction(interaction, { action: 'cancel' }, { setSubmitting: false });
    } catch (error) {
      if (!options.silent) {
        toast(error.message || '关闭提问卡片失败', 'error');
      }
      throw error;
    }
  }, [respondToInteraction, toast]);

  const runInteractionResume = useCallback(async (interaction, llmConfigId = selectedLlmConfigId) => {
    if (!interaction?.id) return;
    if (!llmConfigId) {
      toast('请先在模型配置中新增至少一个 LLM 配置', 'warning');
      return;
    }
    if (interaction.source === 'agent_loop') {
      const session = agentLoop.activeAgentSession || {};
      const sessionId = Number(interaction?.payload?.agent_session_id || session.id || 0) || null;
      const token = session.token || '';
      if (!sessionId || !token) {
        toast('当前 Agent 任务状态已失效，请重新发起任务', 'warning');
        return;
      }
      await agentLoop.startAgentLoop({
        session_id: sessionId,
        session_token: token,
        interaction_id: interaction.id,
        llm_config_id: llmConfigId,
      }, { resume: true });
      return;
    }
    const originalInput = interaction?.payload?.original_user_input || '继续完成刚才的创作任务';
    await prepareCanvasAgentTask(originalInput, {
      llmConfigId,
      routeReason: 'legacy_interaction_resume',
    });
  }, [agentLoop, prepareCanvasAgentTask, selectedLlmConfigId, toast]);

  const handleInteractionCardSubmit = useCallback(async (interaction, answers) => {
    try {
      const payload = await respondToInteraction(interaction, { response: { answers } });
      if (!payload) return;
      if (payload.should_continue && payload.resume_payload) {
        await runInteractionResume(payload.interaction || interaction, selectedLlmConfigId);
      }
    } catch (error) {
      toast(error.message || '回答提问卡片失败', 'error');
    }
  }, [respondToInteraction, runInteractionResume, selectedLlmConfigId, toast]);

  const handleDecisionCorrection = useCallback(async (signalId) => {
    const action = DECISION_CORRECTION_ACTIONS[signalId];
    if (!action || aiRequestLoading) return;
    if (!articleFileId) {
      toast('先保存当前大纲为文档，再继续 AI 改写和历史对话', 'info');
      return;
    }
    if (!selectedLlmConfigId) {
      toast('请先在模型配置中新增至少一个 LLM 配置', 'warning');
      return;
    }

    try {
      await prepareCanvasAgentTask(action.prompt, {
        llmConfigId: selectedLlmConfigId,
        routeReason: 'decision_correction',
      });
    } catch {}
  }, [
    aiRequestLoading,
    articleFileId,
    prepareCanvasAgentTask,
    selectedLlmConfigId,
    toast,
  ]);

  const handleSend = useCallback(async (query, optionsOrLlmConfigId = selectedLlmConfigId) => {
    const sendOptions = optionsOrLlmConfigId && typeof optionsOrLlmConfigId === 'object'
      ? optionsOrLlmConfigId
      : { llmConfigId: optionsOrLlmConfigId };
    const llmConfigId = sendOptions.llmConfigId || selectedLlmConfigId;
    if (!articleFileId) {
      toast('先保存当前大纲为文档，再继续 AI 改写和历史对话', 'info');
      return;
    }

    if (!llmConfigId) {
      toast('请先在模型配置中新增至少一个 LLM 配置', 'warning');
      return;
    }

    if (saveState === 'dirty') {
      const saved = await handleSaveArticle();
      if (!saved) return;
    }

    if (activeClarifyInteraction && clarifyDrawerPhase === 'collapsed') {
      try {
        await cancelInteraction(activeClarifyInteraction, { silent: true });
      } catch {}
    }

    try {
      await prepareCanvasAgentTask(query, {
        llmConfigId,
        attachments: sendOptions.attachments || [],
        webSearchEnabled: Boolean(sendOptions.webSearchEnabled),
        searchProvider: sendOptions.searchProvider || null,
        routeReason: 'canvas_main_input',
      });
    } catch {}
  }, [
    articleFileId,
    activeClarifyInteraction,
    cancelInteraction,
    clarifyDrawerPhase,
    handleSaveArticle,
    prepareCanvasAgentTask,
    saveState,
    selectedLlmConfigId,
    toast,
  ]);

  const handleRetryInteraction = useCallback(async (interaction) => {
    if (!interaction?.id) return;
    try {
      await runInteractionResume(interaction, selectedLlmConfigId);
    } catch {}
  }, [runInteractionResume, selectedLlmConfigId]);

  useEffect(() => {
    if (!articleFileId || !canvasContentRef.current || loadingSourceFile) return undefined;
    const container = canvasContentRef.current;
    if (restoreCanvasPositionRef.current && readViewPosition('canvas', articleFileId)) {
      return retryRestoreViewPosition(
        () => restoreCanvasViewPosition(articleFileId, container),
        {
          onComplete: () => {
            restoreCanvasPositionRef.current = false;
          },
        }
      );
    }

    restoreCanvasPositionRef.current = false;
    return undefined;
  }, [articleFileId, blocks, loadingSourceFile]);

  useEffect(() => {
    if (!articleFileId || !canvasContentRef.current || loadingSourceFile) return undefined;
    const container = canvasContentRef.current;

    const savePosition = () => {
      if (!articleFileId || restoreCanvasPositionRef.current) return;
      writeCanvasViewPosition(articleFileId, container);
    };

    const handleScroll = () => {
      if (saveCanvasPositionTimerRef.current) {
        window.clearTimeout(saveCanvasPositionTimerRef.current);
      }
      saveCanvasPositionTimerRef.current = window.setTimeout(savePosition, 240);
    };

    const flushPosition = () => {
      if (saveCanvasPositionTimerRef.current) {
        window.clearTimeout(saveCanvasPositionTimerRef.current);
        saveCanvasPositionTimerRef.current = null;
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
      if (saveCanvasPositionTimerRef.current) {
        window.clearTimeout(saveCanvasPositionTimerRef.current);
        saveCanvasPositionTimerRef.current = null;
      }
      savePosition();
    };
  }, [articleFileId, loadingSourceFile, router.events]);

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
    setBlocks((prev) => prev.filter((block) => block.id !== blockId));
    setSaveState('dirty');
  }, []);

  // Add new empty block
  const handleAddBlock = useCallback(() => {
    const newId = `b_${Date.now()}`;
    setBlocks((prev) => [...prev, { id: newId, type: 'paragraph', content: '' }]);
    setSaveState('dirty');
  }, []);

  const handleApplyOperationSet = useCallback(async (operationSet) => {
    try {
      const currentConversationId = assertCurrentOperationSet(operationSet);
      if (Array.isArray(operationSet?.operations) && operationSet.operations.length > 0) {
        const response = await fetch('/api/agent/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            article: { ...article, blocks },
            operations: operationSet.operations,
            operation_set_id: operationSet.id,
            current_conversation_id: currentConversationId,
          }),
        });
        const payload = await readApiResponse(response, '应用块级修改失败');
        const nextBlocks = Array.isArray(payload?.article?.blocks) ? payload.article.blocks : blocks;
        setPendingOperationSets((prev) => upsertOperationSet(prev, {
          ...operationSet,
          status: payload.operation_set_status || 'applied',
        }));
        setBlocks(nextBlocks);
        const saved = await handleSaveArticle(nextBlocks);
        if (!saved) return;
        toast('块级修改已应用', 'success');
        return;
      }
      await agentLoop.applyOperationSet(operationSet, {
        approvalMode: CANVAS_AGENT_CONFIRM_MANUAL_CONFIRM,
        currentConversationId,
      });
      toast('修改已应用', 'success');
    } catch (error) {
      toast(error.message || '应用修改失败', 'error');
    }
  }, [agentLoop, article, assertCurrentOperationSet, blocks, handleSaveArticle, toast]);

  const handleApplyOperationFile = useCallback(async (operationSet, patchIndex) => {
    try {
      const currentConversationId = assertCurrentOperationSet(operationSet);
      await agentLoop.applyOperationFile(operationSet, patchIndex, {
        approvalMode: CANVAS_AGENT_CONFIRM_MANUAL_CONFIRM,
        currentConversationId,
      });
      toast('文件修改已应用', 'success');
    } catch (error) {
      toast(error.message || '应用文件修改失败', 'error');
      throw error;
    }
  }, [agentLoop, assertCurrentOperationSet, toast]);

  const handleRollbackOperationFile = useCallback(async (operationSet, patchIndex) => {
    try {
      const currentConversationId = assertCurrentOperationSet(operationSet);
      await agentLoop.rollbackOperationFile(operationSet, patchIndex, { currentConversationId });
      toast('文件修改已回滚', 'success');
    } catch (error) {
      toast(error.message || '回滚文件修改失败', 'error');
      throw error;
    }
  }, [agentLoop, assertCurrentOperationSet, toast]);

  const handleCancelOperationSet = useCallback(async (operationSet) => {
    try {
      await agentLoop.rejectOperationSet(operationSet);
    } catch {}
    setPendingOperationSets((prev) => prev.filter((item) => Number(item.id) !== Number(operationSet?.id)));
  }, [agentLoop]);

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

  const pendingOperationSetById = pendingOperationSets.reduce((acc, item) => {
    acc[String(item.id)] = item;
    return acc;
  }, {});

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
  const highlightedBlockIds = new Set(
    pendingOperationSets
      .filter((item) => item.status === 'pending')
      .flatMap((item) => Array.isArray(item.operations) ? item.operations.map((operation) => operation.block_id).filter(Boolean) : [])
  );

  // ── Entry screen ──
  if (!article) {
    if (!router.isReady || routeFileId) {
      return (
        <Shell active="canvas" tocDisabled requestAction={requestCanvasFileSwitch} navigateOnFileSelect={false}>
          <CanvasRouteLoading
            missing={router.isReady && routeFileMissing}
            onBack={() => {
              pendingRouteFileIdRef.current = null;
              router.replace('/canvas', undefined, { shallow: true });
            }}
          />
          {unsavedGuard.dialog}
        </Shell>
      );
    }

    return (
      <Shell active="canvas" tocDisabled requestAction={requestCanvasFileSwitch} navigateOnFileSelect={false}>
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

  const canvasEditorPanel = (
    <div
      style={{ overflow: 'auto', background: 'var(--bg-primary)', height: '100%', position: 'relative', minHeight: 0 }}
      ref={canvasContentRef}
    >
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
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
          <h1 style={{
            fontFamily: 'var(--font-editor)',
            fontSize: 'var(--text-3xl)',
            fontWeight: 700,
            margin: 0,
            flex: 1,
          }} data-canvas-title="true">
            {articleTitleLabel}
          </h1>
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 28 }}>
          {loadingSourceFile ? '正在载入文章内容…' : `${saveState === 'saving' ? '正在保存' : saveState === 'dirty' ? '尚未保存' : '已保存'} · ${blocks.length} 个块`}
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={blocks.map((block) => block.id)} strategy={verticalListSortingStrategy}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {blocks.map((block, i) => (
                <SortableCanvasItem
                  key={block.id}
                  block={block}
                  index={i}
                  state={highlightedBlockIds.has(block.id) ? 'modified' : 'default'}
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
  );

  const canvasAssistantPanel = (
    <div style={{
      borderLeft: '1px solid var(--border-primary)',
      background: 'var(--bg-primary)',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minHeight: 0,
      minWidth: 0,
      position: 'relative',
    }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', minWidth: 0 }}>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>风格来源</div>
            {[
              { value: 'auto', label: '自动匹配' },
              { value: 'manual', label: '手动指定' },
            ].map((mode) => (
              <button
                key={mode.value}
                onClick={() => setStyleSource(mode.value)}
                style={{
                  height: 26,
                  padding: '0 10px',
                  background: styleSource === mode.value ? 'var(--accent-subtle)' : 'transparent',
                  border: `1px solid ${styleSource === mode.value ? 'color-mix(in srgb, var(--accent) 35%, var(--border-primary))' : 'var(--border-subtle)'}`,
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
            <Tooltip content="查看历史对话">
              <span style={{ display: 'inline-flex' }}>
                <IconButton
                  label="查看历史对话"
                  size={30}
                  active={historyDrawerOpen}
                  disabled={!canvasConversationEnabled || aiRequestLoading || conversationListLoading || agentLoopInteractionLocked}
                  onClick={() => setHistoryDrawerOpen(true)}
                >
                  {conversationListLoading ? <Spinner size={13} /> : <Icons.clock size={14} />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip content="新建对话">
              <span style={{ display: 'inline-flex' }}>
                <IconButton
                  label="新建对话"
                  size={30}
                  disabled={!canvasConversationEnabled || aiRequestLoading || agentLoopInteractionLocked}
                  onClick={handleNewConversation}
                >
                  <Icons.plus size={14} />
                </IconButton>
              </span>
            </Tooltip>
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
                  <Badge tone="accent">{getVisibleDocumentLabel(file, '未命名文档')} ×</Badge>
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

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <AgentWorkspace
          messages={visibleMessages.map((message) => {
            const operationSet = message.meta?.operation_set_id ? pendingOperationSetById[String(message.meta.operation_set_id)] : null;
            return operationSet ? { ...message, operationSet } : message;
          })}
          streamText={agentLoop.loading || agentLoop.streamText ? agentLoop.streamText : streamText}
          loading={aiRequestLoading}
          error={agentLoop.error || ''}
          activeSteps={agentLoop.activeSteps.length > 0 ? agentLoop.activeSteps : activeSteps}
          llmConfigs={llmConfigs}
          selectedConfigId={selectedLlmConfigId}
          onConfigChange={setSelectedLlmConfigId}
          onSend={handleSend}
          onStop={() => {
            if (agentLoop.loading) agentLoop.stopAgentLoop();
            else requestControllerRef.current?.abort();
          }}
          onApplyOperationSet={handleApplyOperationSet}
          onApplyOperationFile={handleApplyOperationFile}
          onRollbackOperationFile={handleRollbackOperationFile}
          activeAgentSession={agentLoop.activeAgentSession}
          agentConfirmMode={agentConfirmMode}
          onAgentConfirmModeChange={setAgentConfirmMode}
          disabled={effectiveCanvasInputDisabled}
          attachmentMode="parsed"
          mentionOptions={[{ value: '__all__', token: '@全文', label: '全文', preview: '对整篇文章生效', searchText: '全文 整篇 整文' }, ...mentionOptions]}
          placeholder={canvasConversationEnabled ? '例如：让 @b2 更简洁，或为第 3 段加一个例子…' : '先保存当前大纲为文档，再继续 AI 改写…'}
        />
      </div>
      <div style={{ display: 'none' }}>
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
        {canvasConversationEnabled && visibleMessages.length === 0 && !loading && (
          <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>
            <div style={{ marginTop: 8 }}>向 AI 发送指令，如：<br />「让 @b2 更简洁」或「为第 3 段加上例子」</div>
          </div>
        )}
        {visibleMessages.map((msg) => (
          msg.role === 'user'
            ? <UserBubble key={msg.id}>{msg.content}</UserBubble>
            : (
              <AiBubble key={msg.id} text={msg.content}>
                {msg.meta?.show_decision_summary && msg.meta?.decision_summary ? (
                  <DecisionSummaryCard summary={msg.meta.decision_summary} />
                ) : null}
                {msg.meta?.operation_set_id && pendingOperationSetById[String(msg.meta.operation_set_id)] ? (
                  <BatchOperationCard
                    operationSet={pendingOperationSetById[String(msg.meta.operation_set_id)]}
                    blocks={blocks}
                    onApply={handleApplyOperationSet}
                    onCancel={handleCancelOperationSet}
                  />
                ) : msg.meta?.show_decision_summary && msg.meta?.canvas_mode === 'edit' ? (
                  <CorrectionChipBar
                    onSelect={handleDecisionCorrection}
                    disabled={aiRequestLoading}
                  />
                ) : null}
              </AiBubble>
            )
        ))}
        {loading && <AiBubble text={streamText} streaming />}
        <div ref={chatEndRef} />
      </div>

      <InputBar
        isEmpty={canvasConversationEnabled && visibleMessages.length === 0 && !loading}
        placeholder={canvasConversationEnabled ? '例如：让 @b2 更简洁，或为第 3 段加一个例子…' : '先保存当前大纲为文档，再继续 AI 改写…'}
        onSend={handleSend}
        onStop={() => {
          if (agentLoop.loading) agentLoop.stopAgentLoop();
          else requestControllerRef.current?.abort();
        }}
        loading={aiRequestLoading}
        injectedValue={aiInjected}
        llmConfigs={llmConfigs}
        selectedConfigId={selectedLlmConfigId}
        onConfigChange={setSelectedLlmConfigId}
        disabled={effectiveCanvasInputDisabled}
        showPlusMenu={false}
        mentionOptions={[{ value: '__all__', token: '@全文', label: '全文', preview: '对整篇文章生效', searchText: '全文 整篇 整文' }, ...mentionOptions]}
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
                onSubmit={handleInteractionCardSubmit}
                onRetry={handleRetryInteraction}
                onCancel={(interaction) => { void cancelInteraction(interaction); }}
                onPhaseChange={setClarifyDrawerPhase}
                onFocusInput={focusCanvasInput}
                submitting={interactionSubmittingId === Number(activeClarifyInteraction?.id)}
                submitLabel={activeClarifyInteraction?.payload?.submit_label || '开始生成预览'}
                retryLabel="重试"
                narrow
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
    </div>
  );

  // ── Canvas editor ──
  return (
    <Shell
      active="canvas"
      fileName={canvasFileLabel}
      saveState={saveState}
      onSave={handleSaveArticle}
      saveDisabled={saveState !== 'dirty'}
      tocDisabled
      requestAction={requestCanvasFileSwitch}
      navigateOnFileSelect={false}
    >
      <div style={{ position: 'relative', flex: 1, display: 'flex', minHeight: 0 }}>
        <ResizableLayout
          initialLeftPercent={CANVAS_LAYOUT_DEFAULT}
          minLeftPercent={CANVAS_LAYOUT_MIN}
          maxLeftPercent={CANVAS_LAYOUT_MAX}
          minLeftPx={CANVAS_EDITOR_MIN_WIDTH}
          minRightPx={CANVAS_CHAT_MIN_WIDTH}
          leftPercent={canvasLayoutLeftPercent}
          onLeftPercentChange={handleCanvasLayoutChange}
          onLeftPercentCommit={handleCanvasLayoutCommit}
          left={canvasEditorPanel}
          right={canvasAssistantPanel}
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
