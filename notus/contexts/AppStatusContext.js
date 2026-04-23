import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const AppStatusContext = createContext(null);

function defaultSetup() {
  return {
    configured: false,
    completed: false,
    indexed_files: 0,
    total_files: 0,
    notes_dir: '',
    model_configured: false,
    indexed: false,
    embedding_provider: '',
    embedding_multimodal_enabled: false,
    llm_provider: '',
  };
}

function defaultIndex() {
  return {
    total: 0,
    ready: 0,
    degraded: 0,
    queued: 0,
    running: 0,
    indexed: 0,
    pending: 0,
    failed: 0,
    active_generation: null,
    rebuild_generation: null,
  };
}

function normalizeIndexStatus(index = {}, setup = {}) {
  const total = Number(index.total ?? setup.total_files ?? 0) || 0;
  const ready = Number(index.ready ?? 0) || 0;
  const degraded = Number(index.degraded ?? 0) || 0;
  const queued = Number(index.queued ?? 0) || 0;
  const running = Number(index.running ?? 0) || 0;
  const indexed = Number(index.indexed ?? ready + degraded ?? setup.indexed_files ?? 0) || 0;
  const pending = Number(index.pending ?? queued + running ?? Math.max(total - indexed, 0)) || 0;
  const failed = Number(index.failed ?? 0) || 0;
  return {
    total,
    ready,
    degraded,
    queued,
    running,
    indexed,
    pending,
    failed,
    active_generation: index.active_generation || null,
    rebuild_generation: index.rebuild_generation || null,
  };
}

function deriveStatus(setup = defaultSetup(), index = defaultIndex()) {
  const nextIndex = normalizeIndexStatus(index, setup);
  const needsSetup = !setup.completed;
  const hasBackgroundIndexing = nextIndex.pending > 0 ||
    Boolean(nextIndex.rebuild_generation && ['queued', 'building', 'catching_up', 'validated'].includes(nextIndex.rebuild_generation.state));
  const needsIndexing = !needsSetup &&
    nextIndex.total > 0 &&
    !nextIndex.active_generation &&
    nextIndex.indexed === 0 &&
    hasBackgroundIndexing;
  return {
    setup,
    index: nextIndex,
    needsSetup,
    needsIndexing,
    hasBackgroundIndexing,
    hasIndexIssues: nextIndex.failed > 0,
    readyForApp: !needsSetup && !needsIndexing,
  };
}

export function AppStatusProvider({ children }) {
  const [status, setStatus] = useState(() => deriveStatus());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshStatus = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);

    try {
      const [setupResponse, indexResponse] = await Promise.all([
        fetch('/api/setup/status', { cache: 'no-store' }),
        fetch('/api/index/status', { cache: 'no-store' }),
      ]);

      const setupPayload = await setupResponse.json();
      const indexPayload = await indexResponse.json();

      if (!setupResponse.ok) {
        throw new Error(setupPayload.error || '读取初始化状态失败');
      }
      if (!indexResponse.ok) {
        throw new Error(indexPayload.error || '读取索引状态失败');
      }

      const next = deriveStatus(setupPayload, indexPayload);
      setStatus(next);
      setError(null);
      return next;
    } catch (refreshError) {
      setError(refreshError);
      throw refreshError;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus().catch(() => {});
  }, [refreshStatus]);

  useEffect(() => {
    if (!status.hasBackgroundIndexing) return undefined;
    const timer = setInterval(() => {
      refreshStatus({ quiet: true }).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [refreshStatus, status.hasBackgroundIndexing]);

  const value = useMemo(() => ({
    status,
    loading,
    error,
    refreshStatus,
  }), [error, loading, refreshStatus, status]);

  return (
    <AppStatusContext.Provider value={value}>
      {children}
    </AppStatusContext.Provider>
  );
}

export function useAppStatus() {
  const context = useContext(AppStatusContext);
  if (!context) throw new Error('useAppStatus must be used within AppStatusProvider');
  return context;
}
