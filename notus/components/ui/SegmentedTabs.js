import { Tooltip } from './Tooltip';

export function SegmentedTabs({ value, options = [], onChange, ariaLabel, disabled = false, minWidth = 62, height = 30, style, responsiveLabels = false, className = '' }) {
  return (
    <div className={['notus-segmented-tabs', responsiveLabels ? 'notus-segmented-tabs--responsive-labels' : '', className].filter(Boolean).join(' ')} role="tablist" aria-label={ariaLabel} style={{ display: 'inline-flex', width: 'fit-content', justifySelf: 'start', alignItems: 'center', gap: 2, minWidth: 0, maxWidth: '100%', padding: 2, boxSizing: 'border-box', overflowX: 'auto', overflowY: 'hidden', borderRadius: 10, background: 'var(--bg-hover)', boxShadow: 'inset 0 0 0 1px var(--border-subtle)', opacity: disabled ? 0.55 : 1, ...style }}>
      {options.map((option) => {
        const active = option.value === value;
        const Icon = option.icon;
        const button = (
          <button key={option.value} type="button" role="tab" aria-selected={active} aria-label={option.ariaLabel || option.label} disabled={disabled} onClick={() => onChange?.(option.value)} style={{ minWidth, height, padding: '0 8px', border: '1px solid transparent', borderRadius: 8, background: active ? 'var(--bg-elevated)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text-tertiary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, fontSize: 12, fontWeight: 700, boxShadow: active ? '0 1px 3px rgba(45,45,45,0.08), inset 0 0 0 1px rgba(217,119,87,0.14)' : 'none', cursor: disabled ? 'not-allowed' : 'pointer', transition: 'transform var(--transition-fast), background var(--transition-fast), color var(--transition-fast)' }} onMouseDown={(event) => { event.currentTarget.style.transform = 'scale(0.96)'; }} onMouseUp={(event) => { event.currentTarget.style.transform = 'scale(1)'; }} onMouseLeave={(event) => { event.currentTarget.style.transform = 'scale(1)'; }}>
            {Icon ? <Icon size={13} /> : null}
            <span className="notus-segmented-tabs__label notus-segmented-tabs__label--full">{option.label}</span>
            {responsiveLabels && option.compactLabel ? <span className="notus-segmented-tabs__label notus-segmented-tabs__label--compact" aria-hidden="true">{option.compactLabel}</span> : null}
          </button>
        );
        return option.description ? <Tooltip key={option.value} content={option.description} placement="top" disabled={disabled}>{button}</Tooltip> : button;
      })}
      <style jsx>{`
        .notus-segmented-tabs__label--compact { display: none; }
        @media (max-width: 720px) {
          .notus-segmented-tabs--responsive-labels .notus-segmented-tabs__label--full { display: none; }
          .notus-segmented-tabs--responsive-labels .notus-segmented-tabs__label--compact { display: inline; }
          .notus-segmented-tabs--responsive-labels button { min-width: 0 !important; padding-inline: 7px !important; }
        }
      `}</style>
    </div>
  );
}
