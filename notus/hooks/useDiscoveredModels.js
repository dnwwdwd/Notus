import { useEffect, useMemo, useState } from 'react';

function normalizeOptions(options = []) {
  const map = new Map();
  options.forEach((item) => {
    if (!item?.value) return;
    const key = String(item.value).trim();
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, {
        value: key,
        label: item.label || key,
        dimension: item.dimension,
        multimodal: Boolean(item.multimodal),
        source: item.source || 'fallback',
      });
    }
  });
  return [...map.values()];
}

export function useDiscoveredModels({ kind, provider, baseUrl, apiKey, fallbackOptions = [] }) {
  const fallback = useMemo(() => normalizeOptions(fallbackOptions), [fallbackOptions]);
  const [state, setState] = useState(() => ({
    models: fallback,
    loading: false,
    source: 'fallback',
    requestId: null,
  }));

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setState((prev) => ({
        ...prev,
        loading: true,
        models: prev.models.length > 0 ? prev.models : fallback,
      }));

      try {
        const response = await fetch('/api/models', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind,
            provider,
            base_url: baseUrl,
            api_key: apiKey,
          }),
        });
        const payload = await response.json();
        if (cancelled) return;

        const models = normalizeOptions(payload.models || []);
        setState({
          models: models.length > 0 ? models : fallback,
          loading: false,
          source: payload.source || 'fallback',
          requestId: payload.request_id || null,
        });
      } catch {
        if (cancelled) return;
        setState({
          models: fallback,
          loading: false,
          source: 'fallback',
          requestId: null,
        });
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [apiKey, baseUrl, fallback, kind, provider]);

  return {
    ...state,
    models: state.models.length > 0 ? state.models : fallback,
  };
}
