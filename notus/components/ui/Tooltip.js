import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GAP = 8;

export const Tooltip = ({ content, children, placement = 'top', gap = GAP }) => {
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return undefined;

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
  }, [gap, open, placement]);

  return (
    <>
      <span
        ref={triggerRef}
        style={{ display: 'inline-flex' }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {children}
      </span>
      {mounted && open && position && content ? createPortal(
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
