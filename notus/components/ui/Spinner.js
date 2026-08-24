// Spinner component
export const Spinner = ({ size = 24 }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      border: '2px solid var(--border-primary)',
      borderTopColor: 'var(--accent)',
      animation: 'spin 0.8s linear infinite',
      display: 'inline-block',
      flexShrink: 0,
    }}
  />
);
