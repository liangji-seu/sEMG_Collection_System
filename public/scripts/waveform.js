/**
 * waveform.js - 主入口文件
 * 
 * 整合渲染器，提供完整的波形显示功能。
 * 数据源：WebSocket实时数据（来自realtimeEngine.js，端口8080）
 * 
 * 修复：移除对data-generator.js的依赖，所有模拟数据由ble_server.py生成
 */

(function() {
    'use strict';

    // ==================== WebSocket 数据接收器 ====================
    class RealtimeDataReceiver {
        constructor(controller) {
            this.controller = controller;
            this.ws = null;
            this.wsUrl = 'ws://localhost:8080';  // realtimeEngine.js 的WebSocket端口
            this.reconnectInterval = 3000;
            this.reconnectTimer = null;
            this.isConnected = false;
            this.maxReconnectAttempts = 10;
            this.reconnectAttempts = 0;
        }

        /**
         * 连接到 realtimeEngine.js 的 WebSocket 服务
         */
        connect() {
            // 【修复】检查是否已连接或正在连接
            if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
                console.log('[Waveform] WebSocket已连接或正在连接，跳过');
                return;
            }

            // 【修复】清理旧连接
            if (this.ws) {
                this.ws.onopen = null;
                this.ws.onclose = null;
                this.ws.onerror = null;
                this.ws.onmessage = null;
                this.ws = null;
            }

            try {
                console.log(`[Waveform] 正在连接 ${this.wsUrl}... (尝试 ${this.reconnectAttempts + 1})`);
                this.ws = new WebSocket(this.wsUrl);

                this.ws.onopen = () => {
                    console.log('[Waveform] ✓ WebSocket连接成功');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    clearTimeout(this.reconnectTimer);

                    // 【新增】自报身份
                    this.ws.send(JSON.stringify({
                        type: 'client_identify',
                        clientName: 'Waveform'
                    }));

                    // 更新UI状态
                    this.updateConnectionStatus(true);
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.ws.onerror = (error) => {
                    console.error('[Waveform] WebSocket错误:', error);
                };

                this.ws.onclose = (event) => {
                    console.log(`[Waveform] WebSocket连接关闭 (code: ${event.code})`);
                    this.isConnected = false;
                    this.ws = null;  // 【修复】清理引用
                    this.updateConnectionStatus(false);

                    // 【修复】只在非主动关闭时重连
                    if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.scheduleReconnect();
                    }
                };

            } catch (error) {
                console.error('[Waveform] 创建WebSocket失败:', error);
                this.scheduleReconnect();
            }
        }

        /**
         * 断开WebSocket连接
         */
        disconnect() {
            clearTimeout(this.reconnectTimer);
            this.reconnectAttempts = this.maxReconnectAttempts; // 阻止重连
            
            if (this.ws) {
                this.ws.close(1000, '用户主动断开');
                this.ws = null;
            }
            this.isConnected = false;
            this.updateConnectionStatus(false);
        }

        /**
         * 安排重连
         */
        scheduleReconnect() {
            this.reconnectAttempts++;
            console.log(`[Waveform] ${this.reconnectInterval/1000}秒后尝试第${this.reconnectAttempts}次重连...`);
            
            this.reconnectTimer = setTimeout(() => {
                this.connect();
            }, this.reconnectInterval);
        }

        /**
         * 处理收到的消息
         */
        handleMessage(rawData) {
            try {
                const packet = JSON.parse(rawData);

                // 处理连接确认消息
                if (packet.type === 'connection_established') {
                    console.log('[Waveform] 收到连接确认:', packet.message);
                    return;
                }

                // 【优化】处理批量实时数据包
                if (packet.type === 'realtime_data_batch') {
                    // 批量渲染所有数据
                    for (const data of packet.batch) {
                        this.renderRealtimeData(data);
                    }
                    return;
                }

                // 处理实时数据包 (来自realtimeEngine.js)
                if (packet.type === 'realtime_data') {
                    this.renderRealtimeData(packet.data);
                    return;
                }

                // 兼容旧格式 emg_data
                if (packet.type === 'emg_data') {
                    console.log('[Waveform] 收到旧格式数据包');
                    return;
                }

                if (packet.type === 'h5_storage_warning') {
                    const message = packet.message || 'H5写入异常，请中断并重采本轮';
                    const nonBlocking = packet.nonBlocking === true || packet.level === 'warning';
                    (nonBlocking ? console.warn : console.error)('[Waveform] H5存储告警:', packet);
                    if (window.collectionController && typeof window.collectionController.showToast === 'function') {
                        window.collectionController.showToast(message, nonBlocking ? 'warning' : 'error');
                    } else if (nonBlocking) {
                        console.warn('[Waveform] 非阻断采集提示:', message);
                    } else {
                        alert(message);
                    }
                    return;
                }

            } catch (error) {
                console.error('[Waveform] 消息解析失败:', error);
            }
        }

        /**
         * 渲染实时数据
         * 
         * @param {Object} data - 数据包（来自realtimeEngine.js）
         *   data.emg1: 设备1的EMG数据 [[ch0_p1, ch0_p2, ...], [ch1_p1, ...], ...] 16通道×N帧
         *   data.emg2: 设备2的EMG数据
         *   data.imu1: 设备1的IMU数据 { acc: [ax,ay,az], gyr: [gx,gy,gz], mag: [mx,my,mz] }
         *   data.imu2: 设备2的IMU数据
         *   data.activeDevices: 活跃设备列表 [1] 或 [2] 或 [1,2]
         */
        renderRealtimeData(data) {
            if (!this.controller || !this.controller.rendererManager) return;

            const rm = this.controller.rendererManager;
            
            // 获取活跃设备列表
            const activeDevices = data.activeDevices || [];

            // ===== EMG1数据渲染（仅当设备1有数据时） =====
            if (data.emg1 && data.emg1.length > 0) {
                const emg1Renderer = rm.get('emg1');
                if (emg1Renderer) {
                    emg1Renderer.renderPoints(data.emg1);
                }
                // Feed 质量监测器
                this.controller.feedQualityMonitor(1, data.emg1);
                // 更新帧计数
                this.controller.frameCount1 += (data.framesInPacket || data.emg1[0].length || 9);
            }

            // ===== EMG2数据渲染（仅当设备2有数据时） =====
            if (data.emg2 && data.emg2.length > 0) {
                const emg2Renderer = rm.get('emg2');
                if (emg2Renderer) {
                    emg2Renderer.renderPoints(data.emg2);
                }
                // Feed 质量监测器
                this.controller.feedQualityMonitor(2, data.emg2);
                // 更新帧计数
                this.controller.frameCount2 += (data.framesInPacket || data.emg2[0].length || 9);
            }

            // ===== IMU1数据渲染（仅当设备1有数据时） =====
            if (data.imu1) {
                const imu1Chips = Array.isArray(data.imu1) ? data.imu1 : [data.imu1];
                const imu1Acc = rm.get('imu1Acc');
                const imu1Gyr = rm.get('imu1Gyr');
                if (imu1Acc) imu1Acc.renderPoints(imu1Chips);
                if (imu1Gyr) imu1Gyr.renderPoints(imu1Chips);

                // 加速度计: acc = [ax, ay, az]
                if (data.imu1.acc) {
                    const accData = data.imu1.acc.map(v => [v]);  // 转为 [[ax], [ay], [az]]
                    const imu1Acc = rm.get('imu1Acc');
                    if (imu1Acc) imu1Acc.renderPoints(accData);
                }

                // 陀螺仪: gyr = [gx, gy, gz]
                if (data.imu1.gyr) {
                    const gyrData = data.imu1.gyr.map(v => [v]);
                    const imu1Gyr = rm.get('imu1Gyr');
                    if (imu1Gyr) imu1Gyr.renderPoints(gyrData);
                }

                // 磁力计: mag = [mx, my, mz]
                if (data.imu1.mag) {
                    const magData = data.imu1.mag.map(v => [v]);
                    const imu1Mag = rm.get('imu1Mag');
                    if (imu1Mag) imu1Mag.renderPoints(magData);
                    // V1: 确保 Mag 区域可见
                    const container = document.getElementById('imu1-mag-container');
                    if (container) container.style.display = '';
                    if (container) {
                        const bar = container.previousElementSibling;
                        if (bar && bar.classList.contains('control-bar')) bar.style.display = '';
                    }
                } else {
                    // V2: 无磁力计，清除残留数据并隐藏 Mag 区域
                    const imu1Mag = rm.get('imu1Mag');
                    if (imu1Mag) imu1Mag.clear();
                    const container = document.getElementById('imu1-mag-container');
                    if (container) container.style.display = 'none';
                    if (container) {
                        const bar = container.previousElementSibling;
                        if (bar && bar.classList.contains('control-bar')) bar.style.display = 'none';
                    }
                }
            }

            // ===== IMU2数据渲染（仅当设备2有数据时） =====
            if (data.imu2) {
                const imu2Chips = Array.isArray(data.imu2) ? data.imu2 : [data.imu2];
                const imu2Acc = rm.get('imu2Acc');
                const imu2Gyr = rm.get('imu2Gyr');
                if (imu2Acc) imu2Acc.renderPoints(imu2Chips);
                if (imu2Gyr) imu2Gyr.renderPoints(imu2Chips);

                if (data.imu2.acc) {
                    const accData = data.imu2.acc.map(v => [v]);
                    const imu2Acc = rm.get('imu2Acc');
                    if (imu2Acc) imu2Acc.renderPoints(accData);
                }

                if (data.imu2.gyr) {
                    const gyrData = data.imu2.gyr.map(v => [v]);
                    const imu2Gyr = rm.get('imu2Gyr');
                    if (imu2Gyr) imu2Gyr.renderPoints(gyrData);
                }

                if (data.imu2.mag) {
                    const magData = data.imu2.mag.map(v => [v]);
                    const imu2Mag = rm.get('imu2Mag');
                    if (imu2Mag) imu2Mag.renderPoints(magData);
                    const container = document.getElementById('imu2-mag-container');
                    if (container) container.style.display = '';
                    if (container) {
                        const bar = container.previousElementSibling;
                        if (bar && bar.classList.contains('control-bar')) bar.style.display = '';
                    }
                } else {
                    const imu2Mag = rm.get('imu2Mag');
                    if (imu2Mag) imu2Mag.clear();
                    const container = document.getElementById('imu2-mag-container');
                    if (container) container.style.display = 'none';
                    if (container) {
                        const bar = container.previousElementSibling;
                        if (bar && bar.classList.contains('control-bar')) bar.style.display = 'none';
                    }
                }
            }

            // ===== 更新统计信息 =====
            if (data.stats1) {
                this.controller.updateDeviceStats(1, data.stats1);
            }
            if (data.stats2) {
                this.controller.updateDeviceStats(2, data.stats2);
            }
            
            this.controller.updateFrameCount();
        }

        /**
         * 更新连接状态显示
         */
        updateConnectionStatus(connected) {
            const statusElement = document.getElementById('ws-status');
            if (statusElement) {
                statusElement.textContent = connected ? '已连接' : '未连接';
                statusElement.className = connected ? 'status-connected' : 'status-disconnected';
            }

            // 【新增】通知 ble_control.js 更新扫描按钮状态
            // 数据端连接状态变化时，触发扫描按钮状态检查
            if (window.BleControl && typeof window.BleControl.updateScanButtonState === 'function') {
                window.BleControl.updateScanButtonState();
            }
        }
    }

    // ==================== 主控制器 ====================
    class WaveformController {
        constructor() {
            this.rendererManager = new RendererManager();
            this.dataReceiver = new RealtimeDataReceiver(this);

            this.isRunning = false;
            this.frameCount1 = 0;  // 设备1帧计数
            this.frameCount2 = 0;  // 设备2帧计数

            // 设备统计
            this.stats1 = { total: 0, lost: 0 };
            this.stats2 = { total: 0, lost: 0 };

            // 信号质量监测器 (每个设备独立)
            this._qualityMonitor1 = new SignalQuality.QualityMonitor();
            this._qualityMonitor2 = new SignalQuality.QualityMonitor();

            this.init();
        }

        init() {
            // 创建EMG渲染器 (供应商堆叠模式，含 clamp checkbox)
            this.rendererManager.createEMGRenderer(
                'emg1', 'emg1-canvas', 'emg1-container', 'emg1-pointer',
                'emg1-offset', 'emg1-channel', 'emg1-clamp'
            );
            this.rendererManager.createEMGRenderer(
                'emg2', 'emg2-canvas', 'emg2-container', 'emg2-pointer',
                'emg2-offset', 'emg2-channel', 'emg2-clamp'
            );

            // 创建IMU渲染器 - IMU1
            this.rendererManager.createIMURenderer(
                'imu1Acc', 'imu1-acc-canvas', 'imu1-acc-container', 'imu1-acc-pointer', 'imu1-acc-offset'
            );
            this.rendererManager.createIMURenderer(
                'imu1Gyr', 'imu1-gyr-canvas', 'imu1-gyr-container', 'imu1-gyr-pointer', 'imu1-gyr-offset'
            );
            this.rendererManager.createIMURenderer(
                'imu1Mag', 'imu1-mag-canvas', 'imu1-mag-container', 'imu1-mag-pointer', 'imu1-mag-offset'
            );

            // 创建IMU渲染器 - IMU2
            this.rendererManager.createIMURenderer(
                'imu2Acc', 'imu2-acc-canvas', 'imu2-acc-container', 'imu2-acc-pointer', 'imu2-acc-offset'
            );
            this.rendererManager.createIMURenderer(
                'imu2Gyr', 'imu2-gyr-canvas', 'imu2-gyr-container', 'imu2-gyr-pointer', 'imu2-gyr-offset'
            );
            this.rendererManager.createIMURenderer(
                'imu2Mag', 'imu2-mag-canvas', 'imu2-mag-container', 'imu2-mag-pointer', 'imu2-mag-offset'
            );

            // 更新时间显示
            this.updateTimeDisplay();
            setInterval(() => this.updateTimeDisplay(), 1000);

            console.log('[Waveform] 渲染器初始化完成');
        }

        updateTimeDisplay() {
            const now = new Date();
            const timeStr = now.getFullYear() + '-' +
                String(now.getMonth() + 1).padStart(2, '0') + '-' +
                String(now.getDate()).padStart(2, '0') + ' ' +
                String(now.getHours()).padStart(2, '0') + ':' +
                String(now.getMinutes()).padStart(2, '0') + ':' +
                String(now.getSeconds()).padStart(2, '0');

            const timeElement = document.getElementById('currentTime');
            if (timeElement) {
                timeElement.textContent = timeStr;
            }
            const welcomeTime = document.getElementById('welcomeTime');
            if (welcomeTime) {
                welcomeTime.textContent = timeStr;
            }
        }

        /**
         * 启动实时数据显示
         * 连接到realtimeEngine.js接收来自ble_server.py的数据
         */
        startRealtime() {
            if (this.isRunning) return;
            
            this.isRunning = true;
            
            // 连接WebSocket接收真实数据
            this.dataReceiver.connect();
            
            console.log('[Waveform] 启动实时数据显示');
        }

        /**
         * 兼容旧接口：start() 现在等同于 startRealtime()
         */
        start() {
            this.startRealtime();
        }

        /**
         * 停止显示
         */
        stop() {
            this.isRunning = false;
            this.dataReceiver.disconnect();
            // 重置质量状态
            this._qualityMonitor1.reset();
            this._qualityMonitor2.reset();
            SignalQuality.updateChannelStatusRow('emg1-channel-status', null);
            SignalQuality.updateChannelStatusRow('emg2-channel-status', null);
            console.log('[Waveform] 停止显示');
        }

        /**
         * 更新帧计数显示
         */
        updateFrameCount() {
            const emg1Frames = document.getElementById('emg1-frames');
            const emg2Frames = document.getElementById('emg2-frames');
            if (emg1Frames) emg1Frames.textContent = this.frameCount1;
            if (emg2Frames) emg2Frames.textContent = this.frameCount2;
        }

        /**
         * 更新设备统计信息
         */
        updateDeviceStats(deviceId, stats) {
            if (deviceId === 1) {
                this.stats1 = stats;
            } else if (deviceId === 2) {
                this.stats2 = stats;
            }
            
            // 更新UI显示（如果有对应元素）
            const totalEl = document.getElementById(`dev${deviceId}-total`);
            const lostEl = document.getElementById(`dev${deviceId}-lost`);
            if (totalEl) totalEl.textContent = stats.total;
            if (lostEl) lostEl.textContent = stats.lost;
        }

        /**
         * 喂入数据到信号质量监测器
         * @param {number} deviceId - 1 或 2
         * @param {number[][]} emgData - [channel][sample] μV 数据
         */
        feedQualityMonitor(deviceId, emgData) {
            var monitor = deviceId === 1 ? this._qualityMonitor1 : this._qualityMonitor2;
            var rowId = 'emg' + deviceId + '-channel-status';

            var metrics = monitor.feed(emgData);
            if (metrics) {
                SignalQuality.updateChannelStatusRow(rowId, metrics);
            }
        }

        /**
         * 刷新通道质量指示的显示/隐藏
         * 统一入口，其他模块只调用此方法。
         *
         * 显示条件:
         *   a) 当前在 collectionScreen
         *   b) 对应设备 connected
         *   c) 采集未运行 (collectionController._isRunning === false)
         */
        refreshQualityVisibility() {
            var collectionScreen = document.getElementById('collectionScreen');
            var isCollectionScreen = collectionScreen && collectionScreen.style.display !== 'none';
            var isCollecting = window.collectionController && window.collectionController.isRunning();

            for (var devId = 1; devId <= 2; devId++) {
                var row = document.getElementById('emg' + devId + '-channel-status');
                if (!row) continue;

                // 检查设备连接状态
                var isConnected = false;
                if (window.BleControl && window.BleControl.state && window.BleControl.state.devices) {
                    var dev = window.BleControl.state.devices[devId];
                    isConnected = dev && dev.connected;
                }

                var shouldShow = isCollectionScreen && isConnected && !isCollecting;
                row.style.display = shouldShow ? 'flex' : 'none';

                // 隐藏时重置为灰色
                if (!shouldShow) {
                    SignalQuality.updateChannelStatusRow('emg' + devId + '-channel-status', null);
                }
            }
        }

        /**
         * 清除所有显示
         */
        clearAll() {
            this.rendererManager.clearAll();
            this.frameCount1 = 0;
            this.frameCount2 = 0;
            this.updateFrameCount();

            // 重置质量状态
            this._qualityMonitor1.reset();
            this._qualityMonitor2.reset();
            SignalQuality.updateChannelStatusRow('emg1-channel-status', null);
            SignalQuality.updateChannelStatusRow('emg2-channel-status', null);
        }

        /**
         * 获取渲染器管理器
         */
        getRendererManager() {
            return this.rendererManager;
        }

        /**
         * 获取数据接收器
         */
        getDataReceiver() {
            return this.dataReceiver;
        }

        /**
         * 检查是否正在使用真实数据
         */
        isUsingRealData() {
            return this.dataReceiver.isConnected;
        }
    }

    // ==================== 初始化 ====================
    let controller = null;

    document.addEventListener('DOMContentLoaded', () => {
        controller = new WaveformController();

        // 暴露全局接口
        window.waveformController = controller;

        // 便捷方法
        window.startRealtime = () => controller.startRealtime();
        window.startSimulation = () => controller.startRealtime(); // 兼容旧接口
        window.stopWaveform = () => controller.stop();
        window.clearWaveform = () => controller.clearAll();

        console.log('[Waveform] 系统初始化完成');
        console.log('[Waveform] 可用命令:');
        console.log('  - startRealtime(): 启动实时数据显示');
        console.log('  - stopWaveform(): 停止显示');
        console.log('  - clearWaveform(): 清除显示');
    });

    // 【新增】页面刷新/关闭前主动断开WebSocket连接
    window.addEventListener('beforeunload', () => {
        if (controller) {
            controller.stop();
        }
    });

})();
