const assert = require('assert');
const path = require('path');
const { resolvePlatformPaths } = require('../lib/platform/paths');
const { getPlatformProfile } = require('../lib/platform/profile');

function runTests() {
  const cwd = '/tmp/notus-web';

  const webPaths = resolvePlatformPaths(
    { NOTUS_RUNTIME_TARGET: 'web', NOTUS_DATA_ROOT: '/tmp/notus-data' },
    { cwd, runtimeTarget: 'web' }
  );
  assert.strictEqual(webPaths.notesDir, '/tmp/notus-data/notes');
  assert.strictEqual(webPaths.assetsDir, '/tmp/notus-data/notes/.assets');
  assert.strictEqual(webPaths.dbPath, '/tmp/notus-data/notus.db');

  const explicitPaths = resolvePlatformPaths(
    {
      NOTUS_RUNTIME_TARGET: 'electron',
      NOTUS_DATA_ROOT: '/tmp/notus-managed',
      NOTES_DIR: '/custom/notes',
      DB_PATH: '/custom/index.db',
    },
    { cwd: '/tmp/notus-electron', runtimeTarget: 'electron' }
  );
  assert.strictEqual(explicitPaths.notesDir, '/custom/notes');
  assert.strictEqual(explicitPaths.dbPath, '/custom/index.db');
  assert.strictEqual(explicitPaths.assetsDir, '/tmp/notus-managed/assets');

  const lazycatProfile = getPlatformProfile({
    NOTES_DIR: '/lzcapp/var/notes',
    ASSETS_DIR: '/lzcapp/var/assets',
    DB_PATH: '/lzcapp/var/data/index.db',
  });
  assert.strictEqual(lazycatProfile.runtimeTarget, 'lazycat');
  assert.strictEqual(lazycatProfile.capabilities.supportsDesktopShell, false);

  const electronProfile = getPlatformProfile({
    NOTUS_RUNTIME_TARGET: 'electron',
    NOTUS_DATA_ROOT: path.resolve('/tmp/notus-electron-data'),
  });
  assert.strictEqual(electronProfile.runtimeTarget, 'electron');
  assert.strictEqual(electronProfile.storageMode, 'managed');
  assert.strictEqual(electronProfile.capabilities.usesManagedWorkspace, true);

  console.log('platform tests passed');
}

runTests();
