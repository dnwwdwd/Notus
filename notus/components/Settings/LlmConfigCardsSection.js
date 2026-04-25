import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../ui/Toast';
import { Button } from '../ui/Button';
import { Dialog, ConfirmDialog } from '../ui/Dialog';
import { TextInput } from '../ui/Input';
import { ProviderSelect } from '../ui/ProviderSelect';
import { Badge } from '../ui/Badge';
import { Icons } from '../ui/Icons';
import { ModelSelectField } from '../ui/ModelSelectField';
import { useDiscoveredModels } from '../../hooks/useDiscoveredModels';
import { useLlmConfigs } from '../../hooks/useLlmConfigs';
import { findProvider, LLM_PROVIDERS } from '../../lib/modelCatalog';

function createDraft(config = null) {
  const defaultProvider = findProvider(LLM_PROVIDERS, config?.provider || 'qwen');
  return {
    id: config?.id || null,
    name: config?.name || '',
    provider: config?.provider || 'qwen',
    model: config?.model || defaultProvider.models[0]?.value || 'qwen-max',
    baseUrl: config?.base_url || defaultProvider.baseUrl || '',
    apiKey: '',
    apiKeySet: Boolean(config?.api_key_set),
    setDefault: Boolean(config?.is_active),
    lastTestLatencyMs: config?.last_test_latency_ms || null,
  };
}

function buildConnectivitySignature(draft) {
  return JSON.stringify({
    provider: String(draft.provider || '').trim(),
    model: String(draft.model || '').trim(),
    baseUrl: String(draft.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(draft.apiKey || '').trim() || (draft.apiKeySet ? '__stored__' : ''),
  });
}

function ConfigCard({ item, onEdit, onDelete, onSetDefault }) {
  return (
    <div
      style={{
        border: `1px solid ${item.is_active ? 'rgba(193,95,60,0.32)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-xl)',
        background: item.is_active ? 'rgba(193,95,60,0.04)' : 'var(--bg-elevated)',
        padding: 18,
        display: 'grid',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>{item.name}</div>
            {item.is_active ? <Badge tone="accent">默认配置</Badge> : null}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            {item.provider} · {item.model}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {!item.is_active ? (
            <Button variant="ghost" size="sm" onClick={() => onSetDefault(item)}>
              设为默认
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => onEdit(item)}>编辑</Button>
          <Button variant="ghost" size="sm" onClick={() => onDelete(item)}>删除</Button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-primary)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>Base URL</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>{item.base_url}</div>
        </div>
        <div style={{ padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-primary)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>最近测试</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
            {item.last_test_latency_ms ? `${item.last_test_latency_ms} ms` : '尚无记录'}
          </div>
        </div>
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

  const provider = findProvider(LLM_PROVIDERS, draft.provider);
  const isCustomProvider = draft.provider === 'custom';
  const fallbackOptions = provider?.models || [];
  const discovered = useDiscoveredModels({
    kind: 'llm',
    provider: draft.provider,
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey,
    fallbackOptions,
  });

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
    const defaultProvider = findProvider(LLM_PROVIDERS, 'qwen');
    const nextDraft = {
      id: null,
      name: '',
      provider: 'qwen',
      model: defaultProvider.models[0]?.value || 'qwen-max',
      baseUrl: defaultProvider.baseUrl || '',
      apiKey: '',
      apiKeySet: false,
      setDefault: configs.length === 0,
      lastTestLatencyMs: null,
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

  const handleProviderChange = (nextProvider) => {
    const selectedProvider = findProvider(LLM_PROVIDERS, nextProvider);
    setDraft((prev) => ({
      ...prev,
      provider: nextProvider,
      model: selectedProvider?.models[0]?.value || prev.model,
      baseUrl: selectedProvider?.baseUrl || '',
      apiKey: '',
    }));
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
            provider: draft.provider,
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
        provider: draft.provider,
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

          <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>Provider</div>
              <ProviderSelect value={draft.provider} catalog={LLM_PROVIDERS} onChange={handleProviderChange} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>Base URL</div>
              <TextInput
                value={draft.baseUrl}
                onChange={(event) => setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))}
                disabled={!isCustomProvider}
                style={!isCustomProvider ? { opacity: 0.65 } : undefined}
                placeholder="https://api.openai.com/v1"
              />
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>模型名称</div>
            <ModelSelectField
              value={draft.model}
              options={discovered.models}
              loading={discovered.loading}
              onChange={(nextValue) => setDraft((prev) => ({ ...prev, model: nextValue }))}
              selectPlaceholder="从候选模型中选择"
              inputPlaceholder="也可以直接输入模型名"
            />
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
                ? `测试通过${draft.lastTestLatencyMs ? `，耗时 ${draft.lastTestLatencyMs} ms` : ''}。`
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
