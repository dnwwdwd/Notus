import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from '../ui/Icons';

const C = {
  page: 'var(--bg-primary)',
  card: 'var(--bg-elevated)',
  soft: 'var(--bg-secondary)',
  border: 'var(--border-subtle)',
  text: 'var(--text-primary)',
  secondary: 'var(--text-secondary)',
  tertiary: 'var(--text-tertiary)',
  accent: 'var(--accent)',
};

function transitionButton(extra) {
  return {
    border: 'none',
    cursor: extra?.cursor || 'pointer',
    transition: 'background var(--transition-fast), color var(--transition-fast), opacity var(--transition-fast)',
    ...(extra || {}),
  };
}

function operationItems(operationSet) {
  if (!operationSet) return [];
  if (operationSet.revision_type === 'file_revision' || operationSet.revision?.type === 'file_revision') {
    const revision = operationSet.revision || {};
    return [{
      id: `revision-${operationSet.id}`,
      patchIndex: 0,
      file_path: revision.file_path || operationSet.revision_file_path || '',
      change_type: 'file_revision',
      old_path: '',
      new_path: '',
      status: operationSet.status || 'pending',
      handled_at: revision.applied_at || revision.discarded_at || revision.rolled_back_at || null,
      error: revision.error_message || '',
      diff_hunks: Array.isArray(revision.diff_hunks) ? revision.diff_hunks : [],
    }];
  }
  if (Array.isArray(operationSet.patches) && operationSet.patches.length > 0) {
    return operationSet.patches.map((patch, index) => ({
      id: patch.patch_id || patch.id || 'patch-' + index,
      patchIndex: index,
      file_path: patch.file_path || patch.folder_path || patch.path || patch.old_path || '',
      change_type: patch.change_type || patch.type || '',
      old_path: patch.old_path || '',
      new_path: patch.new_path || '',
      old: patch.old,
      new: patch.new,
      status: patch.status || 'pending',
      handled_at: patch.handled_at || null,
      error: patch.error || '',
    }));
  }
  return Array.isArray(operationSet.operations) ? operationSet.operations : [];
}

function patchStatusMeta(status) {
  const normalized = String(status || 'pending');
  if (normalized === 'applied') return { label: '已应用', color: 'var(--success)', bg: 'var(--bg-diff-add)' };
  if (normalized === 'auto_applied') return { label: '已自动应用', color: 'var(--success)', bg: 'var(--bg-diff-add)' };
  if (normalized === 'rolled_back') return { label: '已回滚', color: 'var(--danger)', bg: 'var(--bg-diff-remove)' };
  if (normalized === 'discarded') return { label: '已废弃', color: C.tertiary, bg: C.soft };
  if (normalized === 'superseded') return { label: '已被新预览替代', color: C.tertiary, bg: C.soft };
  if (normalized === 'stale') return { label: '文件已变化', color: 'var(--danger)', bg: 'var(--danger-subtle)' };
  if (normalized === 'apply_failed') return { label: '应用失败', color: 'var(--danger)', bg: 'var(--danger-subtle)' };
  if (normalized === 'rollback_conflict') return { label: '回滚冲突', color: 'var(--danger)', bg: 'var(--danger-subtle)' };
  if (normalized === 'failed') return { label: '处理失败', color: 'var(--danger)', bg: 'var(--danger-subtle)' };
  return { label: '待确认', color: C.accent, bg: 'var(--accent-subtle)' };
}

function isPatchPending(item) {
  const status = String(item?.status || 'pending');
  return status === 'pending' || status === 'failed';
}

function operationLabel(operation = {}) {
  const type = String(operation.change_type || '').trim();
  return {
    file_revision: '全文修订',
    create_folder: '新建目录',
    rename_folder: '重命名目录',
    move_folder: '移动目录',
    move_file: '移动文件',
    delete_folder: '删除目录',
    create: '新建文件',
  }[type] || '修改文件';
}

function buildDiffLines(operation = {}) {
  if (operation.change_type === 'file_revision' && Array.isArray(operation.diff_hunks)) {
    return operation.diff_hunks.flatMap((hunk, hunkIndex) => [
      { type: 'hunk', content: `@@ -${hunk.oldStart || 0},${hunk.oldLines || 0} +${hunk.newStart || 0},${hunk.newLines || 0} @@`, key: `hunk-${hunkIndex}` },
      ...(Array.isArray(hunk.lines) ? hunk.lines.map((line) => ({
        type: line.type === 'insert' ? 'add' : line.type === 'delete' ? 'remove' : 'context',
        content: line.content || '',
      })) : []),
    ]);
  }
  const type = String(operation.change_type || '').trim();
  if (['create_folder', 'rename_folder', 'move_folder', 'move_file', 'delete_folder'].includes(type)) {
    const remove = [];
    const add = [];
    if (type === 'create_folder') add.push(`目录：${operation.new_path || operation.file_path || operation.new || ''}`);
    else if (type === 'delete_folder') {
      remove.push(`目录：${operation.old_path || operation.file_path || operation.old || ''}`);
      String(operation.old || '').split('\n').filter(Boolean).forEach((line) => remove.push(`包含：${line}`));
    } else {
      remove.push(`原路径：${operation.old_path || operation.old || ''}`);
      add.push(`新路径：${operation.new_path || operation.new || ''}`);
    }
    return [
      ...remove.map((content) => ({ type: 'remove', content })),
      ...add.map((content) => ({ type: 'add', content })),
    ];
  }
  return [
    ...(operation.old ? String(operation.old).split('\n').map((line) => ({ type: 'remove', content: line })) : []),
    ...(operation.new ? String(operation.new).split('\n').map((line) => ({ type: 'add', content: line })) : []),
    ...(operation.content ? String(operation.content).split('\n').map((line) => ({ type: 'add', content: line })) : []),
  ];
}

export function FileOperationDiffDialog({
  operationSet,
  open,
  onClose,
  onApplyAll,
  onApplyFile,
  onRollbackFile,
  onDiscardFile,
  allowDiscardPending = false,
  discardLabel = '废弃预览',
}) {
  const operations = useMemo(() => operationItems(operationSet), [operationSet]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busyKey, setBusyKey] = useState('');
  const [fileDrawerOpen, setFileDrawerOpen] = useState(false);

  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(operations.length - 1, 0)));
    setFileDrawerOpen(false);
  }, [operationSet?.id, operations.length]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  const activeOperation = operations[Math.min(selectedIndex, Math.max(operations.length - 1, 0))] || {};
  const activePath = activeOperation.new_path || activeOperation.file_path || activeOperation.path || '文件操作';
  const diffLines = buildDiffLines(activeOperation);
  const activeStatus = patchStatusMeta(activeOperation.status);
  const pendingCount = operations.filter(isPatchPending).length;
  const isRevision = activeOperation.change_type === 'file_revision';
  const activeNormalizedStatus = String(activeOperation.status || 'pending');
  const canApply = (isRevision ? activeNormalizedStatus === 'pending' : isPatchPending(activeOperation)) && typeof onApplyFile === 'function';
  const canApplyAll = pendingCount > 0 && typeof onApplyAll === 'function';
  const canRollback = (isRevision ? ['applied', 'rollback_conflict'].includes(activeNormalizedStatus) : !['rolled_back', 'discarded'].includes(activeNormalizedStatus)) && typeof onRollbackFile === 'function';
  const canDiscard = (isRevision && ['pending', 'stale', 'apply_failed', 'rollback_conflict'].includes(activeNormalizedStatus) || allowDiscardPending && ['pending', 'conflict', 'failed'].includes(activeNormalizedStatus)) && typeof onDiscardFile === 'function';
  const moveToNextPending = () => {
    const next = operations.findIndex((item, index) => index !== selectedIndex && isPatchPending(item));
    if (next >= 0) setSelectedIndex(next);
  };
  const runFileAction = async (kind) => {
    const key = `${kind}-${activeOperation.patchIndex}`;
    setBusyKey(key);
    try {
      if (kind === 'apply') await onApplyFile?.(operationSet, activeOperation.patchIndex);
      else if (kind === 'discard') await onDiscardFile?.(operationSet, activeOperation.patchIndex);
      else await onRollbackFile?.(operationSet, activeOperation.patchIndex);
      moveToNextPending();
    } finally {
      setBusyKey('');
    }
  };
  const runApplyAll = async () => {
    setBusyKey('apply-all');
    try {
      await onApplyAll?.(operationSet);
    } finally {
      setBusyKey('');
    }
  };

  return createPortal(
    <div className="notus-diff-dialog__backdrop">
      <div className="notus-diff-dialog" role="dialog" aria-modal="true" aria-label="修改详情">
        <div className="notus-diff-dialog__header" style={{ borderBottom: `1px solid ${C.border}`, background: C.page }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>修改详情</div>
            <div style={{ marginTop: 3, fontSize: 12, color: C.tertiary }}>{pendingCount > 0 ? `${pendingCount} 项待确认` : '本次修改已全部处理'}</div>
          </div>
          <div className="notus-diff-dialog__header-actions">
            <button type="button" className="notus-diff-dialog__file-toggle notus-agent-pressable" aria-label="打开文件列表" aria-expanded={fileDrawerOpen} onClick={() => setFileDrawerOpen(true)} style={transitionButton({ borderRadius: 10, background: C.card, color: C.secondary, alignItems: 'center', justifyContent: 'center', gap: 6, boxShadow: `inset 0 0 0 1px ${C.border}` })}><Icons.list size={15} /><span>文件</span></button>
            <button type="button" aria-label="关闭" onClick={onClose} style={transitionButton({ width: 36, height: 36, borderRadius: 10, background: C.card, color: C.secondary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: `inset 0 0 0 1px ${C.border}` })}><Icons.x size={16} /></button>
          </div>
        </div>
        <div className="notus-diff-dialog__body">
          {fileDrawerOpen ? <button type="button" className="notus-diff-dialog__file-backdrop" aria-label="关闭文件列表" onClick={() => setFileDrawerOpen(false)} /> : null}
          <nav className={['notus-diff-dialog__sidebar', fileDrawerOpen ? 'is-mobile-open' : ''].filter(Boolean).join(' ')} aria-label="文件列表" style={{ borderRight: `1px solid ${C.border}`, background: C.page }}>
            {operations.map((operation, index) => {
              const pathText = operation.new_path || operation.file_path || operation.path || '文件操作';
              const active = index === selectedIndex;
              const statusMeta = patchStatusMeta(operation.status);
              return (
                <button key={operation.id || index} type="button" onClick={() => { setSelectedIndex(index); setFileDrawerOpen(false); }} style={transitionButton({ width: '100%', textAlign: 'left', display: 'grid', gap: 4, padding: '9px 10px', borderRadius: 10, background: active ? C.card : 'transparent', color: active ? C.text : C.secondary, boxShadow: active ? `inset 0 0 0 1px ${C.border}` : 'none' })}>
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ minWidth: 0, fontSize: 12, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{operationLabel(operation)}</span>
                    <span style={{ flexShrink: 0, width: 7, height: 7, borderRadius: 999, background: statusMeta.color }} />
                  </span>
                  <span style={{ fontSize: 10.5, color: C.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pathText}</span>
                </button>
              );
            })}
          </nav>
          <div className="notus-diff-dialog__content" style={{ background: C.soft }}>
            <div className="notus-diff-dialog__content-header" style={{ borderBottom: `1px solid ${C.border}`, background: C.card }}>
              <span style={{ minWidth: 0, fontSize: 12, color: C.secondary, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activePath}</span>
              <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 800, color: activeStatus.color, background: activeStatus.bg, borderRadius: 999, padding: '4px 8px' }}>{activeStatus.label}</span>
            </div>
            <div className="notus-diff-dialog__scroll" style={{ overscrollBehavior: 'contain' }}>
              {activeOperation.error ? (
                <div style={{ margin: '0 12px 12px', padding: '10px 12px', borderRadius: 10, background: 'var(--danger-subtle)', color: 'var(--danger)', fontSize: 12, lineHeight: 1.65, boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--danger) 18%, transparent)' }}>
                  {activeOperation.error}
                </div>
              ) : null}
              <div className="notus-diff-dialog__lines" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {diffLines.length === 0 ? <div style={{ padding: '0 14px', color: C.tertiary }}>没有可展示的 diff 内容。</div> : diffLines.map((line, index) => {
                  const hunk = line.type === 'hunk';
                  const remove = line.type === 'remove';
                  const add = line.type === 'add';
                  return (
                    <div key={index} style={{ display: 'flex', minWidth: '100%', padding: '0 14px', background: hunk ? C.soft : add ? 'var(--bg-diff-add)' : remove ? 'var(--bg-diff-remove)' : 'transparent', color: hunk ? C.tertiary : add ? 'var(--success)' : remove ? 'var(--danger)' : C.secondary, textDecoration: remove ? 'line-through' : 'none' }}>
                      <span style={{ width: 20, flex: '0 0 auto', color: C.tertiary, textAlign: 'right', paddingRight: 8, userSelect: 'none' }}>{hunk ? ' ' : add ? '+' : remove ? '-' : ' '}</span>
                      <span style={{ flex: '0 0 auto', whiteSpace: 'pre' }}>{line.content}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="notus-diff-dialog__footer" style={{ borderTop: `1px solid ${C.border}`, background: C.page, justifyContent: 'flex-end' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
                {canDiscard ? (
                  <button type="button" disabled={Boolean(busyKey)} onClick={() => runFileAction('discard')} style={transitionButton({ height: 32, padding: '0 11px', borderRadius: 9, background: C.soft, color: C.secondary, fontSize: 12, fontWeight: 800, opacity: busyKey ? 0.7 : 1, cursor: busyKey ? 'not-allowed' : 'pointer' })}>{discardLabel}</button>
                ) : null}
                <button type="button" disabled={!canRollback || Boolean(busyKey)} onClick={() => runFileAction('rollback')} style={transitionButton({ height: 32, padding: '0 11px', borderRadius: 9, background: canRollback ? 'var(--bg-diff-remove)' : C.soft, color: canRollback ? 'var(--danger)' : C.tertiary, fontSize: 12, fontWeight: 800, opacity: busyKey ? 0.7 : 1, cursor: (!canRollback || busyKey) ? 'not-allowed' : 'pointer' })}>回滚修改</button>
                <button type="button" disabled={!canApply || Boolean(busyKey)} onClick={() => runFileAction('apply')} style={transitionButton({ height: 32, padding: '0 12px', borderRadius: 9, background: canApply ? 'var(--success)' : C.soft, color: canApply ? '#fff' : C.tertiary, fontSize: 12, fontWeight: 800, opacity: busyKey ? 0.7 : 1, cursor: (!canApply || busyKey) ? 'not-allowed' : 'pointer' })}>应用修改</button>
                <button type="button" disabled={!canApplyAll || Boolean(busyKey)} onClick={runApplyAll} style={transitionButton({ height: 32, padding: '0 13px', borderRadius: 9, background: canApplyAll ? C.accent : C.soft, color: canApplyAll ? '#fff' : C.tertiary, fontSize: 12, fontWeight: 800, opacity: busyKey ? 0.7 : 1, cursor: (!canApplyAll || busyKey) ? 'not-allowed' : 'pointer' })}>全部应用</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
