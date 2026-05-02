import { Button } from '../ui/Button';
import { Icons } from '../ui/Icons';

export function RetryPreviewCard({ onRetry, loading = false }) {
  return (
    <div style={{
      marginTop: 12,
      padding: '14px 16px',
      borderRadius: 'var(--radius-lg)',
      background: 'var(--bg-ai-bubble)',
      border: '1px solid var(--border-primary)',
      display: 'grid',
      gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-primary)' }}>
        <span style={{ color: 'var(--warning)', display: 'inline-flex' }}><Icons.warn size={14} /></span>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>预览生成没有完成</span>
      </div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        你的回答已经保存，可以直接重试生成预览，不需要重新回答卡片。
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="button" variant="primary" size="sm" onClick={onRetry} loading={loading}>
          重试生成预览
        </Button>
      </div>
    </div>
  );
}
