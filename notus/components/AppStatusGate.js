import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import { Spinner } from './ui/Spinner';
import { useAppStatus } from '../contexts/AppStatusContext';

function isBootstrapRoute(pathname = '') {
  return pathname === '/' ||
    pathname === '/setup' ||
    pathname === '/indexing';
}

function resolveTarget(pathname, status) {
  if (pathname === '/') {
    if (status.needsSetup) return '/setup';
    if (status.needsIndexing) return '/indexing';
    return '/files';
  }

  if (pathname === '/setup') {
    if (!status.needsSetup) {
      return status.needsIndexing ? '/indexing' : '/files';
    }
    return null;
  }

  if (pathname === '/indexing') {
    if (status.needsSetup) return '/setup';
    return null;
  }

  return null;
}

export function AppStatusGate({ children }) {
  const router = useRouter();
  const { status, loading } = useAppStatus();

  const shouldGate = useMemo(() => (
    isBootstrapRoute(router.pathname)
  ), [router.pathname]);

  const redirectTarget = useMemo(
    () => resolveTarget(router.pathname, status),
    [router.pathname, status]
  );

  useEffect(() => {
    if (!router.isReady || loading || !redirectTarget || redirectTarget === router.asPath) return;
    router.replace(redirectTarget);
  }, [loading, redirectTarget, router]);

  if (shouldGate && (loading || redirectTarget)) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
          <Spinner size={18} />
          <span>正在检查初始化状态…</span>
        </div>
      </div>
    );
  }

  return children;
}
