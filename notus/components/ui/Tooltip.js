import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GAP = 8;

export const Tooltip = ({ content, children, placement = 'top', gap = GAP, disabled = false, triggerStyle = null }) => {
  const triggerRef = useRef(null);
  const tooltipRef = useRef(null);
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

      setPosition({ top, left, placement, horizontal: 'center' });
    };

    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [disabled, gap, open, placement]);

  useLayoutEffect(() => {
    if (!open || !position || !tooltipRef.current) return;
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    if (!triggerRect) return;

    if (tooltipRect.left < 12 && position.horizontal !== 'left') {
      setPosition((current) => current ? { ...current, left: 12, horizontal: 'left' } : current);
      return;
    }
    if (tooltipRect.right > window.innerWidth - 12 && position.horizontal !== 'right') {
      setPosition((current) => current ? { ...current, left: window.innerWidth - 12, horizontal: 'right' } : current);
      return;
    }
    if (tooltipRect.top < 8 && position.placement === 'top') {
      setPosition((current) => current ? { ...current, top: triggerRect.bottom + gap, placement: 'bottom' } : current);
      return;
    }
    if (tooltipRect.bottom > window.innerHeight - 8 && position.placement === 'bottom') {
      setPosition((current) => current ? { ...current, top: triggerRect.top - gap, placement: 'top' } : current);
    }
  }, [gap, open, position]);

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
        style={{ display: 'inline-flex', ...(triggerStyle || {}) }}
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
          ref={tooltipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
            transform: `${position.horizontal === 'left' ? 'translateX(0)' : position.horizontal === 'right' ? 'translateX(-100%)' : 'translateX(-50%)'} ${position.placement === 'bottom' ? 'translateY(0)' : 'translateY(-100%)'}`,
            zIndex: 1400,
            background: 'var(--text-primary)',
            color: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 8px',
            fontSize: 'var(--text-xs)',
            lineHeight: 1.4,
            boxShadow: 'var(--shadow-md)',
            maxWidth: 'calc(100vw - 24px)',
            boxSizing: 'border-box',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            textAlign: 'left',
          }}
        >
          {content}
        </div>,
        document.body
      ) : null}
    </>
  );
};
