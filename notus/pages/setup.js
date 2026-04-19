import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { NotusLogo, Icons } from '../components/ui/Icons';
import { Button } from '../components/ui/Button';
import { DropdownSelect } from '../components/ui/DropdownSelect';
import { TextInput } from '../components/ui/Input';
import { ProviderSelect } from '../components/ui/ProviderSelect';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Spinner } from '../components/ui/Spinner';
import { Toggle } from '../components/ui/Toggle';
import { useToast } from '../components/ui/Toast';
import {
  EMBEDDING_PROVIDERS,
  findProvider,
  getEmbeddingModelMeta,
  isEmbeddingModelMultimodal,
  LLM_PROVIDERS,
} from '../lib/modelCatalog';

const StepIndicator = ({ current, labels }) => (
  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', marginBottom: 36 }}>
    {labels.map((lb, i) => {
      const done = i < current;
      const on = i === current;
      return (
        <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 90 }}>
            <div style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: on || done ? 'var(--accent)' : 'var(--bg-active)',
              color: on || done ? '#fff' : 'var(--text-tertiary)',
              fontSize: 12,
              fontWeight: 600,
            }}>
              {done ? <Icons.check size={13} /> : i + 1}
            </div>
            <div style={{ fontSize: 11, color: on ? 'var(--text-primary)' : 'var(--text-tertiary)', fontWeight: on ? 500 : 400 }}>
              {lb}
            </div>
          </div>
          {i < labels.length - 1 && (
            <div style={{
              flex: '0 0 40px',
              height: 2,
              marginTop: 12,
              background: i < current ? 'var(--accent)' : 'var(--border-primary)',
            }} />
          )}
        </div>
      );
    })}
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

const Step1 = ({ form, onChange, keyHints, loading }) => {
  const currentEmbProvider = findProvider(EMBEDDING_PROVIDERS, form.embProvider);
  const currentLlmProvider = findProvider(LLM_PROVIDERS, form.llmProvider);
  const isCustomEmb = form.embProvider === 'custom';
  const isCustomLlm = form.llmProvider === 'custom';
  const effectiveEmbeddingModel = isCustomEmb ? form.embCustomModel : form.embModel;
  const selectedEmbeddingModel = isCustomEmb ? null : getEmbeddingModelMeta(form.embProvider, form.embModel);
  const embeddingModelSupportsMultimodal = useMemo(
    () => isEmbeddingModelMultimodal(form.embProvider, effectiveEmbeddingModel),
    [effectiveEmbeddingModel, form.embProvider]
  );
  const embDim = isCustomEmb ? (form.embCustomDim || '—') : (selectedEmbeddingModel?.dimension || '—');

  return (
    <div>
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-xl)',
        padding: 20,
        marginBottom: 20,
      }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            <Spinner size={14} />
            正在读取当前配置…
          </div>
        )}

        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 10 }}>Embedding 模型</div>
        <div style={{ marginBottom: 10 }}>
          <ProviderSelect
            value={form.embProvider}
            catalog={EMBEDDING_PROVIDERS}
            onChange={(value) => {
              const provider = findProvider(EMBEDDING_PROVIDERS, value);
              onChange({
                embProvider: value,
                embBaseUrl: provider.baseUrl || '',
                embModel: provider.models[0]?.value || '',
              });
            }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <TextInput
            value={form.embBaseUrl}
            onChange={(event) => onChange({ embBaseUrl: event.target.value })}
            placeholder="https://your-openai-compatible-endpoint/v1"
            disabled={!isCustomEmb}
            style={{ opacity: isCustomEmb ? 1 : 0.65 }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          {isCustomEmb ? (
            <TextInput
              value={form.embCustomModel}
              onChange={(event) => onChange({ embCustomModel: event.target.value })}
              placeholder="自定义 Embedding 模型名"
            />
          ) : (
            <DropdownSelect
              value={form.embModel}
              options={currentEmbProvider.models}
              onChange={(nextValue) => onChange({ embModel: nextValue })}
              searchable
              searchPlaceholder="搜索 Embedding 模型"
            />
          )}
        </div>
        <div style={{ marginBottom: 10 }}>
          <TextInput
            value={form.embApiKey}
            onChange={(event) => onChange({ embApiKey: event.target.value })}
            placeholder={keyHints.embedding ? '已保存，留空不修改' : 'sk-...'}
            masked
          />
        </div>
        {isCustomEmb && (
          <div style={{ marginBottom: 10 }}>
            <TextInput
              value={form.embCustomDim}
              onChange={(event) => onChange({ embCustomDim: event.target.value })}
              placeholder="自定义维度，例如 1024"
            />
          </div>
        )}
        {!isCustomEmb && (
          <div style={{ marginBottom: 14, fontSize: 11, color: 'var(--text-tertiary)' }}>
            当前向量维度：{embDim}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            padding: '12px 14px',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--bg-primary)',
            marginBottom: 14,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>多模态向量模型</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.6 }}>
              开启后会尝试为图片建立向量；如果当前模型不支持，系统会自动跳过，不影响文本索引。
            </div>
          </div>
          <Toggle on={form.embMultimodalEnabled} onChange={(nextValue) => onChange({ embMultimodalEnabled: nextValue })} />
        </div>

        {form.embMultimodalEnabled && embeddingModelSupportsMultimodal && (
          <div style={{ marginBottom: 14 }}>
            <NoteBox tone="success">
              当前模型支持多模态向量化。图片和文本会共用同一套向量维度；切换模型后需要重建索引。
            </NoteBox>
          </div>
        )}
        {form.embMultimodalEnabled && !embeddingModelSupportsMultimodal && (
          <div style={{ marginBottom: 14 }}>
            <NoteBox tone="warning">
              当前模型更像纯文本向量模型。保存后系统仍可正常使用，但图片和视频向量会跳过。
            </NoteBox>
          </div>
        )}
        {!form.embMultimodalEnabled && (
          <div style={{ marginBottom: 14 }}>
            <NoteBox>
              默认只建立文本向量，已经可以完成普通检索和问答。需要图片检索时，再切换到支持多模态的模型即可。
            </NoteBox>
          </div>
        )}

        <div style={{ height: 1, background: 'var(--border-subtle)', margin: '18px 0' }} />

        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 10 }}>LLM 模型</div>
        <div style={{ marginBottom: 10 }}>
          <ProviderSelect
            value={form.llmProvider}
            catalog={LLM_PROVIDERS}
            onChange={(value) => {
              const provider = findProvider(LLM_PROVIDERS, value);
              onChange({
                llmProvider: value,
                llmBaseUrl: provider.baseUrl || '',
                llmModel: provider.models[0]?.value || '',
              });
            }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <TextInput
            value={form.llmBaseUrl}
            onChange={(event) => onChange({ llmBaseUrl: event.target.value })}
            placeholder="https://your-openai-compatible-endpoint/v1"
            disabled={!isCustomLlm}
            style={{ opacity: isCustomLlm ? 1 : 0.65 }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          {isCustomLlm ? (
            <TextInput
              value={form.llmCustomModel}
              onChange={(event) => onChange({ llmCustomModel: event.target.value })}
              placeholder="自定义 LLM 模型名"
            />
          ) : (
            <DropdownSelect
              value={form.llmModel}
              options={currentLlmProvider.models}
              onChange={(nextValue) => onChange({ llmModel: nextValue })}
              searchable
              searchPlaceholder="搜索 LLM 模型"
            />
          )}
        </div>
        <TextInput
          value={form.llmApiKey}
          onChange={(event) => onChange({ llmApiKey: event.target.value })}
          placeholder={keyHints.llm ? '已保存，留空不修改' : 'sk-...'}
          masked
        />
      </div>
    </div>
  );
};

const Step2 = () => {
  const [dragging, setDragging] = useState(false);
  const [selected] = useState('~/Documents/Notes');

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); }}
        style={{
          border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--border-primary)'}`,
          borderRadius: 'var(--radius-xl)',
          padding: 36,
          textAlign: 'center',
          background: dragging ? 'var(--accent-subtle)' : 'transparent',
          transition: 'all var(--transition-fast)',
          marginBottom: 14,
        }}
      >
        <div style={{ color: dragging ? 'var(--accent)' : 'var(--text-secondary)', display: 'inline-flex', marginBottom: 12 }}>
          <Icons.upload size={32} />
        </div>
        <div style={{ fontSize: 'var(--text-base)', fontWeight: 500, marginBottom: 4 }}>拖拽文件夹到这里</div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 16 }}>或</div>
        <Button variant="secondary">选择文件夹</Button>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 20 }}>
          支持 .md、.markdown · 最多 10,000 篇
        </div>
      </div>
      {selected && (
        <div style={{
          marginBottom: 10,
          padding: '10px 14px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{ color: 'var(--text-secondary)' }}><Icons.folder size={14} /></span>
          <span style={{ fontSize: 'var(--text-sm)', flex: 1, fontFamily: 'var(--font-mono)' }}>{selected}</span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>已选 · 128 篇</span>
        </div>
      )}
      <Button variant="ghost" size="sm">+ 使用空目录从头开始</Button>
    </div>
  );
};

const Step3 = () => {
  const [progress] = useState(77);

  return (
    <div>
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-xl)',
        padding: 24,
        marginBottom: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>98 / 128 篇</div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>约剩 42 秒</div>
        </div>
        <ProgressBar value={progress} max={100} />
        <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spinner size={12} />
          <span>→ 技术文章 / 缓存系列 / 性能优化实践.md</span>
        </div>
        <div style={{ height: 1, background: 'var(--border-subtle)', margin: '18px 0' }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          {[
            { n: '3,842', l: '已生成向量' },
            { n: '98', l: '已处理文件' },
            { n: '2', l: '解析失败' },
          ].map((s, i) => (
            <div key={i}>
              <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, fontFamily: 'var(--font-editor)' }}>{s.n}</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' }}>
        索引完成后将自动进入 Notus。你也可以在设置中随时重建索引。
      </div>
    </div>
  );
};

function createInitialForm() {
  return {
    embProvider: 'qwen',
    embModel: 'text-embedding-v3',
    embBaseUrl: findProvider(EMBEDDING_PROVIDERS, 'qwen').baseUrl,
    embApiKey: '',
    embCustomModel: '',
    embCustomDim: '',
    embMultimodalEnabled: false,
    llmProvider: 'qwen',
    llmModel: 'qwen-max',
    llmBaseUrl: findProvider(LLM_PROVIDERS, 'qwen').baseUrl,
    llmApiKey: '',
    llmCustomModel: '',
  };
}

export default function SetupPage() {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(createInitialForm);
  const [keyHints, setKeyHints] = useState({ embedding: false, llm: false });
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/settings')
      .then((response) => response.json())
      .then((settings) => {
        if (cancelled || !settings) return;
        setForm((prev) => ({
          ...prev,
          embProvider: settings.embedding?.provider || prev.embProvider,
          embModel: settings.embedding?.model || prev.embModel,
          embBaseUrl: settings.embedding?.base_url || prev.embBaseUrl,
          embCustomModel: settings.embedding?.model || prev.embCustomModel,
          embCustomDim: String(settings.embedding?.dim || prev.embCustomDim || ''),
          embMultimodalEnabled: Boolean(settings.embedding?.multimodal_enabled),
          llmProvider: settings.llm?.provider || prev.llmProvider,
          llmModel: settings.llm?.model || prev.llmModel,
          llmBaseUrl: settings.llm?.base_url || prev.llmBaseUrl,
          llmCustomModel: settings.llm?.model || prev.llmCustomModel,
        }));
        setKeyHints({
          embedding: Boolean(settings.embedding?.api_key_set),
          llm: Boolean(settings.llm?.api_key_set),
        });
      })
      .catch(() => {
        toast('读取当前配置失败', 'warning');
      })
      .finally(() => {
        if (!cancelled) setLoadingConfig(false);
      });

    return () => {
      cancelled = true;
    };
  }, [toast]);

  const handleChange = (patch) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const stepMeta = [
    {
      title: '配置 AI 模型',
      subtitle: 'Notus 需要一个 Embedding 模型建立索引，以及一个 LLM 负责对话。图片检索可按需开启多模态向量。',
      canSkip: true,
    },
    {
      title: '选择笔记目录',
      subtitle: '选一个已有的 Markdown 文件夹，或使用一个空目录从头开始',
      canSkip: false,
    },
    {
      title: '正在为你建立索引',
      subtitle: '完成后，你就能从任何一段话检索到它。这需要一点时间，请保持页面打开。',
      canSkip: false,
    },
  ];
  const meta = stepMeta[step];
  const labels = ['配置模型', '导入笔记', '建立索引'];

  const persistModelConfig = async () => {
    const isCustomEmb = form.embProvider === 'custom';
    const isCustomLlm = form.llmProvider === 'custom';
    const effectiveEmbModel = isCustomEmb ? form.embCustomModel.trim() : form.embModel;
    const effectiveLlmModel = isCustomLlm ? form.llmCustomModel.trim() : form.llmModel;
    const embDim = isCustomEmb
      ? form.embCustomDim.trim()
      : (getEmbeddingModelMeta(form.embProvider, form.embModel)?.dimension || '');

    if (!effectiveEmbModel) {
      toast('请填写 Embedding 模型名', 'warning');
      return false;
    }
    if (!effectiveLlmModel) {
      toast('请填写 LLM 模型名', 'warning');
      return false;
    }

    setSavingConfig(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embedding: {
            provider: form.embProvider,
            model: effectiveEmbModel,
            dim: embDim,
            base_url: form.embBaseUrl,
            api_key: form.embApiKey,
            multimodal_enabled: form.embMultimodalEnabled,
          },
          llm: {
            provider: form.llmProvider,
            model: effectiveLlmModel,
            base_url: form.llmBaseUrl,
            api_key: form.llmApiKey,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存失败');

      setForm((prev) => ({
        ...prev,
        embApiKey: '',
        llmApiKey: '',
        embCustomDim: embDim || prev.embCustomDim,
        embCustomModel: effectiveEmbModel,
        llmCustomModel: effectiveLlmModel,
      }));
      setKeyHints({
        embedding: Boolean(payload.embedding?.api_key_set),
        llm: Boolean(payload.llm?.api_key_set),
      });
      toast('模型配置已保存', 'success');
      return true;
    } catch (error) {
      toast(error.message || '保存失败', 'warning');
      return false;
    } finally {
      setSavingConfig(false);
    }
  };

  const finishSetup = async () => {
    setFinishing(true);
    try {
      const response = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '初始化完成失败');
      router.replace('/files');
    } catch (error) {
      toast(error.message || '初始化完成失败', 'warning');
    } finally {
      setFinishing(false);
    }
  };

  const handleNext = async () => {
    if (step === 0) {
      const saved = await persistModelConfig();
      if (!saved) return;
    }

    if (step < 2) setStep(step + 1);
  };

  const handleSkip = () => setStep((prev) => Math.min(prev + 1, 2));
  const handlePrev = () => step > 0 && setStep(step - 1);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      paddingTop: 56,
      minHeight: '100vh',
      background: 'var(--bg-primary)',
      overflow: 'auto',
    }}>
      <div style={{ maxWidth: 560, width: '100%', padding: 24 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ display: 'inline-flex', marginBottom: 14 }}><NotusLogo size={40} /></div>
          <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 6 }}>{meta.title}</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{meta.subtitle}</div>
        </div>

        <StepIndicator current={step} labels={labels} />

        {step === 0 && (
          <Step1
            form={form}
            onChange={handleChange}
            keyHints={keyHints}
            loading={loadingConfig}
          />
        )}
        {step === 1 && <Step2 />}
        {step === 2 && <Step3 />}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
          <div>
            {meta.canSkip
              ? <Button variant="ghost" onClick={handleSkip}>跳过，稍后配置</Button>
              : step === 2
                ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>此步骤必须完成</span>
                : null}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && step < 2 && <Button variant="ghost" onClick={handlePrev}>上一步</Button>}
            {step === 2
              ? <Button variant="primary" loading={finishing} onClick={finishSetup}>开始使用</Button>
              : <Button variant="primary" loading={savingConfig} onClick={handleNext}>下一步</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}
