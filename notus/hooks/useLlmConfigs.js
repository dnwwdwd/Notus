import { useCallback, useEffect, useState } from 'react';
import { readJsonResponse } from '../utils/fetchJson';

const LLM_CONFIGS_CACHE_KEY = 'notus-llm-configs-cache';

// 模块级共享：同一页面内任何实例（设置页、文件工作区等）刷新配置后，
// 通过监听器把最新数据同步给所有已挂载实例，避免设置里新增模型后
// 其他位置的模型列表要等重新挂载才更新。
const configStateListeners = new Set();
let latestSharedConfigState = null;

function notifyConfigStateListeners(nextState) {
  latestSharedConfigState = nextState;
  configStateListeners.forEach((listener) => {
    try {
      listener(nextState);
    } catch {}
  });
}

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
  const [state, setState] = useState({
    configs: [],
    activeConfigId: null,
    loading: true,
  });

  const refresh = useCallback(async ({ forceLoading = false } = {}) => {
    const hasCache = typeof window !== 'undefined' && Boolean(window.sessionStorage.getItem(LLM_CONFIGS_CACHE_KEY));
    if ((forceLoading || !hasCache) && !latestSharedConfigState) {
      setState((prev) => ({ ...prev, loading: true }));
    }

    const response = await fetch('/api/settings');
    const payload = await readJsonResponse(response, { fallbackMessage: '读取 LLM 配置失败' });

    const nextState = {
      configs: payload.llm_configs || [],
      activeConfigId: payload.active_llm_config_id || null,
      loading: false,
    };
    setState(nextState);
    writeCachedConfigs(nextState);
    notifyConfigStateListeners(nextState);

    return payload;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const applySharedState = (next) => {
      if (!cancelled) setState(next);
    };
    configStateListeners.add(applySharedState);

    const cached = readCachedConfigs();
    if (latestSharedConfigState) {
      // 其他实例已加载过数据：直接采用，避免先渲染旧缓存再跳加载态
      setState(latestSharedConfigState);
    } else if (cached) {
      setState(cached);
    }

    refresh({ forceLoading: !cached && !latestSharedConfigState }).catch(() => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, loading: false }));
    });

    return () => {
      cancelled = true;
      configStateListeners.delete(applySharedState);
    };
  }, [refresh]);

  const createConfigs = useCallback(async (input) => {
    const response = await fetch('/api/settings/llm-configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await readJsonResponse(response, { fallbackMessage: '新增 LLM 配置失败' });
    await refresh();
    return Array.isArray(payload.items) ? payload.items : [];
  }, [refresh]);

  const updateConfig = useCallback(async (id, input) => {
    const response = await fetch(`/api/settings/llm-configs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await readJsonResponse(response, { fallbackMessage: '更新 LLM 配置失败' });
    await refresh();
    return payload.item;
  }, [refresh]);

  const deleteConfig = useCallback(async (id) => {
    const response = await fetch(`/api/settings/llm-configs/${id}`, {
      method: 'DELETE',
    });
    const payload = await readJsonResponse(response, { fallbackMessage: '删除 LLM 配置失败' });
    await refresh();
    return payload;
  }, [refresh]);

  const setActiveConfig = useCallback(async (id) => {
    return updateConfig(id, { set_default: true });
  }, [updateConfig]);

  return {
    ...state,
    refresh,
    createConfigs,
    updateConfig,
    deleteConfig,
    setActiveConfig,
  };
}
