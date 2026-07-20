import { Icons } from '../ui/Icons';

export function MentionItem({ id, type = 'file', name, path, readonly = false, inline = false, nodeId, onRemove, onPreview }) {
  // 与侧边文件树展开目录保持同一图标语义。
  const Icon = type === 'folder' ? Icons.folderOpen : type === 'skill' ? Icons.skill : Icons.file;
  const interactive = typeof onPreview === 'function';
  const label = String(name || (type === 'folder' ? '未命名目录' : type === 'skill' ? '未命名 Skill' : '未命名文件'));
  const title = path ? `${label}\n${path}` : label;

  const openPreview = () => onPreview?.({ id, type, name: label, path });
  const onKeyDown = (event) => {
    if (!interactive) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPreview();
    }
  };

  return (
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
      onClick={interactive ? (event) => {
        if (inline) event.preventDefault();
        openPreview();
      } : undefined}
      onKeyDown={onKeyDown}
      aria-label={interactive ? `预览${type === 'folder' ? '目录' : type === 'skill' ? 'Skill' : '笔记'}：${label}` : undefined}
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
}
