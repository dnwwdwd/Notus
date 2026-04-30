// Root bootstrap route: decide destination from current app status.
import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { Spinner } from '../components/ui/Spinner';
import { useAppStatus } from '../contexts/AppStatusContext';

export default function Home() {
  const router = useRouter();
  const { status, loading } = useAppStatus();

  useEffect(() => {
    if (!router.isReady || loading) return;
    const target = status.needsSetup
      ? '/setup'
      : (status.needsIndexing ? '/indexing' : '/files');
    if (router.asPath === target) return;
    router.replace(target);
  }, [loading, router, status.needsIndexing, status.needsSetup]);

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
