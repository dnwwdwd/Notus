import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { NotusLogo, Icons } from '../components/ui/Icons';
import { Button } from '../components/ui/Button';
import { TextInput } from '../components/ui/Input';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Spinner } from '../components/ui/Spinner';
import { Toggle } from '../components/ui/Toggle';
import { useToast } from '../components/ui/Toast';
import { LlmConfigCardsSection } from '../components/Settings/LlmConfigCardsSection';
import { useApp } from '../contexts/AppContext';
import { useAppStatus } from '../contexts/AppStatusContext';
import { usePlatform } from '../contexts/PlatformContext';
import {
  EMBEDDING_PROVIDERS,
  findProvider,
} from '../lib/modelCatalog';
import { findEmbeddingModelMeta, inferEmbeddingProvider } from '../lib/embeddingForm';
import { desktop as desktopClient } from '../utils/platformClient';

const SETUP_STEP_STORAGE_KEY = 'notus-setup-step';

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

function buildEmbeddingConnectivitySignature({ provider, model, baseUrl, apiKey, apiKeySet, multimodalEnabled }) {
  return JSON.stringify({
    provider: String(provider || '').trim(),
    model: String(model || '').trim(),
    baseUrl: String(baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(apiKey || '').trim() || (apiKeySet ? '__stored__' : ''),
    multimodalEnabled: Boolean(multimodalEnabled),
  });
}

function getImportEntryLabel(file) {
  return file.relativePath || file.webkitRelativePath || file.name;
}

// ── Step1 — model config (horizontal layout) ────────────────────
const Step1 = ({
  form,
  onChange,
  keyHints,
  loading,
  testState,
  onTest,
  testErrorMsg,
  onLlmStateChange,
  detectedEmbDim,
}) => {
  const testButtonStyle = {
    ...(testState === 'success' ? { borderColor: 'var(--success)', color: 'var(--success)' } : {}),
    ...(testState === 'error' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}),
  };

  return (
    <div>
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          <Spinner size={14} />
          正在读取当前配置…
        </div>
      )}

      {/* Two-column layout */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 0.92fr) minmax(0, 1.08fr)', gap: 20, marginBottom: 16 }}>
        {/* Left column: Embedding */}
        <div style={{ background: 'linear-gradient(180deg, rgba(193,95,60,0.04) 0%, var(--bg-elevated) 100%)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-sm)', padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>Embedding 模型</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 5 }}>Base URL</div>
              <TextInput
                value={form.embBaseUrl}
                onChange={(e) => onChange({ embBaseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 5 }}>模型名称</div>
              <TextInput
                value={form.embModel}
                onChange={(e) => onChange({ embModel: e.target.value })}
                placeholder="text-embedding-3-small"
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'end' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 5 }}>API Key</div>
              <TextInput
                value={form.embApiKey}
                onChange={(e) => onChange({ embApiKey: e.target.value })}
                placeholder={keyHints.embedding ? '已保存，留空不修改' : 'sk-…'}
                masked
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 1 }}>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>多模态向量</span>
              <Toggle on={form.embMultimodalEnabled} onChange={(v) => onChange({ embMultimodalEnabled: v })} />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                loading={testState === 'loading'}
                onClick={onTest}
                style={testButtonStyle}
              >
                {testState === 'success' ? '✓ Embedding 正常' : testState === 'error' ? '✕ Embedding 失败' : '测试 Embedding'}
              </Button>
            </div>
          </div>
        </div>

        <div style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.94) 0%, var(--bg-elevated) 100%)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-sm)', padding: 18 }}>
          <LlmConfigCardsSection
            compact
            title="LLM 配置"
            subtitle="问答和创作页会读取这里保存的模型配置。新增或修改接入信息后，必须先测试通过才能保存。"
            onStateChange={onLlmStateChange}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {testErrorMsg && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>{testErrorMsg}</span>
        )}

        {testState === 'success' && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--success)', marginLeft: 4 }}>Embedding 连接成功，可以继续下一步</span>
        )}

        <div style={{ flex: 1 }} />
      </div>
    </div>
  );
};

const Step2 = ({ selectedFiles, onSelectFiles, onClear, runtimeTarget, storageMode, capabilities }) => {
  const fileInputRef = useRef(null);
  const directoryInputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [desktopLoading, setDesktopLoading] = useState(false);

  const handleSelection = (fileList) => {
    const markdownFiles = Array.from(fileList || [])
      .filter((file) => /\.md$/i.test(file.name))
      .reduce((items, file) => {
        const key = getImportEntryLabel(file);
        if (!items.seen.has(key)) {
          items.seen.add(key);
          items.files.push(file);
        }
        return items;
      }, { seen: new Set(), files: [] }).files;

    onSelectFiles(markdownFiles);
  };

  const handleDesktopImport = async () => {
    setDesktopLoading(true);
    try {
      const imported = await desktopClient.pickImportSource();
      handleSelection(imported);
    } finally {
      setDesktopLoading(false);
    }
  };

  const helperText = storageMode === 'managed'
    ? '支持 .md；导入后会复制到 Notus 本机工作区中统一管理。'
    : '支持 .md；也会扫描当前工作目录或已准备好的笔记目录。';

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
          {capabilities?.supportsNativeOpenDialog && (
            <Button variant="secondary" loading={desktopLoading} onClick={handleDesktopImport}>
              从系统目录导入
            </Button>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 20 }}>
          {helperText}
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
            {selectedFiles.slice(0, 2).map((file) => getImportEntryLabel(file)).join('，')}
            {selectedFiles.length > 2 ? ` 等 ${selectedFiles.length} 个文件` : ''}
          </span>
          <button type="button" onClick={onClear} style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>清空</button>
        </div>
      ) : (
        <NoteBox>
          {runtimeTarget === 'electron'
            ? '如果暂时不导入文件，也可以先完成初始化，稍后再把 Markdown 导入到 Notus 的本机工作区。'
            : '如果当前环境已经准备好笔记目录，也可以不选择文件，下一步会直接扫描并建立索引。'}
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
    embMultimodalEnabled: false,
  };
}

function clampSetupStep(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(Math.trunc(parsed), 0), 2);
}

function deriveSetupStep(status) {
  const setup = status?.setup || {};
  const index = status?.index || {};

  if (!setup.model_configured) return 0;

  const hasAnyImportedFile = Number(index.total || setup.total_files || setup.indexed_files || 0) > 0;
  if (hasAnyImportedFile) return 2;

  return 1;
}

function pickResumedStep(restoredStep, derivedStep) {
  if (restoredStep === null || restoredStep === undefined) return derivedStep;
  if (derivedStep === 0) return 0;
  if (derivedStep === 1) return restoredStep >= 2 ? 2 : 1;
  return 2;
}

export default function SetupPage() {
  const router = useRouter();
  const toast = useToast();
  const { syncImportedPaths } = useApp();
  const { status: appStatus, loading: statusLoading, refreshStatus } = useAppStatus();
  const { profile } = usePlatform();
  const [step, setStep] = useState(0);
  const [stepReady, setStepReady] = useState(false);
  const [form, setForm] = useState(createInitialForm);
  const [keyHints, setKeyHints] = useState({ embedding: false });
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [testState, setTestState] = useState('idle'); // 'idle' | 'loading' | 'success' | 'error'
  const [testErrorMsg, setTestErrorMsg] = useState('');
  const [nextBlockedMsg, setNextBlockedMsg] = useState('');
  const [llmState, setLlmState] = useState({ configs: [], activeConfigId: null, loading: true });
  const [detectedEmbDim, setDetectedEmbDim] = useState(null);
  const [testedEmbSignature, setTestedEmbSignature] = useState('');
  const [embeddingVerificationToken, setEmbeddingVerificationToken] = useState('');
  const [selectedImportFiles, setSelectedImportFiles] = useState([]);
  const [step3Started, setStep3Started] = useState(false);
  const [step3Running, setStep3Running] = useState(false);
  const [step3Progress, setStep3Progress] = useState({ stage: 'idle', current: 0, total: 0, currentFile: '' });
  const [step3Summary, setStep3Summary] = useState(null);
  const [step3Errors, setStep3Errors] = useState([]);

  useEffect(() => {
    if (!router.isReady || statusLoading) return;
    if (!appStatus?.setup?.completed) return;
    router.replace(appStatus.needsIndexing ? '/indexing' : '/files');
  }, [appStatus?.setup?.completed, appStatus.needsIndexing, router, statusLoading]);

  useEffect(() => {
    if (statusLoading || stepReady) return;

    let restoredStep = null;
    if (typeof window !== 'undefined') {
      const raw = window.sessionStorage.getItem(SETUP_STEP_STORAGE_KEY);
      if (raw !== null) restoredStep = clampSetupStep(raw);
    }

    const derivedStep = deriveSetupStep(appStatus);
    const nextStep = pickResumedStep(restoredStep, derivedStep);

    setStep(nextStep);
    setStepReady(true);
  }, [appStatus, statusLoading, stepReady]);

  useEffect(() => {
    if (!stepReady || typeof window === 'undefined') return;
    window.sessionStorage.setItem(SETUP_STEP_STORAGE_KEY, String(step));
  }, [step, stepReady]);

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
          embMultimodalEnabled: Boolean(settings.embedding?.multimodal_enabled),
        }));
        setDetectedEmbDim(Number(settings.embedding?.dim || 0) || null);
        setKeyHints({
          embedding: Boolean(settings.embedding?.api_key_set),
        });
        setTestedEmbSignature('');
        setEmbeddingVerificationToken('');
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
    const nextBaseUrl = patch.embBaseUrl ?? form.embBaseUrl;
    const nextModel = patch.embModel ?? form.embModel;
    const nextProvider = inferEmbeddingProvider({ baseUrl: nextBaseUrl, model: nextModel });

    setForm((prev) => ({ ...prev, ...patch, embProvider: nextProvider }));
    const testFields = ['embModel', 'embApiKey', 'embBaseUrl', 'embProvider', 'embMultimodalEnabled'];
    if (testFields.some((field) => field in patch)) {
      setTestState('idle');
      setTestErrorMsg('');
      setNextBlockedMsg('');
      setTestedEmbSignature('');
      setEmbeddingVerificationToken('');
      if (patch.embModel !== undefined || patch.embBaseUrl !== undefined || patch.embProvider !== undefined) {
        const knownDim = findEmbeddingModelMeta({
          baseUrl: nextBaseUrl,
          model: nextModel,
        })?.dimension;
        setDetectedEmbDim(Number(knownDim || 0) || null);
      }
    }
  };

  const handleTest = async () => {
    const embModel = form.embModel.trim();
    const resolvedProvider = inferEmbeddingProvider({ provider: form.embProvider, baseUrl: form.embBaseUrl, model: embModel });

    if (!embModel) { toast('请填写 Embedding 模型名', 'warning'); return; }

    setTestState('loading');
    setTestErrorMsg('');
    try {
      const embResponse = await fetch('/api/settings/test', {
        method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'embedding',
          config: {
            model: embModel,
            api_key: form.embApiKey,
            base_url: form.embBaseUrl,
            multimodal_enabled: form.embMultimodalEnabled,
          },
        }),
      });
      const embResult = await embResponse.json();
      if (!embResult.success) throw new Error(embResult.error || 'Embedding 连接失败');

      setDetectedEmbDim(Number(embResult.dimension || 0) || null);
      setForm((prev) => ({ ...prev, embProvider: embResult.provider || inferEmbeddingProvider({ provider: prev.embProvider, baseUrl: prev.embBaseUrl, model: prev.embModel }) }));
      setTestState('success');
      setTestedEmbSignature(buildEmbeddingConnectivitySignature({
        provider: embResult.provider || resolvedProvider,
        model: embModel,
        baseUrl: form.embBaseUrl,
        apiKey: form.embApiKey,
        apiKeySet: keyHints.embedding,
        multimodalEnabled: form.embMultimodalEnabled,
      }));
      setEmbeddingVerificationToken(embResult.verification_token || '');
      setNextBlockedMsg('');
    } catch (err) {
      setTestState('error');
      setTestedEmbSignature('');
      setEmbeddingVerificationToken('');
      setTestErrorMsg(err.message || '连接失败，请检查配置');
    }
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
      subtitle: '配好 Embedding 和 LLM 后，就能使用知识库问答和 AI 创作；也可以先跳过，稍后再配。',
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
  const currentEmbeddingSignature = buildEmbeddingConnectivitySignature({
    provider: inferEmbeddingProvider({ provider: form.embProvider, baseUrl: form.embBaseUrl, model: form.embModel }),
    model: form.embModel,
    baseUrl: form.embBaseUrl,
    apiKey: form.embApiKey,
    apiKeySet: keyHints.embedding,
    multimodalEnabled: form.embMultimodalEnabled,
  });
  const isEmbeddingTestCurrent = testState === 'success'
    && testedEmbSignature === currentEmbeddingSignature
    && Boolean(embeddingVerificationToken);

  const persistModelConfig = async () => {
    const effectiveEmbModel = form.embModel.trim();
    const resolvedProvider = inferEmbeddingProvider({ provider: form.embProvider, baseUrl: form.embBaseUrl, model: effectiveEmbModel });
    const embDim = Number(detectedEmbDim || 0) || null;

    if (!effectiveEmbModel) {
      toast('请填写 Embedding 模型名', 'warning');
      return false;
    }
    if (!isEmbeddingTestCurrent) {
      toast('请先测试当前 Embedding 配置，测试通过后才能保存', 'warning');
      return false;
    }
    if (!embDim) {
      toast('请先测试 Embedding 连接，自动识别当前模型的向量维度', 'warning');
      return false;
    }

    setSavingConfig(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embedding: {
            provider: resolvedProvider,
            model: effectiveEmbModel,
            dim: embDim,
            base_url: form.embBaseUrl,
            api_key: form.embApiKey,
            multimodal_enabled: form.embMultimodalEnabled,
            verification_token: embeddingVerificationToken,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '保存失败');

      setForm((prev) => ({
        ...prev,
        embApiKey: '',
      }));
      setDetectedEmbDim(embDim);
      setKeyHints({
        embedding: Boolean(payload.embedding?.api_key_set),
      });
      setTestState('idle');
      setTestedEmbSignature('');
      setEmbeddingVerificationToken('');
      toast('Embedding 配置已保存', 'success');
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
      if (typeof window !== 'undefined') {
        window.sessionStorage.removeItem(SETUP_STEP_STORAGE_KEY);
      }
      router.replace(latest.index.total > 0 && latest.index.pending > 0 ? '/indexing' : '/files');
    } catch (error) {
      toast(error.message || '初始化完成失败', 'warning');
    } finally {
      setFinishing(false);
    }
  };

  const importSelectedFiles = async () => {
    if (selectedImportFiles.length === 0) {
      return {
        summary: null,
        importedPaths: [],
      };
    }

    const payloadFiles = await Promise.all(
      selectedImportFiles.map(async (file) => ({
        name: getImportEntryLabel(file),
        content: await file.text(),
      }))
    );

    let summary = null;
    const importedPaths = [];
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
      if (event.type === 'file' && ['imported', 'overwritten'].includes(event.status) && event.path) {
        importedPaths.push(String(event.path));
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

    return {
      summary,
      importedPaths,
    };
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
      const importedFromDirectory = selectedImportFiles.some((file) => getImportEntryLabel(file).includes('/'));
      const importResult = await importSelectedFiles();
      const importedPaths = importResult?.importedPaths || [];
      if (importedPaths.length > 0) {
        await syncImportedPaths(importedPaths, {
          rootsOnly: importedFromDirectory,
          selectPath: !importedFromDirectory && importedPaths.length === 1 ? importedPaths[0] : '',
        });
      }
      let latest = await refreshStatus({ quiet: true });
      const shouldRebuild = latest.index.total > 0 &&
        (latest.index.pending > 0 || latest.index.failed > 0 || latest.index.indexed < latest.index.total);

      if (shouldRebuild) {
        await rebuildIndex();
        latest = await refreshStatus({ quiet: true });
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
      if (llmState.loading) {
        setNextBlockedMsg('正在读取 LLM 配置，请稍后再试。');
        return;
      }

      const missing = [];
      if (!isEmbeddingTestCurrent) missing.push('Embedding 测试并保存');
      if (llmState.configs.length === 0) missing.push('至少一个可用的 LLM 配置');
      if (missing.length > 0) {
        setNextBlockedMsg(`进入下一步前，需要先完成${missing.join('，并准备好')}；如果暂时不配置，可以点击“跳过，稍后配置”。`);
        return;
      }
      const saved = await persistModelConfig();
      if (!saved) return;
      setNextBlockedMsg('');
    }

    if (step < 2) {
      if (step === 1) resetStep3();
      setStep(step + 1);
    }
  };

  const handleSkip = () => {
    setNextBlockedMsg('');
    setStep((prev) => Math.min(prev + 1, 2));
  };
  const handlePrev = () => {
    setNextBlockedMsg('');
    if (step > 0) setStep(step - 1);
  };

  if (!stepReady) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
          <Spinner size={18} />
          <span>正在恢复引导进度…</span>
        </div>
      </div>
    );
  }

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
      <div style={{ maxWidth: step === 0 ? 1180 : 760, width: '100%', padding: 24 }}>
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
            testState={testState}
            onTest={handleTest}
            testErrorMsg={testErrorMsg}
            onLlmStateChange={setLlmState}
            detectedEmbDim={detectedEmbDim}
          />
        )}
        {step === 1 && (
          <Step2
            selectedFiles={selectedImportFiles}
            onSelectFiles={handleSelectImportFiles}
            onClear={() => handleSelectImportFiles([])}
            runtimeTarget={profile.runtimeTarget}
            storageMode={profile.storageMode}
            capabilities={profile.capabilities}
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

        {nextBlockedMsg && (
          <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--danger-subtle)', border: '1px solid var(--danger)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>
            {nextBlockedMsg}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
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
