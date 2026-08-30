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
  fs.mkdirSync(config.sessionDir, { recursive: true });
  fs.mkdirSync(config.agentDir, { recursive: true });
  fs.mkdirSync(config.toolResultDir, { recursive: true });
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
    try {
      require('./agentToolResultStore').cleanupOrphanedToolResultFiles();
    } catch (error) {
      logger.warn('agent_tool_results.cleanup_failed', { error });
    }
    try {
      require('./skills').initializeSkills();
    } catch (error) {
      logger.warn('skills.runtime.init_failed', { error });
    }
    try {
      const { initializeGlobalAgentFiles, startGlobalAgentFileWatcher } = require('./globalAgentFiles');
      initializeGlobalAgentFiles();
      if (startBackground) startGlobalAgentFileWatcher();
    } catch (error) {
      logger.warn('agent_files.runtime.init_failed', { error });
    }
    logger.info('runtime.ready', {
      notes_dir: config.notesDir,
      db_path: config.dbPath,
      log_dir: config.logDir,
      vec_available: isVecAvailable(),
    });

    if (startBackground) {
      const { indexFile, removeFile } = require('./indexer');
      const { startStyleBackgroundWorkers } = require('./style');
      const { startSessionCleaner } = require('./agentSessionCleaner');
      startWatcher({
        onAdd: (filePath) => indexFile(filePath).catch((error) => logger.error('watcher.add.failed', { file_path: filePath, error })),
        onChange: (filePath) => indexFile(filePath).catch((error) => logger.error('watcher.change.failed', { file_path: filePath, error })),
        onRemove: (relativePath) => removeFile(relativePath),
      }).catch((error) => {
        logger.error('runtime.watcher.start_failed', { error });
      });
      scheduleRetries();
      startStyleBackgroundWorkers();
      startSessionCleaner();
      // Agent 任务与 HTTP/SSE 连接解耦：运行时启动后由常驻 Worker 领取持久化队列，
      // 服务重启会把未释放的 running 任务恢复为 queued 并从 checkpoint 续跑。
      require('./agentTaskWorker').startAgentTaskWorker();
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
