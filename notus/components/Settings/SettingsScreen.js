import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { NotusLogo, Icons } from '../ui/Icons';
import { Button } from '../ui/Button';
import { DropdownSelect } from '../ui/DropdownSelect';
import { SearchInput, TextInput } from '../ui/Input';
import { ConfirmDialog, Dialog } from '../ui/Dialog';
import { ProgressBar } from '../ui/ProgressBar';
import { Badge } from '../ui/Badge';
import { Toggle } from '../ui/Toggle';
import { useToast } from '../ui/Toast';
import { formatFullTimestamp } from '../../utils/messageTimestamps';
import { AgentLoopLogList } from '../AgentLoop/AgentLoopLogList';
import { LlmConfigCardsSection } from './LlmConfigCardsSection';
import packageMeta from '../../package.json';
import { usePlatform } from '../../contexts/PlatformContext';
import { findEmbeddingModelMeta, inferEmbeddingProvider } from '../../lib/embeddingForm';
import { useShortcuts, normalizeShortcut, DEFAULT_SHORTCUTS } from '../../contexts/ShortcutsContext';
import { navigateWithFallback } from '../../utils/navigation';
import { desktop as desktopClient } from '../../utils/platformClient';
import { readJsonResponse } from '../../utils/fetchJson';
import { SegmentedTabs } from '../ui/SegmentedTabs';
import { FileOperationDiffDialog } from '../AIPanel/FileOperationDiffDialog';
import { Tooltip } from '../ui/Tooltip';

const APP_VERSION = packageMeta.version || '0.1.2';
const SETTINGS_CONTENT_MAX_WIDTH = 860;
const SETTINGS_SURFACE_STYLE = {
  background: '#fff',
  border: '1px solid #E5E3D8',
  borderRadius: 14,
  padding: 24,
  boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
};

const SETTINGS_RESOURCE_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  justifyContent: 'space-between',
  border: '1px solid #ECE9DF',
  borderRadius: 12,
  padding: '12px 14px',
  background: '#FDFCFB',
};

const SETTINGS_RESOURCE_ICON_STYLE = {
  width: 34,
  height: 34,
  borderRadius: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  background: '#F6E8E1',
  color: '#BE6247',
  border: '1px solid #EFD9CF',
};

const EXTERNAL_MCP_PERMISSION_GROUPS = [
  { title: '基础只读', items: [['search_files', '按文件名与路径搜索'], ['list_files', '列出笔记文件'], ['get_note', '读取笔记内容'], ['list_skills', '列出 Skill'], ['list_mcp_servers', '列出 MCP Server']] },
  { title: '文件写入', items: [['create_note', '创建笔记'], ['patch_note', '局部修改笔记'], ['replace_note', '完整替换笔记'], ['move_note', '移动笔记'], ['rename_note', '重命名笔记']] },
];
const EXTERNAL_MCP_MANUAL_PERMISSION_GROUP = { title: '手动确认', items: [['get_change_status', '查询待确认变更状态']] };
const EXTERNAL_MCP_DEFAULT_PERMISSIONS = EXTERNAL_MCP_PERMISSION_GROUPS[0].items.map(([id]) => id);

export const SETTINGS_SECTIONS = [
  { id: 'model', label: '模型配置', icon: <Icons.robot size={17} /> },
  { id: 'search', label: '搜索配置', icon: <Icons.settings size={17} /> },
  { id: 'skills', label: 'Skill', icon: <Icons.skill size={17} /> },
  { id: 'mcp', label: 'MCP', icon: <Icons.mcp size={17} /> },
  { id: 'personalization', label: '个性化', icon: <Icons.palette size={17} /> },
  { id: 'global-agent', label: 'Agent 个性', icon: <Icons.brain size={17} /> },
  { id: 'image-storage', label: '图床', icon: <Icons.image size={17} /> },
  { id: 'storage', label: '存储', icon: <Icons.database size={17} /> },
  { id: 'logs', label: '日志', icon: <Icons.list size={17} /> },
  { id: 'shortcuts', label: '快捷键', icon: <Icons.keyboard size={17} /> },
  { id: 'about', label: '关于', icon: <Icons.info size={17} /> },
];

const SettingsNav = ({ active, onSelect, mobileOpen = false }) => {
  return (
    <nav className={['notus-settings-nav', mobileOpen ? 'is-mobile-open' : ''].filter(Boolean).join(' ')} aria-label="设置菜单" style={{ width: 224, background: 'var(--bg-sidebar)', borderRight: '1px solid var(--border-subtle)', padding: '20px 16px', flexShrink: 0 }}>
      {SETTINGS_SECTIONS.map((item) => {
        const activeItem = item.id === active;
        return (
          <button
            type="button"
            key={item.id}
            onClick={() => onSelect(item.id)}
            aria-current={activeItem ? 'page' : undefined}
            style={{
              width: '100%',
              border: 0,
              height: 42,
              padding: '0 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              borderRadius: 'var(--radius-sm)',
              marginBottom: 4,
              background: activeItem ? 'var(--accent-subtle)' : 'transparent',
              color: activeItem ? 'var(--accent)' : 'var(--text-primary)',
              fontSize: 'var(--text-base)',
              fontWeight: activeItem ? 500 : 400,
              cursor: 'pointer',
              fontFamily: 'inherit',
              textAlign: 'left',
            }}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </nav>
  );
};

const Field = ({ label, children, hint }) => (
  <div style={{ marginBottom: 20 }}>
    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 6 }}>{label}</div>
    {children}
    {hint && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{hint}</div>}
  </div>
);

const Section = ({ title, children }) => (
  <div style={{ marginBottom: 32 }}>
    <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--border-subtle)' }}>
      {title}
    </div>
    {children}
  </div>
);

const NoteBox = ({ tone = 'info', children }) => {
  const tones = {
    info: {
      background: 'rgba(74, 140, 217, 0.08)',
      borderColor: 'rgba(74, 140, 217, 0.24)',
      color: '#3B6EA8',
    },
    success: {
      background: 'rgba(33, 186, 108, 0.08)',
      borderColor: 'rgba(33, 186, 108, 0.24)',
      color: 'var(--success)',
    },
    warning: {
      background: 'rgba(234, 179, 8, 0.1)',
      borderColor: 'rgba(234, 179, 8, 0.26)',
      color: 'var(--warning)',
    },
  };

  const current = tones[tone] || tones.info;

  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 'var(--radius-lg)',
        border: `1px solid ${current.borderColor}`,
        background: current.background,
        color: current.color,
        fontSize: 'var(--text-sm)',
        lineHeight: 1.7,
      }}
    >
      {children}
    </div>
  );
};

function buildEmbeddingConnectivitySignature({ provider, model, baseUrl, apiKey, apiKeySet, multimodalEnabled }) {
  return JSON.stringify({
    provider: String(provider || '').trim(),
    model: String(model || '').trim(),
    baseUrl: String(baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(apiKey || '').trim() || (apiKeySet ? '__stored__' : ''),
    multimodalEnabled: Boolean(multimodalEnabled),
  });
}

const ModelConfig = () => {
  const toast = useToast();
  const [embProvider, setEmbProvider] = useState('qwen');
  const [embModel, setEmbModel] = useState('');
  const [embApiKey, setEmbApiKey] = useState('');
  const [embBaseUrl, setEmbBaseUrl] = useState('');
  const [embMultimodalEnabled, setEmbMultimodalEnabled] = useState(false);
  const [testState, setTestState] = useState('idle');
  const [saving, setSaving] = useState(false);
  const [keyHints, setKeyHints] = useState({ embedding: false });
  const [detectedEmbDim, setDetectedEmbDim] = useState(null);
  const [testedSignature, setTestedSignature] = useState('');
  const [verificationToken, setVerificationToken] = useState('');
  const selectedEmbeddingModel = useMemo(
    () => findEmbeddingModelMeta({ provider: embProvider, baseUrl: embBaseUrl, model: embModel }),
    [embBaseUrl, embModel, embProvider]
  );
  const resolvedEmbProvider = useMemo(
    () => inferEmbeddingProvider({ provider: embProvider, baseUrl: embBaseUrl, model: embModel }),
    [embBaseUrl, embModel, embProvider]
  );
  const embeddingConnectivitySignature = useMemo(
    () => buildEmbeddingConnectivitySignature({
      provider: resolvedEmbProvider,
      model: embModel,
      baseUrl: embBaseUrl,
      apiKey: embApiKey,
      apiKeySet: keyHints.embedding,
      multimodalEnabled: embMultimodalEnabled,
    }),
    [embApiKey, embBaseUrl, embModel, embMultimodalEnabled, keyHints.embedding, resolvedEmbProvider]
  );
  const embeddingTestCurrent = testState === 'success'
    && testedSignature === embeddingConnectivitySignature
    && Boolean(verificationToken);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/settings');
        const settings = await readJsonResponse(response, { fallbackMessage: '读取配置失败' });
        if (cancelled) return;
        const savedEmbModel = String(settings.embedding?.model || '').trim();
        const savedEmbBaseUrl = String(settings.embedding?.base_url || '').trim();
        if (settings.embedding) {
          setEmbProvider(inferEmbeddingProvider({
            provider: settings.embedding.provider,
            baseUrl: savedEmbBaseUrl,
            model: savedEmbModel,
          }));
          setEmbModel((current) => current || savedEmbModel);
          setEmbBaseUrl((current) => current || savedEmbBaseUrl);
          setDetectedEmbDim(Number(settings.embedding.dim || 0) || null);
          setEmbMultimodalEnabled(Boolean(settings.embedding.multimodal_enabled));
        }
        setKeyHints({
          embedding: Boolean(settings.embedding?.api_key_set),
        });
        setTestedSignature('');
        setVerificationToken('');
      } catch (error) {
        if (cancelled) return;
        toast(error.message || '读取配置失败', 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const handleTest = async () => {
    if (!embModel.trim()) {
      toast('请填写 Embedding 模型名', 'warning');
      return;
    }

    setTestState('loading');
    try {
      const embeddingResponse = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'embedding',
          config: {
            model: embModel,
            api_key: embApiKey,
            base_url: embBaseUrl,
            multimodal_enabled: embMultimodalEnabled,
          },
        }),
      });
      const embeddingResult = await readJsonResponse(embeddingResponse, { fallbackMessage: 'Embedding 连接失败' });
      if (!embeddingResult.success) throw new Error(embeddingResult.error || 'Embedding 连接失败');

      setEmbProvider(embeddingResult.provider || resolvedEmbProvider);
      setDetectedEmbDim(Number(embeddingResult.dimension || 0) || Number(selectedEmbeddingModel?.dimension || 0) || null);
      setTestState('success');
      setTestedSignature(buildEmbeddingConnectivitySignature({
        provider: embeddingResult.provider || resolvedEmbProvider,
        model: embModel,
        baseUrl: embBaseUrl,
        apiKey: embApiKey,
        apiKeySet: keyHints.embedding,
        multimodalEnabled: embMultimodalEnabled,
      }));
      setVerificationToken(embeddingResult.verification_token || '');
      toast(`Embedding 连接测试成功${embeddingResult.dimension ? `，已识别 ${embeddingResult.dimension} 维` : ''}`, 'success');
    } catch (error) {
      setTestState('error');
      setVerificationToken('');
      setTestedSignature('');
      toast(error.message || '连接测试失败', 'error');
    }
  };

  const handleEmbeddingFieldChange = (patch) => {
    const nextBaseUrl = patch.embBaseUrl ?? embBaseUrl;
    const nextModel = patch.embModel ?? embModel;
    const nextProvider = inferEmbeddingProvider({ baseUrl: nextBaseUrl, model: nextModel });

    if (patch.embBaseUrl !== undefined) setEmbBaseUrl(nextBaseUrl);
    if (patch.embModel !== undefined) setEmbModel(nextModel);
    if (patch.embApiKey !== undefined) setEmbApiKey(patch.embApiKey);
    if (patch.embMultimodalEnabled !== undefined) setEmbMultimodalEnabled(patch.embMultimodalEnabled);
    setEmbProvider(nextProvider);
    setTestState('idle');
    setTestedSignature('');
    setVerificationToken('');
    setDetectedEmbDim((current) => {
      if (patch.embModel === undefined && patch.embBaseUrl === undefined) return current;
      return Number(findEmbeddingModelMeta({
        baseUrl: nextBaseUrl,
        model: nextModel,
      })?.dimension || 0) || null;
    });
  };

  const handleSave = async () => {
    if (!embModel.trim()) {
      toast('请填写 Embedding 模型名', 'warning');
      return;
    }
    if (!embeddingTestCurrent) {
      toast('请先测试当前 Embedding 配置，测试通过后才能保存', 'warning');
      return;
    }
    const resolvedDim = Number(detectedEmbDim || 0) || null;
    if (!resolvedDim) {
      toast('请先测试 Embedding 连接，自动识别当前模型的向量维度', 'warning');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embedding: {
            provider: resolvedEmbProvider,
            model: embModel,
            dim: resolvedDim,
            multimodal_enabled: embMultimodalEnabled,
            base_url: embBaseUrl,
            api_key: embApiKey,
            verification_token: verificationToken,
          },
        }),
      });
      const payload = await readJsonResponse(response, { fallbackMessage: '保存失败' });
      setEmbApiKey('');
      setEmbProvider(payload.embedding?.provider || resolvedEmbProvider);
      setEmbModel(String(payload.embedding?.model || embModel || '').trim());
      setEmbBaseUrl(String(payload.embedding?.base_url || embBaseUrl || '').trim());
      setKeyHints({
        embedding: Boolean(payload.embedding?.api_key_set),
      });
      setTestedSignature('');
      setVerificationToken('');
      setTestState('idle');
      toast('Embedding 配置已保存', 'success');
    } catch (error) {
      toast(error.message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ width: '100%', color: '#2D2D2D' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        <section style={{ background: '#fff', border: '1px solid #E5E3D8', borderRadius: 12, padding: 24, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(251,228,210,0.5)', color: '#D97757', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icons.database size={18} /></div>
            <div>
              <div style={{ fontSize: 15, lineHeight: 1.25, fontWeight: 700 }}>Embedding 配置</div>
              <div style={{ fontSize: 12, color: '#8A8881', marginTop: 3, lineHeight: 1.45 }}>用于知识库索引与检索的向量模型</div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <label className="notus-llm-field">
              <span>Base URL</span>
              <input
                className="notus-model-input"
                value={embBaseUrl}
                onChange={(event) => handleEmbeddingFieldChange({ embBaseUrl: event.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </label>

            <label className="notus-llm-field">
              <span>模型名称</span>
              <input
                className="notus-model-input"
                value={embModel}
                onChange={(event) => handleEmbeddingFieldChange({ embModel: event.target.value })}
                placeholder="例如：text-embedding-3-small"
              />
            </label>

            <label className="notus-llm-field">
              <span>API Key</span>
              <input
                className="notus-model-input"
                type="password"
                value={embApiKey}
                onChange={(event) => handleEmbeddingFieldChange({ embApiKey: event.target.value })}
                placeholder="sk-••••••••••••"
              />
            </label>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, border: '1px solid #F2F0EA', background: '#FDFCFB', borderRadius: 10, padding: '12px 16px' }}>
              <div>
                <div style={{ fontSize: 13, lineHeight: 1.35, color: '#4B4944', fontWeight: 700 }}>启用多模态向量</div>
                <div style={{ fontSize: 12, color: '#8A8881', marginTop: 3 }}>用于图片等非纯文本内容的索引能力</div>
              </div>
              <button
                type="button"
                aria-pressed={embMultimodalEnabled}
                onClick={() => handleEmbeddingFieldChange({ embMultimodalEnabled: !embMultimodalEnabled })}
                style={{
                  width: 44,
                  height: 24,
                  border: 0,
                  borderRadius: 999,
                  padding: 2,
                  background: embMultimodalEnabled ? '#D97757' : '#E5E3D8',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: embMultimodalEnabled ? 'flex-end' : 'flex-start',
                  transitionProperty: 'background-color',
                  transitionDuration: '150ms',
                }}
              >
                <span style={{ width: 20, height: 20, borderRadius: 999, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.16)' }} />
              </button>
            </div>
          </div>

          <div style={{ borderTop: '1px solid #F2F0EA', paddingTop: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ maxWidth: '55%', minWidth: 220, color: testState === 'success' ? 'var(--success)' : testState === 'error' ? 'var(--danger)' : '#A3A19A', fontSize: 11, lineHeight: 1.6 }}>
              {testState === 'success'
                ? 'Embedding 连接测试通过，可以保存当前配置。'
                : testState === 'error'
                  ? 'Embedding 连接失败，请检查模型、地址或 API Key。'
                  : '保存前需要完成一次 Embedding 连通性测试，系统会记录向量维度用于索引。'}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="notus-llm-secondary-button"
                onClick={handleTest}
                disabled={testState === 'loading'}
                style={{
                  ...(testState === 'success' ? { borderColor: 'var(--success)', color: 'var(--success)' } : {}),
                  ...(testState === 'error' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}),
                }}
              >
                {testState === 'loading' ? '测试中…' : testState === 'success' ? '✓ Embedding 正常' : testState === 'error' ? '✕ Embedding 失败' : '测试 Embedding'}
              </button>
              <button type="button" className="notus-llm-primary-button" disabled={saving || !embeddingTestCurrent} onClick={handleSave}>
                {saving ? '保存中…' : '保存 Embedding'}
              </button>
            </div>
          </div>
        </section>

        <section style={{ background: '#fff', border: '1px solid #E5E3D8', borderRadius: 12, padding: 24, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <LlmConfigCardsSection title="LLM 配置" />
        </section>
      </div>
    </div>
  );
};

const SEARCH_MODE_OPTIONS = {
  firecrawl: [{ value: 'default', label: '默认模式：scrape & search', description: '使用 Firecrawl 默认抓取和搜索组合。' }],
  tavily: [
    { value: 'basic', label: 'basic', description: '默认模式，成本较低。' },
    { value: 'advanced', label: 'advanced', description: '更深度的搜索结果，成本更高。' },
  ],
  exa: [
    { value: 'auto', label: 'auto', description: '默认模式，自动选择策略。' },
    { value: 'fast', label: 'fast', description: '速度优先。' },
    { value: 'deep', label: 'deep', description: '质量更高，耗时更长。' },
  ],
  zhipu: [{ value: 'search-prime', label: '默认搜索引擎：search-prime', description: '使用智谱默认搜索能力。' }],
};

const SearchConfig = () => {
  const router = useRouter();
  const toast = useToast();
  const [config, setConfig] = useState({
    enabled: false,
    selected_provider: 'firecrawl',
    modes: {},
    counts: {},
    api_key_set: {},
    providers: [],
  });
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const savingEnabledRef = useRef(false);
  const providers = useMemo(() => config.providers || [], [config.providers]);
  const requestedProvider = String(router.query.provider || '').trim().toLowerCase();
  const selectedProvider = providers.find((item) => item.id === config.selected_provider) || providers[0] || { id: 'firecrawl', name: 'Firecrawl', max_limit: 20 };
  const modeOptions = SEARCH_MODE_OPTIONS[selectedProvider.id] || SEARCH_MODE_OPTIONS.firecrawl;
  const patchConfig = (patch) => setConfig((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/search-providers')
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) {
          const nextProviders = payload.providers || [];
          const nextProvider = nextProviders.some((provider) => provider.id === requestedProvider) ? requestedProvider : payload.selected_provider;
          setConfig((prev) => ({ ...prev, ...payload, selected_provider: nextProvider || payload.selected_provider || prev.selected_provider }));
        }
      })
      .catch(() => toast('读取搜索配置失败', 'error'));
    return () => { cancelled = true; };
  }, [requestedProvider, toast]);

  useEffect(() => {
    if (!requestedProvider || !providers.some((provider) => provider.id === requestedProvider)) return;
    setConfig((prev) => ({ ...prev, selected_provider: requestedProvider }));
    setApiKey('');
  }, [providers, requestedProvider]);

  const setMode = (mode) => setConfig((prev) => ({ ...prev, modes: { ...(prev.modes || {}), [selectedProvider.id]: mode } }));
  const setCount = (count) => setConfig((prev) => ({ ...prev, counts: { ...(prev.counts || {}), [selectedProvider.id]: Number(count) || 1 } }));

  const saveEnabled = async (enabled) => {
    if (savingEnabledRef.current) return;
    const previousEnabled = Boolean(config.enabled);
    savingEnabledRef.current = true;
    patchConfig({ enabled });
    setSavingEnabled(true);
    try {
      const response = await fetch('/api/settings/search-providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '保存联网搜索开关失败');
      setConfig((prev) => ({ ...prev, ...payload }));
      toast(enabled ? '联网搜索已启用' : '联网搜索已关闭', 'success');
    } catch (error) {
      patchConfig({ enabled: previousEnabled });
      toast(error.message || '保存联网搜索开关失败', 'error');
    } finally {
      savingEnabledRef.current = false;
      setSavingEnabled(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/settings/search-providers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: config.enabled,
          selected_provider: selectedProvider.id,
          modes: config.modes,
          counts: config.counts,
          api_keys: apiKey.trim() ? { [selectedProvider.id]: apiKey.trim() } : {},
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '保存搜索配置失败');
      setConfig((prev) => ({ ...prev, ...payload }));
      setApiKey('');
      toast('搜索配置已保存', 'success');
    } catch (error) {
      toast(error.message || '保存搜索配置失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ width: '100%', color: '#2D2D2D' }}>
      <div style={{ ...SETTINGS_SURFACE_STYLE, display: 'grid', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #F2F0EA', paddingBottom: 20 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>启用联网搜索</div>
            <div style={{ fontSize: 12, color: '#8A8881', marginTop: 4 }}>开启后聊天输入框可以携带联网搜索参数。</div>
          </div>
          <div style={{ opacity: savingEnabled ? 0.62 : 1 }}>
            <Toggle on={Boolean(config.enabled)} onChange={saveEnabled} />
          </div>
        </div>

        <div style={{ display: 'grid', gap: 24, opacity: config.enabled ? 1 : 0.45, pointerEvents: config.enabled ? 'auto' : 'none' }}>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#4B4944' }}>搜索服务商</div>
            <SegmentedTabs value={selectedProvider.id} onChange={(providerId) => { patchConfig({ selected_provider: providerId }); setApiKey(''); }} ariaLabel="搜索服务商" minWidth={88} options={providers.map((provider) => ({ value: provider.id, label: provider.name }))} />
          </div>

          <div style={{ display: 'grid', gap: 14, border: '1px solid #F2F0EA', background: '#FDFCFB', borderRadius: 14, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#4B4944' }}>调用模式</div>
            <div style={{ display: 'grid', gap: 12 }}>
              {modeOptions.map((mode) => (
                <label key={mode.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    checked={(config.modes?.[selectedProvider.id] || modeOptions[0]?.value) === mode.value}
                    onChange={() => setMode(mode.value)}
                    style={{ marginTop: 2, accentColor: '#D97757' }}
                  />
                  <span style={{ display: 'grid', gap: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{mode.label}</span>
                    <span style={{ fontSize: 12, color: '#8A8881' }}>{mode.description}</span>
                  </span>
                </label>
              ))}
            </div>
            <div style={{ display: 'grid', gap: 8, paddingTop: 14, borderTop: '1px solid rgba(229,227,216,0.6)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, color: '#4B4944' }}>
                <span>每次返回结果数</span>
                <span style={{ color: '#D97757', fontFamily: 'var(--font-mono)', background: 'rgba(251,228,210,0.4)', borderRadius: 6, padding: '2px 8px' }}>{config.counts?.[selectedProvider.id] || 5} 条</span>
              </div>
              <input
                type="range"
                min="1"
                max={selectedProvider.max_limit || 20}
                value={config.counts?.[selectedProvider.id] || 5}
                onChange={(event) => setCount(event.target.value)}
                style={{ width: '100%', accentColor: '#D97757' }}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#4B4944' }}>API Key</div>
            <TextInput
              masked
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={config.api_key_set?.[selectedProvider.id]
                ? '已保存，留空不修改'
                : selectedProvider.requires_api_key === false
                  ? '可选；留空使用 Firecrawl 无 Key 模式'
                  : '请输入该服务商 API Key'}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid #F2F0EA', paddingTop: 16 }}>
            <Button variant="ghost" onClick={() => setApiKey('')}>取消</Button>
            <Button variant="primary" loading={saving} onClick={save}>保存</Button>
          </div>
        </div>
      </div>
    </div>
  );
};

const Logs = ({ agentConversationId: suppliedAgentConversationId = '' }) => {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [agentSessions, setAgentSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [agentLoading, setAgentLoading] = useState(false);
  const [level, setLevel] = useState('');
  const [route, setRoute] = useState('');
  const [requestId, setRequestId] = useState('');
  const agentConversationId = String(suppliedAgentConversationId || router.query.conversation_id || '').trim();

  const formatLogTimestamp = (value) => {
    return formatFullTimestamp(value);
  };

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (level) params.set('level', level);
      if (route.trim()) params.set('route', route.trim());
      if (requestId.trim()) params.set('request_id', requestId.trim());

      const response = await fetch(`/api/logs?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '读取日志失败');
      setItems(payload.items || []);
    } catch (error) {
      toast(error.message || '读取日志失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchAgentLogs = async () => {
    setAgentLoading(true);
    try {
      const params = new URLSearchParams({ limit: '20', logs_limit: '100' });
      if (agentConversationId) params.set('conversation_id', agentConversationId);
      const response = await fetch(`/api/agent/sessions?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '读取 Agent Loop 日志失败');
      setAgentSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
    } catch (error) {
      toast(error.message || '读取 Agent Loop 日志失败', 'error');
    } finally {
      setAgentLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs().catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchAgentLogs().catch(() => {});
  }, [agentConversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ width: '100%' }}>
      <Section title="Agent Loop 执行日志">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            {agentConversationId ? `当前仅显示会话 #${agentConversationId} 的 Agent Loop 记录。` : '查看最近的 Agent Loop 轮次、工具调用、失败摘要和耗时。'}
          </div>
          <Button variant="secondary" loading={agentLoading} onClick={fetchAgentLogs}>刷新 Agent 日志</Button>
        </div>
        <AgentLoopLogList
          sessions={agentSessions}
          loading={agentLoading}
          formatTimestamp={formatLogTimestamp}
        />
      </Section>

      <Section title="筛选">
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
            <DropdownSelect
              value={level}
              options={[
                { value: '', label: '全部级别' },
                { value: 'debug', label: 'debug' },
                { value: 'info', label: 'info' },
                { value: 'warn', label: 'warn' },
                { value: 'error', label: 'error' },
              ]}
              onChange={setLevel}
            />
            <TextInput
              value={route}
              onChange={(event) => setRoute(event.target.value)}
              placeholder="按路由过滤，例如 /api/files/import"
            />
          </div>
          <SearchInput
            value={requestId}
            placeholder="按请求 ID 搜索"
            onChange={(event) => setRequestId(event.target.value)}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <Button
              variant="ghost"
              onClick={() => {
                setLevel('');
                setRoute('');
                setRequestId('');
              }}
            >
              清空筛选
            </Button>
            <Button variant="secondary" loading={loading} onClick={fetchLogs}>刷新日志</Button>
          </div>
        </div>
      </Section>

      <Section title="最近记录">
        {items.length === 0 ? (
          <NoteBox>当前还没有匹配的日志记录。</NoteBox>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {items.map((item, index) => (
              <div
                key={`${item.timestamp}-${item.event}-${index}`}
                style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-lg)',
                  background: 'var(--bg-elevated)',
                  padding: 16,
                  display: 'grid',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <Badge tone={
                      item.level === 'error'
                        ? 'danger'
                        : item.level === 'warn'
                          ? 'warning'
                          : item.level === 'info'
                            ? 'accent'
                            : 'default'
                    }>
                      {item.level}
                    </Badge>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.event}
                    </div>
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                    {formatLogTimestamp(item.timestamp)}
                  </div>
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                  <div>路由：{item.route || '—'}</div>
                  <div>请求 ID：{item.request_id || '—'}</div>
                  {item.file_path ? <div>文件：{item.file_path}</div> : null}
                  {item.message ? <div>消息：{item.message}</div> : null}
                  {item.error ? <div>错误：{item.error}</div> : null}
                  {item.error_code ? <div>错误码：{item.error_code}</div> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
};

const Personalization = ({ onOpenImageSettings }) => {
  const toast = useToast();
  const [titleFilenameBindingEnabled, setTitleFilenameBindingEnabled] = useState(false);
  const [savingTitleFilenameBinding, setSavingTitleFilenameBinding] = useState(false);
  const [defaultEditorOpen, setDefaultEditorOpen] = useState(true);
  const [defaultAgentOpen, setDefaultAgentOpen] = useState(true);
  const [savingWorkspaceDefaults, setSavingWorkspaceDefaults] = useState(false);
  const [imageSettings, setImageSettings] = useState(null);
  const [imageTarget, setImageTarget] = useState('local');
  const [savingImageTarget, setSavingImageTarget] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings')
      .then((response) => response.json())
      .then((settings) => {
        if (cancelled) return;
        setTitleFilenameBindingEnabled(Boolean(settings.editor?.title_filename_binding_enabled));
        setDefaultEditorOpen(settings.editor?.default_editor_open !== false);
        setDefaultAgentOpen(settings.editor?.default_agent_open !== false);
        const currentTarget = settings.images?.storage_mode === 'object_storage'
          ? settings.images?.object_storage?.provider
          : 'local';
        setImageSettings(settings.images || null);
        setImageTarget(IMAGE_STORAGE_OPTIONS.some((item) => item.value === currentTarget) ? currentTarget : 'local');
      })
      .catch(() => toast('读取配置失败', 'error'));
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const handleTitleFilenameBindingToggle = async (nextValue) => {
    if (savingTitleFilenameBinding) return;
    const previousValue = titleFilenameBindingEnabled;
    setTitleFilenameBindingEnabled(nextValue);
    setSavingTitleFilenameBinding(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          editor: {
            title_filename_binding_enabled: nextValue,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存失败');
      setTitleFilenameBindingEnabled(Boolean(payload.editor?.title_filename_binding_enabled));
      toast(nextValue ? '标题与文件名双向绑定已开启' : '标题与文件名双向绑定已关闭', 'success');
    } catch (error) {
      setTitleFilenameBindingEnabled(previousValue);
      toast(error.message || '保存失败', 'error');
    } finally {
      setSavingTitleFilenameBinding(false);
    }
  };

  const isConfiguredImageTarget = (target) => {
    if (target === 'local') return true;
    return Boolean(imageSettings?.provider_configs?.[target]?.configured);
  };

  const handleImageTargetChange = async (target) => {
    if (!isConfiguredImageTarget(target)) {
      const option = IMAGE_STORAGE_OPTIONS.find((item) => item.value === target);
      toast(<span>{option?.label || '该图床'}尚未配置，<a href={`/settings/image-storage?provider=${encodeURIComponent(target)}`} onClick={(event) => { event.preventDefault(); onOpenImageSettings?.(target); }} style={{ color: 'var(--accent)', textDecoration: 'underline' }}>前往图床设置</a></span>, 'warning');
      return;
    }
    setImageTarget(target);
    if (savingImageTarget) return;
    setSavingImageTarget(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: target === 'local'
          ? { storage_mode: 'local' }
          : { storage_mode: 'object_storage', active_provider: target } }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '图片上传位置保存失败');
      setImageSettings(payload.images || null);
      toast(target === 'local' ? '图片将保存到本地资源目录' : '图片上传位置已保存', 'success');
    } catch (error) {
      const restored = imageSettings?.storage_mode === 'object_storage' ? imageSettings?.object_storage?.provider : 'local';
      setImageTarget(restored || 'local');
      toast(error.message || '图片上传位置保存失败', 'error');
    } finally {
      setSavingImageTarget(false);
    }
  };

  const handleWorkspaceDefaultToggle = async (field, nextValue) => {
    if (savingWorkspaceDefaults) return;
    const setter = field === 'default_editor_open' ? setDefaultEditorOpen : setDefaultAgentOpen;
    const previousValue = field === 'default_editor_open' ? defaultEditorOpen : defaultAgentOpen;
    setter(nextValue);
    setSavingWorkspaceDefaults(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editor: { [field]: nextValue } }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存失败');
      setDefaultEditorOpen(payload.editor?.default_editor_open !== false);
      setDefaultAgentOpen(payload.editor?.default_agent_open !== false);
      toast('打开文件时的默认工作区已保存', 'success');
    } catch (error) {
      setter(previousValue);
      toast(error.message || '保存失败', 'error');
    } finally {
      setSavingWorkspaceDefaults(false);
    }
  };

  return (
    <div style={{ width: '100%' }}>
      <section style={{ ...SETTINGS_SURFACE_STYLE, display: 'grid', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, paddingBottom: 20, borderBottom: '1px solid #F2F0EA' }}>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>标题与文件名双向绑定</div>
          <div style={{ flexShrink: 0 }}>
            <Toggle
              on={titleFilenameBindingEnabled}
              onChange={(value) => handleTitleFilenameBindingToggle(value)}
            />
          </div>
        </div>
        <div style={{ display: 'grid', gap: 14, paddingBottom: 20, borderBottom: '1px solid #F2F0EA' }}>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>打开文件时的工作区</div>
            <div style={{ marginTop: 4, fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>从未打开文件的状态进入某篇文件时使用。切换已打开的文件会保留当前面板状态。</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>默认展开富文本编辑器</div>
            <Toggle on={defaultEditorOpen} onChange={(value) => handleWorkspaceDefaultToggle('default_editor_open', value)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>默认展开 AI 聊天面板</div>
            <Toggle on={defaultAgentOpen} onChange={(value) => handleWorkspaceDefaultToggle('default_agent_open', value)} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>图片上传位置</div>
            <div style={{ marginTop: 4, fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>选择已配置的图床后，新图片会使用对应位置保存。</div>
          </div>
          <SegmentedTabs value={imageTarget} onChange={handleImageTargetChange} disabled={savingImageTarget} ariaLabel="图片上传位置" minWidth={84} height={30} responsiveLabels style={{ flexShrink: 1, minWidth: 0, maxWidth: '100%' }} options={IMAGE_STORAGE_OPTIONS} />
        </div>
      </section>
    </div>
  );
};

const IMAGE_STORAGE_OPTIONS = [
  { value: 'local', label: '本地资源目录', compactLabel: '本地' },
  { value: 'cos', label: '腾讯云 COS', compactLabel: '腾讯 COS' },
  { value: 'oss', label: '阿里云 OSS', compactLabel: '阿里 OSS' },
  { value: 'r2', label: 'Cloudflare R2', compactLabel: 'R2' },
];

const CLOUD_IMAGE_STORAGE_OPTIONS = [
  { value: 'oss', label: '阿里云 OSS' },
  { value: 'cos', label: '腾讯云 COS' },
  { value: 'r2', label: 'Cloudflare R2' },
];

function notifySkillsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('notus-skills-changed'));
}

function notifyMcpServersChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('notus-mcp-servers-changed'));
}

const ImageStorageProviderConfig = ({ provider, savedConfig, isActive, onSaved }) => {
  const toast = useToast();
  const [objectStorage, setObjectStorage] = useState({ bucket: '', region: '', endpoint: '', prefix: 'notus/images', publicBaseUrl: '', accessKeyId: '', secretAccessKey: '' });
  const [savedKeys, setSavedKeys] = useState({ accessKeyId: false, secretAccessKey: false });
  const [clearKeys, setClearKeys] = useState({ accessKeyId: false, secretAccessKey: false });
  const [saving, setSaving] = useState(false);
  const savedConfigRef = useRef(null);
  const label = CLOUD_IMAGE_STORAGE_OPTIONS.find((item) => item.value === provider)?.label || provider;

  const applyConfig = useCallback((config = {}) => {
    const nextObjectStorage = {
      bucket: config.bucket || '', region: config.region || '', endpoint: config.endpoint || '', prefix: config.prefix || 'notus/images',
      publicBaseUrl: config.public_base_url || '', accessKeyId: '', secretAccessKey: '',
    };
    const nextSavedKeys = { accessKeyId: Boolean(config.access_key_id_set), secretAccessKey: Boolean(config.secret_access_key_set) };
    savedConfigRef.current = { objectStorage: nextObjectStorage, savedKeys: nextSavedKeys };
    setObjectStorage(nextObjectStorage);
    setSavedKeys(nextSavedKeys);
    setClearKeys({ accessKeyId: false, secretAccessKey: false });
  }, []);

  useEffect(() => { applyConfig(savedConfig); }, [applyConfig, savedConfig]);

  const updateObjectStorage = (field, value) => {
    setObjectStorage((current) => ({ ...current, [field]: value }));
    if (field === 'accessKeyId' || field === 'secretAccessKey') setClearKeys((current) => ({ ...current, [field]: false }));
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: { provider_config: {
          provider, bucket: objectStorage.bucket, region: objectStorage.region,
          ...(provider !== 'cos' ? { endpoint: objectStorage.endpoint } : {}), prefix: objectStorage.prefix,
          public_base_url: objectStorage.publicBaseUrl,
          ...(objectStorage.accessKeyId ? { access_key_id: objectStorage.accessKeyId } : {}),
          ...(objectStorage.secretAccessKey ? { secret_access_key: objectStorage.secretAccessKey } : {}),
          ...(clearKeys.accessKeyId ? { clear_access_key_id: true } : {}),
          ...(clearKeys.secretAccessKey ? { clear_secret_access_key: true } : {}),
        } } }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '图床配置保存失败');
      applyConfig(result.images?.provider_configs?.[provider]);
      onSaved?.(result);
      toast(`${label} 配置已保存`, 'success');
    } catch (error) {
      toast(error.message || '图床配置保存失败', 'error');
    } finally { setSaving(false); }
  };

  const providerHints = {
    cos: 'Bucket 必须包含 AppId，例如 example-1250000000；地域使用 ap-guangzhou 等 COS Region。',
    oss: '地域使用 oss-cn-hangzhou 等 OSS Region；Endpoint 留空时由 SDK 按地域生成。',
    r2: 'Endpoint 使用 https://<ACCOUNT_ID>.r2.cloudflarestorage.com，Region 固定为 auto。',
  };

  const restoreSavedConfig = () => {
    const saved = savedConfigRef.current;
    if (!saved) return;
    setObjectStorage(saved.objectStorage);
    setSavedKeys(saved.savedKeys);
    setClearKeys({ accessKeyId: false, secretAccessKey: false });
  };

  return (
    <section style={{ background: '#fff', border: '1px solid #E5E3D8', borderRadius: 14, padding: 24, display: 'grid', gap: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: '#2D2D2D' }}>{label}</div>
      <div style={{ display: 'grid', gap: 14, border: '1px solid #F2F0EA', background: '#FDFCFB', borderRadius: 14, padding: 16 }}>
        <div style={{ padding: '12px 14px', borderRadius: 10, border: '1px solid rgba(234, 179, 8, 0.26)', background: 'rgba(234, 179, 8, 0.1)', color: '#9A6B08', fontSize: 13, lineHeight: 1.6 }}>{providerHints[provider]}</div>
        <Field label="Bucket 名称"><TextInput value={objectStorage.bucket} onChange={(event) => updateObjectStorage('bucket', event.target.value)} placeholder={provider === 'cos' ? 'example-1250000000' : 'notus-images'} /></Field>
        {provider === 'cos' ? <Field label="地域 Region"><TextInput value={objectStorage.region} onChange={(event) => updateObjectStorage('region', event.target.value)} placeholder="ap-guangzhou" /></Field>
          : provider === 'oss' ? <><Field label="地域 Region"><TextInput value={objectStorage.region} onChange={(event) => updateObjectStorage('region', event.target.value)} placeholder="oss-cn-hangzhou" /></Field><Field label="自定义 Endpoint" hint="可选。使用默认 OSS Endpoint 时留空。"><TextInput value={objectStorage.endpoint} onChange={(event) => updateObjectStorage('endpoint', event.target.value)} placeholder="https://oss-cn-hangzhou.aliyuncs.com" /></Field></>
            : <Field label="S3 Endpoint"><TextInput value={objectStorage.endpoint} onChange={(event) => updateObjectStorage('endpoint', event.target.value)} placeholder="https://<ACCOUNT_ID>.r2.cloudflarestorage.com" /></Field>}
        <Field label="对象前缀" hint="默认 notus/images。新图片按 年/月/内容哈希 写入，不能包含 ..。"><TextInput value={objectStorage.prefix} onChange={(event) => updateObjectStorage('prefix', event.target.value)} placeholder="notus/images" /></Field>
        <Field label="公开访问基础 URL" hint="填写 Bucket 的公开域名或 CDN 域名。该地址会直接写入 Markdown，请勿填写临时签名链接。"><TextInput value={objectStorage.publicBaseUrl} onChange={(event) => updateObjectStorage('publicBaseUrl', event.target.value)} placeholder="https://images.example.com" /></Field>
        <Field label={`Access Key ID${savedKeys.accessKeyId ? '（已保存）' : ''}`} hint="密钥只保存在服务端设置库，读取设置时不会回显。留空会保留已保存的值。"><TextInput masked value={objectStorage.accessKeyId} onChange={(event) => updateObjectStorage('accessKeyId', event.target.value)} placeholder={savedKeys.accessKeyId ? '留空以保留当前密钥' : '填写 Access Key ID'} /></Field>
        <Field label={`Secret Access Key${savedKeys.secretAccessKey ? '（已保存）' : ''}`}><TextInput masked value={objectStorage.secretAccessKey} onChange={(event) => updateObjectStorage('secretAccessKey', event.target.value)} placeholder={savedKeys.secretAccessKey ? '留空以保留当前密钥' : '填写 Secret Access Key'} /></Field>
        {(savedKeys.accessKeyId || savedKeys.secretAccessKey) && (isActive
          ? <div style={{ marginTop: -6, fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>正在使用此图床。请先在个性化页切换上传位置，再清除密钥。</div>
          : <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: -6 }}>
            {savedKeys.accessKeyId && <Button size="sm" variant="ghost" onClick={() => setClearKeys((current) => ({ ...current, accessKeyId: !current.accessKeyId }))}>{clearKeys.accessKeyId ? '将清除 Access Key ID' : '清除 Access Key ID'}</Button>}
            {savedKeys.secretAccessKey && <Button size="sm" variant="ghost" onClick={() => setClearKeys((current) => ({ ...current, secretAccessKey: !current.secretAccessKey }))}>{clearKeys.secretAccessKey ? '将清除 Secret Access Key' : '清除 Secret Access Key'}</Button>}
          </div>)}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid #F2F0EA', paddingTop: 16 }}><Button variant="ghost" onClick={restoreSavedConfig}>取消</Button><Button variant="primary" loading={saving} onClick={handleSave}>保存</Button></div>
    </section>
  );
};

const ImageStorageConfig = () => {
  const toast = useToast();
  const [providerConfigs, setProviderConfigs] = useState({});
  const [activeProvider, setActiveProvider] = useState('');
  const [selectedProvider, setSelectedProvider] = useState(CLOUD_IMAGE_STORAGE_OPTIONS[0].value);

  const applySettings = useCallback((settings, { initializeSelectedProvider = false } = {}) => {
    setProviderConfigs(settings.images?.provider_configs || {});
    const nextActiveProvider = settings.images?.storage_mode === 'object_storage' ? settings.images?.object_storage?.provider || '' : '';
    setActiveProvider(nextActiveProvider);
    if (initializeSelectedProvider) {
      setSelectedProvider(CLOUD_IMAGE_STORAGE_OPTIONS.some((item) => item.value === nextActiveProvider)
        ? nextActiveProvider
        : CLOUD_IMAGE_STORAGE_OPTIONS[0].value);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings').then((response) => response.json()).then((settings) => {
      if (!cancelled) applySettings(settings, { initializeSelectedProvider: true });
    }).catch(() => toast('读取图床配置失败', 'error'));
    return () => { cancelled = true; };
  }, [applySettings, toast]);

  return (
    <div style={{ width: '100%', color: '#2D2D2D' }}>
      <div style={{ display: 'grid', gap: 16 }}>
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#4B4944' }}>图床服务商</div>
          <SegmentedTabs value={selectedProvider} onChange={setSelectedProvider} ariaLabel="图床服务商" minWidth={96} options={CLOUD_IMAGE_STORAGE_OPTIONS.map((provider) => ({ value: provider.value, label: provider.label }))} />
        </div>
        <ImageStorageProviderConfig provider={selectedProvider} savedConfig={providerConfigs[selectedProvider]} isActive={activeProvider === selectedProvider} onSaved={applySettings} />
      </div>
    </div>
  );
};

function getRuntimeLabel(runtimeTarget) {
  if (runtimeTarget === 'electron') return '桌面端';
  if (runtimeTarget === 'lazycat') return '懒猫兼容模式';
  return 'Web';
}

const Storage = () => {
  const toast = useToast();
  const { profile, capabilities } = usePlatform();
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState(0);
  const [indexStatus, setIndexStatus] = useState({ total: 0, indexed: 0, pending: 0, failed: 0 });

  const refreshStatus = async () => {
    const statusResponse = await fetch('/api/index/status');
    const status = await statusResponse.json();
    if (statusResponse.ok) setIndexStatus(status);
  };

  useEffect(() => {
    refreshStatus().catch(() => toast('读取索引状态失败', 'error'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRebuild = async () => {
    setConfirmRebuild(false);
    setRebuilding(true);
    setRebuildProgress(0);
    try {
      const response = await fetch('/api/index/rebuild', { method: 'POST' });
      if (!response.ok || !response.body) throw new Error('索引重建启动失败');
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
          const payload = JSON.parse(line.slice(5));
          if (payload.type === 'progress' && payload.total) {
            setRebuildProgress(Math.round((payload.current / payload.total) * 100));
          }
          if (payload.type === 'done') setRebuildProgress(100);
          if (payload.type === 'error') throw new Error(payload.error);
        });
      }
      await refreshStatus();
      toast('索引重建完成', 'success');
    } catch (error) {
      toast(error.message || '索引重建失败', 'error');
    } finally {
      setRebuilding(false);
    }
  };

  const handleClear = async () => {
    setConfirmClear(false);
    setClearing(true);
    try {
      const response = await fetch('/api/index/clear', { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '清除索引失败');
      await refreshStatus();
      setRebuildProgress(0);
      toast('索引已清除', 'warning');
    } catch (error) {
      toast(error.message || '清除索引失败', 'error');
    } finally {
      setClearing(false);
    }
  };

  const handleOpenDataDirectory = async () => {
    const result = await desktopClient.openDataDirectory();
    if (result?.ok === false && !result.unavailable) {
      toast(result.error || '打开数据目录失败', 'error');
    }
  };

  const handleWipe = async () => {
    setConfirmWipe(false);
    setWiping(true);
    try {
      const result = await desktopClient.clearLocalDataAndQuit();
      if (result?.ok === false) {
        throw new Error(result.error || '清理本机数据失败');
      }
    } catch (error) {
      toast(error.message || '清理本机数据失败', 'error');
      setWiping(false);
      return;
    }
  };

  const notesDir = profile.notesDir || '';
  const dataRoot = profile.dataRoot || '';
  const runtimeLabel = getRuntimeLabel(profile.runtimeTarget);

  return (
    <div style={{ width: '100%' }}>
      <Section title="运行环境">
        <Field label="当前平台">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TextInput value={runtimeLabel} disabled style={{ flex: 1 }} />
            <Badge tone={profile.runtimeTarget === 'electron' ? 'accent' : 'success'}>{profile.storageMode === 'managed' ? '应用内托管' : '目录直连'}</Badge>
          </div>
        </Field>
        <Field label="数据根目录">
          <TextInput value={dataRoot} disabled />
        </Field>
      </Section>
      <Section title="笔记目录">
        <Field label="目录路径">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TextInput value={notesDir} disabled style={{ flex: 1 }} />
            <Badge tone="success">已就绪</Badge>
          </div>
        </Field>
        <NoteBox tone={profile.storageMode === 'managed' ? 'info' : 'success'}>
          {profile.storageMode === 'managed'
            ? '桌面端会把导入的 Markdown、附件、数据库和日志统一存放到应用工作区中，避免散落到其他目录。'
            : '当前环境会直接使用现有目录中的文件，索引和运行时数据仍由 Notus 在本地维护。'}
        </NoteBox>
      </Section>
      <Section title="索引状态">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, fontSize: 'var(--text-sm)' }}>
          <span>
            共 {indexStatus.total} 篇文章，
            {indexStatus.indexed} 已索引，
            {indexStatus.pending} 待处理，
            {indexStatus.failed} 失败
          </span>
          <Badge tone={indexStatus.failed > 0 ? 'warning' : 'success'}>{indexStatus.failed > 0 ? '需处理' : '正常'}</Badge>
        </div>
        {rebuilding && (
          <div style={{ marginBottom: 16 }}>
            <ProgressBar value={rebuildProgress} max={100} label={`重建中… ${rebuildProgress}%`} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <Button variant="secondary" loading={rebuilding} onClick={() => setConfirmRebuild(true)}>重建索引</Button>
          <Button variant="danger" loading={clearing} onClick={() => setConfirmClear(true)}>清除索引</Button>
        </div>
      </Section>
      {capabilities.supportsDesktopShell && (
        <Section title="桌面端操作">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <Button variant="secondary" onClick={handleOpenDataDirectory}>打开数据目录</Button>
            <Button variant="danger" loading={wiping} onClick={() => setConfirmWipe(true)}>清除本机数据并退出</Button>
          </div>
          <NoteBox tone={profile.canAutoPurgeOnUninstall ? 'success' : 'warning'}>
            {profile.canAutoPurgeOnUninstall
              ? '当前平台支持随卸载自动清理应用数据。你也可以先手动清理，再执行卸载。'
              : '当前平台建议先执行“清除本机数据并退出”，再删除应用本体，这样更容易避免残留。'}
          </NoteBox>
        </Section>
      )}

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={handleClear}
        title="清除索引"
        message="此操作将删除所有向量索引数据，知识库查询将不可用，直到重建完成。原始笔记文件不受影响。"
        confirmLabel="清除"
        danger
      />
      <ConfirmDialog
        open={confirmRebuild}
        onClose={() => setConfirmRebuild(false)}
        onConfirm={handleRebuild}
        title="重建索引"
        message="将重新处理所有笔记文件，这可能需要几分钟。期间知识库查询仍可正常使用旧索引。"
        confirmLabel="开始重建"
      />
      <ConfirmDialog
        open={confirmWipe}
        onClose={() => setConfirmWipe(false)}
        onConfirm={handleWipe}
        title="清除本机数据并退出"
        message="此操作会删除 Notus 当前工作区中的笔记副本、附件、数据库、日志和本地会话，然后退出应用。"
        confirmLabel="确认清理"
        danger
      />
    </div>
  );
};

const ShortcutsSettings = () => {
  const toast = useToast();
  const { capabilities } = usePlatform();
  const { shortcutList, updateShortcut, resetShortcuts, displayShortcut, formatShortcutDisplay } = useShortcuts();
  const [drafts, setDrafts] = useState(
    () => Object.fromEntries(Object.values(DEFAULT_SHORTCUTS).map((item) => [item.id, item.combo]))
  );

  useEffect(() => {
    setDrafts(Object.fromEntries(shortcutList.map((item) => [item.id, item.combo])));
  }, [shortcutList]);

  return (
    <div style={{ width: '100%' }}>

      {capabilities.supportsDesktopShell && (
        <Section title="桌面端说明">
          <NoteBox tone="info">
            桌面端另外提供固定系统级快捷键 {displayShortcut('Mod+K')}，用于唤起主窗口并直接打开搜索。
            这个系统级快捷键当前不跟随下面的自定义配置变化。
          </NoteBox>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <Badge tone="accent">macOS：{formatShortcutDisplay('Mod+K', 'mac')}</Badge>
            <Badge tone="success">Windows / Linux：{formatShortcutDisplay('Mod+K', 'default')}</Badge>
          </div>
        </Section>
      )}

      <Section title="常用操作">
        <div style={{ display: 'grid', gap: 12 }}>
          {shortcutList.map((item) => (
            <div
              key={item.id}
              style={{
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-lg)',
                background: 'var(--bg-elevated)',
                padding: 16,
                display: 'grid',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{item.label}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 4 }}>
                    {item.scope} · {item.description}
                  </div>
                </div>
                <Badge tone="accent">{item.scope}</Badge>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <TextInput
                  value={drafts[item.id] || ''}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setDrafts((prev) => ({ ...prev, [item.id]: nextValue }));
                  }}
                  onBlur={() => {
                    const nextCombo = normalizeShortcut(drafts[item.id]);
                    updateShortcut(item.id, nextCombo);
                    setDrafts((prev) => ({ ...prev, [item.id]: nextCombo }));
                  }}
                  placeholder="例如：Mod+K"
                  style={{ flex: 1 }}
                />
                <Button
                  variant="secondary"
                  onClick={() => {
                    const nextCombo = normalizeShortcut(drafts[item.id]);
                    updateShortcut(item.id, nextCombo);
                    setDrafts((prev) => ({ ...prev, [item.id]: nextCombo }));
                    toast(`${item.label} 已更新`, 'success');
                  }}
                >
                  保存
                </Button>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Badge tone="accent">macOS：{formatShortcutDisplay(drafts[item.id] || item.combo, 'mac')}</Badge>
                <Badge tone="success">Windows / Linux：{formatShortcutDisplay(drafts[item.id] || item.combo, 'default')}</Badge>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="填写规则">
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          <p>推荐格式：`Mod+K`、`Mod+Enter`、`Shift+Mod+K`、`Escape`。</p>
          <p>`Mod` 会自动兼容 macOS 的 `Command` 和 Windows/Linux 的 `Ctrl`。</p>
        </div>
      </Section>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <Button
          variant="ghost"
          onClick={() => {
            resetShortcuts();
            setDrafts(Object.fromEntries(Object.values(DEFAULT_SHORTCUTS).map((item) => [item.id, item.combo])));
            toast('已恢复默认快捷键', 'success');
          }}
        >
          恢复默认
        </Button>
        <Badge tone="success">当前配置保存在本地浏览器</Badge>
      </div>
    </div>
  );
};

const SkillsSettings = () => {
  const toast = useToast();
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [gitInstallOpen, setGitInstallOpen] = useState(false);
  const [zipInstallOpen, setZipInstallOpen] = useState(false);
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [zipFile, setZipFile] = useState(null);
  const [zipDragging, setZipDragging] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updatingId, setUpdatingId] = useState('');
  const [zipReplaceExisting, setZipReplaceExisting] = useState(false);
  const zipInputRef = useRef(null);
  const zipDragCounterRef = useRef(0);

  const load = useCallback(async () => {
    const response = await fetch('/api/skills', { cache: 'no-store' });
    const payload = await readJsonResponse(response, { fallbackMessage: '读取 Skills 失败' });
    const listed = Array.isArray(payload.skills) ? payload.skills : [];
    const updateStates = await Promise.all(listed.map(async (skill) => {
      if (!skill.can_update) return [String(skill.id), false];
      try {
        const check = await fetch(`/api/skills/${encodeURIComponent(skill.id)}/update`, { cache: 'no-store' });
        const result = await readJsonResponse(check, { fallbackMessage: '检查 Skill 更新失败' });
        return [String(skill.id), Boolean(result.can_update)];
      } catch {
        return [String(skill.id), false];
      }
    }));
    const canUpdateById = new Map(updateStates);
    setSkills(listed.map((skill) => ({ ...skill, can_update: Boolean(canUpdateById.get(String(skill.id))) })));
  }, []);

  useEffect(() => {
    load().catch((error) => toast(error.message || '读取 Skills 失败', 'error')).finally(() => setLoading(false));
  }, [load, toast]);

  const rescan = async () => {
    setScanning(true);
    try {
      const response = await fetch('/api/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rescan' }) });
      const payload = await readJsonResponse(response, { fallbackMessage: '扫描 Skills 失败' });
      setSkills(Array.isArray(payload.skills) ? payload.skills : []);
      await load();
      notifySkillsChanged();
      toast('已完成本机 Skill 扫描', 'success');
    } catch (error) { toast(error.message || '扫描 Skills 失败', 'error'); } finally { setScanning(false); }
  };

  const toggleSkill = async (skill, enabled) => {
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}/state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
      const payload = await readJsonResponse(response, { fallbackMessage: '更新 Skill 状态失败' });
      setSkills((current) => current.map((item) => String(item.id) === String(skill.id) ? payload.skill : item));
      notifySkillsChanged();
    } catch (error) { toast(error.message || '更新 Skill 状态失败', 'error'); }
  };

  const installFromGit = async () => {
    if (!repositoryUrl.trim()) { toast('请填写 HTTPS Git 仓库地址', 'warning'); return; }
    setInstalling(true);
    try {
      const response = await fetch('/api/skills/install/git', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryUrl, conflictPolicy: 'reject' }) });
      const payload = await readJsonResponse(response, { fallbackMessage: '安装 Skill 失败' });
      setGitInstallOpen(false); setRepositoryUrl('');
      await load();
      notifySkillsChanged();
      toast(`已安装 ${payload.skills?.length || 0} 个 Skill`, 'success');
    } catch (error) { toast(error.message || '安装 Skill 失败', 'error'); } finally { setInstalling(false); }
  };

  const selectZipFile = (files) => {
    const file = Array.from(files || [])[0];
    if (!file) return;
    if (!/\.zip$/i.test(file.name || '')) { toast('请选择 .zip 格式的 Skill 压缩包', 'warning'); return; }
    if (file.size > 100 * 1024 * 1024) { toast('ZIP 文件不能超过 100 MiB', 'warning'); return; }
    setZipFile(file);
  };

  const closeZipInstall = () => {
    if (installing) return;
    zipDragCounterRef.current = 0;
    setZipDragging(false);
    setZipFile(null);
    setZipReplaceExisting(false);
    setZipInstallOpen(false);
  };

  const updateSkill = async (skill) => {
    setUpdatingId(String(skill.id));
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}/update`, { method: 'POST' });
      await readJsonResponse(response, { fallbackMessage: '更新 Skill 失败' });
      await load();
      notifySkillsChanged();
      toast(`已更新 ${skill.name}`, 'success');
    } catch (error) { toast(error.message || '更新 Skill 失败', 'error'); } finally { setUpdatingId(''); }
  };

  const installFromZip = async () => {
    if (!zipFile) { toast('请选择 ZIP 文件', 'warning'); return; }
    setInstalling(true);
    try {
      const form = new FormData();
      form.append('file', zipFile, zipFile.name);
      form.append('conflictPolicy', zipReplaceExisting ? 'replace' : 'reject');
      const response = await fetch('/api/skills/install/zip', { method: 'POST', body: form });
      const payload = await readJsonResponse(response, { fallbackMessage: '导入 Skill 失败' });
      zipDragCounterRef.current = 0;
      setZipDragging(false);
      setZipFile(null);
      setZipReplaceExisting(false);
      setZipInstallOpen(false);
      await load();
      notifySkillsChanged();
      toast(`已导入 ${payload.skills?.length || 0} 个 Skill`, 'success');
    } catch (error) { toast(error.message || '导入 Skill 失败', 'error'); } finally { setInstalling(false); }
  };

  const formatZipFileSize = (bytes) => {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MiB`;
  };

  return (
    <div style={{ width: '100%', color: '#2D2D2D' }}>
      <div style={{ display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="ghost" loading={scanning} onClick={rescan}><Icons.refresh size={14} />重新扫描</Button>
          <Button variant="secondary" onClick={() => setZipInstallOpen(true)}><Icons.upload size={14} />导入 ZIP</Button>
          <Button variant="primary" onClick={() => setGitInstallOpen(true)}><Icons.download size={14} />从 Git 安装</Button>
        </div>
        <section style={{ ...SETTINGS_SURFACE_STYLE, display: 'grid', gap: 8, padding: 14 }}>
          <div style={{ display: 'grid', gap: 8 }}>
            {skills.map((skill) => (
              <div key={skill.id} style={{ ...SETTINGS_RESOURCE_ROW_STYLE, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0, flex: '1 1 340px' }}>
                  <div style={SETTINGS_RESOURCE_ICON_STYLE}><Icons.skill size={17} /></div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}><span>{skill.name}</span></div>
                    <div style={{ marginTop: 4, color: '#6B6963', fontSize: 12, lineHeight: 1.55 }}>{skill.description || '未提供描述'}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {skill.can_update ? <Button variant="ghost" loading={updatingId === String(skill.id)} disabled={Boolean(updatingId)} onClick={() => updateSkill(skill)}><Icons.refresh size={14} />更新</Button> : null}
                  <Toggle on={Boolean(skill.enabled)} disabled={skill.status !== 'valid'} onChange={(enabled) => toggleSkill(skill, enabled)} />
                </div>
              </div>
            ))}
            {!loading && skills.length === 0 ? <div style={{ padding: '24px 16px', border: '1px dashed #D9D5CA', borderRadius: 12, color: '#8A8881', fontSize: 13, textAlign: 'center' }}>尚未发现可用 Skill</div> : null}
          </div>
        </section>
      </div>
      <Dialog open={gitInstallOpen} onClose={() => !installing && setGitInstallOpen(false)} closeOnBackdrop={false} title="从 Git 安装 Skill" maxWidth={520} footer={<><Button variant="ghost" disabled={installing} onClick={() => setGitInstallOpen(false)}>取消</Button><Button variant="primary" loading={installing} onClick={installFromGit}>安装</Button></>}><div style={{ display: 'grid', gap: 16 }}><Field label="HTTPS 仓库地址" hint="将依次尝试 main 和 master 分支；仓库根目录必须包含 SKILL.md。"><TextInput value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/org/skill.git" /></Field></div></Dialog>
      <Dialog
        open={zipInstallOpen}
        onClose={closeZipInstall}
        closeOnBackdrop={false}
        title="导入 ZIP Skill"
        maxWidth={560}
        footer={<><Button variant="ghost" disabled={installing} onClick={closeZipInstall}>取消</Button><Button variant="primary" loading={installing} onClick={installFromZip}>导入 Skill</Button></>}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <input ref={zipInputRef} type="file" accept=".zip,application/zip,application/x-zip-compressed" style={{ display: 'none' }} onChange={(event) => { selectZipFile(event.target.files); event.target.value = ''; }} />
          <div
            role="button"
            tabIndex={installing ? -1 : 0}
            aria-label="上传 ZIP Skill 压缩包"
            onClick={() => { if (!installing) zipInputRef.current?.click(); }}
            onKeyDown={(event) => { if (!installing && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); zipInputRef.current?.click(); } }}
            onDragEnter={(event) => { event.preventDefault(); if (!installing) { zipDragCounterRef.current += 1; setZipDragging(true); } }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { event.preventDefault(); zipDragCounterRef.current = Math.max(0, zipDragCounterRef.current - 1); if (zipDragCounterRef.current === 0) setZipDragging(false); }}
            onDrop={(event) => { event.preventDefault(); zipDragCounterRef.current = 0; setZipDragging(false); if (!installing) selectZipFile(event.dataTransfer.files); }}
            style={{
              display: 'grid',
              justifyItems: 'center',
              gap: 8,
              padding: '24px 18px',
              borderRadius: 12,
              border: `2px dashed ${zipDragging ? 'var(--accent)' : '#D9D5CA'}`,
              background: zipDragging ? 'var(--accent-subtle)' : '#FDFCFB',
              textAlign: 'center',
              cursor: installing ? 'not-allowed' : 'pointer',
              transition: 'border-color var(--transition-fast), background var(--transition-fast)',
            }}
          >
            <span style={{ color: zipDragging ? 'var(--accent)' : '#BE6247', display: 'inline-flex' }}><Icons.upload size={28} /></span>
            {zipFile ? <><div style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 700 }}>{zipFile.name}</div><div style={{ color: '#8A8881', fontSize: 12 }}>{formatZipFileSize(zipFile.size)}</div></> : <><div style={{ fontSize: 14, fontWeight: 700 }}>拖入 ZIP 文件或点击上传</div><div style={{ color: '#8A8881', fontSize: 12 }}>最大 100 MiB</div></>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div><div style={{ fontSize: 13, fontWeight: 600 }}>覆盖同名受管 Skill</div><div style={{ marginTop: 3, color: '#8A8881', fontSize: 12, lineHeight: 1.5 }}>开启后会替换压缩包中同名的 Notus 管理 Skill。</div></div>
            <Toggle on={zipReplaceExisting} disabled={installing} onChange={setZipReplaceExisting} />
          </div>
        </div>
      </Dialog>
    </div>
  );
};

const ExternalMcpAccess = () => {
  const toast = useToast();
  const [tokens, setTokens] = useState([]);
  const [changes, setChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null);
  const [rawToken, setRawToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [detailChange, setDetailChange] = useState(null);
  const endpoint = typeof window === 'undefined' ? '/api/mcp' : `${window.location.origin}/api/mcp`;
  const emptyDraft = { name: '', enabled: true, approval_mode: 'manual', permissions: EXTERNAL_MCP_DEFAULT_PERMISSIONS };

  const load = useCallback(async () => {
    const [tokensResponse, changesResponse] = await Promise.all([
      fetch('/api/settings/mcp/tokens', { cache: 'no-store' }),
      fetch('/api/settings/mcp/changes?status=pending,conflict', { cache: 'no-store' }),
    ]);
    const [tokenPayload, changePayload] = await Promise.all([
      readJsonResponse(tokensResponse, { fallbackMessage: '读取 MCP Token 失败' }),
      readJsonResponse(changesResponse, { fallbackMessage: '读取待确认变更失败' }),
    ]);
    setTokens(Array.isArray(tokenPayload.tokens) ? tokenPayload.tokens : []);
    setChanges(Array.isArray(changePayload.changes) ? changePayload.changes : []);
  }, []);

  useEffect(() => { load().catch((cause) => toast(cause.message || '读取外部 MCP 配置失败', 'error')).finally(() => setLoading(false)); }, [load, toast]);

  const copy = async (value, successMessage) => {
    try { await navigator.clipboard.writeText(value); toast(successMessage, 'success'); } catch { toast('复制失败，请手动复制', 'warning'); }
  };
  const togglePermission = (permission, enabled) => setDraft((current) => ({
    ...current,
    permissions: enabled ? [...new Set([...(current.permissions || []), permission])] : (current.permissions || []).filter((item) => item !== permission),
  }));
  const save = async () => {
    if (!draft?.name?.trim()) { toast('请填写 MCP Token 名称', 'warning'); return; }
    setSaving(true);
    try {
      const response = await fetch(draft.id ? `/api/settings/mcp/tokens/${encodeURIComponent(draft.id)}` : '/api/settings/mcp/tokens', {
        method: draft.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: draft.name, enabled: Boolean(draft.enabled), approval_mode: draft.approval_mode, permissions: draft.permissions || [] }),
      });
      const payload = await readJsonResponse(response, { fallbackMessage: '保存 MCP Token 失败' });
      setDraft(null);
      if (payload.raw_token) setRawToken(payload.raw_token);
      await load();
      toast('MCP Token 已保存', 'success');
    } catch (cause) { toast(cause.message || '保存 MCP Token 失败', 'error'); } finally { setSaving(false); }
  };
  const rotate = async (token) => {
    if (!window.confirm(`重新生成“${token.name}”的 Token？旧 Token 会立即失效。`)) return;
    try {
      const response = await fetch(`/api/settings/mcp/tokens/${encodeURIComponent(token.id)}/rotate`, { method: 'POST' });
      const payload = await readJsonResponse(response, { fallbackMessage: '重新生成 MCP Token 失败' });
      setRawToken(payload.raw_token || '');
      await load();
    } catch (cause) { toast(cause.message || '重新生成 MCP Token 失败', 'error'); }
  };
  const remove = async (token) => {
    if (!window.confirm(`删除 MCP Token“${token.name}”？外部 Agent 将立即无法继续调用。`)) return;
    try { const response = await fetch(`/api/settings/mcp/tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' }); await readJsonResponse(response, { fallbackMessage: '删除 MCP Token 失败' }); await load(); toast('MCP Token 已删除', 'success'); } catch (cause) { toast(cause.message || '删除 MCP Token 失败', 'error'); }
  };
  const applyChange = async () => {
    if (!detailChange) return;
    try { const response = await fetch(`/api/settings/mcp/changes/${encodeURIComponent(detailChange.id)}/apply`, { method: 'POST' }); const payload = await readJsonResponse(response, { fallbackMessage: '应用文件变更失败' }); setDetailChange(payload.change || null); await load(); toast('文件变更已应用', 'success'); } catch (cause) { toast(cause.message || '应用文件变更失败', 'error'); await load(); }
  };
  const rejectChange = async () => {
    if (!detailChange) return;
    try { const response = await fetch(`/api/settings/mcp/changes/${encodeURIComponent(detailChange.id)}/reject`, { method: 'POST' }); const payload = await readJsonResponse(response, { fallbackMessage: '拒绝文件变更失败' }); setDetailChange(payload.change || null); await load(); toast('已拒绝该文件变更', 'success'); } catch (cause) { toast(cause.message || '拒绝文件变更失败', 'error'); }
  };
  const changeOperationSet = detailChange ? {
    id: detailChange.id,
    status: detailChange.status,
    patches: [{
      id: detailChange.id,
      file_path: detailChange.payload?.path || detailChange.path,
      old_path: detailChange.payload?.path || '',
      new_path: detailChange.payload?.new_path || '',
      old: detailChange.payload?.before || '',
      new: detailChange.payload?.after ?? detailChange.payload?.content ?? '',
      change_type: detailChange.tool_name === 'create_note' ? 'create' : ['move_note', 'rename_note'].includes(detailChange.tool_name) ? 'move_file' : 'modify',
      status: detailChange.status,
      error: detailChange.error_message || '',
    }],
  } : null;

  return <>
    <section style={{ ...SETTINGS_SURFACE_STYLE, display: 'grid', gap: 16, padding: 18 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
          <div style={SETTINGS_RESOURCE_ICON_STYLE}><Icons.mcp size={17} /></div>
          <div><div style={{ fontSize: 14, fontWeight: 700 }}>供外部 Agent 调用</div><div style={{ marginTop: 3, color: '#6B6963', fontSize: 12, lineHeight: 1.55 }}>使用 Streamable HTTP 和独立 MCP Token；删除与联网搜索不会对外开放。</div></div>
        </div>
        <Button variant="primary" onClick={() => setDraft({ ...emptyDraft })}><Icons.plus size={14} />创建 Token</Button>
      </div>
      <div style={{ display: 'flex', gap: 8, minWidth: 0, alignItems: 'center', padding: '9px 10px', borderRadius: 10, background: '#FDFCFB', border: '1px solid #ECE9DF' }}>
        <code style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#6B6963', fontSize: 12 }}>{endpoint}</code>
        <Button size="sm" variant="ghost" onClick={() => copy(endpoint, 'MCP 地址已复制')}><Icons.copy size={13} />复制</Button>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {tokens.map((token) => <div key={token.id} style={{ ...SETTINGS_RESOURCE_ROW_STYLE, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: '1 1 300px' }}><div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', fontSize: 14, fontWeight: 700 }}><span>{token.name}</span><Badge tone={token.enabled ? 'success' : 'default'}>{token.enabled ? '已启用' : '已停用'}</Badge><Badge tone="default">{token.approval_mode === 'auto' ? '自动应用' : '手动确认'}</Badge></div><div style={{ marginTop: 4, color: '#8A8881', fontSize: 12 }}>{token.permissions?.length || 0} 项工具已授权{token.last_used_at ? ' · 最近已使用' : ''}</div></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><Button size="sm" variant="ghost" onClick={() => setDraft({ ...token, permissions: token.permissions || [] })}>编辑</Button><Button size="sm" variant="ghost" onClick={() => rotate(token)}>重新生成</Button><Button size="sm" variant="ghost" onClick={() => remove(token)}>删除</Button></div>
        </div>)}
        {!loading && tokens.length === 0 ? <div style={{ padding: '18px 12px', border: '1px dashed #D9D5CA', borderRadius: 12, color: '#8A8881', fontSize: 13, textAlign: 'center' }}>尚未创建外部 MCP Token</div> : null}
      </div>
    </section>
    <section style={{ ...SETTINGS_SURFACE_STYLE, display: 'grid', gap: 12, padding: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><div><div style={{ fontSize: 14, fontWeight: 700 }}>待确认变更</div><div style={{ marginTop: 3, color: '#8A8881', fontSize: 12 }}>来自手动确认 Token 的文件写入请求。</div></div><Badge tone={changes.length ? 'default' : 'success'}>{changes.length ? `${changes.length} 项待处理` : '暂无待处理'}</Badge></div>
      {changes.map((change) => <div key={change.id} style={{ ...SETTINGS_RESOURCE_ROW_STYLE, flexWrap: 'wrap' }}><div style={{ minWidth: 0, flex: '1 1 300px' }}><div style={{ fontSize: 13, fontWeight: 700 }}>{change.token_name} · {change.tool_name}</div><div style={{ marginTop: 4, color: change.status === 'conflict' ? 'var(--danger)' : '#8A8881', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{change.status === 'conflict' ? change.error_message || '文件已变化' : change.path || '文件变更'}</div></div><Button size="sm" variant="ghost" onClick={() => setDetailChange(change)}>查看 Diff</Button></div>)}
      {!loading && changes.length === 0 ? <div style={{ color: '#8A8881', fontSize: 12 }}>手动确认 Token 生成的变更会显示在这里。</div> : null}
    </section>
    <Dialog open={Boolean(draft)} onClose={() => !saving && setDraft(null)} closeOnBackdrop={false} title={draft?.id ? '编辑 MCP Token' : '创建 MCP Token'} maxWidth={620} footer={<><Button variant="ghost" disabled={saving} onClick={() => setDraft(null)}>取消</Button><Button variant="primary" loading={saving} onClick={save}>{draft?.id ? '保存' : '创建'}</Button></>}>
      {draft ? <div style={{ display: 'grid', gap: 16 }}><Field label="名称"><TextInput value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：桌面自动化 Agent" /></Field><Field label="应用模式" hint="自动应用仍会校验文件哈希和局部替换内容；手动确认会先进入本页待确认变更。"><SegmentedTabs value={draft.approval_mode} onChange={(approval_mode) => setDraft((current) => ({ ...current, approval_mode, permissions: approval_mode === 'auto' ? (current.permissions || []).filter((permission) => permission !== 'get_change_status') : current.permissions }))} options={[{ value: 'manual', label: '手动确认' }, { value: 'auto', label: '自动应用' }]} /></Field>{[...EXTERNAL_MCP_PERMISSION_GROUPS, ...(draft.approval_mode === 'manual' ? [EXTERNAL_MCP_MANUAL_PERMISSION_GROUP] : [])].map((group) => <div key={group.title} style={{ display: 'grid', gap: 9 }}><div style={{ fontSize: 13, fontWeight: 700 }}>{group.title}</div>{group.items.map(([permission, label]) => <div key={permission} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><span style={{ fontSize: 13, color: '#4D4A45' }}>{label}</span><Toggle on={(draft.permissions || []).includes(permission)} onChange={(enabled) => togglePermission(permission, enabled)} /></div>)}</div>)}<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><span style={{ fontSize: 13, fontWeight: 600 }}>启用此 Token</span><Toggle on={Boolean(draft.enabled)} onChange={(enabled) => setDraft({ ...draft, enabled })} /></div></div> : null}
    </Dialog>
    <Dialog open={Boolean(rawToken)} onClose={() => setRawToken('')} closeOnBackdrop={false} title="请立即保存 MCP Token" maxWidth={620} footer={<Button variant="primary" onClick={() => setRawToken('')}>我已保存</Button>}><div style={{ display: 'grid', gap: 12 }}><NoteBox tone="warning">Token 只会显示这一次。关闭后无法再次查看，只能重新生成。</NoteBox><div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}><TextInput value={rawToken} readOnly onFocus={(event) => event.target.select()} style={{ paddingRight: 42, fontFamily: 'var(--font-mono)' }} /><Tooltip content="复制 Token"><button type="button" aria-label="复制 Token" onClick={() => copy(rawToken, 'MCP Token 已复制')} style={{ position: 'absolute', right: 8, width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)', border: 'none', background: 'transparent', borderRadius: 'var(--radius-sm)', cursor: 'pointer', transition: 'color var(--transition-fast)' }} onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--text-secondary)'; }} onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--text-tertiary)'; }}><Icons.copy size={14} /></button></Tooltip></div></div></Dialog>
    <FileOperationDiffDialog operationSet={changeOperationSet} open={Boolean(detailChange)} onClose={() => setDetailChange(null)} onApplyAll={applyChange} onApplyFile={applyChange} onDiscardFile={rejectChange} allowDiscardPending discardLabel="拒绝变更" />
  </>;
};

const McpSettings = () => {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('connected');
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState(null);
  const [draft, setDraft] = useState(null);
  const [testingId, setTestingId] = useState('');
  const empty = { name: '', transport: 'streamable_http', enabled: true, url: '', allowLocalHttp: false, headers: [], command: '', args: '', cwd: '' };
  const load = useCallback(async () => { const response = await fetch('/api/settings/mcp/servers', { cache: 'no-store' }); const payload = await readJsonResponse(response, { fallbackMessage: '读取 MCP Server 失败' }); setServers(Array.isArray(payload.servers) ? payload.servers : []); }, []);
  useEffect(() => { Promise.all([load(), fetch('/api/runtime/capabilities', { cache: 'no-store' }).then((response) => readJsonResponse(response, { fallbackMessage: '读取运行环境能力失败' }))]).then(([, payload]) => setCapabilities(payload)).catch((error) => toast(error.message || '读取 MCP Server 失败', 'error')).finally(() => setLoading(false)); }, [load, toast]);
  const edit = (server = null) => setDraft(server ? { id: server.id, name: server.name, transport: server.transport, enabled: server.enabled, url: server.config?.http?.url || '', allowLocalHttp: Boolean(server.config?.http?.allow_local_http), headers: (server.config?.http?.headers || []).map((header) => ({ name: header.name || '', value: header.value || '', secret: Boolean(header.secret || header.secretId), secretId: header.secretId || '', configured: Boolean(header.configured || header.secretId || header.value) })), command: server.config?.stdio?.command || '', args: (server.config?.stdio?.args || []).join(' '), cwd: server.config?.stdio?.cwd || '' } : { ...empty, transport: capabilities?.mcp?.stdio ? 'stdio' : 'streamable_http' });
  const save = async () => {
    if (!draft?.name?.trim()) { toast('请填写 MCP Server 名称', 'warning'); return; }
    const args = String(draft.args || '').match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, '')) || [];
    const headers = (draft.headers || []).map((header) => ({ name: String(header.name || '').trim(), value: String(header.value || ''), secret: true, secretId: String(header.secretId || '') })).filter((header) => header.name);
    const body = { name: draft.name, transport: draft.transport, enabled: Boolean(draft.enabled), ...(draft.transport === 'stdio' ? { stdio: { command: draft.command, args, cwd: draft.cwd } } : { http: { url: draft.url, allowLocalHttp: Boolean(draft.allowLocalHttp), headers } }) };
    try { const response = await fetch(draft.id ? `/api/settings/mcp/servers/${encodeURIComponent(draft.id)}` : '/api/settings/mcp/servers', { method: draft.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await readJsonResponse(response, { fallbackMessage: '保存 MCP Server 失败' }); setDraft(null); await load(); notifyMcpServersChanged(); toast('MCP Server 已保存', 'success'); } catch (error) { toast(error.message || '保存 MCP Server 失败', 'error'); }
  };
  const test = async (server) => { setTestingId(server.id); try { const response = await fetch(`/api/settings/mcp/servers/${encodeURIComponent(server.id)}/test`, { method: 'POST' }); const result = await readJsonResponse(response, { fallbackMessage: 'MCP 连接测试失败' }); toast(`连接成功，发现 ${result.tool_count || 0} 个工具`, 'success'); await load(); } catch (error) { toast(error.message || 'MCP 连接测试失败', 'error'); } finally { setTestingId(''); } };
  const remove = async (server) => { if (!window.confirm(`删除 MCP Server“${server.name}”？`)) return; try { const response = await fetch(`/api/settings/mcp/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' }); await readJsonResponse(response, { fallbackMessage: '删除 MCP Server 失败' }); await load(); notifyMcpServersChanged(); toast('MCP Server 已删除', 'success'); } catch (error) { toast(error.message || '删除 MCP Server 失败', 'error'); } };
  const updateHeader = (index, changes) => setDraft((current) => ({ ...current, headers: (current.headers || []).map((header, headerIndex) => headerIndex === index ? { ...header, ...changes } : header) }));
  const addHeader = () => setDraft((current) => ({ ...current, headers: [...(current.headers || []), { name: '', value: '', secret: true, secretId: '', configured: false }] }));
  const removeHeader = (index) => setDraft((current) => ({ ...current, headers: (current.headers || []).filter((_, headerIndex) => headerIndex !== index) }));
  const supportsStdio = Boolean(capabilities?.mcp?.stdio);
  const transportOptions = [
    ...(supportsStdio ? [{ value: 'stdio', label: 'stdio' }] : []),
    { value: 'streamable_http', label: 'Streamable HTTP' },
  ];
  return (
    <div style={{ width: '100%', color: '#2D2D2D' }}>
      <div style={{ display: 'grid', gap: 16 }}>
        <SegmentedTabs value={activeTab} onChange={setActiveTab} style={{ justifySelf: 'start' }} options={[{ value: 'connected', label: '调用 MCP' }, { value: 'external', label: 'MCP 服务' }]} />
        {activeTab === 'external' ? <ExternalMcpAccess /> : <>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            {capabilities ? <Button variant="primary" onClick={() => edit()}><Icons.plus size={14} />添加 Server</Button> : null}
          </div>
          <section style={{ ...SETTINGS_SURFACE_STYLE, display: 'grid', gap: 8, padding: 14 }}>
            <div style={{ display: 'grid', gap: 8 }}>
              {servers.map((server) => (
                <div key={server.id} style={{ ...SETTINGS_RESOURCE_ROW_STYLE, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0, flex: '1 1 330px' }}>
                    <div style={SETTINGS_RESOURCE_ICON_STYLE}><Icons.mcp size={17} /></div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap', fontSize: 14, fontWeight: 700 }}><span>{server.name}</span><Badge tone={server.enabled ? 'success' : 'default'}>{server.enabled ? '已启用' : '已停用'}</Badge></div>
                      <div style={{ marginTop: 4, fontSize: 12, color: '#8A8881', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{server.transport === 'stdio' ? `stdio · ${server.config?.stdio?.command || ''}` : `Streamable HTTP · ${server.config?.http?.url || ''}`}</div>
                      {server.last_error_message ? <div style={{ marginTop: 4, fontSize: 11, color: 'var(--danger)' }}>{server.last_error_message}</div> : null}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button size="sm" variant="ghost" loading={testingId === server.id} onClick={() => test(server)}>测试</Button>
                    <Button size="sm" variant="ghost" onClick={() => edit(server)}>编辑</Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(server)}>删除</Button>
                  </div>
                </div>
              ))}
              {!loading && servers.length === 0 ? <div style={{ padding: '24px 16px', border: '1px dashed #D9D5CA', borderRadius: 12, color: '#8A8881', fontSize: 13, textAlign: 'center' }}>尚未添加 MCP Server</div> : null}
            </div>
          </section>
        </>}
      </div>
      <Dialog open={Boolean(draft)} onClose={() => setDraft(null)} closeOnBackdrop={false} title={draft?.id ? '编辑 MCP Server' : '添加 MCP Server'} maxWidth={560} footer={<><Button variant="ghost" onClick={() => setDraft(null)}>取消</Button><Button variant="primary" onClick={save}>保存</Button></>}>
        {draft ? <div style={{ display: 'grid', gap: 16 }}>
          <Field label="名称"><TextInput value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：本地文件工具" /></Field>
          {supportsStdio ? <Field label="传输方式"><SegmentedTabs value={draft.transport} onChange={(transport) => setDraft({ ...draft, transport })} options={transportOptions} /></Field> : null}
          {draft.transport === 'stdio' ? <><Field label="命令"><TextInput value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></Field><Field label="参数" hint="用空格分隔；带空格的参数可用双引号。"><TextInput value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem /path" /></Field><Field label="工作目录" hint="可选，必须为绝对路径。"><TextInput value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} placeholder="/Users/name/project" /></Field></> : <><Field label="URL"><TextInput value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></Field><Field label="本机 HTTP 地址" hint="仅在本机运行的 MCP 使用 http 时打开；只允许 localhost、127.0.0.1 或 ::1。"><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 32 }}><span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>允许连接本机回环地址</span><Toggle on={Boolean(draft.allowLocalHttp)} onChange={(allowLocalHttp) => setDraft({ ...draft, allowLocalHttp })} /></div></Field><Field label="请求 Header" hint="认证值以密钥保存，编辑已有认证项时留空即可保留原值；列表和任务日志不会显示认证值。"><div style={{ display: 'grid', gap: 8 }}>{(draft.headers || []).map((header, index) => <div key={`${header.secretId || 'new'}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}><div style={{ flex: '1 1 130px', minWidth: 0 }}><TextInput aria-label={`Header 名称 ${index + 1}`} value={header.name} onChange={(event) => updateHeader(index, { name: event.target.value })} placeholder="Header 名称" /></div><div style={{ flex: '1 1 180px', minWidth: 0 }}><TextInput aria-label={`Header 值 ${index + 1}`} masked value={header.value} onChange={(event) => updateHeader(index, { value: event.target.value, configured: Boolean(event.target.value) || header.configured })} placeholder={header.configured ? '已保存，留空不修改' : 'Header 值'} /></div><Button size="sm" variant="ghost" aria-label={`删除 Header ${index + 1}`} onClick={() => removeHeader(index)}>删除</Button></div>)}<div><Button size="sm" variant="secondary" onClick={addHeader}><Icons.plus size={13} />添加 Header</Button></div></div></Field></>}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><span style={{ fontSize: 13, fontWeight: 600 }}>启用此 Server</span><Toggle on={Boolean(draft.enabled)} onChange={(enabled) => setDraft({ ...draft, enabled })} /></div>
        </div> : null}
      </Dialog>
    </div>
  );
};

const GLOBAL_AGENT_FILE_OPTIONS = [
  { value: 'soul', label: 'Agent 性格' },
  { value: 'style', label: '写作风格' },
  { value: 'memory', label: '全局记忆' },
];

const GLOBAL_AGENT_HISTORY_SOURCES = {
  system_init: '首次初始化',
  user_settings: '设置页保存',
  agent_explicit: 'Agent 明确更新',
  restore_default: '恢复默认',
  rollback: '历史回滚',
  external_edit: '外部编辑器修改',
};

const GlobalAgentFiles = () => {
  const toast = useToast();
  const [activeFile, setActiveFile] = useState('soul');
  const [metadata, setMetadata] = useState([]);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [expectedHash, setExpectedHash] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDetail, setHistoryDetail] = useState(null);
  const activeMeta = metadata.find((item) => item.file === activeFile) || null;
  const activeOption = GLOBAL_AGENT_FILE_OPTIONS.find((item) => item.value === activeFile) || GLOBAL_AGENT_FILE_OPTIONS[0];

  const loadList = useCallback(async () => {
    const response = await fetch('/api/settings/agent-files', { cache: 'no-store' });
    const payload = await readJsonResponse(response, { fallbackMessage: '读取全局 Agent 文件失败' });
    setMetadata(Array.isArray(payload.files) ? payload.files : []);
    return payload;
  }, []);

  const loadFile = useCallback(async (file) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/settings/agent-files/${encodeURIComponent(file)}`, { cache: 'no-store' });
      const payload = await readJsonResponse(response, { fallbackMessage: '读取全局 Agent 文件失败' });
      setContent(String(payload.content || ''));
      setSavedContent(String(payload.content || ''));
      setExpectedHash(String(payload.hash || ''));
      setMetadata((current) => current.map((item) => item.file === file ? { ...item, ...payload } : item));
    } catch (error) {
      toast(error.message || '读取全局 Agent 文件失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadList().catch((error) => toast(error.message || '读取全局 Agent 文件失败', 'error')); }, [loadList, toast]);
  useEffect(() => { loadFile(activeFile); }, [activeFile, loadFile]);

  const save = async () => {
    if (!content.trim() && !window.confirm('文件将被清空。确定继续保存吗？')) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/settings/agent-files/${encodeURIComponent(activeFile)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, expected_hash: expectedHash, allow_empty: !content.trim() }),
      });
      const payload = await readJsonResponse(response, { fallbackMessage: '保存全局 Agent 文件失败' });
      setContent(String(payload.content || content));
      setSavedContent(String(payload.content || content));
      setExpectedHash(String(payload.hash || ''));
      await loadList();
      toast('全局 Agent 文件已保存', 'success');
    } catch (error) {
      toast(error.message || '保存失败，当前编辑内容已保留', 'error');
    } finally { setSaving(false); }
  };

  const restoreDefault = async () => {
    if (!window.confirm(`恢复 ${activeOption.label} 的默认内容？当前内容会保留在历史版本中。`)) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/settings/agent-files/${encodeURIComponent(activeFile)}/restore-default`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_hash: expectedHash }),
      });
      const payload = await readJsonResponse(response, { fallbackMessage: '恢复默认内容失败' });
      setContent(String(payload.content || ''));
      setSavedContent(String(payload.content || ''));
      setExpectedHash(String(payload.hash || ''));
      await loadList();
      toast('已恢复默认内容', 'success');
    } catch (error) { toast(error.message || '恢复默认内容失败', 'error'); } finally { setSaving(false); }
  };

  const openHistory = async () => {
    try {
      const response = await fetch(`/api/settings/agent-files/${encodeURIComponent(activeFile)}/history`, { cache: 'no-store' });
      const payload = await readJsonResponse(response, { fallbackMessage: '读取历史版本失败' });
      setHistory(Array.isArray(payload.versions) ? payload.versions : []);
      setHistoryDetail(null);
      setHistoryOpen(true);
    } catch (error) { toast(error.message || '读取历史版本失败', 'error'); }
  };

  const readHistory = async (version) => {
    try {
      const response = await fetch(`/api/settings/agent-files/${encodeURIComponent(activeFile)}/history/${encodeURIComponent(version.id)}`, { cache: 'no-store' });
      setHistoryDetail(await readJsonResponse(response, { fallbackMessage: '读取历史内容失败' }));
    } catch (error) { toast(error.message || '读取历史内容失败', 'error'); }
  };

  const rollback = async (version) => {
    if (!window.confirm('回滚后会创建新的历史版本。确定继续吗？')) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/settings/agent-files/${encodeURIComponent(activeFile)}/history/${encodeURIComponent(version.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_hash: expectedHash }),
      });
      const payload = await readJsonResponse(response, { fallbackMessage: '回滚历史版本失败' });
      setContent(String(payload.content || ''));
      setSavedContent(String(payload.content || ''));
      setExpectedHash(String(payload.hash || ''));
      await loadList();
      setHistoryOpen(false);
      toast('已回滚到所选历史版本', 'success');
    } catch (error) { toast(error.message || '回滚历史版本失败', 'error'); } finally { setSaving(false); }
  };

  const openAgentDirectory = async () => {
    const result = await desktopClient.openAgentDirectory();
    if (!result?.ok) toast('无法打开全局 Agent 文件目录', 'error');
  };

  return (
    <div style={{ width: '100%', color: '#2D2D2D' }}>
      <div style={{ display: 'grid', gap: 16 }}>
        <SegmentedTabs value={activeFile} onChange={setActiveFile} ariaLabel="全局 Agent 文件" minWidth={120} options={GLOBAL_AGENT_FILE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} />
        <section style={{ ...SETTINGS_SURFACE_STYLE, padding: 0, overflow: 'hidden' }}>
          <div style={{ minHeight: 62, padding: '13px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', borderBottom: '1px solid #ECE9DF', background: '#FDFCFB' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#F6E8E1', color: '#BE6247', border: '1px solid #EFD9CF', flexShrink: 0 }}><Icons.file size={16} /></span>
              <div style={{ minWidth: 0 }}><div style={{ fontSize: 14, fontWeight: 750, color: '#2D2D2D' }}>{activeFile}.md</div><div style={{ marginTop: 2, fontSize: 12, color: 'var(--text-tertiary)' }}>{activeMeta?.updated_at ? new Date(activeMeta.updated_at).toLocaleString() : '读取中'}</div></div>
            </div>
            <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: activeMeta?.over_recommended ? 'var(--warning)' : 'var(--text-tertiary)' }}>{content.length} / {activeMeta?.recommended_chars || 0} 字符</div>
          </div>
          <div style={{ padding: 18 }}>
            <textarea className="notus-global-agent-editor" value={content} onChange={(event) => setContent(event.target.value)} disabled={loading || saving} spellCheck={false} aria-label={`${activeOption.label} Markdown 内容`} style={{ width: '100%', minHeight: 390, resize: 'vertical', boxSizing: 'border-box', border: '1px solid #DEDAD0', borderRadius: 12, padding: '16px 18px', color: 'var(--text-primary)', background: '#FCFBF9', font: '13.5px/1.75 var(--font-mono)', outline: 'none', transition: 'border-color 160ms ease, box-shadow 160ms ease, background 160ms ease' }} />
          </div>
          <div style={{ minHeight: 64, padding: '12px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', borderTop: '1px solid #ECE9DF', background: '#FDFCFB' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Button size="md" variant="secondary" disabled={saving || loading} onClick={openHistory}>历史版本</Button>
              {desktopClient.available() ? <Button size="md" variant="ghost" disabled={saving} onClick={openAgentDirectory}>打开所在位置</Button> : null}
              <Button size="md" variant="ghost" disabled={saving || loading} onClick={restoreDefault} style={{ color: '#A6533C' }}>恢复默认</Button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Button size="md" variant="secondary" disabled={saving || loading || content === savedContent} onClick={() => loadFile(activeFile)}>取消</Button>
              <Button size="md" variant="primary" loading={saving} disabled={loading || content === savedContent} onClick={save} style={{ minWidth: 88, justifyContent: 'center', boxShadow: '0 6px 14px rgba(217,119,87,0.2)' }}>保存修改</Button>
            </div>
          </div>
        </section>
      </div>
      <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} closeOnBackdrop={false} title={`${activeOption.label}历史版本`} maxWidth={760} footer={<Button variant="ghost" onClick={() => setHistoryOpen(false)}>关闭</Button>}>
        <div style={{ display: 'grid', gap: 10, maxHeight: '65vh', overflowY: 'auto' }}>
          {history.map((version) => <div key={version.id} style={{ ...SETTINGS_RESOURCE_ROW_STYLE, alignItems: 'flex-start', flexWrap: 'wrap' }}><div style={{ minWidth: 0, flex: '1 1 240px' }}><div style={{ fontSize: 13, fontWeight: 700 }}>{GLOBAL_AGENT_HISTORY_SOURCES[version.source] || version.source}</div><div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-tertiary)' }}>{new Date(version.created_at).toLocaleString()} · {String(version.hash || '').slice(0, 12)}</div></div><div style={{ display: 'flex', gap: 8 }}><Button size="sm" variant="ghost" onClick={() => readHistory(version)}>查看</Button><Button size="sm" variant="ghost" disabled={saving} onClick={() => rollback(version)}>回滚</Button></div></div>)}
          {history.length === 0 ? <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>尚无历史版本。</div> : null}
          {historyDetail ? <textarea readOnly value={historyDetail.content || ''} aria-label="历史版本内容" style={{ width: '100%', minHeight: 220, boxSizing: 'border-box', border: '1px solid var(--border-primary)', borderRadius: 10, padding: 12, background: 'var(--bg-secondary)', font: '12px/1.6 var(--font-mono)' }} /> : null}
        </div>
      </Dialog>
    </div>
  );
};

const About = () => {
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 24 }}>
        <div style={{ width: 56, height: 56, borderRadius: 12, background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <NotusLogo size={36} />
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>Notus</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>版本 {APP_VERSION}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 4 }}>
            本地 Markdown 文件工作区与 AI Agent
          </div>
        </div>
      </div>
      <div>
        当前版本专注本地 Markdown 文件、可审查的 Agent 协作和桌面工作区体验。
      </div>
    </div>
  );
};

const CONTENT_MAP = {
  model: ModelConfig,
  search: SearchConfig,
  skills: SkillsSettings,
  mcp: McpSettings,
  personalization: Personalization,
  'global-agent': GlobalAgentFiles,
  'image-storage': ImageStorageConfig,
  storage: Storage,
  logs: Logs,
  shortcuts: ShortcutsSettings,
  about: About,
};

export function SettingsDialog({ open, section = 'model', conversationId = '', onClose }) {
  const [activeSection, setActiveSection] = useState(section);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => { setActiveSection(section); setMobileNavOpen(false); }, [section]);

  const Content = CONTENT_MAP[activeSection] || CONTENT_MAP.model;
  const openImageSettings = () => setActiveSection('image-storage');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={<button type="button" className="notus-settings-nav-trigger" aria-label="打开设置菜单" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}><Icons.list size={17} /></button>}
      className="notus-settings-dialog"
      showHeader
      maxWidth={1180}
      closeOnBackdrop={false}
      bodyStyle={{ padding: 0, flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', background: 'var(--bg-secondary)' }}
      dialogStyle={{ width: 'min(1180px, calc(100vw - 64px))', height: 'min(760px, calc(100vh - 64px))', margin: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', overflow: 'hidden' }}
    >
      <div className="notus-settings-layout" style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden', background: 'var(--bg-primary)' }}>
        {mobileNavOpen ? <button type="button" className="notus-settings-nav-backdrop" aria-label="关闭设置菜单" onClick={() => setMobileNavOpen(false)} /> : null}
        <SettingsNav active={activeSection} mobileOpen={mobileNavOpen} onSelect={(nextSection) => { setActiveSection(nextSection); setMobileNavOpen(false); }} />
        <div className="notus-settings-content" style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)', padding: 32, minWidth: 0 }}>
          <div className="notus-settings-content__inner" style={{ width: '100%', maxWidth: SETTINGS_CONTENT_MAX_WIDTH, margin: '0 auto' }}>
            <Content onOpenImageSettings={openImageSettings} agentConversationId={conversationId} />
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export function SettingsScreen({ section }) {
  const router = useRouter();
  return <SettingsDialog open section={section} onClose={() => router.replace('/files')} />;
}
