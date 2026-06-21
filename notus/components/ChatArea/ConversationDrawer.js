import { useState } from 'react';
import { Icons } from '../ui/Icons';
import { Spinner } from '../ui/Spinner';
import { ConfirmDialog } from '../ui/Dialog';
import { getConversationTitle } from '../../utils/conversations';

export function ConversationDrawer({
  open = false,
  onClose,
  conversations = [],
  activeConversationId = null,
  loading = false,
  emptyText = '暂无历史对话',
  onSelect,
  onDelete,
  onExport,
  deletingConversationId = null,
  exportingConversationId = null,
}) {
  const [pendingDelete, setPendingDelete] = useState(null);
  if (!open) return null;
  const pendingDeleteTitle = getConversationTitle(pendingDelete);

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
            const deleting = Number(deletingConversationId) === Number(conversation.id);
            const exporting = Number(exportingConversationId) === Number(conversation.id);

            return (
              <div
                key={conversation.id}
                style={{
                  width: '100%',
                  padding: '10px 10px 10px 12px',
                  borderRadius: 'var(--radius-lg)',
                  border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 30%, var(--border-primary))' : 'var(--border-subtle)'}`,
                  background: active ? 'var(--accent-subtle)' : 'var(--bg-primary)',
                  color: active ? 'var(--accent)' : 'var(--text-primary)',
                  textAlign: 'left',
                  display: 'grid',
                  gridTemplateColumns: onExport ? 'minmax(0, 1fr) 28px 28px' : 'minmax(0, 1fr) 28px',
                  columnGap: 8,
                  alignItems: 'start',
                  cursor: 'default',
                  transition: 'background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast)',
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelect?.(conversation.id, conversation)}
                  style={{
                    minWidth: 0,
                    display: 'grid',
                    gap: 6,
                    textAlign: 'left',
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 0,
                    border: 0,
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
                {onExport ? (
                  <button
                    type="button"
                    aria-label={`导出历史对话 ${title}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (exporting) return;
                      onExport(conversation.id, conversation);
                    }}
                    disabled={exporting}
                    title="导出对话"
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 'var(--radius-sm)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: exporting ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                      opacity: exporting ? 0.45 : 0.88,
                      cursor: exporting ? 'not-allowed' : 'pointer',
                      border: 0,
                      padding: 0,
                      background: 'transparent',
                    }}
                  >
                    {exporting ? <Spinner size={13} /> : <Icons.download size={13} />}
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={`删除历史对话 ${title}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (deleting) return;
                    setPendingDelete(conversation);
                  }}
                  disabled={deleting}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 'var(--radius-sm)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: deleting ? 'var(--text-tertiary)' : 'var(--danger)',
                    opacity: deleting ? 0.45 : 0.86,
                    cursor: deleting ? 'not-allowed' : 'pointer',
                    border: 0,
                    padding: 0,
                    background: 'transparent',
                  }}
                >
                  {deleting ? <Spinner size={13} /> : <Icons.trash size={13} />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          onDelete?.(pendingDelete.id, pendingDelete);
          setPendingDelete(null);
        }}
        title="删除历史对话"
        message={`确定删除“${pendingDeleteTitle}”吗？这条对话中的消息和待处理记录也会一起删除。`}
        confirmLabel="删除"
        danger
      />
    </div>
  );
}
