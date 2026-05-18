import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GAP = 8;

export const Tooltip = ({ content, children, placement = 'top', gap = GAP, disabled = false }) => {
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open || disabled) return undefined;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const top = placement === 'bottom'
        ? Math.min(window.innerHeight - gap, rect.bottom + gap)
        : Math.max(gap, rect.top - gap);
      const left = Math.min(
        Math.max(centerX, 12),
        window.innerWidth - 12
      );

      setPosition({ top, left, placement });
    };

    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [disabled, gap, open, placement]);

  useEffect(() => {
    if (!open) return undefined;

    const close = () => setOpen(false);
    document.addEventListener('mousedown', close, true);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', close, true);

    return () => {
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', close, true);
    };
  }, [open]);

  useEffect(() => {
    if (!disabled) return undefined;
    setOpen(false);
    return undefined;
  }, [disabled]);

  return (
    <>
      <span
        ref={triggerRef}
        style={{ display: 'inline-flex' }}
        onMouseEnter={() => { if (!disabled) setOpen(true); }}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => { if (!disabled) setOpen(true); }}
        onBlur={() => setOpen(false)}
        onPointerDown={() => setOpen(false)}
        onClick={() => setOpen(false)}
      >
        {children}
      </span>
      {mounted && open && position && content && !disabled ? createPortal(
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
            transform: position.placement === 'bottom' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            zIndex: 1400,
            background: 'var(--text-primary)',
            color: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 8px',
            fontSize: 'var(--text-xs)',
            lineHeight: 1.4,
            boxShadow: 'var(--shadow-md)',
            maxWidth: 220,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {content}
        </div>,
        document.body
      ) : null}
    </>
  );
};
