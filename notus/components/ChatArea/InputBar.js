// InputBar — message input with model selector and send button
// injectedValue: when set externally (e.g. from canvas block AI button), syncs into the textarea
import { useState, useRef, useEffect } from 'react';
import { DropdownSelect } from '../ui/DropdownSelect';
import { Icons } from '../ui/Icons';
import { useShortcuts } from '../../contexts/ShortcutsContext';

const MODELS = [
  'qwen-max',
  'qwen-plus',
  'claude-opus-4-5',
  'claude-sonnet-4-6',
  'deepseek-v3',
];

export const InputBar = ({
  placeholder = '问点什么…',
  onSend,
  loading,
  injectedValue,
  model,
  onModelChange,
}) => {
  const [value, setValue] = useState('');
  const [selectedModel, setSelectedModel] = useState(model || MODELS[0]);
  const textareaRef = useRef(null);
  const prevInjected = useRef('');
  const { shortcuts, matchShortcut } = useShortcuts();

  useEffect(() => {
    if (model) setSelectedModel(model);
  }, [model]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [value]);

  // Sync injected value from parent (e.g. canvas block AI button)
  useEffect(() => {
    if (injectedValue && injectedValue !== prevInjected.current) {
      prevInjected.current = injectedValue;
      setValue(injectedValue);
      setTimeout(() => {
        textareaRef.current?.focus();
        const len = injectedValue.length;
        textareaRef.current?.setSelectionRange(len, len);
      }, 50);
    }
  }, [injectedValue]);

  const handleSend = () => {
    if (!value.trim() || loading) return;
    onSend?.(value.trim(), selectedModel);
    setValue('');
    prevInjected.current = '';
  };

  const handleKeyDown = (e) => {
    if (matchShortcut(e, shortcuts.chatSend.combo)) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={{
      background: 'var(--bg-elevated)',
      borderTop: '1px solid var(--border-subtle)',
      padding: '12px 16px',
      flexShrink: 0,
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        {/* Model selector */}
        <div style={{ width: 180, flexShrink: 0 }}>
          <DropdownSelect
            value={selectedModel}
            options={MODELS.map((item) => ({ value: item, label: item }))}
            onChange={(nextValue) => {
              setSelectedModel(nextValue);
              onModelChange?.(nextValue);
            }}
            searchable={false}
            placement="top"
            buttonStyle={{
              minHeight: 32,
              height: 32,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-subtle)',
              fontSize: 11,
              color: 'var(--text-secondary)',
            }}
            menuStyle={{ minWidth: 180 }}
          />
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          style={{
            flex: 1,
            minHeight: 40,
            maxHeight: 120,
            padding: '10px 14px',
            background: 'var(--bg-input)',
            border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-primary)',
            resize: 'none',
            outline: 'none',
            lineHeight: 1.5,
            overflowY: 'auto',
            transition: 'border-color var(--transition-fast)',
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-primary)'; }}
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!value.trim() || loading}
          style={{
            width: 40, height: 40,
            borderRadius: 'var(--radius-full)',
            background: 'var(--accent)',
            color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            opacity: !value.trim() || loading ? 0.4 : 1,
            cursor: !value.trim() || loading ? 'not-allowed' : 'pointer',
            flexShrink: 0,
            transition: 'opacity var(--transition-fast)',
          }}
        >
          {loading
            ? <span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'block' }} />
            : <Icons.send size={16} />}
        </button>
      </div>
    </div>
  );
};
