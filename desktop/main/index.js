const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, Menu, dialog, globalShortcut, ipcMain, shell } = require('electron');
const { collectMarkdownEntries } = require('../shared/imports');
const { buildManagedPaths, getManagedDataRoot } = require('../shared/paths');

const isDev = !app.isPackaged || process.env.NOTUS_DESKTOP_DEV === '1';
const managedPaths = buildManagedPaths(getManagedDataRoot(app));

let mainWindow = null;
let serverProcess = null;
let cleanupOnQuit = false;
let cleanupCompleted = false;
let serverBaseUrl = process.env.NOTUS_DESKTOP_DEV_URL || 'http://127.0.0.1:3000';

app.setName('Notus');
app.setPath('userData', managedPaths.dataRoot);
app.setPath('sessionData', managedPaths.sessionDir);
app.setAppLogsPath(managedPaths.logDir);

function getDesktopProfile() {
  return {
    runtimeTarget: 'electron',
    storageMode: 'managed',
    dataRoot: managedPaths.dataRoot,
    notesDir: managedPaths.notesDir,
    assetsDir: managedPaths.assetsDir,
    dbPath: managedPaths.dbPath,
    logDir: managedPaths.logDir,
    sessionDir: managedPaths.sessionDir,
    canAutoPurgeOnUninstall: process.platform === 'win32',
    capabilities: {
      supportsDesktopShell: true,
      supportsAutoPurgeOnUninstall: process.platform === 'win32',
      supportsManualDataWipe: true,
      supportsExternalNotesBinding: false,
      usesManagedWorkspace: true,
      supportsNativeOpenDialog: true,
    },
  };
}

async function ensureManagedDirectories() {
  await Promise.all([
    fs.promises.mkdir(managedPaths.notesDir, { recursive: true }),
    fs.promises.mkdir(managedPaths.assetsDir, { recursive: true }),
    fs.promises.mkdir(path.dirname(managedPaths.dbPath), { recursive: true }),
    fs.promises.mkdir(managedPaths.logDir, { recursive: true }),
    fs.promises.mkdir(managedPaths.sessionDir, { recursive: true }),
  ]);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 3000;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 20000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error('本地 Notus 服务启动超时');
}

async function startServerIfNeeded() {
  if (isDev) {
    await waitForServer(serverBaseUrl);
    return serverBaseUrl;
  }

  const port = await findFreePort();
  const serverScript = path.join(process.resourcesPath, 'notus', 'server.js');
  serverBaseUrl = `http://127.0.0.1:${port}`;

  serverProcess = spawn(process.execPath, [serverScript], {
    cwd: path.join(process.resourcesPath, 'notus'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      NOTUS_RUNTIME_TARGET: 'electron',
      NOTUS_DATA_ROOT: managedPaths.dataRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[notus] ${chunk}`);
  });
  serverProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[notus] ${chunk}`);
  });
  serverProcess.on('exit', () => {
    serverProcess = null;
  });

  await waitForServer(serverBaseUrl);
  return serverBaseUrl;
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) {
      resolve();
      return;
    }

    const target = serverProcess;
    const timer = setTimeout(() => {
      try {
        target.kill('SIGKILL');
      } catch {}
    }, 3000);

    target.once('exit', () => {
      clearTimeout(timer);
      if (serverProcess === target) {
        serverProcess = null;
      }
      resolve();
    });

    try {
      target.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function wipeManagedData() {
  await stopServer();
  await fs.promises.rm(managedPaths.dataRoot, { recursive: true, force: true });
}

async function createWindow() {
  const baseUrl = await startServerIfNeeded();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#F7F2E8',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const expectedOrigin = new URL(baseUrl).origin;
    if (!url.startsWith(expectedOrigin)) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  await mainWindow.loadURL(baseUrl);
}

function requestGlobalSearchOpen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:open-global-search');
}

async function focusMainWindowAndOpenSearch() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  app.focus();
  mainWindow.focus();

  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(requestGlobalSearchOpen, 80);
    });
    return;
  }

  setTimeout(requestGlobalSearchOpen, 80);
}

function registerGlobalShortcuts() {
  const registered = globalShortcut.register('CommandOrControl+K', () => {
    focusMainWindowAndOpenSearch().catch((error) => {
      console.error('failed to open global search', error);
    });
  });

  if (!registered) {
    console.warn('failed to register desktop global shortcut CommandOrControl+K');
  }
}

function buildAppMenu() {
  const template = [
    {
      label: 'Notus',
      submenu: [
        {
          label: '打开数据目录',
          click: () => {
            shell.openPath(managedPaths.dataRoot).catch(() => {});
          },
        },
        {
          label: '清除本机数据并退出',
          click: () => {
            cleanupOnQuit = true;
            setImmediate(() => app.quit());
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: '窗口',
      submenu: [{ role: 'reload' }, { role: 'toggledevtools' }, { role: 'minimize' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('desktop:get-profile', async () => getDesktopProfile());

ipcMain.handle('desktop:pick-import-source', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled) return [];
  return collectMarkdownEntries(result.filePaths);
});

ipcMain.handle('desktop:open-data-directory', async () => {
  const output = await shell.openPath(managedPaths.dataRoot);
  return output ? { ok: false, error: output } : { ok: true };
});

ipcMain.handle('desktop:clear-local-data-and-quit', async () => {
  cleanupOnQuit = true;
  setImmediate(() => app.quit());
  return { ok: true };
});

app.whenReady().then(async () => {
  await ensureManagedDirectories();
  registerGlobalShortcuts();
  buildAppMenu();
  await createWindow();
});

app.on('before-quit', async (event) => {
  if (!cleanupOnQuit || cleanupCompleted) return;
  event.preventDefault();
  cleanupCompleted = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  try {
    await wipeManagedData();
  } catch (error) {
    console.error('failed to wipe managed data', error);
  }
  app.exit(0);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch(() => {});
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopServer().catch(() => {});
});
