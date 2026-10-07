/*
 deviceSync.js
 负责启动ble_server, 以及监控ble_server的传输信息（数据不接受，只接收一些统计信息，为前端提供api接口）
*/

const EventEmitter = require('events');
const realtimeEngine = require('./realtimeEngine');
const { getPythonCommand } = require('./pythonPath');
const cameraManager = require('./cameraManager');
const { ManagedProcess } = require('./lib/service-process');

// BLE服务脚本切换:
// - 'ble_server'        真实腕带
// - 'ble_server_sim_v2' V2模拟器（无设备测试上层链路）
const BLE_SERVER_SCRIPT = 'ble_server';
const PYTHON_ENV = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
};

class DeviceSync extends EventEmitter {
    constructor() {
        super();
        this.pythonProcess = null; // ble_server ManagedProcess
        this.mocapProcess = null;  // mocap_server ManagedProcess
        this.initializePromise = null;
        this.mocapStatus = 'stopped';
        this.packetCount = 0;
        this.lastTimestamp = 0;
        this.isConnected = false;
        this.startTime = null;
        this.dataRate = 0;
        this.emgData = Array(16).fill().map(() => []); // 16通道EMG数据缓存
        this.maxDataPoints = 200; // 每个通道显示的数据点数
        this.lastDataTime = Date.now();
        this.lastValues = Array(16).fill(0); // 最新的16通道值
        this.lastInterval = 0; // 最后的数据包间隔

        this.totalBytesReceived = 0;    // 累计接收的总字节数
        this.lastThroughputCheckTime = null;  // 上次计算吞吐量的时间
        this.lastBytesCount = 0;        // 上次计算时的总字节数
        this.currentThroughput = 0;     // 当前吞吐量（字节/秒）

        // 摄像头管理器引用
        this.cameraManager = cameraManager;
    }

    // 初始化Python进程连接
    async initialize() {
        if (this.pythonProcess?.state === 'ready') return this.getStatus();
        if (this.initializePromise) return this.initializePromise;
        if (this.pythonProcess?.child) throw new Error('BLE旧进程尚未退出，请先重试关闭');
        this.initializePromise = (async () => {
            try {
                console.log('[deviceSync] 正在启动ble_server......');

                // 自动判断使用 Python 脚本还是打包后的 exe
                const { command, args } = getPythonCommand(BLE_SERVER_SCRIPT);
                this.pythonProcess = new ManagedProcess({
                    name: 'ble_server', command, args, env: PYTHON_ENV,
                    readyPorts: [8764, 8766]
                });
                this.pythonProcess.on('error', error => {
                    console.error('[deviceSync] ble_server发生错误:', error.message);
                    this.isConnected = false;
                    this.emit('error', error);
                });
                this.pythonProcess.on('close', ({ code }) => {
                    console.log(`[deviceSync] ble_server已关闭，退出码: ${code}`);
                    this.isConnected = false;
                    this.emit('disconnected');
                });
                await this.pythonProcess.start();
                this.isConnected = true;
                this.startTime = Date.now();
                console.log('[deviceSync] ble_server已就绪 (端口: 8764, 8766)');
                // mocap is optional: a missing SDK degrades motion capture while BLE remains usable.
                this.startMocapServer().catch(error => {
                    this.mocapStatus = 'degraded';
                    console.warn(`[deviceSync] mocap_server不可用，已降级: ${error.message}`);
                });
                return this.getStatus();
            } catch (error) {
                console.error('[deviceSync] 启动ble_server失败:', error);
                this.isConnected = false;
                try {
                    await this.pythonProcess?.stop();
                    this.pythonProcess = null;
                } catch (stopError) {
                    console.error('[deviceSync] BLE启动清理失败，保留句柄:', stopError);
                }
                throw error;
            }
        })().finally(() => { this.initializePromise = null; });
        return this.initializePromise;
    }

    // 启动mocap_server
    async startMocapServer() {
        if (this.mocapProcess?.state === 'ready') return this.mocapProcess;
        if (this.mocapProcess?.child) throw new Error('动捕旧进程尚未退出，请先重试关闭');
        try {
            console.log('[deviceSync] 正在启动mocap_server......');

            // 自动判断使用 Python 脚本还是打包后的 exe
            // 模拟器模式：使用 --simulator 参数连接 mocap_simulator.py
            // SDK模式：使用 -s 参数连接真实 Nokov SDK
            const USE_SIMULATOR = false;  // 设为 false 使用真实SDK
            const mocapArgs = USE_SIMULATOR
                ? ['--simulator']
                : ['-s', '10.1.1.198'];

            const { command, args } = getPythonCommand('mocap_server', mocapArgs);
            this.mocapProcess = new ManagedProcess({
                name: 'mocap_server', command, args, env: PYTHON_ENV,
                readyPorts: 8767
            });
            this.mocapStatus = 'starting';
            this.mocapProcess.on('close', ({ code }) => {
                console.log(`[deviceSync] mocap_server已关闭，退出码: ${code}`);
                this.mocapStatus = 'stopped';
                this.mocapProcess = null;
            });
            await this.mocapProcess.start();
            this.mocapStatus = 'ready';
            console.log('[deviceSync] mocap_server已就绪 (端口: 8767)');
            return this.mocapProcess;
        } catch (error) {
            console.error('[deviceSync] 启动mocap_server失败:', error);
            try {
                await this.mocapProcess?.stop();
                this.mocapProcess = null;
            } catch (stopError) {
                console.error('[deviceSync] 动捕启动清理失败，保留句柄:', stopError);
            }
            this.mocapStatus = 'degraded';
            throw error;
        }
    }

    // api: 获取ble_server的传输吞吐量
    getCurrentThroughput() {
        const currentTime = Date.now();
        
        if (!this.lastThroughputCheckTime) {
            this.lastThroughputCheckTime = currentTime;
            this.lastBytesCount = this.totalBytesReceived;
            return 0;
        }
        
        const timeDiffMs = currentTime - this.lastThroughputCheckTime;
        if (timeDiffMs <= 0) {
            return this.currentThroughput;
        }
        
        const bytesDiff = this.totalBytesReceived - this.lastBytesCount;
        const timeDiffSec = timeDiffMs / 1000;
        this.currentThroughput = bytesDiff / timeDiffSec;
        
        this.lastThroughputCheckTime = currentTime;
        this.lastBytesCount = this.totalBytesReceived;
        
        return this.currentThroughput;
    }

    // api: 获取模块状态
    getStatus() {
        return {
            isConnected: this.isConnected,
            bleProcess: this.pythonProcess?.getStatus() || { state: 'stopped', ready: false },
            mocap: {
                status: this.mocapStatus,
                ready: this.mocapProcess?.state === 'ready'
            },
            dataCount: this.packetCount,
            currentRate: this.dataRate,
            lastTimestamp: this.lastTimestamp,
            lastInterval: this.lastInterval,
            emgData: this.lastValues,
            lastDataTime: this.lastDataTime,
            dataHistory: this.emgData.map(channel => channel.length),
            cameras: this.cameraManager.getCameraStatus()  // 添加摄像头状态
        };
    }

    // 关闭连接
    async close() {
            // 关闭摄像头
            await this.cameraManager.stopAll();
            console.log('[deviceSync] 摄像头已关闭');

            // 关闭mocap_server
            if (this.mocapProcess) {
                const process = this.mocapProcess;
                await process.stop();
                if (this.mocapProcess === process) this.mocapProcess = null;
                this.mocapStatus = 'stopped';
                console.log('[deviceSync] mocap_server关闭');
            }

            // 关闭ble_server
            if (this.pythonProcess) {
                const process = this.pythonProcess;
                await process.stop();
                if (this.pythonProcess === process) this.pythonProcess = null;
                this.isConnected = false;
                console.log('[deviceSync] ble_server关闭');
                this.emit('disconnected');
            } else {
                console.log('[deviceSync] ble_server未启动，无需关闭');
            }
    }

    // 重置模块状态
    reset() {
        this.packetCount = 0;
        this.lastTimestamp = 0;
        this.dataRate = 0;
        this.lastInterval = 0;
        this.emgData = Array(16).fill().map(() => []);
        this.lastValues = Array(16).fill(0);
        this.lastDataTime = Date.now();
        console.log('[deviceSync] deviceSync状态已重置');
    }

    // 检查连接状态
    checkConnection() {
        return this.isConnected && this.pythonProcess !== null;
    }

    // 获取连接信息
    getConnectionInfo() {
        return {
            isConnected: this.isConnected,
            source: '蓝牙设备',
            deviceMac: 'dc:b4:d9:1f:52:be',
            scriptName: 'scan-connect.py',
            dataFormat: 'JSON格式，包含5组16通道数据'
        };
    }

    /**
     * 获取程序运行所在磁盘的剩余容量（GB）和剩余占比（%）
     * @returns {Promise<{freeGB: number, freePercent: number, totalGB: number}|string>} 磁盘信息/错误提示
     */
    async getStorageVolumeInfo() {
        try {
            // 仅支持 Node.js 环境（浏览器无权限）
            if (typeof process === 'undefined' || !process.versions?.node) {
                return "仅支持 Node.js 环境获取磁盘信息";
            }

            const fs = require('fs').promises;
            const path = require('path');

            // 获取程序当前运行目录（关键：以此目录定位所在磁盘）
            const currentDir = process.cwd();
            // Windows: 取盘符根路径（如 D:\），Linux/macOS: 取根目录 /
            const diskPath = process.platform === 'win32'
                ? path.parse(currentDir).root
                : '/';

            // 获取磁盘分区的容量信息（核心：Node.js v22 原生支持）
            const stat = await fs.statfs(diskPath);
            const GB_UNIT = 1024 * 1024 * 1024; // 1GB = 1024³ 字节

            // 计算总容量、剩余容量（字节 → GB，保留2位小数）
            const totalGB = parseFloat((stat.blocks * stat.bsize / GB_UNIT).toFixed(2));
            const freeGB = parseFloat((stat.bavail * stat.bsize / GB_UNIT).toFixed(2));
            // 计算剩余占比（保留1位小数）
            const freePercent = parseFloat(((stat.bavail / stat.blocks) * 100).toFixed(1));

            // 返回核心信息：剩余容量、剩余占比、总容量
            //console.log(`${freeGB}, ${freePercent}`)
            return {
                freeGB,
                freePercent,
                totalGB
            };

        } catch (error) {
            console.error("获取磁盘信息失败：", error);
            return `获取失败：${error.message}`;
        }
    }

    // ==================== 摄像头相关API ====================

    /**
     * 设置摄像头映射
     * @param {string} side - 'left' 或 'right'
     * @param {object} cameraInfo - {deviceId, label, resolution, fps}
     */
    setCameraMapping(side, cameraInfo) {
        return this.cameraManager.setCameraMapping(side, cameraInfo);
    }

    /**
     * 开始视频流推流
     * @param {string} side - 'left', 'right', 或 'both'
     */
    startCameraStreaming(side = 'both') {
        if (side === 'both') {
            const leftResult = this.cameraManager.startStreaming('left');
            const rightResult = this.cameraManager.startStreaming('right');
            return {
                success: leftResult.success && rightResult.success,
                left: leftResult,
                right: rightResult
            };
        }
        return this.cameraManager.startStreaming(side);
    }

    /**
     * 停止视频流推流
     * @param {string} side - 'left', 'right', 或 'both'
     */
    stopCameraStreaming(side = 'both') {
        if (side === 'both') {
            const leftResult = this.cameraManager.stopStreaming('left');
            const rightResult = this.cameraManager.stopStreaming('right');
            return {
                success: leftResult.success && rightResult.success,
                left: leftResult,
                right: rightResult
            };
        }
        return this.cameraManager.stopStreaming(side);
    }

    /**
     * 开始录制视频
     * @param {string} outputPath - 输出文件路径（不含扩展名）
     * @param {object} metadata - 元数据
     */
    async startCameraRecording(recordings, metadata = {}) {
        // recordings 是一个数组，例如：
        // [{ side: 'left', output_filename: 'R001_L_260614_153129.mp4' }]

        if (!recordings || !Array.isArray(recordings)) {
            return { success: false, error: '无效的recordings参数' };
        }

        // 调用 realtimeEngine 通过 camera_server 录制
        const results = {};

        for (const recording of recordings) {
            const { side, output_filename } = recording;
            if (!side || !output_filename) {
                results[side] = { success: false, error: '缺少side或output_filename参数' };
                continue;
            }

            // 通过 realtimeEngine 发送命令到 camera_server
            try {
                const result = await this.realtimeEngine.sendCameraCommand('start_recording', {
                    side: side,
                    output_filename: output_filename
                });

                results[side] = result;

                // 更新 cameraManager 状态
                if (result.success) {
                    this.cameraManager.cameraStatus[side].recording = true;
                    this.cameraManager.currentRecordingFiles[side] = output_filename;
                    this.cameraManager.recordingSessions[side] = {
                        startTime: Date.now(),
                        outputFilename: output_filename,
                        metadata: metadata
                    };
                }
            } catch (error) {
                console.error(`[deviceSync] ${side}侧录制启动失败:`, error);
                results[side] = { success: false, error: error.message };
            }
        }

        // 检查是否至少有一个成功
        const hasSuccess = Object.values(results).some(r => r && r.success);

        return {
            success: hasSuccess,
            ...results
        };
    }

    /**
     * 停止录制视频
     */
    async stopCameraRecording() {
        // 通过 realtimeEngine 发送命令到 camera_server
        const results = {};

        for (const side of ['left', 'right']) {
            if (this.cameraManager.cameraStatus[side].recording) {
                try {
                    const result = await this.realtimeEngine.sendCameraCommand('stop_recording', {
                        side: side
                    });

                    results[side] = result;

                    // 更新 cameraManager 状态
                    if (result.success) {
                        this.cameraManager.cameraStatus[side].recording = false;
                        this.cameraManager.currentRecordingFiles[side] = null;
                        this.cameraManager.recordingSessions[side] = null;
                    }
                } catch (error) {
                    console.error(`[deviceSync] ${side}侧录制停止失败:`, error);
                    results[side] = { success: false, error: error.message };
                }
            } else {
                results[side] = { success: true, message: '未在录制中' };
            }
        }

        const hasSuccess = Object.values(results).some(r => r && r.success);

        return {
            success: hasSuccess,
            left: results.left || { success: false },
            right: results.right || { success: false }
        };
    }

    /**
     * 获取摄像头状态
     */
    getCameraStatus() {
        return this.cameraManager.getCameraStatus();
    }


}

// 创建单例实例
const deviceSync = new DeviceSync();

deviceSync.on('error', (error) => {
    console.error('[deviceSync] deviceSync错误:', error.message);
});

deviceSync.on('disconnected', () => {
    console.log('[deviceSync] deviceSync已断开');
});

console.log('[deviceSync] deviceSync模块加载完成');

module.exports = deviceSync;
