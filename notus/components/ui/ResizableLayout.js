// ResizableLayout — two panels separated by a draggable divider
// left / right: React nodes rendered in each panel
// initialLeftPercent: starting width of left panel as percentage of container
import { useCallback, useRef, useState } from 'react';

export const ResizableLayout = ({
  left,
  right,
  initialLeftPercent = 44,
  minLeftPercent = 15,
  maxLeftPercent = 82,
  style,
}) => {
  const [leftPercent, setLeftPercent] = useState(initialLeftPercent);
  const dragging = useRef(false);
  const containerRef = useRef(null);
  const handleRef = useRef(null);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    if (handleRef.current) handleRef.current.style.background = 'var(--accent)';

    const onMove = (event) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((event.clientX - rect.left) / rect.width) * 100;
      setLeftPercent(Math.min(Math.max(pct, minLeftPercent), maxLeftPercent));
    };

    const onUp = () => {
      dragging.current = false;
      if (handleRef.current) handleRef.current.style.background = 'var(--border-subtle)';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [minLeftPercent, maxLeftPercent]);

  return (
    <div ref={containerRef} style={{ flex: 1, display: 'flex', overflow: 'hidden', ...style }}>
      {/* Left panel */}
      <div style={{ width: `${leftPercent}%`, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
        {left}
      </div>

      {/* Drag handle */}
      <div
        ref={handleRef}
        onMouseDown={onMouseDown}
        onMouseEnter={() => { if (!dragging.current && handleRef.current) handleRef.current.style.background = 'var(--accent-muted)'; }}
        onMouseLeave={() => { if (!dragging.current && handleRef.current) handleRef.current.style.background = 'var(--border-subtle)'; }}
        style={{
          width: 4,
          flexShrink: 0,
          background: 'var(--border-subtle)',
          cursor: 'col-resize',
          transition: 'background var(--transition-fast)',
          position: 'relative',
          zIndex: 1,
        }}
      />

      {/* Right panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        {right}
      </div>
    </div>
  );
};
