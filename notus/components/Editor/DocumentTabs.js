import { useCallback, useMemo, useRef, useState } from 'react';
import { getFileNameLabel } from '../../lib/documentLabels';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Icons } from '../ui/Icons';
import { TextInput } from '../ui/Input';
import { Tooltip } from '../ui/Tooltip';

function tabName(file) {
  return getFileNameLabel(file, '未命名文档');
}

export function DocumentTabs({ files = [], activeFileId = null, onActivate, onClose, onRename }) {
  const [renameFile, setRenameFile] = useState(null);
  const [renameName, setRenameName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const tabButtonRefs = useRef(new Map());
  const tabs = useMemo(() => (Array.isArray(files) ? files.filter(Boolean) : []), [files]);

  const openRename = useCallback((file) => {
    if (!file?.id) return;
    setRenameFile(file);
    setRenameName(String(file.name || '').replace(/\.md$/i, '') || tabName(file));
  }, []);

  const closeRename = useCallback(() => {
    if (renaming) return;
    setRenameFile(null);
    setRenameName('');
  }, [renaming]);

  const submitRename = useCallback(async () => {
    const nextName = renameName.trim();
    if (!renameFile?.id || !nextName || renaming) return;
    setRenaming(true);
    try {
      const renamed = await onRename?.(renameFile, nextName);
      if (renamed !== false) {
        setRenameFile(null);
        setRenameName('');
      }
    } finally {
      setRenaming(false);
    }
  }, [onRename, renameFile, renameName, renaming]);

  const moveFocus = useCallback((fileId, direction) => {
    const currentIndex = tabs.findIndex((file) => Number(file.id) === Number(fileId));
    if (currentIndex < 0 || tabs.length === 0) return;
    const nextIndex = direction === 'start'
      ? 0
      : direction === 'end'
        ? tabs.length - 1
        : (currentIndex + direction + tabs.length) % tabs.length;
    const nextFile = tabs[nextIndex];
    tabButtonRefs.current.get(Number(nextFile.id))?.focus();
    onActivate?.(nextFile);
  }, [onActivate, tabs]);

  return (
    <>
      <div
        className="notus-document-tabs"
        role="tablist"
        aria-label="已打开文件"
        style={{
          height: 48,
          minHeight: 48,
          display: 'flex',
          alignItems: 'stretch',
          padding: '0 8px',
          gap: 2,
          overflowX: 'auto',
          overflowY: 'hidden',
          background: 'var(--bg-primary)',
          flexShrink: 0,
        }}
      >
        {tabs.map((file) => {
          const active = Number(file.id) === Number(activeFileId);
          const label = tabName(file);
          return (
            <div
              key={file.id}
              title={`${label}\n双击或右键重命名`}
              style={{
                height: '100%',
                minWidth: 0,
                maxWidth: 220,
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                margin: '7px 1px',
                height: 34,
                padding: '0 8px 0 10px',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: active ? 'var(--bg-secondary)' : 'transparent',
                border: 'none',
                borderRadius: 'var(--radius-md)',
                boxShadow: active ? '0 1px 2px color-mix(in srgb, var(--text-primary) 8%, transparent)' : 'none',
                cursor: 'pointer',
                outline: 'none',
                flexShrink: 0,
              }}
            >
              <button
                ref={(node) => {
                  if (node) tabButtonRefs.current.set(Number(file.id), node);
                  else tabButtonRefs.current.delete(Number(file.id));
                }}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls="notus-editor-tabpanel"
                tabIndex={active ? 0 : -1}
                onClick={() => onActivate?.(file)}
                onDoubleClick={() => openRename(file)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openRename(file);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    moveFocus(file.id, -1);
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    moveFocus(file.id, 1);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    moveFocus(file.id, 'start');
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    moveFocus(file.id, 'end');
                  }
                }}
                style={{
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0,
                  padding: 0,
                  color: 'inherit',
                  background: 'transparent',
                  border: 0,
                  cursor: 'pointer',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--text-sm)', fontWeight: active ? 600 : 400 }}>
                  {label}
                </span>
              </button>
              <Tooltip content={`关闭 ${label}`}>
                <button
                  type="button"
                  aria-label={`关闭 ${label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose?.(file);
                  }}
                  style={{
                    width: 22,
                    height: 22,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-tertiary)',
                    borderRadius: 'var(--radius-sm)',
                    flexShrink: 0,
                  }}
                >
                  <Icons.x size={13} />
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>
      {renameFile ? (
        <Dialog
          open
          onClose={closeRename}
          title="重命名文件"
          footer={(
            <>
              <Button variant="ghost" onClick={closeRename}>取消</Button>
              <Button variant="primary" loading={renaming} disabled={!renameName.trim()} onClick={submitRename}>确认</Button>
            </>
          )}
        >
          <TextInput
            autoFocus
            value={renameName}
            placeholder="文件名（不含 .md 后缀）"
            onChange={(event) => setRenameName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitRename();
              if (event.key === 'Escape') closeRename();
            }}
          />
        </Dialog>
      ) : null}
    </>
  );
}
