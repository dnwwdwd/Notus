import { Button } from './Button';
import { Icons } from './Icons';

export function AiLockedState({
  title = 'AI 功能尚未就绪',
  description = '先完成 LLM 与 Embedding 配置后，这里的生成、问答和检索能力才会开放。',
  actionLabel = '前往设置',
  onAction,
  compact = false,
  variant = 'inline',
}) {
  const card = (
    <div
      style={{
        width: '100%',
        maxWidth: compact ? 420 : 520,
        padding: compact ? '24px 22px' : '34px 30px',
        borderRadius: compact ? 'var(--radius-xl)' : '24px',
        border: '1px solid color-mix(in srgb, var(--accent) 18%, var(--border-subtle))',
        background: 'color-mix(in srgb, var(--bg-elevated) 96%, #fff 4%)',
        boxShadow: compact ? 'var(--shadow-md)' : '0 18px 44px rgba(26, 23, 18, 0.12)',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: compact ? 48 : 58,
          height: compact ? 48 : 58,
          borderRadius: compact ? 16 : 18,
          margin: '0 auto 16px',
          background: 'color-mix(in srgb, var(--accent-subtle) 82%, #fff 18%)',
          color: 'var(--accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 16%, transparent)',
        }}
      >
        <Icons.lock size={compact ? 22 : 26} />
      </div>
      <div style={{ fontSize: compact ? 'var(--text-base)' : 'var(--text-xl)', fontWeight: 700, marginBottom: 10 }}>
        {title}
      </div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.75, marginBottom: 18 }}>
        {description}
      </div>
      {onAction && (
        <Button variant="primary" onClick={onAction} size={compact ? 'md' : 'lg'}>
          {actionLabel}
        </Button>
      )}
    </div>
  );

  if (variant === 'modal') {
    return (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: 'rgba(247, 244, 238, 0.76)',
          backdropFilter: 'blur(8px)',
          zIndex: 40,
        }}
      >
        {card}
      </div>
    );
  }

  return card;
}
