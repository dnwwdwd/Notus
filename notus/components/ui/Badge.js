// Badge — 5 variants
export const Badge = ({ tone = 'default', children, style }) => {
  const tones = {
    default: { background: 'var(--bg-secondary)', color: 'var(--text-secondary)' },
    accent: { background: 'var(--accent-subtle)', color: 'var(--accent)' },
    warning: { background: 'var(--warning-subtle)', color: 'var(--warning)' },
    danger: { background: 'var(--danger-subtle)', color: 'var(--danger)' },
    success: { background: 'var(--success-subtle)', color: 'var(--success)' },
  }[tone];

  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 500,
        padding: '2px 8px',
        borderRadius: 'var(--radius-full)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        ...tones,
        ...style,
      }}
    >
      {children}
    </span>
  );
};
