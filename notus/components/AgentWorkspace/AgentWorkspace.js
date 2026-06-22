import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/Input';
import { Toggle } from '../ui/Toggle';
import { Dialog, ConfirmDialog } from '../ui/Dialog';
import { Icons } from '../ui/Icons';
import { useToast } from '../ui/Toast';
import { StreamingText } from '../ui/StreamingText';
import { LlmConfigCardsSection } from '../Settings/LlmConfigCardsSection';
import { findEmbeddingModelMeta, inferEmbeddingProvider } from '../../lib/embeddingForm';
import { navigateWithFallback } from '../../utils/navigation';

const SEARCH_PROVIDER_FALLBACKS = [
  { id: 'firecrawl', name: 'Firecrawl', quota_url: 'https://www.firecrawl.dev/', max_limit: 20 },
  { id: 'tavily', name: 'Tavily', quota_url: 'https://app.tavily.com/home', max_limit: 20 },
  { id: 'exa', name: 'Exa', quota_url: 'https://dashboard.exa.ai/api-keys', max_limit: 100 },
  { id: 'zhipu', name: '智谱', quota_url: 'https://bigmodel.cn/usercenter/proj-mgmt/overview', max_limit: 50 },
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
    value: 'auto_apply',
    label: '自动应用',
    description: '发送后直接执行；生成预览后自动写入。',
    icon: 'wand',
  },
  {
    value: 'manual',
    label: '手动确认',
    description: '先显示任务卡；预览也由你手动应用。',
    icon: 'eye',
  },
];

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
  return value === 'manual' ? 'manual' : 'auto_apply';
}

function getAgentConfirmModeOption(value) {
  const normalized = normalizeAgentConfirmMode(value);
  return AGENT_CONFIRM_MODE_OPTIONS.find((item) => item.value === normalized) || AGENT_CONFIRM_MODE_OPTIONS[0];
}

function fileType(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'PDF';
  if (type.includes('word') || /\.(doc|docx)$/.test(name)) return 'W';
  if (/\.(md|markdown)$/.test(name)) return 'MD';
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
      id: patch.id || 'patch-' + index,
      type: 'str_replace',
      file_path: patch.file_path,
      old: patch.old,
      new: patch.new,
    }));
  }
  return Array.isArray(operationSet.operations) ? operationSet.operations : [];
}

function OperationSetCard({ operationSet, onOpenDetail, onCancel }) {
  if (!operationSet) return null;
  const operations = operationItems(operationSet);
  const fileCount = new Set(operations.map((item) => item.file_path || item.path).filter(Boolean)).size;
  const createCount = operations.filter((item) => item.type === 'create' || item.is_new || item.action === 'create').length;
  const modifyCount = Math.max(0, operations.length - createCount);
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
        <div style={{ display: 'grid', gap: 3 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{fileCount || operations.length} 个文件发生变更</div>
          <div style={{ fontSize: 11, color: C.tertiary }}>{createCount ? createCount + ' 个新建，' : ''}{modifyCount ? modifyCount + ' 个修改' : '预览已生成，等待确认'}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
        <button type="button" className="notus-agent-pressable" onClick={() => onCancel?.(operationSet)} style={transitionButton({ minWidth: 0, height: 32, padding: '0 12px', borderRadius: 8, background: '#fff', color: C.secondary, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.95)', fontSize: 12, fontWeight: 600 })}><Icons.undo size={12} style={{ marginRight: 4, verticalAlign: -2 }} />撤销</button>
        <button type="button" className="notus-agent-pressable" onClick={() => onOpenDetail?.(operationSet)} style={transitionButton({ minWidth: 0, height: 32, padding: '0 16px', borderRadius: 8, background: C.accent, color: '#fff', boxShadow: '0 1px 6px rgba(217, 119, 87, 0.24)', fontSize: 12, fontWeight: 600 })}>查看详情</button>
      </div>
    </div>
  );
}

function normalizePathsText(value) {
  return String(value || '')
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function AgentTaskConfirmCard({ task, onConfirm, onCancel }) {
  const [pathsText, setPathsText] = useState('');
  const [limit, setLimit] = useState(5);

  useEffect(() => {
    setPathsText((task?.authorized_paths || ['']).join('\n'));
    setLimit(Number(task?.search_knowledge_limit || 5));
  }, [task]);

  if (!task) return null;

  const confirm = () => {
    onConfirm?.({
      ...task,
      authorized_paths: normalizePathsText(pathsText),
      search_knowledge_limit: Math.max(0, Math.min(20, Number(limit || 0))),
    });
  };

  return (
    <div style={{ margin: '0 0 18px', borderRadius: 18, background: '#fff', padding: 18, boxShadow: '0 10px 30px rgba(45,45,45,0.06), inset 0 0 0 1px rgba(229,227,216,0.82)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{ width: 36, height: 36, borderRadius: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(251,228,210,0.52)', color: C.accent, flexShrink: 0 }}>
          <Icons.wand size={17} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: C.text }}>这是一个需要多步执行的创作任务</div>
          <div style={{ marginTop: 5, fontSize: 13, lineHeight: 1.7, color: C.secondary, whiteSpace: 'pre-wrap' }}>{task.goal}</div>
        </div>
      </div>
      <div style={{ marginTop: 14, display: 'grid', gap: 12 }}>
        <label style={{ display: 'grid', gap: 6, fontSize: 12, color: C.tertiary }}>
          允许写入的路径（每行一个；空值表示知识库根目录）
          <textarea
            rows={3}
            value={pathsText}
            onChange={(event) => setPathsText(event.target.value)}
            style={{ border: '1px solid ' + C.border, borderRadius: 12, background: C.soft, color: C.text, padding: '9px 10px', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
            placeholder="例如：草稿/\n项目计划.md"
          />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 12, alignItems: 'end' }}>
          <div style={{ padding: 12, borderRadius: 13, background: C.soft, color: C.secondary, fontSize: 12, lineHeight: 1.7 }}>
            本次允许 Agent 创建和修改 Markdown 文件；删除文件始终禁止。所有文件改动会先生成预览，确认后才写入。
          </div>
          <label style={{ display: 'grid', gap: 6, fontSize: 12, color: C.tertiary }}>
            检索次数上限
            <input
              type="number"
              min="0"
              max="20"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
              style={{ height: 38, border: '1px solid ' + C.border, borderRadius: 12, background: '#fff', color: C.text, padding: '0 10px' }}
            />
          </label>
        </div>
      </div>
      <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" onClick={onCancel} style={transitionButton({ height: 34, padding: '0 13px', borderRadius: 11, background: C.soft, color: C.secondary, fontSize: 13, fontWeight: 800 })}>取消</button>
        <button type="button" onClick={confirm} style={transitionButton({ height: 34, padding: '0 15px', borderRadius: 11, background: C.accent, color: '#fff', fontSize: 13, fontWeight: 800, boxShadow: '0 6px 18px rgba(217,119,87,0.22)' })}>开始执行</button>
      </div>
    </div>
  );
}

function agentStatusLabel(status) {
  const map = {
    running: '执行中',
    waiting_confirm: '等待确认',
    completed: '已完成',
    failed: '已结束',
    cancelled: '已取消',
    rolled_back: '已回滚',
  };
  return map[status] || status || '未知状态';
}

function AgentSessionCard({ session, onRollback, onExtend }) {
  if (!session?.id) return null;
  const canExtend = session.status === 'waiting_confirm' && session.reason === 'hard_limit_reached';
  return (
    <div style={{ margin: '0 0 18px', borderRadius: 16, background: C.soft, padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.82)', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 32, height: 32, borderRadius: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff', color: C.secondary, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.82)' }}>
          <Icons.brain size={16} />
        </span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>Agentic Loop #{session.id} · {agentStatusLabel(session.status)}</div>
          <div style={{ marginTop: 2, fontSize: 12, color: C.tertiary }}>{session.loop_count ? '已执行 ' + session.loop_count + ' 轮' : '准备执行'}{session.reason ? ' · ' + session.reason : ''}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {canExtend ? <button type="button" onClick={() => onExtend?.(session)} style={transitionButton({ height: 30, padding: '0 11px', borderRadius: 10, background: '#fff', color: C.secondary, fontSize: 12, fontWeight: 800, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.92)' })}>继续 10 轮</button> : null}
        <button type="button" onClick={() => onRollback?.(session)} style={transitionButton({ height: 30, padding: '0 11px', borderRadius: 10, background: '#fff', color: C.secondary, fontSize: 12, fontWeight: 800, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.92)' })}>回滚任务</button>
      </div>
    </div>
  );
}

function MessageList({ messages, streamText, loading, activeSteps, onOpenOperationSet, onCancelOperationSet, onCitationClick }) {
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
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                  {message.citations.slice(0, 6).map((citation, index) => (
                    <button type="button" key={citation.file_id || citation.file || index} onClick={() => onCitationClick?.(citation)} style={transitionButton({ maxWidth: 260, padding: '8px 10px', borderRadius: 12, background: C.soft, color: C.secondary, textAlign: 'left', fontSize: 12, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.78)' })}>
                      <span style={{ fontWeight: 700, color: C.text }}>{citation.file_title || citation.file || '来源'}</span>
                      {citation.preview || citation.quote ? <span> · {String(citation.preview || citation.quote).slice(0, 40)}</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {message.operationSet ? <OperationSetCard operationSet={message.operationSet} onOpenDetail={onOpenOperationSet} onCancel={onCancelOperationSet} /> : null}
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
  const [open, setOpen] = useState(false);
  const current = getAgentConfirmModeOption(value);
  const CurrentIcon = current.icon === 'eye' ? Icons.eye : Icons.wand;
  const close = () => setOpen(false);

  const selectMode = (mode) => {
    onChange?.(mode);
    close();
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        aria-label="Agent 确认方式"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((prev) => !prev)}
        disabled={disabled}
        className="notus-agent-pressable"
        style={transitionButton({
          height: 30,
          padding: '0 10px',
          borderRadius: 10,
          background: current.value === 'auto_apply' ? 'rgba(251,228,210,0.42)' : 'transparent',
          color: current.value === 'auto_apply' ? C.accent : C.secondary,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          fontWeight: 800,
          boxShadow: current.value === 'auto_apply' ? 'inset 0 0 0 1px rgba(217,119,87,0.16)' : 'none',
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        })}
      >
        <CurrentIcon size={15} />
        <span>{current.label}</span>
        <Icons.chevronDown size={12} />
      </button>
      {open ? (
        <>
          <button type="button" aria-label="关闭确认方式下拉" onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 19, border: 0, background: 'transparent', padding: 0 }} />
          <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, width: 248, padding: 8, borderRadius: 16, background: '#fff', boxShadow: '0 -12px 44px -14px rgba(45,45,45,0.16), inset 0 0 0 1px rgba(229,227,216,0.95)', zIndex: 20 }}>
            <div style={{ padding: '6px 8px 8px', color: '#A3A19A', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5 }}>创作执行方式</div>
            {AGENT_CONFIRM_MODE_OPTIONS.map((option) => {
              const active = option.value === current.value;
              const OptionIcon = option.icon === 'eye' ? Icons.eye : Icons.wand;
              return (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => selectMode(option.value)}
                  className="notus-agent-pressable"
                  style={transitionButton({
                    width: '100%',
                    minHeight: 54,
                    padding: '9px 10px',
                    borderRadius: 12,
                    background: active ? 'rgba(251,228,210,0.34)' : 'transparent',
                    color: active ? C.accent : C.secondary,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    textAlign: 'left',
                  })}
                >
                  <span style={{ width: 30, height: 30, borderRadius: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: active ? '#fff' : C.soft, color: active ? C.accent : C.tertiary, boxShadow: active ? 'inset 0 0 0 1px rgba(217,119,87,0.14)' : 'none' }}>
                    <OptionIcon size={15} />
                  </span>
                  <span style={{ display: 'grid', gap: 2, minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: active ? C.accent : C.text }}>{option.label}</span>
                    <span style={{ fontSize: 11, lineHeight: 1.45, color: C.tertiary }}>{option.description}</span>
                  </span>
                  {active ? <Icons.check size={14} style={{ color: C.accent, flexShrink: 0 }} /> : null}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

function AgentInput({ loading, disabled, llmConfigs, selectedConfigId, onConfigChange, onSend, onStop, searchConfig, onRequireSearchConfig, placeholder, agentConfirmMode, onAgentConfirmModeChange }) {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState([]);
  const [focused, setFocused] = useState(false);
  const [selectedSearchProviders, setSelectedSearchProviders] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const fileInputRef = useRef(null);
  const selectedConfig = useMemo(() => llmConfigs.find((item) => String(item.id) === String(selectedConfigId)) || llmConfigs[0] || null, [llmConfigs, selectedConfigId]);
  const providers = searchConfig.providers || SEARCH_PROVIDER_FALLBACKS;
  const providersConfigured = providers.some((provider) => searchConfig.api_key_set?.[provider.id]);
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

  const addFiles = (fileList) => {
    const next = Array.from(fileList || []).map((file) => ({
      id: 'file-' + Date.now() + '-' + Math.random().toString(16).slice(2),
      name: file.name,
      size: file.size,
      sizeLabel: fileSize(file.size),
      type: file.type,
    }));
    if (next.length > 0) setFiles((prev) => [...prev, ...next]);
  };

  const submit = (forcedText) => {
    const text = String(forcedText || value || '').trim();
    if ((!text && files.length === 0) || loading || disabled || !selectedConfig) return;
    if (selectedSearchProviders.length > 0 && !providersConfigured) {
      onRequireSearchConfig?.();
      return;
    }
    onSend?.(text, {
      llmConfigId: selectedConfig.id,
      attachments: files,
      webSearchEnabled: selectedSearchProviders.length > 0,
      searchProvider: selectedSearchProviders[0] || null,
      searchProviders: selectedSearchProviders,
    });
    setValue('');
    setFiles([]);
    setSearchOpen(false);
    setModelOpen(false);
  };

  const canSend = !loading && !disabled && Boolean(selectedConfig) && (Boolean(value.trim()) || files.length > 0);
  const toggleWebSearch = () => {
    if (loading || disabled) return;
    if (!providersConfigured) {
      onRequireSearchConfig?.();
      return;
    }
    if (selectedSearchProviders.length > 0) {
      setSelectedSearchProviders([]);
      setSearchOpen(false);
      return;
    }
    setModelOpen(false);
    setSearchOpen(true);
  };
  const toggleSearchProvider = (providerId) => {
    setSelectedSearchProviders((prev) => (
      prev.includes(providerId)
        ? prev.filter((item) => item !== providerId)
        : [...prev, providerId]
    ));
  };

  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '40px 8px 24px', background: 'linear-gradient(0deg, ' + C.page + ' 0%, ' + C.page + ' 68%, rgba(253,252,251,0) 100%)', zIndex: 6 }}>
      <div style={{ maxWidth: 768, margin: '0 auto', borderRadius: 22, background: '#fff', boxShadow: focused ? '0 4px 24px rgba(217,119,87,0.08), inset 0 0 0 1px rgba(217,119,87,0.30)' : '0 2px 12px rgba(0,0,0,0.03), inset 0 0 0 1px rgba(229,227,216,0.95)', transitionProperty: 'box-shadow', transitionDuration: '180ms', transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)', overflow: 'visible' }}>
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />
        {files.length > 0 ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '14px 16px 4px', maxHeight: 150, overflowY: 'auto' }}>{files.map((file) => <FileChip key={file.id} file={file} onRemove={(id) => setFiles((prev) => prev.filter((item) => item.id !== id))} />)}</div> : null}
        <div style={{ padding: '10px 16px 8px' }}>
          <textarea value={value} rows={1} placeholder={placeholder || '在此输入以唤起 Agent Loop...'} disabled={loading || disabled} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) { event.preventDefault(); submit(); } }} style={{ width: '100%', minHeight: 24, maxHeight: '40vh', resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: disabled ? C.tertiary : C.text, fontSize: 15, lineHeight: 1.65, padding: 0, fontFamily: 'inherit', overflowY: 'auto' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px 12px', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button type="button" aria-label="添加附件" onClick={() => fileInputRef.current?.click()} disabled={loading || disabled} style={transitionButton({ width: 30, height: 30, borderRadius: 10, background: 'transparent', color: C.tertiary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: loading || disabled ? 0.5 : 1 })}><Icons.paperclip size={18} /></button>
            {showAgentConfirmMode ? <AgentConfirmModeSelect value={agentConfirmMode} onChange={onAgentConfirmModeChange} disabled={loading || disabled} /> : null}
            <div style={{ position: 'relative' }}>
              <button type="button" onClick={toggleWebSearch} disabled={loading || disabled} style={transitionButton({ height: 28, padding: '0 10px', borderRadius: 8, background: selectedSearchProviders.length > 0 ? 'rgba(251,228,210,0.40)' : 'transparent', color: selectedSearchProviders.length > 0 ? C.accent : C.tertiary, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: selectedSearchProviders.length > 0 ? 800 : 600, opacity: loading || disabled ? 0.5 : 1 })}><Icons.globe size={15} />联网</button>
              {searchOpen ? (
                <>
                  <button type="button" aria-label="关闭搜索商下拉" onClick={() => setSearchOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 19, border: 0, background: 'transparent', padding: 0 }} />
                  <div style={{ position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, width: 192, padding: '8px 0', borderRadius: 14, background: '#fff', boxShadow: '0 -10px 40px -10px rgba(0,0,0,0.10), inset 0 0 0 1px rgba(229,227,216,0.95)', zIndex: 20 }}>
                    <div style={{ padding: '6px 16px', color: '#A3A19A', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5 }}>搜索引擎</div>
                    {providers.map((provider) => {
                      const checked = selectedSearchProviders.includes(provider.id);
                      return (
                        <button type="button" key={provider.id} onClick={() => toggleSearchProvider(provider.id)} style={transitionButton({ width: '100%', minHeight: 34, padding: '0 16px', background: 'transparent', color: C.secondary, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13, textAlign: 'left' })}>{provider.name}{checked ? <Icons.check size={14} style={{ color: C.accent }} /> : null}</button>
                      );
                    })}
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ position: 'relative' }}>
              <button type="button" onClick={() => { setSearchOpen(false); setModelOpen((prev) => !prev); }} disabled={loading || disabled || llmConfigs.length === 0} style={transitionButton({ maxWidth: 150, height: 28, padding: '0 8px', borderRadius: 8, background: 'transparent', color: C.secondary, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700, opacity: llmConfigs.length === 0 || disabled ? 0.55 : 1 })}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelLabel(selectedConfig)}</span><Icons.chevronDown size={13} /></button>
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
            {loading ? <button type="button" aria-label="停止生成" onClick={() => onStop?.()} style={transitionButton({ width: 34, height: 34, borderRadius: 10, background: C.accent, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 18px rgba(217,119,87,0.24)' })}><Icons.square size={14} /></button> : <button type="button" aria-label="发送" disabled={!canSend} onClick={() => submit()} style={transitionButton({ width: 34, height: 34, borderRadius: 10, background: canSend ? C.accent : C.muted, color: canSend ? '#fff' : '#BDBBB3', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: canSend ? 'pointer' : 'not-allowed', boxShadow: canSend ? '0 6px 18px rgba(217,119,87,0.22)' : 'none' })}><Icons.arrowUp size={18} /></button>}
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
        <ConfigSection title="联网搜索" subtitle="本次先保存配置和请求状态，真实外部搜索调用后续接入。">
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
            <label style={{ display: 'grid', gap: 6, fontSize: 12, color: C.tertiary }}>API Key<TextInput value={apiKeys[activeProvider] || ''} onChange={(event) => setApiKeys((prev) => ({ ...prev, [activeProvider]: event.target.value }))} masked placeholder={config.api_key_set?.[activeProvider] ? '留空则继续使用当前密钥' : '请输入该服务商 API Key'} /></label>
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

function DiffDialog({ operationSet, open, onClose, onApply }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const operations = operationItems(operationSet);
  useEffect(() => {
    if (open) setSelectedIndex(0);
  }, [open, operationSet?.id]);
  if (!open) return null;
  const activeOperation = operations[Math.min(selectedIndex, Math.max(operations.length - 1, 0))] || {};
  const activePath = activeOperation.file_path || activeOperation.path || (activeOperation.block_id ? 'Block ' + activeOperation.block_id : '全文');
  const diffLines = [
    ...(activeOperation.old ? String(activeOperation.old).split('\n').map((line) => ({ type: 'remove', content: line })) : []),
    ...(activeOperation.new ? String(activeOperation.new).split('\n').map((line) => ({ type: 'add', content: line })) : []),
    ...(activeOperation.content ? String(activeOperation.content).split('\n').map((line) => ({ type: 'add', content: line })) : []),
  ];
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, animation: 'fadeIn 0.2s ease-out both' }}>
      <button type="button" aria-label="关闭修改详情" onClick={onClose} style={{ position: 'absolute', inset: 0, border: 0, background: 'rgba(255,255,255,0.70)', backdropFilter: 'blur(10px)', padding: 0 }} />
      <div style={{ position: 'relative', width: '100%', maxWidth: 1024, height: '85vh', background: '#fff', border: '1px solid #E5E3D8', borderRadius: 22, boxShadow: '0 20px 60px -15px rgba(0,0,0,0.10)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: 56, flex: '0 0 auto', borderBottom: '1px solid #E5E3D8', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', background: C.page }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icons.code size={18} style={{ color: C.secondary }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>修改详情预览</span>
            <span style={{ fontSize: 12, color: '#A3A19A', marginLeft: 8, padding: '2px 8px', background: C.muted, borderRadius: 999 }}>{operations.length} 项变更</span>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} style={transitionButton({ width: 32, height: 32, borderRadius: 8, background: 'transparent', color: C.tertiary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' })}><Icons.x size={18} /></button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
          <div style={{ width: 256, flex: '0 0 auto', borderRight: '1px solid #E5E3D8', background: C.page, overflowY: 'auto', padding: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#A3A19A', textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 8px 10px' }}>变更列表</div>
            {operations.length === 0 ? <div style={{ padding: 12, fontSize: 13, color: C.tertiary }}>没有可展示的修改。</div> : operations.map((operation, index) => {
              const path = operation.file_path || operation.path || (operation.block_id ? 'Block ' + operation.block_id : '全文');
              const active = index === selectedIndex;
              const isNew = operation.type === 'create' || operation.is_new || operation.action === 'create';
              return (
                <button key={operation.id || index} type="button" onClick={() => setSelectedIndex(index)} style={transitionButton({ width: '100%', textAlign: 'left', display: 'grid', gap: 4, padding: '10px 12px', borderRadius: 10, background: active ? C.muted : 'transparent', color: active ? C.text : C.secondary })}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(path).split('/').pop()}</span>
                    <span style={{ fontSize: 10, fontWeight: 800, color: isNew ? '#E2574C' : C.accent, background: isNew ? 'rgba(226,87,76,0.10)' : 'rgba(217,119,87,0.10)', borderRadius: 5, padding: '2px 6px', flexShrink: 0 }}>{isNew ? '新建' : '修改'}</span>
                  </span>
                  <span style={{ fontSize: 11, color: '#A3A19A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
                </button>
              );
            })}
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#FAFAFA', overflow: 'hidden' }}>
            <div style={{ height: 40, flex: '0 0 auto', borderBottom: '1px solid #E5E3D8', display: 'flex', alignItems: 'center', padding: '0 16px', background: '#fff' }}>
              <span style={{ fontSize: 12, color: C.secondary, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activePath}</span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0' }}>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, lineHeight: 1.7 }}>
                {diffLines.length === 0 ? <div style={{ padding: '0 16px', color: C.tertiary }}>没有可展示的 diff 内容。</div> : diffLines.map((line, index) => {
                  const remove = line.type === 'remove';
                  const add = line.type === 'add';
                  return (
                    <div key={index} style={{ display: 'flex', padding: '0 16px', background: add ? 'rgba(187,247,208,0.45)' : remove ? 'rgba(254,202,202,0.45)' : 'transparent', color: add ? '#166534' : remove ? '#991B1B' : C.secondary, textDecoration: remove ? 'line-through' : 'none' }}>
                      <span style={{ width: 24, flex: '0 0 auto', color: '#BDBBB3', textAlign: 'right', paddingRight: 8, userSelect: 'none' }}>{add ? '+' : remove ? '-' : ' '}</span>
                      <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{line.content}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        <div style={{ height: 64, flex: '0 0 auto', borderTop: '1px solid #E5E3D8', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', background: C.page }}>
          <span style={{ fontSize: 12, color: '#A3A19A' }}>请确认这些变更符合预期后再应用。</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="button" onClick={onClose} style={transitionButton({ height: 36, padding: '0 16px', borderRadius: 10, background: '#fff', color: C.secondary, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.95)', fontSize: 13, fontWeight: 700 })}>关闭</button>
            <button type="button" onClick={() => onApply?.(operationSet)} style={transitionButton({ height: 36, padding: '0 16px', borderRadius: 10, background: C.accent, color: '#fff', boxShadow: '0 6px 18px rgba(217,119,87,0.22)', fontSize: 13, fontWeight: 700 })}>应用修改</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgentWorkspace({ messages, streamText, loading, error, activeSteps, llmConfigs, selectedConfigId, onConfigChange, onSend, onStop, onApplyOperationSet, onCancelOperationSet, onCitationClick, pendingAgentTask, onConfirmAgentTask, onCancelAgentTask, activeAgentSession, onRollbackAgentSession, onExtendAgentSession, disabled, placeholder, agentConfirmMode, onAgentConfirmModeChange }) {
  const router = useRouter();
  const [searchConfig, setSearchConfig] = useState({ enabled: false, selected_provider: 'firecrawl', modes: {}, counts: {}, api_key_set: {}, providers: SEARCH_PROVIDER_FALLBACKS });
  const [searchPromptOpen, setSearchPromptOpen] = useState(false);
  const [searchViewProvider, setSearchViewProvider] = useState('');
  const [detailOperationSet, setDetailOperationSet] = useState(null);
  const [undoOperationSet, setUndoOperationSet] = useState(null);
  const endRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/search-providers').then((response) => response.json()).then((payload) => {
      if (!cancelled) setSearchConfig((prev) => ({ ...prev, ...payload }));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streamText, loading, activeSteps, pendingAgentTask, activeAgentSession]);

  const requireSearchConfig = ({ selectProvider = '', quiet = false } = {}) => {
    if (selectProvider) {
      setSearchViewProvider(selectProvider);
      setSearchConfig((prev) => ({ ...prev, selected_provider: selectProvider }));
    }
    if (!quiet) setSearchPromptOpen(true);
  };

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 0, background: C.page, color: C.text, overflow: 'hidden', WebkitFontSmoothing: 'antialiased', MozOsxFontSmoothing: 'grayscale' }}>
      <main style={{ height: '100%', overflowY: 'auto', padding: '32px 16px 190px' }}>
        <div style={{ maxWidth: 768, margin: '0 auto' }}>
          <AgentTaskConfirmCard task={pendingAgentTask} onConfirm={onConfirmAgentTask} onCancel={onCancelAgentTask} />
          <AgentSessionCard session={activeAgentSession} onRollback={onRollbackAgentSession} onExtend={onExtendAgentSession} />
          <MessageList messages={messages || []} streamText={streamText || ''} loading={Boolean(loading)} activeSteps={activeSteps || []} onOpenOperationSet={setDetailOperationSet} onCancelOperationSet={setUndoOperationSet} onCitationClick={onCitationClick} />
          {error ? <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 14, background: 'rgba(217,119,87,0.08)', color: C.accentDark, fontSize: 13, lineHeight: 1.7 }}>{error}</div> : null}
          <div ref={endRef} style={{ height: 12 }} />
        </div>
      </main>
      <AgentInput loading={Boolean(loading)} disabled={Boolean(disabled)} llmConfigs={llmConfigs || []} selectedConfigId={selectedConfigId} onConfigChange={onConfigChange} onSend={onSend} onStop={onStop} searchConfig={searchConfig} onRequireSearchConfig={requireSearchConfig} placeholder={placeholder} agentConfirmMode={agentConfirmMode} onAgentConfirmModeChange={onAgentConfirmModeChange} />
      <Dialog open={searchPromptOpen} onClose={() => setSearchPromptOpen(false)} title="未配置搜索引擎" maxWidth={420} footer={<><Button variant="ghost" onClick={() => setSearchPromptOpen(false)}>取消</Button><Button variant="primary" onClick={() => { setSearchPromptOpen(false); navigateWithFallback(router, '/settings/search'); }}>前去配置</Button></>}>
        <div style={{ fontSize: 14, color: C.secondary, lineHeight: 1.8 }}>联网搜索需要先保存服务商 API Key。本次会保存配置和请求状态，真实外部搜索调用后续接入。</div>
      </Dialog>
      <DiffDialog open={Boolean(detailOperationSet)} operationSet={detailOperationSet} onClose={() => setDetailOperationSet(null)} onApply={(operationSet) => { setDetailOperationSet(null); onApplyOperationSet?.(operationSet); }} />
      <ConfirmDialog open={Boolean(undoOperationSet)} title="撤销这次修改预览" message={undoOperationSet ? '确定撤销这 ' + operationItems(undoOperationSet).length + ' 项修改预览吗？' : ''} confirmLabel="撤销" onClose={() => setUndoOperationSet(null)} onConfirm={() => { const target = undoOperationSet; setUndoOperationSet(null); onCancelOperationSet?.(target); }} />
    </div>
  );
}
