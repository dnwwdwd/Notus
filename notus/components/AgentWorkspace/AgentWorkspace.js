import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/Input';
import { Toggle } from '../ui/Toggle';
import { Dialog } from '../ui/Dialog';
import { Icons } from '../ui/Icons';
import { ImagePreviewOverlay } from '../ui/ImagePreviewOverlay';
import { MentionItem } from './MentionItem';
import { MentionPreviewDialog, prefetchMentionDocument } from './MentionPreviewDialog';
import { Tooltip } from '../ui/Tooltip';
import { SourceCard } from '../ui/SourceCard';
import { useToast } from '../ui/Toast';
import { StreamingText } from '../ui/StreamingText';
import { Spinner } from '../ui/Spinner';
import { LlmConfigCardsSection } from '../Settings/LlmConfigCardsSection';
import { findEmbeddingModelMeta, inferEmbeddingProvider } from '../../lib/embeddingForm';
import { resolveLlmProviderLabel } from '../../lib/llmForm';
import { useSettingsDialog } from '../../contexts/SettingsDialogContext';
import { SegmentedTabs } from '../ui/SegmentedTabs';
import { readAgentInputPreference, writeAgentInputPreference } from '../../utils/agentInputPreferences';
import { dedupeAgentMedia, getAgentImagePreviewUrl } from '../../utils/agentMedia';
import { formatMessageTimestamp } from '../../utils/messageTimestamps';
import {
  clearAgentComposerDraft,
  readAgentComposerDraft,
  restoreAgentComposerFiles,
  saveAgentComposerDraft,
} from '../../utils/agentComposerDraft';

const SEARCH_PROVIDER_FALLBACKS = [
  { id: 'firecrawl', name: 'Firecrawl', quota_url: 'https://www.firecrawl.dev/', max_limit: 20, requires_api_key: false },
  { id: 'tavily', name: 'Tavily', quota_url: 'https://app.tavily.com/home', max_limit: 20, requires_api_key: true },
  { id: 'exa', name: 'Exa', quota_url: 'https://dashboard.exa.ai/api-keys', max_limit: 100, requires_api_key: true },
  { id: 'zhipu', name: '智谱', quota_url: 'https://bigmodel.cn/usercenter/proj-mgmt/overview', max_limit: 50, requires_api_key: true },
];

const SEARCH_MODE_LABELS = {
  firecrawl: [
    { value: 'default', label: '默认抓取' },
    { value: 'map', label: '站点地图' },
    { value: 'extract', label: '结构提取' },
  ],
  tavily: [
    { value: 'basic', label: '基础搜索' },
    { value: 'advanced', label: '增强搜索' },
  ],
  exa: [
    { value: 'auto', label: '自动' },
    { value: 'neural', label: '语义搜索' },
    { value: 'keyword', label: '关键词' },
  ],
  zhipu: [
    { value: 'search-prime', label: 'Search Prime' },
    { value: 'search-std', label: 'Search Standard' },
  ],
};

const AGENT_CONFIRM_MODE_OPTIONS = [
  {
    value: 'auto_confirm',
    label: '自动',
    description: '自动应用修改',
    icon: 'zap',
  },
  {
    value: 'manual_confirm',
    label: '手动',
    description: '手动应用修改',
    icon: 'hand',
  },
];
const AGENT_INPUT_TEXTAREA_DEFAULT_ROWS = 3;
const AGENT_INPUT_LINE_HEIGHT = 22;
const AGENT_CHAT_CONTENT_WIDTH = 'min(860px, calc(100% - 32px))';
const CHAT_STICKY_BOTTOM_THRESHOLD = 56;
const CHAT_JUMP_BUTTON_OFFSET = 240;
const MCP_SELECTION_STORAGE_KEY = 'notus-agent-mcp-selection';
const AGENT_TASK_RECEIPTS_ENABLED = false;
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function readMcpSelectionPreference() {
  if (typeof window === 'undefined') return { mode: 'off' };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MCP_SELECTION_STORAGE_KEY) || '{}');
    if (parsed?.mode === 'auto') return { mode: 'auto' };
    // 旧版本允许固定到某个 Server；输入框现已收敛为任务级自动开关，旧偏好继续按开启处理。
    if (parsed?.mode === 'server') return { mode: 'auto' };
  } catch {}
  return { mode: 'off' };
}

function isNearScrollBottom(container) {
  if (!container) return true;
  return container.scrollHeight - container.scrollTop - container.clientHeight <= CHAT_STICKY_BOTTOM_THRESHOLD;
}

function scrollContainerToBottom(container, behavior = 'auto') {
  if (!container) return;
  container.scrollTo({ top: container.scrollHeight, behavior });
}

async function copyMessageText(text = '') {
  const value = String(text || '');
  if (!value.trim()) throw new Error('当前消息没有可复制内容');

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }

  if (!copied) {
    throw new Error('当前环境不支持复制到剪贴板');
  }
}

const PARSED_ATTACHMENT_ACCEPT = '.pdf,.docx,.md,.markdown,.txt,.csv,text/plain,text/markdown,text/csv,application/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PARSED_ATTACHMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.md', '.markdown', '.txt', '.csv']);
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const LONG_PASTE_ATTACHMENT_THRESHOLD = 100;
const MAX_PARSED_ATTACHMENTS = 10;
const MAX_IMAGES_PER_MESSAGE = 30;

const C = {
  page: '#FDFCFB',
  card: '#FFFFFF',
  muted: '#F2F0EA',
  soft: '#F9F9F8',
  border: '#E5E3D8',
  text: '#2D2D2D',
  secondary: '#6B6963',
  tertiary: '#8A8881',
  accent: '#D97757',
  accentDark: '#CC5500',
};

function transitionButton(extra) {
  return {
    border: 'none',
    cursor: extra && extra.cursor ? extra.cursor : 'pointer',
    transitionProperty: 'transform, background-color, color, box-shadow, opacity',
    transitionDuration: '160ms',
    transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    touchAction: 'manipulation',
    ...(extra || {}),
  };
}

function normalizeApiProtocol(value) {
  return String(value || '').trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
}

function providerLabel(config) {
  if (!config) return '未配置';
  return resolveLlmProviderLabel(config.provider);
}

function modelLabel(config) {
  return config?.model || config?.name || '未配置模型';
}

function normalizeAgentConfirmMode(value) {
  return value === 'manual' || value === 'manual_confirm' ? 'manual_confirm' : 'auto_confirm';
}

function getAgentConfirmModeOption(value) {
  const normalized = normalizeAgentConfirmMode(value);
  return AGENT_CONFIRM_MODE_OPTIONS.find((item) => item.value === normalized) || AGENT_CONFIRM_MODE_OPTIONS[0];
}

function providerNeedsApiKey(provider) {
  return Boolean(provider && provider.requires_api_key !== false);
}

function fileType(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'PDF';
  if (type.includes('word') || /\.(doc|docx)$/.test(name)) return 'W';
  if (/\.(md|markdown)$/.test(name)) return 'MD';
  if (type.includes('csv') || type.includes('excel') || name.endsWith('.csv')) return 'CSV';
  if (type.includes('text') || name.endsWith('.txt')) return 'TXT';
  if (/\.(ppt|pptx)$/.test(name)) return 'PPT';
  return 'FILE';
}

function fileSize(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return '未知大小';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / 1024 / 1024).toFixed(1) + ' MB';
}

function fileExtension(name = '') {
  const match = String(name || '').toLowerCase().match(/(\.[^.]+)$/);
  return match ? match[1] : '';
}

function isSupportedParsedFile(file) {
  return PARSED_ATTACHMENT_EXTENSIONS.has(fileExtension(file?.name));
}

function isSupportedImageFile(file) {
  return IMAGE_EXTENSIONS.has(fileExtension(file?.name))
    || IMAGE_MIME_TYPES.has(String(file?.type || '').trim().toLowerCase());
}

function getClipboardFiles(clipboard) {
  const files = Array.from(clipboard?.files || []).filter(Boolean);
  if (files.length > 0) return files;
  return Array.from(clipboard?.items || [])
    .filter((item) => item?.kind === 'file' && typeof item.getAsFile === 'function')
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

function isImageMedia(file = {}) {
  return file?.media_kind === 'image'
    || file?.source_kind === 'image'
    || isSupportedImageFile(file);
}

function imagePreviewUrl(file = {}) {
  return getAgentImagePreviewUrl(file);
}

function toDisplayAttachment(file) {
  const { fileObject: _fileObject, previewUrl: _previewUrl, ...rest } = file || {};
  return rest;
}

function isPdfAttachment(file = {}) {
  const name = String(file?.name || file?.source || '').toLowerCase();
  const type = String(file?.type || file?.contentType || file?.parsed?.contentType || '').toLowerCase();
  const extension = String(file?.extension || '').toLowerCase();
  return type.includes('pdf') || extension === '.pdf' || name.endsWith('.pdf');
}

function FileChip({ file, onRemove, readOnly, onOpen, onPreview, imageOnly = false, imageSize = 72 }) {
  const image = isImageMedia(file);
  const fileName = String(file?.name || '未命名附件');
  const type = fileType(file);
  const previewUrl = image ? imagePreviewUrl(file) : '';
  const canPreview = image && Boolean(previewUrl) && typeof onPreview === 'function';
  const canOpen = readOnly && !image && typeof onOpen === 'function';
  const interactive = canPreview || canOpen;
  const removeButton = !readOnly ? (
    <button
      type="button"
      aria-label={image ? '移除图片' : '移除附件'}
      onClick={(event) => {
        event.stopPropagation();
        onRemove?.(file.id);
      }}
      style={transitionButton({
        position: 'absolute',
        top: -6,
        right: -6,
        width: 20,
        height: 20,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: C.tertiary,
        color: '#fff',
        zIndex: 1,
      })}
    >
      <Icons.x size={11} />
    </button>
  ) : null;

  if (image && imageOnly && previewUrl) {
    const imageStyle = {
      width: imageSize,
      height: imageSize,
      display: 'block',
      padding: 0,
      overflow: 'hidden',
      border: 0,
      borderRadius: 12,
      background: C.soft,
      cursor: canPreview ? 'pointer' : 'default',
      boxShadow: '0 1px 6px rgba(45,45,45,0.10), inset 0 0 0 1px rgba(229,227,216,0.9)',
    };
    const thumbnail = (
      // 本地对象 URL 与会话临时图片不经过 Next 图片优化。
      // eslint-disable-next-line @next/next/no-img-element
      <img src={previewUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
    );
    return (
      <div style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
        {canPreview ? <button type="button" aria-label={`预览图片：${file.name || '未命名图片'}`} onClick={() => onPreview?.(file)} className="notus-agent-pressable" style={transitionButton(imageStyle)}>{thumbnail}</button> : <div style={imageStyle}>{thumbnail}</div>}
        {removeButton}
      </div>
    );
  }
  const content = (
    <>
      {image && previewUrl ? (
        // 本地对象 URL 与会话临时图片不经过 Next 图片优化。
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt={file.name || '已上传图片'} style={{ width: 38, height: 38, objectFit: 'cover', borderRadius: 10, flexShrink: 0, background: C.soft }} />
      ) : (
        <span style={{
          minWidth: 30,
          height: 30,
          borderRadius: 10,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: type === 'PDF' ? '#E2574C' : type === 'MD' ? '#333' : '#1B5EBE',
          color: '#fff',
          fontSize: 9,
          fontWeight: 800,
        }}>{type}</span>
      )}
      <span style={{ minWidth: 0, flex: '1 1 auto', display: 'grid', gap: 2 }}>
        <span style={{ minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
        <span style={{ fontSize: 11, color: C.tertiary }}>{file.sizeLabel || fileSize(file.size)}</span>
      </span>
      {canOpen ? <Icons.eye size={14} style={{ color: C.tertiary, flexShrink: 0 }} /> : null}
    </>
  );
  const commonStyle = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    maxWidth: '100%',
    boxSizing: 'border-box',
    padding: '8px 12px',
    borderRadius: 14,
    background: '#fff',
    boxShadow: '0 1px 6px rgba(45,45,45,0.08), inset 0 0 0 1px rgba(229,227,216,0.9)',
    color: C.text,
    border: 'none',
    textAlign: 'left',
    cursor: interactive ? 'pointer' : 'default',
  };
  return (
    <Tooltip content={fileName} placement="top" triggerStyle={{ display: 'inline-flex', width: 240, maxWidth: '100%' }}>
      <div style={{ position: 'relative', display: 'inline-flex', width: 240, maxWidth: '100%' }}>
        {interactive ? (
          <button
            type="button"
            aria-label={canPreview ? `预览图片：${fileName}` : `查看附件内容：${fileName}`}
            onClick={() => {
              if (canPreview) onPreview?.(file);
              else onOpen?.(file);
            }}
            className="notus-agent-pressable"
            style={transitionButton(commonStyle)}
          >
            {content}
          </button>
        ) : (
          <div style={commonStyle}>{content}</div>
        )}
        {removeButton}
      </div>
    </Tooltip>
  );
}

function AttachmentContentDialog({ open, attachment, message, onClose }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const copyDisabled = isPdfAttachment(attachment) || payload?.canCopy === false || !String(payload?.text || '').trim();

  useEffect(() => {
    if (!open || !attachment) return undefined;
    let cancelled = false;
    const parsed = attachment.parsed && typeof attachment.parsed === 'object' ? attachment.parsed : null;
    const parsedText = String(parsed?.text || '');
    if (parsedText.trim()) {
      setPayload({
        source: parsed.source || attachment.name || '附件',
        contentType: parsed.contentType || parsed.type || 'plaintext',
        status: parsed.status || 'success',
        warning: parsed.warning || null,
        pageCount: parsed.pageCount ?? null,
        parsedAt: parsed.parsedAt || '',
        text: parsedText,
        canCopy: !isPdfAttachment(attachment),
      });
      setError('');
      setLoading(false);
      setCopied(false);
      return undefined;
    }

    setLoading(true);
    setPayload(null);
    setError('');
    setCopied(false);
    fetch('/api/agent/attachments/content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: message?.conversationId || message?.conversation_id || null,
        attachment,
      }),
    }).then(async (response) => {
      const nextPayload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(nextPayload.error || '附件内容读取失败');
      if (!cancelled) setPayload(nextPayload);
    }).catch((fetchError) => {
      if (!cancelled) setError(fetchError.message || '附件内容读取失败');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [attachment, message?.conversationId, message?.conversation_id, open]);

  const handleCopy = useCallback(async () => {
    if (copyDisabled) return;
    try {
      await copyMessageText(payload?.text || '');
      setCopied(true);
      toast('已复制附件内容', 'success');
      window.setTimeout(() => setCopied(false), 2200);
    } catch (copyError) {
      toast(copyError.message || '复制失败', 'error');
    }
  }, [copyDisabled, payload?.text, toast]);

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose}>关闭</Button>
      <Button variant="primary" onClick={handleCopy} disabled={copyDisabled || loading}>
        {copied ? '已复制' : isPdfAttachment(attachment) ? 'PDF 不支持复制' : '复制内容'}
      </Button>
    </>
  );

  return (
    <Dialog open={open} onClose={onClose} title={attachment?.name || '附件内容'} maxWidth={720} footer={footer}>
      <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: C.tertiary }}>
          <span>{fileType(attachment)}</span>
          <span>{attachment?.sizeLabel || fileSize(attachment?.size)}</span>
          {payload?.pageCount ? <span>{payload.pageCount} 页</span> : null}
          {payload?.status && payload.status !== 'success' ? <span>{payload.status === 'partial' ? '部分解析' : '解析异常'}</span> : null}
        </div>
        {payload?.warning ? (
          <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(217,119,87,0.08)', color: C.accentDark, fontSize: 13, lineHeight: 1.7 }}>
            {payload.warning}
          </div>
        ) : null}
        {loading ? (
          <div style={{ minHeight: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.tertiary, fontSize: 14 }}>
            <InlineActionSpinner size={16} />
            <span style={{ marginLeft: 8 }}>正在读取附件内容...</span>
          </div>
        ) : error ? (
          <div style={{ minHeight: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.accentDark, fontSize: 14, textAlign: 'center', lineHeight: 1.7 }}>
            {error}
          </div>
        ) : (
          <pre style={{
            margin: 0,
            maxHeight: 'min(56vh, 520px)',
            overflow: 'auto',
            padding: 14,
            borderRadius: 12,
            background: C.soft,
            color: C.text,
            border: `1px solid ${C.border}`,
            fontSize: 13,
            lineHeight: 1.7,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}>{payload?.text || '没有可展示的附件文本内容。'}</pre>
        )}
      </div>
    </Dialog>
  );
}

function ToolStatusIcon({ status, size = 14 }) {
  if (status === 'failed' || status === 'error') return <Icons.warn size={size} style={{ color: C.accent }} />;
  if (status === 'stopped' || status === 'cancelled') return <Icons.square size={Math.max(10, size - 2)} style={{ color: C.tertiary }} />;
  if (status === 'running') {
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          borderRadius: 999,
          display: 'inline-block',
          boxSizing: 'border-box',
          border: '2px solid rgba(217,119,87,0.20)',
          borderTopColor: C.accent,
          animation: 'spin 0.82s linear infinite',
        }}
      />
    );
  }
  return <Icons.check size={size} stroke={2.4} style={{ color: C.tertiary }} />;
}

function ToolTraceIcon({ step, size = 15 }) {
  const status = String(step?.status || 'done');
  const source = `${step?.tool || ''} ${step?.label || ''}`.toLowerCase();
  if (['failed', 'error'].includes(status)) return <Icons.warn size={size} />;
  if (['waiting', 'action_required'].includes(status)) return <Icons.warn size={size} />;
  if (['stopped', 'cancelled'].includes(status)) return <Icons.square size={Math.max(10, size - 2)} />;
  if (source.includes('mcp')) return <Icons.mcp size={size} />;
  if (source.includes('skill')) return <Icons.skill size={size} />;
  if (source.includes('image') || source.includes('图片')) return <Icons.image size={size} />;
  if (source.includes('search') || source.includes('检索') || source.includes('搜索')) return <Icons.search size={size} />;
  if (source.includes('folder') || source.includes('目录')) return <Icons.folderOpen size={size} />;
  if (source.includes('create') || source.includes('新建')) return <Icons.filePlus size={size} />;
  if (source.includes('file') || source.includes('文件') || source.includes('附件')) return <Icons.file size={size} />;
  if (source.includes('web') || source.includes('网页')) return <Icons.globe size={size} />;
  if (source.includes('ask_question_card') || source.includes('提问') || source.includes('问题')) {
    return step?.questionAnswer ? <Icons.messageCircle size={size} /> : <Icons.hand size={size} />;
  }
  return <Icons.code size={size} />;
}

function buildInteractionHistoryStep(interaction) {
  const questions = Array.isArray(interaction?.payload?.questions) ? interaction.payload.questions : [];
  const answers = interaction?.response?.answers || {};
  const question = questions[0] || {};
  const questionText = String(question.question || question.title || question.label || '').trim();
  const answer = answers?.[question.id] || {};
  const answerText = String(answer.label || answer.value || answer.text || answer.custom_text || '').trim();
  return {
    id: `interaction-${interaction.id}`,
    status: interaction?.status === 'failed' ? 'error' : 'done',
    tool: 'ask_question_card',
    label: interaction?.status === 'answered' ? '已回答问题' : '提问需要处理',
    createdAt: interaction?.answered_at || interaction?.updated_at || interaction?.created_at || '',
    questionAnswer: {
      question: questionText || '已保存提问',
      answer: answerText && answerText !== questionText ? answerText : '',
      answeredAt: formatMessageTimestamp(interaction?.answered_at || interaction?.updated_at || interaction?.created_at || ''),
    },
  };
}

function mergeInteractionStepsIntoTimeline(steps, interactionSteps) {
  if (!interactionSteps.length) return steps;
  const lastQuestionStepIndex = steps.reduce((index, step, currentIndex) => {
    const source = `${step?.tool || ''} ${step?.label || ''}`.toLowerCase();
    return source.includes('ask_question_card') || source.includes('等待回答') ? currentIndex : index;
  }, -1);
  if (lastQuestionStepIndex < 0) return steps.concat(interactionSteps);
  return [
    ...steps.slice(0, lastQuestionStepIndex + 1),
    ...interactionSteps,
    ...steps.slice(lastQuestionStepIndex + 1),
  ];
}

function traceTimestamp(value) {
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatTraceElapsed(milliseconds) {
  const duration = Number(milliseconds);
  if (!Number.isFinite(duration) || duration < 1000) return '不到 1 秒';
  const seconds = Math.max(1, Math.round(duration / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
}

function InlineActionSpinner({ size = 14, color = C.accent }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        display: 'inline-block',
        boxSizing: 'border-box',
        border: '2px solid rgba(217,119,87,0.20)',
        borderTopColor: color,
        animation: 'spin 0.82s linear infinite',
      }}
    />
  );
}

function MessageIconButton({ label, onClick, disabled, active = false, children }) {
  return (
    <Tooltip content={label} placement="top" disabled={disabled}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="notus-agent-pressable"
        style={transitionButton({
          width: 28,
          height: 28,
          borderRadius: 9,
          background: active ? 'rgba(251,228,210,0.42)' : 'transparent',
          color: active ? C.accent : C.secondary,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
          flexShrink: 0,
        })}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function normalizeAgentErrorDetails(value, errorCode = '', requestId = '') {
  const source = String(value || '').trim();
  const safeSource = /<\/?[a-z][^>]*>/i.test(source) ? '服务没有返回可用结果，请稍后重试。' : source;
  const requestMatch = safeSource.match(/请求编号\s*[:：]\s*([^）)\s]+)/i);
  const httpMatch = safeSource.match(/\bHTTP\s*\d{3}\b/i);
  const codeMatch = safeSource.match(/\b[A-Z][A-Z0-9_]{3,}\b/);
  const resolvedRequestId = String(requestId || requestMatch?.[1] || '').trim();
  const message = safeSource
    .replace(/\s*[（(]\s*请求编号\s*[:：]\s*[^）)]*[）)]\s*$/i, '')
    .trim() || 'Agent 任务未完成，请稍后重试。';
  return {
    message,
    code: String(errorCode || httpMatch?.[0] || codeMatch?.[0] || '').trim(),
    requestId: resolvedRequestId,
  };
}

function AgentErrorCard({ title = '任务没有完成', message, errorCode = '', requestId = '', retryMessage = null, onRetry, onResume, resumeLabel = '继续任务' }) {
  const [retrying, setRetrying] = useState(false);
  const details = useMemo(() => normalizeAgentErrorDetails(message, errorCode, requestId), [errorCode, message, requestId]);
  const canRetry = Boolean(retryMessage?.content) && typeof onRetry === 'function';

  const handleRetry = useCallback(async () => {
    if (!canRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetry(retryMessage, { reason: 'retry' });
    } finally {
      setRetrying(false);
    }
  }, [canRetry, onRetry, retryMessage, retrying]);

  return (
    <section className="notus-agent-error-card" role="alert" aria-label="Agent 错误信息">
      <div className="notus-agent-error-card__main">
        <div className="notus-agent-error-card__icon" aria-hidden="true"><Icons.warn size={18} /></div>
        <div className="notus-agent-error-card__content">
          <div className="notus-agent-error-card__title">{title}</div>
          <p className="notus-agent-error-card__message">{details.message}</p>
          {details.code || details.requestId ? (
            <div className="notus-agent-error-card__meta">
              {details.code ? <span>{details.code}</span> : null}
              {details.requestId ? <span>请求编号：{details.requestId}</span> : null}
            </div>
          ) : null}
        </div>
      </div>
      <div className="notus-agent-error-card__footer">
        <div className="notus-agent-error-card__actions">
          {typeof onResume === 'function' ? <button type="button" className="notus-agent-error-card__secondary notus-agent-pressable" onClick={onResume}>{resumeLabel}</button> : null}
          <button type="button" className="notus-agent-error-card__primary notus-agent-pressable" onClick={() => { void handleRetry(); }} disabled={!canRetry || retrying}>
            {retrying ? <InlineActionSpinner size={14} color="#fff" /> : <Icons.refresh size={14} />}
            <span>{retrying ? '重新发送中' : '重试'}</span>
          </button>
        </div>
      </div>
    </section>
  );
}

function CopyMessageButton({ text, successMessage = '已复制消息', disabled = false }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  const handleCopy = useCallback(async () => {
    try {
      await copyMessageText(text);
      toast(successMessage, 'success');
      setCopied(true);
    } catch (error) {
      toast(error.message || '复制失败', 'error');
    }
  }, [successMessage, text, toast]);

  useEffect(() => {
    if (!copied) return undefined;

    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, 3000);

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [copied]);

  return (
    <MessageIconButton label="复制" onClick={handleCopy} disabled={disabled} active={copied}>
      {copied ? <Icons.check size={14} /> : <Icons.copy size={14} />}
    </MessageIconButton>
  );
}

function ToolChain({ steps, loading, sessionStatus = '', sessionId = '', startedAt = '', finishedAt = '', errorMessage = '', onAction, onRetryMessage, retryMessage = null, onPreviewImages }) {
  // 只展示服务端已经确认的真实动作，内部循环、排队和推测性 loading 不进入执行记录。
  const visibleSteps = useMemo(() => (Array.isArray(steps) ? steps : []), [steps]);
  const agentErrorStep = [...visibleSteps].reverse().find((step) => step?.errorType === 'agent') || null;
  const renderedSteps = useMemo(() => visibleSteps.filter((step) => step?.errorType !== 'agent'), [visibleSteps]);
  const fallbackErrorStep = !agentErrorStep && String(errorMessage || '').trim()
    ? {
      label: '请求失败',
      errorType: 'agent',
      errorMessage,
      errorCode: '',
      requestId: '',
    }
    : null;
  const displayedErrorStep = agentErrorStep || fallbackErrorStep;
  const [expanded, setExpanded] = useState({});
  const liveSession = Boolean(loading) || ['created', 'queued', 'running'].includes(sessionStatus);
  const tailStatus = visibleSteps[visibleSteps.length - 1]?.status || 'done';
  const hasActionRequired = Boolean(displayedErrorStep)
    || ['waiting', 'action_required'].includes(tailStatus)
    || ['waiting_confirm', 'waiting_interaction', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery'].includes(sessionStatus);
  const hasViewedImages = visibleSteps.some((step) => Array.isArray(step.images) && step.images.length > 0);
  // 已完成的历史记录通常保持收起；但图片查看属于需要可见确认的结果，不能被自动折叠隐藏。
  const [traceExpanded, setTraceExpanded] = useState(() => liveSession || hasActionRequired || hasViewedImages);
  const [now, setNow] = useState(() => Date.now());
  const stepKey = visibleSteps.map((step, index) => step.id || step.label || index).join('|');

  useEffect(() => {
    setExpanded((prev) => {
      const next = {};
      visibleSteps.forEach((step, index) => {
        const id = String(step.id || step.label || index);
        const isActiveTail = index === visibleSteps.length - 1 && ['running', 'waiting', 'action_required', 'failed', 'error', 'stopped', 'cancelled'].includes(step.status);
        if (prev[id] || step.open || isActiveTail) next[id] = true;
      });
      return next;
    });
  }, [stepKey, visibleSteps]);

  const hasRunning = liveSession || tailStatus === 'running';
  const hasFailed = ['failed', 'error', 'stopped', 'cancelled'].includes(tailStatus);
  const taskStartedAt = traceTimestamp(startedAt);
  const taskFinishedAt = traceTimestamp(finishedAt);
  const firstTimestamp = taskStartedAt
    || visibleSteps.map((step) => traceTimestamp(step.createdAt)).filter(Boolean)[0]
    || 0;
  const lastStepTimestamp = visibleSteps.map((step) => traceTimestamp(step.updatedAt || step.createdAt)).filter(Boolean).at(-1);
  const lastTimestamp = hasRunning ? now : taskFinishedAt || lastStepTimestamp || firstTimestamp;
  const elapsed = firstTimestamp ? formatTraceElapsed((hasRunning ? now : lastTimestamp) - firstTimestamp) : '';
  const statusLabel = hasFailed || hasActionRequired
    ? '需要处理'
    : sessionStatus === 'queued'
      ? `任务已提交${elapsed ? ` · 已等待 ${elapsed}` : ''}`
      : hasRunning
        ? `正在处理${elapsed ? ` ${elapsed}` : ''}`
        : `已处理${elapsed ? ` ${elapsed}` : ''}`;

  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  useEffect(() => {
    if (!liveSession && !hasActionRequired && !hasViewedImages) setTraceExpanded(false);
  }, [hasActionRequired, hasViewedImages, liveSession]);

  if (!visibleSteps.length && !liveSession && !displayedErrorStep) return null;

  return (
    <section className="notus-agent-toolchain" aria-label="Agent 执行记录">
      <div className="notus-agent-toolchain__header">
        <button type="button" className="notus-agent-toolchain__summary-toggle notus-agent-pressable" aria-expanded={traceExpanded} onClick={() => setTraceExpanded((value) => !value)}>
          <span role="status" aria-live="polite">{statusLabel}</span>
          <Icons.chevronRight size={15} aria-hidden="true" />
        </button>
        {hasRunning && typeof onAction === 'function' ? <button type="button" className="notus-agent-toolchain__stop notus-agent-pressable" onClick={() => onAction('stop_agent', null, sessionId)} aria-label="停止当前任务">停止</button> : null}
      </div>
      {traceExpanded ? <>
        {renderedSteps.length > 0 ? <div className="notus-agent-toolchain__steps">
          {renderedSteps.map((step, index) => {
          const stepId = String(step.id || step.label || index);
          const open = Boolean(expanded[stepId]);
          const hasDetails = Boolean(step.detail || step.tool || step.input || step.result || step.action || step.images?.length || step.questionAnswer);
          return (
            <div key={stepId} className="notus-agent-toolchain__step notus-agent-toolchain__step--enter" style={{ '--notus-step-index': Math.min(index, 6) }}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`agent-step-${stepId}`}
                disabled={!hasDetails}
                onClick={() => setExpanded((prev) => ({ ...prev, [stepId]: !prev[stepId] }))}
                className={`notus-agent-tool-row notus-agent-toolchain__row${hasDetails ? '' : ' is-static'}`}
              >
                <span className="notus-agent-toolchain__icon">
                  <ToolTraceIcon step={step} size={14} />
                </span>
                <span className="notus-agent-toolchain__label">{step.label}</span>
                {hasDetails ? <Icons.chevronRight size={14} className={open ? 'notus-agent-tool-chevron is-open' : 'notus-agent-tool-chevron'} /> : null}
              </button>
              {open ? (
                <div id={`agent-step-${stepId}`} className="notus-agent-toolchain__detail">
                  {step.questionAnswer ? <div className="notus-agent-toolchain__question-answer">
                    <div className="notus-agent-toolchain__question-label">问题</div>
                    <div>{step.questionAnswer.question}</div>
                    {step.questionAnswer.answer ? <><div className="notus-agent-toolchain__question-label">回答</div><div>{step.questionAnswer.answer}</div></> : <div className="notus-agent-toolchain__question-saved">回答已保存</div>}
                    {step.questionAnswer.answeredAt ? <div className="notus-agent-toolchain__question-time">{step.questionAnswer.answeredAt}</div> : null}
                  </div> : null}
                  {step.detail ? <div className="notus-agent-toolchain__description">{step.detail}</div> : null}
                  {step.tool && !step.questionAnswer && step.errorType !== 'agent' ? <div className="notus-agent-toolchain__code">
                    <div className="notus-agent-toolchain__code-title"><Icons.code size={12} /> {step.tool}</div>
                    {step.input ? <ToolPayload label="调用参数" value={step.input} /> : null}
                    {step.result ? <ToolPayload label="调用结果" value={step.result} /> : null}
                  </div> : null}
                  {Array.isArray(step.images) && step.images.length > 0 ? (
                    <div className="notus-agent-toolchain__images" aria-label="已查看的图片">
                      {step.images.map((image, imageIndex) => image?.preview_url ? (
                        <button
                          key={image.id || image.preview_url || imageIndex}
                          type="button"
                          className="notus-agent-toolchain__image-preview notus-agent-pressable"
                          onClick={() => onPreviewImages?.(step.images, image)}
                          aria-label={`预览已查看图片 ${imageIndex + 1}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={image.preview_url} alt={image.alt || image.name || '已查看图片'} />
                        </button>
                      ) : null)}
                    </div>
                  ) : null}
                  {step.action && step.errorType !== 'agent' && typeof onAction === 'function' ? (
                    <div className="notus-agent-toolchain__actions">
                      <button
                        type="button"
                        onClick={() => onAction(step.action, step, sessionId)}
                        className="notus-agent-pressable"
                      >
                        {step.actionLabel || '继续任务'}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
          })}
        </div> : null}
        {displayedErrorStep ? (
          <AgentErrorCard
            title={displayedErrorStep.label || '任务没有完成'}
            message={displayedErrorStep.errorMessage || displayedErrorStep.detail}
            errorCode={displayedErrorStep.errorCode}
            requestId={displayedErrorStep.requestId}
            retryMessage={retryMessage}
            onRetry={onRetryMessage}
            onResume={displayedErrorStep.action && typeof onAction === 'function'
              ? () => onAction(displayedErrorStep.action, displayedErrorStep, sessionId)
              : undefined}
            resumeLabel={displayedErrorStep.actionLabel || '继续任务'}
          />
        ) : null}
      </> : null}
    </section>
  );
}

function formatToolPayload(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  try {
    return JSON.stringify(JSON.parse(source), null, 2);
  } catch {
    return source;
  }
}

function ToolPayload({ label, value }) {
  const content = formatToolPayload(value);
  if (!content) return null;
  return (
    <section className="notus-agent-toolchain__payload" aria-label={label}>
      <div className="notus-agent-toolchain__payload-label">{label}</div>
      <pre>{content}</pre>
    </section>
  );
}

function operationItems(operationSet) {
  if (!operationSet) return [];
  if (operationSet.revision_type === 'file_revision' || operationSet.revision?.type === 'file_revision') {
    const revision = operationSet.revision || {};
    return [{
      id: `revision-${operationSet.id}`,
      patchIndex: 0,
      type: 'file_revision',
      change_type: 'file_revision',
      file_path: revision.file_path || operationSet.revision_file_path || '',
      old_path: '',
      new_path: '',
      status: operationSet.status || 'pending',
      handled_at: revision.applied_at || revision.discarded_at || revision.rolled_back_at || null,
      error: revision.error_message || '',
      diff_hunks: Array.isArray(revision.diff_hunks) ? revision.diff_hunks : [],
      media_changes: Array.isArray(operationSet.media_changes) ? operationSet.media_changes : [],
    }];
  }
  if (Array.isArray(operationSet.patches) && operationSet.patches.length > 0) {
    return operationSet.patches.map((patch, index) => ({
      id: patch.patch_id || patch.id || 'patch-' + index,
      patchIndex: index,
      type: 'str_replace',
      file_path: patch.file_path || patch.folder_path || patch.path || patch.old_path || patch.new_path || '',
      change_type: patch.change_type || patch.type || '',
      old_path: patch.old_path || '',
      new_path: patch.new_path || '',
      old: patch.old,
      new: patch.new,
      status: patch.status || 'pending',
      handled_at: patch.handled_at || null,
      error: patch.error || '',
      media_changes: (Array.isArray(operationSet.media_changes) ? operationSet.media_changes : [])
        .filter((change) => String(change?.file_path || '') === String(patch.file_path || '')),
    }));
  }
  return Array.isArray(operationSet.operations) ? operationSet.operations : [];
}

function patchStatusMeta(status) {
  const normalized = String(status || 'pending');
  if (normalized === 'applied') return { label: '已应用', color: '#166534', bg: 'rgba(187,247,208,0.50)' };
  if (normalized === 'auto_applied') return { label: '已自动应用', color: '#166534', bg: 'rgba(187,247,208,0.50)' };
  if (normalized === 'rolled_back') return { label: '已回滚', color: '#991B1B', bg: 'rgba(254,202,202,0.52)' };
  if (normalized === 'discarded') return { label: '已废弃', color: C.tertiary, bg: C.muted };
  if (normalized === 'superseded') return { label: '已被新预览替代', color: C.tertiary, bg: C.muted };
  if (normalized === 'stale') return { label: '文件已变化', color: C.accentDark, bg: 'rgba(217,119,87,0.12)' };
  if (normalized === 'apply_failed') return { label: '应用失败', color: C.accentDark, bg: 'rgba(217,119,87,0.12)' };
  if (normalized === 'rollback_conflict') return { label: '回滚冲突', color: C.accentDark, bg: 'rgba(217,119,87,0.12)' };
  if (normalized === 'failed') return { label: '处理失败', color: C.accentDark, bg: 'rgba(217,119,87,0.12)' };
  return { label: '待确认', color: C.accent, bg: 'rgba(251,228,210,0.42)' };
}

function isPatchPending(item) {
  const status = String(item?.status || 'pending');
  return status === 'pending' || status === 'failed';
}

function isFileSystemOperation(operation = {}) {
  return ['create_folder', 'rename_folder', 'move_folder', 'move_file', 'delete_folder'].includes(String(operation?.change_type || '').trim());
}

function operationLabel(operation = {}) {
  const type = String(operation.change_type || '').trim();
  return {
    file_revision: '全文修订',
    create_folder: '新建目录',
    rename_folder: '重命名目录',
    move_folder: '移动目录',
    move_file: '移动文件',
    delete_folder: '删除目录',
    create: '新建文件',
  }[type] || '修改文件';
}

function buildDiffLines(operation = {}) {
  if (operation.change_type === 'file_revision' && Array.isArray(operation.diff_hunks)) {
    return operation.diff_hunks.flatMap((hunk, hunkIndex) => [
      { type: 'hunk', content: `@@ -${hunk.oldStart || 0},${hunk.oldLines || 0} +${hunk.newStart || 0},${hunk.newLines || 0} @@`, key: `hunk-${hunkIndex}` },
      ...(Array.isArray(hunk.lines) ? hunk.lines.map((line) => ({
        type: line.type === 'insert' ? 'add' : line.type === 'delete' ? 'remove' : 'context',
        content: line.content || '',
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
      })) : []),
    ]);
  }
  if (isFileSystemOperation(operation)) {
    const type = String(operation.change_type || '').trim();
    const removed = [];
    const added = [];
    if (type === 'create_folder') {
      added.push(`目录：${operation.new_path || operation.file_path || operation.new || ''}`);
    } else if (type === 'delete_folder') {
      removed.push(`目录：${operation.old_path || operation.file_path || operation.old || ''}`);
      String(operation.old || '').split('\n').filter(Boolean).forEach((line) => removed.push(`包含：${line}`));
    } else {
      removed.push(`原路径：${operation.old_path || operation.old || ''}`);
      added.push(`新路径：${operation.new_path || operation.new || ''}`);
    }
    return [
      ...removed.map((content) => ({ type: 'remove', content })),
      ...added.map((content) => ({ type: 'add', content })),
    ];
  }
  return [
    ...(operation.old ? String(operation.old).split('\n').map((line) => ({ type: 'remove', content: line })) : []),
    ...(operation.new ? String(operation.new).split('\n').map((line) => ({ type: 'add', content: line })) : []),
    ...(operation.content ? String(operation.content).split('\n').map((line) => ({ type: 'add', content: line })) : []),
  ];
}

function operationSetSummary(operationSet) {
  const operations = operationItems(operationSet);
  const fileCount = new Set(
    operations
      .map((item) => item.file_path || item.new_path || item.old_path || item.path)
      .filter(Boolean)
  ).size || operations.length;
  const pendingCount = operations.filter(isPatchPending).length;
  const autoAppliedCount = operations.filter((item) => String(item.status || '') === 'auto_applied').length;
  const appliedCount = operations.filter((item) => ['applied', 'auto_applied'].includes(String(item.status || ''))).length;
  const rolledBackCount = operations.filter((item) => String(item.status || '') === 'rolled_back').length;
  const discardedCount = operations.filter((item) => String(item.status || '') === 'discarded').length;
  const failedCount = operations.filter((item) => String(item.status || '') === 'failed').length;
  const staleCount = operations.filter((item) => String(item.status || '') === 'stale').length;
  const applyFailedCount = operations.filter((item) => String(item.status || '') === 'apply_failed').length;
  const rollbackConflictCount = operations.filter((item) => String(item.status || '') === 'rollback_conflict').length;
  const supersededCount = operations.filter((item) => String(item.status || '') === 'superseded').length;
  const revisionMode = operations.some((item) => item.change_type === 'file_revision');
  const fileSystemMode = operations.some((item) => isFileSystemOperation(item));
  const mediaCount = operations.reduce((total, item) => total + (Array.isArray(item.media_changes) ? item.media_changes.length : 0), 0);
  let detail = revisionMode ? '本次任务的全文修订预览已生成' : fileSystemMode ? '本次任务的文件/目录操作预览已生成' : '本次任务的文件修改预览已生成';
  if (pendingCount > 0) detail = `${pendingCount} 个文件待确认`;
  else if (autoAppliedCount === operations.length && operations.length > 0) detail = '已自动应用，可查看详情或逐文件回滚';
  else if (appliedCount > 0 || rolledBackCount > 0 || discardedCount > 0) detail = `已应用 ${appliedCount} 个，已回滚 ${rolledBackCount} 个，已废弃 ${discardedCount} 个`;
  if (failedCount > 0) detail = `${detail}，${failedCount} 个处理失败`;
  if (staleCount > 0) detail = `${staleCount} 个文件已变化，需要重新生成`;
  if (applyFailedCount > 0) detail = `${applyFailedCount} 个文件应用失败`;
  if (rollbackConflictCount > 0) detail = `${rollbackConflictCount} 个文件无法安全回滚`;
  if (supersededCount > 0) detail = `${supersededCount} 个预览已被新修订替代`;
  if (mediaCount > 0) detail = `${detail}，包含 ${mediaCount} 项图片变更`;
  return { operations, fileCount, pendingCount, detail, fileSystemMode, revisionMode, mediaCount };
}

function OperationSetCard({ operationSet, onOpenDetail }) {
  if (!operationSet) return null;
  const summary = operationSetSummary(operationSet);
  if (summary.operations.length === 0) return null;
  return (
    <div style={{
      marginTop: 12,
      background: C.soft,
      borderRadius: 16,
      padding: 16,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.50)',
      flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <span style={{ width: 32, height: 32, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: C.secondary, background: '#fff', boxShadow: '0 1px 6px rgba(45,45,45,0.08), inset 0 0 0 1px rgba(229,227,216,0.95)' }}>
          <Icons.edit size={15} />
        </span>
        <div style={{ display: 'grid', gap: 3, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{summary.fileCount} {summary.revisionMode ? '个文件全文修订' : summary.fileSystemMode ? '项文件/目录操作' : '个文件发生变更'}</div>
          <div style={{ fontSize: 11, color: C.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary.detail}</div>
        </div>
      </div>
      <button type="button" className="notus-agent-pressable" onClick={() => onOpenDetail?.(operationSet)} style={transitionButton({ minWidth: 0, height: 32, padding: '0 16px', borderRadius: 8, background: C.accent, color: '#fff', boxShadow: '0 1px 6px rgba(217, 119, 87, 0.24)', fontSize: 12, fontWeight: 800 })}>查看详情</button>
    </div>
  );
}

function isDocumentPath(value) {
  return /\.md$/i.test(String(value || '').trim());
}

function DiffFileLink({ path, onOpenFile, style, children }) {
  const label = children || path;
  if (!isDocumentPath(path)) return <span style={style}>{label}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpenFile?.(path)}
      style={transitionButton({
        padding: 0,
        border: 0,
        background: 'transparent',
        color: C.accent,
        font: 'inherit',
        textAlign: 'left',
        textDecoration: 'underline',
        textUnderlineOffset: 2,
        cursor: 'pointer',
        ...style,
      })}
    >
      {label}
    </button>
  );
}

function diffSidebarFileName(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || '全文';
}

function DiffDialog({ operationSet, open, onClose, onApplyAll, onApplyFile, onRollbackFile, onDiscardFile, onOpenFile }) {
  const operations = operationItems(operationSet);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busyKey, setBusyKey] = useState('');
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false);
  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(operations.length - 1, 0)));
    setFileDrawerOpen(false);
  }, [operationSet?.id, operations.length]);
  if (!open) return null;
  const activeOperation = operations[Math.min(selectedIndex, Math.max(operations.length - 1, 0))] || {};
  const activePath = activeOperation.new_path || activeOperation.file_path || activeOperation.old_path || activeOperation.path || '全文';
  const diffLines = buildDiffLines(activeOperation);
  const mediaChanges = Array.isArray(activeOperation.media_changes) ? activeOperation.media_changes : [];
  const activeStatus = patchStatusMeta(activeOperation.status);
  const pendingCount = operations.filter(isPatchPending).length;
  const isRevision = activeOperation.change_type === 'file_revision';
  const activeNormalizedStatus = String(activeOperation.status || 'pending');
  const canApply = (isRevision ? activeNormalizedStatus === 'pending' : isPatchPending(activeOperation)) && typeof onApplyFile === 'function';
  const canApplyAll = pendingCount > 0 && typeof onApplyAll === 'function';
  const canRollback = (isRevision ? ['applied', 'rollback_conflict'].includes(activeNormalizedStatus) : !['rolled_back', 'discarded'].includes(activeNormalizedStatus)) && typeof onRollbackFile === 'function';
  const canDiscard = isRevision && ['pending', 'stale', 'apply_failed', 'rollback_conflict'].includes(activeNormalizedStatus) && typeof onDiscardFile === 'function';
  const moveToNextPending = () => {
    const next = operations.findIndex((item, index) => index !== selectedIndex && isPatchPending(item));
    if (next >= 0) setSelectedIndex(next);
  };
  const runFileAction = async (kind) => {
    const key = `${kind}-${activeOperation.patchIndex}`;
    setBusyKey(key);
    try {
      if (kind === 'apply') await onApplyFile?.(operationSet, activeOperation.patchIndex);
      else if (kind === 'discard') await onDiscardFile?.(operationSet, activeOperation.patchIndex);
      else await onRollbackFile?.(operationSet, activeOperation.patchIndex);
      moveToNextPending();
    } finally {
      setBusyKey('');
    }
  };
  const runApplyAll = async () => {
    setBusyKey('apply-all');
    try {
      await onApplyAll?.(operationSet);
      onClose?.();
    } finally {
      setBusyKey('');
    }
  };
  const openDiffFile = (path) => {
    setFileDrawerOpen(false);
    onClose?.();
    onOpenFile?.(path);
  };

  const dialog = (
    <div className="notus-diff-dialog__backdrop" style={{ background: 'rgba(45,45,45,0.28)' }}>
      <div className="notus-diff-dialog" role="dialog" aria-modal="true" aria-label="修改详情">
        <div className="notus-diff-dialog__header" style={{ borderBottom: '1px solid ' + C.border, background: C.page }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: C.text }}>修改详情</div>
            {pendingCount > 0 ? <div style={{ marginTop: 3, fontSize: 12, color: C.tertiary }}>{pendingCount} 个文件待确认</div> : null}
          </div>
          <div className="notus-diff-dialog__header-actions">
            <button type="button" className="notus-diff-dialog__file-toggle notus-agent-pressable" aria-label="打开文件列表" aria-expanded={fileDrawerOpen} onClick={() => setFileDrawerOpen(true)} style={transitionButton({ borderRadius: 10, background: '#fff', color: C.secondary, alignItems: 'center', justifyContent: 'center', gap: 6, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.95)' })}><Icons.list size={15} /><span>文件</span></button>
            <button type="button" aria-label="关闭" onClick={onClose} style={transitionButton({ width: 34, height: 34, borderRadius: 10, background: '#fff', color: C.secondary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.95)' })}><Icons.x size={16} /></button>
          </div>
        </div>
        <div className="notus-diff-dialog__body">
          {fileDrawerOpen ? <button type="button" className="notus-diff-dialog__file-backdrop" aria-label="关闭文件列表" onClick={() => setFileDrawerOpen(false)} /> : null}
          <nav className={['notus-diff-dialog__sidebar', fileDrawerOpen ? 'is-mobile-open' : ''].filter(Boolean).join(' ')} aria-label="文件列表" style={{ borderRight: '1px solid ' + C.border, background: C.page }}>
            {operations.map((operation, index) => {
              const pathText = operation.new_path || operation.file_path || operation.old_path || operation.path || '全文';
              const active = index === selectedIndex;
              const statusMeta = patchStatusMeta(operation.status);
              return (
                <div key={operation.id || index} style={{ display: 'grid', gap: 4, padding: '9px 10px', borderRadius: 10, background: active ? '#fff' : 'transparent', color: active ? C.text : C.secondary, boxShadow: active ? 'inset 0 0 0 1px rgba(229,227,216,0.92)' : 'none' }}>
                  <button type="button" onClick={() => setSelectedIndex(index)} style={transitionButton({ width: '100%', padding: 0, background: 'transparent', color: 'inherit', textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 })}>
                    <span style={{ minWidth: 0, fontSize: 12, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{operationLabel(operation)}</span>
                    <span style={{ flexShrink: 0, width: 7, height: 7, borderRadius: 999, background: statusMeta.color }} />
                  </button>
                  <DiffFileLink path={pathText} onOpenFile={openDiffFile} style={{ minWidth: 0, fontSize: 10.5, color: isDocumentPath(pathText) ? C.accent : C.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {diffSidebarFileName(pathText)}
                  </DiffFileLink>
                </div>
              );
            })}
          </nav>
          <div className="notus-diff-dialog__content" style={{ background: '#FAFAFA' }}>
            <div className="notus-diff-dialog__content-header" style={{ borderBottom: '1px solid ' + C.border, background: '#fff' }}>
              <DiffFileLink path={activePath} onOpenFile={openDiffFile} style={{ minWidth: 0, fontSize: 12, color: isDocumentPath(activePath) ? C.accent : C.secondary, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} />
              <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: activeStatus.color, background: activeStatus.bg, borderRadius: 999, padding: '4px 8px' }}>{activeStatus.label}</span>
            </div>
            <div className="notus-diff-dialog__scroll" style={{ overscrollBehavior: 'contain' }}>
              {activeOperation.error ? (
                <div style={{ margin: '0 12px 12px', padding: '10px 12px', borderRadius: 10, background: 'rgba(217,119,87,0.10)', color: C.accentDark, fontSize: 12, lineHeight: 1.65, boxShadow: 'inset 0 0 0 1px rgba(217,119,87,0.18)' }}>
                  {activeOperation.error}
                </div>
              ) : null}
              {mediaChanges.length > 0 ? (
                <div style={{ margin: '0 12px 14px', padding: 12, borderRadius: 12, background: '#fff', boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.95)' }}>
                  <div style={{ marginBottom: 10, fontSize: 12, fontWeight: 800, color: C.secondary }}>图片变更 · {mediaChanges.length}</div>
                  <div style={{ display: 'grid', gap: 10 }}>
                    {mediaChanges.map((change, index) => {
                      const kind = String(change?.kind || 'add');
                      const label = kind === 'remove' ? '移除图片' : kind === 'replace' ? '替换图片' : '';
                      const tone = kind === 'remove' ? '#991B1B' : kind === 'replace' ? '#9A6700' : '#166534';
                      const renderImage = (image, title = '') => {
                        const src = String(image?.preview_src || image?.src || '');
                        if (!src) return null;
                        return (
                          <div style={{ minWidth: 0, display: 'grid', gap: 5 }}>
                            {title ? <span style={{ fontSize: 10.5, color: C.tertiary }}>{title}</span> : null}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={src} alt={image?.alt || title} style={{ width: 'min(220px, 100%)', maxHeight: 150, objectFit: 'contain', objectPosition: 'left top', borderRadius: 8, background: C.soft, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.8)' }} />
                            {image?.alt ? <span style={{ fontSize: 10.5, color: C.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{image.alt}</span> : null}
                          </div>
                        );
                      };
                      return (
                        <div key={change.id || index} style={{ padding: 10, borderRadius: 10, background: C.soft, display: 'grid', gap: 8 }}>
                          {label ? <span style={{ fontSize: 11, fontWeight: 800, color: tone }}>{label}</span> : null}
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                            {kind !== 'add' ? renderImage(change.before, kind === 'replace' ? '原图' : '已移除') : null}
                            {kind === 'replace' ? <span style={{ marginTop: 55, color: C.tertiary }}>→</span> : null}
                            {kind !== 'remove' ? renderImage(change.after, kind === 'replace' ? '新图' : '') : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="notus-diff-dialog__lines" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {diffLines.length === 0 ? <div style={{ padding: '0 14px', color: C.tertiary }}>没有可展示的 diff 内容。</div> : diffLines.map((line, index) => {
                  const hunk = line.type === 'hunk';
                  const remove = line.type === 'remove';
                  const add = line.type === 'add';
                  return (
                    <div key={index} style={{ display: 'flex', minWidth: '100%', padding: '0 14px', background: hunk ? 'rgba(229,227,216,0.45)' : add ? 'rgba(187,247,208,0.45)' : remove ? 'rgba(254,202,202,0.45)' : 'transparent', color: hunk ? C.tertiary : add ? '#166534' : remove ? '#991B1B' : C.secondary, textDecoration: remove ? 'line-through' : 'none' }}>
                      <span style={{ width: 20, flex: '0 0 auto', color: '#BDBBB3', textAlign: 'right', paddingRight: 8, userSelect: 'none' }}>{hunk ? ' ' : add ? '+' : remove ? '-' : ' '}</span>
                      <span style={{ flex: '0 0 auto', whiteSpace: 'pre' }}>{line.content}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="notus-diff-dialog__footer" style={{ borderTop: '1px solid ' + C.border, background: '#fff' }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.6, color: C.tertiary }}>仅当前对话可应用或回滚修改；新建/切换对话、预览已处理、会话权限过期或文件内容变化后，应用与回滚会失效。</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {canDiscard ? (
                  <button type="button" disabled={Boolean(busyKey)} onClick={() => runFileAction('discard')} style={transitionButton({ height: 32, padding: '0 11px', borderRadius: 9, background: C.muted, color: C.secondary, fontSize: 12, fontWeight: 800, opacity: busyKey ? 0.7 : 1, cursor: busyKey ? 'not-allowed' : 'pointer' })}>废弃预览</button>
                ) : null}
                <button type="button" disabled={!canRollback || Boolean(busyKey)} onClick={() => runFileAction('rollback')} style={transitionButton({ height: 32, padding: '0 11px', borderRadius: 9, background: canRollback ? 'rgba(254,202,202,0.65)' : C.muted, color: canRollback ? '#991B1B' : C.tertiary, fontSize: 12, fontWeight: 800, opacity: busyKey ? 0.7 : 1, cursor: (!canRollback || busyKey) ? 'not-allowed' : 'pointer' })}>回滚修改</button>
                <button type="button" disabled={!canApply || Boolean(busyKey)} onClick={() => runFileAction('apply')} style={transitionButton({ height: 32, padding: '0 12px', borderRadius: 9, background: canApply ? '#16A34A' : C.muted, color: canApply ? '#fff' : C.tertiary, fontSize: 12, fontWeight: 800, opacity: busyKey ? 0.7 : 1, cursor: (!canApply || busyKey) ? 'not-allowed' : 'pointer' })}>应用修改</button>
                <button type="button" disabled={!canApplyAll || Boolean(busyKey)} onClick={runApplyAll} style={transitionButton({ height: 32, padding: '0 13px', borderRadius: 9, background: canApplyAll ? C.accent : C.muted, color: canApplyAll ? '#fff' : C.tertiary, fontSize: 12, fontWeight: 800, opacity: busyKey ? 0.7 : 1, cursor: (!canApplyAll || busyKey) ? 'not-allowed' : 'pointer' })}>全部应用</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? null : createPortal(dialog, document.body);
}

function UserMessageRow({ message, disabled, removing = false, onResendMessage, onOpenAttachment, onPreviewMention, onPrefetchMention, onPreviewImages }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(message.content || ''));
  const [sending, setSending] = useState(false);
  const [submittedContent, setSubmittedContent] = useState(null);
  const canEdit = Boolean(String(message.content || '').trim()) && typeof onResendMessage === 'function';
  const displayContent = submittedContent === null ? String(message.content || '') : submittedContent;

  useEffect(() => {
    if (!editing) setDraft(displayContent);
  }, [displayContent, editing]);

  const submitEdit = useCallback(async () => {
    const nextContent = String(draft || '').trim();
    if (!canEdit || !nextContent || sending) return;
    setSending(true);
    setSubmittedContent(nextContent);
    setEditing(false);
    try {
      const sent = await onResendMessage(message, {
        reason: 'rewrite',
        content: nextContent,
      });
      if (sent === false) {
        setSubmittedContent(null);
        setEditing(true);
      }
    } finally {
      setSending(false);
    }
  }, [canEdit, draft, message, onResendMessage, sending]);

  const messageMedia = dedupeAgentMedia(message.attachments);
  const messageImages = messageMedia.filter(isImageMedia);
  const messageAttachments = messageMedia.filter((file) => !isImageMedia(file));
  const hasTextContent = Boolean(String(message.content || '').trim() || (Array.isArray(message.mentions) && message.mentions.length > 0));
  const timestamp = formatMessageTimestamp(message.createdAt);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, minWidth: 0, maxWidth: '100%', overflow: 'hidden', opacity: removing ? 0 : 1, transform: removing ? 'translateY(-6px)' : 'translateY(0)', transition: 'opacity 220ms ease, transform 220ms ease' }}>
      {messageAttachments.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, minWidth: 0, maxWidth: '100%' }}>
          {messageAttachments.map((file) => (
            <FileChip
              key={file.id || file.name}
              file={file}
              readOnly
              onOpen={onOpenAttachment ? (attachment) => onOpenAttachment(attachment, message) : undefined}
            />
          ))}
        </div>
      ) : null}
      {messageImages.length > 0 ? (
        <div data-message-image-row="true" style={{ display: 'grid', gap: 5, justifyItems: 'start', alignSelf: 'flex-end', minWidth: 0, maxWidth: '100%' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, minWidth: 0, maxWidth: '100%' }}>
            {messageImages.map((file) => (
              <FileChip
                key={file.id || file.name}
                file={file}
                readOnly
                imageOnly
                imageSize={112}
                onPreview={(selectedFile) => onPreviewImages?.(message, selectedFile)}
              />
            ))}
          </div>
        </div>
      ) : null}
      {editing ? (
        <div style={{ width: 'min(80%, 560px)', minWidth: 0, display: 'grid', gap: 8 }}>
          <textarea
            value={draft}
            disabled={disabled || sending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submitEdit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
                setDraft(displayContent);
              }
            }}
            autoFocus
            style={{ width: '100%', minHeight: 96, maxHeight: 220, resize: 'vertical', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 16, border: `1px solid ${C.border}`, outline: 'none', background: '#fff', color: C.text, fontSize: 14, lineHeight: 1.7, fontFamily: 'inherit', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" disabled={sending} onClick={() => { setEditing(false); setDraft(String(message.content || '')); }} style={transitionButton({ height: 30, padding: '0 10px', borderRadius: 9, background: C.soft, color: C.secondary, fontSize: 12, fontWeight: 800, opacity: sending ? 0.55 : 1, cursor: sending ? 'not-allowed' : 'pointer' })}>取消</button>
            <button type="button" disabled={disabled || sending || !String(draft || '').trim()} onClick={() => { void submitEdit(); }} style={transitionButton({ height: 30, padding: '0 12px', borderRadius: 9, background: C.accent, color: '#fff', fontSize: 12, fontWeight: 800, opacity: (disabled || sending || !String(draft || '').trim()) ? 0.55 : 1, cursor: (disabled || sending || !String(draft || '').trim()) ? 'not-allowed' : 'pointer' })}>发送</button>
          </div>
        </div>
      ) : hasTextContent ? (
        <div data-message-bubble="true" style={{ maxWidth: '80%', minWidth: 0, padding: '13px 18px', borderRadius: '20px 20px 6px 20px', background: C.muted, color: C.text, fontSize: 15, lineHeight: 1.7, overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          <div className="notus-message-mention-flow">
            {submittedContent === null ? (message.mentionSegments || []).map((segment, index) => segment.type === 'mention' ? (
              <MentionItem key={`${segment.mention?.id || index}-${index}`} {...segment.mention} inline readonly onPreview={onPreviewMention} onPrefetch={onPrefetchMention} />
            ) : <span key={`text-${index}`} style={{ whiteSpace: 'pre-wrap' }}>{segment.text}</span>) : <span style={{ whiteSpace: 'pre-wrap' }}>{displayContent}</span>}
          </div>
        </div>
      ) : null}
      {!editing && (displayContent.trim() || timestamp) ? (
        <div aria-label="用户消息操作" style={{ width: hasTextContent ? 'min(80%, 560px)' : undefined, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, minHeight: 28 }}>
          <MessageTimestamp value={timestamp} align="left" inline />
          {displayContent.trim() ? <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <CopyMessageButton text={displayContent} disabled={false} successMessage="已复制用户消息" />
            <MessageIconButton label="改写" onClick={() => setEditing(true)} disabled={disabled || !canEdit}>
              <Icons.edit size={14} />
            </MessageIconButton>
          </div> : null}
        </div>
      ) : null}
    </div>
  );
}

function MessageTimestamp({ value, align = 'left', inline = false }) {
  if (!value) return null;
  return (
    <div data-message-timestamp={align} style={{ display: 'flex', justifyContent: align === 'right' ? 'flex-end' : 'flex-start', marginTop: inline ? 0 : 7, color: C.tertiary, fontSize: 11, lineHeight: 1.25, fontVariantNumeric: 'tabular-nums', userSelect: 'none', whiteSpace: 'nowrap' }}>
      {value}
    </div>
  );
}

function TaskReceiptCards({ researchSummary, writeSummary }) {
  const sources = Array.isArray(researchSummary?.sources) ? researchSummary.sources : [];
  const changes = Array.isArray(writeSummary?.changes) ? writeSummary.changes : [];
  if (!AGENT_TASK_RECEIPTS_ENABLED || (sources.length === 0 && changes.length === 0)) return null;
  const statusLabel = (status) => {
    if (status === 'success' || status === 'applied') return '已读取';
    if (status === 'partial') return '部分读取';
    if (status === 'pending') return '待确认';
    if (status === 'empty') return '无补充结果';
    if (status === 'error' || status === 'failed') return '失败';
    return status || '已记录';
  };
  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
      {sources.length > 0 ? (
        <section aria-label="已使用资料" style={{ padding: '10px 12px', borderRadius: 12, background: C.soft, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.9)' }}>
          <div style={{ marginBottom: 7, fontSize: 11, fontWeight: 800, color: C.secondary }}>已使用资料</div>
          <div style={{ display: 'grid', gap: 7 }}>
            {sources.map((source, index) => {
              const ref = String(source?.ref || '');
              const link = /^https?:\/\//i.test(ref);
              return (
                <div key={`${source?.type || 'source'}-${ref || index}`} style={{ minWidth: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '2px 8px', fontSize: 11.5, lineHeight: 1.55 }}>
                  <span style={{ minWidth: 0, color: C.text, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source?.title || '资料'}</span>
                  <span style={{ color: source?.status === 'success' || source?.status === 'applied' ? '#278044' : C.tertiary, whiteSpace: 'nowrap' }}>{statusLabel(source?.status)}</span>
                  {ref ? link ? <a href={ref} target="_blank" rel="noreferrer" style={{ minWidth: 0, color: C.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ref}</a> : <span style={{ minWidth: 0, color: C.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ref}</span> : null}
                  {source?.summary ? <span style={{ gridColumn: '1 / -1', color: C.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.summary}</span> : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
      {changes.length > 0 ? (
        <section aria-label="文件变更" style={{ padding: '10px 12px', borderRadius: 12, background: C.soft, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.9)' }}>
          <div style={{ marginBottom: 7, fontSize: 11, fontWeight: 800, color: C.secondary }}>文件变更</div>
          <div style={{ display: 'grid', gap: 5 }}>
            {changes.map((change, index) => (
              <div key={`${change?.operation_set_id || 'set'}-${change?.path || index}`} style={{ display: 'flex', minWidth: 0, alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 11.5 }}>
                <span style={{ minWidth: 0, color: C.text, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{change?.path || '文件变更'}</span>
                <span style={{ flexShrink: 0, color: change?.status === 'applied' ? '#278044' : C.tertiary }}>{change?.status === 'applied' ? '已应用' : change?.status === 'pending' ? '待确认' : statusLabel(change?.status)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function AssistantMessageRow({ message, disabled, removing = false, onRetryMessage, previousUserMessage, onOpenOperationSet, onCitationClick, citationSelection, executionTrace = null }) {
  const [retrying, setRetrying] = useState(false);
  const canRetry = Boolean(previousUserMessage?.content) && typeof onRetryMessage === 'function';
  const timestamp = formatMessageTimestamp(message.createdAt);

  const handleRetry = useCallback(async () => {
    if (!canRetry || retrying) return;
    setRetrying(true);
    try {
      await onRetryMessage(previousUserMessage, {
        reason: 'retry',
        assistantMessage: message,
      });
    } finally {
      setRetrying(false);
    }
  }, [canRetry, message, onRetryMessage, previousUserMessage, retrying]);

  return (
    <div className="notus-agent-assistant-message" style={{ minWidth: 0, maxWidth: '100%', overflow: 'hidden', opacity: removing ? 0 : 1, transform: removing ? 'translateY(-6px)' : 'translateY(0)', transition: 'opacity 220ms ease, transform 220ms ease' }}>
      {executionTrace}
      {message.content ? <StreamingText className="notus-agent-markdown" text={message.content} streaming={false} style={{ fontSize: 15, lineHeight: 1.85, color: C.text }} /> : null}
      {Array.isArray(message.citations) && message.citations.length > 0 ? (
        <div style={{ display: 'grid', gap: 8, marginTop: 12, minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
          <div style={{ fontSize: 12, color: C.tertiary }}>
            {(Number(message.sourceCount) > 0 ? Number(message.sourceCount) : message.citations.length)} 个来源
          </div>
          {message.citations.map((citation, index) => (
            <SourceCard
              key={citation.file_id || citation.file || index}
              file={citation.file}
              path={citation.path}
              quote={citation.quote || citation.preview}
              lines={citation.lines}
              imageProxyUrl={citation.image_proxy_url}
              imageAltText={citation.image_alt_text}
              imageCaption={citation.image_caption}
              selected={citationSelection?.messageId === message.id && citationSelection?.citationIndex === index}
              onClick={() => onCitationClick?.(citation, { messageId: message.id, citationIndex: index })}
            />
          ))}
        </div>
      ) : null}
      {message.operationSet ? <OperationSetCard operationSet={message.operationSet} onOpenDetail={onOpenOperationSet} /> : null}
      <TaskReceiptCards researchSummary={message.meta?.research_summary} writeSummary={message.meta?.write_summary} />
      <div aria-label="AI 回复操作" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8, marginTop: 10, minHeight: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <CopyMessageButton text={message.content} disabled={false} successMessage="已复制 AI 回复" />
          <MessageIconButton label="重试" onClick={() => { void handleRetry(); }} disabled={disabled || !canRetry || retrying}>
            {retrying ? <InlineActionSpinner size={14} /> : <Icons.refresh size={14} />}
          </MessageIconButton>
        </div>
        <MessageTimestamp value={timestamp} align="right" inline />
      </div>
    </div>
  );
}

function AgentTaskTimeline({ activeSteps, loading, streamText, sessionStatus = '', sessionId = '', startedAt = '', finishedAt = '', errorMessage = '', retryMessage = null, onRetryMessage, onAction, onPreviewImages }) {
  const hasSteps = Array.isArray(activeSteps) && activeSteps.length > 0;
  const isStarting = !hasSteps && !streamText && (loading || ['created', 'queued'].includes(sessionStatus));
  const hasTrace = hasSteps || Boolean(startedAt);
  const hasActivity = hasTrace || Boolean(streamText) || Boolean(errorMessage) || isStarting;
  if (!hasActivity) return null;
  return (
    <div className="notus-agent-task-timeline">
      {isStarting && !hasTrace ? <div className="notus-agent-task-timeline__pending" role="status" aria-live="polite">任务正在提交</div> : null}
      {hasTrace || errorMessage ? <ToolChain steps={activeSteps} loading={loading} sessionStatus={sessionStatus} sessionId={sessionId} startedAt={startedAt} finishedAt={finishedAt} errorMessage={errorMessage} retryMessage={retryMessage} onRetryMessage={onRetryMessage} onAction={onAction} onPreviewImages={onPreviewImages} /> : null}
      {streamText ? (
        <div className="notus-agent-task-timeline__draft">
          {!loading ? <div className="notus-agent-task-timeline__draft-label">中断前已生成的回复</div> : null}
          <StreamingText className="notus-agent-markdown" text={streamText} streaming={loading} style={{ fontSize: 15, lineHeight: 1.85, color: C.text }} />
        </div>
      ) : null}
    </div>
  );
}

function MessageList({ messages, interactions = [], streamText, error = '', loading, activeSteps, activeSessionId = null, activeSessionStatus = '', sessionTimelines = {}, removingMessageIds, onOpenOperationSet, onCitationClick, citationSelection, actionDisabled = false, onResendMessage, onRetryMessage, onOpenAttachment, onPreviewMention, onPrefetchMention, onPreviewImages, onPreviewToolchainImages, onAgentStepAction }) {
  const hasPersistedTimeline = Array.isArray(activeSteps) && activeSteps.length > 0;
  const hasAgentActivity = hasPersistedTimeline || Boolean(streamText) || Boolean(error) || Boolean(loading)
    || ['created', 'queued', 'running'].includes(activeSessionStatus);
  const lastMessageIndex = messages.length - 1;
  const currentSessionKey = String(activeSessionId || '');
  const assistantSessionIds = new Set((Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === 'assistant' && message?.meta?.session_id)
    .map((message) => String(message.meta.session_id)));
  const answeredInteractions = (Array.isArray(interactions) ? interactions : [])
    .filter((interaction) => interaction?.status === 'answered');
  const interactionStepsFor = (sessionId) => answeredInteractions
    .filter((interaction) => String(interaction?.payload?.agent_session_id || '') === String(sessionId || ''))
    .map(buildInteractionHistoryStep);
  const traceFor = (timeline, key, retryMessage = null) => {
    if (!timeline) return null;
    const steps = mergeInteractionStepsIntoTimeline(
      Array.isArray(timeline.activeSteps) ? timeline.activeSteps : [],
      interactionStepsFor(timeline.sessionId),
    );
    const draft = String(timeline.streamText || '');
    const timelineError = String(timeline.errorMessage || '').trim();
    if (steps.length === 0 && !draft && !timeline.loading && !timelineError && !timeline.startedAt) return null;
    return <AgentTaskTimeline key={key} activeSteps={steps} loading={Boolean(timeline.loading)} streamText={draft} errorMessage={timelineError} retryMessage={retryMessage} onRetryMessage={onRetryMessage} sessionStatus={timeline.sessionStatus || ''} sessionId={timeline.sessionId || ''} startedAt={timeline.startedAt || ''} finishedAt={timeline.finishedAt || ''} onAction={onAgentStepAction} onPreviewImages={onPreviewToolchainImages} />;
  };
  const currentTimelineSource = sessionTimelines?.[currentSessionKey] || null;
  const currentRetryMessage = currentTimelineSource?.userMessageId
    ? (messages.find((message) => String(message?.id || '') === String(currentTimelineSource.userMessageId)) || null)
    : ([...messages].reverse().find((message) => message?.role === 'user') || null);
  const currentTimeline = hasAgentActivity ? {
    sessionId: currentSessionKey,
    userMessageId: currentTimelineSource?.userMessageId || null,
    activeSteps,
    loading,
    streamText,
    errorMessage: error,
    sessionStatus: activeSessionStatus,
    startedAt: currentTimelineSource?.startedAt || '',
    finishedAt: currentTimelineSource?.finishedAt || '',
  } : null;
  const executionTrace = traceFor(currentTimeline, `active-${currentSessionKey || 'pending'}`, currentRetryMessage);
  if (messages.length === 0 && !hasAgentActivity) {
    return (
      <div style={{ minHeight: '42vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: C.tertiary }}>
        <div style={{ fontSize: 20, lineHeight: 1.5, fontWeight: 500, color: C.text }}>你今天在想些什么？</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 22, minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}>
      {messages.map((message, index) => {
        const removing = removingMessageIds?.has?.(String(message.id)) || false;
        const messageSessionKey = String(message?.meta?.session_id || '');
        const messageTimeline = messageSessionKey ? sessionTimelines?.[messageSessionKey] : null;
        if (message.role === 'user') {
          const userTimeline = Object.values(sessionTimelines || {})
            .filter((timeline) => String(timeline?.userMessageId || '') === String(message.id || ''))
            .sort((left, right) => Number(right?.sessionId || 0) - Number(left?.sessionId || 0))[0] || null;
          const userSessionKey = String(userTimeline?.sessionId || '');
          const userTrace = userTimeline && !assistantSessionIds.has(userSessionKey)
            ? traceFor(userSessionKey && userSessionKey === currentSessionKey ? currentTimeline : userTimeline, `user-${userSessionKey}`, message)
            : (index === lastMessageIndex && hasAgentActivity ? executionTrace : null);
          return (
            <Fragment key={message.id}>
              <UserMessageRow
                message={message}
                disabled={actionDisabled}
                removing={removing}
                onResendMessage={onResendMessage}
                onOpenAttachment={onOpenAttachment}
                onPreviewMention={onPreviewMention}
                onPrefetchMention={onPrefetchMention}
                onPreviewImages={onPreviewImages}
              />
              {userTrace}
            </Fragment>
          );
        }

        const previousUserMessage = [...messages.slice(0, index)].reverse().find((item) => item.role === 'user') || null;

        return (
          <AssistantMessageRow
            key={message.id}
            message={message}
            disabled={actionDisabled}
            removing={removing}
            onRetryMessage={onRetryMessage}
            previousUserMessage={previousUserMessage}
            onOpenOperationSet={onOpenOperationSet}
            onCitationClick={onCitationClick}
            citationSelection={citationSelection}
            executionTrace={messageTimeline
              ? traceFor(messageSessionKey === currentSessionKey ? currentTimeline : messageTimeline, `assistant-${messageSessionKey}`, previousUserMessage)
              : (index === lastMessageIndex && hasAgentActivity ? executionTrace : null)}
          />
        );
      })}
      {messages.length === 0 && hasAgentActivity ? executionTrace : null}
    </div>
  );
}

function AgentConfirmModeSelect({ value, onChange, disabled }) {
  const current = getAgentConfirmModeOption(value);

  return (
    <SegmentedTabs
      value={current.value}
      onChange={onChange}
      disabled={disabled}
      ariaLabel="Agent 确认方式"
      className="notus-agent-confirm-mode"
      style={{ background: C.soft, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.86)' }}
      options={AGENT_CONFIRM_MODE_OPTIONS.map((option) => ({ ...option, ariaLabel: option.value === 'auto_confirm' ? '自动应用修改' : '手动应用修改', icon: option.icon === 'hand' ? Icons.hand : Icons.zap }))}
    />
  );
}

function AgentInput({ loading, disabled, llmConfigs, selectedConfigId, onConfigChange, onSend, onInterrupt, interruptibleSessionId = null, searchConfig, searchPreference, onSearchPreferenceChange, onRequireSearchConfig, onRequireMcpConfig, mcpSelection = { mode: 'off' }, onMcpSelectionChange, mcpAvailable = false, mcpAvailabilityChecked = false, placeholder, agentConfirmMode, onAgentConfirmModeChange, attachmentMode = 'metadata', mentionOptions = [], onPreviewMention, onPrefetchMention }) {
  const [composerState, setComposerState] = useState({ content: '', mentions: [], segments: [] });
  const [files, setFiles] = useState([]);
  const [imagePreview, setImagePreview] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selectedSearchProvider, setSelectedSearchProvider] = useState(String(searchPreference?.searchProvider || '').trim());
  const [webSearchPreferenceEnabled, setWebSearchPreferenceEnabled] = useState(Boolean(searchPreference?.webSearchEnabled));
  const [searchOpen, setSearchOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [mentionQuery, setMentionQuery] = useState(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [mentionDropActive, setMentionDropActive] = useState(false);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const composerRef = useRef(null);
  const mentionListRef = useRef(null);
  const mentionOptionRefs = useRef([]);
  const uploadOrderRef = useRef(0);
  const selectedMediaCountRef = useRef({ image: 0, attachment: 0 });
  const previewUrlsRef = useRef(new Set());
  const modelSearchRef = useRef(null);
  const composerDraftHydratedRef = useRef(false);
  const composerDraftSaveTimerRef = useRef(null);
  const composerInteractionRef = useRef(false);
  const mentionDropCounterRef = useRef(0);
  const selectedConfig = useMemo(() => llmConfigs.find((item) => String(item.id) === String(selectedConfigId)) || llmConfigs[0] || null, [llmConfigs, selectedConfigId]);
  const toast = useToast();
  const parsedAttachmentMode = attachmentMode === 'parsed';
  // 任务已改为后台队列，运行中仍允许立即输入下一条消息；上传完成前才阻止提交。
  const busy = uploading;
  const providers = searchConfig.providers || SEARCH_PROVIDER_FALLBACKS;
  const preferredSearchProvider = providers.find((provider) => provider.id === searchConfig.selected_provider)?.id || providers[0]?.id || 'firecrawl';
  const webSearchSelected = Boolean(searchConfig.enabled && webSearchPreferenceEnabled && selectedSearchProvider);
  const mcpMode = String(mcpSelection?.mode || 'off');
  const mcpEnabled = Boolean(mcpAvailable && mcpMode === 'auto');
  const mcpLabel = 'MCP';
  const searchProviderList = webSearchSelected ? [selectedSearchProvider] : [];
  const isSearchProviderReady = (providerId) => {
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) return false;
    if (!providerNeedsApiKey(provider)) return true;
    return Boolean(searchConfig.api_key_set?.[providerId]);
  };
  const showAgentConfirmMode = typeof onAgentConfirmModeChange === 'function';
  const groupedConfigs = useMemo(() => {
    const groups = [];
    (llmConfigs || []).forEach((config) => {
      const label = providerLabel(config);
      let group = groups.find((item) => item.label === label);
      if (!group) {
        group = { label, configs: [] };
        groups.push(group);
      }
      group.configs.push(config);
    });
    return groups;
  }, [llmConfigs]);
  const filteredGroupedConfigs = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    if (!query) return groupedConfigs;
    return groupedConfigs
      .map((group) => ({
        ...group,
        configs: group.configs.filter((config) => [modelLabel(config), providerLabel(config), config?.name]
          .some((value) => String(value || '').toLowerCase().includes(query))),
      }))
      .filter((group) => group.configs.length > 0);
  }, [groupedConfigs, modelQuery]);

  useEffect(() => {
    if (!modelOpen) {
      setModelQuery('');
      return undefined;
    }
    const timer = window.setTimeout(() => modelSearchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [modelOpen]);
  useEffect(() => {
    if (!mcpAvailabilityChecked || mcpAvailable || mcpMode !== 'auto') return;
    onMcpSelectionChange?.({ mode: 'off' });
    setMcpOpen(false);
  }, [mcpAvailabilityChecked, mcpAvailable, mcpMode, onMcpSelectionChange]);
  const value = composerState.content;
  const mentions = composerState.mentions;

  const serializeComposer = useCallback(() => {
    const root = composerRef.current;
    const segments = [];
    if (!root) return { content: '', mentions: [], segments };
    const appendNode = (node) => {
      if (node.nodeType === 3) {
        const text = String(node.textContent || '');
        if (text) segments.push({ type: 'text', text });
        return;
      }
      const encodedMention = node.nodeType === 1 ? node.getAttribute('data-notus-mention') : '';
      if (encodedMention) {
        try {
          const mention = JSON.parse(decodeURIComponent(encodedMention));
          if (mention?.id && mention?.path) segments.push({ type: 'mention', mention });
        } catch {
          // 已损坏的 DOM 节点不参与发送，避免编辑器状态影响整页。
        }
        return;
      }
      if (node.nodeType === 1 && node.nodeName === 'BR') {
        segments.push({ type: 'text', text: '\n' });
        return;
      }
      Array.from(node.childNodes || []).forEach(appendNode);
    };
    Array.from(root.childNodes).forEach(appendNode);
    const mentions = segments.filter((segment) => segment.type === 'mention').map((segment) => segment.mention);
    return {
      content: segments.filter((segment) => segment.type === 'text').map((segment) => segment.text).join(''),
      mentions,
      segments,
    };
  }, []);

  const syncComposerState = useCallback(() => {
    setComposerState(serializeComposer());
  }, [serializeComposer]);

  const restoreComposerCaret = useCallback((preferredNode = null, preferredOffset = 0) => {
    const root = composerRef.current;
    if (!root || typeof document === 'undefined') return;
    let textNode = preferredNode?.nodeType === 3 && root.contains(preferredNode) ? preferredNode : null;
    if (!textNode) {
      textNode = document.createTextNode('');
      root.appendChild(textNode);
    }
    const offset = Math.min(Math.max(Number(preferredOffset) || 0, 0), textNode.textContent.length);
    root.focus();
    const selection = window.getSelection?.();
    if (!selection) return;
    const range = document.createRange();
    range.setStart(textNode, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const createMentionChip = useCallback((mention = {}) => {
    if (typeof document === 'undefined') return null;
    const chip = document.createElement('span');
    chip.className = 'notus-mention-item notus-mention-item--inline';
    chip.contentEditable = 'false';
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    chip.setAttribute('data-notus-mention', encodeURIComponent(JSON.stringify(mention)));
    const isSkill = mention.type === 'skill';
    chip.setAttribute('title', isSkill ? (mention.description || '未提供 Skill 描述') : `${mention.name}\n${mention.path}`);
    chip.setAttribute('aria-label', isSkill ? `Skill：${mention.name}` : `预览${mention.type === 'folder' ? '目录' : '笔记'}：${mention.name}`);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.7');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', mention.type === 'folder'
      ? 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2M3 7v11a2 2 0 0 0 2 2h13.5a2 2 0 0 0 1.9-1.4l2-6A1 1 0 0 0 21.5 11H5a2 2 0 0 0-2 2V7z'
      : mention.type === 'skill'
        ? 'M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21zM20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5A2.5 2.5 0 0 1 20 21z'
        : 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6');
    icon.appendChild(path);
    const label = document.createElement('span');
    label.className = 'notus-mention-item__label';
    label.textContent = mention.name;
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'notus-mention-item__remove';
    removeButton.setAttribute('aria-label', `移除 mention：${mention.name}`);
    removeButton.textContent = '×';
    const removeChip = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const root = composerRef.current;
      if (!root || !root.contains(chip)) return;
      let trailingText = chip.nextSibling;
      if (trailingText?.nodeType !== 3) {
        trailingText = document.createTextNode('');
        chip.after(trailingText);
      }
      chip.remove();
      composerInteractionRef.current = true;
      restoreComposerCaret(trailingText, 0);
      syncComposerState();
      setMentionQuery(null);
      setDismissedMentionKey('');
    };
    removeButton.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    removeButton.addEventListener('click', removeChip);
    chip.append(icon, label, removeButton);
    const openPreview = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isSkill) return;
      onPreviewMention?.(mention);
    };
    chip.addEventListener('mousedown', (event) => event.preventDefault());
    chip.addEventListener('mouseenter', () => { if (!isSkill) onPrefetchMention?.(mention); });
    chip.addEventListener('focus', () => { if (!isSkill) onPrefetchMention?.(mention); });
    chip.addEventListener('click', openPreview);
    chip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') openPreview(event);
    });
    return chip;
  }, [onPrefetchMention, onPreviewMention, restoreComposerCaret, syncComposerState]);

  const restoreComposerDom = useCallback((segments = []) => {
    const root = composerRef.current;
    if (!root || typeof document === 'undefined') return;
    root.replaceChildren();
    (Array.isArray(segments) ? segments : []).forEach((segment) => {
      if (segment?.type === 'text' && segment.text) {
        root.appendChild(document.createTextNode(String(segment.text)));
        return;
      }
      if (segment?.type !== 'mention' || !segment.mention?.path) return;
      const chip = createMentionChip(segment.mention);
      if (chip) {
        root.appendChild(chip);
        root.appendChild(document.createTextNode(''));
      }
    });
  }, [createMentionChip]);

  useEffect(() => {
    let cancelled = false;
    readAgentComposerDraft().then((draft) => {
      if (cancelled || !draft) {
        composerDraftHydratedRef.current = true;
        return;
      }
      if (composerInteractionRef.current) {
        composerDraftHydratedRef.current = true;
        return;
      }
      const segments = Array.isArray(draft.segments) ? draft.segments : [];
      restoreComposerDom(segments);
      const restoredFiles = restoreAgentComposerFiles(draft.files);
      restoredFiles.forEach((file) => {
        if (file.previewUrl) previewUrlsRef.current.add(file.previewUrl);
      });
      setFiles(restoredFiles);
      setComposerState({
        content: String(draft.content || ''),
        mentions: Array.isArray(draft.mentions) ? draft.mentions : segments.filter((segment) => segment?.type === 'mention').map((segment) => segment.mention),
        segments,
      });
      uploadOrderRef.current = restoredFiles.reduce((max, file) => Math.max(max, Number(file.upload_order || 0) + 1), 0);
      selectedMediaCountRef.current = restoredFiles.reduce((counts, file) => {
        const key = isImageMedia(file) ? 'image' : 'attachment';
        counts[key] += 1;
        return counts;
      }, { image: 0, attachment: 0 });
      composerDraftHydratedRef.current = true;
    }).catch(() => {
      composerDraftHydratedRef.current = true;
    });
    return () => { cancelled = true; };
  }, [restoreComposerDom]);

  useEffect(() => {
    if (!composerDraftHydratedRef.current) return undefined;
    if (composerDraftSaveTimerRef.current) window.clearTimeout(composerDraftSaveTimerRef.current);
    composerDraftSaveTimerRef.current = window.setTimeout(() => {
      saveAgentComposerDraft({ ...composerState, files }).catch(() => {});
    }, 280);
    return () => {
      if (composerDraftSaveTimerRef.current) window.clearTimeout(composerDraftSaveTimerRef.current);
    };
  }, [composerState, files]);

  const resolveComposerTextPosition = useCallback((root, node, offset) => {
    const findTextNode = (candidate, direction) => {
      if (!candidate) return null;
      if (candidate.nodeType === 3) return candidate;
      if (candidate.nodeType !== 1 || candidate.hasAttribute?.('data-notus-mention')) return null;
      const children = Array.from(candidate.childNodes || []);
      const ordered = direction === 'forward' ? children : children.reverse();
      for (const child of ordered) {
        const found = findTextNode(child, direction);
        if (found) return found;
      }
      return null;
    };

    if (node?.nodeType === 3) {
      return {
        textNode: node,
        offset: Math.min(Math.max(Number(offset) || 0, 0), node.textContent.length),
      };
    }

    const children = Array.from(node?.childNodes || []);
    const boundary = Math.min(Math.max(Number(offset) || 0, 0), children.length);
    const before = findTextNode(children[boundary - 1], 'backward');
    if (before && root.contains(before)) return { textNode: before, offset: before.textContent.length };
    const after = findTextNode(children[boundary], 'forward');
    if (after && root.contains(after)) return { textNode: after, offset: 0 };
    return null;
  }, []);

  const readMentionQuery = useCallback(() => {
    const root = composerRef.current;
    if (typeof window === 'undefined' || !root) return null;
    const selection = window.getSelection?.();
    const node = selection?.anchorNode;
    if (!selection?.rangeCount || !node || !root.contains(node)) return null;
    const position = resolveComposerTextPosition(root, node, selection.anchorOffset);
    if (!position) return null;
    const { textNode, offset } = position;
    const prefix = textNode.textContent.slice(0, offset);
    const start = prefix.lastIndexOf('@');
    if (start < 0) return null;
    // 中文任务常把 Mention 紧接在正文后，例如“请处理@会议纪要”。
    // 仍跳过常见 ASCII 邮箱本地部分，避免输入邮箱时弹出文件候选。
    if (/[A-Za-z0-9._%+-]/.test(prefix.charAt(start - 1))) return null;
    const match = prefix.slice(start).match(/^@(?:\{([^}]*)|([^@\n]*))$/);
    if (!match) return null;
    const key = `${Array.prototype.indexOf.call(root.childNodes, textNode)}:${start}:${prefix.slice(start)}`;
    return { textNode, start, end: offset, key, query: String(match[1] ?? match[2] ?? '').trim().toLowerCase() };
  }, [resolveComposerTextPosition]);

  const updateMentionQuery = useCallback(() => {
    try {
      setMentionQuery(readMentionQuery());
    } catch {
      // 选区会在 IME、鼠标拖选与 React 重绘之间短暂失效；此时关闭候选而不是让输入框崩溃。
      setMentionQuery(null);
    }
  }, [readMentionQuery]);

  const commitSearchPreference = useCallback((nextPreference = {}) => {
    const normalizedProvider = String(nextPreference.searchProvider || '').trim();
    const normalizedEnabled = Boolean(nextPreference.webSearchEnabled);
    setSelectedSearchProvider(normalizedProvider);
    setWebSearchPreferenceEnabled(normalizedEnabled);
    onSearchPreferenceChange?.({
      webSearchEnabled: normalizedEnabled,
      searchProvider: normalizedProvider,
    });
  }, [onSearchPreferenceChange]);

  useEffect(() => {
    setSelectedSearchProvider(String(searchPreference?.searchProvider || '').trim());
    setWebSearchPreferenceEnabled(Boolean(searchPreference?.webSearchEnabled));
  }, [searchPreference]);

  useEffect(() => {
    if (selectedSearchProvider && !providers.some((provider) => provider.id === selectedSearchProvider)) {
      commitSearchPreference({
        webSearchEnabled: webSearchPreferenceEnabled,
        searchProvider: preferredSearchProvider,
      });
    }
  }, [commitSearchPreference, preferredSearchProvider, providers, selectedSearchProvider, webSearchPreferenceEnabled]);

  const activeMention = useMemo(() => {
    if (!mentionOptions.length || disabled || !mentionQuery) return null;
    if (dismissedMentionKey === mentionQuery.key) return null;
    const query = mentionQuery.query;
    const options = mentionOptions
      .filter((option) => {
        if (!query) return true;
        const searchText = [
          option.token,
          option.label,
          option.preview,
          option.searchText,
        ].filter(Boolean).join(' ').toLowerCase();
        return searchText.includes(query);
      })
      .sort((left, right) => {
        const leftLabel = String(left?.label || '').trim().toLowerCase();
        const rightLabel = String(right?.label || '').trim().toLowerCase();
        const leftExact = query && leftLabel === query ? 0 : 1;
        const rightExact = query && rightLabel === query ? 0 : 1;
        if (leftExact !== rightExact) return leftExact - rightExact;
        if (left?.kind !== right?.kind) return left?.kind === 'folder' ? -1 : 1;
        return String(left?.preview || '').localeCompare(String(right?.preview || ''), 'zh-Hans-CN');
      })
      .slice(0, 8);
    return {
      ...mentionQuery,
      options,
    };
  }, [disabled, dismissedMentionKey, mentionOptions, mentionQuery]);

  useEffect(() => {
    if (!activeMention?.options?.length) {
      setActiveMentionIndex(0);
      return;
    }
    setActiveMentionIndex((prev) => Math.min(Math.max(prev, 0), activeMention.options.length - 1));
  }, [activeMention?.key, activeMention?.options?.length]);

  useEffect(() => {
    if (!activeMention?.options?.length) return;
    const list = mentionListRef.current;
    const option = mentionOptionRefs.current[activeMentionIndex];
    if (!list || !option) return;
    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    const visibleTop = list.scrollTop;
    const visibleBottom = visibleTop + list.clientHeight;
    if (optionTop < visibleTop) {
      list.scrollTo({ top: optionTop - 4, behavior: 'smooth' });
    } else if (optionBottom > visibleBottom) {
      list.scrollTo({ top: optionBottom - list.clientHeight + 4, behavior: 'smooth' });
    }
  }, [activeMention?.options?.length, activeMentionIndex]);

  useEffect(() => () => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current.clear();
  }, []);

  const revokePreview = (item) => {
    if (!item?.previewUrl) return;
    URL.revokeObjectURL(item.previewUrl);
    previewUrlsRef.current.delete(item.previewUrl);
  };

  const clearPendingFiles = () => {
    setImagePreview(null);
    setFiles((previous) => {
      previous.forEach(revokePreview);
      return [];
    });
    uploadOrderRef.current = 0;
    selectedMediaCountRef.current = { image: 0, attachment: 0 };
  };

  const openImagePreview = useCallback((selectedFile) => {
    const images = files.reduce((result, file) => {
      if (!isImageMedia(file)) return result;
      const src = imagePreviewUrl(file);
      if (!src) return result;
      result.push({
        id: file.id,
        src,
        alt: file.name || '已上传图片',
      });
      return result;
    }, []);
    const currentIndex = images.findIndex((image) => image.id === selectedFile?.id);
    if (currentIndex < 0) return;
    setImagePreview({ images, currentIndex });
  }, [files]);

  const moveImagePreview = useCallback((direction) => {
    setImagePreview((previous) => {
      if (!previous) return previous;
      const currentIndex = Math.min(
        Math.max(previous.currentIndex + direction, 0),
        previous.images.length - 1
      );
      return currentIndex === previous.currentIndex ? previous : { ...previous, currentIndex };
    });
  }, []);

  const normalizeMention = useCallback((option = {}) => ({
    id: String(option?.id || option?.value || option?.path || ''),
    type: option?.type === 'folder' || option?.kind === 'folder' ? 'folder' : option?.type === 'skill' || option?.kind === 'skill' ? 'skill' : 'file',
    name: String(option?.name || option?.label || option?.path || '未命名文件'),
    path: String(option?.path || option?.preview || ''),
    description: String(option?.description || ''),
  }), []);

  const insertMention = useCallback((option, targetRange = null) => {
    composerInteractionRef.current = true;
    const mention = normalizeMention(option);
    if (!mention.id || !mention.path) return;
    const root = composerRef.current;
    if (!root || typeof document === 'undefined') return;
    const chip = createMentionChip(mention);
    if (!chip) return;
    const range = targetRange && root.contains(targetRange.startContainer) ? targetRange.cloneRange() : document.createRange();
    if (!targetRange || !root.contains(targetRange.startContainer)) {
      range.selectNodeContents(root);
      range.collapse(false);
    }
    range.deleteContents();
    range.insertNode(chip);
    const tail = document.createTextNode('');
    chip.after(tail);
    const selection = window.getSelection?.();
    if (selection) {
      const caret = document.createRange();
      caret.setStart(tail, 0);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    syncComposerState();
    setMentionQuery(null);
    setDismissedMentionKey('');
    setActiveMentionIndex(0);
    root.focus();
  }, [createMentionChip, normalizeMention, syncComposerState]);

  const applyMention = (option) => {
    if (!activeMention) return;
    const root = composerRef.current;
    const textNode = activeMention.textNode;
    if (!root || !textNode || !root.contains(textNode) || typeof document === 'undefined') return;
    const range = document.createRange();
    range.setStart(textNode, activeMention.start);
    range.setEnd(textNode, activeMention.end);
    insertMention(option, range);
  };

  const handleMentionDrop = useCallback((event) => {
    const raw = event.dataTransfer?.getData('application/x-notus-mention') || '';
    if (!raw) return;
    event.preventDefault();
    mentionDropCounterRef.current = 0;
    setMentionDropActive(false);
    let mention;
    try { mention = JSON.parse(raw); } catch { return; }
    const root = composerRef.current;
    if (!root || !mention?.path) return;
    let range = null;
    const position = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    if (position) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    } else {
      range = document.caretRangeFromPoint?.(event.clientX, event.clientY) || null;
    }
    insertMention(mention, range);
  }, [insertMention]);

  const addFiles = (fileList, options = {}) => {
    const rejected = [];
    const incoming = Array.from(fileList || []);
    const mediaKind = options.mediaKind === 'image' ? 'image' : 'attachment';
    // 附件选择器允许用户混选文件。图片必须始终走视觉上传链路，不能因
    // 从纸夹入口选中就退回到 PDF/DOCX 的文本解析链路。
    if (mediaKind === 'attachment') {
      const images = incoming.filter(isSupportedImageFile);
      if (images.length > 0) {
        addFiles(images, { ...options, mediaKind: 'image' });
        const nonImages = incoming.filter((file) => !isSupportedImageFile(file));
        if (nonImages.length === 0) return;
        return addFiles(nonImages, options);
      }
    }
    const supported = incoming.filter((file) => {
      if (mediaKind === 'image' && !isSupportedImageFile(file)) {
        rejected.push(file.name || '未命名图片');
        return false;
      }
      if (mediaKind === 'attachment' && parsedAttachmentMode && !isSupportedParsedFile(file)) {
        rejected.push(file.name || '未命名附件');
        return false;
      }
      return true;
    });
    const selectedCount = selectedMediaCountRef.current[mediaKind] || 0;
    const limit = mediaKind === 'image' ? MAX_IMAGES_PER_MESSAGE : MAX_PARSED_ATTACHMENTS;
    const remaining = parsedAttachmentMode ? Math.max(0, limit - selectedCount) : supported.length;
    const acceptedCandidates = supported.slice(0, remaining);
    const skippedCount = Math.max(0, supported.length - acceptedCandidates.length);
    const next = acceptedCandidates.map((file, index) => {
      const previewUrl = mediaKind === 'image' ? URL.createObjectURL(file) : '';
      if (previewUrl) previewUrlsRef.current.add(previewUrl);
      return {
        id: 'file-' + Date.now() + '-' + Math.random().toString(16).slice(2),
        name: file.name,
        size: file.size,
        sizeLabel: fileSize(file.size),
        type: file.type,
        source_kind: mediaKind === 'image' ? 'image' : (options.sourceKind || 'file'),
        media_kind: mediaKind,
        upload_order: uploadOrderRef.current + index,
        previewUrl,
        fileObject: file,
      };
    });
    if (next.length > 0) composerInteractionRef.current = true;
    uploadOrderRef.current += next.length;
    selectedMediaCountRef.current[mediaKind] = selectedCount + next.length;
    if (rejected.length > 0) {
      toast(mediaKind === 'image'
        ? `暂不支持 ${rejected.slice(0, 3).join('、')}，请上传 PNG、JPG、WEBP 或 GIF。`
        : `暂不支持 ${rejected.slice(0, 3).join('、')}，请上传 PDF、DOCX、MD、TXT 或 CSV。`, 'warning');
    }
    if (skippedCount > 0) {
      toast(mediaKind === 'image'
        ? `单次最多上传 ${MAX_IMAGES_PER_MESSAGE} 张图片，已忽略多出的 ${skippedCount} 张。`
        : `单次最多上传 ${MAX_PARSED_ATTACHMENTS} 个附件，已忽略多出的 ${skippedCount} 个。`, 'warning');
    }
    if (next.length > 0) setFiles((prev) => [...prev, ...next]);
  };

  const uploadParsedAttachments = async (items = []) => {
    const uploadItems = items.filter((item) => item.fileObject && !isImageMedia(item));
    if (!parsedAttachmentMode || uploadItems.length === 0) return items.filter((item) => !isImageMedia(item)).map(toDisplayAttachment);
    const form = new FormData();
    uploadItems.forEach((item) => {
      form.append('files', item.fileObject, item.name);
    });
    const response = await fetch('/api/agent/attachments/upload', {
      method: 'POST',
      body: form,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || '附件上传失败');
    }
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      toast(payload.errors[0]?.error || '部分附件未上传', 'warning');
    }
    const uploaded = Array.isArray(payload.attachments) ? payload.attachments : [];
    return uploadItems.map((item, index) => ({
      ...toDisplayAttachment(item),
      ...(uploaded[index] || {}),
      id: item.id,
      source_kind: item.source_kind || 'file',
    }));
  };

  const uploadImages = async (items = []) => {
    const uploadItems = items.filter((item) => item.fileObject && isImageMedia(item));
    if (uploadItems.length === 0) return [];
    const form = new FormData();
    uploadItems.forEach((item) => form.append('images', item.fileObject, item.name));
    const response = await fetch('/api/agent/images/upload', { method: 'POST', body: form });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '图片上传失败');
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      toast(payload.errors[0]?.error || '部分图片未上传', 'warning');
    }
    const uploaded = Array.isArray(payload.images) ? payload.images : [];
    return uploadItems.map((item, index) => ({
      ...toDisplayAttachment(item),
      ...(uploaded[index] || {}),
      id: item.id,
      source_kind: 'image',
      media_kind: 'image',
      upload_order: item.upload_order,
    }));
  };

  const submit = async (forcedText) => {
    const hasPendingImages = files.some(isImageMedia);
    const fallbackText = hasPendingImages
      ? '请分析我上传的图片，并说明其中能够确认的内容。'
      : parsedAttachmentMode && files.length > 0
        ? '请读取并分析已上传的文件。'
        : '';
    const currentComposer = serializeComposer();
    const text = String(forcedText || currentComposer.content || fallbackText || '').trim();
    if ((!text && files.length === 0 && currentComposer.mentions.length === 0) || busy || disabled || !selectedConfig) return;
    if (webSearchSelected && !searchConfig.enabled) {
      onRequireSearchConfig?.({ reason: 'disabled', selectProvider: selectedSearchProvider || preferredSearchProvider });
      return;
    }
    if (webSearchSelected && !isSearchProviderReady(selectedSearchProvider)) {
      onRequireSearchConfig?.({ reason: 'missing_api_key', selectProvider: selectedSearchProvider });
      return;
    }
    const mentionSegments = currentComposer.segments;
    composerRef.current?.replaceChildren();
    setComposerState({ content: '', mentions: [], segments: [] });
    setMentionQuery(null);
    setDismissedMentionKey('');
    setSearchOpen(false);
    setMcpOpen(false);
    setModelOpen(false);
    setUploading(files.some((item) => item.fileObject));
    let taskAccepted = false;
    const clearAcceptedComposer = () => {
      if (taskAccepted) return;
      taskAccepted = true;
      clearPendingFiles();
      clearAgentComposerDraft().catch(() => {});
    };
    try {
      const [uploadedAttachments, images] = await Promise.all([
        parsedAttachmentMode ? uploadParsedAttachments(files) : Promise.resolve(files.filter((item) => !isImageMedia(item)).map(toDisplayAttachment)),
        uploadImages(files),
      ]);
      const mediaById = new Map([...uploadedAttachments, ...images].map((item) => [item.id, item]));
      const mediaItems = files.map((item) => mediaById.get(item.id) || toDisplayAttachment(item));
      const attachments = mediaItems.filter((item) => !isImageMedia(item));
      await onSend?.(text, {
        llmConfigId: selectedConfig.id,
        attachments,
        images,
        mediaItems,
        mentions: currentComposer.mentions,
        mentionSegments,
        webSearchEnabled: webSearchSelected,
        searchProvider: selectedSearchProvider || null,
        searchProviders: searchProviderList,
        mcpSelection: mcpMode === 'auto' ? { mode: 'auto' } : { mode: 'off' },
        onTaskAccepted: clearAcceptedComposer,
      });
    } catch (error) {
      if (taskAccepted) return;
      restoreComposerDom(currentComposer.segments);
      setComposerState(currentComposer);
      toast(error.message || '发送失败', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleKeyDown = (event) => {
    if (isComposing || event.nativeEvent?.isComposing) return;
    if (activeMention) {
      if (event.key === 'ArrowDown' && activeMention.options.length > 0) {
        event.preventDefault();
        setActiveMentionIndex((prev) => (prev + 1) % activeMention.options.length);
        return;
      }
      if (event.key === 'ArrowUp' && activeMention.options.length > 0) {
        event.preventDefault();
        setActiveMentionIndex((prev) => (prev - 1 + activeMention.options.length) % activeMention.options.length);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && activeMention.options.length > 0) {
        event.preventDefault();
        applyMention(activeMention.options[activeMentionIndex] || activeMention.options[0]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedMentionKey(activeMention.key);
        setActiveMentionIndex(0);
        return;
      }
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const selection = window.getSelection?.();
      const node = selection?.anchorNode;
      const root = composerRef.current;
      const isTextNode = node?.nodeType === 3;
      const atStart = isTextNode && selection?.anchorOffset === 0;
      const atEnd = isTextNode && selection?.anchorOffset === (node?.textContent?.length || 0);
      const isRootSelection = node === root;
      const rootOffset = Number(selection?.anchorOffset || 0);
      const neighbor = event.key === 'Backspace' && atStart ? node.previousSibling
        : event.key === 'Delete' && atEnd ? node.nextSibling
          : event.key === 'Backspace' && isRootSelection && rootOffset > 0 ? root.childNodes[rootOffset - 1]
            : event.key === 'Delete' && isRootSelection ? root.childNodes[rootOffset]
              : null;
      if (neighbor?.nodeType === 1 && neighbor.hasAttribute('data-notus-mention')) {
        event.preventDefault();
        composerInteractionRef.current = true;
        const caretNode = isTextNode ? node : null;
        const caretOffset = isTextNode ? Number(selection?.anchorOffset || 0) : 0;
        neighbor.remove();
        restoreComposerCaret(caretNode, caretOffset);
        syncComposerState();
        setMentionQuery(null);
        setDismissedMentionKey('');
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const canSend = !busy && !disabled && Boolean(selectedConfig) && (Boolean(value.trim()) || files.length > 0 || mentions.length > 0);
  const canInterrupt = Boolean(interruptibleSessionId && typeof onInterrupt === 'function');
  const primaryActionEnabled = canInterrupt || canSend;
  const handlePrimaryAction = () => {
    if (canInterrupt) {
      void onInterrupt(interruptibleSessionId);
      return;
    }
    void submit();
  };
  const toggleWebSearch = () => {
    if (busy || disabled) return;
    if (!searchConfig.enabled) {
      onRequireSearchConfig?.({ reason: 'disabled', selectProvider: preferredSearchProvider });
      return;
    }
    const nextProvider = selectedSearchProvider || preferredSearchProvider;
    if (webSearchSelected) {
      commitSearchPreference({
        webSearchEnabled: false,
        searchProvider: nextProvider,
      });
      setSearchOpen(false);
      return;
    }
    if (!isSearchProviderReady(nextProvider)) {
      onRequireSearchConfig?.({ reason: 'missing_api_key', selectProvider: nextProvider });
      return;
    }
    setModelOpen(false);
    commitSearchPreference({
      webSearchEnabled: true,
      searchProvider: nextProvider,
    });
    setSearchOpen(true);
  };
  const toggleMcp = () => {
    if (busy || disabled) return;
    if (!mcpAvailable) {
      onRequireMcpConfig?.();
      return;
    }
    setSearchOpen(false);
    setModelOpen(false);
    if (mcpMode === 'auto') {
      onMcpSelectionChange?.({ mode: 'off' });
      setMcpOpen(false);
      return;
    }
    onMcpSelectionChange?.({ mode: 'auto' });
    setMcpOpen(true);
  };
  const selectSearchProvider = (providerId) => {
    if (!isSearchProviderReady(providerId)) {
      onRequireSearchConfig?.({ reason: 'missing_api_key', selectProvider: providerId });
      setSearchOpen(false);
      return;
    }
    commitSearchPreference({
      webSearchEnabled: true,
      searchProvider: providerId,
    });
    setSearchOpen(false);
  };

  const handlePaste = (event) => {
    if (!parsedAttachmentMode || busy || disabled) return;
    const clipboard = event.clipboardData;
    const pastedFiles = getClipboardFiles(clipboard);
    if (pastedFiles.length > 0) {
      event.preventDefault();
      pastedFiles.forEach((file) => {
        addFiles([file], {
          sourceKind: 'clipboard_file',
          mediaKind: isSupportedImageFile(file) ? 'image' : 'attachment',
        });
      });
      return;
    }
    const text = clipboard?.getData('text/plain') || '';
    if (text.length > LONG_PASTE_ATTACHMENT_THRESHOLD) {
      event.preventDefault();
      const suffix = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      const file = new File([text], `pasted-text-${suffix}.txt`, { type: 'text/plain' });
      addFiles([file], { sourceKind: 'pasted_text', mediaKind: 'attachment' });
      toast('粘贴文本较长，已转为 TXT 附件。', 'info');
    }
  };

  return (
    <div className="notus-agent-composer-dock" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, background: 'linear-gradient(0deg, ' + C.page + ' 0%, ' + C.page + ' 68%, rgba(253,252,251,0) 100%)', zIndex: 6 }}>
      {imagePreview ? <ImagePreviewOverlay preview={imagePreview} onClose={() => setImagePreview(null)} onMove={moveImagePreview} /> : null}
      <div className="notus-agent-composer-shell" aria-busy={loading || undefined} style={{ width: AGENT_CHAT_CONTENT_WIDTH, maxWidth: 'none', margin: '0 auto', background: '#fff', boxShadow: focused ? '0 4px 24px rgba(217,119,87,0.08), inset 0 0 0 1px rgba(217,119,87,0.30)' : '0 2px 12px rgba(0,0,0,0.03), inset 0 0 0 1px rgba(229,227,216,0.95)', transitionProperty: 'box-shadow', transitionDuration: '180ms', transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)', overflow: 'visible' }}>
        <input ref={fileInputRef} type="file" multiple accept={parsedAttachmentMode ? `${PARSED_ATTACHMENT_ACCEPT},${IMAGE_ACCEPT}` : undefined} style={{ display: 'none' }} onChange={(event) => { addFiles(event.target.files, { mediaKind: 'attachment' }); event.target.value = ''; }} />
        <input ref={imageInputRef} type="file" multiple accept={IMAGE_ACCEPT} style={{ display: 'none' }} onChange={(event) => { addFiles(event.target.files, { mediaKind: 'image' }); event.target.value = ''; }} />
        {files.length > 0 ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '14px 16px 4px', maxHeight: 150, overflowY: 'auto' }}>{files.map((file) => <FileChip key={file.id} file={file} imageOnly={isImageMedia(file)} onPreview={openImagePreview} onRemove={(id) => {
          composerInteractionRef.current = true;
          setImagePreview((previous) => previous?.images?.some((image) => image.id === id) ? null : previous);
          setFiles((prev) => {
            const target = prev.find((item) => item.id === id);
            revokePreview(target);
            const mediaKind = isImageMedia(target) ? 'image' : 'attachment';
            selectedMediaCountRef.current[mediaKind] = Math.max(0, (selectedMediaCountRef.current[mediaKind] || 0) - 1);
            return prev.filter((item) => item.id !== id);
          });
        }} />)}</div> : null}
        <div style={{ position: 'relative', padding: '10px 16px 8px' }}>
          <div
            ref={composerRef}
            className="notus-agent-composer"
            contentEditable={!(busy || disabled)}
            role="textbox"
            aria-multiline="true"
            aria-label={placeholder || '在此输入以唤起 Agent Loop...'}
            data-placeholder={placeholder || '在此输入以唤起 Agent Loop...'}
            suppressContentEditableWarning
            onFocus={() => setFocused(true)}
            onBlur={() => { setFocused(false); }}
            onPaste={handlePaste}
            onInput={() => {
              composerInteractionRef.current = true;
              syncComposerState();
              updateMentionQuery();
              setDismissedMentionKey('');
            }}
            onClick={updateMentionQuery}
            onKeyUp={updateMentionQuery}
            onSelect={updateMentionQuery}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => {
              setIsComposing(false);
              updateMentionQuery();
            }}
            onDragEnter={(event) => {
              if (!Array.from(event.dataTransfer?.types || []).includes('application/x-notus-mention')) return;
              event.preventDefault();
              mentionDropCounterRef.current += 1;
              setMentionDropActive(true);
            }}
            onDragOver={(event) => {
              if (!Array.from(event.dataTransfer?.types || []).includes('application/x-notus-mention')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
              if (!Array.from(event.dataTransfer?.types || []).includes('application/x-notus-mention')) return;
              event.preventDefault();
              mentionDropCounterRef.current = Math.max(0, mentionDropCounterRef.current - 1);
              if (mentionDropCounterRef.current === 0) setMentionDropActive(false);
            }}
            onDrop={handleMentionDrop}
            onKeyDown={handleKeyDown}
            style={{ width: '100%', minHeight: AGENT_INPUT_TEXTAREA_DEFAULT_ROWS * AGENT_INPUT_LINE_HEIGHT + 2, maxHeight: 196, overflowY: 'auto', outline: 'none', background: mentionDropActive ? 'rgba(251,228,210,0.26)' : 'transparent', color: disabled ? C.tertiary : C.text, fontSize: 15, lineHeight: 1.65, padding: 0, fontFamily: 'inherit', boxSizing: 'border-box', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: 'normal', borderRadius: 8, transition: 'background 120ms ease' }}
          />
          {activeMention ? (
            <div style={{ position: 'absolute', left: 14, right: 14, bottom: 'calc(100% + 8px)', padding: 8, borderRadius: 16, background: '#fff', boxShadow: '0 -10px 40px -10px rgba(0,0,0,0.14), inset 0 0 0 1px rgba(229,227,216,0.95)', zIndex: 24 }}>
              {activeMention.options.length > 0 ? (
                <div ref={mentionListRef} style={{ maxHeight: 256, overflowY: 'auto', overscrollBehavior: 'contain', paddingRight: 2 }}>
                  {activeMention.options.map((option, index) => (
                    <button
                      key={option.value || option.token || index}
                      ref={(node) => {
                        mentionOptionRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applyMention(option)}
                      onMouseEnter={() => setActiveMentionIndex(index)}
                      style={transitionButton({
                        width: '100%',
                        minHeight: 52,
                        padding: '9px 11px',
                        borderRadius: 12,
                        background: index === activeMentionIndex ? 'rgba(251,228,210,0.34)' : 'transparent',
                        color: C.text,
                        display: 'grid',
                        gap: 4,
                        textAlign: 'left',
                        marginBottom: index === activeMention.options.length - 1 ? 0 : 4,
                      })}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        {option.kind === 'folder' ? <Icons.folderOpen size={15} style={{ color: C.accent, flexShrink: 0 }} /> : option.kind === 'skill' ? <Icons.skill size={15} style={{ color: C.accent, flexShrink: 0 }} /> : <Icons.file size={15} style={{ color: C.accent, flexShrink: 0 }} />}
                        <span style={{ minWidth: 0, fontSize: 13, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
                      </span>
                      <span style={{ minWidth: 0, fontSize: 12, color: C.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.preview}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ padding: '8px 10px', fontSize: 12, color: C.tertiary }}>没有匹配的文件、目录或 Skill</div>
              )}
            </div>
          ) : null}
        </div>
        <div className="notus-agent-composer__footer">
          <div className="notus-agent-composer__tools">
            <div className="notus-agent-composer__attachments">
              <button type="button" aria-label="添加附件" onClick={() => fileInputRef.current?.click()} disabled={busy || disabled} style={transitionButton({ width: 30, height: 30, borderRadius: 10, background: 'transparent', color: C.tertiary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: busy || disabled ? 0.5 : 1 })}><Icons.paperclip size={18} /></button>
              <button type="button" aria-label="添加图片" onClick={() => imageInputRef.current?.click()} disabled={busy || disabled} style={transitionButton({ width: 30, height: 30, borderRadius: 10, background: 'transparent', color: C.tertiary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: busy || disabled ? 0.5 : 1 })}><Icons.image size={18} /></button>
            </div>
            <div className="notus-agent-composer__task-controls">
              {showAgentConfirmMode ? <AgentConfirmModeSelect value={agentConfirmMode} onChange={onAgentConfirmModeChange} disabled={busy || disabled} /> : null}
              <div className="notus-agent-composer__network-tools">
              <div style={{ position: 'relative' }}>
                <Tooltip content="联网搜索">
                  <span style={{ display: 'inline-flex' }}>
                    <button type="button" aria-label="联网搜索" onClick={toggleWebSearch} disabled={busy || disabled} style={transitionButton({ height: 28, padding: '0 10px', borderRadius: 8, background: webSearchSelected ? 'rgba(251,228,210,0.40)' : 'transparent', color: webSearchSelected ? C.accent : C.tertiary, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: webSearchSelected ? 800 : 600, opacity: busy || disabled ? 0.5 : 1 })}><Icons.globe size={15} /><span className="notus-agent-control-label">联网</span></button>
                  </span>
                </Tooltip>
              {searchOpen ? (
                <>
                  <button type="button" aria-label="关闭搜索商下拉" onClick={() => setSearchOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 19, border: 0, background: 'transparent', padding: 0 }} />
                  <div role="radiogroup" aria-label="搜索引擎" style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, width: 192, padding: '8px 0', borderRadius: 14, background: '#fff', boxShadow: '0 -10px 40px -10px rgba(0,0,0,0.10), inset 0 0 0 1px rgba(229,227,216,0.95)', zIndex: 20 }}>
                    <div style={{ padding: '6px 16px', color: '#A3A19A', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5 }}>搜索引擎</div>
                    {providers.map((provider) => {
                      const checked = selectedSearchProvider === provider.id;
                      return (
                        <button type="button" role="radio" aria-checked={checked} key={provider.id} onClick={() => selectSearchProvider(provider.id)} style={transitionButton({ width: '100%', minHeight: 34, padding: '0 16px', background: checked ? 'rgba(251,228,210,0.30)' : 'transparent', color: checked ? C.accent : C.secondary, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, fontWeight: checked ? 800 : 500, textAlign: 'left' })}>{provider.name}{checked ? <Icons.check size={14} style={{ color: C.accent }} /> : null}</button>
                      );
                    })}
                  </div>
                </>
              ) : null}
              </div>
              <div style={{ position: 'relative' }}>
                <Tooltip content={mcpAvailable ? 'MCP 工具' : '暂无 MCP 服务'}>
                  <span style={{ display: 'inline-flex' }}>
                    <button type="button" aria-label={mcpAvailable ? '切换 MCP 自动工具' : '暂无 MCP 服务'} aria-disabled={busy || disabled || !mcpAvailable} onClick={toggleMcp} disabled={busy || disabled || !mcpAvailable} style={transitionButton({ height: 28, padding: '0 10px', borderRadius: 8, background: mcpEnabled ? 'rgba(251,228,210,0.40)' : 'transparent', color: mcpEnabled ? C.accent : C.tertiary, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: mcpEnabled ? 800 : 600, opacity: busy || disabled || !mcpAvailable ? 0.5 : 1, cursor: busy || disabled || !mcpAvailable ? 'not-allowed' : undefined })}><Icons.mcp size={15} /><span className="notus-agent-control-label">{mcpLabel}</span></button>
                  </span>
                </Tooltip>
                {mcpOpen && mcpAvailable ? (
                  <>
                    <button type="button" aria-label="关闭 MCP 自动下拉" onClick={() => setMcpOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 19, border: 0, background: 'transparent', padding: 0 }} />
                    <div role="radiogroup" aria-label="MCP 工具" style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, width: 132, padding: '8px 0', borderRadius: 14, background: '#fff', boxShadow: '0 -10px 40px -10px rgba(0,0,0,0.10), inset 0 0 0 1px rgba(229,227,216,0.95)', zIndex: 20 }}>
                      <button type="button" role="radio" aria-checked={mcpMode === 'auto'} onClick={() => { onMcpSelectionChange?.({ mode: 'auto' }); setMcpOpen(false); }} style={transitionButton({ width: '100%', minHeight: 34, padding: '0 16px', background: mcpMode === 'auto' ? 'rgba(251,228,210,0.30)' : 'transparent', color: mcpMode === 'auto' ? C.accent : C.secondary, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, fontWeight: mcpMode === 'auto' ? 800 : 600, textAlign: 'left' })}>自动{mcpMode === 'auto' ? <Icons.check size={14} style={{ color: C.accent }} /> : null}</button>
                    </div>
                  </>
                ) : null}
              </div>
              </div>
            </div>
          </div>
          <div className="notus-agent-composer__actions">
            <div style={{ position: 'relative' }}>
              <Tooltip content={modelLabel(selectedConfig)} disabled={!selectedConfig}><span style={{ display: 'inline-flex', minWidth: 0 }}><button type="button" className="notus-agent-composer__model" onClick={() => { setSearchOpen(false); setMcpOpen(false); setModelOpen((prev) => !prev); }} disabled={busy || disabled || llmConfigs.length === 0} style={transitionButton({ height: 28, padding: '0 8px', borderRadius: 8, background: 'transparent', color: C.secondary, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700, opacity: llmConfigs.length === 0 || disabled ? 0.55 : 1 })}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelLabel(selectedConfig)}</span><Icons.chevronDown size={13} /></button></span></Tooltip>
              {modelOpen ? (
                <>
                  <button type="button" aria-label="关闭模型下拉" onClick={() => setModelOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 19, border: 0, background: 'transparent', padding: 0 }} />
                  <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', right: 0, width: 260, maxHeight: '40vh', overflowY: 'auto', padding: '8px 0', borderRadius: 14, background: '#fff', boxShadow: '0 -10px 40px -10px rgba(0,0,0,0.10), inset 0 0 0 1px rgba(229,227,216,0.95)', zIndex: 20 }}>
                    <div style={{ padding: '2px 8px 8px' }}><input ref={modelSearchRef} value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索模型或 Provider" aria-label="搜索模型或 Provider" style={{ width: '100%', height: 32, padding: '0 10px', border: '1px solid #E5E3D8', borderRadius: 9, outline: 'none', boxSizing: 'border-box', color: C.text, fontSize: 12, fontFamily: 'inherit' }} /></div>
                    {groupedConfigs.length === 0 ? <div style={{ padding: 12, fontSize: 13, color: C.tertiary }}>暂无模型配置</div> : filteredGroupedConfigs.length === 0 ? <div style={{ padding: 12, fontSize: 13, color: C.tertiary }}>没有匹配的模型或 Provider</div> : filteredGroupedConfigs.map((group, index) => (
                      <div key={group.label} style={{ marginTop: index > 0 ? 8 : 0, paddingTop: index > 0 ? 8 : 0, borderTop: index > 0 ? '1px solid #F2F0EA' : 'none' }}>
                        <div style={{ position: 'sticky', top: 0, padding: '6px 16px', color: '#A3A19A', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, background: 'rgba(255,255,255,0.92)' }}>{group.label}</div>
                        {group.configs.map((config) => {
                          const active = String(config.id) === String(selectedConfig?.id);
                          return (
                            <button type="button" key={config.id} onClick={() => { onConfigChange?.(config.id); setModelOpen(false); }} style={transitionButton({ width: '100%', minHeight: 34, padding: '7px 16px', background: active ? 'rgba(251,228,210,0.30)' : 'transparent', color: active ? C.accent : C.secondary, textAlign: 'left', fontSize: 13, fontWeight: active ? 800 : 500 })}>{modelLabel(config)}</button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            <Tooltip content={canInterrupt ? '中断当前任务' : '发送'}><span style={{ display: 'inline-flex' }}><button type="button" aria-label={canInterrupt ? '中断当前任务' : '发送'} disabled={!primaryActionEnabled} onClick={handlePrimaryAction} style={transitionButton({ width: 34, height: 34, borderRadius: 10, background: primaryActionEnabled ? C.accent : C.muted, color: primaryActionEnabled ? '#fff' : '#BDBBB3', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: primaryActionEnabled ? 'pointer' : 'not-allowed', boxShadow: primaryActionEnabled ? '0 6px 18px rgba(217,119,87,0.22)' : 'none' })}>{canInterrupt ? <Icons.square size={16} /> : uploading ? <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: 999, display: 'inline-block', boxSizing: 'border-box', border: '2px solid rgba(255,255,255,0.45)', borderTopColor: '#fff', animation: 'spin 0.82s linear infinite' }} /> : <Icons.arrowUp size={18} />}</button></span></Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfigHeader({ title, onBack }) {
  return (
    <header style={{ height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'sticky', top: 0, zIndex: 12, background: 'rgba(255,255,255,0.84)', boxShadow: 'inset 0 -1px 0 rgba(229,227,216,0.9)', backdropFilter: 'blur(10px)' }}>
      <button type="button" aria-label="返回聊天" onClick={onBack} style={transitionButton({ position: 'absolute', left: 16, height: 34, padding: '0 12px', borderRadius: 11, background: C.soft, color: C.secondary, display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700 })}><Icons.chevronLeft size={14} /> 返回</button>
      <div style={{ fontFamily: 'Georgia, Songti SC, STSong, serif', fontSize: 17, fontWeight: 800, color: C.text }}>{title}</div>
    </header>
  );
}

function ConfigSection({ title, subtitle, children }) {
  return (
    <section style={{ padding: 22, borderRadius: 22, background: '#fff', boxShadow: '0 10px 30px rgba(45,45,45,0.055), inset 0 0 0 1px rgba(229,227,216,0.74)' }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: C.text }}>{title}</div>
        {subtitle ? <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.65, color: C.tertiary }}>{subtitle}</div> : null}
      </div>
      {children}
    </section>
  );
}

function EmbeddingConfigPanel() {
  const toast = useToast();
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [multimodal, setMultimodal] = useState(false);
  const [dim, setDim] = useState(null);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verificationToken, setVerificationToken] = useState('');
  const provider = useMemo(() => inferEmbeddingProvider({ baseUrl, model }), [baseUrl, model]);
  const modelMeta = useMemo(() => findEmbeddingModelMeta({ baseUrl, model }), [baseUrl, model]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings').then((response) => response.json()).then((settings) => {
      if (cancelled) return;
      setModel(settings.embedding?.model || '');
      setBaseUrl(settings.embedding?.base_url || '');
      setMultimodal(Boolean(settings.embedding?.multimodal_enabled));
      setDim(Number(settings.embedding?.dim || 0) || null);
      setApiKeySet(Boolean(settings.embedding?.api_key_set));
    }).catch(() => toast('读取 Embedding 配置失败', 'error'));
    return () => { cancelled = true; };
  }, [toast]);

  const runTest = async () => {
    if (!model.trim()) {
      toast('请填写 Embedding 模型名', 'warning');
      return;
    }
    setTesting(true);
    try {
      const response = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'embedding', config: { model, base_url: baseUrl, api_key: apiKey, multimodal_enabled: multimodal } }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Embedding 测试失败');
      setDim(Number(payload.dimension || 0) || Number(modelMeta?.dimension || 0) || null);
      setVerificationToken(payload.verification_token || '');
      toast('Embedding 测试成功', 'success');
    } catch (error) {
      setVerificationToken('');
      toast(error.message || 'Embedding 测试失败', 'error');
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const resolvedDim = Number(dim || modelMeta?.dimension || 0) || null;
    if (!model.trim()) {
      toast('请填写 Embedding 模型名', 'warning');
      return;
    }
    if (!resolvedDim || !verificationToken) {
      toast('请先完成 Embedding 测试', 'warning');
      return;
    }
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embedding: { provider, model, dim: resolvedDim, multimodal_enabled: multimodal, base_url: baseUrl, api_key: apiKey, verification_token: verificationToken } }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存 Embedding 失败');
      setApiKey('');
      setApiKeySet(Boolean(payload.embedding?.api_key_set));
      setVerificationToken('');
      toast('Embedding 配置已保存', 'success');
    } catch (error) {
      toast(error.message || '保存 Embedding 失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ display: 'grid', gap: 6, fontSize: 12, color: C.tertiary }}>Base URL<TextInput value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" /></label>
        <label style={{ display: 'grid', gap: 6, fontSize: 12, color: C.tertiary }}>模型名称<TextInput value={model} onChange={(event) => setModel(event.target.value)} placeholder="text-embedding-v3" /></label>
      </div>
      <label style={{ display: 'grid', gap: 6, fontSize: 12, color: C.tertiary }}>API Key<TextInput value={apiKey} onChange={(event) => setApiKey(event.target.value)} masked placeholder={apiKeySet ? '留空则继续使用当前密钥' : 'sk-...'} /></label>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.secondary }}><Toggle on={multimodal} onChange={setMultimodal} />启用多模态 Embedding</label>
        <span style={{ fontSize: 12, color: C.tertiary }}>Provider：{provider || 'auto'}{dim ? ' · ' + dim + ' 维' : ''}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button variant="secondary" loading={testing} onClick={runTest}>测试 Embedding</Button>
        <Button variant="primary" loading={saving} onClick={save}>保存 Embedding</Button>
      </div>
    </div>
  );
}

function ModelConfigView({ onBack }) {
  return (
    <div style={{ height: '100%', overflow: 'auto', background: C.page }}>
      <ConfigHeader title="模型配置" onBack={onBack} />
      <div style={{ maxWidth: 920, margin: '0 auto', padding: '30px 22px 80px', display: 'grid', gap: 22 }}>
        <ConfigSection title="Embedding 模型" subtitle="用于知识库索引和语义检索。保存前仍需要测试，以确认向量维度。"><EmbeddingConfigPanel /></ConfigSection>
        <ConfigSection title="LLM 配置" subtitle="新增和修改 LLM 配置时选择兼容协议；保存不要求连通性测试。"><LlmConfigCardsSection compact title="" subtitle="" /></ConfigSection>
      </div>
    </div>
  );
}

function SearchConfigView({ config, onSaved, onBack, selectProvider }) {
  const toast = useToast();
  const providers = config.providers || SEARCH_PROVIDER_FALLBACKS;
  const [enabled, setEnabled] = useState(Boolean(config.enabled));
  const [activeProvider, setActiveProvider] = useState(selectProvider || config.selected_provider || providers[0]?.id || 'firecrawl');
  const [modes, setModes] = useState(config.modes || {});
  const [counts, setCounts] = useState(config.counts || {});
  const [apiKeys, setApiKeys] = useState({});
  const [saving, setSaving] = useState(false);
  const provider = providers.find((item) => item.id === activeProvider) || providers[0];
  const modeOptions = SEARCH_MODE_LABELS[activeProvider] || [{ value: 'default', label: '默认' }];

  useEffect(() => {
    if (selectProvider) setActiveProvider(selectProvider);
  }, [selectProvider]);

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/settings/search-providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, selected_provider: activeProvider, modes, counts, api_keys: apiKeys }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存搜索配置失败');
      onSaved?.(payload);
      setApiKeys({});
      toast('搜索配置已保存', 'success');
    } catch (error) {
      toast(error.message || '保存搜索配置失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ height: '100%', overflow: 'auto', background: C.page }}>
      <ConfigHeader title="搜索配置" onBack={onBack} />
      <div style={{ maxWidth: 920, margin: '0 auto', padding: '30px 22px 80px' }}>
        <ConfigSection title="联网搜索" subtitle="开启后，Agent Loop 可按需调用联网搜索工具。">
          <div style={{ display: 'grid', gap: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div><div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>启用联网搜索</div><div style={{ fontSize: 12, color: C.tertiary, marginTop: 4 }}>开启后，输入框可选择搜索服务商。</div></div>
              <Toggle on={enabled} onChange={setEnabled} />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {providers.map((item) => (
                <button key={item.id} type="button" onClick={() => setActiveProvider(item.id)} style={transitionButton({ height: 34, padding: '0 13px', borderRadius: 12, background: activeProvider === item.id ? 'rgba(251,228,210,0.48)' : C.soft, color: activeProvider === item.id ? C.accent : C.secondary, fontSize: 13, fontWeight: 800, boxShadow: activeProvider === item.id ? 'inset 0 0 0 1px rgba(217,119,87,0.28)' : 'none' })}>{item.name}</button>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <label style={{ display: 'grid', gap: 6, fontSize: 12, color: C.tertiary }}>调用模式<select value={modes[activeProvider] || modeOptions[0]?.value || 'default'} onChange={(event) => setModes((prev) => ({ ...prev, [activeProvider]: event.target.value }))} style={{ height: 38, border: '1px solid ' + C.border, borderRadius: 12, padding: '0 10px', background: '#fff', color: C.text }}>{modeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
              <label style={{ display: 'grid', gap: 6, fontSize: 12, color: C.tertiary }}>结果数：{counts[activeProvider] || 5}<input type="range" min="1" max={provider?.max_limit || 20} value={counts[activeProvider] || 5} onChange={(event) => setCounts((prev) => ({ ...prev, [activeProvider]: Number(event.target.value) }))} style={{ accentColor: C.accent }} /></label>
            </div>
            <label style={{ display: 'grid', gap: 6, fontSize: 12, color: C.tertiary }}>API Key<TextInput value={apiKeys[activeProvider] || ''} onChange={(event) => setApiKeys((prev) => ({ ...prev, [activeProvider]: event.target.value }))} masked placeholder={config.api_key_set?.[activeProvider] ? '留空则继续使用当前密钥' : provider?.requires_api_key === false ? '可选；留空使用 Firecrawl 无 Key 模式' : '请输入该服务商 API Key'} /></label>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <a href={provider?.quota_url || '#'} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.accent, textDecoration: 'none' }}>查看 {provider?.name} 控制台</a>
              <div style={{ display: 'flex', gap: 8 }}><Button variant="ghost" onClick={onBack}>取消</Button><Button variant="primary" loading={saving} onClick={save}>保存搜索配置</Button></div>
            </div>
          </div>
        </ConfigSection>
      </div>
    </div>
  );
}

export function AgentWorkspace({ messages, interactions = [], streamText, loading, error, activeSteps, activeSessionId = null, activeSessionStatus = '', sessionTimelines = {}, interruptibleSessionId = null, llmConfigs, selectedConfigId, onConfigChange, onSend, onStop, onResumeAgentTask, onConversationRewritten, onApplyOperationSet, onApplyOperationFile, onRollbackOperationFile, onDiscardOperationFile, onCitationClick, citationSelection, disabled, placeholder, agentConfirmMode, onAgentConfirmModeChange, attachmentMode = 'metadata', mentionOptions = [], fullWidth = false, onOpenDiffFile, restoringConversation = false }) {
  const { openSettings } = useSettingsDialog();
  const toast = useToast();
  const [searchConfig, setSearchConfig] = useState({ enabled: false, selected_provider: 'firecrawl', modes: {}, counts: {}, api_key_set: {}, providers: SEARCH_PROVIDER_FALLBACKS });
  const [searchPreference, setSearchPreference] = useState(() => readAgentInputPreference());
  const [searchPromptOpen, setSearchPromptOpen] = useState(false);
  const [mcpPromptOpen, setMcpPromptOpen] = useState(false);
  const [searchViewProvider, setSearchViewProvider] = useState('');
  const [searchPromptReason, setSearchPromptReason] = useState('disabled');
  const [detailOperationSet, setDetailOperationSet] = useState(null);
  const [attachmentDetail, setAttachmentDetail] = useState(null);
  const [previewMention, setPreviewMention] = useState(null);

  useEffect(() => {
    setDetailOperationSet((current) => {
      if (!current?.id) return current;
      const latest = (Array.isArray(messages) ? messages : [])
        .map((message) => message?.operationSet)
        .find((operationSet) => Number(operationSet?.id) === Number(current.id));
      return latest || current;
    });
  }, [messages]);
  const [messageImagePreview, setMessageImagePreview] = useState(null);
  const handlePrefetchMention = useCallback((mention) => prefetchMentionDocument(mention), []);
  const [mcpSelection, setMcpSelection] = useState(() => readMcpSelectionPreference());
  const [mcpAvailable, setMcpAvailable] = useState(false);
  const [mcpAvailabilityChecked, setMcpAvailabilityChecked] = useState(false);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [rewrittenMessages, setRewrittenMessages] = useState({});
  const [removingMessageIds, setRemovingMessageIds] = useState(() => new Set());
  const [hiddenMessageIds, setHiddenMessageIds] = useState(() => new Set());
  const scrollContainerRef = useRef(null);
  const shouldStickToBottomRef = useRef(true);
  const sourceMessages = useMemo(() => (Array.isArray(messages) ? messages : []), [messages]);

  const handleMcpSelectionChange = useCallback((next) => {
    const normalized = next?.mode === 'auto' ? { mode: 'auto' } : { mode: 'off' };
    setMcpSelection(normalized);
    try { window.localStorage.setItem(MCP_SELECTION_STORAGE_KEY, JSON.stringify(normalized)); } catch {}
  }, []);
  const refreshMcpAvailability = useCallback(async () => {
    try {
      const response = await fetch('/api/settings/mcp/servers?enabled_only=1', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '读取 MCP Server 失败');
      setMcpAvailable(Array.isArray(payload.servers) && payload.servers.length > 0);
    } catch {
      setMcpAvailable(false);
    } finally {
      setMcpAvailabilityChecked(true);
    }
  }, []);
  useEffect(() => {
    refreshMcpAvailability();
    const onFocus = () => refreshMcpAvailability();
    const onChanged = () => refreshMcpAvailability();
    window.addEventListener('focus', onFocus);
    window.addEventListener('notus-mcp-servers-changed', onChanged);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('notus-mcp-servers-changed', onChanged);
    };
  }, [refreshMcpAvailability]);
  useEffect(() => {
    if (mcpAvailabilityChecked && !mcpAvailable && mcpSelection.mode !== 'off') handleMcpSelectionChange({ mode: 'off' });
  }, [handleMcpSelectionChange, mcpAvailabilityChecked, mcpAvailable, mcpSelection.mode]);
  const visibleMessages = sourceMessages
    .filter((message) => !hiddenMessageIds.has(String(message.id)))
    .map((message) => {
      const rewritten = rewrittenMessages[String(message.id)];
      return rewritten === undefined ? message : { ...message, content: rewritten };
    });
  const visibleActiveSteps = Array.isArray(activeSteps) ? activeSteps : [];
  const lastMessage = visibleMessages[visibleMessages.length - 1] || null;
  const messageScrollKey = [
    visibleMessages.length,
    lastMessage?.id || '',
    String(lastMessage?.content || '').length,
    lastMessage?.operationSet?.id || '',
    lastMessage?.operationSet?.status || '',
  ].join(':');
  const activeStepsScrollKey = visibleActiveSteps
    .map((step) => [step?.id || '', step?.status || '', step?.label || '', step?.detail || '', step?.result || ''].join('/'))
    .join('|');

  useEffect(() => {
    const currentIds = new Set(sourceMessages.map((message) => String(message.id)));
    setHiddenMessageIds((prev) => {
      const next = new Set([...prev].filter((id) => currentIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setRemovingMessageIds((prev) => {
      const next = new Set([...prev].filter((id) => currentIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setRewrittenMessages((prev) => {
      const next = {};
      Object.keys(prev).forEach((id) => {
        if (currentIds.has(id)) next[id] = prev[id];
      });
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [sourceMessages]);

  const handleChatScroll = useCallback((event) => {
    const nearBottom = isNearScrollBottom(event.currentTarget);
    shouldStickToBottomRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/search-providers').then((response) => response.json()).then((payload) => {
      if (!cancelled) setSearchConfig((prev) => ({ ...prev, ...payload }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setSearchPreference(readAgentInputPreference());
  }, []);

  const handleSearchPreferenceChange = useCallback((nextPreference) => {
    setSearchPreference(nextPreference);
    writeAgentInputPreference(null, nextPreference);
  }, []);

  const handleOpenAttachment = useCallback((attachment, message) => {
    setAttachmentDetail({ attachment, message });
  }, []);

  const openMessageImagePreview = useCallback((message, selectedFile) => {
    const images = dedupeAgentMedia(message?.attachments)
      .filter(isImageMedia)
      .map((file) => ({
        id: file.id || file.stored_name || file.name,
        src: imagePreviewUrl(file),
        alt: file.name || '已上传图片',
      }))
      .filter((image) => image.src);
    const selectedId = selectedFile?.id || selectedFile?.stored_name || selectedFile?.name;
    const currentIndex = images.findIndex((image) => String(image.id) === String(selectedId));
    if (currentIndex >= 0) setMessageImagePreview({ images, currentIndex });
  }, []);

  const openToolchainImagePreview = useCallback((sourceImages, selectedImage) => {
    const images = dedupeAgentMedia(sourceImages)
      .map((image) => ({
        id: image.id || image.stored_name || image.preview_url,
        src: image.preview_url || getAgentImagePreviewUrl(image),
        alt: image.alt || '已查看图片',
      }))
      .filter((image) => image.src);
    const selectedId = selectedImage?.id || selectedImage?.stored_name || selectedImage?.preview_url;
    const currentIndex = images.findIndex((image) => String(image.id) === String(selectedId));
    if (currentIndex >= 0) setMessageImagePreview({ images, currentIndex, hideTitle: true });
  }, []);

  const moveMessageImagePreview = useCallback((direction) => {
    setMessageImagePreview((previous) => {
      if (!previous) return previous;
      const currentIndex = Math.min(Math.max(previous.currentIndex + direction, 0), previous.images.length - 1);
      return currentIndex === previous.currentIndex ? previous : { ...previous, currentIndex };
    });
  }, []);

  useIsomorphicLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (!shouldStickToBottomRef.current && !isNearScrollBottom(container)) {
      setShowJumpToBottom(true);
      return;
    }
    scrollContainerToBottom(container);
    shouldStickToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [messageScrollKey, String(streamText || '').length, Boolean(loading), activeStepsScrollKey, error]);

  useEffect(() => {
    if (!detailOperationSet?.id) return;
    const next = (Array.isArray(messages) ? messages : [])
      .map((message) => message.operationSet)
      .find((operationSet) => Number(operationSet?.id || 0) === Number(detailOperationSet.id));
    if (next && next !== detailOperationSet) setDetailOperationSet(next);
  }, [detailOperationSet, messages]);

  const requireSearchConfig = useCallback(({ selectProvider = '', quiet = false, reason = 'disabled' } = {}) => {
    if (selectProvider) {
      setSearchViewProvider(selectProvider);
      setSearchConfig((prev) => ({ ...prev, selected_provider: selectProvider }));
    }
    setSearchPromptReason(reason);
    if (!quiet) setSearchPromptOpen(true);
  }, []);
  const promptProvider = (searchConfig.providers || SEARCH_PROVIDER_FALLBACKS).find((provider) => provider.id === searchViewProvider)
    || (searchConfig.providers || SEARCH_PROVIDER_FALLBACKS).find((provider) => provider.id === searchConfig.selected_provider)
    || SEARCH_PROVIDER_FALLBACKS[0];
  const promptTitle = searchPromptReason === 'missing_api_key' ? '需要配置搜索服务商' : '联网搜索未开启';
  const promptMessage = searchPromptReason === 'missing_api_key'
    ? `${promptProvider?.name || '该搜索服务商'} 需要先配置 API Key。前往设置后会自动切换到对应服务商。`
    : '需要开启联网搜索功能才能使用，请前往设置 → 搜索配置 → 启用联网搜索。';
  const selectedModelId = selectedConfigId || llmConfigs?.[0]?.id || null;
  const activeSearchProvider = String(searchPreference?.searchProvider || '').trim();
  const activeWebSearchEnabled = Boolean(searchConfig.enabled && searchPreference?.webSearchEnabled && activeSearchProvider);

  const isSearchProviderReady = useCallback((providerId) => {
    const provider = (searchConfig.providers || SEARCH_PROVIDER_FALLBACKS).find((item) => item.id === providerId);
    if (!provider) return false;
    if (!providerNeedsApiKey(provider)) return true;
    return Boolean(searchConfig.api_key_set?.[providerId]);
  }, [searchConfig.api_key_set, searchConfig.providers]);

  const handleResendMessage = useCallback(async (sourceMessage, options = {}) => {
    const nextContent = String(options.content ?? sourceMessage?.content ?? '').trim();
    const sourceMeta = sourceMessage?.meta && typeof sourceMessage.meta === 'object' ? sourceMessage.meta : {};
    const sourceMedia = dedupeAgentMedia([
      ...(Array.isArray(sourceMessage?.attachments) ? sourceMessage.attachments : []),
      ...(Array.isArray(sourceMeta.attachments) ? sourceMeta.attachments : []),
      ...(Array.isArray(sourceMeta.images) ? sourceMeta.images.map((image) => ({ ...image, source_kind: 'image', media_kind: 'image' })) : []),
    ]);
    const sourceImages = sourceMedia.filter(isImageMedia);
    const sourceAttachments = sourceMedia.filter((file) => !isImageMedia(file));
    const sourceMediaItems = Array.isArray(sourceMeta.media_items) && sourceMeta.media_items.length > 0
      ? dedupeAgentMedia(sourceMeta.media_items)
      : sourceMedia;
    const hasOriginalSearchPreference = Object.prototype.hasOwnProperty.call(sourceMeta, 'web_search_enabled');
    const retryWebSearchEnabled = options.reason === 'retry' && hasOriginalSearchPreference
      ? Boolean(sourceMeta.web_search_enabled)
      : activeWebSearchEnabled;
    const retrySearchProvider = options.reason === 'retry' && sourceMeta.search_provider
      ? String(sourceMeta.search_provider)
      : activeSearchProvider;
    const retryMcpSelection = options.reason === 'retry' && sourceMeta.mcp_selection?.mode
      ? (sourceMeta.mcp_selection.mode === 'auto' ? { mode: 'auto' } : { mode: 'off' })
      : mcpSelection;
    if (!nextContent) {
      toast('当前消息没有可发送内容', 'warning');
      return false;
    }
    if (!selectedModelId) {
      toast('请先在模型配置中新增至少一个 LLM 配置', 'warning');
      return false;
    }
    if (retryWebSearchEnabled && !searchConfig.enabled) {
      requireSearchConfig({ reason: 'disabled', selectProvider: retrySearchProvider });
      return false;
    }
    if (retryWebSearchEnabled && !isSearchProviderReady(retrySearchProvider)) {
      requireSearchConfig({ reason: 'missing_api_key', selectProvider: retrySearchProvider });
      return false;
    }

    let hiddenOptimisticMessageKey = '';
    try {
      const isRewrite = options.reason === 'rewrite';
      // 改写与重试都会从当前用户消息截断。重试不改写原文，但必须移除旧回答及其后的分支，
      // 否则启动新任务会追加一条相同用户消息，历史上下文也会出现两次相同请求。
      const replacesConversation = isRewrite || options.reason === 'retry';
      if (replacesConversation) {
        const sourceId = sourceMessage?.id;
        const conversationId = Number(sourceMessage?.conversationId || sourceMessage?.conversation_id || 0) || null;
        const hasSavedSourceMessage = Boolean(conversationId && Number.isFinite(Number(sourceId)) && Number(sourceId) > 0);
        if (!hasSavedSourceMessage && isRewrite) {
          throw new Error('当前消息尚未完成服务端保存，无法改写。请稍后重试。');
        }
        const sourceKey = String(sourceId || '');
        if (hasSavedSourceMessage) {
          const sourceIndex = sourceMessages.findIndex((message) => String(message.id) === sourceKey);
          const futureMessages = sourceIndex >= 0 ? sourceMessages.slice(sourceIndex + 1) : [];
          const futureIds = futureMessages.map((message) => String(message.id));
          const response = await fetch(`/api/conversations/${conversationId}/truncate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message_id: Number(sourceId),
              content: nextContent,
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error || '清理后续对话失败');

          onConversationRewritten?.(payload);

          setRewrittenMessages((prev) => ({ ...prev, [sourceKey]: nextContent }));
          setRemovingMessageIds((prev) => {
            const next = new Set(prev);
            futureIds.forEach((id) => next.add(id));
            return next;
          });
          if (futureIds.length > 0) {
            window.setTimeout(() => {
              setHiddenMessageIds((prev) => {
                const next = new Set(prev);
                futureIds.forEach((id) => next.add(id));
                return next;
              });
              setRemovingMessageIds((prev) => {
                const next = new Set(prev);
                futureIds.forEach((id) => next.delete(id));
                return next;
              });
            }, 220);
          }
        } else if (options.reason === 'retry' && sourceKey) {
          // POST 尚未落库时，乐观用户气泡不能参与下一次消息列表，否则重试会显示两条相同 prompt。
          hiddenOptimisticMessageKey = sourceKey;
          setHiddenMessageIds((prev) => new Set([...prev, sourceKey]));
        }
      }

      await onSend?.(nextContent, {
        llmConfigId: selectedModelId,
        attachments: sourceAttachments,
        images: sourceImages,
        mediaItems: sourceMediaItems,
        mentions: isRewrite ? [] : (Array.isArray(sourceMessage?.mentions) ? sourceMessage.mentions : []),
        mentionSegments: isRewrite ? [{ type: 'text', text: nextContent }] : (Array.isArray(sourceMessage?.mentionSegments) ? sourceMessage.mentionSegments : []),
        rewriteUserMessageId: replacesConversation && Number(sourceMessage?.id || 0) > 0 ? Number(sourceMessage.id) : null,
        webSearchEnabled: retryWebSearchEnabled,
        searchProvider: retryWebSearchEnabled ? retrySearchProvider : null,
        searchProviders: retryWebSearchEnabled ? [retrySearchProvider] : [],
        mcpSelection: retryMcpSelection,
        skipUserMessageAppend: replacesConversation && Number(sourceMessage?.id || 0) > 0,
      });
      return true;
    } catch (sendError) {
      if (hiddenOptimisticMessageKey) {
        setHiddenMessageIds((prev) => {
          const next = new Set(prev);
          next.delete(hiddenOptimisticMessageKey);
          return next;
        });
      }
      toast(sendError.message || (options.reason === 'retry' ? '重试失败' : '重新发送失败'), 'error');
      return false;
    }
  }, [
    activeSearchProvider,
    activeWebSearchEnabled,
    isSearchProviderReady,
    onSend,
    onConversationRewritten,
    requireSearchConfig,
    searchConfig.enabled,
    selectedModelId,
    sourceMessages,
    toast,
    mcpSelection,
  ]);

  return (
    <div className="notus-agent-workspace" style={{ position: 'relative', height: '100%', minHeight: 0, minWidth: 0, maxWidth: '100%', background: C.page, color: C.text, overflow: 'hidden', WebkitFontSmoothing: 'antialiased', MozOsxFontSmoothing: 'grayscale' }}>
      {messageImagePreview ? <ImagePreviewOverlay preview={messageImagePreview} onClose={() => setMessageImagePreview(null)} onMove={moveMessageImagePreview} /> : null}
      <main ref={scrollContainerRef} onScroll={handleChatScroll} className="notus-agent-workspace__scroll" style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
        <div className="notus-agent-workspace__content" style={{ width: AGENT_CHAT_CONTENT_WIDTH, maxWidth: 'none', minWidth: 0, margin: '0 auto', overflow: 'hidden' }}>
          {restoringConversation ? (
            <div className="notus-agent-conversation-restore" role="status" aria-live="polite">
              <Spinner size={16} />
              <div>
                <strong>正在恢复上次对话…</strong>
                <span>消息与执行记录将自动显示</span>
              </div>
            </div>
          ) : <MessageList
            messages={visibleMessages}
            interactions={interactions}
            streamText={streamText || ''}
            error={error || ''}
            loading={Boolean(loading)}
            activeSteps={visibleActiveSteps}
            activeSessionId={activeSessionId}
            activeSessionStatus={activeSessionStatus}
            sessionTimelines={sessionTimelines}
            removingMessageIds={removingMessageIds}
            onOpenOperationSet={setDetailOperationSet}
            onCitationClick={onCitationClick}
            citationSelection={citationSelection}
            actionDisabled={Boolean(disabled)}
            onResendMessage={handleResendMessage}
            onRetryMessage={handleResendMessage}
            onOpenAttachment={handleOpenAttachment}
            onPreviewMention={setPreviewMention}
            onPrefetchMention={handlePrefetchMention}
            onPreviewImages={openMessageImagePreview}
            onPreviewToolchainImages={openToolchainImagePreview}
            onAgentStepAction={(action, _step, sessionId) => {
              if (action === 'stop_agent') void onStop?.(sessionId);
              if (action === 'resume_agent') void onResumeAgentTask?.(sessionId);
            }}
          />}
          <div style={{ height: 12 }} />
        </div>
      </main>
      {showJumpToBottom && (visibleMessages.length > 0 || loading) ? (
        <button
          type="button"
          aria-label="滚动到最新消息"
          onClick={() => {
            const container = scrollContainerRef.current;
            if (!container) return;
            scrollContainerToBottom(container, 'smooth');
            shouldStickToBottomRef.current = true;
            setShowJumpToBottom(false);
          }}
          className="notus-agent-pressable"
          style={transitionButton({
            position: 'absolute',
            left: '50%',
            bottom: CHAT_JUMP_BUTTON_OFFSET,
            transform: 'translateX(-50%)',
            width: 34,
            height: 34,
            padding: 0,
            borderRadius: 999,
            background: '#fff',
            color: C.secondary,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 10px 28px rgba(45,45,45,0.12), inset 0 0 0 1px rgba(229,227,216,0.95)',
            zIndex: 9,
          })}
        >
          <Icons.chevronDown size={14} />
        </button>
      ) : null}
      <AgentInput loading={Boolean(loading)} disabled={Boolean(disabled)} llmConfigs={llmConfigs || []} selectedConfigId={selectedConfigId} onConfigChange={onConfigChange} onSend={onSend} onInterrupt={onStop} interruptibleSessionId={interruptibleSessionId} searchConfig={searchConfig} searchPreference={searchPreference} onSearchPreferenceChange={handleSearchPreferenceChange} onRequireSearchConfig={requireSearchConfig} onRequireMcpConfig={() => setMcpPromptOpen(true)} mcpSelection={mcpSelection} onMcpSelectionChange={handleMcpSelectionChange} mcpAvailable={mcpAvailable} mcpAvailabilityChecked={mcpAvailabilityChecked} placeholder={placeholder} agentConfirmMode={agentConfirmMode} onAgentConfirmModeChange={onAgentConfirmModeChange} attachmentMode={attachmentMode} mentionOptions={mentionOptions} onPreviewMention={setPreviewMention} onPrefetchMention={handlePrefetchMention} />
      <MentionPreviewDialog mention={previewMention} onClose={() => setPreviewMention(null)} onOpenDocument={onOpenDiffFile} />
      <Dialog open={searchPromptOpen} onClose={() => setSearchPromptOpen(false)} title={promptTitle} maxWidth={420} footer={<><Button variant="ghost" onClick={() => setSearchPromptOpen(false)}>取消</Button><Button variant="primary" onClick={() => { setSearchPromptOpen(false); openSettings('search', { provider: promptProvider?.id }); }}>前往设置</Button></>}>
        <div style={{ fontSize: 14, color: C.secondary, lineHeight: 1.8 }}>{promptMessage}</div>
      </Dialog>
      <Dialog open={mcpPromptOpen} onClose={() => setMcpPromptOpen(false)} title="需要配置 MCP 服务" maxWidth={420} footer={<><Button variant="ghost" onClick={() => setMcpPromptOpen(false)}>暂不配置</Button><Button variant="primary" onClick={() => { setMcpPromptOpen(false); openSettings('mcp'); }}>前往配置</Button></>}>
        <div style={{ fontSize: 14, color: C.secondary, lineHeight: 1.8 }}>当前没有可用的 MCP 服务。配置并启用至少一个服务后，才能在本次任务中开启 MCP 自动工具。</div>
      </Dialog>
      <DiffDialog
        open={Boolean(detailOperationSet)}
        operationSet={detailOperationSet}
        onClose={() => setDetailOperationSet(null)}
        onApplyAll={onApplyOperationSet}
        onApplyFile={onApplyOperationFile}
        onRollbackFile={onRollbackOperationFile}
        onDiscardFile={onDiscardOperationFile}
        onOpenFile={onOpenDiffFile}
      />
      <AttachmentContentDialog
        open={Boolean(attachmentDetail)}
        attachment={attachmentDetail?.attachment || null}
        message={attachmentDetail?.message || null}
        onClose={() => setAttachmentDetail(null)}
      />
    </div>
  );
}
