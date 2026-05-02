const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const children = [];

function start(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
    }
    children.forEach((item) => {
      if (item !== child) {
        try {
          item.kill('SIGTERM');
        } catch {}
      }
    });
    process.exit(code || 0);
  });
  children.push(child);
}

start('web', 'npm', ['--prefix', 'notus', 'run', 'dev']);
start('desktop', 'node', ['desktop/scripts/dev-electron.js']);
