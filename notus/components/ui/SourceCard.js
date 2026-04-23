// SourceCard — citation card from knowledge retrieval
import { Icons } from './Icons';

export const SourceCard = ({ kind, file, path, quote, lines, imageProxyUrl, imageAltText, imageCaption, onClick }) => {
  const imageHit = Boolean(imageProxyUrl || imageAltText || imageCaption);
  const previewText = quote || imageCaption || imageAltText || '';
  const kindLabel = kind === 'style' ? '风格' : '';

  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3)',
        marginBottom: 8,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.borderColor = 'var(--accent)';
          e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-primary)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Icons.file size={13} />
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>{file}</span>
        {path && (
          <>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>›</span>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>{path}</span>
          </>
        )}
        {lines && (
          <span style={{
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            color: 'var(--accent)',
            background: 'var(--accent-subtle)',
            padding: '1px 6px',
            borderRadius: 3,
          }}>{lines}</span>
        )}
        {kindLabel && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10,
            color: 'var(--accent)',
            background: 'var(--accent-subtle)',
            padding: '1px 6px',
            borderRadius: 999,
          }}>
            {kindLabel}
          </span>
        )}
        {imageHit && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10,
            color: 'var(--text-secondary)',
            background: 'var(--bg-secondary)',
            padding: '1px 6px',
            borderRadius: 999,
          }}>
            <Icons.image size={10} />
            图片
          </span>
        )}
        <div style={{ flex: 1 }} />
        <Icons.chevronRight size={12} />
      </div>
      {previewText && (
        <div style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--text-tertiary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          &quot;{previewText}&quot;
        </div>
      )}
    </div>
  );
};
