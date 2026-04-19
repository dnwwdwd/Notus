const fs = require('fs');
const { initDb, isVecAvailable } = require('./db');
const { readEnvConfig } = require('./config');
const { startWatcher } = require('./watcher');

let runtimeStarted = false;
let retryTimer = null;
let runtimeError = null;

function ensureDirs(config) {
  fs.mkdirSync(config.notesDir, { recursive: true });
  fs.mkdirSync(config.assetsDir, { recursive: true });
  fs.mkdirSync(require('path').dirname(config.dbPath), { recursive: true });
}

function scheduleRetries() {
  if (retryTimer) return;
  const { retryFailedIndexing } = require('./indexer');
  retryTimer = setInterval(() => {
    retryFailedIndexing().catch((error) => {
      console.error('[runtime] retry failed:', error);
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

    if (startBackground) {
      const { indexFile, removeFile } = require('./indexer');
      startWatcher({
        onAdd: (filePath) => indexFile(filePath).catch((error) => console.error('[watcher] add:', error)),
        onChange: (filePath) => indexFile(filePath).catch((error) => console.error('[watcher] change:', error)),
        onRemove: (relativePath) => removeFile(relativePath),
      }).catch((error) => {
        console.error('[runtime] watcher start failed:', error);
      });
      scheduleRetries();
    }

    runtimeStarted = true;
    runtimeError = null;
    return { ok: true, vecAvailable: isVecAvailable() };
  } catch (error) {
    runtimeError = error;
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
