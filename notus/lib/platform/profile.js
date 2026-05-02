const { getPlatformCapabilities } = require('./capabilities');
const { resolvePlatformPaths } = require('./paths');
const { inferRuntimeTarget } = require('./target');

function getPlatformProfile(env = process.env) {
  const runtimeTarget = inferRuntimeTarget(env);
  const paths = resolvePlatformPaths(env, { runtimeTarget });
  const capabilities = getPlatformCapabilities(runtimeTarget, process.platform);

  return {
    runtimeTarget,
    dataRoot: paths.dataRoot,
    storageMode: capabilities.usesManagedWorkspace ? 'managed' : 'external',
    canAutoPurgeOnUninstall: capabilities.supportsAutoPurgeOnUninstall,
    capabilities,
    paths,
  };
}

module.exports = {
  getPlatformProfile,
};
