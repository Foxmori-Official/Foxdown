const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

app.setName('Foxdown');

const port = Number(process.env.FOXDOWN_PORT) || 16801;
const appUrl = `http://127.0.0.1:${port}`;
const root = app.getAppPath();
const runtime = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : root;
const logo = path.join(root, 'web', 'public', 'logo.png');
const setupFile = path.join(__dirname, 'setup.html');
const setupUrl = pathToFileURL(setupFile).href;
const dataDir = process.env.DATA_DIR || path.join(app.getPath('userData'), 'data');
const downloadDir = process.env.DOWNLOAD_DIR || path.join(app.getPath('downloads'), 'Foxdown');
const binDir = process.env.FOXDOWN_BIN_DIR || process.env.KIMI_BIN_DIR
  || (app.isPackaged ? path.join(runtime, 'bin') : path.join(root, 'bin', (process.platform === 'darwin' ? 'mac' : 'win') + '-' + process.arch));

let mainWindow;
let tray;
let backend;
let startup;
let backendReady = false;
let isQuitting = false;
let setupState = { phase: 'checking' };
const pendingTasks = [];

function updateSetup(phase, detail = '') {
  setupState = { phase, detail, downloadDir };
  if (mainWindow?.webContents.getURL() === setupUrl) {
    mainWindow.webContents.send('setup-state', setupState);
  }
}

function openSetup() {
  return mainWindow.loadFile(setupFile);
}

function startServer() {
  return new Promise((resolve, reject) => {
    let ready = false;
    let failure = '';
    const child = spawn(process.execPath, [path.join(runtime, 'server', 'src', 'index.js')], {
      cwd: runtime,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        DATA_DIR: dataDir,
        FOXDOWN_DEFAULT_DOWNLOAD_DIR: downloadDir,
        FOXDOWN_BIN_DIR: binDir,
        FOXDOWN_HOST: '127.0.0.1',
        FOXDOWN_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    backend = child;
    child.stdout.on('data', data => console.log(String(data).trimEnd()));
    child.stderr.on('data', data => {
      failure = (failure + String(data)).slice(-1200);
      console.error(String(data).trimEnd());
    });
    const timeout = setTimeout(() => {
      child.send({ type: 'shutdown' }, () => {});
      reject(new Error('The local service did not become ready.'));
    }, 20000);
    child.on('message', message => {
      if (message?.type !== 'ready') return;
      ready = true;
      backendReady = true;
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', error => {
      clearTimeout(timeout);
      if (backend === child) backend = null;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (backend === child) backend = null;
      backendReady = false;
      const error = new Error(failure.trim() || `Local service exited (${code ?? signal}).`);
      if (!ready) reject(error);
      else if (!isQuitting) {
        updateSetup('error', error.message);
        void openSetup().catch(console.error);
      }
    });
  });
}

function launchBackend() {
  if (startup) return startup;
  startup = (async () => {
    try {
      const suffix = process.platform === 'win32' ? '.exe' : '';
      const mediaDir = process.platform === 'darwin' ? path.join(binDir, 'media/bin') : binDir;
      await fs.access(path.join(binDir, 'aria2c' + suffix));
      for (const name of ['ffmpeg', 'ffprobe']) await fs.access(path.join(mediaDir, name + suffix));
      if (isQuitting) return;

      if (!backendReady) {
        if (backend) throw new Error('The previous local service is still stopping. Try again.');
        updateSetup('starting');
        await startServer();
      }
      if (isQuitting) return;
      await mainWindow.loadURL(appUrl);
      for (const task of pendingTasks.splice(0)) void sendTask(task);
    } catch (error) {
      updateSetup('error', error.message);
      if (!isQuitting && mainWindow.webContents.getURL() !== setupUrl) await openSetup();
    } finally {
      startup = null;
    }
  })();
  return startup;
}

async function sendTask(body) {
  if (!backendReady) {
    pendingTasks.push(body);
    return;
  }
  try {
    let token = process.env.API_TOKEN;
    if (!token) {
      try { token = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).apiToken; }
      catch { /* The local API does not require a token by default. */ }
    }
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(appUrl + '/api/v1/tasks', {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    dialog.showErrorBox('Foxdown', `Could not add the download. ${error.message}`);
  }
}

function handleMagnet(url) {
  if (/^magnet:\?/i.test(url)) void sendTask({ url });
}

async function handleTorrent(file) {
  if (!/\.torrent$/i.test(file)) return;
  try {
    const data = await fs.readFile(file);
    await sendTask({ torrentBase64: data.toString('base64') });
  } catch (error) {
    dialog.showErrorBox('Foxdown', `Could not read the torrent file. ${error.message}`);
  }
}

function handleArgv(argv) {
  for (const arg of argv) {
    if (/^magnet:\?/i.test(arg)) handleMagnet(arg);
    else if (/\.torrent$/i.test(arg)) void handleTorrent(arg);
  }
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  const available = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1360, available.width - 24);
  const height = Math.min(900, available.height - 24);
  mainWindow = new BrowserWindow({
    width, height, minWidth: Math.min(1080, width), minHeight: Math.min(760, height),
    title: 'Foxdown', icon: logo,
    backgroundColor: '#faf9f4', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  mainWindow.on('close', event => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== setupUrl && new URL(url).origin !== appUrl) event.preventDefault();
  });
}

function allowSender(event, origin) {
  const frame = event.senderFrame;
  if (event.sender !== mainWindow?.webContents || !frame || frame.parent) throw new Error('Unexpected renderer');
  if (origin === setupUrl ? frame.url !== setupUrl : new URL(frame.url).origin !== origin) {
    throw new Error('Unexpected renderer location');
  }
}

ipcMain.handle('setup-state', event => {
  allowSender(event, setupUrl);
  return { ...setupState, downloadDir };
});
ipcMain.handle('setup-retry', event => {
  allowSender(event, setupUrl);
  return launchBackend();
});
ipcMain.handle('get-login-item', event => {
  allowSender(event, appUrl);
  return { openAtLogin: app.getLoginItemSettings().openAtLogin };
});
ipcMain.handle('set-login-item', (event, value) => {
  allowSender(event, appUrl);
  app.setLoginItemSettings({ openAtLogin: Boolean(value) });
  return { openAtLogin: app.getLoginItemSettings().openAtLogin };
});

async function choosePath(event, defaultPath, properties) {
  allowSender(event, appUrl);
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: typeof defaultPath === 'string' && defaultPath.trim() ? defaultPath : downloadDir,
    properties,
  });
  return result.canceled ? null : result.filePaths[0] || null;
}
ipcMain.handle('select-directory', (event, defaultPath) =>
  choosePath(event, defaultPath, ['openDirectory', 'createDirectory']));
ipcMain.handle('select-file', (event, defaultPath) =>
  choosePath(event, defaultPath, ['openFile']));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => { showWindow(); handleArgv(argv); });
  app.on('open-url', (event, url) => { event.preventDefault(); showWindow(); handleMagnet(url); });
  app.on('open-file', (event, file) => { event.preventDefault(); showWindow(); void handleTorrent(file); });
  app.on('activate', showWindow);

  app.whenReady().then(async () => {
    const chinese = app.getLocale().startsWith('zh');
    createWindow();
    tray = new Tray(nativeImage.createFromPath(logo).resize({ width: 20, height: 20 }));
    tray.setToolTip('Foxdown');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: chinese ? '显示 Foxdown' : 'Show Foxdown', click: showWindow },
      { role: 'quit', label: chinese ? '退出 Foxdown' : 'Quit Foxdown' },
    ]));
    tray.on('click', showWindow);
    handleArgv(process.argv.slice(app.isPackaged ? 1 : 2));
    await openSetup();
    void launchBackend();
  }).catch(error => dialog.showErrorBox('Foxdown', error.message));

  app.on('before-quit', event => {
    if (!backend) { isQuitting = true; return; }
    event.preventDefault();
    if (isQuitting) return;
    isQuitting = true;
    const child = backend;
    const timeout = setTimeout(() => child.kill(), 6000);
    child.once('exit', () => { clearTimeout(timeout); app.quit(); });
    child.send({ type: 'shutdown' }, () => {});
  });
}
