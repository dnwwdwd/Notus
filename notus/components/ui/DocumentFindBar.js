import { useEffect, useRef } from 'react';
import { Icons } from './Icons';

export function DocumentFindBar({
  open,
  query,
  total = 0,
  current = 0,
  onChange,
  onPrev,
  onNext,
  onClose,
  placeholder = '搜索当前文档',
}) {
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        right: 18,
        zIndex: 30,
        minWidth: 320,
        maxWidth: 'min(420px, calc(100% - 36px))',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-lg)',
        padding: 10,
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }}>
            <Icons.search size={13} />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onChange?.(event.target.value)}
            placeholder={placeholder}
            style={{
              width: '100%',
              height: 38,
              padding: '0 12px 0 32px',
              background: 'var(--bg-input)',
              border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-primary)',
              outline: 'none',
            }}
          />
        </div>

        <div style={{ minWidth: 56, textAlign: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
          {query.trim()
            ? (total > 0 ? `${Math.min(current + 1, total)} / ${total}` : '0 / 0')
            : '输入关键词'}
        </div>

        <button
          type="button"
          onClick={onPrev}
          disabled={!query.trim() || total === 0}
          style={{
            width: 30,
            height: 30,
            borderRadius: 'var(--radius-md)',
            color: query.trim() && total > 0 ? 'var(--text-primary)' : 'var(--text-tertiary)',
            opacity: query.trim() && total > 0 ? 1 : 0.45,
          }}
          title="上一个匹配"
        >
          <Icons.chevronUp size={14} />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!query.trim() || total === 0}
          style={{
            width: 30,
            height: 30,
            borderRadius: 'var(--radius-md)',
            color: query.trim() && total > 0 ? 'var(--text-primary)' : 'var(--text-tertiary)',
            opacity: query.trim() && total > 0 ? 1 : 0.45,
          }}
          title="下一个匹配"
        >
          <Icons.chevronDown size={14} />
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{
            width: 30,
            height: 30,
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-secondary)',
          }}
          title="关闭搜索"
        >
          <Icons.x size={14} />
        </button>
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', padding: '0 2px' }}>
        搜索当前文档内容，回车或按钮切换匹配项，`Esc` 关闭。
      </div>
    </div>
  );
}
