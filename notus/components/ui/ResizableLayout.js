// ResizableLayout — two panels separated by a draggable divider
// left / right: React nodes rendered in each panel
// initialLeftPercent: starting width of left panel as percentage of container
import { useCallback, useEffect, useRef, useState } from 'react';

export const ResizableLayout = ({
  left,
  right,
  initialLeftPercent = 44,
  minLeftPercent = 15,
  maxLeftPercent = 82,
  minLeftPx = 0,
  minRightPx = 0,
  leftPercent,
  onLeftPercentChange,
  onLeftPercentCommit,
  style,
}) => {
  const containerRef = useRef(null);
  const handleRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const clampPercent = useCallback((value) => {
    const parsed = Number.parseFloat(value);
    const fallback = Number.isFinite(parsed) ? parsed : initialLeftPercent;
    const handleWidth = 4;
    const pxMinPercent = containerWidth > 0 && minLeftPx > 0
      ? (minLeftPx / containerWidth) * 100
      : minLeftPercent;
    const pxMaxPercent = containerWidth > 0 && minRightPx > 0
      ? ((containerWidth - minRightPx - handleWidth) / containerWidth) * 100
      : maxLeftPercent;
    const resolvedMin = Math.max(minLeftPercent, pxMinPercent);
    const resolvedMax = Math.min(maxLeftPercent, pxMaxPercent);
    if (resolvedMin > resolvedMax) return Math.min(Math.max(fallback, minLeftPercent), maxLeftPercent);
    return Math.min(Math.max(fallback, resolvedMin), resolvedMax);
  }, [containerWidth, initialLeftPercent, maxLeftPercent, minLeftPercent, minLeftPx, minRightPx]);
  const controlled = Number.isFinite(Number(leftPercent));
  const [internalLeftPercent, setInternalLeftPercent] = useState(() => clampPercent(initialLeftPercent));
  const dragging = useRef(false);
  const resolvedLeftPercent = clampPercent(controlled ? leftPercent : internalLeftPercent);
  const latestLeftPercentRef = useRef(resolvedLeftPercent);

  useEffect(() => {
    latestLeftPercentRef.current = resolvedLeftPercent;
  }, [resolvedLeftPercent]);

  useEffect(() => {
    if (controlled) return;
    setInternalLeftPercent(clampPercent(initialLeftPercent));
  }, [clampPercent, controlled, initialLeftPercent]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const updateLeftPercent = useCallback((value) => {
    const nextPercent = clampPercent(value);
    latestLeftPercentRef.current = nextPercent;
    if (!controlled) {
      setInternalLeftPercent((prev) => (Math.abs(prev - nextPercent) < 0.01 ? prev : nextPercent));
    }
    onLeftPercentChange?.(nextPercent);
    return nextPercent;
  }, [clampPercent, controlled, onLeftPercentChange]);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    if (handleRef.current) handleRef.current.style.background = 'var(--accent)';

    const onMove = (event) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((event.clientX - rect.left) / rect.width) * 100;
      updateLeftPercent(pct);
    };

    const onUp = () => {
      dragging.current = false;
      if (handleRef.current) handleRef.current.style.background = 'var(--border-subtle)';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onLeftPercentCommit?.(latestLeftPercentRef.current);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onLeftPercentCommit, updateLeftPercent]);

  return (
    <div ref={containerRef} style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0, ...style }}>
      {/* Left panel */}
      <div style={{ width: `${resolvedLeftPercent}%`, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0, minWidth: minLeftPx || 0, minHeight: 0 }}>
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
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: minRightPx || 0, minHeight: 0 }}>
        {right}
      </div>
    </div>
  );
};
