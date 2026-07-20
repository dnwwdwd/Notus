const path = require('path');
const os = require('os');

function getSkillMcpCapabilities(runtimeTarget, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const dataRoot = options.dataRoot || '';
  const electron = runtimeTarget === 'electron';
  return {
    runtime: runtimeTarget,
    skills: {
      managedRoot: electron ? path.join(homeDir, '.agents', 'skills') : path.join(dataRoot, 'skills'),
      discoverExternalRoots: electron,
      discoverWorkspaceRoots: electron,
      installFromGit: true,
      installFromZip: true,
      createFromAgent: true,
      openFolder: electron,
    },
    mcp: {
      stdio: electron,
      streamableHttp: true,
    },
  };
}

function getPlatformCapabilities(runtimeTarget, platform = process.platform, options = {}) {
  return {
    supportsDesktopShell: runtimeTarget === 'electron',
    supportsAutoPurgeOnUninstall: runtimeTarget === 'electron' && platform === 'win32',
    supportsManualDataWipe: runtimeTarget === 'electron',
    supportsExternalNotesBinding: runtimeTarget !== 'electron',
    usesManagedWorkspace: runtimeTarget === 'electron',
    supportsNativeOpenDialog: runtimeTarget === 'electron',
    skillMcp: getSkillMcpCapabilities(runtimeTarget, options),
  };
}

module.exports = {
  getPlatformCapabilities,
  getSkillMcpCapabilities,
};
