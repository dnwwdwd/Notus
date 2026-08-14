const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getBundledWindowsArm64VecExtensionPath,
} = require('../lib/db');
const {
  SQLITE_VEC_AMALGAMATION,
  assertWindowsArm64Dll,
  getWindowsArm64VecExtensionPath,
  shouldCompileSqliteVecFromSource,
} = require('../../desktop/scripts/build-desktop');

async function runTests() {
  assert.match(SQLITE_VEC_AMALGAMATION.url, /sqlite-vec-0\.1\.9-amalgamation\.zip$/);
  assert.match(SQLITE_VEC_AMALGAMATION.sha256, /^[a-f0-9]{64}$/);
  assert.strictEqual(shouldCompileSqliteVecFromSource('win32', 'arm64'), true);
  assert.strictEqual(shouldCompileSqliteVecFromSource('win32', 'x64'), false);
  assert.strictEqual(shouldCompileSqliteVecFromSource('darwin', 'arm64'), false);

  const resourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-win-arm64-vec-'));
  const extensionPath = getWindowsArm64VecExtensionPath(resourcesRoot);
  fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
  fs.writeFileSync(extensionPath, 'placeholder');

  assert.strictEqual(
    getBundledWindowsArm64VecExtensionPath({
      platform: 'win32',
      arch: 'arm64',
      cwd: resourcesRoot,
    }),
    extensionPath
  );
  assert.strictEqual(
    getBundledWindowsArm64VecExtensionPath({
      platform: 'win32',
      arch: 'x64',
      cwd: resourcesRoot,
    }),
    null
  );

  const validDllPath = path.join(resourcesRoot, 'valid.dll');
  const validDll = Buffer.alloc(0x100);
  validDll.write('MZ', 0, 'ascii');
  validDll.writeUInt32LE(0x80, 0x3c);
  validDll.write('PE\0\0', 0x80, 'ascii');
  validDll.writeUInt16LE(0xaa64, 0x84);
  fs.writeFileSync(validDllPath, validDll);
  await assertWindowsArm64Dll(validDllPath);

  const invalidDllPath = path.join(resourcesRoot, 'invalid.dll');
  validDll.writeUInt16LE(0x8664, 0x84);
  fs.writeFileSync(invalidDllPath, validDll);
  await assert.rejects(assertWindowsArm64Dll(invalidDllPath), /not ARM64/);

  fs.rmSync(resourcesRoot, { recursive: true, force: true });
  console.log('desktop vector extension tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
