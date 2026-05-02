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

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const appRoot = path.join(repoRoot, 'notus');
  const outputRoot = path.join(repoRoot, 'web-dist');

  await run('npm', ['--prefix', 'notus', 'run', 'build'], { cwd: repoRoot });

  await fs.promises.rm(outputRoot, { recursive: true, force: true });
  await fs.promises.mkdir(outputRoot, { recursive: true });

  await copyDirectory(path.join(appRoot, '.next', 'standalone'), outputRoot);
  await copyDirectory(path.join(appRoot, '.next', 'static'), path.join(outputRoot, '.next', 'static'));

  if (fs.existsSync(path.join(appRoot, 'public'))) {
    await copyDirectory(path.join(appRoot, 'public'), path.join(outputRoot, 'public'));
  }

  console.log(`web-dist is ready at ${outputRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
