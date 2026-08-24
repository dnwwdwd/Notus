const path = require('path');
const { getEffectiveConfig } = require('./config');
const { getDb } = require('./db');
const { readMarkdownFile } = require('./files');
const { parseFrontmatter } = require('./markdownMeta');

let watcher = null;
let chokidarModulePromise = null;
const fileQueues = new Map();
const removeTimers = new Map();

function normalizeRelative(config, filePath) {
  return path.relative(config.notesDir, filePath).replace(/\\/g, '/');
}

function enqueueFileTask(key, task) {
  const previous = fileQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .catch((error) => {
      console.error('[watcher] task failed:', error);
    })
    .finally(() => {
      if (fileQueues.get(key) === next) fileQueues.delete(key);
    });
  fileQueues.set(key, next);
  return next;
}

function cancelPendingRemove(relativePath) {
  const timer = removeTimers.get(relativePath);
  if (!timer) return;
  clearTimeout(timer);
  removeTimers.delete(relativePath);
}

function maybeUpdatePathByStableId(relativePath) {
  try {
    const frontmatterId = String(parseFrontmatter(readMarkdownFile(relativePath)).data.id || '').trim();
    if (!frontmatterId) return false;
    const db = getDb();
    const existing = db.prepare(`
      SELECT id, path
      FROM files
      WHERE stable_id = ?
        AND path != ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(frontmatterId, relativePath);
    if (!existing) return false;
    cancelPendingRemove(existing.path);
    db.prepare(`
      UPDATE files
      SET path = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(relativePath, existing.id);
    return true;
  } catch {
    return false;
  }
}

async function loadChokidar() {
  if (!chokidarModulePromise) {
    chokidarModulePromise = import('chokidar').then((module) => module.default || module);
  }
  return chokidarModulePromise;
}

async function startWatcher({ onAdd, onChange, onRemove } = {}) {
  if (watcher) return watcher;

  const config = getEffectiveConfig();
  const chokidar = await loadChokidar();
  watcher = chokidar.watch(config.notesDir, {
    ignored: /(^|[/\\])\../,
    persistent: true,
    usePolling: true,
    interval: 3000,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 1500,
      pollInterval: 500,
    },
  });

  watcher
    .on('add', (filePath) => {
      if (!/\.md$/i.test(filePath) || !onAdd) return;
      const relativePath = normalizeRelative(config, filePath);
      cancelPendingRemove(relativePath);
      enqueueFileTask(relativePath, async () => {
        maybeUpdatePathByStableId(relativePath);
        await onAdd(filePath);
      });
    })
    .on('change', (filePath) => {
      if (!/\.md$/i.test(filePath) || !onChange) return;
      const relativePath = normalizeRelative(config, filePath);
      cancelPendingRemove(relativePath);
      enqueueFileTask(relativePath, () => onChange(filePath));
    })
    .on('unlink', (filePath) => {
      if (!/\.md$/i.test(filePath) || !onRemove) return;
      const relativePath = normalizeRelative(config, filePath);
      cancelPendingRemove(relativePath);
      const timer = setTimeout(() => {
        removeTimers.delete(relativePath);
        enqueueFileTask(relativePath, () => onRemove(relativePath));
      }, 3000);
      removeTimers.set(relativePath, timer);
    })
    .on('error', (error) => {
      console.error('[watcher] error:', error);
    });

  return watcher;
}

function stopWatcher() {
  if (!watcher) return Promise.resolve();
  const closing = watcher.close();
  watcher = null;
  return closing;
}

module.exports = {
  startWatcher,
  stopWatcher,
};
