const fs = require('fs');
const { initDb, isVecAvailable } = require('./db');
const { readEnvConfig } = require('./config');
const { createLogger } = require('./logger');
const { startWatcher } = require('./watcher');

let runtimeStarted = false;
let retryTimer = null;
let runtimeError = null;
let maintenanceMode = null;
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

function ensureRuntime({ startBackground = true, allowMaintenance = false } = {}) {
  if (maintenanceMode && !allowMaintenance) {
    const error = new Error('Notus 正在进行数据维护，请稍候重试');
    error.code = 'DATA_MAINTENANCE';
    return { ok: false, error, vecAvailable: false };
  }
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

function beginDataMaintenance(mode = 'data') {
  if (maintenanceMode) {
    const error = new Error('已有数据维护操作正在进行');
    error.code = 'DATA_MAINTENANCE_BUSY';
    error.status = 409;
    throw error;
  }
  maintenanceMode = String(mode || 'data');
  return maintenanceMode;
}

function endDataMaintenance() {
  maintenanceMode = null;
}

function getDataMaintenanceMode() {
  return maintenanceMode;
}

async function stopRuntime() {
  const { stopWatcher } = require('./watcher');
  const { stopSkillWatchers } = require('./skills');
  const { stopGlobalAgentFileWatcher } = require('./globalAgentFiles');
  const { closeAllConnections } = require('./mcp');
  const { stopSessionCleaner } = require('./agentSessionCleaner');
  const { stopStyleBackgroundWorkers } = require('./style');
  const { stopAgentTaskWorker } = require('./agentTaskWorker');
  // 先停止新的队列领取和后台定时任务，再等待 watcher/MCP 关闭，避免维护锁
  // 建立后又有新写入进入数据库。
  stopAgentTaskWorker();
  stopStyleBackgroundWorkers();
  stopSessionCleaner();
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
  await Promise.allSettled([
    stopWatcher(),
    Promise.resolve(stopSkillWatchers()),
    stopGlobalAgentFileWatcher(),
    closeAllConnections(),
  ]);
  const { closeDb } = require('./db');
  closeDb();
  runtimeStarted = false;
  runtimeError = null;
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
  beginDataMaintenance,
  endDataMaintenance,
  getDataMaintenanceMode,
  stopRuntime,
  getRuntimeStatus,
};
