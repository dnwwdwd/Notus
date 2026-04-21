import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { NotusLogo, Icons } from '../components/ui/Icons';
import { Button } from '../components/ui/Button';
import { ModelSelectField } from '../components/ui/ModelSelectField';
import { TextInput } from '../components/ui/Input';
import { ProviderSelect } from '../components/ui/ProviderSelect';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Spinner } from '../components/ui/Spinner';
import { Toggle } from '../components/ui/Toggle';
import { useToast } from '../components/ui/Toast';
import { useAppStatus } from '../contexts/AppStatusContext';
import { useDiscoveredModels } from '../hooks/useDiscoveredModels';
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

async function consumeSseResponse(response, onPayload) {
  if (!response.ok) {
    let message = '请求失败';
    try {
      const payload = await response.json();
      message = payload.error || message;
    } catch {
      message = await response.text();
    }
    throw new Error(message);
  }
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
      onPayload(JSON.parse(line.slice(5)));
    });
  }

  if (buffer.trim()) {
    const line = buffer.split('\n').find((item) => item.startsWith('data:'));
    if (line) onPayload(JSON.parse(line.slice(5)));
  }
}

const Step1 = ({
  form,
  onChange,
  keyHints,
  loading,
  embeddingOptions,
  embeddingLoading,
  llmOptions,
  llmLoading,
}) => {
  const currentEmbProvider = findProvider(EMBEDDING_PROVIDERS, form.embProvider);
  const currentLlmProvider = findProvider(LLM_PROVIDERS, form.llmProvider);
  const isCustomEmbProvider = form.embProvider === 'custom';
  const isCustomLlmProvider = form.llmProvider === 'custom';
  const effectiveEmbeddingModel = form.embModel;
  const selectedEmbeddingModel = getEmbeddingModelMeta(form.embProvider, form.embModel);
  const embeddingModelSupportsMultimodal = useMemo(
    () => isEmbeddingModelMultimodal(form.embProvider, effectiveEmbeddingModel),
    [effectiveEmbeddingModel, form.embProvider]
  );
  const embDim = selectedEmbeddingModel?.dimension || form.embCustomDim || '—';

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
                embModel: provider.models[0]?.value || form.embModel,
              });
            }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <TextInput
            value={form.embBaseUrl}
            onChange={(event) => onChange({ embBaseUrl: event.target.value })}
            placeholder="https://your-openai-compatible-endpoint/v1"
            disabled={!isCustomEmbProvider}
            style={{ opacity: isCustomEmbProvider ? 1 : 0.65 }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <ModelSelectField
            value={form.embModel}
            options={embeddingOptions}
            onChange={(nextValue) => onChange({ embModel: nextValue })}
            loading={embeddingLoading}
            selectPlaceholder={currentEmbProvider.models.length ? '选择候选 Embedding 模型' : '当前提供商没有内置候选'}
            inputPlaceholder="也可以直接输入 Embedding 模型名"
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <TextInput
            value={form.embApiKey}
            onChange={(event) => onChange({ embApiKey: event.target.value })}
            placeholder={keyHints.embedding ? '已保存，留空不修改' : 'sk-...'}
            masked
          />
        </div>
        <div style={{ marginBottom: 14 }}>
          <TextInput
            value={selectedEmbeddingModel?.dimension || form.embCustomDim}
            onChange={(event) => onChange({ embCustomDim: event.target.value })}
            placeholder="向量维度，例如 1024"
            disabled={Boolean(selectedEmbeddingModel)}
            style={{ opacity: selectedEmbeddingModel ? 0.65 : 1 }}
          />
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-tertiary)' }}>
            当前向量维度：{embDim}
          </div>
        </div>

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
                llmModel: provider.models[0]?.value || form.llmModel,
              });
            }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <TextInput
            value={form.llmBaseUrl}
            onChange={(event) => onChange({ llmBaseUrl: event.target.value })}
            placeholder="https://your-openai-compatible-endpoint/v1"
            disabled={!isCustomLlmProvider}
            style={{ opacity: isCustomLlmProvider ? 1 : 0.65 }}
          />
        </div>
        <div style={{ marginBottom: 10 }}>
          <ModelSelectField
            value={form.llmModel}
            options={llmOptions}
            onChange={(nextValue) => onChange({ llmModel: nextValue })}
            loading={llmLoading}
            selectPlaceholder={currentLlmProvider.models.length ? '选择候选 LLM 模型' : '当前提供商没有内置候选'}
            inputPlaceholder="也可以直接输入 LLM 模型名"
          />
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

const Step2 = ({ selectedFiles, onSelectFiles, onClear }) => {
  const fileInputRef = useRef(null);
  const directoryInputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleSelection = (fileList) => {
    const markdownFiles = Array.from(fileList || [])
      .filter((file) => /\.md$/i.test(file.name))
      .reduce((items, file) => {
        const key = file.webkitRelativePath || file.name;
        if (!items.seen.has(key)) {
          items.seen.add(key);
          items.files.push(file);
        }
        return items;
      }, { seen: new Set(), files: [] }).files;

    onSelectFiles(markdownFiles);
  };

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,text/markdown"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => handleSelection(event.target.files)}
      />
      <input
        ref={directoryInputRef}
        type="file"
        accept=".md,text/markdown"
        multiple
        webkitdirectory=""
        directory=""
        style={{ display: 'none' }}
        onChange={(event) => handleSelection(event.target.files)}
      />
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleSelection(e.dataTransfer.files); }}
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
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
          <Button variant="secondary" onClick={() => fileInputRef.current?.click()}>选择 Markdown 文件</Button>
          <Button variant="secondary" onClick={() => directoryInputRef.current?.click()}>选择文件夹</Button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 20 }}>
          支持 .md · 也会扫描已挂载到笔记目录中的文件
        </div>
      </div>
      {selectedFiles.length > 0 ? (
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
          <span style={{ fontSize: 'var(--text-sm)', flex: 1, fontFamily: 'var(--font-mono)' }}>
            {selectedFiles.slice(0, 2).map((file) => file.webkitRelativePath || file.name).join('，')}
            {selectedFiles.length > 2 ? ` 等 ${selectedFiles.length} 个文件` : ''}
          </span>
          <button type="button" onClick={onClear} style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>清空</button>
        </div>
      ) : (
        <NoteBox>
          如果你已经在懒猫微服里挂载了笔记目录，可以不选择文件，下一步会直接扫描并建立索引。
        </NoteBox>
      )}
    </div>
  );
};

const Step3 = ({ running, progress, indexStatus, summary, errors }) => {
  const total = Number(indexStatus?.total || progress.total || 0);
  const indexed = Number(indexStatus?.indexed || 0);
  const failed = Number(indexStatus?.failed || 0);
  const pending = Number(indexStatus?.pending || 0);
  const progressValue = progress.total
    ? Math.round((Math.min(progress.current, progress.total) / progress.total) * 100)
    : (total > 0 ? Math.round((indexed / total) * 100) : 100);
  const countLabel = progress.total
    ? `${Math.min(progress.current, progress.total)} / ${progress.total} 篇`
    : `${indexed} / ${total} 篇`;
  const statusText = running
    ? (progress.currentFile ? `→ ${progress.currentFile}` : '正在准备索引任务…')
    : (total === 0 ? '当前目录还没有 Markdown 文件' : '索引任务已完成');

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
          <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>{countLabel}</div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {running ? (progress.stage === 'importing' || progress.stage === 'saving' ? '正在导入' : '正在索引') : (failed > 0 || (summary?.warnings || 0) > 0 ? '存在异常项' : '已完成')}
          </div>
        </div>
        <ProgressBar value={progressValue} max={100} />
        <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 8 }}>
          {running ? <Spinner size={12} /> : <Icons.check size={12} />}
          <span>{statusText}</span>
        </div>
        <div style={{ height: 1, background: 'var(--border-subtle)', margin: '18px 0' }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          {[
            { n: indexed, l: '已索引文件' },
            { n: pending, l: '待处理文件' },
            { n: failed, l: '失败文件' },
          ].map((s, i) => (
            <div key={i}>
              <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, fontFamily: 'var(--font-editor)' }}>{s.n}</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>
      {summary && (
        <div style={{ marginBottom: 12 }}>
          <NoteBox tone={summary.failed > 0 || (summary.warnings || 0) > 0 ? 'warning' : 'success'}>
            本轮处理完成：新增索引 {summary.indexed || 0}，跳过 {summary.skipped || 0}，告警 {summary.warnings || 0}，失败 {summary.failed || 0}。
          </NoteBox>
        </div>
      )}
      {errors.length > 0 && (
        <div style={{ maxHeight: 120, overflow: 'auto', display: 'grid', gap: 6, marginBottom: 12 }}>
          {errors.slice(0, 5).map((item, index) => (
            <div key={`${item.path || item.name}-${index}`} style={{ padding: '8px 10px', borderRadius: 'var(--radius-md)', background: 'var(--warning-subtle)', color: 'var(--warning)', fontSize: 'var(--text-xs)' }}>
              {item.path || item.name}：{item.error}
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' }}>
        完成后你可以进入 Notus；也可以稍后在设置中重建索引。
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
  const { status: appStatus, refreshStatus } = useAppStatus();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(createInitialForm);
  const [keyHints, setKeyHints] = useState({ embedding: false, llm: false });
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [selectedImportFiles, setSelectedImportFiles] = useState([]);
  const [step3Started, setStep3Started] = useState(false);
  const [step3Running, setStep3Running] = useState(false);
  const [step3Progress, setStep3Progress] = useState({ stage: 'idle', current: 0, total: 0, currentFile: '' });
  const [step3Summary, setStep3Summary] = useState(null);
  const [step3Errors, setStep3Errors] = useState([]);
  const currentEmbeddingProvider = useMemo(
    () => findProvider(EMBEDDING_PROVIDERS, form.embProvider),
    [form.embProvider]
  );
  const currentLlmProvider = useMemo(
    () => findProvider(LLM_PROVIDERS, form.llmProvider),
    [form.llmProvider]
  );
  const embeddingDiscovery = useDiscoveredModels({
    kind: 'embedding',
    provider: form.embProvider,
    baseUrl: form.embBaseUrl,
    apiKey: form.embApiKey,
    fallbackOptions: currentEmbeddingProvider.models,
  });
  const llmDiscovery = useDiscoveredModels({
    kind: 'llm',
    provider: form.llmProvider,
    baseUrl: form.llmBaseUrl,
    apiKey: form.llmApiKey,
    fallbackOptions: currentLlmProvider.models,
  });

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
          embCustomDim: String(settings.embedding?.dim || prev.embCustomDim || ''),
          embMultimodalEnabled: Boolean(settings.embedding?.multimodal_enabled),
          llmProvider: settings.llm?.provider || prev.llmProvider,
          llmModel: settings.llm?.model || prev.llmModel,
          llmBaseUrl: settings.llm?.base_url || prev.llmBaseUrl,
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

  const resetStep3 = () => {
    setStep3Started(false);
    setStep3Running(false);
    setStep3Progress({ stage: 'idle', current: 0, total: 0, currentFile: '' });
    setStep3Summary(null);
    setStep3Errors([]);
  };

  const handleSelectImportFiles = (files) => {
    setSelectedImportFiles(files);
    resetStep3();
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
    const effectiveEmbModel = form.embModel.trim();
    const effectiveLlmModel = form.llmModel.trim();
    const embDim = getEmbeddingModelMeta(form.embProvider, effectiveEmbModel)?.dimension || form.embCustomDim.trim();

    if (!effectiveEmbModel) {
      toast('请填写 Embedding 模型名', 'warning');
      return false;
    }
    if (!effectiveLlmModel) {
      toast('请填写 LLM 模型名', 'warning');
      return false;
    }
    if (!embDim) {
      toast('请填写 Embedding 向量维度', 'warning');
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
    if (step3Running) return;
    setFinishing(true);
    try {
      const response = await fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '初始化完成失败');
      const latest = await refreshStatus();
      router.replace(latest.index.total > 0 && latest.index.pending > 0 ? '/indexing' : '/files');
    } catch (error) {
      toast(error.message || '初始化完成失败', 'warning');
    } finally {
      setFinishing(false);
    }
  };

  const importSelectedFiles = async () => {
    if (selectedImportFiles.length === 0) return null;

    const payloadFiles = await Promise.all(
      selectedImportFiles.map(async (file) => ({
        name: file.webkitRelativePath || file.name,
        content: await file.text(),
      }))
    );

    let summary = null;
    const response = await fetch('/api/files/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conflict_policy: 'skip',
        files: payloadFiles,
      }),
    });

    await consumeSseResponse(response, (event) => {
      if (event.type === 'progress') {
        setStep3Progress({
          stage: event.stage || 'importing',
          current: event.current || 0,
          total: event.total || payloadFiles.length,
          currentFile: event.currentFile || '',
        });
      }
      if (event.type === 'file' && (event.status === 'failed' || event.warning)) {
        setStep3Errors((prev) => [...prev, { name: event.name, path: event.path, error: event.error || event.warning }]);
      }
      if (event.type === 'done') {
        summary = {
          indexed: Math.max((event.imported || 0) + (event.overwritten || 0) - (event.warnings || 0), 0),
          skipped: event.skipped || 0,
          warnings: event.warnings || 0,
          failed: event.failed || 0,
          errors: [...(event.errors || []), ...(event.warning_items || [])],
        };
        setStep3Summary(summary);
        if (event.errors?.length || event.warning_items?.length) {
          setStep3Errors((prev) => [...prev, ...(event.errors || []), ...(event.warning_items || [])]);
        }
      }
    });

    return summary;
  };

  const rebuildIndex = async () => {
    let summary = null;
    const response = await fetch('/api/index/rebuild', { method: 'POST' });

    await consumeSseResponse(response, (event) => {
      if (event.type === 'progress') {
        setStep3Progress({
          stage: 'indexing',
          current: event.current || 0,
          total: event.total || 0,
          currentFile: event.currentFile || '',
        });
        if (event.status === 'failed' && event.error) {
          setStep3Errors((prev) => [...prev, { path: event.currentFile, error: event.error }]);
        }
      }
      if (event.type === 'done') {
        summary = event;
        setStep3Summary(event);
        if (event.errors?.length) setStep3Errors((prev) => [...prev, ...event.errors]);
      }
      if (event.type === 'error') {
        throw new Error(event.error || '索引重建失败');
      }
    });

    return summary;
  };

  const runInitialSetupPipeline = async () => {
    setStep3Running(true);
    setStep3Summary(null);
    setStep3Errors([]);
    setStep3Progress({ stage: 'idle', current: 0, total: 0, currentFile: '' });

    try {
      await importSelectedFiles();
      let latest = await refreshStatus();
      const shouldRebuild = latest.index.total > 0 &&
        (latest.index.pending > 0 || latest.index.failed > 0 || latest.index.indexed < latest.index.total);

      if (shouldRebuild) {
        await rebuildIndex();
        latest = await refreshStatus();
      }

      if (latest.index.total === 0) {
        setStep3Progress({ stage: 'done', current: 0, total: 0, currentFile: '' });
      }
    } catch (error) {
      toast(error.message || '初始化索引失败', 'warning');
    } finally {
      setStep3Running(false);
      setStep3Started(true);
    }
  };

  useEffect(() => {
    if (step !== 2 || step3Started || step3Running) return;
    runInitialSetupPipeline();
  }, [step, step3Started, step3Running]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNext = async () => {
    if (step === 0) {
      const saved = await persistModelConfig();
      if (!saved) return;
    }

    if (step < 2) {
      if (step === 1) resetStep3();
      setStep(step + 1);
    }
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
            embeddingOptions={embeddingDiscovery.models}
            embeddingLoading={embeddingDiscovery.loading}
            llmOptions={llmDiscovery.models}
            llmLoading={llmDiscovery.loading}
          />
        )}
        {step === 1 && (
          <Step2
            selectedFiles={selectedImportFiles}
            onSelectFiles={handleSelectImportFiles}
            onClear={() => handleSelectImportFiles([])}
          />
        )}
        {step === 2 && (
          <Step3
            running={step3Running}
            progress={step3Progress}
            indexStatus={appStatus.index}
            summary={step3Summary}
            errors={step3Errors}
          />
        )}

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
              ? <Button variant="primary" loading={finishing || step3Running} onClick={finishSetup}>开始使用</Button>
              : <Button variant="primary" loading={savingConfig} onClick={handleNext}>下一步</Button>}
          </div>
        </div>
      </div>
    </div>
  );
}
