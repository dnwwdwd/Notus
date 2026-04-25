import { useCallback, useEffect, useState } from 'react';

export function useLlmConfigs() {
  const [state, setState] = useState({
    configs: [],
    activeConfigId: null,
    loading: true,
  });

  const refresh = useCallback(async () => {
    const response = await fetch('/api/settings');
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || '读取 LLM 配置失败');
    }

    setState({
      configs: payload.llm_configs || [],
      activeConfigId: payload.active_llm_config_id || null,
      loading: false,
    });

    return payload;
  }, []);

  useEffect(() => {
    let cancelled = false;

    refresh().catch(() => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, loading: false }));
    });

    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const createConfig = useCallback(async (input) => {
    const response = await fetch('/api/settings/llm-configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || '新增 LLM 配置失败');
    }
    await refresh();
    return payload.item;
  }, [refresh]);

  const updateConfig = useCallback(async (id, input) => {
    const response = await fetch(`/api/settings/llm-configs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || '更新 LLM 配置失败');
    }
    await refresh();
    return payload.item;
  }, [refresh]);

  const deleteConfig = useCallback(async (id) => {
    const response = await fetch(`/api/settings/llm-configs/${id}`, {
      method: 'DELETE',
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || '删除 LLM 配置失败');
    }
    await refresh();
    return payload;
  }, [refresh]);

  const setActiveConfig = useCallback(async (id) => {
    return updateConfig(id, { set_default: true });
  }, [updateConfig]);

  return {
    ...state,
    refresh,
    createConfig,
    updateConfig,
    deleteConfig,
    setActiveConfig,
  };
}
