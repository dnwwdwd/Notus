import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { TopBar } from '../Layout/TopBar';
import { NotusLogo, Icons } from '../ui/Icons';
import { Button } from '../ui/Button';
import { DropdownSelect } from '../ui/DropdownSelect';
import { SearchInput, TextInput } from '../ui/Input';
import { ConfirmDialog } from '../ui/Dialog';
import { ProgressBar } from '../ui/ProgressBar';
import { Badge } from '../ui/Badge';
import { Toggle } from '../ui/Toggle';
import { useToast } from '../ui/Toast';
import { LlmConfigCardsSection } from './LlmConfigCardsSection';
import packageMeta from '../../package.json';
import { usePlatform } from '../../contexts/PlatformContext';
import {
  EMBEDDING_PROVIDERS,
  findProvider,
} from '../../lib/modelCatalog';
import { findEmbeddingModelMeta, inferEmbeddingProvider } from '../../lib/embeddingForm';
import { useShortcuts, normalizeShortcut, DEFAULT_SHORTCUTS } from '../../contexts/ShortcutsContext';
import { navigateWithFallback } from '../../utils/navigation';
import { desktop as desktopClient } from '../../utils/platformClient';

const APP_VERSION = packageMeta.version || '0.1.2';

export const SETTINGS_SECTIONS = [
  { id: 'model', label: '模型配置', icon: <Icons.robot size={14} />, href: '/settings/model' },
  { id: 'storage', label: '存储', icon: <Icons.database size={14} />, href: '/settings/storage' },
  { id: 'logs', label: '日志', icon: <Icons.list size={14} />, href: '/settings/logs' },
  { id: 'shortcuts', label: '快捷键', icon: <Icons.dots size={14} />, href: '/settings/shortcuts' },
  { id: 'about', label: '关于', icon: <Icons.info size={14} />, href: '/settings/about' },
];

const SettingsNav = ({ active }) => {
  const router = useRouter();

  return (
    <div style={{ width: 208, background: 'var(--bg-sidebar)', borderRight: '1px solid var(--border-subtle)', padding: 16, flexShrink: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '4px 10px 8px' }}>
        设置
      </div>
      {SETTINGS_SECTIONS.map((item) => {
        const activeItem = item.id === active;
        return (
          <div
            key={item.id}
            onClick={() => navigateWithFallback(router, item.href)}
            style={{
              height: 32,
              padding: '0 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              borderRadius: 'var(--radius-sm)',
              marginBottom: 2,
              background: activeItem ? 'var(--accent-subtle)' : 'transparent',
              color: activeItem ? 'var(--accent)' : 'var(--text-primary)',
              fontSize: 'var(--text-sm)',
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
  const [embModel, setEmbModel] = useState('text-embedding-v3');
  const [embApiKey, setEmbApiKey] = useState('');
  const [embBaseUrl, setEmbBaseUrl] = useState(findProvider(EMBEDDING_PROVIDERS, 'qwen').baseUrl);
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
    fetch('/api/settings')
      .then((response) => response.json())
      .then((settings) => {
        if (cancelled) return;
        if (settings.embedding) {
          setEmbProvider(settings.embedding.provider || 'qwen');
          setEmbModel(settings.embedding.model || 'text-embedding-v3');
          setEmbBaseUrl(settings.embedding.base_url || '');
          setDetectedEmbDim(Number(settings.embedding.dim || 0) || null);
          setEmbMultimodalEnabled(Boolean(settings.embedding.multimodal_enabled));
        }
        setKeyHints({
          embedding: Boolean(settings.embedding?.api_key_set),
        });
        setTestedSignature('');
        setVerificationToken('');
      })
      .catch(() => toast('读取配置失败', 'error'));
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
      const embeddingResult = await embeddingResponse.json();
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
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存失败');
      setEmbApiKey('');
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
    <div>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 6 }}>模型配置</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 20 }}>
        Embedding 继续单独配置；所有对话模型统一通过卡片管理，并保存在服务端。
      </div>

      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--border-subtle)' }}>
          Embedding 模型
        </div>
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', background: 'var(--bg-elevated)', padding: 18 }}>
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Base URL">
                <TextInput
                  value={embBaseUrl}
                  onChange={(event) => {
                    handleEmbeddingFieldChange({ embBaseUrl: event.target.value });
                  }}
                  placeholder="https://api.openai.com/v1"
                />
              </Field>
              <Field label="模型名称">
                <TextInput
                  value={embModel}
                  onChange={(event) => handleEmbeddingFieldChange({ embModel: event.target.value })}
                  placeholder="例如：text-embedding-3-small"
                />
              </Field>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'end' }}>
              <Field label="API Key">
                <TextInput
                  value={embApiKey}
                  onChange={(event) => handleEmbeddingFieldChange({ embApiKey: event.target.value })}
                  placeholder={keyHints.embedding ? '已保存，留空不修改' : 'sk-...'}
                  masked
                />
              </Field>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 1 }}>
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>多模态向量</span>
                <Toggle on={embMultimodalEnabled} onChange={(value) => handleEmbeddingFieldChange({ embMultimodalEnabled: value })} />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <Button
                  variant="secondary"
                  loading={testState === 'loading'}
                  onClick={handleTest}
                  style={{
                    ...(testState === 'success' ? { borderColor: 'var(--success)', color: 'var(--success)' } : {}),
                    ...(testState === 'error' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}),
                  }}
                >
                  {testState === 'success' ? '✓ Embedding 正常' : testState === 'error' ? '✕ Embedding 失败' : '测试 Embedding'}
                </Button>
                <Button variant="primary" loading={saving} disabled={!embeddingTestCurrent} onClick={handleSave}>保存 Embedding</Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 32 }}>
        <LlmConfigCardsSection
          title="LLM 配置"
          subtitle="知识库问答与 AI 创作会直接读取这里保存的已测试模型配置。"
        />
      </div>
    </div>
  );
};

const Logs = () => {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [level, setLevel] = useState('');
  const [route, setRoute] = useState('');
  const [requestId, setRequestId] = useState('');

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

  useEffect(() => {
    fetchLogs().catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 6 }}>日志</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 28 }}>
        查看最近的服务端结构化日志，用于排查导入、索引、模型配置和运行时错误。
      </div>

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
    <div>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 28 }}>存储</div>
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
    <div>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 6 }}>快捷键</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 28 }}>
        在这里集中维护常用操作的快捷键。输入框中的快捷键提示默认隐藏，但实际操作仍会按这里的配置生效。
      </div>

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

const About = () => {
  return (
    <div>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 28 }}>关于</div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 24 }}>
        <div style={{ width: 56, height: 56, borderRadius: 12, background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <NotusLogo size={36} />
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>Notus</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>版本 {APP_VERSION}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 4 }}>
            私有化个人知识库与 AI 写作协作工具
          </div>
        </div>
      </div>
      <div
        style={{
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xl)',
          background: 'linear-gradient(180deg, rgba(193,95,60,0.06) 0%, var(--bg-elevated) 100%)',
          padding: '18px 20px',
          boxShadow: 'var(--shadow-sm)',
          maxWidth: 560,
        }}
      >
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
          当前版本专注本地知识库问答、块级创作协作和桌面工作区体验。
        </div>
      </div>
    </div>
  );
};

const CONTENT_MAP = {
  model: ModelConfig,
  storage: Storage,
  logs: Logs,
  shortcuts: ShortcutsSettings,
  about: About,
};

export function SettingsScreen({ section }) {
  const Content = CONTENT_MAP[section] || CONTENT_MAP.model;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <TopBar active="" />
      <div
        style={{
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
          minHeight: 0,
          position: 'relative',
          isolation: 'isolate',
          zIndex: 0,
        }}
      >
        <SettingsNav active={section} />
        <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)', padding: 32, minWidth: 0 }}>
          <div style={{ maxWidth: 920, margin: '0 auto' }}>
            <Content />
          </div>
        </div>
      </div>
    </div>
  );
}
