import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../ui/Toast';
import { Icons } from '../ui/Icons';
import { DropdownSelect } from '../ui/DropdownSelect';
import { scheduleInitialFocus } from '../ui/dialogFocus';
import { useLlmConfigs } from '../../hooks/useLlmConfigs';
import { groupLlmConfigs, inferLlmProvider, resolveLlmProviderLabel } from '../../lib/llmForm';
import { readJsonResponse } from '../../utils/fetchJson';

const API_PROTOCOL_OPTIONS = [
  { value: 'openai', label: 'OpenAI 兼容' },
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
  '.notus-llm-group-list { display: flex; flex-direction: column; gap: 12px; }',
  '.notus-llm-group { border: 1px solid #e5e3d8; border-radius: 12px; background: #fdfcfb; overflow: hidden; transition-property: border-color, background-color, box-shadow; transition-duration: 160ms; transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }',
  '.notus-llm-group:hover { border-color: #d4d2c9; background: #fff; box-shadow: 0 12px 32px -28px rgba(0, 0, 0, 0.35); }',
  '.notus-llm-group-header { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 16px; border-bottom: 1px solid #f0eee6; }',
  '.notus-llm-group-main { min-width: 0; display: flex; flex-direction: column; gap: 6px; }',
  '.notus-llm-group-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }',
  '.notus-llm-group-title { color: #2d2d2d; font-size: 14px; line-height: 1.2; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '.notus-llm-group-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 999px; background: rgba(217, 119, 87, 0.12); color: #c96849; font-size: 10px; font-weight: 700; white-space: nowrap; }',
  '.notus-llm-group-protocol { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: 999px; background: #f2f0ea; color: #6b6963; font-size: 10px; font-weight: 700; white-space: nowrap; }',
  '.notus-llm-group-meta { display: flex; align-items: center; gap: 6px; min-width: 0; color: #8a8881; font-size: 12px; line-height: 1.35; }',
  '.notus-llm-code { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #6b6963; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }',
  '.notus-llm-group-models { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px 14px; }',
  '.notus-llm-model-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 26px; padding: 0 10px; border-radius: 999px; background: #f2f0ea; color: #4b4944; font-size: 12px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }',
  '.notus-llm-model-chip.is-active { background: rgba(217, 119, 87, 0.12); color: #c96849; }',
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
  '.notus-llm-field-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }',
  '.notus-llm-field-badge { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; background: #f2f0ea; color: #6b6963; font-size: 11px; line-height: 1; font-weight: 700; white-space: nowrap; }',
  '.notus-model-input { width: 100%; min-height: 38px; border: 1px solid #e5e3d8; border-radius: 9px; background: #fafafa; color: #2d2d2d; padding: 8px 12px; font-size: 13px; line-height: 1.4; font-family: inherit; outline: none; transition-property: border-color, box-shadow, background-color; transition-duration: 150ms; transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }',
  '.notus-model-input::placeholder { color: #a3a19a; }',
  '.notus-model-input:focus { border-color: rgba(217, 119, 87, 0.6); background: #fff; box-shadow: 0 0 0 3px rgba(217, 119, 87, 0.12); }',
  '.notus-llm-model-picker { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid #e5e3d8; border-radius: 10px; background: #fdfcfb; }',
  '.notus-llm-picker-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }',
  '.notus-llm-picker-title { color: #4b4944; font-size: 13px; font-weight: 700; }',
  '.notus-llm-picker-hint { color: #a3a19a; font-size: 11px; }',
  '.notus-llm-fetch-button { border: 1px solid #e5e3d8; border-radius: 8px; background: #fff; color: #4b4944; height: 32px; padding: 0 12px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; transition-property: background-color, color, border-color; transition-duration: 150ms; }',
  '.notus-llm-fetch-button:hover { background: #f7f5ef; color: #2d2d2d; }',
  '.notus-llm-fetch-button:disabled { cursor: not-allowed; opacity: 0.6; }',
  '.notus-llm-selected-chips { display: flex; flex-wrap: wrap; gap: 6px; }',
  '.notus-llm-selected-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; height: 24px; padding: 0 6px 0 9px; border-radius: 999px; background: rgba(217, 119, 87, 0.1); color: #b95f42; font-size: 11px; font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }',
  '.notus-llm-chip-remove { width: 16px; height: 16px; border: 0; border-radius: 999px; padding: 0; display: inline-flex; align-items: center; justify-content: center; color: #b95f42; background: transparent; cursor: pointer; }',
  '.notus-llm-chip-remove:hover { background: rgba(217, 119, 87, 0.18); }',
  '.notus-llm-model-catalog { display: flex; flex-direction: column; gap: 8px; }',
  '.notus-llm-model-catalog-list { max-height: 180px; overflow: auto; border: 1px solid #e5e3d8; border-radius: 8px; background: #fff; display: flex; flex-direction: column; scrollbar-width: thin; scrollbar-color: #d8d5ca transparent; }',
  '.notus-llm-model-option { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #4b4944; border-bottom: 1px solid #f4f2ec; }',
  '.notus-llm-model-option:last-child { border-bottom: 0; }',
  '.notus-llm-model-option:hover { background: #f9f7f2; }',
  '.notus-llm-model-option input { accent-color: #d97757; margin: 0; }',
  '.notus-llm-model-option.is-selected { color: #b95f42; font-weight: 700; }',
  '.notus-llm-custom-row { display: flex; gap: 8px; }',
  '.notus-llm-custom-row .notus-model-input { flex: 1; min-width: 0; }',
  '.notus-llm-test-list { display: flex; flex-direction: column; gap: 6px; }',
  '.notus-llm-test-row { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #4b4944; }',
  '.notus-llm-test-dot { width: 8px; height: 8px; border-radius: 999px; flex: 0 0 auto; }',
  '.notus-llm-test-dot.is-pending { background: #d4d2c9; animation: notus-llm-test-pulse 1.2s ease-in-out infinite; }',
  '.notus-llm-test-dot.is-success { background: #3f9d63; }',
  '.notus-llm-test-dot.is-failed { background: #e2574c; }',
  '@keyframes notus-llm-test-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }',
  '.notus-llm-test-model { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.notus-llm-test-meta { margin-left: auto; flex: 0 0 auto; color: #a3a19a; font-size: 11px; }',
  '.notus-llm-test-error { color: #c94136; }',
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
  '@media (max-width: 560px) { .notus-llm-section-header, .notus-llm-group-header { align-items: stretch; flex-direction: column; } .notus-llm-add-button { align-self: flex-start; } .notus-llm-row-actions { align-self: flex-end; } .notus-llm-modal-root { padding: 16px; } }',
].join('\n');

function normalizeApiProtocol(value) {
  return String(value || '').trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
}

function protocolLabel(value) {
  return normalizeApiProtocol(value) === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容';
}

function createGroupDraft(config = null) {
  return {
    apiProtocol: normalizeApiProtocol(config?.api_protocol),
    provider: config?.provider || '',
    baseUrl: config?.base_url || '',
    apiKey: '',
    apiKeySet: Boolean(config?.api_key_set),
    contextWindow: config?.context_window_tokens ? String(config.context_window_tokens) : '',
  };
}

function LlmField({ label, badge = '', children }) {
  return (
    <label className="notus-llm-field">
      <div className="notus-llm-field-header">
        <span>{label}</span>
        {badge ? <em className="notus-llm-field-badge">{badge}</em> : null}
      </div>
      {children}
    </label>
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
  subtitle = '用于文件工作区检索和 Agent 协作的大语言模型',
  onStateChange,
}) {
  const toast = useToast();
  const { configs, activeConfigId, loading, createConfigs, updateConfig, deleteConfig } = useLlmConfigs();
  const groups = useMemo(() => groupLlmConfigs(configs), [configs]);
  const [dialogMode, setDialogMode] = useState(null);
  const [draft, setDraft] = useState(createGroupDraft());
  const [baselineDraft, setBaselineDraft] = useState(null);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [initialModels, setInitialModels] = useState([]);
  const [selectedModels, setSelectedModels] = useState([]);
  const [testTargets, setTestTargets] = useState([]);
  const [fetchedModels, setFetchedModels] = useState(null);
  const [modelFilter, setModelFilter] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [fetchingModels, setFetchingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState(null);
  const providerInputRef = useRef(null);
  const inferredProvider = useMemo(
    () => inferLlmProvider({ baseUrl: draft.baseUrl, model: selectedModels[0] || '' }),
    [draft.baseUrl, selectedModels]
  );
  const selectedProvider = String(draft.provider || '').trim();
  const effectiveProvider = selectedProvider || inferredProvider;
  const resolvedProviderLabel = useMemo(
    () => resolveLlmProviderLabel(effectiveProvider),
    [effectiveProvider]
  );
  const dialogActive = dialogMode !== null;
  const editingGroup = useMemo(
    () => (editingGroupId ? groups.find((group) => group.items.some((item) => item.id === editingGroupId)) || null : null),
    [editingGroupId, groups]
  );
  const filteredCatalog = useMemo(() => {
    if (!Array.isArray(fetchedModels)) return [];
    const keyword = modelFilter.trim().toLowerCase();
    const rows = keyword ? fetchedModels.filter((id) => id.toLowerCase().includes(keyword)) : fetchedModels;
    return [...rows].sort((a, b) => {
      const aSelected = selectedModels.includes(a) ? 0 : 1;
      const bSelected = selectedModels.includes(b) ? 0 : 1;
      if (aSelected !== bSelected) return aSelected - bSelected;
      return a.localeCompare(b);
    });
  }, [fetchedModels, modelFilter, selectedModels]);
  const testRows = useMemo(() => (
    Object.entries(testResults).map(([model, result]) => ({ model, ...result }))
  ), [testResults]);

  useEffect(() => {
    onStateChange?.({ configs, activeConfigId, loading });
  }, [activeConfigId, configs, loading, onStateChange]);

  const resetDialogState = () => {
    setDraft(createGroupDraft());
    setBaselineDraft(null);
    setEditingGroupId(null);
    setInitialModels([]);
    setSelectedModels([]);
    setTestTargets([]);
    setFetchedModels(null);
    setModelFilter('');
    setCustomModel('');
    setTestResults({});
  };

  // 从设置页打开新增/编辑弹窗时，焦点应直接落在第一个可编辑字段。
  useEffect(() => {
    if (!dialogMode) return undefined;
    return scheduleInitialFocus(providerInputRef, { select: true });
  }, [dialogMode]);

  const openCreate = () => {
    resetDialogState();
    setDialogMode('create');
  };

  const openEdit = (group) => {
    resetDialogState();
    const nextDraft = createGroupDraft(group.items[0]);
    setDraft(nextDraft);
    setBaselineDraft(nextDraft);
    setEditingGroupId(group.items[0].id);
    setInitialModels(group.items.map((item) => item.model));
    setSelectedModels(group.items.map((item) => item.model));
    setDialogMode('edit');
  };

  const closeDialog = () => {
    if (submitting) return;
    setDialogMode(null);
    resetDialogState();
  };

  const toggleModel = (model) => {
    setSelectedModels((prev) => {
      if (prev.includes(model)) {
        setTestTargets((targets) => targets.filter((item) => item !== model));
        return prev.filter((item) => item !== model);
      }
      return [...prev, model];
    });
  };

  const toggleTestTarget = (model) => {
    setTestTargets((prev) => (
      prev.includes(model) ? prev.filter((item) => item !== model) : [...prev, model]
    ));
  };

  const removeSelectedModel = (model) => {
    setSelectedModels((prev) => prev.filter((item) => item !== model));
    setTestTargets((prev) => prev.filter((item) => item !== model));
  };

  const addCustomModel = () => {
    const model = String(customModel || '').trim();
    if (!model) return;
    if (selectedModels.includes(model)) {
      toast('该模型已在列表中', 'warning');
      return;
    }
    setSelectedModels((prev) => [...prev, model]);
    setCustomModel('');
  };

  const handleFetchModels = async () => {
    const baseUrl = String(draft.baseUrl || '').trim();
    if (!baseUrl) {
      toast('请先填写 LLM Base URL', 'warning');
      return;
    }
    setFetchingModels(true);
    try {
      const response = await fetch('/api/settings/llm-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_protocol: normalizeApiProtocol(draft.apiProtocol),
          base_url: baseUrl,
          api_key: String(draft.apiKey || '').trim(),
          llm_config_id: dialogMode === 'edit' ? editingGroupId : null,
        }),
      });
      const payload = await readJsonResponse(response, { fallbackMessage: '获取模型列表失败' });
      if (!payload.success) {
        toast(payload.error || '获取模型列表失败', 'error');
        return;
      }
      setFetchedModels(Array.isArray(payload.models) ? payload.models : []);
      setModelFilter('');
      toast(`已获取 ${payload.models.length} 个模型`, 'success');
    } catch (error) {
      toast(error.message || '获取模型列表失败', 'error');
    } finally {
      setFetchingModels(false);
    }
  };

  // 可选连通性测试：对已选模型逐个执行真实请求，结果仅作展示与耗时记录，不阻塞保存。
  const handleRunTests = async () => {
    const targets = selectedModels.filter((model) => testTargets.includes(model));
    if (targets.length === 0) {
      toast('请先勾选要测试的模型', 'warning');
      return;
    }
    setTestResults({});
    setTesting(true);
    try {
      for (const model of targets) {
        setTestResults((prev) => ({ ...prev, [model]: { status: 'pending' } }));
        try {
          const response = await fetch('/api/settings/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              kind: 'llm',
              config: {
                provider: effectiveProvider,
                api_protocol: normalizeApiProtocol(draft.apiProtocol),
                model,
                base_url: String(draft.baseUrl || '').trim(),
                ...(String(draft.apiKey || '').trim() ? { api_key: String(draft.apiKey || '').trim() } : {}),
              },
              ...(dialogMode === 'edit' && editingGroupId ? { llm_config_id: editingGroupId } : {}),
            }),
          });
          const payload = await readJsonResponse(response, { fallbackMessage: '连通性测试失败' });
          if (!payload.success) throw new Error(payload.error || '连通性测试未通过');
          setTestResults((prev) => ({ ...prev, [model]: { status: 'success', latency_ms: payload.latency_ms } }));
        } catch (error) {
          setTestResults((prev) => ({ ...prev, [model]: { status: 'failed', error: error.message } }));
        }
      }
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async () => {
    const baseUrl = String(draft.baseUrl || '').trim();
    const apiKey = String(draft.apiKey || '').trim();
    const contextWindowRaw = String(draft.contextWindow || '').trim();

    if (selectedModels.length === 0) {
      toast('请至少选择或输入一个模型', 'warning');
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
    let contextWindowTokens = null;
    if (contextWindowRaw) {
      const parsed = Number(contextWindowRaw);
      if (!Number.isInteger(parsed) || parsed < 4096 || parsed > 10485760) {
        toast('上下文窗口需为 4096 ～ 10485760 之间的整数 Token', 'warning');
        return;
      }
      contextWindowTokens = parsed;
    }

    const addedModels = selectedModels.filter((model) => !initialModels.includes(model));
    const removedModels = initialModels.filter((model) => !selectedModels.includes(model));
    const propertyChanged = dialogMode === 'create' || (
      baselineDraft && (
        normalizeApiProtocol(draft.apiProtocol) !== normalizeApiProtocol(baselineDraft.apiProtocol)
        || String(draft.baseUrl || '').trim() !== String(baselineDraft.baseUrl || '').trim()
        || String(draft.provider || '').trim() !== String(baselineDraft.provider || '').trim()
        || String(draft.contextWindow || '').trim() !== String(baselineDraft.contextWindow || '').trim()
        || Boolean(apiKey)
      )
    );

    // 可选测试通过后的耗时；未测试的模型以 null / 原值保存，不阻塞提交。
    const testedLatency = (model) => (
      testResults[model]?.status === 'success' && Number.isFinite(testResults[model].latency_ms)
        ? testResults[model].latency_ms
        : null
    );

    setSubmitting(true);
    try {
      const sharedPayload = {
        name: resolvedProviderLabel,
        provider: effectiveProvider,
        api_protocol: normalizeApiProtocol(draft.apiProtocol),
        base_url: baseUrl,
        context_window_tokens: contextWindowTokens,
      };

      if (dialogMode === 'create') {
        await createConfigs({
          ...sharedPayload,
          api_key: apiKey,
          models: selectedModels.map((model) => ({
            model,
            last_test_latency_ms: testedLatency(model),
          })),
        });
        toast('LLM 配置已添加', 'success');
      } else {
        const group = editingGroup;
        const rowByModel = new Map((group?.items || []).map((item) => [item.model, item]));
        const keptModels = initialModels.filter((model) => selectedModels.includes(model));

        if (propertyChanged) {
          for (const model of keptModels) {
            const row = rowByModel.get(model);
            if (!row) continue;
            await updateConfig(row.id, {
              ...sharedPayload,
              last_test_latency_ms: testedLatency(model) ?? row.last_test_latency_ms,
            });
          }
        }

        if (addedModels.length > 0) {
          await createConfigs({
            ...sharedPayload,
            ...(apiKey ? { api_key: apiKey } : {}),
            inherit_api_key_from: editingGroupId,
            models: addedModels.map((model) => ({
              model,
              last_test_latency_ms: testedLatency(model),
            })),
          });
        }

        for (const model of removedModels) {
          const row = rowByModel.get(model);
          if (row) await deleteConfig(row.id);
        }

        toast('LLM 配置已更新', 'success');
      }
      closeDialog();
    } catch (error) {
      toast(error.message || '保存 LLM 配置失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDeleteGroup = async () => {
    if (!pendingDeleteGroup) return;
    const rows = [...pendingDeleteGroup.items].sort((a, b) => Number(a.is_active) - Number(b.is_active));
    try {
      for (const row of rows) {
        await deleteConfig(row.id);
      }
      toast('已删除“' + resolveLlmProviderLabel(pendingDeleteGroup.provider) + '”', 'success');
    } catch (error) {
      toast(error.message || '删除 LLM 配置失败', 'error');
    } finally {
      setPendingDeleteGroup(null);
    }
  };

  const submitDisabled = submitting;

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
      ) : groups.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="notus-llm-group-list">
          {groups.map((group) => (
            <section key={group.key} className="notus-llm-group">
              <div className="notus-llm-group-header">
                <div className="notus-llm-group-main">
                  <div className="notus-llm-group-title-row">
                    <span className="notus-llm-group-title">{resolveLlmProviderLabel(group.provider)}</span>
                    {group.hasActive ? <span className="notus-llm-group-badge">默认</span> : null}
                    <span className="notus-llm-group-protocol">{protocolLabel(group.api_protocol)}</span>
                  </div>
                  <div className="notus-llm-group-meta">
                    <span className="notus-llm-code">{group.base_url}</span>
                  </div>
                </div>
                <div className="notus-llm-row-actions">
                  <button type="button" className="notus-llm-icon-button" aria-label={'编辑 ' + resolveLlmProviderLabel(group.provider) + ' 配置'} onClick={() => openEdit(group)}>
                    <Icons.edit size={15} />
                  </button>
                  <button type="button" className="notus-llm-icon-button is-danger" aria-label={'删除 ' + resolveLlmProviderLabel(group.provider) + ' 配置'} onClick={() => setPendingDeleteGroup(group)}>
                    <Icons.trash size={15} />
                  </button>
                </div>
              </div>
              <div className="notus-llm-group-models">
                {group.items.map((item) => (
                  <span key={item.id} className={'notus-llm-model-chip' + (item.is_active ? ' is-active' : '')}>
                    {item.model}
                    {item.is_active ? ' · 默认' : ''}
                  </span>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {dialogActive ? (
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
                <DropdownSelect
                  value={draft.apiProtocol}
                  options={API_PROTOCOL_OPTIONS}
                  onChange={(nextValue) => setDraft((prev) => ({ ...prev, apiProtocol: normalizeApiProtocol(nextValue) }))}
                  menuZIndex={2205}
                  buttonStyle={{
                    minHeight: 38,
                    background: '#fafafa',
                    border: '1px solid #e5e3d8',
                    borderRadius: 9,
                    color: '#2d2d2d',
                    fontSize: 13,
                    lineHeight: 1.4,
                  }}
                />
              </LlmField>

              <LlmField label="提供商">
                <input
                  ref={providerInputRef}
                  className="notus-model-input"
                  value={draft.provider}
                  onChange={(event) => setDraft((prev) => ({ ...prev, provider: event.target.value }))}
                  placeholder={draft.apiProtocol === 'anthropic' ? 'Anthropic' : 'OpenAI'}
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

              <LlmField label="上下文窗口（Token）" badge="可选">
                <input
                  className="notus-model-input"
                  type="number"
                  inputMode="numeric"
                  min={4096}
                  max={10485760}
                  value={draft.contextWindow}
                  onChange={(event) => setDraft((prev) => ({ ...prev, contextWindow: event.target.value }))}
                  placeholder="留空按默认 200000 处理"
                />
              </LlmField>

              <LlmField label="API Key" badge={draft.apiKeySet ? '已保存' : ''}>
                <input
                  className="notus-model-input"
                  type="password"
                  value={draft.apiKey}
                  onChange={(event) => setDraft((prev) => ({ ...prev, apiKey: event.target.value }))}
                  placeholder={draft.apiKeySet ? '已保存，留空不修改' : 'sk-••••••••••••'}
                />
              </LlmField>

              <div className="notus-llm-model-picker">
                <div className="notus-llm-picker-header">
                  <span className="notus-llm-picker-title">模型</span>
                  <span className="notus-llm-picker-hint">至少选择一个，可多选</span>
                </div>

                {selectedModels.length > 0 ? (
                  <div className="notus-llm-selected-chips">
                    {selectedModels.map((model) => (
                      <span key={model} className="notus-llm-selected-chip">
                        <input
                          type="checkbox"
                          aria-label={'选择测试 ' + model}
                          checked={testTargets.includes(model)}
                          onChange={() => toggleTestTarget(model)}
                          disabled={testing}
                          style={{ margin: 0, width: 12, height: 12, accentColor: '#D97757', cursor: 'pointer' }}
                        />
                        {model}
                        <button
                          type="button"
                          className="notus-llm-chip-remove"
                          aria-label={'移除模型 ' + model}
                          disabled={submitting || testing}
                          onClick={() => removeSelectedModel(model)}
                        >
                          <Icons.x size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="notus-llm-picker-hint">尚未选择模型：可从服务商拉取列表勾选，或直接输入模型名添加。</div>
                )}

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="notus-llm-fetch-button" onClick={handleFetchModels} disabled={fetchingModels || testing || submitting}>
                    <Icons.refresh size={12} />
                    {fetchingModels ? '获取中…' : (Array.isArray(fetchedModels) ? '重新拉取模型列表' : '拉取模型列表')}
                  </button>
                  <button type="button" className="notus-llm-fetch-button" onClick={handleRunTests} disabled={testing || submitting || testTargets.length === 0}>
                    {testing ? '测试中…' : testTargets.length > 0 ? `测试连通性（已选 ${testTargets.length} 个）` : '测试连通性'}
                  </button>
                </div>
                {selectedModels.length > 0 && testTargets.length === 0 && !testing ? (
                  <div className="notus-llm-picker-hint">点击模型芯片左侧的复选框选择要测试的模型，可多选；不会默认测试全部。</div>
                ) : null}

                {Array.isArray(fetchedModels) ? (
                  <div className="notus-llm-model-catalog">
                    <input
                      className="notus-model-input"
                      value={modelFilter}
                      onChange={(event) => setModelFilter(event.target.value)}
                      placeholder="过滤模型…"
                    />
                    {filteredCatalog.length > 0 ? (
                      <div className="notus-llm-model-catalog-list">
                        {filteredCatalog.map((model) => {
                          const isSelected = selectedModels.includes(model);
                          return (
                            <label key={model} className={'notus-llm-model-option' + (isSelected ? ' is-selected' : '')}>
                              <input type="checkbox" checked={isSelected} onChange={() => toggleModel(model)} disabled={submitting || testing} />
                              {model}
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="notus-llm-picker-hint">没有匹配的模型</div>
                    )}
                  </div>
                ) : null}

                <div className="notus-llm-custom-row">
                  <input
                    className="notus-model-input"
                    value={customModel}
                    onChange={(event) => setCustomModel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addCustomModel();
                      }
                    }}
                    placeholder="自定义输入模型名，如 qwen-max"
                    disabled={submitting || testing}
                  />
                  <button type="button" className="notus-llm-fetch-button" onClick={addCustomModel} disabled={submitting || testing}>
                    添加
                  </button>
                </div>

                {testRows.length > 0 ? (
                  <div className="notus-llm-test-list" role="status">
                    {testRows.map((row) => (
                      <div key={row.model} className="notus-llm-test-row">
                        <span className={'notus-llm-test-dot is-' + row.status} />
                        <span className="notus-llm-test-model">{row.model}</span>
                        {row.status === 'success' ? (
                          <span className="notus-llm-test-meta">已连通{Number.isFinite(row.latency_ms) ? ` · ${row.latency_ms}ms` : ''}</span>
                        ) : null}
                        {row.status === 'failed' ? <span className="notus-llm-test-meta notus-llm-test-error">{row.error || '测试失败'}</span> : null}
                        {row.status === 'pending' ? <span className="notus-llm-test-meta">测试中…</span> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="notus-llm-modal-note">连通性测试为可选操作：勾选要测试的模型后点击“测试连通性”；测试失败或未测试的配置同样可以直接保存。</div>
            </div>
            <div className="notus-llm-modal-footer">
              <button type="button" className="notus-llm-secondary-button" onClick={closeDialog} disabled={submitting}>取消</button>
              <button type="button" className="notus-llm-primary-button" onClick={handleSubmit} disabled={submitDisabled}>
                {submitting ? '保存中…' : dialogMode === 'edit' ? '保存修改' : '添加'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingDeleteGroup ? (
        <div className="notus-llm-modal-root">
          <button type="button" className="notus-llm-modal-backdrop" aria-label="关闭删除确认" onClick={() => setPendingDeleteGroup(null)} />
          <section className="notus-llm-delete-modal" role="dialog" aria-modal="true" aria-label="删除 LLM 配置">
            <h3>删除 LLM 配置</h3>
            <p>确定删除“{resolveLlmProviderLabel(pendingDeleteGroup.provider)}”及其 {pendingDeleteGroup.items.length} 个模型吗？如果其中包含当前默认模型，系统会自动切换到剩余的最新配置。</p>
            <div className="notus-llm-delete-actions">
              <button type="button" className="notus-llm-secondary-button" onClick={() => setPendingDeleteGroup(null)}>取消</button>
              <button type="button" className="notus-llm-danger-button" onClick={confirmDeleteGroup}>删除</button>
            </div>
          </section>
        </div>
      ) : null}

      <style jsx global>{LLM_CONFIG_STYLES}</style>
    </div>
  );
}
