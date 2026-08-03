import { Icons } from '../ui/Icons';
import { Tooltip } from '../ui/Tooltip';

export function MentionItem({ id, type = 'file', name, path, description = '', readonly = false, inline = false, nodeId, onRemove, onPreview, onPrefetch }) {
  // 与侧边文件树展开目录保持同一图标语义。
  const Icon = type === 'folder' ? Icons.folderOpen : type === 'skill' ? Icons.skill : Icons.file;
  const isSkill = type === 'skill';
  const interactive = typeof onPreview === 'function' && !isSkill;
  const label = String(name || (type === 'folder' ? '未命名目录' : type === 'skill' ? '未命名 Skill' : '未命名文件'));
  const title = isSkill ? (description || '未提供 Skill 描述') : (path ? `${label}\n${path}` : label);

  const openPreview = () => onPreview?.({ id, type, name: label, path });
  const onKeyDown = (event) => {
    if (!interactive) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPreview();
    }
  };

  const item = (
    <span
      className={`notus-mention-item${inline ? ' notus-mention-item--inline' : ''}`}
      data-mention-id={id}
      data-mention-type={type}
      data-mention-node-id={nodeId}
      contentEditable={inline ? false : undefined}
      title={title}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onMouseDown={inline ? (event) => event.preventDefault() : undefined}
      onMouseEnter={!isSkill ? () => onPrefetch?.({ id, type, name: label, path, description }) : undefined}
      onFocus={!isSkill ? () => onPrefetch?.({ id, type, name: label, path, description }) : undefined}
      onClick={interactive ? (event) => {
        if (inline) event.preventDefault();
        openPreview();
      } : undefined}
      onKeyDown={onKeyDown}
      aria-label={interactive ? `预览${type === 'folder' ? '目录' : '笔记'}：${label}` : (isSkill ? `Skill：${label}` : undefined)}
      style={{ cursor: interactive ? 'pointer' : 'default' }}
    >
      <Icon size={16} stroke={1.7} style={{ color: 'var(--accent)', flexShrink: 0 }} />
      <span className="notus-mention-item__label">{label}</span>
      {!readonly && typeof onRemove === 'function' ? (
        <button
          type="button"
          className="notus-mention-item__remove"
          aria-label={`移除 mention：${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <Icons.x size={13} />
        </button>
      ) : null}
    </span>
  );

  return isSkill ? <Tooltip content={title}>{item}</Tooltip> : item;
}
