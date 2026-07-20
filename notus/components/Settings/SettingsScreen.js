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

const APP_VERSION = packageMeta.version || '0.1.2';
const SETTINGS_CONTENT_MAX_WIDTH = 860;
const SETTINGS_PAGE_TITLE_STYLE = {
  fontFamily: 'Georgia, Songti SC, STSong, serif',
  fontSize: 22,
  lineHeight: 1.25,
  fontWeight: 700,
  letterSpacing: '-0.012em',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

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

const SettingsPageHeader = ({ title, icon }) => (
  <div style={{ borderBottom: '1px solid #E5E3D8', paddingBottom: 16, marginBottom: 28 }}>
    <div style={SETTINGS_PAGE_TITLE_STYLE}>
      {icon}
      {title}
    </div>
  </div>
);

export const SETTINGS_SECTIONS = [
  { id: 'model', label: '模型配置', icon: <Icons.robot size={17} /> },
  { id: 'search', label: '搜索配置', icon: <Icons.settings size={17} /> },
  { id: 'skills', label: 'Skill', icon: <Icons.skill size={17} /> },
  { id: 'mcp', label: 'MCP', icon: <Icons.mcp size={17} /> },
  { id: 'personalization', label: '个性化', icon: <Icons.palette size={17} /> },
  { id: 'image-storage', label: '图床', icon: <Icons.image size={17} /> },
  { id: 'storage', label: '存储', icon: <Icons.database size={17} /> },
  { id: 'logs', label: '日志', icon: <Icons.list size={17} /> },
  { id: 'shortcuts', label: '快捷键', icon: <Icons.keyboard size={17} /> },
  { id: 'about', label: '关于', icon: <Icons.info size={17} /> },
];

const SettingsNav = ({ active, onSelect }) => {
  return (
    <div className="notus-settings-nav" style={{ width: 224, background: 'var(--bg-sidebar)', borderRight: '1px solid var(--border-subtle)', padding: '20px 16px', flexShrink: 0 }}>
      {SETTINGS_SECTIONS.map((item) => {
        const activeItem = item.id === active;
        return (
          <div
            key={item.id}
            onClick={() => onSelect(item.id)}
            style={{
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
            }}
          >
            {item.icon}
            {item.label}
          </div>
        );
      })}
    </div>
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
      <SettingsPageHeader title="模型配置" icon={<Icons.cpu size={20} style={{ color: '#D97757' }} />} />

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
      <SettingsPageHeader title="搜索引擎配置" icon={<Icons.settings size={20} style={{ color: '#D97757' }} />} />

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
            <div style={{ display: 'flex', gap: 8, padding: 4, background: '#F9F9F8', border: '1px solid #E5E3D8', borderRadius: 10, overflowX: 'auto' }}>
              {providers.map((provider) => {
                const active = provider.id === selectedProvider.id;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => { patchConfig({ selected_provider: provider.id }); setApiKey(''); }}
                    style={{
                      flex: 1,
                      minWidth: 88,
                      height: 32,
                      border: active ? '1px solid rgba(229,227,216,0.8)' : '1px solid transparent',
                      borderRadius: 8,
                      background: active ? '#fff' : 'transparent',
                      color: active ? '#D97757' : '#6B6963',
                      boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {provider.name}
                  </button>
                );
              })}
            </div>
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

const Logs = () => {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [agentSessions, setAgentSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [agentLoading, setAgentLoading] = useState(false);
  const [level, setLevel] = useState('');
  const [route, setRoute] = useState('');
  const [requestId, setRequestId] = useState('');
  const agentConversationId = String(router.query.conversation_id || '').trim();

  const formatLogTimestamp = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date).replace(/\//g, '-');
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
      <SettingsPageHeader title="日志" icon={<Icons.list size={20} style={{ color: '#D97757' }} />} />

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
    setImageTarget(target);
    if (!isConfiguredImageTarget(target)) {
      const option = IMAGE_STORAGE_OPTIONS.find((item) => item.value === target);
      toast(<span>{option?.label || '该图床'}尚未配置，<a href={`/settings/image-storage?provider=${encodeURIComponent(target)}`} onClick={(event) => { event.preventDefault(); onOpenImageSettings?.(target); }} style={{ color: 'var(--accent)', textDecoration: 'underline' }}>前往图床设置</a></span>, 'warning');
      return;
    }
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
      <SettingsPageHeader title="个性化" icon={<Icons.palette size={20} style={{ color: '#D97757' }} />} />
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
          <SegmentedTabs value={imageTarget} onChange={handleImageTargetChange} disabled={savingImageTarget} ariaLabel="图片上传位置" minWidth={84} height={30} style={{ flexShrink: 0 }} options={IMAGE_STORAGE_OPTIONS} />
        </div>
      </section>
    </div>
  );
};

const IMAGE_STORAGE_OPTIONS = [
  { value: 'local', label: '本地资源目录' },
  { value: 'cos', label: '腾讯云 COS' },
  { value: 'oss', label: '阿里云 OSS' },
  { value: 'r2', label: 'Cloudflare R2' },
];

const CLOUD_IMAGE_STORAGE_OPTIONS = IMAGE_STORAGE_OPTIONS.filter((item) => item.value !== 'local');

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

  const applySettings = useCallback((settings) => {
    setProviderConfigs(settings.images?.provider_configs || {});
    setActiveProvider(settings.images?.storage_mode === 'object_storage' ? settings.images?.object_storage?.provider || '' : '');
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings').then((response) => response.json()).then((settings) => {
      if (!cancelled) applySettings(settings);
    }).catch(() => toast('读取图床配置失败', 'error'));
    return () => { cancelled = true; };
  }, [applySettings, toast]);

  return (
    <div style={{ width: '100%', color: '#2D2D2D' }}>
      <SettingsPageHeader title="图床配置" icon={<Icons.image size={20} style={{ color: '#D97757' }} />} />
      <div style={{ display: 'grid', gap: 20 }}>{CLOUD_IMAGE_STORAGE_OPTIONS.map((item) => <ImageStorageProviderConfig key={item.value} provider={item.value} savedConfig={providerConfigs[item.value]} isActive={activeProvider === item.value} onSaved={applySettings} />)}</div>
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
      <SettingsPageHeader title="存储" icon={<Icons.database size={20} style={{ color: '#D97757' }} />} />
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
      <SettingsPageHeader title="快捷键" icon={<Icons.keyboard size={20} style={{ color: '#D97757' }} />} />

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
  const [roots, setRoots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [ref, setRef] = useState('');
  const [subdirectory, setSubdirectory] = useState('');
  const [installing, setInstalling] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch('/api/skills', { cache: 'no-store' });
    const payload = await readJsonResponse(response, { fallbackMessage: '读取 Skills 失败' });
    setSkills(Array.isArray(payload.skills) ? payload.skills : []);
    setRoots(Array.isArray(payload.roots) ? payload.roots : []);
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
      toast('已完成本机 Skill 扫描', 'success');
    } catch (error) { toast(error.message || '扫描 Skills 失败', 'error'); } finally { setScanning(false); }
  };

  const toggleSkill = async (skill, enabled) => {
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}/state`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
      const payload = await readJsonResponse(response, { fallbackMessage: '更新 Skill 状态失败' });
      setSkills((current) => current.map((item) => String(item.id) === String(skill.id) ? payload.skill : item));
    } catch (error) { toast(error.message || '更新 Skill 状态失败', 'error'); }
  };

  const installFromGit = async () => {
    if (!repositoryUrl.trim()) { toast('请填写 HTTPS Git 仓库地址', 'warning'); return; }
    setInstalling(true);
    try {
      const response = await fetch('/api/skills/install/git', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryUrl, ref, subdirectory, conflictPolicy: 'reject' }) });
      const payload = await readJsonResponse(response, { fallbackMessage: '安装 Skill 失败' });
      setInstallOpen(false); setRepositoryUrl(''); setRef(''); setSubdirectory('');
      await load();
      toast(`已安装 ${payload.skills?.length || 0} 个 Skill`, 'success');
    } catch (error) { toast(error.message || '安装 Skill 失败', 'error'); } finally { setInstalling(false); }
  };

  return (
    <div style={{ width: '100%', color: '#2D2D2D' }}>
      <SettingsPageHeader title="Skill" icon={<Icons.skill size={20} style={{ color: '#D97757' }} />} />
      <div style={{ display: 'grid', gap: 18 }}>
        <section style={{ ...SETTINGS_SURFACE_STYLE, display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ ...SETTINGS_RESOURCE_ICON_STYLE, width: 40, height: 40, borderRadius: 12 }}><Icons.skill size={19} /></div>
              <div><div style={{ fontSize: 15, fontWeight: 700 }}>本机 Skill</div><div style={{ marginTop: 3, fontSize: 12, color: '#8A8881' }}>{loading ? '正在读取…' : `${skills.length} 个已发现`}</div></div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="ghost" loading={scanning} onClick={rescan}><Icons.refresh size={14} />重新扫描</Button>
              <Button variant="primary" onClick={() => setInstallOpen(true)}><Icons.download size={14} />从 Git 安装</Button>
            </div>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {skills.map((skill) => (
              <div key={skill.id} style={{ ...SETTINGS_RESOURCE_ROW_STYLE, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0, flex: '1 1 340px' }}>
                  <div style={SETTINGS_RESOURCE_ICON_STYLE}><Icons.skill size={17} /></div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 14, fontWeight: 700 }}><span>{skill.name}</span><Badge tone={skill.status === 'valid' ? 'success' : 'warning'}>{skill.status === 'valid' ? '有效' : skill.status}</Badge></div>
                    <div style={{ marginTop: 4, color: '#6B6963', fontSize: 12, lineHeight: 1.55 }}>{skill.description || '未提供描述'}</div>
                    <div style={{ marginTop: 5, color: '#A3A19A', fontSize: 11 }}>{skill.source_label || '本机'} · {skill.managed ? 'Notus 管理' : '外部目录'}</div>
                  </div>
                </div>
                <Toggle on={Boolean(skill.enabled)} disabled={skill.status !== 'valid'} onChange={(enabled) => toggleSkill(skill, enabled)} />
              </div>
            ))}
            {!loading && skills.length === 0 ? <div style={{ padding: '24px 16px', border: '1px dashed #D9D5CA', borderRadius: 12, color: '#8A8881', fontSize: 13, textAlign: 'center' }}>尚未发现可用 Skill</div> : null}
          </div>
        </section>
        <section style={{ ...SETTINGS_SURFACE_STYLE, display: 'grid', gap: 10, padding: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.02em', color: '#6B6963' }}>扫描位置</div>
          {roots.map((root) => <div key={root.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12, minWidth: 0 }}><Badge tone={root.managed_by_notus ? 'success' : 'default'}>{root.managed_by_notus ? '管理目录' : '外部目录'}</Badge><code style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#6B6963' }}>{root.path}</code></div>)}
        </section>
      </div>
      <Dialog open={installOpen} onClose={() => setInstallOpen(false)} title="从 Git 安装 Skill" maxWidth={520} footer={<><Button variant="ghost" onClick={() => setInstallOpen(false)}>取消</Button><Button variant="primary" loading={installing} onClick={installFromGit}>安装</Button></>}><div style={{ display: 'grid', gap: 16 }}><Field label="HTTPS 仓库地址"><TextInput value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/org/skills.git" /></Field><Field label="分支或 Tag" hint="可选"><TextInput value={ref} onChange={(event) => setRef(event.target.value)} placeholder="main" /></Field><Field label="Skill 所在子目录" hint="可选；仓库根目录中的所有 Skill 会被发现。"><TextInput value={subdirectory} onChange={(event) => setSubdirectory(event.target.value)} placeholder="skills" /></Field></div></Dialog>
    </div>
  );
};

const McpSettings = () => {
  const toast = useToast();
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState(null);
  const [draft, setDraft] = useState(null);
  const [testingId, setTestingId] = useState('');
  const empty = { name: '', transport: 'streamable_http', enabled: true, url: '', command: '', args: '', cwd: '', defaultPolicy: 'ask' };
  const load = useCallback(async () => { const response = await fetch('/api/mcp/servers', { cache: 'no-store' }); const payload = await readJsonResponse(response, { fallbackMessage: '读取 MCP Server 失败' }); setServers(Array.isArray(payload.servers) ? payload.servers : []); }, []);
  useEffect(() => { Promise.all([load(), fetch('/api/runtime/capabilities', { cache: 'no-store' }).then((response) => readJsonResponse(response, { fallbackMessage: '读取运行环境能力失败' }))]).then(([, payload]) => setCapabilities(payload)).catch((error) => toast(error.message || '读取 MCP Server 失败', 'error')).finally(() => setLoading(false)); }, [load, toast]);
  const edit = (server = null) => setDraft(server ? { id: server.id, name: server.name, transport: server.transport, enabled: server.enabled, url: server.config?.http?.url || '', command: server.config?.stdio?.command || '', args: (server.config?.stdio?.args || []).join(' '), cwd: server.config?.stdio?.cwd || '', defaultPolicy: server.tool_policy?.default || 'ask' } : { ...empty, transport: capabilities?.mcp?.stdio ? 'stdio' : 'streamable_http' });
  const save = async () => {
    if (!draft?.name?.trim()) { toast('请填写 MCP Server 名称', 'warning'); return; }
    const args = String(draft.args || '').match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, '')) || [];
    const body = { name: draft.name, transport: draft.transport, enabled: Boolean(draft.enabled), toolPolicy: { default: draft.defaultPolicy }, ...(draft.transport === 'stdio' ? { stdio: { command: draft.command, args, cwd: draft.cwd } } : { http: { url: draft.url } }) };
    try { const response = await fetch(draft.id ? `/api/mcp/servers/${encodeURIComponent(draft.id)}` : '/api/mcp/servers', { method: draft.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await readJsonResponse(response, { fallbackMessage: '保存 MCP Server 失败' }); setDraft(null); await load(); toast('MCP Server 已保存', 'success'); } catch (error) { toast(error.message || '保存 MCP Server 失败', 'error'); }
  };
  const test = async (server) => { setTestingId(server.id); try { const response = await fetch(`/api/mcp/servers/${encodeURIComponent(server.id)}/test`, { method: 'POST' }); const result = await readJsonResponse(response, { fallbackMessage: 'MCP 连接测试失败' }); toast(`连接成功，发现 ${result.tool_count || 0} 个工具`, 'success'); await load(); } catch (error) { toast(error.message || 'MCP 连接测试失败', 'error'); } finally { setTestingId(''); } };
  const remove = async (server) => { if (!window.confirm(`删除 MCP Server“${server.name}”？`)) return; try { const response = await fetch(`/api/mcp/servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' }); await readJsonResponse(response, { fallbackMessage: '删除 MCP Server 失败' }); await load(); toast('MCP Server 已删除', 'success'); } catch (error) { toast(error.message || '删除 MCP Server 失败', 'error'); } };
  const supportsStdio = Boolean(capabilities?.mcp?.stdio);
  const transportOptions = [
    ...(supportsStdio ? [{ value: 'stdio', label: 'stdio' }] : []),
    { value: 'streamable_http', label: 'Streamable HTTP' },
  ];
  return (
    <div style={{ width: '100%', color: '#2D2D2D' }}>
      <SettingsPageHeader title="MCP" icon={<Icons.mcp size={20} style={{ color: '#D97757' }} />} />
      <div style={{ display: 'grid', gap: 18 }}>
        <section style={{ ...SETTINGS_SURFACE_STYLE, display: 'grid', gap: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ ...SETTINGS_RESOURCE_ICON_STYLE, width: 40, height: 40, borderRadius: 12 }}><Icons.mcp size={19} /></div>
              <div><div style={{ fontSize: 15, fontWeight: 700 }}>MCP Server</div><div style={{ marginTop: 3, fontSize: 12, color: '#8A8881' }}>{loading ? '正在读取…' : `${servers.length} 个已配置`}</div></div>
            </div>
            {capabilities ? <Button variant="primary" onClick={() => edit()}><Icons.plus size={14} />添加 Server</Button> : null}
          </div>
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
      </div>
      <Dialog open={Boolean(draft)} onClose={() => setDraft(null)} title={draft?.id ? '编辑 MCP Server' : '添加 MCP Server'} maxWidth={560} footer={<><Button variant="ghost" onClick={() => setDraft(null)}>取消</Button><Button variant="primary" onClick={save}>保存</Button></>}>
        {draft ? <div style={{ display: 'grid', gap: 16 }}>
          <Field label="名称"><TextInput value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：本地文件工具" /></Field>
          {supportsStdio ? <Field label="传输方式"><SegmentedTabs value={draft.transport} onChange={(transport) => setDraft({ ...draft, transport })} options={transportOptions} /></Field> : null}
          {draft.transport === 'stdio' ? <><Field label="命令"><TextInput value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></Field><Field label="参数" hint="用空格分隔；带空格的参数可用双引号。"><TextInput value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem /path" /></Field><Field label="工作目录" hint="可选，必须为绝对路径。"><TextInput value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} placeholder="/Users/name/project" /></Field></> : <Field label="Server URL" hint="桌面开发环境允许 localhost HTTP；其他地址必须使用 HTTPS。"><TextInput value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" /></Field>}
          <Field label="默认工具权限"><SegmentedTabs value={draft.defaultPolicy} onChange={(defaultPolicy) => setDraft({ ...draft, defaultPolicy })} options={[{ value: 'ask', label: '每次询问' }, { value: 'allow', label: '默认允许' }, { value: 'deny', label: '默认拒绝' }]} /></Field>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><span style={{ fontSize: 13, fontWeight: 600 }}>启用此 Server</span><Toggle on={Boolean(draft.enabled)} onChange={(enabled) => setDraft({ ...draft, enabled })} /></div>
        </div> : null}
      </Dialog>
    </div>
  );
};

const About = () => {
  return (
    <div style={{ width: '100%' }}>
      <SettingsPageHeader title="关于" icon={<Icons.info size={20} style={{ color: '#D97757' }} />} />
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
  'image-storage': ImageStorageConfig,
  storage: Storage,
  logs: Logs,
  shortcuts: ShortcutsSettings,
  about: About,
};

export function SettingsDialog({ open, section = 'model', onClose }) {
  const [activeSection, setActiveSection] = useState(section);

  useEffect(() => { setActiveSection(section); }, [section]);

  const Content = CONTENT_MAP[activeSection] || CONTENT_MAP.model;
  const openImageSettings = () => setActiveSection('image-storage');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="notus-settings-dialog"
      showHeader
      maxWidth={1180}
      closeOnBackdrop={false}
      bodyStyle={{ padding: 0, flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex' }}
      dialogStyle={{ width: 'min(1180px, calc(100vw - 64px))', height: 'min(760px, calc(100vh - 64px))', margin: 0, display: 'flex', flexDirection: 'column' }}
    >
      <div className="notus-settings-layout" style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <SettingsNav active={activeSection} onSelect={setActiveSection} />
        <div className="notus-settings-content" style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)', padding: 32, minWidth: 0 }}>
          <div className="notus-settings-content__inner" style={{ width: '100%', maxWidth: SETTINGS_CONTENT_MAX_WIDTH, margin: '0 auto' }}>
            <Content onOpenImageSettings={openImageSettings} />
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
