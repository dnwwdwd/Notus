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

async function removeOldPackages(repoRoot, packageName) {
  const entries = await fs.promises.readdir(repoRoot);
  const targets = entries
    .filter((entry) => entry.startsWith(`${packageName}-v`) && entry.endsWith('.lpk'))
    .map((entry) => path.join(repoRoot, entry));

  await Promise.all(targets.map((target) => fs.promises.rm(target, { force: true })));
  return targets;
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
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
  const removed = await removeOldPackages(repoRoot, packageName);
  if (removed.length > 0) {
    console.log(`已删除旧包：${removed.map((file) => path.basename(file)).join(', ')}`);
  }

  await run('sh', ['lzc/build-package.sh'], { cwd: repoRoot });
  await run('lzc-cli', ['project', 'build'], { cwd: repoRoot });

  const outputName = `${packageName}-v${version}.lpk`;
  const outputPath = path.join(repoRoot, outputName);
  if (!fs.existsSync(outputPath)) {
    throw new Error(`打包完成，但未找到产物：${outputPath}`);
  }

  console.log(`LPK is ready at ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
