import { useCallback, useEffect, useState } from 'react';

const LLM_CONFIGS_CACHE_KEY = 'notus-llm-configs-cache';

function readCachedConfigs() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(LLM_CONFIGS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      configs: Array.isArray(parsed?.configs) ? parsed.configs : [],
      activeConfigId: parsed?.activeConfigId || null,
      loading: false,
    };
  } catch {
    return null;
  }
}

function writeCachedConfigs(nextState) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(LLM_CONFIGS_CACHE_KEY, JSON.stringify({
      configs: Array.isArray(nextState?.configs) ? nextState.configs : [],
      activeConfigId: nextState?.activeConfigId || null,
    }));
  } catch {}
}

export function useLlmConfigs() {
  const [state, setState] = useState(() => readCachedConfigs() || {
    configs: [],
    activeConfigId: null,
    loading: true,
  });

  const refresh = useCallback(async ({ forceLoading = false } = {}) => {
    const hasCache = typeof window !== 'undefined' && Boolean(window.sessionStorage.getItem(LLM_CONFIGS_CACHE_KEY));
    if (forceLoading || !hasCache) {
      setState((prev) => ({ ...prev, loading: true }));
    }

    const response = await fetch('/api/settings');
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || '读取 LLM 配置失败');
    }

    const nextState = {
      configs: payload.llm_configs || [],
      activeConfigId: payload.active_llm_config_id || null,
      loading: false,
    };
    setState(nextState);
    writeCachedConfigs(nextState);

    return payload;
  }, []);

  useEffect(() => {
    let cancelled = false;

    refresh({ forceLoading: !readCachedConfigs() }).catch(() => {
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
