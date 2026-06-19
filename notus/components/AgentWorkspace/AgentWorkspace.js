import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { TextInput } from '../ui/Input';
import { Toggle } from '../ui/Toggle';
import { Dialog, ConfirmDialog } from '../ui/Dialog';
import { Icons } from '../ui/Icons';
import { useToast } from '../ui/Toast';
import { LlmConfigCardsSection } from '../Settings/LlmConfigCardsSection';
import { findEmbeddingModelMeta, inferEmbeddingProvider } from '../../lib/embeddingForm';

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

function ToolChain({ steps, loading }) {
  const visibleSteps = steps && steps.length ? steps : (loading ? [
    { id: 'prepare', label: '准备上下文', status: 'running', detail: '正在整理当前请求、模型和工作区上下文。' },
  ] : []);
  if (!visibleSteps.length) return null;

  return (
    <div style={{ width: '100%', margin: '12px 0 16px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid ' + C.border, paddingTop: 8 }}>
        {visibleSteps.map((step) => {
          const status = step.status || 'done';
          const running = status === 'running';
          const failed = status === 'error' || status === 'stopped';
          return (
            <details key={step.id || step.label} open={running || failed || Boolean(step.open)} style={{ borderRadius: 10 }}>
              <summary style={{
                minHeight: 34,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 10,
                cursor: 'pointer',
                color: failed ? C.accent : C.tertiary,
                fontSize: 13,
                listStyle: 'none',
              }}>
                <span style={{ width: 18, display: 'inline-flex', justifyContent: 'center' }}>
                  {running ? <Icons.refresh size={13} style={{ animation: 'spin 1s linear infinite' }} /> : failed ? <Icons.warn size={13} /> : <Icons.check size={13} />}
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.label}</span>
                <Icons.chevronRight size={13} />
              </summary>
              <div style={{ marginLeft: 28, padding: '8px 12px 10px', borderLeft: '1px solid ' + C.border, display: 'grid', gap: 8 }}>
                {step.detail ? <div style={{ fontSize: 13, lineHeight: 1.75, color: C.secondary, whiteSpace: 'pre-wrap' }}>{step.detail}</div> : null}
                {step.tool ? (
                  <div style={{ background: C.soft, borderRadius: 12, padding: 12, color: C.secondary, fontSize: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, color: C.text, marginBottom: 6 }}>
                      <Icons.code size={13} /> {step.tool}
                    </div>
                    {step.input ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{step.input}</pre> : null}
                    {step.result ? (
                      <pre style={{ margin: '8px 0 0', paddingTop: 8, borderTop: '1px solid ' + C.border, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{step.result}</pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function OperationSetCard({ operationSet, onOpenDetail, onCancel }) {
  if (!operationSet) return null;
  const operations = Array.isArray(operationSet.operations) ? operationSet.operations : [];
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
      boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.62)',
      flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <span style={{ width: 34, height: 34, borderRadius: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: C.secondary, background: '#fff', boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.72)' }}>
          <Icons.edit size={15} />
        </span>
        <div style={{ display: 'grid', gap: 3 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{operations.length} 项文件内容变更</div>
          <div style={{ fontSize: 12, color: C.tertiary }}>预览已生成，等待确认</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
        <button type="button" onClick={() => onCancel?.(operationSet)} style={transitionButton({ height: 32, padding: '0 12px', borderRadius: 10, background: '#fff', color: C.secondary, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.95)', fontSize: 12, fontWeight: 700 })}>撤销</button>
        <button type="button" onClick={() => onOpenDetail?.(operationSet)} style={transitionButton({ height: 32, padding: '0 14px', borderRadius: 10, background: C.accent, color: '#fff', boxShadow: '0 6px 18px rgba(217, 119, 87, 0.22)', fontSize: 12, fontWeight: 700 })}>查看详情</button>
      </div>
    </div>
  );
}

function MessageList({ messages, streamText, loading, activeSteps, onOpenOperationSet, onCancelOperationSet }) {
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
              {message.content ? <div style={{ fontSize: 15, lineHeight: 1.85, color: C.text, whiteSpace: 'pre-wrap' }}>{message.content}</div> : null}
              {Array.isArray(message.citations) && message.citations.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                  {message.citations.slice(0, 6).map((citation, index) => (
                    <div key={citation.file_id || citation.file || index} style={{ maxWidth: 260, padding: '8px 10px', borderRadius: 12, background: C.soft, color: C.secondary, textAlign: 'left', fontSize: 12, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.78)' }}>
                      <span style={{ fontWeight: 700, color: C.text }}>{citation.file_title || citation.file || '来源'}</span>
                      {citation.preview || citation.quote ? <span> · {String(citation.preview || citation.quote).slice(0, 40)}</span> : null}
                    </div>
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
            {streamText ? <div style={{ fontSize: 15, lineHeight: 1.85, color: C.text, whiteSpace: 'pre-wrap' }}>{streamText}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AgentInput({ loading, disabled, llmConfigs, selectedConfigId, onConfigChange, onSend, onStop, searchConfig, onRequireSearchConfig, suggestions, placeholder }) {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState([]);
  const [focused, setFocused] = useState(false);
  const [webEnabled, setWebEnabled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const fileInputRef = useRef(null);
  const selectedConfig = useMemo(() => llmConfigs.find((item) => String(item.id) === String(selectedConfigId)) || llmConfigs[0] || null, [llmConfigs, selectedConfigId]);
  const providers = searchConfig.providers || SEARCH_PROVIDER_FALLBACKS;
  const selectedSearchProvider = searchConfig.selected_provider || providers[0]?.id || 'firecrawl';
  const selectedSearchLabel = providers.find((item) => item.id === selectedSearchProvider)?.name || '搜索';
  const searchConfigured = Boolean(searchConfig.api_key_set?.[selectedSearchProvider]);

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
    if (webEnabled && !searchConfigured) {
      onRequireSearchConfig?.();
      return;
    }
    onSend?.(text, {
      llmConfigId: selectedConfig.id,
      attachments: files,
      webSearchEnabled: webEnabled,
      searchProvider: webEnabled ? selectedSearchProvider : null,
    });
    setValue('');
    setFiles([]);
    setSearchOpen(false);
    setModelOpen(false);
  };

  const canSend = !loading && !disabled && Boolean(selectedConfig) && (Boolean(value.trim()) || files.length > 0);

  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '42px 16px 28px', background: 'linear-gradient(180deg, rgba(253,252,251,0), ' + C.page + ' 32%, ' + C.page + ')', zIndex: 6 }}>
      {suggestions && suggestions.length > 0 && !value && files.length === 0 ? (
        <div style={{ maxWidth: 780, margin: '0 auto 12px', display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {suggestions.slice(0, 4).map((item) => (
            <button key={item} type="button" onClick={() => submit(item)} style={transitionButton({ height: 30, padding: '0 12px', borderRadius: 999, background: '#fff', color: C.secondary, fontSize: 12, boxShadow: '0 2px 8px rgba(45,45,45,0.05), inset 0 0 0 1px rgba(229,227,216,0.9)' })}>{item}</button>
          ))}
        </div>
      ) : null}
      <div style={{ maxWidth: 780, margin: '0 auto', borderRadius: 22, background: '#fff', boxShadow: focused ? '0 8px 30px rgba(217,119,87,0.11), inset 0 0 0 1px rgba(217,119,87,0.34)' : '0 5px 24px rgba(45,45,45,0.06), inset 0 0 0 1px rgba(229,227,216,0.95)', transitionProperty: 'box-shadow', transitionDuration: '180ms', overflow: 'visible' }}>
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={(event) => { addFiles(event.target.files); event.target.value = ''; }} />
        {files.length > 0 ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '14px 16px 0' }}>{files.map((file) => <FileChip key={file.id} file={file} onRemove={(id) => setFiles((prev) => prev.filter((item) => item.id !== id))} />)}</div> : null}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, padding: 10 }}>
          <button type="button" aria-label="添加附件" onClick={() => fileInputRef.current?.click()} disabled={loading || disabled} style={transitionButton({ width: 36, height: 36, borderRadius: 12, background: C.soft, color: C.secondary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: loading || disabled ? 0.6 : 1 })}><Icons.paperclip size={17} /></button>
          <textarea value={value} rows={1} placeholder={placeholder || '告诉 Notus 你想处理什么…'} disabled={disabled} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) { event.preventDefault(); submit(); } }} style={{ flex: 1, minHeight: 42, maxHeight: 180, resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: disabled ? C.tertiary : C.text, fontSize: 15, lineHeight: 1.65, padding: '8px 4px', fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'nowrap', flexShrink: 0 }}>
            <div style={{ position: 'relative' }}>
              <button type="button" onClick={() => { if (!searchConfigured && !webEnabled) { onRequireSearchConfig?.(); return; } setWebEnabled((prev) => !prev); }} disabled={loading} style={transitionButton({ height: 32, padding: '0 10px', borderRadius: 10, background: webEnabled ? 'rgba(251,228,210,0.52)' : 'transparent', color: webEnabled ? C.accent : C.tertiary, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: webEnabled ? 800 : 600 })}><Icons.globe size={15} />联网</button>
              {webEnabled ? <button type="button" onClick={() => setSearchOpen((prev) => !prev)} style={transitionButton({ height: 32, padding: '0 8px', borderRadius: 10, background: 'transparent', color: C.secondary, fontSize: 12 })}>{selectedSearchLabel} <Icons.chevronDown size={12} /></button> : null}
              {searchOpen ? (
                <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, width: 210, padding: 8, borderRadius: 16, background: '#fff', boxShadow: '0 -12px 36px rgba(45,45,45,0.12), inset 0 0 0 1px rgba(229,227,216,0.95)', zIndex: 20 }}>
                  <div style={{ padding: '6px 8px', color: C.tertiary, fontSize: 11, fontWeight: 800 }}>搜索服务商</div>
                  {providers.map((provider) => (
                    <button type="button" key={provider.id} onClick={() => { onRequireSearchConfig?.({ selectProvider: provider.id, quiet: true }); setSearchOpen(false); }} style={transitionButton({ width: '100%', height: 34, padding: '0 9px', borderRadius: 10, background: provider.id === selectedSearchProvider ? 'rgba(251,228,210,0.38)' : 'transparent', color: provider.id === selectedSearchProvider ? C.accent : C.secondary, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 })}>{provider.name}{provider.id === selectedSearchProvider ? <Icons.check size={13} /> : null}</button>
                  ))}
                </div>
              ) : null}
            </div>
            <div style={{ position: 'relative' }}>
              <button type="button" onClick={() => setModelOpen((prev) => !prev)} disabled={llmConfigs.length === 0} style={transitionButton({ maxWidth: 168, height: 32, padding: '0 9px', borderRadius: 10, background: 'transparent', color: C.secondary, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700, opacity: llmConfigs.length === 0 ? 0.55 : 1 })}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelLabel(selectedConfig)}</span><Icons.chevronDown size={13} /></button>
              {modelOpen ? (
                <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, width: 280, maxHeight: 320, overflowY: 'auto', padding: 8, borderRadius: 16, background: '#fff', boxShadow: '0 -12px 36px rgba(45,45,45,0.12), inset 0 0 0 1px rgba(229,227,216,0.95)', zIndex: 20 }}>
                  {llmConfigs.length === 0 ? <div style={{ padding: 10, fontSize: 13, color: C.tertiary }}>暂无模型配置</div> : llmConfigs.map((config) => (
                    <button type="button" key={config.id} onClick={() => { onConfigChange?.(config.id); setModelOpen(false); }} style={transitionButton({ width: '100%', minHeight: 44, padding: '8px 10px', borderRadius: 12, background: String(config.id) === String(selectedConfig?.id) ? 'rgba(251,228,210,0.38)' : 'transparent', color: String(config.id) === String(selectedConfig?.id) ? C.accent : C.text, textAlign: 'left' })}><span style={{ display: 'block', fontSize: 13, fontWeight: 800 }}>{modelLabel(config)}</span><span style={{ display: 'block', marginTop: 2, fontSize: 11, color: C.tertiary }}>{providerLabel(config)}</span></button>
                  ))}
                </div>
              ) : null}
            </div>
            {loading ? <button type="button" aria-label="停止生成" onClick={() => onStop?.()} style={transitionButton({ width: 36, height: 36, borderRadius: 12, background: C.accent, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 18px rgba(217,119,87,0.24)' })}><Icons.square size={14} /></button> : <button type="button" aria-label="发送" disabled={!canSend} onClick={() => submit()} style={transitionButton({ width: 36, height: 36, borderRadius: 12, background: canSend ? C.accent : C.muted, color: canSend ? '#fff' : '#BDBBB3', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: canSend ? 'pointer' : 'not-allowed', boxShadow: canSend ? '0 6px 18px rgba(217,119,87,0.22)' : 'none' })}><Icons.arrowUp size={17} /></button>}
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
  const operations = Array.isArray(operationSet?.operations) ? operationSet.operations : [];
  return (
    <Dialog open={open} onClose={onClose} title="文件变更详情" maxWidth={780} footer={<><Button variant="ghost" onClick={onClose}>关闭</Button><Button variant="primary" onClick={() => onApply?.(operationSet)}>应用修改</Button></>}>
      <div style={{ maxHeight: '62vh', overflow: 'auto', display: 'grid', gap: 12 }}>
        {operations.length === 0 ? <div style={{ color: C.tertiary, fontSize: 13 }}>没有可展示的修改。</div> : operations.map((operation, index) => (
          <div key={operation.id || index} style={{ borderRadius: 14, background: C.soft, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.75)', overflow: 'hidden' }}>
            <div style={{ padding: '10px 12px', display: 'flex', justifyContent: 'space-between', gap: 12, color: C.secondary, fontSize: 12 }}><strong style={{ color: C.text }}>#{index + 1} {operation.type || operation.action || '修改'}</strong><span>{operation.block_id ? 'Block ' + operation.block_id : '全文'}</span></div>
            <pre style={{ margin: 0, padding: 12, background: '#fff', color: C.secondary, whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{[operation.old ? '- ' + operation.old : '', operation.new ? '+ ' + operation.new : '', operation.content ? '+ ' + operation.content : ''].filter(Boolean).join('\n')}</pre>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function AgentWorkspace({ pageTitle, modeLabel, messages, streamText, loading, error, activeSteps, suggestions, llmConfigs, selectedConfigId, onConfigChange, onSend, onStop, onApplyOperationSet, onCancelOperationSet, disabled, placeholder }) {
  const [view, setView] = useState('chat');
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
  }, [messages, streamText, loading, activeSteps]);

  if (view === 'modelConfig') return <ModelConfigView onBack={() => setView('chat')} />;
  if (view === 'searchConfig') {
    return <SearchConfigView config={searchConfig} selectProvider={searchViewProvider} onBack={() => setView('chat')} onSaved={(nextConfig) => setSearchConfig((prev) => ({ ...prev, ...nextConfig }))} />;
  }

  const requireSearchConfig = ({ selectProvider = '', quiet = false } = {}) => {
    if (selectProvider) {
      setSearchViewProvider(selectProvider);
      setSearchConfig((prev) => ({ ...prev, selected_provider: selectProvider }));
    }
    if (!quiet) setSearchPromptOpen(true);
  };

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 0, background: C.page, color: C.text, overflow: 'hidden', WebkitFontSmoothing: 'antialiased', MozOsxFontSmoothing: 'grayscale' }}>
      <header style={{ height: 56, display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 12, padding: '0 16px', background: 'rgba(255,255,255,0.84)', boxShadow: 'inset 0 -1px 0 rgba(229,227,216,0.9)', backdropFilter: 'blur(10px)', position: 'relative', zIndex: 8 }}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', minWidth: 0 }}>
          <button type="button" onClick={() => setView('modelConfig')} style={transitionButton({ height: 34, padding: '0 11px', borderRadius: 11, background: 'transparent', color: C.secondary, display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 800 })}><Icons.robot size={15} /> 模型配置</button>
          <button type="button" onClick={() => setView('searchConfig')} style={transitionButton({ height: 34, padding: '0 11px', borderRadius: 11, background: 'transparent', color: C.secondary, display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 800 })}><Icons.settings size={15} /> 搜索配置</button>
        </div>
        <div style={{ fontFamily: 'Georgia, Songti SC, STSong, serif', fontSize: 17, fontWeight: 800, color: C.text, textAlign: 'center' }}>{pageTitle || 'Notus Agent Workspace'}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: C.tertiary }}>{modeLabel || 'Agent'}</span>
          <span style={{ height: 24, display: 'inline-flex', alignItems: 'center', padding: '0 9px', borderRadius: 999, background: searchConfig.enabled ? '#F0F9F0' : C.soft, color: searchConfig.enabled ? '#3B7A3F' : C.tertiary, fontSize: 11, fontWeight: 800, boxShadow: 'inset 0 0 0 1px rgba(229,227,216,0.74)' }}>{searchConfig.enabled ? '搜索配置已启用' : '仅本地知识库'}</span>
        </div>
      </header>
      <main style={{ height: 'calc(100% - 56px)', overflowY: 'auto', padding: '32px 18px 190px' }}>
        <div style={{ maxWidth: 780, margin: '0 auto' }}>
          <MessageList messages={messages || []} streamText={streamText || ''} loading={Boolean(loading)} activeSteps={activeSteps || []} onOpenOperationSet={setDetailOperationSet} onCancelOperationSet={setUndoOperationSet} />
          {error ? <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 14, background: 'rgba(217,119,87,0.08)', color: C.accentDark, fontSize: 13, lineHeight: 1.7 }}>{error}</div> : null}
          <div ref={endRef} style={{ height: 12 }} />
        </div>
      </main>
      <AgentInput loading={Boolean(loading)} disabled={Boolean(disabled)} llmConfigs={llmConfigs || []} selectedConfigId={selectedConfigId} onConfigChange={onConfigChange} onSend={onSend} onStop={onStop} searchConfig={searchConfig} onRequireSearchConfig={requireSearchConfig} suggestions={suggestions || []} placeholder={placeholder} />
      <Dialog open={searchPromptOpen} onClose={() => setSearchPromptOpen(false)} title="需要先配置搜索服务商" maxWidth={420} footer={<><Button variant="ghost" onClick={() => setSearchPromptOpen(false)}>稍后再说</Button><Button variant="primary" onClick={() => { setSearchPromptOpen(false); setView('searchConfig'); }}>去配置</Button></>}>
        <div style={{ fontSize: 14, color: C.secondary, lineHeight: 1.8 }}>联网搜索需要先保存服务商 API Key。本次会保存配置和请求状态，真实外部搜索调用后续接入。</div>
      </Dialog>
      <DiffDialog open={Boolean(detailOperationSet)} operationSet={detailOperationSet} onClose={() => setDetailOperationSet(null)} onApply={(operationSet) => { setDetailOperationSet(null); onApplyOperationSet?.(operationSet); }} />
      <ConfirmDialog open={Boolean(undoOperationSet)} title="撤销这次修改预览" message={undoOperationSet ? '确定撤销这 ' + (Array.isArray(undoOperationSet.operations) ? undoOperationSet.operations.length : 0) + ' 项修改预览吗？' : ''} confirmLabel="撤销" onClose={() => setUndoOperationSet(null)} onConfirm={() => { const target = undoOperationSet; setUndoOperationSet(null); onCancelOperationSet?.(target); }} />
    </div>
  );
}
