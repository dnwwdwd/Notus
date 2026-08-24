// /login — OIDC intermediate state
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { NotusLogo } from '../components/ui/Icons';
import { Spinner } from '../components/ui/Spinner';
import { Button } from '../components/ui/Button';

export default function LoginPage() {
  const router = useRouter();
  const [state, setState] = useState('loading'); // loading | timeout | error
  const [showRetry, setShowRetry] = useState(false);

  useEffect(() => {
    // Simulate 5s OIDC timeout
    const t = setTimeout(() => setShowRetry(true), 5000);
    // Simulate successful login after 2s for demo
    const loginTimer = setTimeout(() => {
      router.replace('/files');
    }, 2000);
    return () => { clearTimeout(t); clearTimeout(loginTimer); };
  }, [router]);

  const handleRetry = () => {
    setShowRetry(false);
    setState('loading');
    setTimeout(() => router.replace('/files'), 1500);
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: 'var(--bg-primary)',
    }}>
      <div style={{ textAlign: 'center', padding: 24 }}>
        <div style={{ display: 'inline-flex', marginBottom: 20 }}>
          <NotusLogo size={64} />
        </div>
        <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, letterSpacing: -0.4, marginBottom: 4 }}>
          Notus
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 40 }}>
          你的笔记，你的 AI 副驾驶
        </div>

        {state === 'loading' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
            <Spinner size={18} />
            <span>正在登录…</span>
          </div>
        )}

        {state === 'error' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <span style={{ color: 'var(--danger)', fontSize: 36 }}>✕</span>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>登录失败，请重试</div>
          </div>
        )}

        {showRetry && (
          <div style={{ marginTop: 16, animation: 'fadeIn var(--transition-slow)' }}>
            <Button variant="ghost" onClick={handleRetry}>重新登录</Button>
          </div>
        )}
      </div>
    </div>
  );
}
