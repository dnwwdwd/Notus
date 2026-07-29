const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'notus-lazycat-skill-rescan-'));
process.env.NOTUS_RUNTIME_TARGET = 'lazycat';
process.env.NOTUS_DATA_ROOT = dataRoot;
process.env.SESSION_DIR = path.join(dataRoot, 'session');

const skillDir = path.join(dataRoot, 'skills', 'restart-skill');
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: restart-skill\ndescription: 懒猫重启扫描回归\n---\n\n测试内容\n');

const { ensureRuntime } = require('../lib/runtime');
const { listSkills, scanAllSkills, stopSkillWatchers } = require('../lib/skills');

try {
  assert.equal(ensureRuntime({ startBackground: false }).ok, true);
  assert.equal(listSkills().find((skill) => skill.name === 'restart-skill')?.status, 'valid');
  assert.equal(scanAllSkills().find((skill) => skill.name === 'restart-skill')?.status, 'valid');
  console.log('lazycat skill rescan tests passed');
} finally {
  stopSkillWatchers();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
