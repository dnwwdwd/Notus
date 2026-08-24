const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, Menu, Tray, nativeImage, Notification, dialog, globalShortcut, ipcMain, shell, safeStorage } = require('electron');
const { collectMarkdownEntries } = require('../shared/imports');
const { buildManagedPaths, getManagedDataRoot } = require('../shared/paths');

const isDev = !app.isPackaged || process.env.NOTUS_DESKTOP_DEV === '1';
const managedPaths = buildManagedPaths(getManagedDataRoot(app));

let mainWindow = null;
let serverProcess = null;
let cleanupOnQuit = false;
let cleanupCompleted = false;
let serverBaseUrl = process.env.NOTUS_DESKTOP_DEV_URL || 'http://127.0.0.1:3000';
let secretBridgeServer = null;
let secretBridgeUrl = '';
let secretBridgeToken = '';
let tray = null;
let explicitQuit = false;

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

function secretBridgeStorePath() {
  return path.join(managedPaths.dataRoot, 'secrets', 'electron-safe-storage.json');
}

function readSecretBridgeStore() {
  const file = secretBridgeStorePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeSecretBridgeStore(store) {
  const file = secretBridgeStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
}

function sendSecretBridgeJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readSecretBridgeBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('请求格式错误')); }
    });
    req.on('error', reject);
  });
}

async function startSecretBridge() {
  if (secretBridgeServer || !safeStorage.isEncryptionAvailable()) return;
  secretBridgeToken = crypto.randomBytes(32).toString('hex');
  secretBridgeServer = http.createServer(async (req, res) => {
    const suppliedToken = String(req.headers['x-notus-secret-token'] || '');
    if (!suppliedToken || suppliedToken.length !== secretBridgeToken.length || !crypto.timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(secretBridgeToken))) {
      return sendSecretBridgeJson(res, 403, { error: '未授权的密钥请求' });
    }
    if (req.method !== 'POST') return sendSecretBridgeJson(res, 405, { error: '仅支持 POST' });
    const action = String(req.url || '').replace(/^\/+/, '').split('?')[0];
    try {
      const body = await readSecretBridgeBody(req);
      const store = readSecretBridgeStore();
      if (action === 'set') {
        const value = String(body.value || '');
        if (!value) return sendSecretBridgeJson(res, 400, { error: '密钥不能为空' });
        const id = crypto.randomUUID();
        store[id] = safeStorage.encryptString(value).toString('base64');
        writeSecretBridgeStore(store);
        return sendSecretBridgeJson(res, 200, { id });
      }
      if (action === 'get') {
        const encrypted = store[String(body.id || '')];
        if (!encrypted) return sendSecretBridgeJson(res, 404, { error: '密钥不存在' });
        return sendSecretBridgeJson(res, 200, { value: safeStorage.decryptString(Buffer.from(encrypted, 'base64')) });
      }
      if (action === 'delete') {
        delete store[String(body.id || '')];
        writeSecretBridgeStore(store);
        return sendSecretBridgeJson(res, 200, { ok: true });
      }
      return sendSecretBridgeJson(res, 404, { error: '未知操作' });
    } catch (error) { return sendSecretBridgeJson(res, 400, { error: error.message || '密钥服务失败' }); }
  });
  await new Promise((resolve, reject) => {
    secretBridgeServer.once('error', reject);
    secretBridgeServer.listen(0, '127.0.0.1', () => {
      const address = secretBridgeServer.address();
      secretBridgeUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

function stopSecretBridge() {
  return new Promise((resolve) => {
    if (!secretBridgeServer) return resolve();
    const target = secretBridgeServer;
    secretBridgeServer = null;
    secretBridgeUrl = '';
    secretBridgeToken = '';
    target.close(() => resolve());
  });
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
      ...(secretBridgeUrl ? { NOTUS_SECRET_BRIDGE_URL: secretBridgeUrl, NOTUS_SECRET_BRIDGE_TOKEN: secretBridgeToken } : {}),
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
    minWidth: 390,
    minHeight: 640,
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

  mainWindow.on('close', (event) => {
    // 关闭窗口等同于“收起到托盘”，本地 Next 服务与 Agent Worker 继续运行。
    if (!explicitQuit && !cleanupOnQuit) {
      event.preventDefault();
      mainWindow.hide();
    }
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

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return Promise.resolve();
}

function createTray() {
  if (tray) return;
  const iconPath = process.platform === 'darwin'
    ? path.join(__dirname, '..', 'build', 'icon.icns')
    : path.join(__dirname, '..', 'build', 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Notus Agent 正在后台运行');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Notus', click: () => showMainWindow().catch(() => {}) },
    { label: '任务概览', click: () => showMainWindow().then(() => mainWindow?.webContents.send('desktop:open-agent-tasks')).catch(() => {}) },
    { type: 'separator' },
    { label: '显式退出（保存后下次自动恢复）', click: () => { explicitQuit = true; app.quit(); } },
  ]));
  tray.on('click', () => showMainWindow().catch(() => {}));
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
        { label: '退出', accelerator: process.platform === 'darwin' ? 'Command+Q' : 'Ctrl+Q', click: () => { explicitQuit = true; app.quit(); } },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggledevtools' },
        { label: '最小化', role: 'minimize' },
      ],
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

ipcMain.handle('desktop:open-agent-directory', async () => {
  const agentDir = path.join(managedPaths.dataRoot, 'agent');
  await fs.promises.mkdir(agentDir, { recursive: true });
  const output = await shell.openPath(agentDir);
  return output ? { ok: false, error: output } : { ok: true };
});

ipcMain.handle('desktop:clear-local-data-and-quit', async () => {
  cleanupOnQuit = true;
  explicitQuit = true;
  setImmediate(() => app.quit());
  return { ok: true };
});

ipcMain.handle('desktop:notify-agent', async (_event, payload = {}) => {
  const title = String(payload.title || 'Notus Agent');
  const body = String(payload.body || '任务状态已更新');
  if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
  return { ok: true };
});

app.whenReady().then(async () => {
  await ensureManagedDirectories();
  await startSecretBridge();
  registerGlobalShortcuts();
  buildAppMenu();
  createTray();
  await createWindow();
});

app.on('before-quit', async (event) => {
  // Dock、系统菜单等所有“退出”路径都必须越过窗口隐藏逻辑，真正停止服务。
  explicitQuit = true;
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
  // 所有窗口关闭后仍保留托盘和后台 Worker；显式退出才停止服务。
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(() => {});
  else showMainWindow().catch(() => {});
});

app.on('will-quit', () => {
  explicitQuit = true;
  globalShortcut.unregisterAll();
  stopServer().catch(() => {});
  stopSecretBridge().catch(() => {});
});
