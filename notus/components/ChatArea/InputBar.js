import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../ui/Icons';
import { useShortcuts } from '../../contexts/ShortcutsContext';

function toAttachment(file) {
  const isImage = String(file?.type || '').startsWith('image/');
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: file?.name || '未命名附件',
    type: file?.type || '',
    isImage,
    previewUrl: isImage ? URL.createObjectURL(file) : '',
    file,
  };
}

function AttachmentChip({ item, onRemove }) {
  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 14,
        background: '#F5F4EF',
        border: '1px solid #E8E6DC',
        fontSize: 13,
        color: '#141413',
      }}
    >
      {item.isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.previewUrl}
          alt={item.name}
          style={{ width: 22, height: 22, borderRadius: 8, objectFit: 'cover' }}
        />
      ) : (
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <Icons.file size={15} />
        </span>
      )}
      <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.name}
      </span>
      <button
        type="button"
        onClick={() => onRemove(item.id)}
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#E8E6DC',
          color: '#4A4945',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <Icons.x size={10} />
      </button>
    </div>
  );
}

function MenuItem({ icon, label, hint, active, muted, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={muted}
      style={{
        width: '100%',
        minHeight: 42,
        padding: '0 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        color: active ? '#0B57D0' : muted ? '#B0AEA5' : '#141413',
        cursor: muted ? 'not-allowed' : 'pointer',
        borderRadius: 12,
        opacity: muted ? 0.65 : 1,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: active ? '#0B57D0' : muted ? '#B0AEA5' : '#4A4945', display: 'inline-flex' }}>
          {icon}
        </span>
        <span style={{ fontSize: 14 }}>{label}</span>
      </span>
      {hint ? (
        <span style={{ fontSize: 12, color: active ? '#0B57D0' : '#B0AEA5' }}>{hint}</span>
      ) : null}
    </button>
  );
}

const MODEL_PICKER_WIDTH = 118;
const MODEL_MENU_WIDTH = 204;
const MODEL_MENU_OFFSET = 3;
const MODEL_MENU_EDGE_GAP = 8;

function ModelPicker({ configs = [], selectedId, onChange, disabled }) {
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuPosition, setMenuPosition] = useState(null);

  const options = useMemo(
    () => configs.map((item) => ({
      value: item.id,
      label: item.model || item.name || `模型 ${item.id}`,
      name: item.name || '',
      searchText: [item.model, item.name, item.id].filter(Boolean).join(' '),
    })),
    [configs]
  );

  const selectedOption = useMemo(
    () => options.find((item) => String(item.value) === String(selectedId)) || options[0] || null,
    [options, selectedId]
  );

  const searchable = options.length > 6;
  const filteredOptions = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return options;
    return options.filter((item) => item.searchText.toLowerCase().includes(keyword));
  }, [options, query]);

  const syncMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;

    const rect = trigger.getBoundingClientRect();
    const width = Math.min(MODEL_MENU_WIDTH, Math.max(168, window.innerWidth - MODEL_MENU_EDGE_GAP * 2));
    const estimatedHeight = Math.min(
      252,
      Math.max(72, filteredOptions.length * 34 + (searchable ? 52 : 12))
    );
    const left = Math.min(
      Math.max(MODEL_MENU_EDGE_GAP, rect.right - width),
      window.innerWidth - width - MODEL_MENU_EDGE_GAP
    );

    setMenuPosition({
      top: Math.max(MODEL_MENU_EDGE_GAP, rect.top - estimatedHeight - MODEL_MENU_OFFSET),
      left,
      width,
    });
  }, [filteredOptions.length, searchable]);

  useEffect(() => {
    if (!open) return undefined;
    syncMenuPosition();

    const handlePointerDown = (event) => {
      if (triggerRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const handleWindowChange = () => syncMenuPosition();

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
    };
  }, [open, syncMenuPosition]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const label = selectedOption?.label || '未配置模型';
  const isDisabled = disabled || options.length === 0;

  const menu = open && menuPosition ? createPortal(
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: menuPosition.top,
        left: menuPosition.left,
        width: menuPosition.width,
        padding: 5,
        background: '#fff',
        border: '1px solid #E8E6DC',
        borderRadius: 12,
        boxShadow: '0 10px 26px rgba(20, 20, 19, 0.13)',
        zIndex: 1300,
        transformOrigin: 'bottom right',
      }}
    >
      {searchable && (
        <div style={{ padding: 3, borderBottom: '1px solid #F0EFE8', marginBottom: 3 }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <span style={{ position: 'absolute', left: 10, color: '#8A887F', display: 'inline-flex' }}>
              <Icons.search size={13} />
            </span>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索模型"
              style={{
                width: '100%',
                height: 30,
                padding: '0 10px 0 31px',
                background: '#FAF9F5',
                border: '1px solid #E8E6DC',
                borderRadius: 9,
                outline: 'none',
                color: '#141413',
                fontSize: 13,
              }}
            />
          </div>
        </div>
      )}

      <div style={{ maxHeight: 214, overflow: 'auto', display: 'grid', gap: 2 }}>
        {filteredOptions.length === 0 ? (
          <div style={{ padding: '10px 12px', color: '#8A887F', fontSize: 13 }}>
            没有匹配的模型
          </div>
        ) : filteredOptions.map((option) => {
          const active = String(option.value) === String(selectedOption?.value);
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange?.(option.value);
                setOpen(false);
              }}
              style={{
                width: '100%',
                minHeight: 32,
                padding: '6px 8px',
                borderRadius: 9,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                background: active ? '#F5F0EA' : 'transparent',
                color: active ? '#C15F3C' : '#141413',
                textAlign: 'left',
                cursor: 'pointer',
              }}
              onMouseEnter={(event) => {
                if (!active) event.currentTarget.style.background = '#F7F6F1';
              }}
              onMouseLeave={(event) => {
                if (!active) event.currentTarget.style.background = 'transparent';
              }}
            >
              <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <span style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {option.label}
                </span>
                {option.name && option.name !== option.label ? (
                  <span style={{ fontSize: 11, color: active ? '#C15F3C' : '#8A887F', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {option.name}
                  </span>
                ) : null}
              </span>
              {active ? <Icons.check size={14} /> : null}
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
        aria-label={selectedOption ? `选择模型，当前为 ${label}` : '选择模型'}
        title={label}
        disabled={isDisabled}
        onClick={() => {
          if (isDisabled) return;
          setOpen((prev) => !prev);
        }}
        style={{
          width: MODEL_PICKER_WIDTH,
          height: 34,
          padding: '0 4px',
          borderRadius: 10,
          border: 'none',
          background: 'transparent',
          color: isDisabled ? '#B0AEA5' : open ? '#C15F3C' : '#6B6A65',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 5,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: isDisabled ? 0.68 : 1,
          flex: `0 0 ${MODEL_PICKER_WIDTH}px`,
          minWidth: MODEL_PICKER_WIDTH,
          maxWidth: MODEL_PICKER_WIDTH,
          transition: 'color var(--transition-fast), transform var(--transition-fast), opacity var(--transition-fast)',
        }}
        onMouseDown={(event) => {
          if (!isDisabled) event.currentTarget.style.transform = 'scale(0.97)';
        }}
        onMouseUp={(event) => {
          event.currentTarget.style.transform = 'scale(1)';
        }}
        onBlur={(event) => {
          event.currentTarget.style.transform = 'scale(1)';
        }}
      >
        <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
          {label}
        </span>
        <Icons.chevronUp
          size={13}
          style={{
            color: '#8A887F',
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform var(--transition-fast)',
          }}
        />
      </button>
      {menu}
    </>
  );
}

export const InputBar = ({
  placeholder = '今天需要什么帮助？',
  onSend,
  onStop,
  loading = false,
  injectedValue,
  llmConfigs = [],
  selectedConfigId,
  onConfigChange,
  isEmpty = false,
  disabled = false,
  showPlusMenu = false,
  mentionOptions = [],
  notice = null,
}) => {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(0);
  const textareaRef = useRef(null);
  const shellRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const plusMenuRef = useRef(null);
  const prevInjectedRef = useRef('');
  const attachmentsRef = useRef([]);
  const dragCounterRef = useRef(0);
  const [shellWidth, setShellWidth] = useState(null);
  const { shortcuts, matchShortcut } = useShortcuts();

  const selectedConfig = useMemo(
    () => llmConfigs.find((item) => String(item.id) === String(selectedConfigId)) || llmConfigs[0] || null,
    [llmConfigs, selectedConfigId]
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '40px';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value, isEmpty]);

  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setShellWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!injectedValue || injectedValue === prevInjectedRef.current) return;
    prevInjectedRef.current = injectedValue;
    setValue(injectedValue);
    setCursorIndex(injectedValue.length);
    window.setTimeout(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      const length = injectedValue.length;
      textarea.setSelectionRange(length, length);
    }, 40);
  }, [injectedValue]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (
        plusMenuRef.current?.contains(event.target)
      ) {
        return;
      }
      setPlusMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    attachmentsRef.current.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
  }, []);

  const addFiles = (fileList) => {
    if (!showPlusMenu) return;
    const nextItems = Array.from(fileList || []).map(toAttachment);
    if (nextItems.length === 0) return;
    setAttachments((prev) => [...prev, ...nextItems]);
  };

  const removeAttachment = (id) => {
    setAttachments((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleSend = () => {
    if (!value.trim() || loading || disabled || !selectedConfig) return;
    onSend?.(value.trim(), selectedConfig.id, attachments.map((item) => item.file).filter(Boolean));
    attachments.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
    setValue('');
    setCursorIndex(0);
    setAttachments([]);
    prevInjectedRef.current = '';
    setPlusMenuOpen(false);
  };

  const handleKeyDown = (event) => {
    if (matchShortcut(event, shortcuts.chatSend.combo)) {
      event.preventDefault();
      handleSend();
    }
  };

  const canSend = Boolean(value.trim()) && !loading && !disabled && Boolean(selectedConfig);
  const menuPlacementStyle = { top: 'calc(100% + 8px)' };

  const activeMention = useMemo(() => {
    if (!mentionOptions.length) return null;
    const beforeCursor = value.slice(0, cursorIndex);
    const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) return null;

    const mentionStart = beforeCursor.lastIndexOf('@');
    const query = String(match[1] || '').trim().toLowerCase();
    const options = mentionOptions
      .filter((option) => {
        if (!query) return true;
        const searchText = [
          option.token,
          option.label,
          option.preview,
          option.searchText,
        ].filter(Boolean).join(' ').toLowerCase();
        return searchText.includes(query);
      })
      .slice(0, 8);

    return {
      start: mentionStart,
      end: cursorIndex,
      options,
    };
  }, [cursorIndex, mentionOptions, value]);

  const applyMention = (option) => {
    if (!activeMention) return;
    const token = option?.token || option?.value;
    if (!token) return;

    const nextValue = `${value.slice(0, activeMention.start)}${token} ${value.slice(activeMention.end)}`;
    const nextCursor = activeMention.start + token.length + 1;
    setValue(nextValue);
    setCursorIndex(nextCursor);

    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const narrowInput = shellWidth !== null && shellWidth < 520;
  const shellStyle = {
    maxWidth: 720,
    borderRadius: 18,
    boxShadow: isEmpty ? '0 6px 18px rgba(0, 0, 0, 0.05)' : '0 4px 14px rgba(0, 0, 0, 0.045)',
    border: '1px solid #E5E3D9',
  };

  return (
    <div
      onDragEnter={(event) => {
        if (!showPlusMenu) return;
        event.preventDefault();
        dragCounterRef.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!showPlusMenu) return;
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!showPlusMenu) return;
        event.preventDefault();
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!showPlusMenu) return;
        dragCounterRef.current = 0;
        setDragging(false);
        addFiles(event.dataTransfer.files);
      }}
      style={{
        width: '100%',
        padding: '10px 16px 12px',
        background: 'var(--bg-primary)',
        borderTop: isEmpty ? 'none' : '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = '';
        }}
      />

      <div ref={shellRef} style={{ maxWidth: shellStyle.maxWidth, margin: '0 auto', position: 'relative' }}>
        {notice?.text ? (
          <div
            style={{
              marginBottom: 10,
              padding: '10px 12px',
              borderRadius: 14,
              background: notice.tone === 'accent' ? 'var(--accent-subtle)' : 'var(--bg-secondary)',
              border: `1px solid ${notice.tone === 'accent' ? 'color-mix(in srgb, var(--accent) 24%, var(--border-primary))' : 'var(--border-subtle)'}`,
              color: notice.tone === 'accent' ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            {notice.text}
          </div>
        ) : null}
        {dragging && showPlusMenu && (
          <div
            style={{
              position: 'absolute',
              inset: -10,
              borderRadius: 30,
              border: '2px dashed #D97757',
              background: 'rgba(250, 249, 245, 0.82)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              color: '#D97757',
              zIndex: 4,
              pointerEvents: 'none',
              backdropFilter: 'blur(4px)',
            }}
          >
            <Icons.upload size={18} />
            <span style={{ fontSize: 14, fontWeight: 500 }}>拖拽文件或图片到这里</span>
          </div>
        )}

        <div
          style={{
            background: '#fff',
            ...shellStyle,
            transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
          }}
        >
          {showPlusMenu && attachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '16px 16px 0' }}>
              {attachments.map((item) => (
                <AttachmentChip key={item.id} item={item} onRemove={removeAttachment} />
              ))}
            </div>
          )}

          <div style={{
            position: 'relative',
            display: 'flex',
            alignItems: narrowInput ? 'stretch' : 'flex-end',
            gap: 8,
            padding: '10px',
            flexWrap: narrowInput ? 'wrap' : 'nowrap',
          }}>
            {showPlusMenu && (
              <div ref={plusMenuRef} style={{ position: 'relative', order: narrowInput ? 2 : 0, flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => {
                    setPlusMenuOpen((prev) => !prev);
                  }}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: '#F5F4EF',
                    color: '#4A4945',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  <Icons.plus size={18} />
                </button>

                {plusMenuOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      width: 260,
                      padding: 8,
                      background: '#fff',
                      border: '1px solid #E8E6DC',
                      borderRadius: 18,
                      boxShadow: '0 10px 28px rgba(0, 0, 0, 0.12)',
                      zIndex: 6,
                      ...menuPlacementStyle,
                    }}
                  >
                    <div style={{ display: 'grid', gap: 2 }}>
                      <MenuItem
                        icon={<Icons.paperclip size={15} />}
                        label="添加文件"
                        onClick={() => {
                          fileInputRef.current?.click();
                          setPlusMenuOpen(false);
                        }}
                      />
                      <MenuItem
                        icon={<Icons.image size={15} />}
                        label="添加图片"
                        onClick={() => {
                          imageInputRef.current?.click();
                          setPlusMenuOpen(false);
                        }}
                      />
                      <div style={{ height: 1, background: '#E8E6DC', margin: '4px 8px' }} />
                      <MenuItem
                        icon={<Icons.globe size={15} />}
                        label="网络搜索"
                        hint="即将接入"
                        muted
                      />
                      <MenuItem
                        icon={<Icons.sparkles size={15} />}
                        label="使用风格"
                        hint="即将接入"
                        muted
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div style={{
              flex: narrowInput ? '1 0 100%' : '1 1 auto',
              minWidth: narrowInput ? '100%' : 180,
              position: 'relative',
              order: narrowInput ? 1 : 0,
            }}>
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setCursorIndex(event.target.selectionStart || 0);
                }}
                onKeyDown={handleKeyDown}
                onClick={(event) => setCursorIndex(event.currentTarget.selectionStart || 0)}
                onKeyUp={(event) => setCursorIndex(event.currentTarget.selectionStart || 0)}
                onSelect={(event) => setCursorIndex(event.currentTarget.selectionStart || 0)}
                onPaste={(event) => {
                  if (!showPlusMenu) return;
                  const files = [];
                  const items = event.clipboardData?.items || [];
                  Array.from(items).forEach((item) => {
                    if (item.kind !== 'file') return;
                    const file = item.getAsFile();
                    if (!file) return;
                    files.push(new File([file], file.name || `Pasted-${Date.now()}`, { type: file.type }));
                  });
                  if (files.length > 0) addFiles(files);
                }}
                placeholder={placeholder}
                disabled={disabled}
                rows={1}
                style={{
                  width: '100%',
                  minHeight: 40,
                  maxHeight: 200,
                  padding: '7px 8px',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  overflowY: 'auto',
                  color: disabled ? '#B0AEA5' : '#141413',
                  fontSize: 15,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'break-word',
                  wordBreak: 'normal',
                }}
              />

              {activeMention && (
                <div
                  style={{
                    position: 'absolute',
                    left: 8,
                    right: 8,
                    bottom: 'calc(100% + 10px)',
                    background: '#fff',
                    border: '1px solid #E8E6DC',
                    borderRadius: 16,
                    boxShadow: '0 10px 28px rgba(0, 0, 0, 0.12)',
                    padding: 8,
                    zIndex: 7,
                  }}
                >
                  {activeMention.options.length > 0 ? activeMention.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => applyMention(option)}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        borderRadius: 12,
                        display: 'grid',
                        gap: 4,
                        textAlign: 'left',
                        color: '#141413',
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#C15F3C' }}>{option.token}</span>
                        <span style={{ fontSize: 12, color: '#6B6A65' }}>{option.label}</span>
                      </span>
                      <span style={{ fontSize: 12, color: '#6B6A65', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {option.preview}
                      </span>
                    </button>
                  )) : (
                    <div style={{ padding: '8px 10px', fontSize: 12, color: '#6B6A65' }}>
                      当前文档中没有匹配的块
                    </div>
                  )}
                </div>
              )}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: 6,
                order: narrowInput ? 2 : 0,
                marginLeft: 'auto',
                flex: narrowInput ? '1 1 auto' : '0 0 auto',
                minWidth: 0,
              }}
            >
              <ModelPicker
                configs={llmConfigs}
                selectedId={selectedConfig?.id || ''}
                onChange={(nextValue) => {
                  setPlusMenuOpen(false);
                  onConfigChange?.(nextValue);
                }}
                disabled={llmConfigs.length === 0}
              />

              {loading ? (
                <button
                  type="button"
                  onClick={() => onStop?.()}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: '#141413',
                    color: '#fff',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  <Icons.square size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!canSend}
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: canSend ? '#D97757' : 'rgba(229,227,217,0.8)',
                    color: canSend ? '#fff' : '#B0AEA5',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: canSend ? 'pointer' : 'not-allowed',
                    flexShrink: 0,
                    boxShadow: canSend ? '0 4px 14px rgba(217, 119, 87, 0.22)' : 'none',
                  }}
                >
                  <Icons.arrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
