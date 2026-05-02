const fs = require('fs');
const { getRuntimeStatus } = require('../../lib/runtime');
const { readEnvConfig } = require('../../lib/config');
const { getTokenizerStatus } = require('../../lib/tokenizer');
const { version: appVersion } = require('../../package.json');

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const config = readEnvConfig();
  const runtime = getRuntimeStatus();
  const directoriesReady = [config.notesDir, config.assetsDir].every((dir) => fs.existsSync(dir));
  const ok = runtime.ok && runtime.vecAvailable && directoriesReady;

  return res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'error',
    version: appVersion,
    runtime_target: config.runtimeTarget,
    data_root: config.dataRoot,
    storage_mode: config.storageMode,
    capabilities: config.capabilities,
    can_auto_purge_on_uninstall: config.canAutoPurgeOnUninstall,
    runtime: {
      ok: runtime.ok,
      vec_available: runtime.vecAvailable,
      error: runtime.error,
    },
    tokenizer: getTokenizerStatus(),
    directories: {
      notes_dir: config.notesDir,
      assets_dir: config.assetsDir,
      db_path: config.dbPath,
      log_dir: config.logDir,
      ready: directoriesReady,
    },
  });
}
