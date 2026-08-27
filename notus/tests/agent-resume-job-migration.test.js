const assert = require('assert');
const Database = require('better-sqlite3');

const migration = require('../lib/migrations/012_agent_resume_job_binding');

function buildLegacyDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_task_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE agent_resume_jobs (
      id TEXT PRIMARY KEY,
      session_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function runTests() {
  const db = buildLegacyDb();
  const insertTask = db.prepare('INSERT INTO agent_task_queue (session_id, status) VALUES (?, ?)');
  const insertJob = db.prepare('INSERT INTO agent_resume_jobs (id, session_id, status, created_at) VALUES (?, ?, ?, ?)');

  const noJobTaskId = insertTask.run(101, 'waiting_interaction').lastInsertRowid;

  const singleJobTaskId = insertTask.run(102, 'waiting_interaction').lastInsertRowid;
  insertJob.run('resume-single', 102, 'queued', '2026-08-26T10:00:00.000Z');

  const multipleJobTaskId = insertTask.run(103, 'waiting_interaction').lastInsertRowid;
  insertJob.run('resume-many-a', 103, 'queued', '2026-08-26T10:00:00.000Z');
  insertJob.run('resume-many-b', 103, 'queued', '2026-08-26T10:01:00.000Z');

  migration.up(db);

  const columns = db.prepare('PRAGMA table_info(agent_task_queue)').all().map((row) => row.name);
  assert.ok(columns.includes('resume_job_id'), '迁移必须新增可空 resume_job_id 字段');
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_task_queue_resume_job'").get(),
    '迁移必须新增 resume_job_id 索引'
  );
  assert.strictEqual(
    db.prepare('SELECT resume_job_id FROM agent_task_queue WHERE id = ?').get(noJobTaskId).resume_job_id,
    null,
    '没有排队恢复任务时不得绑定'
  );
  assert.strictEqual(
    db.prepare('SELECT resume_job_id FROM agent_task_queue WHERE id = ?').get(singleJobTaskId).resume_job_id,
    'resume-single',
    '同一会话恰好一个排队恢复任务时必须绑定'
  );
  assert.strictEqual(
    db.prepare('SELECT resume_job_id FROM agent_task_queue WHERE id = ?').get(multipleJobTaskId).resume_job_id,
    null,
    '同一会话有多个排队恢复任务时不得猜测绑定'
  );

  assert.doesNotThrow(() => migration.up(db), '重复执行迁移不得报错');
  assert.strictEqual(
    db.prepare('SELECT resume_job_id FROM agent_task_queue WHERE id = ?').get(singleJobTaskId).resume_job_id,
    'resume-single',
    '重复执行迁移不得重复修改已有绑定'
  );
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) AS count FROM agent_task_queue').get().count,
    3,
    '迁移不得删除历史队列数据'
  );

  db.close();
  console.log('agent resume job migration tests passed');
}

runTests();
