// Shell — wraps pages that use TopBar + Sidebar layout
import { useEffect } from 'react';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { useApp } from '../../contexts/AppContext';

export const Shell = ({
  active,
  fileName,
  saveState,
  onSave,
  saveDisabled,
  showSaveButton = true,
  showIndex,
  tocDisabled,
  tocItems,
  onCmdK,
  requestAction,
  navigateOnFileSelect = true,
  children,
}) => {
  const { setActiveWorkspacePage } = useApp();

  useEffect(() => {
    if (['files', 'knowledge', 'canvas'].includes(active)) {
      setActiveWorkspacePage(active);
    }
  }, [active, setActiveWorkspacePage]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <TopBar
        active={active}
        fileName={fileName}
        saveState={saveState}
        onSave={onSave}
        saveDisabled={saveDisabled}
        showSaveButton={showSaveButton}
        showIndex={showIndex}
        onCmdK={onCmdK}
        requestAction={requestAction}
      />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0, position: 'relative', isolation: 'isolate', zIndex: 0 }}>
        <Sidebar
          active={active}
          tocDisabled={tocDisabled}
          tocItems={tocItems}
          requestAction={requestAction}
          navigateOnFileSelect={navigateOnFileSelect}
        />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
};
