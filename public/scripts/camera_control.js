/**
 * camera_control.js - 前端摄像头控制模块（直连 camera_server WebSocket）
 * ==========================================================================
 *
 * 对标 ble_control.js，前端直连 camera_server.py :8768
 * 所有摄像头操作通过 WebSocket 发送命令，预览帧由后端主动推送
 *
 * 使用方法：
 *   在 HTML 中引入: <script defer src="scripts/camera_control.js"></script>
 *   会自动初始化并绑定到页面元素
 */

(function() {
    'use strict';

    // ================= 配置 =================
    const WS_URL = 'ws://localhost:8768';
    const RECONNECT_DELAY = 2000;
    const MAX_RECONNECT_ATTEMPTS = 10;

    // ================= 状态 =================
    const CamState = {
        ws: null,
        connected: false,
        reconnecting: false,
        reconnectAttempts: 0,

        // 摄像头配置
        cameras: {
            left: { configured: false, opened: false, device_name: null, device_id: null },
            right: { configured: false, opened: false, device_name: null, device_id: null }
        },

        // 枚举结果
        scannedDevices: [],

        // 最新预览帧 (base64)
        previewFrames: {
            left: null,
            right: null
        },

        // 待处理命令 (命令 -> Promise resolver)
        pendingCommands: {},

        // 回调
        onStatusChange: null,
        onPreviewFrame: null,
        onScanResult: null,
        onError: null,
        onCameraStateChange: null,
        onRecordingStatus: null,  // 录制状态变化回调
    };

    // ================= WebSocket 连接 =================

    function connect() {
        if (CamState.ws && (CamState.ws.readyState === WebSocket.OPEN || CamState.ws.readyState === WebSocket.CONNECTING)) {
            console.log('[CameraControl] 已经连接或正在连接，跳过');
            return;
        }

        if (CamState.reconnecting) {
            console.log('[CameraControl] 正在重连中，跳过');
            return;
        }

        if (CamState.ws) {
            console.log('[CameraControl] 清理旧连接');
            CamState.ws.onopen = null;
            CamState.ws.onclose = null;
            CamState.ws.onerror = null;
            CamState.ws.onmessage = null;
            CamState.ws = null;
        }

        console.log('[CameraControl] 连接 Camera Server:', WS_URL);
        updateConnectionStatus('connecting');

        try {
            CamState.ws = new WebSocket(WS_URL);

            CamState.ws.onopen = () => {
                console.log('[CameraControl] ✅ 已连接到 Camera Server');
                CamState.connected = true;
                CamState.reconnecting = false;
                CamState.reconnectAttempts = 0;
                updateConnectionStatus('connected');

                if (CamState.onStatusChange) {
                    CamState.onStatusChange({ connected: true });
                }
            };

            CamState.ws.onclose = (event) => {
                console.log('[CameraControl] 连接关闭, code:', event.code);
                CamState.connected = false;
                CamState.ws = null;
                updateConnectionStatus('disconnected');

                // 清除所有待处理的命令
                Object.keys(CamState.pendingCommands).forEach(key => {
                    const { reject } = CamState.pendingCommands[key];
                    reject(new Error('连接已断开'));
                    delete CamState.pendingCommands[key];
                });

                if (CamState.onStatusChange) {
                    CamState.onStatusChange({
                        connected: false,
                        reason: 'ws_closed',
                        code: event.code,
                        message: event.reason || ''
                    });
                }

                if (event.code !== 1000) {
                    scheduleReconnect();
                }
            };

            CamState.ws.onerror = (err) => {
                console.error('[CameraControl] WebSocket 错误');
                if (CamState.onError) {
                    CamState.onError('Camera Server 连接错误');
                }
            };

            CamState.ws.onmessage = (event) => {
                handleMessage(event.data);
            };

        } catch (err) {
            console.error('[CameraControl] 连接失败:', err);
            CamState.ws = null;
            scheduleReconnect();
        }
    }

    function disconnect() {
        Object.values(CamState.pendingCommands).forEach(pending => pending.reject(new Error('连接已关闭')));
        CamState.pendingCommands = {};
        CamState.reconnecting = false;
        if (CamState.ws) {
            CamState.ws.onclose = null;
            CamState.ws.close(1000);
            CamState.ws = null;
        }
        CamState.connected = false;
        updateConnectionStatus('disconnected');
    }

    function scheduleReconnect() {
        if (CamState.reconnecting) return;
        if (CamState.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.warn('[CameraControl] 达到最大重连次数，停止重连');
            return;
        }

        CamState.reconnecting = true;
        CamState.reconnectAttempts++;
        console.log(`[CameraControl] ${RECONNECT_DELAY/1000}秒后重连... (${CamState.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(() => {
            CamState.reconnecting = false;
            connect();
        }, RECONNECT_DELAY);
    }

    // ================= 消息处理 =================

    function handleMessage(data) {
        try {
            const msg = JSON.parse(data);

            // 预览帧推送
            if (msg.type === 'preview_frame') {
                const side = msg.side;
                CamState.previewFrames[side] = msg.frame;
                if (CamState.onPreviewFrame) {
                    CamState.onPreviewFrame(side, msg.frame);
                }
                return;
            }

            // 录制状态推送
            if (msg.type === 'recording_status') {
                if (CamState.onRecordingStatus) {
                    CamState.onRecordingStatus(msg);
                }
                return;
            }

            // 状态推送
            if (msg.type === 'status') {
                // 更新本地状态
                if (msg.cameras) {
                    for (const side of ['left', 'right']) {
                        if (msg.cameras[side]) {
                            CamState.cameras[side].configured = true;
                            CamState.cameras[side].device_name = msg.cameras[side].device_name;
                        }
                    }
                }
                if (msg.captures) {
                    for (const side of ['left', 'right']) {
                        CamState.cameras[side].opened = !!(msg.captures[side] && msg.captures[side].running);
                    }
                }
                if (CamState.onCameraStateChange) {
                    CamState.onCameraStateChange(msg);
                }
                return;
            }

            // 命令响应（通过 request_id 匹配）
            if (msg.request_id && CamState.pendingCommands[msg.request_id]) {
                const { resolve } = CamState.pendingCommands[msg.request_id];
                delete CamState.pendingCommands[msg.request_id];
                resolve(msg);
                return;
            }

            // 其他未匹配的响应
            // console.log('[CameraControl] 未处理的消息:', msg);

        } catch (e) {
            console.error('[CameraControl] 解析消息失败:', e);
        }
    }

    // ================= 命令发送 =================

    let _requestIdCounter = 0;

    /**
     * 发送命令并等待响应
     */
    function sendCommand(command, data = {}, timeout = 10000) {
        return new Promise((resolve, reject) => {
            if (!CamState.ws || CamState.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('Camera Server 未连接'));
                return;
            }

            if (Object.keys(CamState.pendingCommands).length >= 32) {
                reject(new Error('相机命令队列已满'));
                return;
            }
            const requestId = `cmd_${++_requestIdCounter}_${Date.now()}`;
            const payload = {
                command,
                request_id: requestId,
                ...data
            };

            // 超时处理
            const timer = setTimeout(() => {
                delete CamState.pendingCommands[requestId];
                reject(new Error(`命令 ${command} 超时`));
            }, timeout);

            CamState.pendingCommands[requestId] = {
                resolve: (response) => {
                    clearTimeout(timer);
                    resolve(response);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                }
            };

            try {
                CamState.ws.send(JSON.stringify(payload));
            } catch (err) {
                clearTimeout(timer);
                delete CamState.pendingCommands[requestId];
                reject(err);
            }
        });
    }

    /**
     * 发送命令（不等待响应，适用于订阅/取消订阅等）
     */
    function sendCommandFireAndForget(command, data = {}) {
        if (!CamState.ws || CamState.ws.readyState !== WebSocket.OPEN) {
            console.warn('[CameraControl] 未连接，无法发送:', command);
            return;
        }
        const payload = { command, ...data };
        try {
            CamState.ws.send(JSON.stringify(payload));
        } catch (err) {
            console.error('[CameraControl] 发送失败:', err);
        }
    }

    // ================= 公共 API =================

    /**
     * 扫描摄像头设备列表
     */
    async function scanCameras() {
        console.log('[CameraControl] 扫描摄像头...');
        try {
            const result = await sendCommand('list_cameras', {}, 15000);
            if (result.success && result.devices) {
                CamState.scannedDevices = result.devices;
                if (CamState.onScanResult) {
                    CamState.onScanResult(result.devices);
                }
            }
            return result;
        } catch (err) {
            console.error('[CameraControl] 扫描失败:', err);
            return { success: false, error: err.message, devices: [] };
        }
    }

    /**
     * 设置摄像头配置
     */
    async function setCamera(side, deviceName, deviceId) {
        console.log(`[CameraControl] 设置${side}侧摄像头:`, deviceName);
        try {
            const result = await sendCommand('set_camera', {
                side,
                device_name: deviceName,
                device_id: deviceId || deviceName
            });
            if (result.success) {
                CamState.cameras[side].configured = true;
                CamState.cameras[side].device_name = deviceName;
                CamState.cameras[side].device_id = deviceId || deviceName;
            }
            return result;
        } catch (err) {
            console.error(`[CameraControl] 设置${side}摄像头失败:`, err);
            return { success: false, error: err.message };
        }
    }

    /**
     * 打开摄像头（开始MJPEG采集 + 预览）
     */
    async function openCamera(side) {
        console.log(`[CameraControl] 打开${side}侧摄像头...`);
        try {
            const result = await sendCommand('open_camera', { side });
            if (result.success) {
                CamState.cameras[side].opened = true;
                // open_camera 会自动订阅预览
            }
            return result;
        } catch (err) {
            console.error(`[CameraControl] 打开${side}摄像头失败:`, err);
            return { success: false, error: err.message };
        }
    }

    /**
     * 关闭摄像头（停止MJPEG采集）
     */
    async function closeCamera(side) {
        console.log(`[CameraControl] 关闭${side}侧摄像头...`);
        try {
            // 先取消订阅
            sendCommandFireAndForget('unsubscribe_preview', { side });
            const result = await sendCommand('close_camera', { side }, 30000);
            if (result.success) {
                CamState.cameras[side].opened = false;
                CamState.previewFrames[side] = null;
            }
            return result;
        } catch (err) {
            console.error(`[CameraControl] 关闭${side}摄像头失败:`, err);
            return { success: false, error: err.message };
        }
    }

    /**
     * 按需拍照 — 获取一帧最新画面（不走推送流）
     * 后端优先返回 CameraCapture 缓存的实时帧，否则运行一次性 ffmpeg 抓帧（~1-2s）
     */
    async function captureSnapshot(side) {
        console.log(`[CameraControl] 📸 ${side}侧 拍照...`);
        try {
            const result = await sendCommand('capture_snapshot', { side }, 12000);
            if (result.success) {
                CamState.previewFrames[side] = result.frame;
            }
            return result;
        } catch (err) {
            console.error(`[CameraControl] ${side}拍照失败:`, err);
            return { success: false, error: err.message };
        }
    }

    /**
     * 订阅预览帧（如果摄像头已打开但未自动订阅）
     */
    function subscribePreview(side) {
        sendCommandFireAndForget('subscribe_preview', { side });
    }

    /**
     * 取消预览帧订阅
     */
    function unsubscribePreview(side) {
        sendCommandFireAndForget('unsubscribe_preview', { side });
    }

    /**
     * 获取最新预览帧
     */
    function getPreviewFrame(side) {
        return CamState.previewFrames[side];
    }

    /**
     * 获取摄像头状态
     */
    function getCameraState(side) {
        if (side) return CamState.cameras[side];
        return CamState.cameras;
    }

    async function getStatus() {
        try {
            return await sendCommand('get_status', {}, 5000);
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    async function setVideoCollectionActive(active, data = {}) {
        try {
            return await sendCommand('set_video_collection_active', {
                active: !!active,
                ...data
            }, 5000);
        } catch (err) {
            console.warn('[CameraControl] 设置视频采集活跃标记失败:', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * 检查是否已连接
     */
    function isConnected() {
        return CamState.connected;
    }

    // ================= UI 辅助 =================

    function updateConnectionStatus(status) {
        const badge = document.getElementById('cameraStreamStatus');
        const hint = document.getElementById('cameraStreamHint');

        if (badge) {
            switch (status) {
                case 'connected':
                    badge.className = 'status-badge connected';
                    badge.textContent = '就绪';
                    break;
                case 'connecting':
                    badge.className = 'status-badge';
                    badge.textContent = '连接中...';
                    break;
                case 'disconnected':
                default:
                    badge.className = 'status-badge disconnected';
                    badge.textContent = '未连接';
                    break;
            }
        }

        if (hint) {
            switch (status) {
                case 'connected':
                    hint.textContent = '点击配置并打开摄像头';
                    break;
                case 'connecting':
                    hint.textContent = '正在连接Camera服务器...';
                    break;
                default:
                    hint.textContent = 'Camera服务器未连接';
                    break;
            }
        }
    }

    // ================= 全局初始化 =================

    function init() {
        console.log('[CameraControl] 初始化...');

        // 自动连接
        connect();

        console.log('[CameraControl] 初始化完成');
    }

    // DOM 加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /**
     * 清空所有缓存的预览帧
     */
    function clearPreviewFrames() {
        CamState.previewFrames.left = null;
        CamState.previewFrames.right = null;
        console.log('[CameraControl] 预览帧缓存已清空');
    }

    // ================= 暴露全局 API =================
    window.CameraControl = {
        // 连接管理
        connect,
        disconnect,
        isConnected,

        // 命令
        scanCameras,
        setCamera,
        openCamera,
        closeCamera,
        getStatus,
        setVideoCollectionActive,
        subscribePreview,
        unsubscribePreview,
        captureSnapshot,

        // 状态
        getPreviewFrame,
        getCameraState,
        getScannedDevices: () => CamState.scannedDevices,
        clearPreviewFrames,

        // 回调
        set onPreviewFrame(cb) { CamState.onPreviewFrame = cb; },
        set onScanResult(cb) { CamState.onScanResult = cb; },
        set onStatusChange(cb) { CamState.onStatusChange = cb; },
        set onError(cb) { CamState.onError = cb; },
        set onCameraStateChange(cb) { CamState.onCameraStateChange = cb; },
        set onRecordingStatus(cb) { CamState.onRecordingStatus = cb; },

        // 状态对象（只读）
        get state() { return { ...CamState }; }
    };

    console.log('[CameraControl] 模块加载完成，全局 API: window.CameraControl');

})();
