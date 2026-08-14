const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ELECTRON_VERSION = require('../../node_modules/electron/package.json').version;
const SQLITE_VEC_VERSION = '0.1.9';
const SQLITE_VEC_AMALGAMATION = {
  name: `sqlite-vec-${SQLITE_VEC_VERSION}-amalgamation.zip`,
  url: `https://github.com/asg017/sqlite-vec/releases/download/v${SQLITE_VEC_VERSION}/sqlite-vec-${SQLITE_VEC_VERSION}-amalgamation.zip`,
  sha256: 'b87cdda12112657ba5ab8842f0088a4090982eaf41f22b2bd6d495b81765a8c9',
};

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

function shouldCompileSqliteVecFromSource(targetPlatform, targetArch) {
  return targetPlatform === 'win32' && targetArch === 'arm64';
}

function getWindowsArm64VecExtensionPath(resourcesRoot) {
  return path.join(resourcesRoot, 'native', 'sqlite-vec', 'win32-arm64', 'vec0.dll');
}

async function downloadVerifiedFile({ url, sha256, outputPath }) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to download ${url}: ${response.status} ${response.statusText}`);
  }

  const contents = Buffer.from(await response.arrayBuffer());
  const actualSha256 = crypto.createHash('sha256').update(contents).digest('hex');
  if (actualSha256 !== sha256) {
    throw new Error(`Checksum mismatch for ${url}: expected ${sha256}, received ${actualSha256}`);
  }

  await fs.promises.writeFile(outputPath, contents);
}

async function assertWindowsArm64Dll(extensionPath) {
  const contents = await fs.promises.readFile(extensionPath);
  if (contents.length < 0x40 || contents.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`sqlite-vec did not produce a valid Windows DLL: ${extensionPath}`);
  }

  const peOffset = contents.readUInt32LE(0x3c);
  if (peOffset + 6 > contents.length || contents.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`sqlite-vec DLL is missing its PE header: ${extensionPath}`);
  }

  const machine = contents.readUInt16LE(peOffset + 4);
  if (machine !== 0xaa64) {
    throw new Error(`sqlite-vec DLL is not ARM64 (machine 0x${machine.toString(16)}): ${extensionPath}`);
  }
}

async function compileWindowsArm64SqliteVec(resourcesRoot) {
  const sourceRoot = path.join(resourcesRoot, '.native-build', `sqlite-vec-${SQLITE_VEC_VERSION}`);
  const sqliteIncludeRoot = path.join(resourcesRoot, 'node_modules', 'better-sqlite3', 'deps', 'sqlite3');
  const extensionPath = getWindowsArm64VecExtensionPath(resourcesRoot);
  const extensionOutputBase = extensionPath.slice(0, -path.extname(extensionPath).length);
  const sourcePath = path.join(sourceRoot, 'sqlite-vec.c');

  if (!fs.existsSync(path.join(sqliteIncludeRoot, 'sqlite3.h')) || !fs.existsSync(path.join(sqliteIncludeRoot, 'sqlite3ext.h'))) {
    throw new Error(`Missing better-sqlite3 SQLite headers required for Windows ARM64 sqlite-vec: ${sqliteIncludeRoot}`);
  }

  await fs.promises.rm(sourceRoot, { recursive: true, force: true });
  await fs.promises.mkdir(sourceRoot, { recursive: true });
  const sourceArchivePath = path.join(sourceRoot, SQLITE_VEC_AMALGAMATION.name);
  await downloadVerifiedFile({
    ...SQLITE_VEC_AMALGAMATION,
    outputPath: sourceArchivePath,
  });
  await run('tar', ['-xf', sourceArchivePath, '-C', sourceRoot], {
    cwd: sourceRoot,
    env: buildInstallEnv('win32', 'arm64'),
  });
  if (!fs.existsSync(sourcePath) || !fs.existsSync(path.join(sourceRoot, 'sqlite-vec.h'))) {
    throw new Error(`sqlite-vec amalgamation did not contain the required source files: ${sourceArchivePath}`);
  }

  await fs.promises.mkdir(path.dirname(extensionPath), { recursive: true });
  await Promise.all([
    extensionPath,
    `${extensionOutputBase}.exp`,
    `${extensionOutputBase}.lib`,
    `${extensionOutputBase}.pdb`,
  ].map((filePath) => fs.promises.rm(filePath, { force: true })));

  try {
    await run('cl', [
      '/nologo',
      '/LD',
      '/O2',
      `/I${sqliteIncludeRoot}`,
      `/Fe:${extensionPath}`,
      sourcePath,
    ], {
      cwd: sourceRoot,
      env: buildInstallEnv('win32', 'arm64'),
    });
    await assertWindowsArm64Dll(extensionPath);
  } finally {
    await fs.promises.rm(sourceRoot, { recursive: true, force: true });
    await Promise.all([
      `${extensionOutputBase}.exp`,
      `${extensionOutputBase}.lib`,
      `${extensionOutputBase}.pdb`,
    ].map((filePath) => fs.promises.rm(filePath, { force: true })));
  }
}

async function ensureSqliteVecPackage(resourcesRoot, targetPlatform, targetArch) {
  if (shouldCompileSqliteVecFromSource(targetPlatform, targetArch)) {
    await compileWindowsArm64SqliteVec(resourcesRoot);
    return;
  }

  const platformPackageNameMap = {
    win32: 'windows',
    darwin: 'darwin',
    linux: 'linux',
  };

  const packagePlatform = platformPackageNameMap[targetPlatform];
  if (!packagePlatform) {
    return;
  }

  const packageName = `sqlite-vec-${packagePlatform}-${targetArch}@${SQLITE_VEC_VERSION}`;
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

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  SQLITE_VEC_AMALGAMATION,
  assertWindowsArm64Dll,
  getWindowsArm64VecExtensionPath,
  shouldCompileSqliteVecFromSource,
};
