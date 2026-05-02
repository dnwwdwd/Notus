const path = require('path');

function getManagedDataRoot(app) {
  return path.join(app.getPath('appData'), 'Notus');
}

function buildManagedPaths(dataRoot) {
  return {
    dataRoot,
    notesDir: path.join(dataRoot, 'notes'),
    assetsDir: path.join(dataRoot, 'assets'),
    dbPath: path.join(dataRoot, 'data', 'index.db'),
    logDir: path.join(dataRoot, 'logs'),
    sessionDir: path.join(dataRoot, 'session'),
  };
}

module.exports = {
  buildManagedPaths,
  getManagedDataRoot,
};
