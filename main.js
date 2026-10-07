const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;
let serverModule = null;
let gracefulQuitStarted = false;
let allowWindowClose = false;

// 直接在主进程中启动服务器（不再 spawn 外部 node）
async function startServer() {
  process.env.ELECTRON_MODE = '1';
  process.env.SEMG_NO_AUTO_START = '1';
  serverModule = require(path.join(__dirname, 'server.js'));
  const server = await serverModule.startServer();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (process.env.PORT || 3000);
  return `http://localhost:${port}`;
}

// 创建 Electron 窗口
async function createWindow() {
  try {
    // 等待服务完全启动，获取访问地址
    const serverUrl = await startServer();
    console.log('服务启动成功，地址：', serverUrl);

    // 创建窗口
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false
      }
    });

    // 加载服务地址
    mainWindow.loadURL(serverUrl);

    // 确保窗口获得焦点（修复偶发输入框无法键入问题）
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.focus();
    });

    // 窗口关闭时的处理
    mainWindow.on('close', event => {
      if (!allowWindowClose) {
        event.preventDefault();
        app.quit();
      }
    });
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  } catch (error) {
    console.error('启动失败：', error.message);
    app.quit();
  }
}

// 应用就绪后启动
app.on('ready', createWindow);

// 所有窗口关闭时退出
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// macOS 激活时重建窗口
app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// 应用退出前先让服务优雅关闭，确保 H5 文件完成 close
app.on('before-quit', async (event) => {
  if (allowWindowClose) return;
  event.preventDefault();
  if (gracefulQuitStarted) return;
  gracefulQuitStarted = true;

  console.log('[Main] 应用即将退出，先优雅关闭采集服务...');
  let timeoutId;
  try {
    const timeout = new Promise((resolve) => { timeoutId = setTimeout(resolve, 300000); });
    const shutdown = serverModule && typeof serverModule.shutdown === 'function'
      ? serverModule.shutdown('electron-before-quit')
      : Promise.resolve();
    const completed = await Promise.race([shutdown.then(() => true), timeout.then(() => false)]);
    clearTimeout(timeoutId);
    if (!completed) {
      gracefulQuitStarted = false;
      console.error('[Main] 优雅关闭超时，保留服务以便恢复');
      return;
    }
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('[Main] 优雅关闭采集服务失败:', error);
    gracefulQuitStarted = false;
    return;
  }

  allowWindowClose = true;
  app.quit();
});

// 捕获未处理的异常，确保清理
process.on('uncaughtException', (error) => {
  console.error('[Main] 未捕获的异常:', error);
  // Keep the process tree available for recovery; service-process owns only its children.
});

// 捕获 SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  console.log('[Main] 收到 SIGINT 信号');
  app.quit();
});
