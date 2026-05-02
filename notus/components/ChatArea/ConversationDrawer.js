import { Icons } from '../ui/Icons';
import { Spinner } from '../ui/Spinner';
import { getConversationTitle } from '../../utils/conversations';

export function ConversationDrawer({
  open = false,
  onClose,
  conversations = [],
  activeConversationId = null,
  loading = false,
  emptyText = '暂无历史对话',
  onSelect,
}) {
  if (!open) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 12,
        display: 'flex',
        justifyContent: 'flex-end',
        animation: 'fadeIn var(--transition-fast)',
      }}
    >
      <button
        type="button"
        aria-label="关闭历史对话抽屉"
        onClick={onClose}
        style={{
          flex: 1,
          background: 'rgba(26, 19, 17, 0.18)',
          backdropFilter: 'blur(2px)',
          cursor: 'pointer',
        }}
      />
      <div
        style={{
          width: 'min(360px, calc(100vw - 32px))',
          height: '100%',
          background: 'var(--bg-elevated)',
          borderLeft: '1px solid var(--border-primary)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          animation: 'drawerIn var(--transition-normal)',
        }}
      >
        <div
          style={{
            height: 52,
            padding: '0 14px 0 16px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>历史对话</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭历史对话"
            style={{
              width: 28,
              height: 28,
              borderRadius: 'var(--radius-sm)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <Icons.x size={14} />
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch', minHeight: 0 }}>
          {loading ? (
            <div style={{ minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}>
              <Spinner size={18} />
            </div>
          ) : conversations.length === 0 ? (
            <div
              style={{
                minHeight: 120,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-tertiary)',
                fontSize: 'var(--text-sm)',
              }}
            >
              {emptyText}
            </div>
          ) : conversations.map((conversation) => {
            const active = Number(conversation.id) === Number(activeConversationId);
            const title = getConversationTitle(conversation);
            const preview = String(conversation.preview || '').trim();

            return (
              <button
                key={conversation.id}
                type="button"
                onClick={() => onSelect?.(conversation.id, conversation)}
                style={{
                  width: '100%',
                  padding: '12px 12px 11px',
                  borderRadius: 'var(--radius-lg)',
                  border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 30%, var(--border-primary))' : 'var(--border-subtle)'}`,
                  background: active ? 'var(--accent-subtle)' : 'var(--bg-primary)',
                  color: active ? 'var(--accent)' : 'var(--text-primary)',
                  textAlign: 'left',
                  display: 'grid',
                  gap: 6,
                  cursor: 'pointer',
                  transition: 'background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast)',
                }}
              >
                <div
                  style={{
                    fontSize: 'var(--text-sm)',
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {title}
                </div>
                {preview && preview !== title && (
                  <div
                    style={{
                      fontSize: 'var(--text-xs)',
                      color: active ? 'var(--accent)' : 'var(--text-tertiary)',
                      lineHeight: 1.6,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {preview}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
