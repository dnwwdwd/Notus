const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(appRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

async function runTests() {
  const home = read('pages/index.js');
  const statusGate = read('components/AppStatusGate.js');
  const indexing = read('pages/indexing.js');
  const npmConfig = read('.npmrc');
  const runScript = fs.readFileSync(path.join(repoRoot, 'lzc/run.sh'), 'utf8').replace(/\r\n/g, '\n');
  const packageScript = fs.readFileSync(path.join(repoRoot, 'lzc/build-package.sh'), 'utf8').replace(/\r\n/g, '\n');
  const containerScript = fs.readFileSync(path.join(repoRoot, 'desktop/scripts/build-lpk-container.sh'), 'utf8');
  const lpkBuildScript = fs.readFileSync(path.join(repoRoot, 'desktop/scripts/build-lpk.js'), 'utf8').replace(/\r\n/g, '\n');
  const lpkBuildConfig = fs.readFileSync(path.join(repoRoot, 'lzc-build.yml'), 'utf8').replace(/\r\n/g, '\n');
  const proxyFunction = packageScript.match(/normalize_docker_proxy\(\) \{[\s\S]*?\n\}\n\nclean_runtime_state/);

  assert.ok(home.includes("const target = status.needsSetup ? '/setup' : '/files';"), '启动页只能根据初始化状态跳转，不能因待索引文件自动进入重建页');
  assert.ok(!home.includes("status.needsIndexing ? '/indexing'"), '启动页不得自动跳转到索引重建页');
  assert.ok(!statusGate.includes("status.needsIndexing ? '/indexing'"), '初始化守卫不得把完成初始化的用户自动送入索引重建页');
  assert.ok(!indexing.includes('if (shouldStart) startRebuild();'), '索引页不得在加载后自动请求全量重建');
  assert.ok(indexing.includes("router.replace('/files')"), '旧索引入口必须回到文件工作区');
  assert.ok(runScript.includes('node server.js &'), 'LPK 必须先在同一进程启动 Next 服务');
  assert.ok(runScript.includes('/api/runtime/capabilities'), 'LPK 启动时必须通过内部运行时接口完成初始化');
  assert.ok(runScript.includes('wait "$SERVER_PID"'), 'LPK 启动脚本必须持续托管 Next 服务进程');
  assert.ok(runScript.includes('trap cleanup_server EXIT INT TERM'), 'LPK 停止时必须清理 Next 服务子进程');
  assert.ok(!runScript.includes('trap - EXIT INT TERM'), 'LPK 进入托管状态后不得撤销子进程清理处理');
  assert.ok(!runScript.includes('/api/setup/status'), '启动预热不得改变用户初始化完成状态');
  assert.ok(npmConfig.includes('registry=https://registry.npmjs.org/'), 'LPK 构建必须使用 npm 官方源下载依赖');
  assert.ok(npmConfig.includes('replace-registry-host=always'), '锁文件中的镜像地址必须改由 npm 官方源下载');

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
    assert.ok((packageScript + containerScript).includes(expected), `LPK 构建必须隔离本地运行数据：${expected}`);
  });

  [
    'normalize_docker_proxy()',
    'host.docker.internal',
    '--add-host=host.docker.internal:host-gateway',
    'HTTP_PROXY=$DOCKER_HTTP_PROXY',
    'HTTPS_PROXY=$DOCKER_HTTPS_PROXY',
    'ensure_linux_next_swc()',
    'node_modules/@next/swc-linux-x64-gnu',
    'npm install --no-save --package-lock=false --ignore-scripts --include=optional',
    'run_timed "Next.js 构建" npm run build',
  ].forEach((expected) => {
    assert.ok(packageScript.includes(expected), `LPK Docker 构建必须正确传递宿主代理：${expected}`);
  });
  assert.ok(proxyFunction, 'LPK 构建必须定义宿主代理地址转换函数');

  function normalizeProxy(value) {
    return execFileSync(
      'sh',
      ['-c', `${proxyFunction[0].replace(/\n\nclean_runtime_state$/, '')}\nnormalize_docker_proxy "$1"`, 'sh', value],
      { encoding: 'utf8' }
    ).trim();
  }

  assert.strictEqual(normalizeProxy('http://127.0.0.1:7898'), 'http://host.docker.internal:7898', '回环 HTTP 代理必须改写为容器可访问地址');
  assert.strictEqual(normalizeProxy('https://localhost/proxy'), 'https://host.docker.internal/proxy', '回环 HTTPS 代理必须改写为容器可访问地址');
  assert.strictEqual(normalizeProxy('http://127.0.0.1.example:7898'), 'http://127.0.0.1.example:7898', '非回环主机名不得被误改写');
  assert.strictEqual(normalizeProxy('http://proxy.example:7898'), 'http://proxy.example:7898', '远程代理必须保持原值');

  assert.ok(lpkBuildConfig.includes('buildscript: sh lzc/build-package.sh'), 'LPK 配置必须声明唯一的内容构建脚本');
  assert.ok(lpkBuildScript.includes("await runCommand('lzc-cli', ['project', 'build', '-o', stagingPath]"), 'LPK 入口必须由 lzc-cli project build 写入临时包');
  assert.ok(!lpkBuildScript.includes("await run('sh', ['lzc/build-package.sh']"), 'LPK 入口不得在 lzc-cli project build 前重复执行内容构建脚本');
  assert.strictEqual(
    (lpkBuildScript.match(/await runCommand\('lzc-cli', \['project', 'build', '-o', stagingPath\]/g) || []).length,
    1,
    'dist:lpk 必须只调用一次 lzc-cli project build'
  );
  assert.ok(!lpkBuildScript.includes('removeOldPackages'), '打包前不得删除已有 LPK');
  assert.ok(lpkBuildScript.includes('await promoteStagedPackage(stagingPath, outputPath)'), '临时包存在后必须替换正式包');

  const { buildLpk, createStagedPackagePath } = require(path.join(repoRoot, 'desktop/scripts/build-lpk.js'));
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-lpk-promote-'));
  try {
    const outputPath = path.join(fixtureDir, 'cloud.lazycat.app.notus-v0.1.17.lpk');
    const packagePath = path.join(fixtureDir, 'package.yml');
    const lzcDir = path.join(fixtureDir, 'lzc');
    fs.mkdirSync(lzcDir);
    fs.writeFileSync(packagePath, 'package: cloud.lazycat.app.notus\nversion: 0.1.17\n');
    fs.writeFileSync(path.join(fixtureDir, 'lzc-build.yml'), 'buildscript: sh lzc/build-package.sh\n');
    fs.writeFileSync(path.join(fixtureDir, 'lzc-manifest.yml'), 'name: Notus\n');
    fs.writeFileSync(path.join(lzcDir, 'build-package.sh'), '#!/bin/sh\n');
    fs.writeFileSync(outputPath, 'previous-package');

    await assert.rejects(
      buildLpk({
        repoRoot: fixtureDir,
        runCommand: async () => {
          throw new Error('simulated build failure');
        },
      }),
      /simulated build failure/,
      '构建失败必须直接返回错误'
    );
    assert.strictEqual(fs.readFileSync(outputPath, 'utf8'), 'previous-package', '构建失败不得删除或替换已有正式包');

    for (const scenario of ['missing', 'empty', 'symlink']) {
      await assert.rejects(buildLpk({
        repoRoot: fixtureDir,
        runCommand: async (_command, args) => {
          if (scenario === 'empty') fs.writeFileSync(args[3], '');
          if (scenario === 'symlink') fs.symlinkSync(outputPath, args[3]);
        },
      }), '临时产物缺失、为空或为软链接必须拒绝替换');
      assert.strictEqual(fs.readFileSync(outputPath, 'utf8'), 'previous-package');
      assert.ok(!fs.existsSync(path.join(fixtureDir, '.lpk-build.lock')), '失败后必须释放打包锁');
    }
    await buildLpk({
      repoRoot: fixtureDir,
      runCommand: async (_command, args) => {
        await assert.rejects(buildLpk({ repoRoot: fixtureDir, runCommand: async () => {
          throw new Error('并发构建不应执行命令');
        } }), /已有 LPK 打包锁/);
        fs.writeFileSync(args[3], 'previous-package');
      },
    });

    await buildLpk({
      repoRoot: fixtureDir,
      runCommand: async (_command, args) => {
        const stagingPath = args[3];
        assert.ok(stagingPath.startsWith(fixtureDir), '临时包必须写入正式包所在目录');
        assert.ok(stagingPath.endsWith('.lpk'), '临时包必须保留 .lpk 扩展名');
        fs.writeFileSync(stagingPath, 'new-package');
      },
    });

    assert.strictEqual(fs.readFileSync(outputPath, 'utf8'), 'new-package', '构建成功后必须替换正式包');
    const remainingStagingPaths = fs.readdirSync(fixtureDir).filter((name) => name.includes('.staging-'));
    assert.deepStrictEqual(remainingStagingPaths, [], '替换完成后不应保留临时包');
    assert.ok(createStagedPackagePath(outputPath).startsWith(fixtureDir), '临时包路径必须位于正式包目录');
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  console.log('lazycat startup and package tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
