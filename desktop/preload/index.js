const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notusDesktop', {
  getProfile: () => ipcRenderer.invoke('desktop:get-profile'),
  pickImportSource: () => ipcRenderer.invoke('desktop:pick-import-source'),
  openDataDirectory: () => ipcRenderer.invoke('desktop:open-data-directory'),
  clearLocalDataAndQuit: () => ipcRenderer.invoke('desktop:clear-local-data-and-quit'),
  onOpenGlobalSearch: (listener) => {
    if (typeof listener !== 'function') {
      return () => {};
    }
    const handleEvent = () => listener();
    ipcRenderer.on('desktop:open-global-search', handleEvent);
    return () => ipcRenderer.removeListener('desktop:open-global-search', handleEvent);
  },
});
