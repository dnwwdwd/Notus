const assert = require('assert');
let initializations = 0;
let vectorChecks = 0;
const dbId = require.resolve('../lib/db');
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: {
  initDb() { initializations += 1; throw new Error('health must not initialize runtime'); },
  isVecAvailable() { vectorChecks += 1; return true; },
} };
const { getRuntimeStatus } = require('../lib/runtime');
assert.equal(getRuntimeStatus().ok, false);
assert.equal(getRuntimeStatus().ok, false);
assert.equal(initializations, 0, '冷启动状态读取不能初始化数据库或后台任务');
assert.equal(vectorChecks, 0, '冷启动时 isVecAvailable 也会打开数据库，不能调用');
console.log('runtime health readonly tests passed');
