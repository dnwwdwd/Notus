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
    const target = contentRef.current?.scrollHeight || 0;
    const ms = Math.min(1800, Math.max(240, target * 3));
    setDuration(ms);
    const frame = requestAnimationFrame(() => setHeight(target));
    const timer = setTimeout(() => setHeight(null), ms + 80);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, []);
  return <div style={{height: height === null ? 'auto' : height, overflow: height === null ? 'visible' : 'hidden', transition: height === null ? 'none' : `height ${duration}ms linear`}}>
    <div ref={contentRef}>{children}</div>
  </div>;
}
