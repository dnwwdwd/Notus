import { MentionItem } from './MentionItem';

export function MentionList({ mentions = [], readonly = false, onRemove, onPreview, style }) {
  if (!Array.isArray(mentions) || mentions.length === 0) return null;
  return (
    <div className="notus-mention-list" style={style}>
      {mentions.map((mention, index) => (
        <MentionItem
          key={`${mention.type}-${mention.id || mention.path || index}`}
          {...mention}
          readonly={readonly}
          onRemove={onRemove ? () => onRemove(mention, index) : undefined}
          onPreview={onPreview ? () => onPreview(mention) : undefined}
        />
      ))}
    </div>
  );
}
