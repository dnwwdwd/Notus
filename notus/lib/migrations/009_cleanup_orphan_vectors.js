module.exports = {
  version: 9,
  up(db, { tableExists }) {
    if (tableExists(db, 'chunks_vec')) {
      db.prepare(`
        DELETE FROM chunks_vec
        WHERE chunk_id NOT IN (SELECT id FROM chunks)
      `).run();
    }
    if (tableExists(db, 'images_vec')) {
      db.prepare(`
        DELETE FROM images_vec
        WHERE image_id NOT IN (SELECT id FROM images)
      `).run();
    }
  },
  down() {
    // 仅清理已经没有关联实体的向量，不能恢复已删除笔记的数据。
  },
};
