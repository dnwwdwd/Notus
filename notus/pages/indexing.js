// 兼容旧书签：待索引文件统一在文件工作区内由用户确认处理。
import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { Spinner } from '../components/ui/Spinner';

export default function IndexingPage() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    router.replace('/files');
  }, [router]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Spinner size={16} />正在进入文件工作区…</span>
    </div>
  );
}
