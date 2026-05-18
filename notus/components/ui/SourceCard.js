// SourceCard — citation card from knowledge retrieval
import { Icons } from './Icons';
import { getVisibleDocumentLabel } from '../../lib/documentLabels';

export const SourceCard = ({ file, path, quote, lines, imageProxyUrl, imageAltText, imageCaption, selected = false, onClick }) => {
  const imageHit = Boolean(imageProxyUrl || imageAltText || imageCaption);
  const previewText = quote || imageCaption || imageAltText || '';
  const baseBorderColor = selected
    ? 'color-mix(in srgb, var(--accent) 48%, var(--border-primary))'
    : 'var(--border-subtle)';
  const baseBackground = selected
    ? 'color-mix(in srgb, var(--accent-subtle) 76%, var(--bg-primary))'
    : 'color-mix(in srgb, var(--bg-primary) 84%, var(--bg-elevated))';
  const baseBoxShadow = selected ? 'var(--shadow-sm)' : '0 1px 2px rgba(20, 20, 19, 0.04)';
  const fileLabel = getVisibleDocumentLabel(file, '未命名文档');

  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-pressed={selected}
      onKeyDown={(event) => {
        if (!onClick) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      style={{
        background: baseBackground,
        border: `1px solid ${baseBorderColor}`,
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3)',
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: baseBoxShadow,
        transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast), background-color var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.borderColor = 'var(--accent)';
          e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
          e.currentTarget.style.background = 'color-mix(in srgb, var(--accent-subtle) 62%, var(--bg-primary))';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = baseBorderColor;
        e.currentTarget.style.boxShadow = baseBoxShadow;
        e.currentTarget.style.background = baseBackground;
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Icons.file size={13} />
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>{fileLabel}</span>
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
          lineHeight: 1.6,
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 2,
          overflow: 'hidden',
        }}>
          &quot;{previewText}&quot;
        </div>
      )}
    </div>
  );
};
