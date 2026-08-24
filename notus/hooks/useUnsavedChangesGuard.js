import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UnsavedChangesDialog } from '../components/ui/UnsavedChangesDialog';

export function useUnsavedChangesGuard({
  isDirty,
  onSave,
  title,
  message,
}) {
  const bypassRef = useRef(false);
  const pendingActionRef = useRef(null);
  const releaseTimerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const closeDialog = useCallback(() => {
    pendingActionRef.current = null;
    setOpen(false);
    setSaving(false);
  }, []);

  const releaseBypassSoon = useCallback(() => {
    if (releaseTimerRef.current) {
      window.clearTimeout(releaseTimerRef.current);
    }
    releaseTimerRef.current = window.setTimeout(() => {
      bypassRef.current = false;
      releaseTimerRef.current = null;
    }, 0);
  }, []);

  const request = useCallback((action) => {
    if (typeof action !== 'function') return true;
    if (!isDirty || bypassRef.current) {
      action();
      return true;
    }
    pendingActionRef.current = action;
    setOpen(true);
    return false;
  }, [isDirty]);

  const runPendingAction = useCallback(() => {
    const action = pendingActionRef.current;
    closeDialog();
    if (!action) return;
    bypassRef.current = true;
    action();
    releaseBypassSoon();
  }, [closeDialog, releaseBypassSoon]);

  const handleDiscard = useCallback(() => {
    runPendingAction();
  }, [runPendingAction]);

  const handleSave = useCallback(async () => {
    if (!pendingActionRef.current) {
      closeDialog();
      return;
    }

    setSaving(true);
    try {
      const saved = await onSave?.();
      if (saved === false) {
        setSaving(false);
        return;
      }
      runPendingAction();
    } catch {
      setSaving(false);
    }
  }, [closeDialog, onSave, runPendingAction]);

  useEffect(() => {
    if (!isDirty) return undefined;

    const handleBeforeUnload = (event) => {
      if (bypassRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDirty]);

  useEffect(() => () => {
    if (releaseTimerRef.current) {
      window.clearTimeout(releaseTimerRef.current);
    }
  }, []);

  const dialog = useMemo(() => (
    <UnsavedChangesDialog
      open={open}
      saving={saving}
      onCancel={closeDialog}
      onDiscard={handleDiscard}
      onSave={handleSave}
      title={title}
      message={message}
    />
  ), [closeDialog, handleDiscard, handleSave, message, open, saving, title]);

  return {
    request,
    dialog,
  };
}
