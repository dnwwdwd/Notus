import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../ui/Toast';
import { Button } from '../ui/Button';
import { Dialog, ConfirmDialog } from '../ui/Dialog';
import { TextInput } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Icons } from '../ui/Icons';
import { useLlmConfigs } from '../../hooks/useLlmConfigs';
import { inferLlmProvider, resolveLlmProviderLabel } from '../../lib/llmForm';

function createDraft(config = null) {
  const model = config?.model || '';
  const baseUrl = config?.base_url || '';
  return {
    id: config?.id || null,
    name: config?.name || '',
    provider: inferLlmProvider({ baseUrl, model }),
    model,
    baseUrl,
    apiKey: '',
    apiKeySet: Boolean(config?.api_key_set),
    setDefault: Boolean(config?.is_active),
    lastTestLatencyMs: config?.last_test_latency_ms || null,
    contextWindowTokens: config?.context_window_tokens || null,
    maxOutputTokens: config?.max_output_tokens || null,
  };
}

function buildConnectivitySignature(draft) {
  const resolvedProvider = inferLlmProvider({ baseUrl: draft.baseUrl, model: draft.model });
  return JSON.stringify({
    provider: String(resolvedProvider || '').trim(),
    model: String(draft.model || '').trim(),
    baseUrl: String(draft.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(draft.apiKey || '').trim() || (draft.apiKeySet ? '__stored__' : ''),
  });
}

function ConfigCard({ item, onEdit, onDelete, onSetDefault, compact = false }) {
  const providerLabel = resolveLlmProviderLabel(item.provider);
  const shellTint = item.is_active ? 'rgba(193,95,60,0.08)' : 'rgba(255,255,255,0.72)';
  return (
    <div
      style={{
        border: `1px solid ${item.is_active ? 'rgba(193,95,60,0.26)' : 'var(--border-subtle)'}`,
        borderRadius: 18,
        background: `linear-gradient(180deg, ${shellTint} 0%, var(--bg-elevated) 100%)`,
        boxShadow: item.is_active ? '0 10px 24px rgba(193,95,60,0.08)' : '0 8px 18px rgba(26,19,17,0.05)',
        padding: compact ? 16 : 18,
        display: 'grid',
        gap: compact ? 10 : 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: compact ? 'wrap' : 'nowrap' }}>
        <div style={{ minWidth: 0, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <div
            style={{
              width: compact ? 38 : 42,
              height: compact ? 38 : 42,
              borderRadius: 14,
              background: item.is_active ? 'var(--accent-subtle)' : 'rgba(193,95,60,0.08)',
              color: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icons.robot size={compact ? 18 : 20} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              <div style={{ fontSize: compact ? 'var(--text-sm)' : 'var(--text-base)', fontWeight: 600 }}>{item.name}</div>
              <Badge tone="default">{providerLabel}</Badge>
            {item.is_active ? <Badge tone="accent">默认配置</Badge> : null}
            {item.api_key_set ? <Badge tone="success">已保存密钥</Badge> : <Badge tone="warning">待补密钥</Badge>}
          </div>
            <div style={{ fontSize: compact ? 12 : 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
              直接连接你自己的模型服务，不经过中间代理。
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
          {!item.is_active ? (
            <Button variant="ghost" size="sm" onClick={() => onSetDefault(item)}>
              设为默认
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => onEdit(item)}>编辑</Button>
          <Button variant="ghost" size="sm" onClick={() => onDelete(item)}>删除</Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'minmax(0, 0.95fr) minmax(0, 1.05fr)', gap: 10 }}>
        <div style={{ padding: compact ? '11px 12px' : '12px 13px', border: '1px solid var(--border-subtle)', borderRadius: 14, background: 'var(--bg-primary)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 5 }}>模型名称</div>
          <div style={{ fontSize: compact ? 12 : 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 600, wordBreak: 'break-all' }}>{item.model}</div>
        </div>
        <div style={{ padding: compact ? '11px 12px' : '12px 13px', border: '1px solid var(--border-subtle)', borderRadius: 14, background: 'var(--bg-primary)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 5 }}>Base URL</div>
          <div style={{ fontSize: compact ? 12 : 'var(--text-sm)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>{item.base_url}</div>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
          padding: compact ? '10px 12px' : '11px 13px',
          borderRadius: 14,
          background: item.is_active ? 'rgba(193,95,60,0.06)' : 'rgba(26,19,17,0.03)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ color: item.is_active ? 'var(--accent)' : 'var(--text-tertiary)', display: 'inline-flex' }}>
            <Icons.sparkles size={14} />
          </span>
          <div style={{ fontSize: compact ? 12 : 'var(--text-sm)', color: 'var(--text-secondary)', minWidth: 0 }}>
            {item.is_active ? '当前知识库和创作页默认使用这套模型配置。' : '可切换为默认配置，供知识库和创作页直接调用。'}
          </div>
        </div>
        <Badge tone={item.api_key_set ? 'success' : 'warning'}>{item.api_key_set ? '配置完整' : '需补充 Key'}</Badge>
      </div>
    </div>
  );
}

export function LlmConfigCardsSection({
  title = 'LLM 配置',
  subtitle = '通过配置卡片管理所有可用的大模型接入。',
  onStateChange,
  compact = false,
}) {
  const toast = useToast();
  const { configs, activeConfigId, loading, createConfig, updateConfig, deleteConfig, setActiveConfig } = useLlmConfigs();
  const [dialogMode, setDialogMode] = useState(null);
  const [draft, setDraft] = useState(createDraft());
  const [testState, setTestState] = useState('idle');
  const [testing, setTesting] = useState(false);
  const [testedSignature, setTestedSignature] = useState('');
  const [verificationToken, setVerificationToken] = useState('');
  const [testError, setTestError] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const resolvedProvider = useMemo(
    () => inferLlmProvider({ baseUrl: draft.baseUrl, model: draft.model }),
    [draft.baseUrl, draft.model]
  );
  const resolvedProviderLabel = useMemo(
    () => resolveLlmProviderLabel(resolvedProvider),
    [resolvedProvider]
  );

  useEffect(() => {
    onStateChange?.({ configs, activeConfigId, loading });
  }, [activeConfigId, configs, loading, onStateChange]);

  useEffect(() => {
    if (!dialogMode) return;
    const currentSignature = buildConnectivitySignature(draft);
    if (testedSignature && currentSignature !== testedSignature) {
      setTestState('idle');
      setVerificationToken('');
      setTestError('');
    }
  }, [dialogMode, draft, testedSignature]);

  const openCreate = () => {
    const nextDraft = {
      id: null,
      name: '',
      provider: 'custom',
      model: '',
      baseUrl: '',
      apiKey: '',
      apiKeySet: false,
      setDefault: configs.length === 0,
      lastTestLatencyMs: null,
      contextWindowTokens: null,
      maxOutputTokens: null,
    };
    setDraft(nextDraft);
    setTestState('idle');
    setTesting(false);
    setVerificationToken('');
    setTestError('');
    setTestedSignature('');
    setDialogMode('create');
  };

  const openEdit = (item) => {
    setDraft(createDraft(item));
    setTestState('idle');
    setTesting(false);
    setVerificationToken('');
    setTestError('');
    setTestedSignature('');
    setDialogMode('edit');
  };

  const closeDialog = () => {
    if (testing || submitting) return;
    setDialogMode(null);
    setDraft(createDraft());
    setTestState('idle');
    setTestError('');
    setTestedSignature('');
    setVerificationToken('');
  };

  const connectivitySignature = useMemo(
    () => buildConnectivitySignature(draft),
    [draft]
  );
  const canSubmit = testState === 'success' && testedSignature === connectivitySignature && Boolean(verificationToken) && !testing && !submitting;

  const handleTest = async () => {
    if (!String(draft.name || '').trim()) {
      toast('请填写配置名称', 'warning');
      return;
    }
    if (!String(draft.model || '').trim()) {
      toast('请填写 LLM 模型名称', 'warning');
      return;
    }
    if (!String(draft.baseUrl || '').trim()) {
      toast('请填写 LLM Base URL', 'warning');
      return;
    }
    if (!String(draft.apiKey || '').trim() && !draft.apiKeySet) {
      toast('请填写 LLM API Key', 'warning');
      return;
    }

    setTesting(true);
    setTestState('loading');
    setTestError('');
    try {
      const response = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'llm',
          llm_config_id: dialogMode === 'edit' ? draft.id : undefined,
          config: {
            provider: resolvedProvider,
            model: String(draft.model || '').trim(),
            base_url: String(draft.baseUrl || '').trim(),
            api_key: String(draft.apiKey || '').trim(),
          },
        }),
      });
      const payload = await response.json();
      if (!payload.success) {
        throw new Error(payload.error || 'LLM 连接测试失败');
      }
      setDraft((prev) => ({ ...prev, lastTestLatencyMs: payload.latency_ms || null }));
      setTestState('success');
      setTestedSignature(connectivitySignature);
      setVerificationToken(payload.verification_token || '');
      setTestError('');
      toast('LLM 连接测试成功', 'success');
    } catch (error) {
      setTestState('error');
      setVerificationToken('');
      setTestError(error.message || 'LLM 连接测试失败');
      toast(error.message || 'LLM 连接测试失败', 'error');
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      toast('请先完成连接测试并保持测试结果为最新', 'warning');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name: String(draft.name || '').trim(),
        provider: resolvedProvider,
        model: String(draft.model || '').trim(),
        base_url: String(draft.baseUrl || '').trim(),
        api_key: String(draft.apiKey || '').trim(),
        set_default: draft.setDefault,
        last_test_latency_ms: draft.lastTestLatencyMs,
        verification_token: verificationToken,
      };

      if (dialogMode === 'edit') {
        await updateConfig(draft.id, payload);
        toast('LLM 配置已更新', 'success');
      } else {
        await createConfig(payload);
        toast('LLM 配置已添加', 'success');
      }
      closeDialog();
    } catch (error) {
      toast(error.message || '保存 LLM 配置失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: compact ? 14 : 18 }}>
        <div>
          <div style={{ fontSize: compact ? 'var(--text-base)' : 'var(--text-xl)', fontWeight: 600, marginBottom: 6 }}>{title}</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{subtitle}</div>
        </div>
        <Button variant="primary" onClick={openCreate}>新增配置</Button>
      </div>

      {loading ? (
        <div style={{ padding: '18px 16px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
          正在读取 LLM 配置…
        </div>
      ) : configs.length === 0 ? (
        <div style={{ padding: '28px 24px', border: '1px dashed var(--border-primary)', borderRadius: 'var(--radius-xl)', background: 'var(--bg-elevated)', textAlign: 'center' }}>
          <div style={{ color: 'var(--text-tertiary)', display: 'inline-flex', marginBottom: 12 }}><Icons.robot size={28} /></div>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 6 }}>还没有可用的 LLM 配置</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
            通过“新增配置”创建模型接入；添加前必须先测试连通性。
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {configs.map((item) => (
            <ConfigCard
              key={item.id}
              item={item}
              compact={compact}
              onEdit={openEdit}
              onDelete={setPendingDelete}
              onSetDefault={async (target) => {
                try {
                  await setActiveConfig(target.id);
                  toast(`已将“${target.name}”设为默认配置`, 'success');
                } catch (error) {
                  toast(error.message || '切换默认配置失败', 'error');
                }
              }}
            />
          ))}
        </div>
      )}

      <Dialog
        open={Boolean(dialogMode)}
        onClose={closeDialog}
        title={dialogMode === 'edit' ? '编辑 LLM 配置' : '新增 LLM 配置'}
        maxWidth={560}
        footer={(
          <>
            <Button variant="ghost" onClick={closeDialog}>取消</Button>
            <Button variant="secondary" loading={testing} onClick={handleTest}>
              {testState === 'success' && testedSignature === connectivitySignature ? '已测试成功' : '测试连通性'}
            </Button>
            <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={handleSubmit}>
              {dialogMode === 'edit' ? '保存修改' : '添加配置'}
            </Button>
          </>
        )}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>配置名称</div>
            <TextInput
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="例如：通义主力、OpenAI 备用"
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>Base URL</div>
              <TextInput
                value={draft.baseUrl}
                onChange={(event) => setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>模型名称</div>
              <TextInput
                value={draft.model}
                onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))}
                placeholder="例如：gpt-4o、claude-sonnet-4、qwen-max"
              />
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>API Key</div>
            <TextInput
              value={draft.apiKey}
              onChange={(event) => setDraft((prev) => ({ ...prev, apiKey: event.target.value }))}
              masked
              placeholder={draft.apiKeySet ? '已保存，留空则继续使用当前密钥' : 'sk-...'}
            />
          </div>

          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
            系统会根据 Base URL 和模型名自动识别兼容厂商，当前识别为：{resolvedProviderLabel}。
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
            <input
              type="checkbox"
              checked={draft.setDefault}
              onChange={(event) => setDraft((prev) => ({ ...prev, setDefault: event.target.checked }))}
            />
            设为默认配置
          </label>

          <div
            style={{
              padding: '12px 14px',
              borderRadius: 'var(--radius-lg)',
              border: `1px solid ${testState === 'error' ? 'rgba(220,38,38,0.2)' : testState === 'success' ? 'rgba(22,163,74,0.24)' : 'var(--border-subtle)'}`,
              background: testState === 'error'
                ? 'rgba(220,38,38,0.05)'
                : testState === 'success'
                  ? 'rgba(22,163,74,0.06)'
                  : 'var(--bg-primary)',
              fontSize: 'var(--text-sm)',
              color: testState === 'error'
                ? 'var(--danger)'
                : testState === 'success'
                  ? 'var(--success)'
                  : 'var(--text-secondary)',
              lineHeight: 1.7,
            }}
          >
            {testState === 'loading'
              ? '正在测试当前 LLM 配置…'
              : testState === 'success' && testedSignature === connectivitySignature
                ? '测试通过，可以保存当前配置。'
                : testError || '新增或修改配置后必须先测试通过，才能保存。'}
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await deleteConfig(pendingDelete.id);
            toast(`已删除“${pendingDelete.name}”`, 'success');
          } catch (error) {
            toast(error.message || '删除 LLM 配置失败', 'error');
          } finally {
            setPendingDelete(null);
          }
        }}
        title="删除 LLM 配置"
        message={`确定删除“${pendingDelete?.name || ''}”吗？如果它是默认配置，系统会自动切换到剩余的最新配置。`}
        confirmLabel="删除"
        danger
      />
    </div>
  );
}
