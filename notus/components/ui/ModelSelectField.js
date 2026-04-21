import { DropdownSelect } from './DropdownSelect';
import { TextInput } from './Input';
import { Spinner } from './Spinner';

export const ModelSelectField = ({
  value,
  options = [],
  onChange,
  loading = false,
  selectPlaceholder = '从候选模型中选择',
  inputPlaceholder = '也可以直接输入模型名',
}) => (
  <div style={{ display: 'grid', gap: 8 }}>
    <DropdownSelect
      value={value}
      options={options}
      onChange={(nextValue) => onChange?.(nextValue)}
      searchable
      searchPlaceholder="搜索候选模型"
      placeholder={selectPlaceholder}
      renderValue={(selectedOption) => selectedOption?.label || value || selectPlaceholder}
    />
    <TextInput
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      placeholder={inputPlaceholder}
    />
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-tertiary)' }}>
      {loading ? <Spinner size={12} /> : null}
      <span>{loading ? '正在尝试获取最新模型列表，失败时会自动回退到内置候选。' : '可直接输入模型名；未命中内置模型时会按当前填写值保存。'}</span>
    </div>
  </div>
);
