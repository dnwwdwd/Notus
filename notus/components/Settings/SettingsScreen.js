import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { TopBar } from '../Layout/TopBar';
import { NotusLogo, Icons } from '../ui/Icons';
import { Button } from '../ui/Button';
import { DropdownSelect } from '../ui/DropdownSelect';
import { TextInput } from '../ui/Input';
import { ProviderSelect } from '../ui/ProviderSelect';
import { ConfirmDialog } from '../ui/Dialog';
import { ProgressBar } from '../ui/ProgressBar';
import { Badge } from '../ui/Badge';
import { Toggle } from '../ui/Toggle';
import { useToast } from '../ui/Toast';
import {
  EMBEDDING_PROVIDERS,
  findProvider,
  getEmbeddingModelMeta,
  isEmbeddingModelMultimodal,
  LLM_PROVIDERS,
} from '../../lib/modelCatalog';
import { useShortcuts, normalizeShortcut, DEFAULT_SHORTCUTS } from '../../contexts/ShortcutsContext';

export const SETTINGS_SECTIONS = [
  { id: 'model', label: '模型配置', icon: <Icons.robot size={14} />, href: '/settings/model' },
  { id: 'storage', label: '存储', icon: <Icons.database size={14} />, href: '/settings/storage' },
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
            onClick={() => router.push(item.href)}
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

const ModelConfig = () => {
  const toast = useToast();
  const [embProvider, setEmbProvider] = useState('qwen');
  const [embModel, setEmbModel] = useState('text-embedding-v3');
  const [embApiKey, setEmbApiKey] = useState('');
  const [embBaseUrl, setEmbBaseUrl] = useState(findProvider(EMBEDDING_PROVIDERS, 'qwen').baseUrl);
  const [embCustomModel, setEmbCustomModel] = useState('');
  const [embCustomDim, setEmbCustomDim] = useState('');
  const [embMultimodalEnabled, setEmbMultimodalEnabled] = useState(false);
  const [llmProvider, setLlmProvider] = useState('qwen');
  const [llmModel, setLlmModel] = useState('qwen-max');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmBaseUrl, setLlmBaseUrl] = useState(findProvider(LLM_PROVIDERS, 'qwen').baseUrl);
  const [llmCustomModel, setLlmCustomModel] = useState('');
  const [testState, setTestState] = useState('idle');
  const [saving, setSaving] = useState(false);
  const [keyHints, setKeyHints] = useState({ embedding: false, llm: false });

  const currentEmbProvider = useMemo(
    () => findProvider(EMBEDDING_PROVIDERS, embProvider),
    [embProvider]
  );
  const currentLlmProvider = useMemo(
    () => findProvider(LLM_PROVIDERS, llmProvider),
    [llmProvider]
  );
  const isCustomEmb = embProvider === 'custom';
  const isCustomLlm = llmProvider === 'custom';
  const selectedEmbeddingModel = useMemo(
    () => isCustomEmb ? null : getEmbeddingModelMeta(embProvider, embModel),
    [embModel, embProvider, isCustomEmb]
  );
  const effectiveEmbeddingModel = isCustomEmb ? embCustomModel : embModel;
  const embeddingModelSupportsMultimodal = useMemo(
    () => isEmbeddingModelMultimodal(embProvider, effectiveEmbeddingModel),
    [effectiveEmbeddingModel, embProvider]
  );
  const showMultimodalWarning = embMultimodalEnabled && !embeddingModelSupportsMultimodal;
  const showMultimodalReady = embMultimodalEnabled && embeddingModelSupportsMultimodal;

  const handleSelectEmbProvider = (providerId) => {
    setEmbProvider(providerId);
    const provider = findProvider(EMBEDDING_PROVIDERS, providerId);
    setEmbBaseUrl(provider.baseUrl || '');
    setEmbModel(provider.models[0]?.value || '');
  };

  const handleSelectLlmProvider = (providerId) => {
    setLlmProvider(providerId);
    const provider = findProvider(LLM_PROVIDERS, providerId);
    setLlmBaseUrl(provider.baseUrl || '');
    setLlmModel(provider.models[0]?.value || '');
  };

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
          setEmbCustomDim(String(settings.embedding.dim || ''));
          setEmbCustomModel(settings.embedding.model || '');
          setEmbMultimodalEnabled(Boolean(settings.embedding.multimodal_enabled));
        }
        if (settings.llm) {
          setLlmProvider(settings.llm.provider || 'qwen');
          setLlmModel(settings.llm.model || 'qwen-max');
          setLlmBaseUrl(settings.llm.base_url || '');
          setLlmCustomModel(settings.llm.model || '');
        }
        setKeyHints({
          embedding: Boolean(settings.embedding?.api_key_set),
          llm: Boolean(settings.llm?.api_key_set),
        });
      })
      .catch(() => toast('读取配置失败', 'error'));
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const handleTest = async () => {
    setTestState('loading');
    try {
      const embeddingConfig = {
        provider: embProvider,
        model: isCustomEmb ? embCustomModel : embModel,
        api_key: embApiKey,
        base_url: embBaseUrl,
        dim: isCustomEmb ? embCustomDim : embDim,
        multimodal_enabled: embMultimodalEnabled,
      };
      const llmConfig = {
        provider: llmProvider,
        model: isCustomLlm ? llmCustomModel : llmModel,
        api_key: llmApiKey,
        base_url: llmBaseUrl,
      };
      const embeddingResponse = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'embedding', config: embeddingConfig }),
      });
      const embeddingResult = await embeddingResponse.json();
      if (!embeddingResult.success) throw new Error(`Embedding：${embeddingResult.error}`);

      const llmResponse = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'llm', config: llmConfig }),
      });
      const llmResult = await llmResponse.json();
      if (!llmResult.success) throw new Error(`LLM：${llmResult.error}`);

      setTestState('success');
      toast('连接测试成功', 'success');
    } catch (error) {
      setTestState('error');
      toast(error.message || '连接测试失败', 'error');
    }
    setTimeout(() => setTestState('idle'), 2500);
  };

  const embDim = embProvider === 'custom'
    ? (embCustomDim || '—')
    : (selectedEmbeddingModel?.dimension || '—');

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embedding: {
            provider: embProvider,
            model: isCustomEmb ? embCustomModel : embModel,
            dim: isCustomEmb ? embCustomDim : embDim,
            multimodal_enabled: embMultimodalEnabled,
            base_url: embBaseUrl,
            api_key: embApiKey,
          },
          llm: {
            provider: llmProvider,
            model: isCustomLlm ? llmCustomModel : llmModel,
            base_url: llmBaseUrl,
            api_key: llmApiKey,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存失败');
      setEmbApiKey('');
      setLlmApiKey('');
      setKeyHints({
        embedding: Boolean(payload.embedding?.api_key_set),
        llm: Boolean(payload.llm?.api_key_set),
      });
      toast('配置已保存', 'success');
    } catch (error) {
      toast(error.message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 6 }}>模型配置</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 28 }}>
        选择内置提供商，或填写兼容 OpenAI API 的自定义服务。API Key 仅保存在本地。
      </div>

      <Section title="Embedding 模型">
        <Field label="提供商">
          <ProviderSelect
            value={embProvider}
            catalog={EMBEDDING_PROVIDERS}
            onChange={handleSelectEmbProvider}
            style={{ maxWidth: 260 }}
          />
        </Field>
        <Field label="Base URL" hint={isCustomEmb ? '填写兼容 OpenAI Embeddings API 的服务地址' : undefined}>
          <TextInput
            value={embBaseUrl}
            onChange={(event) => setEmbBaseUrl(event.target.value)}
            disabled={!isCustomEmb}
            style={!isCustomEmb ? { opacity: 0.65 } : undefined}
          />
        </Field>
        <Field label="模型">
          {isCustomEmb ? (
            <TextInput
              value={embCustomModel}
              onChange={(event) => setEmbCustomModel(event.target.value)}
              placeholder="text-embedding-xxx"
            />
          ) : (
            <DropdownSelect
              value={embModel}
              options={currentEmbProvider.models}
              onChange={setEmbModel}
              searchable
              searchPlaceholder="搜索 Embedding 模型"
            />
          )}
        </Field>
        <Field label="多模态向量">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              padding: '12px 14px',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--bg-elevated)',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>允许图片 / 视频向量化</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.6 }}>
                关闭时系统只建立文本向量；开启后会尝试为图片建立向量，不支持的模型会自动跳过。
              </div>
            </div>
            <Toggle on={embMultimodalEnabled} onChange={setEmbMultimodalEnabled} />
          </div>
        </Field>
        {showMultimodalReady && (
          <div style={{ marginBottom: 16 }}>
            <NoteBox tone="success">
              当前模型支持多模态向量化。文本块和图片向量会共用同一维度，切换模型后需要重建索引。
            </NoteBox>
          </div>
        )}
        {showMultimodalWarning && (
          <div style={{ marginBottom: 16 }}>
            <NoteBox tone="warning">
              当前选择的模型看起来是纯文本向量模型。保存后系统仍可正常工作，但图片和视频向量会跳过，不会影响文本检索。
            </NoteBox>
          </div>
        )}
        {!embMultimodalEnabled && (
          <div style={{ marginBottom: 16 }}>
            <NoteBox>
              这是默认模式，只建立文本块向量。若后续需要图片检索，可再切换到支持多模态的向量模型。
            </NoteBox>
          </div>
        )}
        <Field label="API Key">
          <TextInput
            value={embApiKey}
            onChange={(event) => setEmbApiKey(event.target.value)}
            placeholder={keyHints.embedding ? '已保存，留空不修改' : 'sk-...'}
            masked
          />
        </Field>
        <Field
          label="向量维度"
          hint={embMultimodalEnabled ? '文本块和图片向量必须使用同一维度；切换模型时需重建索引' : '切换模型时需重建索引'}
        >
          <TextInput
            value={embDim}
            onChange={(event) => setEmbCustomDim(event.target.value)}
            disabled={!isCustomEmb}
            style={{ opacity: isCustomEmb ? 1 : 0.65, maxWidth: 120 }}
          />
        </Field>
      </Section>

      <Section title="LLM 模型">
        <Field label="提供商">
          <ProviderSelect
            value={llmProvider}
            catalog={LLM_PROVIDERS}
            onChange={handleSelectLlmProvider}
            style={{ maxWidth: 260 }}
          />
        </Field>
        <Field label="Base URL" hint={isCustomLlm ? '填写兼容 OpenAI Chat Completions API 的服务地址' : undefined}>
          <TextInput
            value={llmBaseUrl}
            onChange={(event) => setLlmBaseUrl(event.target.value)}
            disabled={!isCustomLlm}
            style={!isCustomLlm ? { opacity: 0.65 } : undefined}
          />
        </Field>
        <Field label="模型">
          {isCustomLlm ? (
            <TextInput
              value={llmCustomModel}
              onChange={(event) => setLlmCustomModel(event.target.value)}
              placeholder="模型标识，如 kimi-k2-preview"
            />
          ) : (
            <DropdownSelect
              value={llmModel}
              options={currentLlmProvider.models}
              onChange={setLlmModel}
              searchable
              searchPlaceholder="搜索 LLM 模型"
            />
          )}
        </Field>
        <Field label="API Key">
          <TextInput
            value={llmApiKey}
            onChange={(event) => setLlmApiKey(event.target.value)}
            placeholder={keyHints.llm ? '已保存，留空不修改' : 'sk-...'}
            masked
          />
        </Field>
      </Section>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <Button
          variant="secondary"
          loading={testState === 'loading'}
          onClick={handleTest}
          style={{
            ...(testState === 'success' ? { borderColor: 'var(--success)', color: 'var(--success)' } : {}),
            ...(testState === 'error' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}),
          }}
        >
          {testState === 'success' ? '✓ 连接正常' : testState === 'error' ? '✕ 连接失败' : '测试连接'}
        </Button>
        <Button variant="primary" loading={saving} onClick={handleSave}>保存配置</Button>
      </div>
    </div>
  );
};

const Storage = () => {
  const toast = useToast();
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState(0);
  const [notesDir, setNotesDir] = useState('/lzcapp/var/notes');
  const [indexStatus, setIndexStatus] = useState({ total: 0, indexed: 0, pending: 0, failed: 0 });

  const refreshStatus = async () => {
    const [settingsResponse, statusResponse] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/index/status'),
    ]);
    const settings = await settingsResponse.json();
    const status = await statusResponse.json();
    if (settingsResponse.ok) setNotesDir(settings.notes_dir || '/lzcapp/var/notes');
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

  return (
    <div>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 28 }}>存储</div>
      <Section title="笔记目录">
        <Field label="目录路径">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TextInput value={notesDir} disabled style={{ flex: 1 }} />
            <Badge tone="success">已就绪</Badge>
          </div>
        </Field>
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
          <Button variant="danger" onClick={() => setConfirmClear(true)}>清除索引</Button>
        </div>
      </Section>

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          toast('索引已清除', 'warning');
        }}
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
    </div>
  );
};

const ShortcutsSettings = () => {
  const toast = useToast();
  const { shortcutList, updateShortcut, resetShortcuts } = useShortcuts();
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

const About = () => (
  <div>
    <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 28 }}>关于</div>
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 24 }}>
      <div style={{ width: 56, height: 56, borderRadius: 12, background: 'var(--accent-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <NotusLogo size={36} />
      </div>
      <div>
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>Notus</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>版本 0.1.0</div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 4 }}>
          私有化个人知识库与 AI 写作协作工具
        </div>
      </div>
    </div>
    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
      <p>Notus 运行在懒猫微服上，数据存储在本地，不依赖云服务。</p>
      <p>所有 AI 调用均通过你自己配置的 API Key 直接连接服务商，无中间代理。</p>
    </div>
  </div>
);

const CONTENT_MAP = {
  model: <ModelConfig />,
  storage: <Storage />,
  shortcuts: <ShortcutsSettings />,
  about: <About />,
};

export function SettingsScreen({ section }) {
  const content = CONTENT_MAP[section] || CONTENT_MAP.model;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <TopBar active="" />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <SettingsNav active={section} />
        <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)', padding: 32 }}>
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            {content}
          </div>
        </div>
      </div>
    </div>
  );
}
