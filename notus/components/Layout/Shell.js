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
  editorOpen,
  agentOpen,
  onToggleEditor,
  onToggleAgent,
  children,
}) => {
  const { setActiveWorkspacePage } = useApp();

  useEffect(() => {
    if (active === 'files') {
      setActiveWorkspacePage(active);
    }
  }, [active, setActiveWorkspacePage]);

  return (
    <div className="notus-shell" style={{ display: 'flex', flexDirection: 'column', height: '100dvh', minHeight: 0 }}>
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
        editorOpen={editorOpen}
        agentOpen={agentOpen}
        onToggleEditor={onToggleEditor}
        onToggleAgent={onToggleAgent}
      />
      <div className="notus-shell__body" style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0, position: 'relative', isolation: 'isolate', zIndex: 0 }}>
        <Sidebar
          active={active}
          tocDisabled={tocDisabled}
          tocItems={tocItems}
          requestAction={requestAction}
          navigateOnFileSelect={navigateOnFileSelect}
        />
        <div className="notus-shell__content" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
};
