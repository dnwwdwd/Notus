const { getDb } = require('./db');
const {
  syncFilesFromDisk,
  getFileByPath,
  ensureMarkdownPath,
  listMarkdownFiles,
} = require('./files');
const { createAppError, ensureError } = require('./errors');
const { createLogger } = require('./logger');
const {
  ensureActiveGeneration,
  getActiveGeneration,
  getGenerationById,
  getLatestRebuildGeneration,
  buildEmbeddingConfig,
  createGeneration,
  updateGeneration,
  updateGenerationProgress,
  markGenerationFailed,
  activateGeneration,
  applyGenerationAsActiveFileStatus,
  setFileQueued,
  setFileRunning,
  setFileIndexStatus,
  upsertGenerationFileResult,
  getGenerationFileResult,
  deleteGenerationFileResult,
  upsertGenerationDirtyFile,
  listGenerationDirtyFiles,
  clearGenerationDirtyFile,
} = require('./indexGenerations');
const { indexFileToGeneration, removeFileFromGeneration } = require('./indexer');
const { clearGenerationData } = require('./indexGenerationDb');

const logger = createLogger({ subsystem: 'index-coordinator' });

class IndexCoordinator {
  constructor() {
    this.initialized = false;
    this.fileQueue = [];
    this.fileEntries = new Map();
    this.processing = false;
    this.rebuildTask = null;
  }

  init() {
    if (this.initialized) return;

    const activeGeneration = ensureActiveGeneration();
    syncFilesFromDisk();

    getDb().prepare(`
      UPDATE file_index_status
      SET status = 'queued', updated_at = datetime('now')
      WHERE status = 'running'
    `).run();

    const recoverRows = getDb().prepare(`
      SELECT f.path
      FROM files f
      LEFT JOIN file_index_status s ON s.file_id = f.id
      WHERE s.file_id IS NULL OR s.status IN ('queued', 'running')
      ORDER BY f.path COLLATE NOCASE
    `).all();

    recoverRows.forEach((row) => {
      this.enqueuePath(row.path, { reason: 'recover', silent: true });
    });

    const rebuildGeneration = getLatestRebuildGeneration();
    if (rebuildGeneration && ['queued', 'building', 'catching_up', 'validated'].includes(rebuildGeneration.state)) {
      this.rebuildTask = {
        generationId: rebuildGeneration.id,
        abortRequested: false,
        finished: false,
      };
      setImmediate(() => {
        this.runRebuild(rebuildGeneration.id, this.rebuildTask).catch((error) => {
          logger.error('index_coordinator.resume_rebuild_failed', { generation_id: rebuildGeneration.id, error });
        });
      });
    }

    if (activeGeneration) {
      this.processQueue().catch((error) => {
        logger.error('index_coordinator.initial_process_failed', { error });
      });
    }

    this.initialized = true;
  }

  enqueuePath(inputPath, options = {}) {
    this.init();

    const relativePath = ensureMarkdownPath(inputPath);
    syncFilesFromDisk();
    const file = getFileByPath(relativePath);
    const activeGeneration = getActiveGeneration();
    const rebuildGeneration = getLatestRebuildGeneration();

    if (file && activeGeneration) {
      setFileQueued(file, activeGeneration.id, { contentHash: file.hash || null });
      if (rebuildGeneration && rebuildGeneration.id !== activeGeneration.id &&
        ['queued', 'building', 'catching_up', 'validated'].includes(rebuildGeneration.state)) {
        upsertGenerationDirtyFile(rebuildGeneration.id, file);
      }
    }

    const current = this.fileEntries.get(relativePath) || {
      path: relativePath,
      pendingHash: file?.hash || null,
      processing: false,
    };
    current.pendingHash = file?.hash || current.pendingHash || null;
    current.reason = options.reason || current.reason || 'queue';
    this.fileEntries.set(relativePath, current);

    if (!current.processing && !this.fileQueue.includes(relativePath)) {
      this.fileQueue.push(relativePath);
    }

    setImmediate(() => {
      this.processQueue().catch((error) => {
        logger.error('index_coordinator.process_queue_failed', { error });
      });
    });

    return {
      path: relativePath,
      index_state: 'queued',
      active_generation_id: activeGeneration?.id || null,
    };
  }

  enqueuePaths(paths = [], options = {}) {
    return (paths || [])
      .filter(Boolean)
      .map((itemPath) => this.enqueuePath(itemPath, options));
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.fileQueue.length > 0) {
        const relativePath = this.fileQueue.shift();
        const entry = this.fileEntries.get(relativePath);
        if (!entry) continue;

        entry.processing = true;
        let processedHash = entry.pendingHash || null;
        try {
          processedHash = await this.processSinglePath(relativePath);
        } catch (error) {
          logger.error('index_coordinator.process_single_failed', {
            file_path: relativePath,
            error,
          });
        }
        entry.processing = false;

        const next = this.fileEntries.get(relativePath);
        if (!next) continue;

        if (next.pendingHash && processedHash && next.pendingHash !== processedHash) {
          if (!this.fileQueue.includes(relativePath)) this.fileQueue.push(relativePath);
        } else {
          this.fileEntries.delete(relativePath);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  async processSinglePath(relativePath) {
    syncFilesFromDisk();
    const activeGeneration = getActiveGeneration() || ensureActiveGeneration();
    const file = getFileByPath(relativePath);

    if (!file) {
      return null;
    }

    const currentStatus = getDb().prepare(`
      SELECT *
      FROM file_index_status
      WHERE file_id = ?
    `).get(Number(file.id));

    if (currentStatus &&
      currentStatus.generation_id === activeGeneration.id &&
      currentStatus.content_hash === file.hash &&
      ['ready', 'degraded'].includes(currentStatus.status)) {
      return file.hash;
    }

    setFileRunning(file, activeGeneration.id, { contentHash: file.hash || null });
    try {
      const result = await indexFileToGeneration({
        generation: activeGeneration,
        relativePath: file.path,
        fileId: file.id,
      });
      setFileIndexStatus(file, activeGeneration.id, result);
      return result.contentHash || file.hash || null;
    } catch (error) {
      const normalized = ensureError(error, 'INDEX_FAILED', '索引失败');
      setFileIndexStatus(file, activeGeneration.id, {
        status: 'failed',
        content_hash: file.hash || null,
        chunks_count: 0,
        text_indexed: 0,
        vector_indexed: 0,
        image_vector_indexed: 0,
        error: normalized.message,
      });
      throw normalized;
    }
  }

  removePath(inputPath) {
    this.init();
    const relativePath = ensureMarkdownPath(inputPath);
    const fileRow = getDb().prepare('SELECT id, path FROM files WHERE path = ?').get(relativePath);
    const activeGeneration = getActiveGeneration();
    if (fileRow && activeGeneration) {
      removeFileFromGeneration(activeGeneration, { fileId: fileRow.id });
    }
    this.fileEntries.delete(relativePath);
    this.fileQueue = this.fileQueue.filter((item) => item !== relativePath);
  }

  handleRename(oldPath, newPath) {
    this.removePath(oldPath);
    return this.enqueuePath(newPath, { reason: 'rename' });
  }

  async retryFailed(limit = 10) {
    this.init();

    const rows = getDb().prepare(`
      SELECT f.path
      FROM file_index_status s
      JOIN files f ON f.id = s.file_id
      WHERE s.status = 'failed'
      ORDER BY s.updated_at ASC
      LIMIT ?
    `).all(Number(limit || 10));

    rows.forEach((row) => this.enqueuePath(row.path, { reason: 'retry' }));
    const activeGeneration = getActiveGeneration();
    return {
      queued: rows.length,
      paths: rows.map((row) => row.path),
      active_generation_id: activeGeneration?.id || null,
    };
  }

  clearActiveIndex() {
    this.init();
    const activeGeneration = getActiveGeneration() || ensureActiveGeneration();
    clearGenerationData(activeGeneration);
    getDb().prepare('DELETE FROM file_index_status').run();
    getDb().prepare(`
      UPDATE files
      SET indexed = 0,
          indexed_at = NULL,
          index_error = NULL,
          retry_count = 0,
          updated_at = datetime('now')
    `).run();
    syncFilesFromDisk();
  }

  startRebuild(options = {}) {
    this.init();

    if (this.rebuildTask && !this.rebuildTask.finished) {
      this.rebuildTask.abortRequested = true;
    }

    syncFilesFromDisk();
    const totalFiles = listMarkdownFiles().length;
    const generation = createGeneration({
      kind: options.kind || 'manual_rebuild',
      state: 'queued',
      configSnapshot: options.configSnapshot || buildEmbeddingConfig(),
      totalFiles,
      progress: {
        stage: 'queued',
        current: 0,
        total: totalFiles,
        currentFile: '',
        dirty_files: 0,
      },
    });

    this.rebuildTask = {
      generationId: generation.id,
      abortRequested: false,
      finished: false,
    };

    setImmediate(() => {
      this.runRebuild(generation.id, this.rebuildTask).catch((error) => {
        logger.error('index_coordinator.rebuild_failed', { generation_id: generation.id, error });
      });
    });

    return generation;
  }

  async runRebuild(generationId, task) {
    const generation = getGenerationById(generationId);
    if (!generation) return;

    try {
      syncFilesFromDisk();
      const paths = listMarkdownFiles();
      updateGeneration(generationId, {
        state: 'building',
        total_files: paths.length,
        processed_files: 0,
        error_summary: null,
      });
      updateGenerationProgress(generationId, {
        stage: 'building',
        current: 0,
        total: paths.length,
        currentFile: '',
        dirty_files: listGenerationDirtyFiles(generationId).length,
      });

      let processedCount = 0;
      for (const currentPath of paths) {
        if (task.abortRequested) {
          throw createAppError('REBUILD_ABORTED', '当前重建任务已被新的请求替代');
        }

        syncFilesFromDisk();
        const file = getFileByPath(currentPath);
        if (!file) continue;

        const existing = getGenerationFileResult(generationId, file.id);
        if (existing &&
          existing.content_hash === file.hash &&
          ['ready', 'degraded'].includes(existing.status)) {
          processedCount += 1;
          updateGeneration(generationId, { processed_files: processedCount });
          updateGenerationProgress(generationId, {
            stage: 'building',
            current: processedCount,
            total: paths.length,
            currentFile: currentPath,
            status: 'skipped',
            dirty_files: listGenerationDirtyFiles(generationId).length,
          });
          continue;
        }

        let result;
        try {
          result = await indexFileToGeneration({
            generation: getGenerationById(generationId),
            relativePath: currentPath,
            fileId: file.id,
          });
        } catch (error) {
          const normalized = ensureError(error, 'INDEX_FAILED', '索引失败');
          result = {
            status: 'failed',
            contentHash: file.hash || null,
            chunksCount: 0,
            textIndexed: 0,
            vectorIndexed: 0,
            imageVectorIndexed: 0,
            error: normalized.message,
          };
        }
        upsertGenerationFileResult(generationId, file, result);
        processedCount += 1;
        updateGeneration(generationId, { processed_files: processedCount });
        updateGenerationProgress(generationId, {
          stage: 'building',
          current: processedCount,
          total: paths.length,
          currentFile: currentPath,
          status: result.status,
          error: result.error || null,
          dirty_files: listGenerationDirtyFiles(generationId).length,
        });
      }

      await this.catchUpGeneration(generationId, task, paths.length);

      if (task.abortRequested) {
        throw createAppError('REBUILD_ABORTED', '当前重建任务已被新的请求替代');
      }

      updateGeneration(generationId, {
        state: 'validated',
        finished_at: new Date().toISOString(),
      });
      updateGenerationProgress(generationId, {
        stage: 'validated',
        current: paths.length,
        total: paths.length,
        currentFile: '',
        dirty_files: 0,
      });

      const active = activateGeneration(generationId);
      applyGenerationAsActiveFileStatus(active.id);
      updateGenerationProgress(generationId, {
        stage: 'activated',
        current: paths.length,
        total: paths.length,
        currentFile: '',
        dirty_files: 0,
      }, {
        state: 'active',
        activated_at: new Date().toISOString(),
      });
    } catch (error) {
      const normalized = ensureError(error, 'REBUILD_FAILED', '索引重建失败');
      markGenerationFailed(generationId, normalized);
      logger.error('index_coordinator.run_rebuild_failed', {
        generation_id: generationId,
        error: normalized,
      });
    } finally {
      task.finished = true;
      if (this.rebuildTask?.generationId === generationId) {
        this.rebuildTask.finished = true;
      }
    }
  }

  async catchUpGeneration(generationId, task, totalFiles) {
    while (true) {
      if (task.abortRequested) {
        throw createAppError('REBUILD_ABORTED', '当前重建任务已被新的请求替代');
      }

      const dirtyRows = listGenerationDirtyFiles(generationId);
      if (!dirtyRows.length) return;

      updateGeneration(generationId, { state: 'catching_up' });
      updateGenerationProgress(generationId, {
        stage: 'catching_up',
        current: totalFiles,
        total: totalFiles,
        currentFile: '',
        dirty_files: dirtyRows.length,
      });

      for (const dirty of dirtyRows) {
        if (task.abortRequested) {
          throw createAppError('REBUILD_ABORTED', '当前重建任务已被新的请求替代');
        }

        syncFilesFromDisk();
        const file = getFileByPath(dirty.path);
        if (file) {
          let result;
          try {
            result = await indexFileToGeneration({
              generation: getGenerationById(generationId),
              relativePath: file.path,
              fileId: file.id,
            });
          } catch (error) {
            const normalized = ensureError(error, 'INDEX_FAILED', '索引失败');
            result = {
              status: 'failed',
              contentHash: file.hash || null,
              chunksCount: 0,
              textIndexed: 0,
              vectorIndexed: 0,
              imageVectorIndexed: 0,
              error: normalized.message,
            };
          }
          upsertGenerationFileResult(generationId, file, result);
        } else if (dirty.file_id) {
          removeFileFromGeneration(
            getGenerationById(generationId),
            { fileId: dirty.file_id }
          );
          deleteGenerationFileResult(generationId, dirty.file_id);
        }
        clearGenerationDirtyFile(generationId, dirty.file_id);
        updateGenerationProgress(generationId, {
          stage: 'catching_up',
          current: totalFiles,
          total: totalFiles,
          currentFile: dirty.path,
          dirty_files: Math.max(listGenerationDirtyFiles(generationId).length, 0),
        });
      }
    }
  }
}

let singleton = null;

function getIndexCoordinator() {
  if (!singleton) singleton = new IndexCoordinator();
  return singleton;
}

module.exports = {
  IndexCoordinator,
  getIndexCoordinator,
};
