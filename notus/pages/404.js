// 404 page
import { useRouter } from 'next/router';
import { Shell } from '../components/Layout/Shell';
import { Button } from '../components/ui/Button';
import { Icons } from '../components/ui/Icons';

export default function NotFoundPage() {
  const router = useRouter();
  return (
    <Shell active="" tocDisabled>
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-primary)',
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontSize: 96,
            fontWeight: 700,
            color: 'var(--text-primary)',
            opacity: 0.12,
            letterSpacing: -2,
            lineHeight: 1,
            marginBottom: 16,
            fontFamily: 'var(--font-editor)',
          }}>
            404
          </div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 500, marginBottom: 6 }}>这里什么都没有</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginBottom: 20, maxWidth: 320 }}>
            你要找的页面可能被移动了，或者从来没有存在过
          </div>
          <Button variant="secondary" icon={<Icons.home size={14} />} onClick={() => router.push('/files')}>
            返回首页
          </Button>
        </div>
      </div>
    </Shell>
  );
}
