const path = require('path');
const { getEffectiveConfig } = require('./config');

let watcher = null;
let chokidarModulePromise = null;

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
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 1500,
      pollInterval: 500,
    },
  });

  watcher
    .on('add', (filePath) => {
      if (/\.md$/i.test(filePath) && onAdd) onAdd(filePath);
    })
    .on('change', (filePath) => {
      if (/\.md$/i.test(filePath) && onChange) onChange(filePath);
    })
    .on('unlink', (filePath) => {
      if (/\.md$/i.test(filePath) && onRemove) {
        onRemove(path.relative(config.notesDir, filePath).replace(/\\/g, '/'));
      }
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
