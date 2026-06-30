import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/Input';
import { Toggle } from '../ui/Toggle';
import { Dialog } from '../ui/Dialog';
import { Icons } from '../ui/Icons';
import { Tooltip } from '../ui/Tooltip';
import { SourceCard } from '../ui/SourceCard';
import { useToast } from '../ui/Toast';
import { StreamingText } from '../ui/StreamingText';
import { LlmConfigCardsSection } from '../Settings/LlmConfigCardsSection';
import { findEmbeddingModelMeta, inferEmbeddingProvider } from '../../lib/embeddingForm';
import { navigateWithFallback } from '../../utils/navigation';

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
    description: 'Agent 完成后自动应用所有修改，可在对话记录中查看详情和回滚。',
    icon: 'zap',
  },
  {
    value: 'manual_confirm',
    label: '手动',
    description: 'Agent 完成后需逐文件手动确认，未确认内容在下次任务时自动废弃。',
    icon: 'hand',
  },
];
const CHAT_STICKY_BOTTOM_THRESHOLD = 56;
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function isNearScrollBottom(container) {
  if (!container) return true;
  return container.scrollHeight - container.scrollTop - container.clientHeight <= CHAT_STICKY_BOTTOM_THRESHOLD;
}

function scrollContainerToBottom(container, behavior = 'auto') {
  if (!container) return;
  container.scrollTo({ top: container.scrollHeight, behavior });
}

const PARSED_ATTACHMENT_ACCEPT = '.pdf,.docx,.md,.markdown,.txt,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PARSED_ATTACHMENT_EXTENSIONS = new Set(['.pdf', '.docx', '.md', '.markdown', '.txt']);
const LONG_PASTE_ATTACHMENT_THRESHOLD = 100;
const MAX_PARSED_ATTACHMENTS = 5;

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
  return normalizeApiProtocol(config.api_protocol) === 'anthropic' ? 'Anthropic' : (config.provider || 'OpenAI');
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

function toDisplayAttachment(file) {
  const { fileObject: _fileObject, ...rest } = file || {};
  return rest;
}

function FileChip({ file, onRemove, readOnly }) {
  const type = fileType(file);
  return (
    <div style={{
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      maxWidth: 220,
      padding: '8px 12px',
      borderRadius: 14,
      background: '#fff',
      boxShadow: '0 1px 6px rgba(45,45,45,0.08), inset 0 0 0 1px rgba(229,227,216,0.9)',
      color: C.text,
    }}>
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
      <span style={{ minWidth: 0, display: 'grid', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name || '未命名附件'}</span>
        <span style={{ fontSize: 11, color: C.tertiary }}>{file.sizeLabel || fileSize(file.size)}</span>
      </span>
      {!readOnly ? (
        <button
          type="button"
          aria-label="移除附件"
          onClick={() => onRemove?.(file.id)}
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
          })}
        >
          <Icons.x size={11} />
        </button>
      ) : null}
    </div>
  );
}

function ToolStatusIcon({ status, size = 14 }) {
  if (status === 'failed') return <Icons.warn size={size} style={{ color: C.accent }} />;
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

function ToolChain({ steps, loading }) {
  const visibleSteps = useMemo(() => (
    steps && steps.length ? steps : (loading ? [
      { id: 'prepare', label: '准备上下文', status: 'running', detail: '正在整理当前请求、模型和工作区上下文。' },
    ] : [])
  ), [steps, loading]);
  const [expanded, setExpanded] = useState({});
  const stepKey = visibleSteps.map((step, index) => step.id || step.label || index).join('|');

  useEffect(() => {
    setExpanded((prev) => {
      const next = {};
      visibleSteps.forEach((step, index) => {
        const id = String(step.id || step.label || index);
        if (prev[id] || step.open) next[id] = true;
      });
      return next;
    });
  }, [stepKey, visibleSteps]);

  if (!visibleSteps.length) return null;
  const hasRunning = visibleSteps.some((step) => step.status === 'running');
  const hasFailed = visibleSteps.some((step) => step.status === 'error' || step.status === 'stopped');
  const chainStatus = hasFailed ? 'failed' : hasRunning ? 'running' : 'done';

  return (
    <div style={{ width: '100%', margin: '16px 0', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, padding: '0 4px' }}>
        <ToolStatusIcon status={chainStatus} size={14} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid ' + C.border, paddingTop: 8 }}>
        {visibleSteps.map((step, index) => {
          const stepId = String(step.id || step.label || index);
          const status = step.status || 'done';
          const running = status === 'running';
          const failed = status === 'error' || status === 'stopped';
          const open = Boolean(expanded[stepId]);
          const rowStatus = failed ? 'failed' : running ? 'running' : 'done';
          return (
            <div key={stepId} style={{ display: 'flex', flexDirection: 'column' }}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setExpanded((prev) => ({ ...prev, [stepId]: !prev[stepId] }))}
                className="notus-agent-tool-row"
                style={{
                minHeight: 32,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '6px 4px',
                borderRadius: 8,
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                width: '100%',
                textAlign: 'left',
                color: failed ? C.accent : C.tertiary,
                fontSize: 13,
                fontFamily: 'inherit',
                transitionProperty: 'transform, background-color, color',
                transitionDuration: '160ms',
                transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
                touchAction: 'manipulation',
              }}
              >
                <span style={{ width: 20, display: 'inline-flex', justifyContent: 'center', color: failed ? C.accent : running ? C.accent : '#BDBBB3' }}>
                  <ToolStatusIcon status={rowStatus} size={13} />
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.label}</span>
                <Icons.chevronRight size={14} className={open ? 'notus-agent-tool-chevron is-open' : 'notus-agent-tool-chevron'} style={{ color: '#BDBBB3' }} />
              </button>
              {open ? (
                <div style={{ marginLeft: 25, padding: '8px 0 10px 16px', borderLeft: '1px solid ' + C.border, display: 'grid', gap: 12, marginBottom: 2, marginTop: 1 }}>
                  {step.detail ? <div style={{ fontSize: 13.5, lineHeight: 1.75, color: C.secondary, whiteSpace: 'pre-wrap' }}>{step.detail}{running ? <span style={{ display: 'inline-block', width: 6, height: 14, background: 'rgba(217,119,87,0.6)', marginLeft: 5, verticalAlign: 'text-bottom', animation: 'notus-agent-pulse 1s ease-in-out infinite' }} /> : null}</div> : null}
                  {step.tool ? (
                    <div style={{ background: C.soft, borderRadius: 8, padding: 12, color: C.secondary, fontSize: 12.5 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: C.text, marginBottom: 8 }}>
                        <Icons.code size={12} style={{ color: C.tertiary }} /> {step.tool}
                      </div>
                      {step.input ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{step.input}</pre> : null}
                      {step.result ? (
                        <pre style={{ margin: '8px 0 0', paddingTop: 8, borderTop: '1px solid ' + C.border, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{step.result}</pre>
                      ) : running ? (
                        <div style={{ display: 'flex', gap: 4, marginTop: 8, paddingTop: 8, borderTop: '1px solid ' + C.border }}>
                          <span style={{ width: 6, height: 6, borderRadius: 999, background: '#C2C0B6', animation: 'notus-agent-bounce 1s infinite' }} />
                          <span style={{ width: 6, height: 6, borderRadius: 999, background: '#C2C0B6', animation: 'notus-agent-bounce 1s infinite', animationDelay: '0.15s' }} />
                          <span style={{ width: 6, height: 6, borderRadius: 999, background: '#C2C0B6', animation: 'notus-agent-bounce 1s infinite', animationDelay: '0.3s' }} />
                        </div>
                      ) : failed ? (
                        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid ' + C.border, color: C.accent }}>进程被手动中止或执行失败</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function operationItems(operationSet) {
  if (!operationSet) return [];
  if (Array.isArray(operationSet.patches) && operationSet.patches.length > 0) {
    return operationSet.patches.map((patch, index) => ({
      id: patch.patch_id || patch.id || 'patch-' + index,
      patchIndex: index,
      type: 'str_replace',
      file_path: patch.file_path,
      change_type: patch.change_type || patch.type || '',
      old: patch.old,
      new: patch.new,
      status: patch.status || 'pending',
      handled_at: patch.handled_at || null,
      error: patch.error || '',
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
  if (normalized === 'failed') return { label: '处理失败', color: C.accentDark, bg: 'rgba(217,119,87,0.12)' };
  return { label: '待确认', color: C.accent, bg: 'rgba(251,228,210,0.42)' };
}

function isPatchPending(item) {
  const status = String(item?.status || 'pending');
  return status === 'pending' || status === 'failed';
}

function buildDiffLines(operation = {}) {
  return [
    ...(operation.old ? String(operation.old).split('\n').map((line) => ({ type: 'remove', content: line })) : []),
    ...(operation.new ? String(operation.new).split('\n').map((line) => ({ type: 'add', content: line })) : []),
    ...(operation.content ? String(operation.content).split('\n').map((line) => ({ type: 'add', content: line })) : []),
  ];
}

function operationSetSummary(operationSet) {
  const operations = operationItems(operationSet);
  const fileCount = new Set(operations.map((item) => item.file_path || item.path).filter(Boolean)).size || operations.length;
  const pendingCount = operations.filter(isPatchPending).length;
  const autoAppliedCount = operations.filter((item) => String(item.status || '') === 'auto_applied').length;
  const appliedCount = operations.filter((item) => ['applied', 'auto_applied'].includes(String(item.status || ''))).length;
  const rolledBackCount = operations.filter((item) => String(item.status || '') === 'rolled_back').length;
  const discardedCount = operations.filter((item) => String(item.status || '') === 'discarded').length;
  const failedCount = operations.filter((item) => String(item.status || '') === 'failed').length;
  let detail = '本次任务的文件修改预览已生成';
  if (pendingCount > 0) detail = `${pendingCount} 个文件待确认`;
  else if (autoAppliedCount === operations.length && operations.length > 0) detail = '已自动应用，可查看详情或逐文件回滚';
  else if (appliedCount > 0 || rolledBackCount > 0 || discardedCount > 0) detail = `已应用 ${appliedCount} 个，已回滚 ${rolledBackCount} 个，已废弃 ${discardedCount} 个`;
  if (failedCount > 0) detail = `${detail}，${failedCount} 个处理失败`;
  return { operations, fileCount, pendingCount, detail };
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
          <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{summary.fileCount} 个文件发生变更</div>
          <div style={{ fontSize: 11, color: C.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary.detail}</div>
        </div>
      </div>
      <button type="button" className="notus-agent-pressable" onClick={() => onOpenDetail?.(operationSet)} style={transitionButton({ minWidth: 0, height: 32, padding: '0 16px', borderRadius: 8, background: C.accent, color: '#fff', boxShadow: '0 1px 6px rgba(217, 119, 87, 0.24)', fontSize: 12, fontWeight: 800 })}>查看详情</button>
    </div>
  );
}

function DiffDialog({ operationSet, open, onClose, onApplyAll, onApplyFile, onRollbackFile }) {
  const operations = operationItems(operationSet);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busyKey, setBusyKey] = useState('');
  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(operations.length - 1, 0)));
  }, [operationSet?.id, operations.length]);
  if (!open) return null;
  const activeOperation = operations[Math.min(selectedIndex, Math.max(operations.length - 1, 0))] || {};
  const activePath = activeOperation.file_path || activeOperation.path || '全文';
  const diffLines = buildDiffLines(activeOperation);
  const activeStatus = patchStatusMeta(activeOperation.status);
  const pendingCount = operations.filter(isPatchPending).length;
  const canApply = isPatchPending(activeOperation) && typeof onApplyFile === 'function';
  const canApplyAll = pendingCount > 0 && typeof onApplyAll === 'function';
  const canRollback = !['rolled_back', 'discarded'].includes(String(activeOperation.status || 'pending')) && typeof onRollbackFile === 'function';
  const moveToNextPending = () => {
    const next = operations.findIndex((item, index) => index !== selectedIndex && isPatchPending(item));
    if (next >= 0) setSelectedIndex(next);
  };
  const runFileAction = async (kind) => {
    const key = `${kind}-${activeOperation.patchIndex}`;
    setBusyKey(key);
    try {
      if (kind === 'apply') await onApplyFile?.(operationSet, activeOperation.patchIndex);
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

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(45,45,45,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div role="dialog" aria-modal="true" aria-label="修改详情" style={{ width: 'min(980px, calc(100vw - 48px))', height: 'min(760px, calc(100vh - 48px))', background: '#fff', borderRadius: 18, overflow: 'hidden', boxShadow: '0 24px 80px rgba(45,45,45,0.22)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ minHeight: 58, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 18px', borderBottom: '1px solid ' + C.border, background: C.page }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 900, color: C.text }}>修改详情</div>
            <div style={{ marginTop: 3, fontSize: 12, color: C.tertiary }}>{pendingCount > 0 ? `${pendingCount} 个文件待确认` : '本次任务的文件已全部处理'}</div>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} style={transitionButton({ width: 34, height: 34, borderRadius: 10, background: '#fff', color: C.secondary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.95)' })}><Icons.x size={16} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', minHeight: 0, flex: 1, overflow: 'hidden' }}>
          <div style={{ borderRight: '1px solid ' + C.border, background: C.page, padding: 8, overflowY: 'auto' }}>
            {operations.map((operation, index) => {
              const pathText = operation.file_path || operation.path || '全文';
              const active = index === selectedIndex;
              const statusMeta = patchStatusMeta(operation.status);
              return (
                <button key={operation.id || index} type="button" onClick={() => setSelectedIndex(index)} style={transitionButton({ width: '100%', textAlign: 'left', display: 'grid', gap: 4, padding: '9px 10px', borderRadius: 10, background: active ? '#fff' : 'transparent', color: active ? C.text : C.secondary, boxShadow: active ? 'inset 0 0 0 1px rgba(229,227,216,0.92)' : 'none' })}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ minWidth: 0, fontSize: 12, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(pathText).split('/').pop()}</span>
                    <span style={{ flexShrink: 0, width: 7, height: 7, borderRadius: 999, background: statusMeta.color }} />
                  </span>
                  <span style={{ fontSize: 10.5, color: C.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pathText}</span>
                </button>
              );
            })}
          </div>
          <div style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#FAFAFA', overflow: 'hidden' }}>
            <div style={{ minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 12px', borderBottom: '1px solid ' + C.border, background: '#fff' }}>
              <span style={{ minWidth: 0, fontSize: 12, color: C.secondary, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activePath}</span>
              <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: activeStatus.color, background: activeStatus.bg, borderRadius: 999, padding: '4px 8px' }}>{activeStatus.label}</span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 0', overscrollBehavior: 'contain' }}>
              <div style={{ minWidth: 'max-content', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, lineHeight: 1.65 }}>
                {diffLines.length === 0 ? <div style={{ padding: '0 14px', color: C.tertiary }}>没有可展示的 diff 内容。</div> : diffLines.map((line, index) => {
                  const remove = line.type === 'remove';
                  const add = line.type === 'add';
                  return (
                    <div key={index} style={{ display: 'flex', minWidth: '100%', padding: '0 14px', background: add ? 'rgba(187,247,208,0.45)' : remove ? 'rgba(254,202,202,0.45)' : 'transparent', color: add ? '#166534' : remove ? '#991B1B' : C.secondary, textDecoration: remove ? 'line-through' : 'none' }}>
                      <span style={{ width: 20, flex: '0 0 auto', color: '#BDBBB3', textAlign: 'right', paddingRight: 8, userSelect: 'none' }}>{add ? '+' : remove ? '-' : ' '}</span>
                      <span style={{ flex: '0 0 auto', whiteSpace: 'pre' }}>{line.content}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={{ minHeight: 56, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 12px', borderTop: '1px solid ' + C.border, background: '#fff' }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.6, color: C.tertiary }}>仅当前对话可应用或回滚修改；新建/切换对话、预览已处理、会话权限过期或文件内容变化后，应用与回滚会失效。</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
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
}

function MessageList({ messages, streamText, loading, activeSteps, onOpenOperationSet, onCitationClick, citationSelection }) {
  if (messages.length === 0 && !loading) {
    return (
      <div style={{ minHeight: '42vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: C.tertiary }}>
        <div style={{ width: 58, height: 58, borderRadius: 20, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.accent, boxShadow: '0 8px 24px rgba(45,45,45,0.06), inset 0 0 0 1px rgba(229,227,216,0.95)', marginBottom: 22 }}>
          <Icons.sparkles size={28} stroke={1.4} />
        </div>
        <h1 style={{ margin: '0 0 8px', fontFamily: 'Georgia, Songti SC, STSong, serif', fontSize: 26, lineHeight: 1.1, color: C.text }}>有什么我可以帮您的？</h1>
        <p style={{ margin: 0, fontSize: 15 }}>输入问题、创作指令，或附上文件让 Notus 帮你处理。</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 22 }}>
      {messages.map((message) => {
        if (message.role === 'user') {
          return (
            <div key={message.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
              {Array.isArray(message.attachments) && message.attachments.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>
                  {message.attachments.map((file) => <FileChip key={file.id || file.name} file={file} readOnly />)}
                </div>
              ) : null}
              <div style={{ maxWidth: '80%', padding: '13px 18px', borderRadius: '20px 20px 6px 20px', background: C.muted, color: C.text, fontSize: 15, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{message.content}</div>
            </div>
          );
        }

        return (
          <div key={message.id} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: C.accent, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Georgia, Songti SC, STSong, serif', fontWeight: 800, boxShadow: '0 4px 12px rgba(217,119,87,0.22)', flexShrink: 0, marginTop: 3 }}>N</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: C.text, margin: '5px 0 2px' }}>Notus Agent</div>
              <ToolChain steps={message.toolSteps || []} />
              {message.content ? <StreamingText className="notus-agent-markdown" text={message.content} streaming={false} style={{ fontSize: 15, lineHeight: 1.85, color: C.text }} /> : null}
              {Array.isArray(message.citations) && message.citations.length > 0 ? (
                <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
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
            </div>
          </div>
        );
      })}
      {loading ? (
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: C.accent, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Georgia, Songti SC, STSong, serif', fontWeight: 800, flexShrink: 0, marginTop: 3 }}>N</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: C.text, margin: '5px 0 2px' }}>Notus Agent</div>
            <ToolChain steps={activeSteps} loading />
            {streamText ? <StreamingText className="notus-agent-markdown" text={streamText} streaming style={{ fontSize: 15, lineHeight: 1.85, color: C.text }} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AgentConfirmModeSelect({ value, onChange, disabled }) {
  const current = getAgentConfirmModeOption(value);

  return (
    <div
      role="radiogroup"
      aria-label="Agent 确认方式"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 10,
        background: C.soft,
        boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.86)',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {AGENT_CONFIRM_MODE_OPTIONS.map((option) => {
        const active = option.value === current.value;
        const OptionIcon = option.icon === 'hand' ? Icons.hand : Icons.zap;
        return (
          <Tooltip key={option.value} content={option.description} placement="top" disabled={disabled}>
            <button
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`Agent 确认方式：${option.label}`}
              disabled={disabled}
              onClick={() => onChange?.(option.value)}
              className="notus-agent-pressable"
              style={transitionButton({
                minWidth: 62,
                height: 26,
                padding: '0 8px',
                borderRadius: 8,
                background: active ? '#fff' : 'transparent',
                color: active ? C.accent : C.tertiary,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                fontSize: 12,
                fontWeight: 800,
                boxShadow: active ? '0 1px 3px rgba(45,45,45,0.08), inset 0 0 0 1px rgba(217,119,87,0.14)' : 'none',
                cursor: disabled ? 'not-allowed' : 'pointer',
              })}
            >
              <OptionIcon size={13} stroke={option.icon === 'zap' ? 1.8 : 1.55} />
              <span>{option.label}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

function AgentInput({ loading, disabled, llmConfigs, selectedConfigId, onConfigChange, onSend, onStop, searchConfig, onRequireSearchConfig, placeholder, agentConfirmMode, onAgentConfirmModeChange, attachmentMode = 'metadata', mentionOptions = [] }) {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selectedSearchProvider, setSelectedSearchProvider] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);
  const mentionListRef = useRef(null);
  const mentionOptionRefs = useRef([]);
  const selectedConfig = useMemo(() => llmConfigs.find((item) => String(item.id) === String(selectedConfigId)) || llmConfigs[0] || null, [llmConfigs, selectedConfigId]);
  const toast = useToast();
  const parsedAttachmentMode = attachmentMode === 'parsed';
  const busy = loading || uploading;
  const providers = searchConfig.providers || SEARCH_PROVIDER_FALLBACKS;
  const preferredSearchProvider = providers.find((provider) => provider.id === searchConfig.selected_provider)?.id || providers[0]?.id || 'firecrawl';
  const webSearchSelected = Boolean(selectedSearchProvider);
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

  useEffect(() => {
    if (!searchConfig.enabled && selectedSearchProvider) {
      setSelectedSearchProvider('');
      setSearchOpen(false);
      return;
    }
    if (selectedSearchProvider && !providers.some((provider) => provider.id === selectedSearchProvider)) {
      setSelectedSearchProvider(preferredSearchProvider);
    }
  }, [preferredSearchProvider, providers, searchConfig.enabled, selectedSearchProvider]);

  const activeMention = useMemo(() => {
    if (!mentionOptions.length || disabled) return null;
    const beforeCursor = value.slice(0, cursorIndex);
    const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) return null;
    const mentionStart = beforeCursor.lastIndexOf('@');
    const mentionKey = `${mentionStart}:${beforeCursor.slice(mentionStart, cursorIndex)}`;
    if (dismissedMentionKey === mentionKey) return null;
    const query = String(match[1] || '').trim().toLowerCase();
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
      .slice(0, 8);
    return {
      start: mentionStart,
      end: cursorIndex,
      key: mentionKey,
      options,
    };
  }, [cursorIndex, disabled, dismissedMentionKey, mentionOptions, value]);

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

  const applyMention = (option) => {
    if (!activeMention) return;
    const token = option?.token || option?.value;
    if (!token) return;
    const nextValue = `${value.slice(0, activeMention.start)}${token} ${value.slice(activeMention.end)}`;
    const nextCursor = activeMention.start + token.length + 1;
    setValue(nextValue);
    setCursorIndex(nextCursor);
    setDismissedMentionKey('');
    setActiveMentionIndex(0);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const addFiles = (fileList, options = {}) => {
    const rejected = [];
    const incoming = Array.from(fileList || []);
    const supported = incoming.filter((file) => {
      if (parsedAttachmentMode && !isSupportedParsedFile(file)) {
        rejected.push(file.name || '未命名附件');
        return false;
      }
      return true;
    });
    const remaining = parsedAttachmentMode ? Math.max(0, MAX_PARSED_ATTACHMENTS - files.length) : supported.length;
    const acceptedCandidates = supported.slice(0, remaining);
    const skippedCount = Math.max(0, supported.length - acceptedCandidates.length);
    const next = acceptedCandidates.map((file) => {
      return {
        id: 'file-' + Date.now() + '-' + Math.random().toString(16).slice(2),
        name: file.name,
        size: file.size,
        sizeLabel: fileSize(file.size),
        type: file.type,
        source_kind: options.sourceKind || 'file',
        fileObject: file,
      };
    });
    if (rejected.length > 0) {
      toast(`暂不支持 ${rejected.slice(0, 3).join('、')}，请上传 PDF、DOCX、MD 或 TXT。`, 'warning');
    }
    if (skippedCount > 0) {
      toast(`单次最多上传 ${MAX_PARSED_ATTACHMENTS} 个附件，已忽略多出的 ${skippedCount} 个。`, 'warning');
    }
    if (next.length > 0) setFiles((prev) => [...prev, ...next]);
  };

  const uploadParsedAttachments = async (items = []) => {
    const uploadItems = items.filter((item) => item.fileObject);
    if (!parsedAttachmentMode || uploadItems.length === 0) return items.map(toDisplayAttachment);
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

  const submit = async (forcedText) => {
    const fallbackText = parsedAttachmentMode && files.length > 0 ? '请读取并分析已上传的文件。' : '';
    const text = String(forcedText || value || fallbackText || '').trim();
    if ((!text && files.length === 0) || busy || disabled || !selectedConfig) return;
    if (webSearchSelected && !searchConfig.enabled) {
      onRequireSearchConfig?.({ reason: 'disabled', selectProvider: selectedSearchProvider || preferredSearchProvider });
      return;
    }
    if (webSearchSelected && !isSearchProviderReady(selectedSearchProvider)) {
      onRequireSearchConfig?.({ reason: 'missing_api_key', selectProvider: selectedSearchProvider });
      return;
    }
    setUploading(parsedAttachmentMode && files.some((item) => item.fileObject));
    try {
      const attachments = parsedAttachmentMode
        ? await uploadParsedAttachments(files)
        : files.map(toDisplayAttachment);
      await onSend?.(text, {
        llmConfigId: selectedConfig.id,
        attachments,
        webSearchEnabled: webSearchSelected,
        searchProvider: selectedSearchProvider || null,
        searchProviders: searchProviderList,
      });
      setValue('');
      setCursorIndex(0);
      setDismissedMentionKey('');
      setFiles([]);
      setSearchOpen(false);
      setModelOpen(false);
    } catch (error) {
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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const canSend = !busy && !disabled && Boolean(selectedConfig) && (Boolean(value.trim()) || files.length > 0);
  const toggleWebSearch = () => {
    if (busy || disabled) return;
    if (!searchConfig.enabled) {
      onRequireSearchConfig?.({ reason: 'disabled', selectProvider: preferredSearchProvider });
      return;
    }
    if (webSearchSelected) {
      setSelectedSearchProvider('');
      setSearchOpen(false);
      return;
    }
    if (!isSearchProviderReady(preferredSearchProvider)) {
      onRequireSearchConfig?.({ reason: 'missing_api_key', selectProvider: preferredSearchProvider });
      return;
    }
    setModelOpen(false);
    setSelectedSearchProvider(preferredSearchProvider);
    setSearchOpen(true);
  };
  const selectSearchProvider = (providerId) => {
    if (!isSearchProviderReady(providerId)) {
      onRequireSearchConfig?.({ reason: 'missing_api_key', selectProvider: providerId });
      setSearchOpen(false);
      return;
    }
    setSelectedSearchProvider(providerId);
    setSearchOpen(false);
  };

  const handlePaste = (event) => {
    if (!parsedAttachmentMode || busy || disabled) return;
    const clipboard = event.clipboardData;
    const pastedFiles = Array.from(clipboard?.files || []);
    if (pastedFiles.length > 0) {
      event.preventDefault();
      addFiles(pastedFiles, { sourceKind: 'clipboard_file' });
      return;
    }
    const text = clipboard?.getData('text/plain') || '';
    if (text.length > LONG_PASTE_ATTACHMENT_THRESHOLD) {
      event.preventDefault();
      const suffix = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      const file = new File([text], `pasted-text-${suffix}.txt`, { type: 'text/plain' });
      addFiles([file], { sourceKind: 'pasted_text' });
      toast('粘贴文本较长，已转为 TXT 附件。', 'info');
    }
  };

  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '40px 8px 24px', background: 'linear-gradient(0deg, ' + C.page + ' 0%, ' + C.page + ' 68%, rgba(253,252,251,0) 100%)', zIndex: 6 }}>
      <div style={{ maxWidth: 768, margin: '0 auto', borderRadius: 22, background: '#fff', boxShadow: focused ? '0 4px 24px rgba(217,119,87,0.08), inset 0 0 0 1px rgba(217,119,87,0.30)' : '0 2px 12px rgba(0,0,0,0.03), inset 0 0 0 1px rgba(229,227,216,0.95)', transitionProperty: 'box-shadow', transitionDuration: '180ms', transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)', overflow: 'visible' }}>
        <input ref={fileInputRef} type="file" multiple accept={parsedAttachmentMode ? PARSED_ATTACHMENT_ACCEPT : undefined} style={{ display: 'none' }} onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />
        {files.length > 0 ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '14px 16px 4px', maxHeight: 150, overflowY: 'auto' }}>{files.map((file) => <FileChip key={file.id} file={file} onRemove={(id) => setFiles((prev) => prev.filter((item) => item.id !== id))} />)}</div> : null}
        <div style={{ position: 'relative', padding: '10px 16px 8px' }}>
          <textarea
            ref={textareaRef}
            value={value}
            rows={1}
            placeholder={placeholder || '在此输入以唤起 Agent Loop...'}
            disabled={busy || disabled}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onPaste={handlePaste}
            onChange={(event) => {
              setValue(event.target.value);
              setCursorIndex(event.target.selectionStart || 0);
              setDismissedMentionKey('');
            }}
            onClick={(event) => setCursorIndex(event.currentTarget.selectionStart || 0)}
            onKeyUp={(event) => setCursorIndex(event.currentTarget.selectionStart || 0)}
            onSelect={(event) => setCursorIndex(event.currentTarget.selectionStart || 0)}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={(event) => {
              setIsComposing(false);
              setCursorIndex(event.currentTarget.selectionStart || 0);
            }}
            onKeyDown={handleKeyDown}
            style={{ width: '100%', minHeight: 24, maxHeight: '40vh', resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: disabled ? C.tertiary : C.text, fontSize: 15, lineHeight: 1.65, padding: 0, fontFamily: 'inherit', overflowY: 'auto' }}
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
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 800, color: C.accent }}>{option.token}</span>
                        <span style={{ minWidth: 0, fontSize: 12, color: C.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
                      </span>
                      <span style={{ minWidth: 0, fontSize: 12, color: C.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.preview}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ padding: '8px 10px', fontSize: 12, color: C.tertiary }}>当前文档中没有匹配的块</div>
              )}
            </div>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px 12px', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button type="button" aria-label="添加附件" onClick={() => fileInputRef.current?.click()} disabled={busy || disabled} style={transitionButton({ width: 30, height: 30, borderRadius: 10, background: 'transparent', color: C.tertiary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: busy || disabled ? 0.5 : 1 })}><Icons.paperclip size={18} /></button>
            {showAgentConfirmMode ? <AgentConfirmModeSelect value={agentConfirmMode} onChange={onAgentConfirmModeChange} disabled={busy || disabled} /> : null}
            <div style={{ position: 'relative' }}>
              <button type="button" onClick={toggleWebSearch} disabled={busy || disabled} style={transitionButton({ height: 28, padding: '0 10px', borderRadius: 8, background: webSearchSelected ? 'rgba(251,228,210,0.40)' : 'transparent', color: webSearchSelected ? C.accent : C.tertiary, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: webSearchSelected ? 800 : 600, opacity: busy || disabled ? 0.5 : 1 })}><Icons.globe size={15} />联网</button>
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
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ position: 'relative' }}>
              <button type="button" onClick={() => { setSearchOpen(false); setModelOpen((prev) => !prev); }} disabled={busy || disabled || llmConfigs.length === 0} style={transitionButton({ maxWidth: 150, height: 28, padding: '0 8px', borderRadius: 8, background: 'transparent', color: C.secondary, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700, opacity: llmConfigs.length === 0 || disabled ? 0.55 : 1 })}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelLabel(selectedConfig)}</span><Icons.chevronDown size={13} /></button>
              {modelOpen ? (
                <>
                  <button type="button" aria-label="关闭模型下拉" onClick={() => setModelOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 19, border: 0, background: 'transparent', padding: 0 }} />
                  <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', right: 0, width: 260, maxHeight: '40vh', overflowY: 'auto', padding: '8px 0', borderRadius: 14, background: '#fff', boxShadow: '0 -10px 40px -10px rgba(0,0,0,0.10), inset 0 0 0 1px rgba(229,227,216,0.95)', zIndex: 20 }}>
                    {groupedConfigs.length === 0 ? <div style={{ padding: 12, fontSize: 13, color: C.tertiary }}>暂无模型配置</div> : groupedConfigs.map((group, index) => (
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
            {loading ? <button type="button" aria-label="停止生成" onClick={() => onStop?.()} style={transitionButton({ width: 34, height: 34, borderRadius: 10, background: C.accent, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 18px rgba(217,119,87,0.24)' })}><Icons.square size={14} /></button> : <button type="button" aria-label="发送" disabled={!canSend} onClick={() => submit()} style={transitionButton({ width: 34, height: 34, borderRadius: 10, background: canSend ? C.accent : C.muted, color: canSend ? '#fff' : '#BDBBB3', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: canSend ? 'pointer' : 'not-allowed', boxShadow: canSend ? '0 6px 18px rgba(217,119,87,0.22)' : 'none' })}>{uploading ? <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: 999, display: 'inline-block', boxSizing: 'border-box', border: '2px solid rgba(255,255,255,0.45)', borderTopColor: '#fff', animation: 'spin 0.82s linear infinite' }} /> : <Icons.arrowUp size={18} />}</button>}
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

export function AgentWorkspace({ messages, streamText, loading, error, activeSteps, llmConfigs, selectedConfigId, onConfigChange, onSend, onStop, onApplyOperationSet, onApplyOperationFile, onRollbackOperationFile, onCitationClick, citationSelection, disabled, placeholder, agentConfirmMode, onAgentConfirmModeChange, attachmentMode = 'metadata', mentionOptions = [] }) {
  const router = useRouter();
  const [searchConfig, setSearchConfig] = useState({ enabled: false, selected_provider: 'firecrawl', modes: {}, counts: {}, api_key_set: {}, providers: SEARCH_PROVIDER_FALLBACKS });
  const [searchPromptOpen, setSearchPromptOpen] = useState(false);
  const [searchViewProvider, setSearchViewProvider] = useState('');
  const [searchPromptReason, setSearchPromptReason] = useState('disabled');
  const [detailOperationSet, setDetailOperationSet] = useState(null);
  const scrollContainerRef = useRef(null);
  const shouldStickToBottomRef = useRef(true);
  const visibleMessages = Array.isArray(messages) ? messages : [];
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

  const handleChatScroll = useCallback((event) => {
    shouldStickToBottomRef.current = isNearScrollBottom(event.currentTarget);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/search-providers').then((response) => response.json()).then((payload) => {
      if (!cancelled) setSearchConfig((prev) => ({ ...prev, ...payload }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useIsomorphicLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (!shouldStickToBottomRef.current && !isNearScrollBottom(container)) return;
    scrollContainerToBottom(container);
    shouldStickToBottomRef.current = true;
  }, [messageScrollKey, String(streamText || '').length, Boolean(loading), activeStepsScrollKey, error]);

  useEffect(() => {
    if (!detailOperationSet?.id) return;
    const next = (Array.isArray(messages) ? messages : [])
      .map((message) => message.operationSet)
      .find((operationSet) => Number(operationSet?.id || 0) === Number(detailOperationSet.id));
    if (next && next !== detailOperationSet) setDetailOperationSet(next);
  }, [detailOperationSet, messages]);

  const requireSearchConfig = ({ selectProvider = '', quiet = false, reason = 'disabled' } = {}) => {
    if (selectProvider) {
      setSearchViewProvider(selectProvider);
      setSearchConfig((prev) => ({ ...prev, selected_provider: selectProvider }));
    }
    setSearchPromptReason(reason);
    if (!quiet) setSearchPromptOpen(true);
  };
  const promptProvider = (searchConfig.providers || SEARCH_PROVIDER_FALLBACKS).find((provider) => provider.id === searchViewProvider)
    || (searchConfig.providers || SEARCH_PROVIDER_FALLBACKS).find((provider) => provider.id === searchConfig.selected_provider)
    || SEARCH_PROVIDER_FALLBACKS[0];
  const promptTitle = searchPromptReason === 'missing_api_key' ? '需要配置搜索服务商' : '联网搜索未开启';
  const promptMessage = searchPromptReason === 'missing_api_key'
    ? `${promptProvider?.name || '该搜索服务商'} 需要先配置 API Key。前往设置后会自动切换到对应服务商。`
    : '需要开启联网搜索功能才能使用，请前往设置 → 搜索配置 → 启用联网搜索。';
  const searchSettingsHref = `/settings/search${promptProvider?.id ? `?provider=${encodeURIComponent(promptProvider.id)}` : ''}`;

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 0, background: C.page, color: C.text, overflow: 'hidden', WebkitFontSmoothing: 'antialiased', MozOsxFontSmoothing: 'grayscale' }}>
      <main ref={scrollContainerRef} onScroll={handleChatScroll} style={{ height: '100%', overflowY: 'auto', padding: '32px 16px 190px' }}>
        <div style={{ maxWidth: 768, margin: '0 auto' }}>
          <MessageList messages={visibleMessages} streamText={streamText || ''} loading={Boolean(loading)} activeSteps={visibleActiveSteps} onOpenOperationSet={setDetailOperationSet} onCitationClick={onCitationClick} citationSelection={citationSelection} />
          {error ? <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 14, background: 'rgba(217,119,87,0.08)', color: C.accentDark, fontSize: 13, lineHeight: 1.7 }}>{error}</div> : null}
          <div style={{ height: 12 }} />
        </div>
      </main>
      <AgentInput loading={Boolean(loading)} disabled={Boolean(disabled)} llmConfigs={llmConfigs || []} selectedConfigId={selectedConfigId} onConfigChange={onConfigChange} onSend={onSend} onStop={onStop} searchConfig={searchConfig} onRequireSearchConfig={requireSearchConfig} placeholder={placeholder} agentConfirmMode={agentConfirmMode} onAgentConfirmModeChange={onAgentConfirmModeChange} attachmentMode={attachmentMode} mentionOptions={mentionOptions} />
      <Dialog open={searchPromptOpen} onClose={() => setSearchPromptOpen(false)} title={promptTitle} maxWidth={420} footer={<><Button variant="ghost" onClick={() => setSearchPromptOpen(false)}>取消</Button><Button variant="primary" onClick={() => { setSearchPromptOpen(false); navigateWithFallback(router, searchSettingsHref); }}>前往设置</Button></>}>
        <div style={{ fontSize: 14, color: C.secondary, lineHeight: 1.8 }}>{promptMessage}</div>
      </Dialog>
      <DiffDialog
        open={Boolean(detailOperationSet)}
        operationSet={detailOperationSet}
        onClose={() => setDetailOperationSet(null)}
        onApplyAll={onApplyOperationSet}
        onApplyFile={onApplyOperationFile}
        onRollbackFile={onRollbackOperationFile}
      />
    </div>
  );
}
