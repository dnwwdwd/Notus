const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function readPackageMeta(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const packageMatch = content.match(/^package:\s*(.+)\s*$/m);
  const versionMatch = content.match(/^version:\s*(.+)\s*$/m);

  if (!packageMatch || !versionMatch) {
    throw new Error(`无法从 ${filePath} 读取 package/version`);
  }

  return {
    packageName: packageMatch[1].trim(),
    version: versionMatch[1].trim(),
  };
}

function createStagedPackagePath(outputPath) {
  const directory = path.dirname(outputPath);
  const extension = path.extname(outputPath) || '.lpk';
  const baseName = path.basename(outputPath, extension);
  return path.join(directory, `.${baseName}.staging-${process.pid}-${Date.now()}${extension}`);
}

async function promoteStagedPackage(stagingPath, outputPath) {
  await fs.promises.rename(stagingPath, outputPath);
}

async function buildLpk(options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..');
  const runCommand = options.runCommand || run;
  const packagePath = path.join(repoRoot, 'package.yml');
  const lzcBuildPath = path.join(repoRoot, 'lzc-build.yml');
  const lzcManifestPath = path.join(repoRoot, 'lzc-manifest.yml');
  const buildScriptPath = path.join(repoRoot, 'lzc', 'build-package.sh');

  [packagePath, lzcBuildPath, lzcManifestPath, buildScriptPath].forEach((target) => {
    if (!fs.existsSync(target)) {
      throw new Error(`缺少懒猫打包文件：${target}`);
    }
  });

  const { packageName, version } = readPackageMeta(packagePath);
  const outputName = `${packageName}-v${version}.lpk`;
  const outputPath = path.join(repoRoot, outputName);
  const stagingPath = createStagedPackagePath(outputPath);

  // 同仓库的内容目录由 lzc-cli 读取，封包结束前不能被另一次构建替换。
  const lockPath = path.join(repoRoot, '.lpk-build.lock');
  let lock;
  try {
    lock = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`已有 LPK 打包锁：${lockPath}。请等待当前构建结束；若上次进程被强制终止，请确认其已退出后删除此锁再重试。`);
    }
    throw error;
  }
  const started = Date.now();
  try {
    fs.writeFileSync(lock, String(process.pid));
    console.log('[LPK] 开始 Linux 内容构建与封包');
    // lzc-cli 依据 lzc-build.yml 调用一次 build-package.sh，不能在入口重复构建。
    await runCommand('lzc-cli', ['project', 'build', '-o', stagingPath], { cwd: repoRoot });
    const staged = await fs.promises.lstat(stagingPath);
    if (!staged.isFile() || staged.size === 0) {
      throw new Error(`临时 LPK 无效或为空：${stagingPath}`);
    }
    await promoteStagedPackage(stagingPath, outputPath);
    console.log(`[LPK] 总耗时: ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
    console.log(`LPK is ready at ${outputPath}`);
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
    await fs.promises.rm(stagingPath, { force: true });
  }

}

if (require.main === module) {
  buildLpk().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  buildLpk,
  createStagedPackagePath,
  promoteStagedPackage,
};
