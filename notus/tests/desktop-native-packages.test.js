const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const calls = [];
const sourcePath = path.resolve(__dirname, '../../desktop/scripts/build-desktop.js');
const fakeRequire = (name) => {
  if (name === 'child_process') return { spawn(command, args, options) {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  } };
  if (name.endsWith('electron/package.json')) return { version: '36.9.5' };
  if (name.endsWith('@llamaindex/liteparse/package.json')) return { version: '2.1.2' };
  return require(name);
};
const context = { require: fakeRequire, module: { exports: {} }, process, console, __dirname: path.dirname(sourcePath) };
vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
(async () => {
  for (const [platform, arch, vec, parser] of [
    ['darwin', 'arm64', 'darwin-arm64', 'darwin-arm64'],
    ['darwin', 'x64', 'darwin-x64', 'darwin-x64'],
    ['win32', 'x64', 'windows-x64', 'win32-x64-msvc'],
    ['win32', 'arm64', 'windows-arm64', 'win32-arm64-msvc'],
  ]) {
    await context.module.exports.ensureSqliteVecPackage('/release/notus', platform, arch);
    const { args } = calls.at(-1);
    assert(args.includes(`sqlite-vec-${vec}@0.1.9`));
    assert(args.includes(`@llamaindex/liteparse-${parser}@2.1.2`));
    assert(args.includes('--omit=dev'));
  }
  console.log('desktop target native dependency tests passed (4 architectures)');
})().catch((error) => { console.error(error); process.exit(1); });
