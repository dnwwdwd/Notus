import { memo, useEffect, useRef, useState } from 'react';

function elapsedLabel(milliseconds, running) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  // 首秒只显示处理状态，满一秒后开始显示真实秒数，避免预填 1 秒后停顿。
  if (running && seconds === 0) return '';
  const value = Math.max(1, seconds);
  if (value < 60) return `${value} 秒`;
  const remainder = value % 60;
  return `${Math.floor(value / 60)} 分${remainder ? ` ${remainder} 秒` : ''}`;
}

export const TraceStatus = memo(function TraceStatus({ phase, startedAt, finishedAt, running }) {
  const animate = useRef(running);
  if (running) animate.current = true;
  const stoppedAt = running ? 0 : finishedAt;
  const [elapsed, setElapsed] = useState(() => startedAt ? elapsedLabel((running ? Date.now() : finishedAt) - startedAt, running) : '');
  useEffect(() => {
    if (!startedAt) { setElapsed(''); return undefined; }
    if (!running) { setElapsed(elapsedLabel(stoppedAt - startedAt, false)); return undefined; }
    const initial = Math.max(0, Date.now() - startedAt);
    const anchor = performance.now();
    const update = () => setElapsed(elapsedLabel(initial + performance.now() - anchor, true));
    update();
    // 只在整秒变化时触发这个小组件更新；不依赖 SSE，后台标签页恢复时补齐真实时长。
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [startedAt, stoppedAt, running]);
  return <span className="notus-agent-trace-status" role="status" aria-live="off" data-running={running || undefined} data-animate={animate.current || undefined}>
    <span key={phase} className="notus-agent-trace-status__phase">{phase}</span>
    {elapsed ? <span key={`${phase}-${elapsed}`} className="notus-agent-trace-status__elapsed">{phase === '任务已提交' ? ` · 已等待 ${elapsed}` : ` ${elapsed}`}</span> : null}
  </span>;
});
