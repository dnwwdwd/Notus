const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testsDir = path.join(__dirname, '..', 'tests');
const tests = fs.readdirSync(testsDir).filter((name) => name.endsWith('.test.js')).sort();
for (const name of tests) {
  const result = spawnSync(process.execPath, [path.join(testsDir, name)], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
const evalResult = spawnSync(process.execPath, [path.join(__dirname, 'run-agent-prompt-eval.js')], { stdio: 'inherit', env: process.env });
process.exit(evalResult.status || 0);
