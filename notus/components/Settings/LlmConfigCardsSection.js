import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../ui/Toast';
import { Button } from '../ui/Button';
import { Dialog, ConfirmDialog } from '../ui/Dialog';
import { TextInput } from '../ui/Input';
import { DropdownSelect } from '../ui/DropdownSelect';
import { Icons } from '../ui/Icons';
import { useLlmConfigs } from '../../hooks/useLlmConfigs';
import { inferLlmProvider, resolveLlmProviderLabel } from '../../lib/llmForm';

const API_PROTOCOL_OPTIONS = [
  { value: 'openai', label: 'OpenAI API' },
  { value: 'anthropic', label: 'Anthropic' },
];

function normalizeApiProtocol(value) {
  return String(value || '').trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
}

function createDraft(config = null) {
  const model = config?.model || '';
  const baseUrl = config?.base_url || '';
  return {
    id: config?.id || null,
    name: config?.name || '',
    apiProtocol: normalizeApiProtocol(config?.api_protocol),
    provider: config?.provider || inferLlmProvider({ baseUrl, model }),
    model,
    baseUrl,
    apiKey: '',
    apiKeySet: Boolean(config?.api_key_set),
  };
}

function ConfigRow({ item, onEdit, onDelete, compact = false }) {
  const providerLabel = resolveLlmProviderLabel(item.provider);
  return (
    <div
      style={{
        padding: compact ? '12px 0' : '14px 0',
        display: 'grid',
        gap: compact ? 8 : 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: compact ? 'wrap' : 'nowrap' }}>
        <div style={{ minWidth: 0, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div
            style={{
              width: compact ? 30 : 34,
              height: compact ? 30 : 34,
              borderRadius: 10,
              color: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icons.robot size={compact ? 16 : 18} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: compact ? 'var(--text-sm)' : 'var(--text-base)', fontWeight: 600, color: 'var(--text-primary)' }}>{item.name}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{providerLabel}</div>
            </div>
            <div style={{ marginTop: 5, display: 'grid', gap: 3 }}>
              <div style={{ fontSize: compact ? 12 : 'var(--text-sm)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>{item.model}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', wordBreak: 'break-all' }}>{item.base_url}</div>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <Button variant="ghost" size="sm" onClick={() => onEdit(item)}>编辑</Button>
          <Button variant="ghost" size="sm" onClick={() => onDelete(item)}>删除</Button>
        </div>
      </div>
    </div>
  );
}

export function LlmConfigCardsSection({
  title = 'LLM 配置',
  subtitle = '',
  onStateChange,
  compact = false,
}) {
  const toast = useToast();
  const { configs, activeConfigId, loading, createConfig, updateConfig, deleteConfig } = useLlmConfigs();
  const [dialogMode, setDialogMode] = useState(null);
  const [draft, setDraft] = useState(createDraft());
  const [pendingDelete, setPendingDelete] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const resolvedProvider = useMemo(
    () => inferLlmProvider({ baseUrl: draft.baseUrl, model: draft.model }),
    [draft.baseUrl, draft.model]
  );

  useEffect(() => {
    onStateChange?.({ configs, activeConfigId, loading });
  }, [activeConfigId, configs, loading, onStateChange]);

  const openCreate = () => {
    setDraft(createDraft());
    setDialogMode('create');
  };

  const openEdit = (item) => {
    setDraft(createDraft(item));
    setDialogMode('edit');
  };

  const closeDialog = () => {
    if (submitting) return;
    setDialogMode(null);
    setDraft(createDraft());
  };

  const canSubmit = !submitting;

  const handleSubmit = async () => {
    const name = String(draft.name || '').trim();
    const model = String(draft.model || '').trim();
    const baseUrl = String(draft.baseUrl || '').trim();
    const apiKey = String(draft.apiKey || '').trim();

    if (!name) {
      toast('请填写配置名称', 'warning');
      return;
    }
    if (!model) {
      toast('请填写 LLM 模型名称', 'warning');
      return;
    }
    if (!baseUrl) {
      toast('请填写 LLM Base URL', 'warning');
      return;
    }
    if (!apiKey && !draft.apiKeySet) {
      toast('请填写 LLM API Key', 'warning');
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        name,
        provider: resolvedProvider,
        api_protocol: normalizeApiProtocol(draft.apiProtocol),
        model,
        base_url: baseUrl,
        api_key: apiKey,
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
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: compact ? 10 : 14 }}>
        <div>
          <div style={{ fontSize: compact ? 'var(--text-base)' : 'var(--text-xl)', fontWeight: 600, marginBottom: subtitle ? 6 : 0 }}>{title}</div>
          {subtitle ? (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{subtitle}</div>
          ) : null}
        </div>
        <Button variant="primary" onClick={openCreate}>新增配置</Button>
      </div>

      {loading ? (
        <div style={{ padding: '14px 0', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
          正在读取 LLM 配置…
        </div>
      ) : configs.length === 0 ? (
        <div style={{ padding: '22px 0', textAlign: 'center' }}>
          <div style={{ color: 'var(--text-tertiary)', display: 'inline-flex', marginBottom: 10 }}><Icons.robot size={26} /></div>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 5 }}>还没有可用的 LLM 配置</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
            通过“新增配置”创建模型接入。
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: compact ? 4 : 6 }}>
          {configs.map((item) => (
            <ConfigRow
              key={item.id}
              item={item}
              compact={compact}
              onEdit={openEdit}
              onDelete={setPendingDelete}
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
            <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={handleSubmit}>
              {dialogMode === 'edit' ? '保存修改' : '添加配置'}
            </Button>
          </>
        )}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>兼容协议</div>
            <DropdownSelect
              value={draft.apiProtocol}
              options={API_PROTOCOL_OPTIONS}
              onChange={(nextValue) => setDraft((prev) => ({ ...prev, apiProtocol: normalizeApiProtocol(nextValue) }))}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>配置名称</div>
            <TextInput
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="例如：主力模型、备用模型"
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>Base URL</div>
              <TextInput
                value={draft.baseUrl}
                onChange={(event) => setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))}
                placeholder={draft.apiProtocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'}
              />
            </div>
            <div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>模型名称</div>
              <TextInput
                value={draft.model}
                onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))}
                placeholder={draft.apiProtocol === 'anthropic' ? '例如：claude-sonnet-4' : '例如：gpt-4o、qwen-max'}
              />
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 6 }}>API Key</div>
            <TextInput
              value={draft.apiKey}
              onChange={(event) => setDraft((prev) => ({ ...prev, apiKey: event.target.value }))}
              masked
              placeholder={draft.apiKeySet ? '留空则继续使用当前密钥' : 'sk-...'}
            />
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
            toast('已删除“' + pendingDelete.name + '”', 'success');
          } catch (error) {
            toast(error.message || '删除 LLM 配置失败', 'error');
          } finally {
            setPendingDelete(null);
          }
        }}
        title="删除 LLM 配置"
        message={'确定删除“' + (pendingDelete?.name || '') + '”吗？如果它是当前回退配置，系统会自动切换到剩余的最新配置。'}
        confirmLabel="删除"
        danger
      />
    </div>
  );
}
