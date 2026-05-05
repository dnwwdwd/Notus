const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ELECTRON_VERSION = require('../../node_modules/electron/package.json').version;

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

function parseArgs(argv) {
  const parsed = {
    platform: process.platform,
    arch: process.arch,
  };

  argv.forEach((arg) => {
    if (arg.startsWith('--platform=')) {
      parsed.platform = arg.slice('--platform='.length);
    } else if (arg.startsWith('--arch=')) {
      parsed.arch = arg.slice('--arch='.length);
    }
  });

  return parsed;
}

async function copyDirectory(source, target) {
  await fs.promises.mkdir(target, { recursive: true });
  const entries = await fs.promises.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }
    await fs.promises.copyFile(sourcePath, targetPath);
  }
}

async function prepareDesktopResources(repoRoot) {
  const appRoot = path.join(repoRoot, 'notus');
  const resourcesRoot = path.join(repoRoot, 'desktop', 'resources', 'notus');

  await fs.promises.rm(resourcesRoot, { recursive: true, force: true });
  await fs.promises.mkdir(resourcesRoot, { recursive: true });

  await copyDirectory(path.join(appRoot, '.next', 'standalone'), resourcesRoot);
  await copyDirectory(path.join(appRoot, '.next', 'static'), path.join(resourcesRoot, '.next', 'static'));

  if (fs.existsSync(path.join(appRoot, 'public'))) {
    await copyDirectory(path.join(appRoot, 'public'), path.join(resourcesRoot, 'public'));
  }

  await fs.promises.copyFile(
    path.join(appRoot, 'package-lock.json'),
    path.join(resourcesRoot, 'package-lock.json')
  );

  return resourcesRoot;
}

function buildInstallEnv(targetPlatform, targetArch) {
  const env = {
    ...process.env,
    npm_config_runtime: 'electron',
    npm_config_target: ELECTRON_VERSION,
    npm_config_disturl: 'https://electronjs.org/headers',
    npm_config_devdir: path.join(process.env.HOME || '', '.electron-gyp'),
    npm_config_update_binary: 'true',
    npm_config_fallback_to_build: 'true',
  };

  if (targetPlatform) {
    env.npm_config_platform = targetPlatform;
    env.npm_config_target_platform = targetPlatform;
  }

  if (targetArch) {
    env.npm_config_arch = targetArch;
    env.npm_config_target_arch = targetArch;
  }

  if (targetPlatform && targetPlatform !== process.platform) {
    env.npm_config_force = 'true';
  }

  return env;
}

async function installProductionDependencies(resourcesRoot, targetPlatform, targetArch) {
  await fs.promises.rm(path.join(resourcesRoot, 'node_modules'), { recursive: true, force: true });
  await run(
    'npm',
    ['ci', '--omit=dev', '--legacy-peer-deps'],
    {
      cwd: resourcesRoot,
      env: buildInstallEnv(targetPlatform, targetArch),
    }
  );
}

function getBetterSqlitePrebuildName(targetPlatform, targetArch) {
  const platformNameMap = {
    win32: 'win32',
    darwin: 'darwin',
    linux: 'linux',
  };

  const archNameMap = {
    x64: 'x64',
    arm64: 'arm64',
  };

  const platformName = platformNameMap[targetPlatform];
  const archName = archNameMap[targetArch];
  if (!platformName || !archName) {
    return null;
  }

  return `better-sqlite3-v11.10.0-electron-v135-${platformName}-${archName}.tar.gz`;
}

async function ensureBetterSqliteBinary(resourcesRoot, targetPlatform, targetArch) {
  const betterSqliteDir = path.join(resourcesRoot, 'node_modules', 'better-sqlite3');
  const prebuildBinary = path.join(betterSqliteDir, 'build', 'Release', 'better_sqlite3.node');
  const prebuildName = getBetterSqlitePrebuildName(targetPlatform, targetArch);
  const prebuildCachePath = prebuildName
    ? path.join(process.env.HOME || '', '.npm', '_prebuilds', prebuildName)
    : null;

  if (targetPlatform === process.platform && targetArch === process.arch) {
    return;
  }

  await fs.promises.rm(prebuildBinary, { force: true });

  if (prebuildCachePath && fs.existsSync(prebuildCachePath)) {
    await run('../.bin/prebuild-install', [], {
      cwd: betterSqliteDir,
      env: {
        ...buildInstallEnv(targetPlatform, targetArch),
        npm_config_build_from_source: 'false',
      },
    });
    return;
  }

  await run('../.bin/prebuild-install', [
    '--runtime=electron',
    `--target=${ELECTRON_VERSION}`,
    `--platform=${targetPlatform}`,
    `--arch=${targetArch}`,
  ], {
    cwd: betterSqliteDir,
    env: {
      ...buildInstallEnv(targetPlatform, targetArch),
      npm_config_build_from_source: 'false',
    },
  });
}

async function ensureSqliteVecPackage(resourcesRoot, targetPlatform, targetArch) {
  const platformPackageNameMap = {
    win32: 'windows',
    darwin: 'darwin',
    linux: 'linux',
  };

  const packagePlatform = platformPackageNameMap[targetPlatform];
  if (!packagePlatform) {
    return;
  }

  const packageName = `sqlite-vec-${packagePlatform}-${targetArch}@0.1.9`;
  await run(
    'npm',
    ['install', '--no-save', '--force', packageName],
    {
      cwd: resourcesRoot,
      env: buildInstallEnv(targetPlatform, targetArch),
    }
  );
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const { platform: targetPlatform, arch: targetArch } = parseArgs(process.argv.slice(2));

  await run('npm', ['--prefix', 'notus', 'run', 'build'], { cwd: repoRoot });
  const resourcesRoot = await prepareDesktopResources(repoRoot);
  await installProductionDependencies(resourcesRoot, targetPlatform, targetArch);
  await ensureBetterSqliteBinary(resourcesRoot, targetPlatform, targetArch);
  await ensureSqliteVecPackage(resourcesRoot, targetPlatform, targetArch);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
