// Shell — wraps pages that use TopBar + Sidebar layout
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';

export const Shell = ({
  active,
  fileName,
  saveState,
  showIndex,
  tocDisabled,
  tocItems,
  onCmdK,
  navigateOnFileSelect = true,
  children,
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
    <TopBar
      active={active}
      fileName={fileName}
      saveState={saveState}
      showIndex={showIndex}
      onCmdK={onCmdK}
    />
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar
        tocDisabled={tocDisabled}
        tocItems={tocItems}
        navigateOnFileSelect={navigateOnFileSelect}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  </div>
);
