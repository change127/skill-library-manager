import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { navigationAllowed, resolveManagerRoot } from './config.mjs';

let runtime;
let mainWindow;
let shuttingDown = false;

async function loadDesktopRuntime() {
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const managerRoot = resolveManagerRoot({
    isPackaged: app.isPackaged,
    home: app.getPath('home'),
    moduleRoot,
  });
  const moduleUrl = pathToFileURL(path.join(managerRoot, 'desktop', 'runtime.mjs')).href;
  return import(moduleUrl);
}

async function createWindow() {
  const { startDesktopRuntime } = await loadDesktopRuntime();
  runtime = await startDesktopRuntime();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Skill 管理器',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = undefined; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!navigationAllowed(url, runtime.url)) event.preventDefault();
  });
  await mainWindow.loadURL(runtime.url);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(createWindow).catch((error) => {
    dialog.showErrorBox('Skill 管理器启动失败', error.message);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', (event) => {
  if (!runtime || shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  runtime.close().finally(() => {
    runtime = undefined;
    app.quit();
  });
});
