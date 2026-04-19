// EmptyState — centered placeholder for empty lists/pages
export const EmptyState = ({ icon, title, subtitle, action }) => (
  <div style={{
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--space-8)',
    textAlign: 'center',
  }}>
    {icon && (
      <div style={{ opacity: 0.3, marginBottom: 16, color: 'var(--text-secondary)', display: 'flex', justifyContent: 'center' }}>
        {icon}
      </div>
    )}
    {title && (
      <div style={{ fontSize: 'var(--text-base)', fontWeight: 500, marginBottom: 6 }}>{title}</div>
    )}
    {subtitle && (
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginBottom: 16, maxWidth: 360, lineHeight: 1.6 }}>
        {subtitle}
      </div>
    )}
    {action}
  </div>
);
