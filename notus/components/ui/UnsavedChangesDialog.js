import { Button } from './Button';
import { Dialog } from './Dialog';

export function UnsavedChangesDialog({
  open,
  onCancel,
  onDiscard,
  onSave,
  saving = false,
  title = '离开前保存更改？',
  message = '当前内容还有未保存修改。你可以先保存再继续，也可以直接离开并丢弃这些更改。',
}) {
  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onCancel}
      title={title}
      maxWidth={520}
      footer={(
        <>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>取消</Button>
          <Button variant="secondary" onClick={onDiscard} disabled={saving}>不保存离开</Button>
          <Button variant="primary" loading={saving} onClick={onSave}>保存并继续</Button>
        </>
      )}
    >
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        {message}
      </div>
    </Dialog>
  );
}
