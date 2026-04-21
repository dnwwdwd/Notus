import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import { Spinner } from './ui/Spinner';
import { useAppStatus } from '../contexts/AppStatusContext';

function isProtectedRoute(pathname = '') {
  return pathname === '/files' ||
    pathname === '/knowledge' ||
    pathname === '/canvas' ||
    pathname.startsWith('/settings');
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

  if (isProtectedRoute(pathname)) {
    if (status.needsSetup) return '/setup';
    if (status.needsIndexing) return '/indexing';
  }

  return null;
}

export function AppStatusGate({ children }) {
  const router = useRouter();
  const { status, loading } = useAppStatus();

  const shouldGate = useMemo(() => (
    router.pathname === '/' ||
    router.pathname === '/setup' ||
    router.pathname === '/indexing' ||
    isProtectedRoute(router.pathname)
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
