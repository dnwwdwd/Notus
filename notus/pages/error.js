// Fatal error page — no Shell
import { useRouter } from 'next/router';
import { Icons } from '../components/ui/Icons';
import { Button } from '../components/ui/Button';
import { navigateWithFallback } from '../utils/navigation';

export default function ErrorPage() {
  const router = useRouter();
  const { message = '索引数据库无法打开。可能是上次非正常关闭造成的文件锁未释放。' } = router.query;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'var(--bg-primary)',
    }}>
      <div style={{ textAlign: 'center', maxWidth: 440, padding: 24 }}>
        <div style={{ display: 'inline-flex', color: 'var(--danger)', marginBottom: 20 }}>
          <Icons.warn size={56} />
        </div>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 8 }}>出了点问题</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.7 }}>
          {message}
        </div>
        <div style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          padding: 12,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--text-secondary)',
          textAlign: 'left',
          marginBottom: 24,
        }}>
          Error: LOCK: Resource temporarily unavailable<br />
          &nbsp;&nbsp;at Database.open (index.db:LOCK)
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <Button variant="secondary" icon={<Icons.refresh size={14} />} onClick={() => window.location.reload()}>
            重新加载
          </Button>
          <Button variant="primary" icon={<Icons.settings size={14} />} onClick={() => navigateWithFallback(router, '/settings/model')}>
            前往设置
          </Button>
        </div>
      </div>
    </div>
  );
}
