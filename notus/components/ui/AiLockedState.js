import { Button } from './Button';
import { Icons } from './Icons';

export function AiLockedState({
  title = 'AI 功能尚未就绪',
  description = '先完成 LLM 与 Embedding 配置后，这里的生成、问答和检索能力才会开放。',
  actionLabel = '前往设置',
  onAction,
  compact = false,
}) {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: compact ? 420 : 520,
        padding: compact ? '22px 20px' : '28px 24px',
        borderRadius: 'var(--radius-xl)',
        border: '1px solid var(--border-subtle)',
        background: 'color-mix(in srgb, var(--bg-elevated) 92%, var(--bg-primary))',
        boxShadow: 'var(--shadow-md)',
        textAlign: 'center',
      }}
    >
      <div style={{ width: 44, height: 44, borderRadius: 14, margin: '0 auto 14px', background: 'var(--accent-subtle)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icons.lock size={20} />
      </div>
      <div style={{ fontSize: compact ? 'var(--text-base)' : 'var(--text-lg)', fontWeight: 600, marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: 16 }}>
        {description}
      </div>
      {onAction && (
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
