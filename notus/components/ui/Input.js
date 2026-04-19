// Input, TextInput, TextArea, Select
import { Icons } from './Icons';
import { DropdownSelect } from './DropdownSelect';

export const TextInput = ({ value, placeholder, masked, state, onChange, style, ...rest }) => {
  const border = { success: 'var(--success)', error: 'var(--danger)' }[state] || 'var(--border-primary)';
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input
        type={masked ? 'password' : 'text'}
        value={value || ''}
        placeholder={placeholder}
        onChange={onChange}
        style={{
          width: '100%',
          height: 40,
          padding: '0 36px 0 12px',
          background: 'var(--bg-input)',
          border: `1px solid ${border}`,
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-primary)',
          outline: 'none',
          fontFamily: masked ? 'var(--font-mono)' : 'inherit',
          ...style,
        }}
        {...rest}
      />
      {state === 'success' && (
        <span style={{ position: 'absolute', right: 10, color: 'var(--success)' }}>
          <Icons.check size={14} />
        </span>
      )}
      {state === 'error' && (
        <span style={{ position: 'absolute', right: 10, color: 'var(--danger)' }}>
          <Icons.x size={14} />
        </span>
      )}
      {masked && !state && (
        <span style={{ position: 'absolute', right: 10, color: 'var(--text-tertiary)' }}>
          <Icons.eye size={14} />
        </span>
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
