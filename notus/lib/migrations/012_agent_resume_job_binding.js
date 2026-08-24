function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

module.exports = {
  version: 12,
  up(db, helpers = {}) {
    const exists = helpers.tableExists || tableExists;
    const columnExists = helpers.hasColumn || hasColumn;
    if (!exists(db, 'agent_task_queue')) return;

    if (!columnExists(db, 'agent_task_queue', 'resume_job_id')) {
      db.exec('ALTER TABLE agent_task_queue ADD COLUMN resume_job_id TEXT;');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_task_queue_resume_job
        ON agent_task_queue(resume_job_id);
    `);

    // 兼容升级前已经排队的恢复任务：只有同一 session 恰好有一个待执行 job
    // 时才补回绑定，避免历史异常数据按“最早 job”猜测并跳过新的提问卡片。
    if (exists(db, 'agent_resume_jobs')) {
      db.exec(`
        UPDATE agent_task_queue
        SET resume_job_id = (
          SELECT jobs.id
          FROM agent_resume_jobs jobs
          WHERE jobs.session_id = agent_task_queue.session_id
            AND jobs.status = 'queued'
          ORDER BY jobs.created_at ASC, jobs.id ASC
          LIMIT 1
        )
        WHERE resume_job_id IS NULL
          AND status IN ('queued', 'waiting_interaction', 'waiting_retry', 'waiting_model_recovery')
          AND 1 = (
            SELECT COUNT(*)
            FROM agent_resume_jobs jobs
            WHERE jobs.session_id = agent_task_queue.session_id
              AND jobs.status = 'queued'
          );
      `);
    }
  },
  down() {
    // SQLite 增量迁移保留已绑定的恢复任务数据。
  },
};
