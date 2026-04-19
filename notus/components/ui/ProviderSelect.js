import { DropdownSelect } from './DropdownSelect';

export const ProviderSelect = ({ value, catalog, onChange, disabled, style, searchable = false }) => (
  <DropdownSelect
    value={value}
    options={catalog.map((provider) => ({
      value: provider.value,
      label: provider.label,
    }))}
    onChange={(nextValue) => onChange?.(nextValue)}
    disabled={disabled}
    searchable={searchable}
    style={style}
  />
);
