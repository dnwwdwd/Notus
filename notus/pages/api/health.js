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
    capabilities: {
      runtime: Boolean(runtime.ok),
      vector_search: Boolean(runtime.vecAvailable),
      storage_ready: Boolean(directoriesReady),
      tokenizer_ready: Boolean(getTokenizerStatus()?.jiebaLoaded),
      desktop_shell: Boolean(config.capabilities?.supportsDesktopShell),
      external_notes_binding: Boolean(config.capabilities?.supportsExternalNotesBinding),
    },
  });
}
