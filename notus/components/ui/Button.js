// Button — 4 variants × 3 sizes
import { Spinner } from './Spinner';

export const Button = ({ variant = 'secondary', size = 'md', children, icon, loading, disabled, style, ...rest }) => {
  const sz = {
    sm: { h: 28, fs: 11, px: 10 },
    md: { h: 36, fs: 13, px: 14 },
    lg: { h: 44, fs: 15, px: 18 },
  }[size];

  const vars = {
    primary: { background: 'var(--accent)', color: 'var(--text-on-accent)', border: 'none' },
    secondary: { background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' },
    ghost: { background: 'transparent', color: 'var(--text-primary)', border: 'none' },
    danger: { background: 'var(--danger)', color: '#fff', border: 'none' },
  }[variant];

  return (
    <button
      disabled={disabled || loading}
      style={{
        height: sz.h,
        padding: `0 ${sz.px}px`,
        fontSize: sz.fs,
        fontWeight: 500,
        borderRadius: 'var(--radius-md)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'opacity var(--transition-fast)',
        ...vars,
        ...style,
      }}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon}
      {children}
    </button>
  );
};
