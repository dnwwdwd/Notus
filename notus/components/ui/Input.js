// Input, TextInput, TextArea, Select
import { useState } from 'react';
import { Icons } from './Icons';
import { DropdownSelect } from './DropdownSelect';

export const TextInput = ({ value, placeholder, masked, state, onChange, style, ...rest }) => {
  const [showPassword, setShowPassword] = useState(false);
  const border = { success: 'var(--success)', error: 'var(--danger)' }[state] || 'var(--border-primary)';
  const inputType = masked ? (showPassword ? 'text' : 'password') : 'text';

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input
        type={inputType}
        value={value || ''}
        placeholder={placeholder}
        onChange={onChange}
        style={{
          width: '100%',
          height: 40,
          padding: masked ? '0 36px 0 12px' : (state ? '0 36px 0 12px' : '0 12px'),
          background: 'var(--bg-input)',
          border: `1px solid ${border}`,
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-primary)',
          outline: 'none',
          fontFamily: (masked && !showPassword) ? 'var(--font-mono)' : 'inherit',
          ...style,
        }}
        {...rest}
      />
      {state === 'success' && !masked && (
        <span style={{ position: 'absolute', right: 10, color: 'var(--success)', pointerEvents: 'none' }}>
          <Icons.check size={14} />
        </span>
      )}
      {state === 'error' && !masked && (
        <span style={{ position: 'absolute', right: 10, color: 'var(--danger)', pointerEvents: 'none' }}>
          <Icons.x size={14} />
        </span>
      )}
      {masked && (
        <button
          type="button"
          onClick={() => setShowPassword((v) => !v)}
          tabIndex={-1}
          style={{
            position: 'absolute', right: 8,
            width: 24, height: 24,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: showPassword ? 'var(--accent)' : 'var(--text-tertiary)',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            transition: 'color var(--transition-fast)',
          }}
          onMouseEnter={(e) => { if (!showPassword) e.currentTarget.style.color = 'var(--text-secondary)'; }}
          onMouseLeave={(e) => { if (!showPassword) e.currentTarget.style.color = 'var(--text-tertiary)'; }}
        >
          {showPassword ? <Icons.eyeOff size={14} /> : <Icons.eye size={14} />}
        </button>
      )}
    </div>
  );
};

export const SearchInput = ({ value, placeholder = '搜索…', onChange, style }) => (
  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
    <span style={{ position: 'absolute', left: 10, color: 'var(--text-tertiary)' }}>
      <Icons.search size={13} />
    </span>
    <input
      type="text"
      value={value || ''}
      placeholder={placeholder}
      onChange={onChange}
      style={{
        width: '100%',
        height: 32,
        padding: '0 10px 0 32px',
        background: 'var(--bg-input)',
        border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-sm)',
        color: 'var(--text-primary)',
        outline: 'none',
        ...style,
      }}
    />
  </div>
);

export const SelectInput = ({ value, options = [], onChange, disabled, style }) => (
  <DropdownSelect
    value={value}
    options={options.map((opt) => ({
      value: opt.value || opt,
      label: opt.label || opt,
      searchText: opt.searchText,
    }))}
    onChange={(nextValue, option) => onChange?.({ target: { value: nextValue, option } })}
    disabled={disabled}
    style={style}
  />
);

export const TextArea = ({ value, placeholder, onChange, minRows = 2, style, ...rest }) => (
  <textarea
    value={value || ''}
    placeholder={placeholder}
    onChange={onChange}
    rows={minRows}
    style={{
      width: '100%',
      padding: '10px 12px',
      background: 'var(--bg-input)',
      border: '1px solid var(--border-primary)',
      borderRadius: 'var(--radius-md)',
      fontSize: 'var(--text-sm)',
      color: 'var(--text-primary)',
      resize: 'none',
      outline: 'none',
      lineHeight: 1.6,
      ...style,
    }}
    {...rest}
  />
);
