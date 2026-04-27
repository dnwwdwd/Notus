import { useEffect, useMemo, useRef, useState } from 'react';
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
}) => {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const plusMenuRef = useRef(null);
  const modelMenuRef = useRef(null);
  const prevInjectedRef = useRef('');
  const attachmentsRef = useRef([]);
  const dragCounterRef = useRef(0);
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
    if (!injectedValue || injectedValue === prevInjectedRef.current) return;
    prevInjectedRef.current = injectedValue;
    setValue(injectedValue);
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
        plusMenuRef.current?.contains(event.target) ||
        modelMenuRef.current?.contains(event.target)
      ) {
        return;
      }
      setPlusMenuOpen(false);
      setModelMenuOpen(false);
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
    setAttachments([]);
    prevInjectedRef.current = '';
    setPlusMenuOpen(false);
    setModelMenuOpen(false);
  };

  const handleKeyDown = (event) => {
    if (matchShortcut(event, shortcuts.chatSend.combo)) {
      event.preventDefault();
      handleSend();
    }
  };

  const canSend = Boolean(value.trim()) && !loading && !disabled && Boolean(selectedConfig);
  const menuPlacementStyle = isEmpty
    ? { top: 'calc(100% + 8px)' }
    : { bottom: 'calc(100% + 8px)' };

  const shellStyle = isEmpty
    ? {
      maxWidth: 720,
      borderRadius: 24,
      boxShadow: '0 10px 34px rgba(0, 0, 0, 0.05)',
      border: '1px solid #E5E3D9',
    }
    : {
      maxWidth: 720,
      borderRadius: 22,
      boxShadow: '0 10px 28px rgba(0, 0, 0, 0.05)',
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
        padding: isEmpty ? '12px 16px 16px' : '10px 16px 12px',
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

      <div style={{ maxWidth: shellStyle.maxWidth, margin: '0 auto', position: 'relative' }}>
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

          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 10px 10px 10px' }}>
            {showPlusMenu && (
              <div ref={plusMenuRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => {
                    setPlusMenuOpen((prev) => !prev);
                    setModelMenuOpen(false);
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

            <div style={{ flex: 1, minWidth: 0 }}>
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={handleKeyDown}
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
                  minHeight: isEmpty ? 54 : 40,
                  maxHeight: 200,
                  padding: isEmpty ? '14px 8px' : '7px 8px',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  overflowY: 'auto',
                  color: disabled ? '#B0AEA5' : '#141413',
                  fontSize: 15,
                  lineHeight: 1.7,
                }}
              />
            </div>

            <div ref={modelMenuRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                onClick={() => {
                  if (llmConfigs.length === 0) return;
                  setModelMenuOpen((prev) => !prev);
                  setPlusMenuOpen(false);
                }}
                style={{
                  height: 34,
                  maxWidth: isEmpty ? 180 : 150,
                  padding: '0 10px',
                  borderRadius: 10,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  color: selectedConfig ? '#4A4945' : '#B0AEA5',
                  cursor: llmConfigs.length === 0 ? 'not-allowed' : 'pointer',
                  flexShrink: 0,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 500 }}>
                  {selectedConfig?.name || '未配置模型'}
                </span>
                <Icons.chevronDown size={14} style={{ color: '#B0AEA5' }} />
              </button>

              {modelMenuOpen && llmConfigs.length > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    width: 260,
                    maxHeight: 280,
                    overflow: 'auto',
                    padding: 8,
                    background: '#fff',
                    border: '1px solid #E8E6DC',
                    borderRadius: 18,
                    boxShadow: '0 10px 28px rgba(0, 0, 0, 0.12)',
                    zIndex: 6,
                    ...menuPlacementStyle,
                  }}
                >
                  {llmConfigs.map((item) => {
                    const active = String(item.id) === String(selectedConfig?.id);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          onConfigChange?.(item.id);
                          setModelMenuOpen(false);
                        }}
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          borderRadius: 14,
                          display: 'grid',
                          gap: 4,
                          textAlign: 'left',
                          background: active ? '#F5E7E1' : 'transparent',
                          color: active ? '#C15F3C' : '#141413',
                          marginBottom: 4,
                        }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontSize: 14, fontWeight: 600 }}>{item.name}</span>
                          {active ? <Icons.check size={14} /> : null}
                        </span>
                        <span style={{ fontSize: 12, color: active ? '#C15F3C' : '#6B6A65' }}>
                          {item.provider} · {item.model}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

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
