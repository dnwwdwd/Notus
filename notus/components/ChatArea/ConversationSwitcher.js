import { DropdownSelect } from '../ui/DropdownSelect';
import { Button } from '../ui/Button';
import { formatConversationOption, getConversationTitle } from '../../utils/conversations';

export function ConversationSwitcher({
  scopeLabel,
  conversations = [],
  activeConversationId = null,
  isDraft = false,
  disabled = false,
  loading = false,
  onSelect,
  onCreateNew,
  emptyText = '暂无历史对话',
}) {
  const currentConversation = conversations.find((item) => String(item.id) === String(activeConversationId)) || null;
  const currentTitle = isDraft ? '新对话' : getConversationTitle(currentConversation);
  const options = conversations.map((conversation) => ({
    value: conversation.id,
    label: getConversationTitle(conversation),
    searchText: `${conversation.title || ''} ${conversation.preview || ''}`,
    conversation,
  }));

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{scopeLabel}</div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onCreateNew}
          disabled={disabled}
        >
          新建对话
        </Button>
      </div>
      <div style={{ maxWidth: 360 }}>
        <DropdownSelect
          value={activeConversationId || ''}
          options={options}
          onChange={(value, option) => onSelect?.(value, option?.conversation)}
          disabled={disabled || loading || options.length === 0}
          searchable={options.length > 6}
          emptyText={emptyText}
          placeholder={options.length > 0 ? '选择历史对话' : emptyText}
          searchPlaceholder="按标题或内容搜索历史对话"
          renderValue={() => currentTitle}
          renderOption={(option) => formatConversationOption(option.conversation)}
        />
      </div>
    </div>
  );
}
