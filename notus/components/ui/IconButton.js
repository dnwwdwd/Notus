export function IconButton({
  label,
  active = false,
  disabled = false,
  size = 32,
  children,
  style,
  ...rest
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      style={{
        width: size,
        height: size,
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 28%, var(--border-primary))' : 'var(--border-primary)'}`,
        background: active ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast), opacity var(--transition-fast)',
        flexShrink: 0,
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
