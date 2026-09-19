const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const packageScript = fs.readFileSync(path.join(repoRoot, 'lzc/build-package.sh'), 'utf8');
const prepareDependencies = packageScript.slice(packageScript.indexOf('prepare_dependencies() {'), packageScript.indexOf('\nrun_local_build() {'));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-lpk-cache-'));
function write(relative, text) {
  const target = path.join(fixture, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}
function executable(relative, text) {
  const target = write(relative, text);
  fs.chmodSync(target, 0o755);
  return target;
}
function run(script, args = [], extraEnv = {}) {
  return spawnSync('sh', [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${fixture}/bin:${process.env.PATH}`, ...extraEnv } });
}
try {
  const { contentDigest } = require(path.join(repoRoot, 'desktop/scripts/lpk-content-digest.js'));
  const digestFile = write('digest/a', 'same content');
  const digestRoot = path.dirname(digestFile);
  const originalDigest = contentDigest(digestRoot);
  fs.chmodSync(digestFile, 0o700);
  assert.notStrictEqual(contentDigest(digestRoot), originalDigest, '权限变化必须使摘要失效');
  fs.symlinkSync('a', path.join(digestRoot, 'link'));
  const linkDigest = contentDigest(digestRoot);
  fs.unlinkSync(path.join(digestRoot, 'link'));
  fs.symlinkSync('missing', path.join(digestRoot, 'link'));
  assert.notStrictEqual(contentDigest(digestRoot), linkDigest, '链接目标变化必须使摘要失效');
  fs.unlinkSync(digestFile);
  assert.notStrictEqual(contentDigest(digestRoot), originalDigest, '文件删除必须使摘要失效');

  // 工具替身只替换昂贵的安装/原生检查；实际执行生产依赖缓存函数和真实文件哈希。
  executable('bin/sha256sum', `#!${process.execPath}\nconst fs=require('fs'),crypto=require('crypto'); const args=process.argv.slice(2); for(const file of args.length?args:[null]) { const data=fs.readFileSync(file||0); console.log(crypto.createHash('sha256').update(data).digest('hex')+'  '+(file||'-')); }\n`);
  executable('bin/npm', `#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then echo "10.8.2"; exit; fi
[ "$1" = "ci" ] || exit 12
rm -rf node_modules
mkdir node_modules
printf 'install\\n' >> "$ROOT_DIR/installs"
[ "\${FAIL_INSTALL:-0}" != "1" ] || exit 42
rm -f "$ROOT_DIR/native-broken"
`);
  write('deps/notus/package.json', '{"name":"fixture"}');
  write('deps/notus/package-lock.json', '{}');
  write('deps/notus/.npmrc', 'legacy-peer-deps=true');
  write('deps/lzc/build-package.sh', packageScript);
  const runner = write('prepare.sh', `#!/bin/sh
set -eu
ROOT_DIR="$1"
APP_DIR="$ROOT_DIR/notus"
export ROOT_DIR
cd "$APP_DIR"
ensure_linux_next_swc() { :; }
verify_linux_dependencies() { [ ! -f "$ROOT_DIR/native-broken" ]; }
${prepareDependencies}
prepare_dependencies
`);
  const depRoot = path.join(fixture, 'deps');
  const stamp = path.join(depRoot, 'notus/node_modules/.notus-lpk-dependencies');
  const installs = () => fs.readFileSync(path.join(depRoot, 'installs'), 'utf8').trim().split('\n').length;
  const prepare = (env = {}) => run(runner, [depRoot], { LZC_BUILD_CACHE: '1', LZC_BUILD_IMAGE_ID: 'image-one', ...env });
  assert.strictEqual(prepare().status, 0);
  assert.strictEqual(installs(), 1);
  assert(fs.existsSync(stamp));
  write('deps/notus/.next/cache/sentinel', 'cache');
  write('deps/notus/page.js', 'source changed');
  assert(prepare().stdout.includes('缓存命中'));
  assert.strictEqual(installs(), 1, '源码变化不能重装依赖');
  assert(fs.existsSync(path.join(depRoot, 'notus/.next/cache/sentinel')));
  write('deps/notus/package-lock.json', '{"lockfileVersion":3}');
  assert.strictEqual(prepare().status, 0);
  assert.strictEqual(installs(), 2, '锁文件变化必须重装');
  assert(!fs.existsSync(path.join(depRoot, 'notus/.next')), '依赖变化必须清除 Next 缓存');
  write('deps/notus/.npmrc', 'legacy-peer-deps=false');
  assert.strictEqual(prepare().status, 0);
  assert.strictEqual(installs(), 3, 'npm 配置变化必须重装');
  assert.strictEqual(prepare({ LZC_BUILD_IMAGE_ID: 'image-two' }).status, 0);
  assert.strictEqual(installs(), 4, '镜像身份变化必须重装');
  write('deps/native-broken', 'broken');
  assert.strictEqual(prepare({ LZC_BUILD_IMAGE_ID: 'image-two' }).status, 0);
  assert.strictEqual(installs(), 5, '原生依赖加载失败必须重新安装');
  write('deps/notus/package.json', '{"name":"changed"}');
  assert.strictEqual(prepare({ FAIL_INSTALL: '1' }).status, 42);
  assert(!fs.existsSync(stamp), '安装失败不得留下成功指纹');
  assert.strictEqual(prepare().status, 0);
  assert.strictEqual(installs(), 7, '失败后下次必须重新安装');

  // 测试真实同步脚本；flock 在无该工具的 macOS 测试环境中替换，实际容器另行验证。
  executable('bin/flock', '#!/bin/sh\nexit 0\n');
  write('source/notus/input.js', 'new source');
  write('source/notus/.env.local', 'must not copy');
  write('source/notus/notes/private.md', 'must not copy');
  write('source/notus/node_modules/host-native', 'must not copy');
  write('source/notus/.next/host-output', 'must not copy');
  write('source/package.json', '{}');
  write('source/package.yml', 'package: fixture');
  write('source/desktop/scripts/lpk-content-digest.js', fs.readFileSync(path.join(repoRoot, 'desktop/scripts/lpk-content-digest.js'), 'utf8'));
  write('source/lzc/build-package.sh', `#!/bin/sh
set -eu
[ ! -e notus/.env.local ]
[ ! -e notus/notes/private.md ]
[ ! -e notus/node_modules/host-native ]
[ ! -e notus/.next/host-output ]
[ ! -e notus/.next/standalone/stale ]
[ ! -e notus/deleted.js ]
rm -rf lzc-dist
mkdir -p lzc-dist/notus
cp notus/input.js lzc-dist/notus/input.js
`);
  write('cache/src/notus/deleted.js', 'old source');
  write('cache/src/notus/node_modules/linux-native', 'keep');
  write('cache/src/notus/.next/cache/sentinel', 'keep');
  write('cache/src/notus/.next/standalone/stale', 'remove');
  write('cache/npm/download', 'keep');
  write('output/old', 'remove after success');
  const containerHelper = path.join(repoRoot, 'desktop/scripts/build-lpk-container.sh');
  const args = ['source', 'cache', 'output'].map((part) => path.join(fixture, part));
  const sync = run(containerHelper, args);
  assert.strictEqual(sync.status, 0, sync.stderr);
  assert.strictEqual(fs.readFileSync(path.join(fixture, 'output/notus/input.js'), 'utf8'), 'new source');
  assert(!fs.existsSync(path.join(fixture, 'output/old')));
  assert(fs.existsSync(path.join(fixture, 'cache/src/notus/node_modules/linux-native')));
  assert(fs.existsSync(path.join(fixture, 'cache/src/notus/.next/cache/sentinel')));
  assert(fs.existsSync(path.join(fixture, 'cache/npm/download')));
  const reuse = run(containerHelper, args);
  assert.strictEqual(reuse.status, 0, reuse.stderr);
  assert(reuse.stdout.includes('复用上次成功内容'), '无变化应复用已校验产物');
  write('cache/src/lzc-dist/notus/input.js', 'corrupt output');
  const rebuild = run(containerHelper, args);
  assert.strictEqual(rebuild.status, 0, rebuild.stderr);
  assert(!rebuild.stdout.includes('复用上次成功内容'), '产物损坏必须重建');
  assert.strictEqual(fs.readFileSync(path.join(fixture, 'output/notus/input.js'), 'utf8'), 'new source');
  execFileSync('mkfifo', [path.join(fixture, 'cache/src/lzc-dist/broken-pipe')]);
  const unreadable = run(containerHelper, args);
  assert.strictEqual(unreadable.status, 0, unreadable.stderr);
  assert(!unreadable.stdout.includes('复用上次成功内容'), '摘要校验失败必须回退重建');
  write('source/notus/input.js', 'changed source');
  assert.strictEqual(run(containerHelper, args).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(fixture, 'output/notus/input.js'), 'utf8'), 'changed source');
  write('output/successful-content', 'keep on failure');
  write('source/lzc/build-package.sh', '#!/bin/sh\nexit 17\n');
  assert.strictEqual(run(containerHelper, args).status, 17);
  assert(fs.existsSync(path.join(fixture, 'output/successful-content')), '内容构建失败不得清空导出目录');
  assert.strictEqual(run(containerHelper, args, { LZC_CLEAN_BUILD: '1' }).status, 17);
  assert(!fs.existsSync(path.join(fixture, 'cache/src/notus/node_modules')));
  assert(!fs.existsSync(path.join(fixture, 'cache/src/notus/.next')));
  assert(!fs.existsSync(path.join(fixture, 'cache/npm/download')));
  console.log('LPK cache behavior tests passed');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
