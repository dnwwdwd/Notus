// ProgressBar
export const ProgressBar = ({ value, max = 100, label, style }) => {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={style}>
      {label && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</div>
      )}
      <div style={{
        height: 6,
        background: 'var(--bg-active)',
        borderRadius: 'var(--radius-full)',
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${pct}%`,
          background: 'var(--accent)',
          borderRadius: 'var(--radius-full)',
          transition: 'width var(--transition-normal)',
        }} />
      </div>
    </div>
  );
};
