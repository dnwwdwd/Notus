function getPlatformCapabilities(runtimeTarget, platform = process.platform) {
  return {
    supportsDesktopShell: runtimeTarget === 'electron',
    supportsAutoPurgeOnUninstall: runtimeTarget === 'electron' && platform === 'win32',
    supportsManualDataWipe: runtimeTarget === 'electron',
    supportsExternalNotesBinding: runtimeTarget !== 'electron',
    usesManagedWorkspace: runtimeTarget === 'electron',
    supportsNativeOpenDialog: runtimeTarget === 'electron',
  };
}

module.exports = {
  getPlatformCapabilities,
};
