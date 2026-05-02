const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron', '.'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NOTUS_DESKTOP_DEV: '1',
      NOTUS_DESKTOP_DEV_URL: process.env.NOTUS_DESKTOP_DEV_URL || 'http://127.0.0.1:3000',
    },
  }
);

child.on('exit', (code) => {
  process.exit(code || 0);
});
