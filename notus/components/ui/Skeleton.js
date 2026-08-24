// Skeleton shimmer loading placeholders
export const Skeleton = ({ width = '100%', height = 16, style }) => (
  <div
    style={{
      width,
      height,
      borderRadius: 'var(--radius-sm)',
      background: 'linear-gradient(90deg, var(--bg-secondary) 25%, var(--bg-hover) 50%, var(--bg-secondary) 75%)',
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.5s infinite',
      ...style,
    }}
  />
);

export const SkeletonText = ({ lines = 5 }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    {[0.6, 1, 1, 0.9, 0.85, 1, 0.7].slice(0, lines).map((w, i) => (
      <Skeleton key={i} width={`${w * 100}%`} height={i === 0 ? 24 : 14} />
    ))}
  </div>
);

export const SkeletonBlock = () => (
  <Skeleton width="100%" height={80} style={{ borderRadius: 'var(--radius-md)' }} />
);
