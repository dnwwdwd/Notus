import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from './Icons';

const MENU_GAP = 6;

export const DropdownSelect = ({
  value,
  options = [],
  onChange,
  disabled,
  placeholder = '请选择',
  searchable = false,
  emptyText = '没有可选项',
  style,
  buttonStyle,
  menuStyle,
  searchPlaceholder = '搜索…',
  maxMenuHeight = 280,
  renderValue,
  renderOption,
  placement = 'auto',
  isOptionSelected,
  closeOnSelect = true,
}) => {
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuPosition, setMenuPosition] = useState(null);

  const selectedOption = useMemo(
    () => options.find((option) => String(option.value) === String(value)) || null,
    [options, value]
  );

  const filteredOptions = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!searchable || !keyword) return options;
    return options.filter((option) => {
      const searchText = [option.label, option.searchText, option.value]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchText.includes(keyword);
    });
  }, [options, query, searchable]);

  const syncMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = Math.min(
      maxMenuHeight + (searchable ? 58 : 0) + 12,
      Math.max(72, filteredOptions.length * 40 + (searchable ? 58 : 0) + 12)
    );
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP;
    const spaceAbove = rect.top - MENU_GAP;
    const resolvedPlacement = placement === 'auto'
      ? (spaceBelow < estimatedHeight && spaceAbove > spaceBelow ? 'top' : 'bottom')
      : placement;

    setMenuPosition({
      top: resolvedPlacement === 'top'
        ? Math.max(MENU_GAP, rect.top - estimatedHeight - MENU_GAP)
        : Math.min(window.innerHeight - estimatedHeight - MENU_GAP, rect.bottom + MENU_GAP),
      left: rect.left,
      width: rect.width,
      placement: resolvedPlacement,
    });
  }, [filteredOptions.length, maxMenuHeight, placement, searchable]);

  useEffect(() => {
    if (!open) return undefined;
    syncMenuPosition();

    const handlePointerDown = (event) => {
      if (triggerRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };

    const handleWindowChange = () => syncMenuPosition();

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
    };
  }, [open, syncMenuPosition]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const triggerLabel = renderValue
    ? renderValue(selectedOption)
    : (selectedOption?.label || placeholder);

  const menu = open && menuPosition ? createPortal(
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: menuPosition.top,
        left: menuPosition.left,
        width: menuPosition.width,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        zIndex: 1300,
        overflow: 'hidden',
        transformOrigin: menuPosition.placement === 'top' ? 'bottom left' : 'top left',
        ...menuStyle,
      }}
    >
      {searchable && (
        <div style={{ padding: 8, borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span style={{ position: 'absolute', left: 10, color: 'var(--text-tertiary)' }}>
              <Icons.search size={13} />
            </span>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              style={{
                width: '100%',
                height: 34,
                padding: '0 10px 0 32px',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-md)',
                fontSize: 'var(--text-sm)',
                color: 'var(--text-primary)',
                outline: 'none',
              }}
            />
          </div>
        </div>
      )}
      <div style={{ maxHeight: maxMenuHeight, overflow: 'auto', padding: 6 }}>
        {filteredOptions.length === 0 ? (
          <div style={{ padding: '10px 12px', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            {emptyText}
          </div>
        ) : filteredOptions.map((option) => {
          const active = isOptionSelected
            ? Boolean(isOptionSelected(option, value))
            : String(option.value) === String(value);
          return (
            <button
              key={option.value}
              onClick={() => {
                onChange?.(option.value, option);
                if (closeOnSelect) setOpen(false);
              }}
              style={{
                width: '100%',
                minHeight: 36,
                padding: '8px 10px',
                borderRadius: 'var(--radius-sm)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                textAlign: 'left',
                background: active ? 'var(--accent-subtle)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-primary)',
                fontSize: 'var(--text-sm)',
              }}
              onMouseEnter={(event) => {
                if (!active) event.currentTarget.style.background = 'var(--bg-hover)';
              }}
              onMouseLeave={(event) => {
                if (!active) event.currentTarget.style.background = 'transparent';
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {renderOption ? renderOption(option, active) : option.label}
              </span>
              {active && <Icons.check size={14} />}
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => !prev);
        }}
        style={{
          width: '100%',
          minHeight: 40,
          padding: '0 12px',
          background: disabled ? 'var(--bg-secondary)' : 'var(--bg-input)',
          border: '1px solid var(--border-primary)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--text-sm)',
          color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)',
          outline: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          ...style,
          ...buttonStyle,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {triggerLabel}
        </span>
        <Icons.chevronDown
          size={14}
          style={{
            color: 'var(--text-secondary)',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform var(--transition-fast)',
            flexShrink: 0,
          }}
        />
      </button>
      {menu}
    </>
  );
};
