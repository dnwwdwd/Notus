function getDesktopBridge() {
  if (typeof window === 'undefined') return null;
  return window.notusDesktop || null;
}

function mapSettingsToProfile(settings = {}) {
  return {
    runtimeTarget: settings.runtimeTarget || settings.runtime_target || 'web',
    storageMode: settings.storageMode || settings.storage_mode || 'external',
    dataRoot: settings.dataRoot || settings.data_root || '',
    notesDir: settings.notesDir || settings.notes_dir || '',
    assetsDir: settings.assetsDir || settings.assets_dir || '',
    dbPath: settings.dbPath || settings.db_path || '',
    logDir: settings.logDir || settings.log_dir || '',
    sessionDir: settings.sessionDir || settings.session_dir || '',
    canAutoPurgeOnUninstall: Boolean(
      settings.canAutoPurgeOnUninstall ?? settings.can_auto_purge_on_uninstall
    ),
    capabilities: settings.capabilities || {},
  };
}

async function fetchSettings() {
  const response = await fetch('/api/settings', { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || '读取平台信息失败');
  }
  return payload;
}

export async function getProfile() {
  const bridge = getDesktopBridge();
  if (bridge?.getProfile) {
    return mapSettingsToProfile(await bridge.getProfile());
  }
  const settings = await fetchSettings();
  return mapSettingsToProfile(settings);
}

export async function getCapabilities() {
  const profile = await getProfile();
  return profile.capabilities;
}

export const desktop = {
  available() {
    return Boolean(getDesktopBridge());
  },

  onOpenGlobalSearch(listener) {
    const bridge = getDesktopBridge();
    if (!bridge?.onOpenGlobalSearch || typeof listener !== 'function') {
      return () => {};
    }
    const unsubscribe = bridge.onOpenGlobalSearch(() => {
      listener();
    });
    return typeof unsubscribe === 'function' ? unsubscribe : () => {};
  },

  async pickImportSource() {
    const bridge = getDesktopBridge();
    if (!bridge?.pickImportSource) {
      return [];
    }
    const entries = await bridge.pickImportSource();
    return (entries || []).map((entry) => ({
      ...entry,
      webkitRelativePath: entry.relativePath || entry.webkitRelativePath || entry.name,
      async text() {
        return entry.content || '';
      },
    }));
  },

  async clearLocalDataAndQuit() {
    const bridge = getDesktopBridge();
    if (!bridge?.clearLocalDataAndQuit) {
      return { ok: false, unavailable: true };
    }
    return bridge.clearLocalDataAndQuit();
  },

  async getProfile() {
    const bridge = getDesktopBridge();
    if (!bridge?.getProfile) {
      return null;
    }
    return mapSettingsToProfile(await bridge.getProfile());
  },

  async openDataDirectory() {
    const bridge = getDesktopBridge();
    if (!bridge?.openDataDirectory) {
      return { ok: false, unavailable: true };
    }
    return bridge.openDataDirectory();
  },
};

export function isDesktopBridgeAvailable() {
  return desktop.available();
}

export function profileFromSettings(settings) {
  return mapSettingsToProfile(settings);
}
