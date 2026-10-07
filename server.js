/*
server.js
负责启动采集模式的所有模块，包括（deviceSync, ble_server, realtimeEngine, taskManager, storage）
*/ 

// ===================== 路径管理（必须最先执行）=====================
const { PATHS, isPackaged } = require('./paths');

// ===================== 日志系统初始化 =====================
const { initLogger } = require('./logger');
const logger = initLogger({
    logDir: PATHS.log,               // 使用统一的日志目录
    maxFileSize: 20 * 1024 * 1024,   // 20MB
    maxFiles: 10,                     // 最多保留 10 个日志文件
    filePrefix: 'server'              // 日志文件前缀
});

// ===================== 其他模块引入 =====================
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const app = express();
const PORT = process.env.PORT || 3000;
let httpServer = null;
let isShuttingDown = false;
let shutdownPromise = null;

// 引入设备协同模块
const deviceSync = require('./deviceSync');

// 引入实时引擎模块
const realtimeEngine = require('./realtimeEngine');

// 引入数据存储模块
const dataStorage = require('./dataStorage');

// 【新增】Python 环境配置（与 deviceSync 一致）
const { getPythonCommand } = require('./pythonPath');
const { ManagedProcess } = require('./lib/service-process');
const PYTHON_ENV = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
};

// 【新增】Camera Server 进程管理
let cameraServerProcess = null;
const CAMERA_SERVER_SCRIPT = 'camera_server';
let startPromise = null;
let storageFilesCache = null;
let storageFilesPromise = null;
const STORAGE_FILES_CACHE_MS = 500;


// 中间件配置， 用于给前端获取数据的接口
app.use(cors());
app.use(express.json());
app.use(express.static(PATHS.public));


// ===================== Storage 文件列表 API =====================
async function listStorageFiles() {
    const storageDir = PATHS.storage;
    const files = [];
    async function readDirRecursive(dir, relativePath = '') {
        let items;
        try { items = await fsp.readdir(dir, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        await Promise.all(items.map(async item => {
            // Do not follow symlinks: storage traversal is bounded to PATHS.storage.
            if (item.isSymbolicLink()) return;
            const fullPath = path.join(dir, item.name);
            const relPath = relativePath ? `${relativePath}/${item.name}` : item.name;
            if (item.isDirectory()) {
                await readDirRecursive(fullPath, relPath);
            } else if (item.isFile() && /\.(?:h5|hdf5)$/i.test(item.name)) {
                const stat = await fsp.stat(fullPath);
                files.push({ name: item.name, path: relPath, size: stat.size, lastModified: stat.mtimeMs });
            }
        }));
    }
    await readDirRecursive(storageDir);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
}

function getStorageFilesCached() {
    const now = Date.now();
    if (storageFilesCache && now - storageFilesCache.at < STORAGE_FILES_CACHE_MS) return Promise.resolve(storageFilesCache.files);
    if (!storageFilesPromise) {
        storageFilesPromise = listStorageFiles().then(files => {
            storageFilesCache = { at: Date.now(), files };
            return files;
        }).finally(() => { storageFilesPromise = null; });
    }
    return storageFilesPromise;
}

app.get('/api/storage/files', async (req, res) => {
    try {
        const files = await getStorageFilesCached();
        res.json({ success: true, files, count: files.length });
    } catch (error) {
        res.json({ success: false, error: error.message, files: [] });
    }
});

// ===================== Config 配置文件列表 API =====================
app.get('/api/config/files', (req, res) => {
    const configDir = PATHS.config;
    
    if (!fs.existsSync(configDir)) {
        return res.json({ success: false, error: 'config 目录不存在', files: [] });
    }

    try {
        const items = fs.readdirSync(configDir);
        const files = items
            .filter(item => item.endsWith('.json'))
            .map(item => {
                const fullPath = path.join(configDir, item);
                const stat = fs.statSync(fullPath);
                return {
                    name: item,
                    size: stat.size,
                    lastModified: stat.mtimeMs
                };
            });
        
        res.json({ success: true, files: files, count: files.length });
    } catch (err) {
        res.json({ success: false, error: err.message, files: [] });
    }
});

// ===================== 读取单个配置文件内容 API =====================
app.get('/api/config/load/:filename', (req, res) => {
    const { filename } = req.params;
    const configPath = path.join(PATHS.config, filename);
    
    // 安全检查：防止路径遍历攻击
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.json({ success: false, error: '无效的文件名' });
    }
    
    if (!fs.existsSync(configPath)) {
        return res.json({ success: false, error: '配置文件不存在' });
    }

    try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        res.json({ success: true, config: config, filename: filename });
    } catch (err) {
        res.json({ success: false, error: '读取配置文件失败: ' + err.message });
    }
});

// ===================== 保存配置文件 API =====================
app.post('/api/config/save', (req, res) => {
    const { filename, config } = req.body;
    
    if (!filename || !config) {
        return res.json({ success: false, error: '缺少文件名或配置内容' });
    }
    
    // 安全检查：防止路径遍历攻击
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.json({ success: false, error: '无效的文件名' });
    }
    
    // 确保文件名以.json结尾
    const safeFilename = filename.endsWith('.json') ? filename : filename + '.json';
    const configPath = path.join(PATHS.config, safeFilename);
    
    // 确保config目录存在
    if (!fs.existsSync(PATHS.config)) {
        try {
            fs.mkdirSync(PATHS.config, { recursive: true });
        } catch (err) {
            return res.json({ success: false, error: '创建配置目录失败: ' + err.message });
        }
    }
    
    try {
        const content = JSON.stringify(config, null, 2);
        fs.writeFileSync(configPath, content, 'utf-8');
        console.log(`[server.js] 配置文件已保存: ${safeFilename}`);
        res.json({ success: true, filename: safeFilename, message: '配置保存成功' });
    } catch (err) {
        res.json({ success: false, error: '保存配置文件失败: ' + err.message });
    }
});

// ===================== 删除配置文件 API =====================
app.delete('/api/config/delete/:filename', (req, res) => {
    const { filename } = req.params;
    
    // 安全检查：防止路径遍历攻击
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.json({ success: false, error: '无效的文件名' });
    }
    
    const configPath = path.join(PATHS.config, filename);
    
    if (!fs.existsSync(configPath)) {
        return res.json({ success: false, error: '配置文件不存在' });
    }
    
    try {
        fs.unlinkSync(configPath);
        console.log(`[server.js] 配置文件已删除: ${filename}`);
        res.json({ success: true, message: '配置删除成功' });
    } catch (err) {
        res.json({ success: false, error: '删除配置文件失败: ' + err.message });
    }
});

// API路由 - 获取设备状态
app.get('/api/device-status', (req, res) => {
    // 获取设备协同模块状态
    const syncStatus = deviceSync.getStatus();
    
    // 设备协同模块提供的传输数据量
    const throughput = (deviceSync.getCurrentThroughput()/1000).toFixed(4);
    const throughputPercent = throughput/10;

    res.json({
        // 添加设备协同模块状态
        deviceSync: {
            connected: syncStatus.isConnected,
            dataPackets: syncStatus.dataCount,
            dataRate: syncStatus.currentRate.toFixed(2),
            lastTimestamp: syncStatus.lastTimestamp,
            emgData: syncStatus.emgData || Array(16).fill(0)
        }
    });
});


// 存储空间状态
app.get('/api/storage-volume', (req, res) => {
    (async () => {
        // 接收函数返回值（核心赋值语句）
        const diskInfo = await deviceSync.getStorageVolumeInfo();

        // 判断是否获取成功
        if (typeof diskInfo === 'object' && diskInfo !== null) {
            // 直接赋值使用
            const freeGB = diskInfo.freeGB;
            const freePercent = diskInfo.freePercent;

            res.json({
                storage: {
                    free_Percent: freePercent,
                    volume: freeGB
                }
            });
        } else {
            // 打印错误信息
            //console.log(diskInfo);
            res.json({
                storage: {
                    free_Percent: 0,
                    volume: 0
                }
            });
        }
    })();
});

// ===================== 摄像头管理 API（降级/兼容路由） =====================
// 注意：前端现在通过 camera_control.js 直连 camera_server WebSocket (:8768)
// 以下 HTTP 路由仅作为降级方案保留

// 枚举摄像头设备（降级）
app.get('/api/camera/list', async (req, res) => {
    try {
        const result = await realtimeEngine.sendCameraCommand('list_cameras', {});
        res.json(result);
    } catch (error) {
        console.error('[server.js] 枚举摄像头失败:', error);
        res.json({ success: false, error: error.message, devices: [] });
    }
});

// 设置摄像头配置（降级）
app.post('/api/camera/set-camera', async (req, res) => {
    try {
        const { side, device_name, device_id } = req.body;
        const result = await realtimeEngine.sendCameraCommand('set_camera', {
            side: side,
            device_name: device_name,
            device_id: device_id
        });
        res.json(result);
    } catch (error) {
        console.error('[server.js] 配置摄像头失败:', error);
        res.json({ success: false, error: error.message });
    }
});

// 获取预览帧（降级，前端优先使用WebSocket推送）
app.post('/api/camera/get-preview-frame', async (req, res) => {
    try {
        const { side } = req.body;
        const result = await realtimeEngine.sendCameraCommand('get_preview_frame', {
            side: side
        });
        res.json(result);
    } catch (error) {
        console.error('[server.js] 获取预览帧失败:', error);
        res.json({ success: false, error: error.message });
    }
});

// 获取摄像头状态（降级）
app.get('/api/camera/status', async (req, res) => {
    try {
        const result = await realtimeEngine.sendCameraCommand('get_status', {});
        res.json(result);
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});



app.get('/api/health', (req, res) => {
    let engine = {};
    try { engine = realtimeEngine.getStatus?.() || {}; } catch (error) { engine = { error: error.message }; }
    const ble = deviceSync.getStatus();
    const storage = dataStorage.getStatus();
    const health = {
        status: ble.isConnected && storage.isRunning && engine.isRunning === true &&
                engine.bleConnected === true && engine.storageConnected === true ? 'ready' : 'degraded',
        services: {
            realtimeEngine: { ready: engine.isRunning === true, state: engine.isRunning ? 'ready' : 'starting' },
            ble: { ready: ble.isConnected === true, state: ble.bleProcess?.state || 'stopped' },
            storage: { ready: storage.isRunning === true, state: storage.process?.state || 'stopped' },
            mocap: ble.mocap || { ready: false, status: 'degraded' }
        },
        engine: {
            running: engine.isRunning === true,
            bleConnected: engine.bleConnected === true,
            storageConnected: engine.storageConnected === true,
            mocapConnected: engine.mocapConnected === true
        }
    };
    res.status(health.status === 'ready' ? 200 : 503).json(health);
});

// 所有路由都指向index.html（支持前端路由）
app.get('*', (req, res) => {
    res.sendFile(path.join(PATHS.public, 'index.html'));
});


// 自动打开浏览器函数
function openBrowser() {
    try {
        const { exec } = require('child_process');
        const url = `http://localhost:${PORT}`;
        
        switch (process.platform) {
            case 'win32':
                exec(`start ${url}`);
                break;
            case 'darwin':
                exec(`open ${url}`);
                break;
            case 'linux':
                exec(`xdg-open ${url}`);
                break;
            default:
                console.log(`请手动打开浏览器访问: ${url}`);
        }
    } catch (error) {
        console.log('自动打开浏览器失败，请手动访问');
    }
}

// 优雅关闭处理
function shutdownServices(signal = 'manual') {
    if (shutdownPromise) return shutdownPromise;
    isShuttingDown = true;
    shutdownPromise = (async () => {
      console.log(`\n收到 ${signal}，正在关闭服务器...`);
      try {
        await realtimeEngine.stop();
        await deviceSync.close();
        await dataStorage.close();
        await stopCameraServer();  // 【新增】停止 camera_server

        if (httpServer) {
            await new Promise(resolve => httpServer.close(resolve));
            httpServer = null;
        }

        console.log('服务器关闭完成');
        if (logger) await logger.close();
      } catch (error) {
        console.error('关闭过程中发生错误，服务保持运行以便恢复:', error);
        throw error;
      }
    })().finally(() => {
      isShuttingDown = false;
      shutdownPromise = null;
    });
    return shutdownPromise;
}

function setupGracefulShutdown() {
    const shutdown = async (signal) => {
        try {
            await shutdownServices(signal);
            process.exit(0);
        } catch (error) {
            console.error('[server.js] 关闭未完成，未强制退出进程');
        }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ==================== Camera Server 管理 ====================

function startCameraServer() {
    if (cameraServerProcess?.state === 'ready') return Promise.resolve(cameraServerProcess);
    if (cameraServerProcess?.child) return Promise.reject(new Error('摄像头旧进程尚未退出，请先重试关闭'));
    return (async () => {
        try {
            console.log('[server.js] 正在启动 camera_server...');

            const { command, args } = getPythonCommand(CAMERA_SERVER_SCRIPT);
            cameraServerProcess = new ManagedProcess({
                name: 'camera_server', command, args, env: PYTHON_ENV,
                readyPorts: 8768
            });
            cameraServerProcess.on('close', ({ code, signal }) => {
                console.log(`[server.js] camera_server 进程退出, code: ${code}, signal: ${signal}`);
                cameraServerProcess = null;
            });
            await cameraServerProcess.start();
            console.log('[server.js] ✅ camera_server 已就绪 (端口: 8768)');
            return cameraServerProcess;
        } catch (error) {
            console.error('[server.js] 启动 camera_server 时出错:', error);
            try {
                await cameraServerProcess?.stop();
                cameraServerProcess = null;
            } catch (stopError) {
                console.error('[server.js] 摄像头启动清理失败，保留句柄:', stopError);
            }
            throw error;
        }
    })();
}

async function stopCameraServer() {
    if (!cameraServerProcess) return;
    const service = cameraServerProcess;
    await service.stop({ timeoutMs: 30000 });
    if (cameraServerProcess === service) cameraServerProcess = null;
}

// ==================== End Camera Server ====================

// 启动服务器
async function startServer() {
    if (httpServer) return httpServer;
    if (startPromise) return startPromise;
    startPromise = startServerInternal().finally(() => { startPromise = null; });
    return startPromise;
}

async function startServerInternal() {
    try {


        // 启动realtimeEngine模块
        await realtimeEngine.start(8080);
        console.log('[server.js] realtimeEngine 启动成功');

        // 启动deviceSync模块（deviceSync启动ble_server模块）
        await deviceSync.initialize();
        console.log('[server.js] deviceSync 启动成功');

        // 启动dataStorage模块(dataStorage模块启动storage_server模块)
        await dataStorage.initialize();
        console.log('[server.js] dataStorage 启动成功');

        // Camera is optional; BLE/storage remain mandatory.
        try {
            await startCameraServer();
            console.log('[server.js] camera_server 启动成功');
        } catch (error) {
            console.warn(`[server.js] camera_server不可用，已降级: ${error.message}`);
        }
        
        // 启动HTTP服务器
        const server = app.listen(PORT);
        await new Promise((resolve, reject) => {
            const onListening = () => { cleanup(); resolve(); };
            const onError = error => { cleanup(); reject(error); };
            const cleanup = () => { server.off('listening', onListening); server.off('error', onError); };
            server.once('listening', onListening);
            server.once('error', onError);
        });
        console.log(`数据采集系统已启动，访问地址：http://localhost:${PORT}`);
        console.log('设备状态API: http://localhost:' + PORT + '/api/device-status');
        if (!process.env.ELECTRON_MODE && !process.env.SEMG_NO_BROWSER) openBrowser();

        httpServer = server;
        return server;
        
    } catch (error) {
        console.error('服务器启动失败:', error);
        // Stop ingestion before its sinks. Every owned resource gets a cleanup
        // attempt even if an earlier shutdown step fails.
        for (const cleanup of [() => stopCameraServer(), () => realtimeEngine.stop(),
                               () => dataStorage.close(), () => deviceSync.close()]) {
            try { await cleanup(); }
            catch (cleanupError) { console.error('启动回滚失败:', cleanupError); }
        }
        throw error;
    }
}

// 启动服务器
setupGracefulShutdown();
if (!process.env.SEMG_NO_AUTO_START && !process.env.ELECTRON_MODE) {
    startServer().then(() => printSystemStatus()).catch(error => {
        console.error('服务器启动失败:', error);
        process.exitCode = 1;
    });
}

module.exports = {
    app,
    startServer,
    shutdown: shutdownServices,
    listStorageFiles,
    getStorageFilesCached
};

// 打印系统状态汇总
function printSystemStatus() {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                         系统模块连接架构图                                   ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║                                                                              ║');
    console.log('║   [前端浏览器]                                                               ║');
    console.log('║       │                                                                      ║');
    console.log('║       ├──(HTTP)──────► [Express Server :3000]                                ║');
    console.log('║       │                                                                      ║');
    console.log('║       └──(WS :8080)──► [realtimeEngine]                                      ║');
    console.log('║                             │                                                ║');
    console.log('║                             ├──(WS :8766)──► [ble_server 数据端]             ║');
    console.log('║                             │                                                ║');
    console.log('║                             ├──(WS :8767)──► [mocap_server]                  ║');
    console.log('║                             │                                                ║');
    console.log('║                             └──(ZMQ :5555)─► [storage_server]                ║');
    console.log('║                                                                              ║');
    console.log('║   [前端 ble_control.js]                                                      ║');
    console.log('║       │                                                                      ║');
    console.log('║       └──(WS :8764)──► [ble_server 控制端]                                   ║');
    console.log('║                                                                              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║                         各端口连接状态                                       ║');
    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');

    // realtimeEngine 状态
    const rtStatus = realtimeEngine.getStatus();
    const bleDataConn = rtStatus.bleConnected ? '✓ 已连接' : '✗ 未连接';
    const storageConn = rtStatus.storageConnected ? '✓ 已连接' : '✗ 未连接';
    const mocapConn = rtStatus.mocapConnected ? '✓ 已连接' : '✗ 未连接';
    const frontendCount = rtStatus.clientCount || 0;

    console.log('║                                                                              ║');
    console.log(`║  :8080  realtimeEngine ← 前端WebSocket        ${(frontendCount + ' 个客户端').padEnd(25)} ║`);

    // 【新增】显示已连接的客户端列表
    if (rtStatus.connectedClients && rtStatus.connectedClients.length > 0) {
        const clientNames = rtStatus.connectedClients.map(c => c.name).join(', ');
        console.log(`║         已连接: ${clientNames.padEnd(55)} ║`);
    }
    // 【新增】显示需要手动触发才连接的客户端
    console.log(`║         待连接: Waveform (进入采集页面后连接)                                ║`);

    console.log(`║  :8766  realtimeEngine → ble_server(数据端)   ${bleDataConn.padEnd(25)} ║`);
    console.log(`║  :8767  realtimeEngine → mocap_server         ${mocapConn.padEnd(25)} ║`);
    console.log(`║  :5555  realtimeEngine → storage_server(ZMQ)  ${storageConn.padEnd(25)} ║`);
    console.log('║                                                                              ║');

    // deviceSync 状态 (ble_server进程)
    const deviceSyncStatus = deviceSync.getStatus();
    const bleProcessRunning = deviceSyncStatus.isConnected ? '✓ 进程运行中' : '✗ 进程未启动';
    console.log(`║  :8764  ble_server(控制端) ← 前端ble_control  ${bleProcessRunning.padEnd(25)} ║`);
    console.log(`║  :8766  ble_server(数据端) ← realtimeEngine   ${bleDataConn.padEnd(25)} ║`);
    console.log('║                                                                              ║');

    // storage 状态
    const dsStatus = dataStorage.getStatus();
    const storageRunning = dsStatus.isRunning ? '✓ 进程运行中' : '✗ 进程未启动';
    console.log(`║  :5555  storage_server(ZMQ) ← realtimeEngine  ${storageRunning.padEnd(25)} ║`);
    console.log('║                                                                              ║');

    console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
    console.log('║  提示: 如果 :8766 数据端未连接，波形将无法显示                               ║');
    console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
    console.log('\n');
}
