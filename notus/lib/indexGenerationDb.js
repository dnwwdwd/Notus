const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { readEnvConfig } = require('./config');
const { createLogger } = require('./logger');

const logger = createLogger({ subsystem: 'index-generation-db' });
const dbCache = new Map();

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function getGenerationDbPath(id) {
  const config = readEnvConfig();
  return path.join(path.dirname(config.dbPath), 'index-generations', `generation-${Number(id)}.db`);
}

function normalizeDim(generation) {
  const snapshot = generation?.config_snapshot_object || {};
  const raw = snapshot.embeddingDim || snapshot.embedding_dim || 1024;
  const dim = Number(raw);
  return Number.isFinite(dim) && dim > 0 ? dim : 1024;
}

function loadVecExtension(database) {
  try {
    sqliteVec.load(database);
    database.prepare('SELECT vec_version() AS version').get();
    return true;
  } catch (error) {
    logger.warn('index_generation_db.vec_unavailable', {
      db_path: database.name,
      error,
    });
    return false;
  }
}

function createVecTables(database, dim) {
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dim}] distance_metric=cosine
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS images_vec USING vec0(
      image_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dim}] distance_metric=cosine
    );
  `);
}

function recreateFts(database) {
  database.exec(`
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_ad;
    DROP TRIGGER IF EXISTS chunks_au;
    DROP TABLE IF EXISTS chunks_fts;

    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content,
      search_text,
      tokenize='unicode61'
    );

    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, search_text)
      VALUES (new.id, new.content, new.search_text);
    END;

    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
    END;

    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
      INSERT INTO chunks_fts(rowid, content, search_text)
      VALUES (new.id, new.content, new.search_text);
    END;
  `);
}

function ensureGenerationSchema(database, generation) {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('synchronous = NORMAL');
  database.pragma('busy_timeout = 5000');

  database.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id           INTEGER PRIMARY KEY,
      file_id      INTEGER NOT NULL,
      content      TEXT NOT NULL,
      type         TEXT NOT NULL,
      position     INTEGER NOT NULL,
      line_start   INTEGER,
      line_end     INTEGER,
      heading_path TEXT,
      has_image    INTEGER DEFAULT 0,
      search_text  TEXT NOT NULL DEFAULT '',
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_position ON chunks(file_id, position);

    CREATE TABLE IF NOT EXISTS images (
      id                 INTEGER PRIMARY KEY,
      chunk_id           INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      url                TEXT NOT NULL,
      status             TEXT DEFAULT 'pending',
      caption            TEXT,
      local_path         TEXT,
      processed_at       TEXT,
      alt_text           TEXT,
      cache_status       TEXT NOT NULL DEFAULT 'pending',
      cache_error        TEXT,
      mime_type          TEXT,
      content_length     INTEGER,
      cached_at          TEXT,
      embedding_status   TEXT NOT NULL DEFAULT 'pending',
      embedding_error    TEXT,
      embedded_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_images_chunk_id ON images(chunk_id);
    CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
  `);

  recreateFts(database);

  const vecEnabled = loadVecExtension(database);
  if (vecEnabled) {
    createVecTables(database, normalizeDim(generation));
  }
  return vecEnabled;
}

function getGenerationHandle(generation) {
  const dbPath = generation?.db_path || getGenerationDbPath(generation?.id);
  if (dbCache.has(dbPath)) {
    return dbCache.get(dbPath);
  }

  ensureParentDir(dbPath);
  const database = new Database(dbPath);
  const handle = {
    db: database,
    dbPath,
    vecEnabled: ensureGenerationSchema(database, generation),
  };
  dbCache.set(dbPath, handle);
  return handle;
}

function getGenerationDb(generation) {
  return getGenerationHandle(generation).db;
}

function isGenerationVecEnabled(generation) {
  return Boolean(getGenerationHandle(generation).vecEnabled);
}

function clearGenerationData(generation) {
  const handle = getGenerationHandle(generation);
  const { db, vecEnabled } = handle;

  db.transaction(() => {
    if (vecEnabled) {
      db.prepare('DELETE FROM images_vec').run();
      db.prepare('DELETE FROM chunks_vec').run();
    }
    db.prepare('DELETE FROM images').run();
    db.prepare('DELETE FROM chunks').run();
  })();
}

function closeGenerationDb(generation) {
  const dbPath = generation?.db_path || getGenerationDbPath(generation?.id);
  const handle = dbCache.get(dbPath);
  if (!handle) return;
  try {
    handle.db.close();
  } catch {
    // ignore close errors during shutdown / rebuild replacement
  }
  dbCache.delete(dbPath);
}

function closeAllGenerationDbs() {
  [...dbCache.keys()].forEach((dbPath) => closeGenerationDb({ db_path: dbPath }));
}

function copyLegacyIndexFromMainDb(generation, mainDb) {
  const handle = getGenerationHandle(generation);
  const { db, vecEnabled } = handle;

  clearGenerationData(generation);

  const chunks = mainDb.prepare(`
    SELECT id, file_id, content, type, position, line_start, line_end, heading_path, has_image, search_text, created_at
    FROM chunks
    ORDER BY id ASC
  `).all();
  const images = mainDb.prepare(`
    SELECT
      id,
      chunk_id,
      url,
      status,
      caption,
      local_path,
      processed_at,
      alt_text,
      cache_status,
      cache_error,
      mime_type,
      content_length,
      cached_at,
      embedding_status,
      embedding_error,
      embedded_at
    FROM images
    ORDER BY id ASC
  `).all();

  const insertChunk = db.prepare(`
    INSERT INTO chunks (
      id, file_id, content, type, position, line_start, line_end, heading_path, has_image, search_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertImage = db.prepare(`
    INSERT INTO images (
      id, chunk_id, url, status, caption, local_path, processed_at, alt_text,
      cache_status, cache_error, mime_type, content_length, cached_at,
      embedding_status, embedding_error, embedded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    chunks.forEach((row) => {
      insertChunk.run(
        row.id,
        row.file_id,
        row.content,
        row.type,
        row.position,
        row.line_start,
        row.line_end,
        row.heading_path,
        row.has_image,
        row.search_text,
        row.created_at
      );
    });
    images.forEach((row) => {
      insertImage.run(
        row.id,
        row.chunk_id,
        row.url,
        row.status,
        row.caption,
        row.local_path,
        row.processed_at,
        row.alt_text,
        row.cache_status,
        row.cache_error,
        row.mime_type,
        row.content_length,
        row.cached_at,
        row.embedding_status,
        row.embedding_error,
        row.embedded_at
      );
    });
  })();

  let chunkVecCopied = false;
  let imageVecCopied = false;

  if (vecEnabled) {
    try {
      const chunkVectors = mainDb.prepare('SELECT chunk_id, embedding FROM chunks_vec').all();
      const insertChunkVec = db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)');
      db.transaction(() => {
        chunkVectors.forEach((row) => {
          insertChunkVec.run(BigInt(row.chunk_id), row.embedding);
        });
      })();
      chunkVecCopied = true;
    } catch (error) {
      logger.warn('index_generation_db.copy_legacy_chunk_vec_failed', {
        generation_id: generation?.id,
        error,
      });
    }

    try {
      const imageVectors = mainDb.prepare('SELECT image_id, embedding FROM images_vec').all();
      const insertImageVec = db.prepare('INSERT INTO images_vec (image_id, embedding) VALUES (?, ?)');
      db.transaction(() => {
        imageVectors.forEach((row) => {
          insertImageVec.run(BigInt(row.image_id), row.embedding);
        });
      })();
      imageVecCopied = true;
    } catch (error) {
      logger.warn('index_generation_db.copy_legacy_image_vec_failed', {
        generation_id: generation?.id,
        error,
      });
    }
  }

  return {
    chunks: chunks.length,
    images: images.length,
    chunk_vec_copied: chunkVecCopied,
    image_vec_copied: imageVecCopied,
  };
}

module.exports = {
  getGenerationDbPath,
  getGenerationDb,
  getGenerationHandle,
  isGenerationVecEnabled,
  clearGenerationData,
  closeGenerationDb,
  closeAllGenerationDbs,
  copyLegacyIndexFromMainDb,
};
