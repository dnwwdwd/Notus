module.exports = {
  version: 16,
  up(db) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'canvas_operation_sets'").get()) return;
    if (!db.prepare('PRAGMA table_info(canvas_operation_sets)').all().some(column => column.name === 'revision_base_path')) {
      db.exec("ALTER TABLE canvas_operation_sets ADD COLUMN revision_base_path TEXT NOT NULL DEFAULT ''");
    }
    // 旧待应用预览尚未覆盖原路径，可以直接保留。已应用记录不能反推。
    db.exec(`UPDATE canvas_operation_sets SET revision_base_path = revision_file_path
      WHERE revision_type = 'file_revision' AND status = 'pending' AND revision_base_path = ''`);
  },
  down() {},
};
