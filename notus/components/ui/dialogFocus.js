// 弹窗初始聚焦工具。
//
// 背景：Radix DropdownMenu 等浮层在关闭时会在 setTimeout(0) 里把焦点还给触发元素。
// 如果弹窗的输入框只在挂载时 autoFocus，菜单的这次延迟聚焦会把焦点抢回标签/菜单按钮，
// 表现为“弹窗已打开但光标不在输入框”。
//
// 这里用同样的 setTimeout(0) 排队，保证在菜单的焦点恢复之后再执行弹窗自己的聚焦。
export function scheduleInitialFocus(ref, { select = false, delay = 0 } = {}) {
  if (typeof window === 'undefined') return () => {};
  const timer = window.setTimeout(() => {
    const node = ref?.current;
    if (!node || typeof node.focus !== 'function') return;
    node.focus({ preventScroll: true });
    if (select && typeof node.select === 'function') {
      try { node.select(); } catch { /* 部分 input 类型不支持 select */ }
    }
  }, delay);
  return () => window.clearTimeout(timer);
}
