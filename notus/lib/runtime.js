const fs = require('fs');
const { initDb, isVecAvailable } = require('./db');
const { readEnvConfig } = require('./config');
const { createLogger } = require('./logger');
const { startWatcher } = require('./watcher');

let runtimeStarted = false;
let retryTimer = null;
let runtimeError = null;
const logger = createLogger({ subsystem: 'runtime' });

function ensureDirs(config) {
  fs.mkdirSync(config.notesDir, { recursive: true });
  fs.mkdirSync(config.assetsDir, { recursive: true });
  fs.mkdirSync(require('path').dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.logDir, { recursive: true });
}

function scheduleRetries() {
  if (retryTimer) return;
  const { retryFailedIndexing } = require('./indexer');
  retryTimer = setInterval(() => {
    retryFailedIndexing().catch((error) => {
      logger.error('runtime.retry.failed', { error });
    });
  }, 5 * 60 * 1000);
  if (retryTimer.unref) retryTimer.unref();
}

function ensureRuntime({ startBackground = true } = {}) {
  if (runtimeStarted) return { ok: true, vecAvailable: isVecAvailable() };

  try {
    const config = readEnvConfig();
    ensureDirs(config);
    initDb();
    logger.info('runtime.ready', {
      notes_dir: config.notesDir,
      db_path: config.dbPath,
      log_dir: config.logDir,
      vec_available: isVecAvailable(),
    });

    if (startBackground) {
      const { indexFile, removeFile } = require('./indexer');
      const { startStyleBackgroundWorkers } = require('./style');
      startWatcher({
        onAdd: (filePath) => indexFile(filePath).catch((error) => logger.error('watcher.add.failed', { file_path: filePath, error })),
        onChange: (filePath) => indexFile(filePath).catch((error) => logger.error('watcher.change.failed', { file_path: filePath, error })),
        onRemove: (relativePath) => removeFile(relativePath),
      }).catch((error) => {
        logger.error('runtime.watcher.start_failed', { error });
      });
      scheduleRetries();
      startStyleBackgroundWorkers();
    }

    runtimeStarted = true;
    runtimeError = null;
    return { ok: true, vecAvailable: isVecAvailable() };
  } catch (error) {
    runtimeError = error;
    logger.error('runtime.init.failed', { error });
    return { ok: false, error, vecAvailable: false };
  }
}

function getRuntimeStatus() {
  const result = ensureRuntime();
  return {
    ok: result.ok,
    vecAvailable: result.vecAvailable,
    error: result.error?.message || runtimeError?.message || null,
  };
}

module.exports = {
  ensureRuntime,
  getRuntimeStatus,
};
