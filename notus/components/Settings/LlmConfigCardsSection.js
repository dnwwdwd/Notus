import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../ui/Toast';
import { Icons } from '../ui/Icons';
import { useLlmConfigs } from '../../hooks/useLlmConfigs';
import { inferLlmProvider, resolveLlmProviderLabel } from '../../lib/llmForm';

const API_PROTOCOL_OPTIONS = [
  { value: 'openai', label: 'OpenAI API' },
  { value: 'anthropic', label: 'Anthropic' },
];

const LLM_CONFIG_STYLES = [
  '.notus-llm-section { display: flex; flex-direction: column; gap: 20px; }',
  '.notus-llm-section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }',
  '.notus-llm-section-heading { min-width: 0; display: flex; align-items: flex-start; gap: 12px; }',
  '.notus-model-icon-box { width: 36px; height: 36px; flex: 0 0 auto; border-radius: 10px; color: #d97757; background: rgba(251, 228, 210, 0.5); display: flex; align-items: center; justify-content: center; }',
  '.notus-llm-section-title { color: #2d2d2d; font-size: 15px; line-height: 1.25; font-weight: 700; letter-spacing: -0.01em; }',
  '.notus-llm-section-subtitle { margin-top: 3px; color: #8a8881; font-size: 12px; line-height: 1.45; }',
  '.notus-llm-add-button, .notus-llm-primary-button, .notus-llm-secondary-button, .notus-llm-danger-button, .notus-llm-icon-button, .notus-llm-modal-close { border: 0; appearance: none; font: inherit; cursor: pointer; transition-property: transform, background-color, border-color, color, opacity, box-shadow; transition-duration: 150ms; transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1); touch-action: manipulation; }',
  '.notus-llm-add-button:active, .notus-llm-primary-button:active, .notus-llm-secondary-button:active, .notus-llm-danger-button:active, .notus-llm-icon-button:active, .notus-llm-modal-close:active { transform: scale(0.96); }',
  '.notus-llm-add-button { height: 34px; padding: 0 14px; border-radius: 8px; color: #fff; background: #d97757; display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 700; box-shadow: 0 10px 24px -18px rgba(217, 119, 87, 0.9); white-space: nowrap; }',
  '.notus-llm-add-button:hover { background: #c96849; }',
  '.notus-llm-list { display: flex; flex-direction: column; gap: 10px; }',
  '.notus-llm-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 62px; padding: 12px 16px; border: 1px solid #e5e3d8; border-radius: 12px; background: #fdfcfb; transition-property: border-color, background-color, box-shadow; transition-duration: 160ms; transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }',
  '.notus-llm-row:hover { border-color: #d4d2c9; background: #fff; box-shadow: 0 12px 32px -28px rgba(0, 0, 0, 0.35); }',
  '.notus-llm-row-main { min-width: 0; display: flex; flex-direction: column; gap: 7px; }',
  '.notus-llm-row-name { color: #2d2d2d; font-size: 14px; line-height: 1.2; font-weight: 700; }',
  '.notus-llm-row-meta { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: #8a8881; font-size: 12px; line-height: 1.35; }',
  '.notus-llm-provider { color: #6b6963; font-weight: 650; }',
  '.notus-llm-dot { width: 3px; height: 3px; border-radius: 999px; background: #d4d2c9; }',
  '.notus-llm-code { max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #6b6963; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }',
  '.notus-llm-url { max-width: 260px; }',
  '.notus-llm-row-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }',
  '.notus-llm-icon-button { width: 36px; height: 36px; border-radius: 9px; color: #8a8881; background: transparent; display: flex; align-items: center; justify-content: center; }',
  '.notus-llm-icon-button:hover { color: #4b4944; background: #f2f0ea; }',
  '.notus-llm-icon-button.is-danger:hover { color: #c94136; background: #fff1ef; }',
  '.notus-llm-empty { min-height: 92px; border-radius: 12px; color: #a3a19a; display: flex; align-items: center; justify-content: center; text-align: center; padding: 18px; font-size: 13px; line-height: 1.5; }',
  '.notus-llm-empty.is-dashed { border: 1px dashed #e5e3d8; background: #fdfcfb; }',
  '.notus-llm-modal-root { position: fixed; inset: 0; z-index: 2100; display: flex; align-items: center; justify-content: center; padding: 24px; }',
  '.notus-llm-modal-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; background: rgba(255, 255, 255, 0.72); border: 0; backdrop-filter: blur(5px); cursor: default; }',
  '.notus-llm-modal, .notus-llm-delete-modal { position: relative; z-index: 1; width: min(448px, calc(100vw - 32px)); max-height: 88vh; overflow: hidden; border: 1px solid #e5e3d8; border-radius: 16px; background: #fff; box-shadow: 0 20px 60px -15px rgba(0, 0, 0, 0.1); color: #2d2d2d; }',
  '.notus-llm-modal-header { height: 56px; padding: 0 18px 0 20px; border-bottom: 1px solid #e5e3d8; background: #fdfcfb; display: flex; align-items: center; justify-content: space-between; gap: 12px; }',
  '.notus-llm-modal-header h3 { margin: 0; color: #2d2d2d; font-size: 14px; line-height: 1.2; font-weight: 700; }',
  '.notus-llm-modal-close { width: 34px; height: 34px; border-radius: 9px; color: #8a8881; background: transparent; display: flex; align-items: center; justify-content: center; }',
  '.notus-llm-modal-close:hover { color: #4b4944; background: #f2f0ea; }',
  '.notus-llm-modal-body { max-height: calc(88vh - 120px); overflow: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; scrollbar-width: thin; scrollbar-color: #d8d5ca transparent; }',
  '.notus-llm-field { display: flex; flex-direction: column; gap: 7px; }',
  '.notus-llm-field span { color: #4b4944; font-size: 13px; line-height: 1.35; font-weight: 700; }',
  '.notus-model-input { width: 100%; min-height: 38px; border: 1px solid #e5e3d8; border-radius: 9px; background: #fafafa; color: #2d2d2d; padding: 8px 12px; font-size: 13px; line-height: 1.4; font-family: inherit; outline: none; transition-property: border-color, box-shadow, background-color; transition-duration: 150ms; transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }',
  '.notus-model-input::placeholder { color: #a3a19a; }',
  '.notus-model-input:focus { border-color: rgba(217, 119, 87, 0.6); background: #fff; box-shadow: 0 0 0 3px rgba(217, 119, 87, 0.12); }',
  '.notus-llm-modal-note { color: #a3a19a; font-size: 11px; line-height: 1.65; }',
  '.notus-llm-modal-footer { height: 64px; padding: 0 20px; border-top: 1px solid #e5e3d8; background: #fdfcfb; display: flex; align-items: center; justify-content: flex-end; gap: 10px; }',
  '.notus-llm-primary-button, .notus-llm-secondary-button, .notus-llm-danger-button { min-height: 36px; padding: 0 15px; border-radius: 9px; font-size: 13px; line-height: 1; font-weight: 700; }',
  '.notus-llm-primary-button { color: #fff; background: #d97757; }',
  '.notus-llm-primary-button:hover { background: #c96849; }',
  '.notus-llm-primary-button:disabled, .notus-llm-secondary-button:disabled { cursor: not-allowed; opacity: 0.65; transform: none; }',
  '.notus-llm-secondary-button { color: #6b6963; background: #fff; border: 1px solid #e5e3d8; }',
  '.notus-llm-secondary-button:hover { color: #2d2d2d; background: #f7f5ef; }',
  '.notus-llm-danger-button { color: #fff; background: #e2574c; }',
  '.notus-llm-danger-button:hover { background: #c94136; }',
  '.notus-llm-delete-modal { width: min(384px, calc(100vw - 32px)); padding: 22px; }',
  '.notus-llm-delete-modal h3 { margin: 0; color: #2d2d2d; font-size: 15px; line-height: 1.25; font-weight: 700; }',
  '.notus-llm-delete-modal p { margin: 10px 0 0; color: #6b6963; font-size: 13px; line-height: 1.7; }',
  '.notus-llm-delete-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 20px; }',
  '@media (max-width: 560px) { .notus-llm-section-header, .notus-llm-row { align-items: stretch; flex-direction: column; } .notus-llm-add-button { align-self: flex-start; } .notus-llm-row-actions { align-self: flex-end; } .notus-llm-modal-root { padding: 16px; } }',
].join('\n');

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

function LlmField({ label, children }) {
  return (
    <label className="notus-llm-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function ConfigRow({ item, onEdit, onDelete }) {
  const providerLabel = resolveLlmProviderLabel(item.provider);

  return (
    <div className="notus-llm-row">
      <div className="notus-llm-row-main">
        <div className="notus-llm-row-name">{item.name}</div>
        <div className="notus-llm-row-meta">
          <span className="notus-llm-provider">{providerLabel}</span>
          <span className="notus-llm-dot" />
          <span className="notus-llm-code">{item.model}</span>
          <span className="notus-llm-dot" />
          <span className="notus-llm-code notus-llm-url">{item.base_url}</span>
        </div>
      </div>
      <div className="notus-llm-row-actions">
        <button type="button" className="notus-llm-icon-button" aria-label={'编辑 ' + item.name} onClick={() => onEdit(item)}>
          <Icons.edit size={15} />
        </button>
        <button type="button" className="notus-llm-icon-button is-danger" aria-label={'删除 ' + item.name} onClick={() => onDelete(item)}>
          <Icons.trash size={15} />
        </button>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="notus-llm-empty">
      正在读取 LLM 配置…
    </div>
  );
}

function EmptyState() {
  return (
    <div className="notus-llm-empty is-dashed">
      暂无 LLM 配置，点击右上角“新增配置”开始
    </div>
  );
}

export function LlmConfigCardsSection({
  title = 'LLM 配置',
  subtitle = '用于知识库问答与创作 Agent 的大语言模型',
  onStateChange,
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

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    try {
      await deleteConfig(pendingDelete.id);
      toast('已删除“' + pendingDelete.name + '”', 'success');
    } catch (error) {
      toast(error.message || '删除 LLM 配置失败', 'error');
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="notus-llm-section">
      <div className="notus-llm-section-header">
        <div className="notus-llm-section-heading">
          <div className="notus-model-icon-box">
            <Icons.robot size={18} />
          </div>
          <div>
            <div className="notus-llm-section-title">{title}</div>
            {subtitle ? <div className="notus-llm-section-subtitle">{subtitle}</div> : null}
          </div>
        </div>
        <button type="button" className="notus-llm-add-button" onClick={openCreate}>
          <Icons.plus size={14} />
          新增配置
        </button>
      </div>

      {loading ? (
        <LoadingState />
      ) : configs.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="notus-llm-list">
          {configs.map((item) => (
            <ConfigRow
              key={item.id}
              item={item}
              onEdit={openEdit}
              onDelete={setPendingDelete}
            />
          ))}
        </div>
      )}

      {dialogMode ? (
        <div className="notus-llm-modal-root">
          <button type="button" className="notus-llm-modal-backdrop" aria-label="关闭弹窗" onClick={closeDialog} />
          <section className="notus-llm-modal" role="dialog" aria-modal="true" aria-label={dialogMode === 'edit' ? '编辑 LLM 配置' : '新增 LLM 配置'}>
            <div className="notus-llm-modal-header">
              <h3>{dialogMode === 'edit' ? '编辑 LLM 配置' : '新增 LLM 配置'}</h3>
              <button type="button" className="notus-llm-modal-close" aria-label="关闭" onClick={closeDialog}>
                <Icons.x size={16} />
              </button>
            </div>
            <div className="notus-llm-modal-body">
              <LlmField label="兼容协议">
                <select
                  className="notus-model-input"
                  value={draft.apiProtocol}
                  onChange={(event) => setDraft((prev) => ({ ...prev, apiProtocol: normalizeApiProtocol(event.target.value) }))}
                >
                  {API_PROTOCOL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </LlmField>

              <LlmField label="配置名称">
                <input
                  className="notus-model-input"
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="例如：主力模型、备用模型"
                />
              </LlmField>

              <LlmField label="Base URL">
                <input
                  className="notus-model-input"
                  value={draft.baseUrl}
                  onChange={(event) => setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))}
                  placeholder={draft.apiProtocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'}
                />
              </LlmField>

              <LlmField label="模型名称">
                <input
                  className="notus-model-input"
                  value={draft.model}
                  onChange={(event) => setDraft((prev) => ({ ...prev, model: event.target.value }))}
                  placeholder={draft.apiProtocol === 'anthropic' ? '例如：claude-sonnet-4' : '例如：gpt-4o、qwen-max'}
                />
              </LlmField>

              <LlmField label="API Key">
                <input
                  className="notus-model-input"
                  type="password"
                  value={draft.apiKey}
                  onChange={(event) => setDraft((prev) => ({ ...prev, apiKey: event.target.value }))}
                  placeholder="sk-••••••••••••"
                />
              </LlmField>

              <div className="notus-llm-modal-note">保存后即可在知识库问答与创作页选用，无需先测试连通性。</div>
            </div>
            <div className="notus-llm-modal-footer">
              <button type="button" className="notus-llm-secondary-button" onClick={closeDialog} disabled={submitting}>取消</button>
              <button type="button" className="notus-llm-primary-button" onClick={handleSubmit} disabled={submitting}>
                {submitting ? '保存中…' : dialogMode === 'edit' ? '保存修改' : '添加配置'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="notus-llm-modal-root">
          <button type="button" className="notus-llm-modal-backdrop" aria-label="关闭删除确认" onClick={() => setPendingDelete(null)} />
          <section className="notus-llm-delete-modal" role="dialog" aria-modal="true" aria-label="删除 LLM 配置">
            <h3>删除 LLM 配置</h3>
            <p>确定删除“{pendingDelete.name}”吗？如果它是当前回退配置，系统会自动切换到剩余的最新配置。</p>
            <div className="notus-llm-delete-actions">
              <button type="button" className="notus-llm-secondary-button" onClick={() => setPendingDelete(null)}>取消</button>
              <button type="button" className="notus-llm-danger-button" onClick={confirmDelete}>删除</button>
            </div>
          </section>
        </div>
      ) : null}

      <style jsx global>{LLM_CONFIG_STYLES}</style>
    </div>
  );
}
