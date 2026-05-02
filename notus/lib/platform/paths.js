const path = require('path');
const { inferRuntimeTarget } = require('./target');

function absolutePath(value, fallback, cwd = process.cwd()) {
  const target = value || fallback;
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
}

function buildDefaultLayout(runtimeTarget, cwd = process.cwd()) {
  if (runtimeTarget === 'electron') {
    const dataRoot = absolutePath(process.env.NOTUS_DATA_ROOT, path.join(cwd, '.notus-desktop-data'), cwd);
    return {
      dataRoot,
      notesDir: path.join(dataRoot, 'notes'),
      assetsDir: path.join(dataRoot, 'assets'),
      dbPath: path.join(dataRoot, 'data', 'index.db'),
      logDir: path.join(dataRoot, 'logs'),
      sessionDir: path.join(dataRoot, 'session'),
    };
  }

  if (runtimeTarget === 'lazycat') {
    const dataRoot = '/lzcapp/var/notus';
    return {
      dataRoot,
      notesDir: '/lzcapp/var/notes',
      assetsDir: '/lzcapp/var/assets',
      dbPath: '/lzcapp/var/data/index.db',
      logDir: '/lzcapp/var/logs',
      sessionDir: '/lzcapp/cache/notus/session',
    };
  }

  const dataRoot = absolutePath(process.env.NOTUS_DATA_ROOT, cwd, cwd);
  return {
    dataRoot,
    notesDir: path.join(dataRoot, 'notes'),
    assetsDir: path.join(dataRoot, 'notes', '.assets'),
    dbPath: path.join(dataRoot, 'notus.db'),
    logDir: path.join(dataRoot, 'logs'),
    sessionDir: path.join(dataRoot, '.session'),
  };
}

function derivePathsFromDataRoot(runtimeTarget, dataRoot) {
  if (runtimeTarget === 'web') {
    return {
      notesDir: path.join(dataRoot, 'notes'),
      assetsDir: path.join(dataRoot, 'notes', '.assets'),
      dbPath: path.join(dataRoot, 'notus.db'),
      logDir: path.join(dataRoot, 'logs'),
      sessionDir: path.join(dataRoot, '.session'),
    };
  }

  if (runtimeTarget === 'lazycat') {
    return {
      notesDir: path.join(dataRoot, 'notes'),
      assetsDir: path.join(dataRoot, 'assets'),
      dbPath: path.join(dataRoot, 'data', 'index.db'),
      logDir: path.join(dataRoot, 'logs'),
      sessionDir: '/lzcapp/cache/notus/session',
    };
  }

  return {
    notesDir: path.join(dataRoot, 'notes'),
    assetsDir: path.join(dataRoot, 'assets'),
    dbPath: path.join(dataRoot, 'data', 'index.db'),
    logDir: path.join(dataRoot, 'logs'),
    sessionDir: path.join(dataRoot, 'session'),
  };
}

function resolvePlatformPaths(env = process.env, options = {}) {
  const cwd = options.cwd || process.cwd();
  const runtimeTarget = options.runtimeTarget || inferRuntimeTarget(env);
  const defaults = buildDefaultLayout(runtimeTarget, cwd);
  const dataRoot = absolutePath(env.NOTUS_DATA_ROOT, defaults.dataRoot, cwd);
  const derived = derivePathsFromDataRoot(runtimeTarget, dataRoot);

  return {
    runtimeTarget,
    dataRoot,
    notesDir: absolutePath(env.NOTES_DIR, derived.notesDir, cwd),
    assetsDir: absolutePath(env.ASSETS_DIR, derived.assetsDir, cwd),
    dbPath: absolutePath(env.DB_PATH, derived.dbPath, cwd),
    logDir: absolutePath(env.LOG_DIR, derived.logDir, cwd),
    sessionDir: absolutePath(env.SESSION_DIR, derived.sessionDir, cwd),
  };
}

module.exports = {
  absolutePath,
  buildDefaultLayout,
  derivePathsFromDataRoot,
  resolvePlatformPaths,
};
