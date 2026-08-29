const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function runTests() {
  const home = read('pages/index.js');
  const statusGate = read('components/AppStatusGate.js');
  const indexing = read('pages/indexing.js');
  const packageScript = fs.readFileSync(path.join(repoRoot, 'lzc/build-package.sh'), 'utf8').replace(/\r\n/g, '\n');
  const lpkBuildScript = fs.readFileSync(path.join(repoRoot, 'desktop/scripts/build-lpk.js'), 'utf8').replace(/\r\n/g, '\n');
  const lpkBuildConfig = fs.readFileSync(path.join(repoRoot, 'lzc-build.yml'), 'utf8').replace(/\r\n/g, '\n');

  assert.ok(home.includes("const target = status.needsSetup ? '/setup' : '/files';"), '启动页只能根据初始化状态跳转，不能因待索引文件自动进入重建页');
  assert.ok(!home.includes("status.needsIndexing ? '/indexing'"), '启动页不得自动跳转到索引重建页');
  assert.ok(!statusGate.includes("status.needsIndexing ? '/indexing'"), '初始化守卫不得把完成初始化的用户自动送入索引重建页');
  assert.ok(!indexing.includes('if (shouldStart) startRebuild();'), '索引页不得在加载后自动请求全量重建');
  assert.ok(indexing.includes('发现待索引文件，请手动开始构建'), '索引页必须说明待索引文件需要用户主动开始构建');

  [
    'clean_runtime_state()',
    'assert_no_runtime_state()',
    '[ -e "$DIST_DIR/notus/$runtime_dir" ] || [ -L "$DIST_DIR/notus/$runtime_dir" ]',
    '"$DIST_DIR/notus/.session"',
    '"$DIST_DIR/notus/.notus-desktop-data"',
    '"$DIST_DIR/notus/notes"',
    '"$DIST_DIR/notus/assets"',
    '"$DIST_DIR/notus/agent"',
    '--exclude=notus/.session',
    '--exclude=notus/.notus-desktop-data',
    '--exclude=notus/notes',
    '--exclude=notus/assets',
    '-path "$DIST_DIR/notus/node_modules" -prune',
  ].forEach((expected) => {
    assert.ok(packageScript.includes(expected), `LPK 构建必须隔离本地运行数据：${expected}`);
  });

  assert.ok(lpkBuildConfig.includes('buildscript: sh lzc/build-package.sh'), 'LPK 配置必须声明唯一的内容构建脚本');
  assert.ok(lpkBuildScript.includes("await run('lzc-cli', ['project', 'build']"), 'LPK 入口必须由 lzc-cli project build 负责生成包');
  assert.ok(!lpkBuildScript.includes("await run('sh', ['lzc/build-package.sh']"), 'LPK 入口不得在 lzc-cli project build 前重复执行内容构建脚本');

  console.log('lazycat startup and package tests passed');
}

runTests();
