import { useEffect, useRef, useState } from 'react';

// 渲染一次完整内容，用容器高度渐显；不在每个动画帧重新解析 Markdown。
export function ProgressiveReveal({ children, animate = false }) {
  const initialAnimate = useRef(animate);
  const contentRef = useRef(null);
  const [height, setHeight] = useState(animate ? 0 : null);
  const [duration, setDuration] = useState(0);
  useEffect(() => {
    if (!initialAnimate.current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setHeight(null);
      return undefined;
    }
    const node = contentRef.current;
    const target = node?.scrollHeight || 0;
    const initialWidth = node?.getBoundingClientRect().width || 0;
    let stopped = false;
    const finish = () => { stopped = true; observer?.disconnect(); setHeight(null); };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      // 面板拖动或字体/媒体加载改变布局时，立即恢复自然高度。
      if (Math.abs((node?.getBoundingClientRect().width || 0) - initialWidth) > 1 || node?.scrollHeight !== target) finish();
    });
    if (node) observer?.observe(node);
    const ms = Math.min(1800, Math.max(240, target * 3));
    setDuration(ms);
    const frame = requestAnimationFrame(() => { if (!stopped) setHeight(target); });
    const timer = setTimeout(finish, ms + 80);
    return () => { stopped = true; observer?.disconnect(); cancelAnimationFrame(frame); clearTimeout(timer); };
  }, []);
  return <div style={{height: height === null ? 'auto' : height, overflow: height === null ? 'visible' : 'hidden', transition: height === null ? 'none' : `height ${duration}ms linear`}}>
    <div ref={contentRef} className="notus-reveal-content">{children}</div>
  </div>;
}
