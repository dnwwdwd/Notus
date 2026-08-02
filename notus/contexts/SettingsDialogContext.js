import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { SettingsDialog } from '../components/Settings/SettingsScreen';

const SettingsDialogContext = createContext(null);

export function SettingsDialogProvider({ children }) {
  const [state, setState] = useState({ open: false, section: 'model', provider: '', conversationId: '' });
  const openSettings = useCallback((section = 'model', options = {}) => {
    setState({ open: true, section, provider: options.provider || '', conversationId: options.conversationId || '' });
  }, []);
  const closeSettings = useCallback(() => setState((current) => ({ ...current, open: false })), []);
  const value = useMemo(() => ({ ...state, openSettings, closeSettings }), [closeSettings, openSettings, state]);
  return <SettingsDialogContext.Provider value={value}>{children}</SettingsDialogContext.Provider>;
}

export function SettingsDialogRoot() {
  const settings = useSettingsDialog();
  return <SettingsDialog open={settings.open} section={settings.section} provider={settings.provider} conversationId={settings.conversationId} onClose={settings.closeSettings} />;
}

export function useSettingsDialog() {
  const context = useContext(SettingsDialogContext);
  if (!context) throw new Error('useSettingsDialog 必须在 SettingsDialogProvider 内使用');
  return context;
}
