/**
 * bleControl.js - 前端蓝牙控制模块
 * ==================================
 * 
 * 与 ble_server_final.py 的控制端口 (8765) 通信
 * 用于 index.html 控制蓝牙设备的连接/断开/采集
 * 
 * 使用方法：
 *   在 HTML 中引入: <script src="bleControl.js"></script>
 *   会自动初始化并绑定到页面元素
 */

(function() {
    'use strict';

    // ================= 配置 =================
    const WS_URL = 'ws://localhost:8764';  // 控制端口
    const RECONNECT_DELAY = 1000;  // 1秒重连，加快连接速度
    const HEARTBEAT_INTERVAL = 30000;
    const STATUS_UPDATE_INTERVAL = 5000;  // 【新增】状态更新间隔：5秒（用于电池和流模式显示）
    const MAX_RECONNECT_ATTEMPTS = 10;  // 【新增】最大重连次数
    const BLE_CONNECT_UI_TIMEOUT_MS = 30000;

    // ================= 状态 =================
    const BleState = {
        ws: null,
        connected: false,
        reconnecting: false,
        reconnectAttempts: 0,  // 【新增】重连次数计数
        heartbeatTimer: null,
        statusUpdateTimer: null,  // 【新增】状态更新定时器

        // 设备状态
        devices: {
            1: { connected: false, streaming: false, mac: null, name: null, rssi: null, num_imus: null, hw_version: null },
            2: { connected: false, streaming: false, mac: null, name: null, rssi: null, num_imus: null, hw_version: null },
        },
        imuWarningShown: {
            1: false,
            2: false,
        },
        connectingDevices: {
            1: { active: false, startedAt: 0, timer: null, mac: null },
            2: { active: false, startedAt: 0, timer: null, mac: null },
        },

        // 扫描结果
        scannedDevices: [],

        // 回调
        onStatusChange: null,
        onDeviceChange: null,
        onScanResult: null,
        onError: null,
    };

    let requestSequence = 0;
    const commandQueue = [];
    function rejectCommands(reason) {
        const pending = BleState._pendingResponse;
        delete BleState._pendingResponse;
        if (pending) { clearTimeout(pending.timeoutId); pending.reject(new Error(reason)); }
        for (const command of commandQueue.splice(0)) command.reject(new Error(reason));
    }
    function pumpCommands() {
        if (BleState._pendingResponse || !commandQueue.length) return;
        const command = commandQueue.shift();
        const requestId = `ble_${Date.now()}_${++requestSequence}`;
        const pending = { ...command, requestId };
        BleState._pendingResponse = pending;
        pending.timeoutId = setTimeout(() => {
            if (BleState._pendingResponse !== pending) return;
            delete BleState._pendingResponse;
            pending.reject(new Error(`BLE 命令超时: ${pending.action}`));
            pumpCommands();
        }, command.timeoutMs);
        if (!send({ ...command.extraData, action: command.action, request_id: requestId })) {
            clearTimeout(pending.timeoutId);
            delete BleState._pendingResponse;
            pending.reject(new Error(`BLE 未连接，无法发送: ${command.action}`));
            pumpCommands();
        }
    }

    // ================= WebSocket 连接 =================

    function connect() {
        // 如果已经连接或正在连接，直接返回
        if (BleState.ws && (BleState.ws.readyState === WebSocket.OPEN || BleState.ws.readyState === WebSocket.CONNECTING)) {
            console.log('[BLE] 已经连接或正在连接，跳过');
            return;
        }

        // 【修复】如果正在重连中，跳过
        if (BleState.reconnecting) {
            console.log('[BLE] 正在重连中，跳过');
            return;
        }

        // 清理旧的 WebSocket 对象
        if (BleState.ws) {
            console.log('[BLE] 清理旧连接, readyState:', BleState.ws.readyState);
            BleState.ws.onopen = null;
            BleState.ws.onclose = null;
            BleState.ws.onerror = null;
            BleState.ws.onmessage = null;
            BleState.ws = null;
        }

        console.log('[BLE] 连接服务器:', WS_URL);
        updateServerStatus('connecting');

        try {
            BleState.ws = new WebSocket(WS_URL);

            BleState.ws.onopen = () => {
                console.log('[BLE] ✅ 已连接到BLE服务器');
                BleState.connected = true;
                BleState.reconnecting = false;
                BleState.reconnectAttempts = 0;  // 【修复】重置重连计数
                updateServerStatus('connected');
                startHeartbeat();
            };

            BleState.ws.onclose = (event) => {
                console.log('[BLE] 连接关闭, code:', event.code, 'reason:', event.reason);
                rejectCommands('BLE 连接已断开');
                BleState.connected = false;
                BleState.ws = null;
                updateServerStatus('disconnected');
                stopHeartbeat();

                // 【新增】BLE 服务器断开后隐藏质量颜色指示
                if (window.waveformController) {
                    window.waveformController.refreshQualityVisibility();
                }

                // 【修复】只在非主动关闭时重连
                if (event.code !== 1000) {
                    scheduleReconnect();
                }
            };

            BleState.ws.onerror = (err) => {
                console.error('[BLE] WebSocket 错误');
                if (BleState.onError) {
                    BleState.onError('WebSocket 连接错误');
                }
            };

            BleState.ws.onmessage = (event) => {
                handleMessage(event.data);
            };

        } catch (err) {
            console.error('[BLE] 连接失败:', err);
            BleState.ws = null;
            scheduleReconnect();
        }
    }

    function disconnect() {
        rejectCommands('BLE 连接已关闭');
        BleState.reconnecting = false;
        stopHeartbeat();
        if (BleState.ws) {
            BleState.ws.onclose = null; // 防止触发重连
            BleState.ws.close();
            BleState.ws = null;
        }
        BleState.connected = false;
    }

    function scheduleReconnect() {
        if (BleState.reconnecting) {
            console.log('[BLE] 已在重连队列中，跳过');
            return;
        }

        // 【修复】检查重连次数
        if (BleState.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.warn('[BLE] 达到最大重连次数，停止重连');
            return;
        }

        BleState.reconnecting = true;
        BleState.reconnectAttempts++;
        console.log(`[BLE] ${RECONNECT_DELAY/1000}秒后重连... (尝试 ${BleState.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(() => {
            BleState.reconnecting = false; // 重置标志，允许下次重连
            connect();
        }, RECONNECT_DELAY);
    }
    
    function startHeartbeat() {
        stopHeartbeat();
        BleState.heartbeatTimer = setInterval(() => {
            if (BleState.connected) {
                send({ action: 'ping' });  // 心跳用ping，保持连接
            }
        }, HEARTBEAT_INTERVAL);

        // 【新增】启动状态更新定时器（用于电池和流模式显示）
        BleState.statusUpdateTimer = setInterval(() => {
            if (BleState.connected) {
                send({ action: 'status' });  // 定期获取设备状态
            }
        }, STATUS_UPDATE_INTERVAL);

        // 首次立即获取状态
        if (BleState.connected) {
            send({ action: 'status' });
        }
    }

    function stopHeartbeat() {
        if (BleState.heartbeatTimer) {
            clearInterval(BleState.heartbeatTimer);
            BleState.heartbeatTimer = null;
        }
        if (BleState.statusUpdateTimer) {
            clearInterval(BleState.statusUpdateTimer);
            BleState.statusUpdateTimer = null;
        }
    }

    // ================= 消息处理 =================
    
    function send(data) {
        if (!BleState.ws || BleState.ws.readyState !== WebSocket.OPEN) {
            console.warn('[BLE] 未连接，无法发送, readyState:', BleState.ws?.readyState);
            return false;
        }
        console.log('[BLE] 发送命令:', data);
        BleState.ws.send(JSON.stringify(data));
        return true;
    }
    
async function handleMessage(rawData) {
    try {
        let msg;
        
        console.log('liangji start handleMessage');
        // 支持 MessagePack 和 JSON
        if (rawData instanceof Blob) {
            console.log('liangji rawData = Blob');
            const buffer = await rawData.arrayBuffer();
            msg = await decodeData(buffer); // 抽离解码逻辑，提高复用性
        } else if (rawData instanceof ArrayBuffer) {
            console.log('liangji rawData = ArrayBuffer');
            msg = await decodeData(rawData);
        } else {
            console.log('liangji rawData = JSON');
            // 先判断是否是字符串，避免非字符串类型传入 JSON.parse
            if (typeof rawData === 'string') {
                msg = JSON.parse(rawData);
            } else {
                throw new Error('非字符串类型无法解析为 JSON');
            }
        }
        
        console.log('[BLE] 收到:', msg);
        
        if (msg.type === 'response') {
            handleResponse(msg);
        } else if (msg.type === 'event') {
            handleEvent(msg);
        } else if (msg.type === 'welcome') {
            handleWelcome(msg);
        }
        
    } catch (err) {
        console.error('[BLE] 消息解析错误:', err);
    }
}

// 抽离解码逻辑，单独处理 msgpack 和 JSON 降级
async function decodeData(buffer) {
    // 1. 优先尝试 msgpack 解码（核心修复：增加 msgpack 解码失败的容错）
    if (typeof msgpack !== 'undefined' && msgpack?.decode) {
        try {
            return msgpack.decode(new Uint8Array(buffer));
        } catch (msgpackErr) {
            console.warn('[BLE] msgpack 解码失败，尝试 JSON 解析:', msgpackErr);
        }
    } else {
        console.warn('[BLE] msgpack 库未加载，直接尝试 JSON 解析');
    }
    
    // 2. msgpack 解码失败/库不存在时，降级为 JSON 解析
    try {
        const text = new TextDecoder().decode(buffer);
        return JSON.parse(text);
    } catch (jsonErr) {
        throw new Error(`JSON 解析也失败：${jsonErr.message}，原始数据长度：${buffer.byteLength}`);
    }
}
    
    function handleWelcome(msg) {
        console.log('[BLE] 欢迎消息:', msg.message);
        
        // 更新设备状态
        if (msg.dev1) updateDeviceState(1, msg.dev1);
        if (msg.dev2) updateDeviceState(2, msg.dev2);
        
        // 更新 UI
        updateAllUI();
    }
    
    function handleResponse(msg) {
        const action = msg.action;

        // 【新增】检查是否有待处理的 Promise 响应
        if (BleState._pendingResponse && BleState._pendingResponse.requestId === msg.request_id) {
            const pending = BleState._pendingResponse;
            clearTimeout(pending.timeoutId);
            delete BleState._pendingResponse;
            if (msg.success !== false) {
                pending.resolve(msg);
            } else {
                pending.reject(new Error(msg.error || `BLE 命令失败: ${action}`));
            }
            pumpCommands();
            // 即使有 pending response，仍然继续执行下面的 UI 更新逻辑
        }

        // 扫描结果
        if (action === 'scan') {
            console.log('liangji scan over');
            if (msg.success) {
                console.log('liangji scan success');
                BleState.scannedDevices = msg.devices || [];
                updateDeviceSelects();
                showToast(`发现 ${msg.count} 个设备`);
            } else {
                console.log('liangji scan fail');
                showToast('扫描失败: ' + msg.error, 'error');
            }
            console.log('liangji updateScanButton');
            updateScanButton(false);
        }
        
        // 连接结果
        else if (action.startsWith('connect')) {
            const deviceId = parseInt(action.slice(-1));
            
            if (msg.success === true) {
                clearDeviceConnecting(deviceId);
                BleState.devices[deviceId] = {
                    connected: true,
                    streaming: false,
                    mac: msg.mac,
                    name: msg.name,
                    rssi: msg.rssi,
                    battery_percent: msg.battery_percent || 0,
                    stream_mode: msg.stream_mode || 'idle',
                    num_imus: Number.isFinite(msg.num_imus) ? msg.num_imus : null,
                    hw_version: msg.hw_version || null,
                };
                updateDeviceStatusWidget(deviceId, BleState.devices[deviceId]);
                checkImuCount(deviceId, BleState.devices[deviceId]);
                if (BleState.onDeviceChange) {
                    BleState.onDeviceChange(deviceId, BleState.devices[deviceId]);
                }
                updateDeviceUI(deviceId);
                showToast(`设备 ${deviceId} 连接成功`);
            } else if (msg.success === false) {
                clearDeviceConnecting(deviceId);
                updateDeviceUI(deviceId);
                showToast(`设备 ${deviceId} 连接失败: ${msg.error}`, 'error');
            } else {
                // 连接中
                setDeviceConnecting(deviceId, msg.mac || BleState.connectingDevices[deviceId].mac, msg.message);
            }
            updateConnectButton(deviceId, msg.success !== null);
        }
        
        // 断开结果
        else if (action.startsWith('disconnect')) {
            const deviceId = parseInt(action.slice(-1));
            
            if (msg.success) {
                BleState.devices[deviceId] = {
                    connected: false,
                    streaming: false,
                    mac: null,
                    name: null,
                    rssi: null,
                    battery_percent: 0,
                    stream_mode: 'idle',
                    num_imus: null,
                    hw_version: null,
                };
                BleState.imuWarningShown[deviceId] = false;
                updateDeviceStatusWidget(deviceId, BleState.devices[deviceId]);
                if (BleState.onDeviceChange) {
                    BleState.onDeviceChange(deviceId, BleState.devices[deviceId]);
                }
                updateDeviceUI(deviceId);
                showToast(`设备 ${deviceId} 已断开`);
            } else {
                showToast('断开失败: ' + msg.error, 'error');
            }
            updateConnectButton(deviceId, true);
        }
        
        // 开始采集
        else if (action.startsWith('start')) {
            const deviceId = action === 'start_all' ? 0 : parseInt(action.slice(-1));
            
            if (msg.success) {
                if (deviceId === 0) {
                    // start_all
                    (msg.started || []).forEach(id => {
                        BleState.devices[id].streaming = true;
                    });
                } else {
                    BleState.devices[deviceId].streaming = true;
                }
                updateAllUI();
                showToast('采集已开始');
            } else {
                showToast('启动失败: ' + msg.error, 'error');
            }
        }
        
        // 停止采集
        else if (action.startsWith('stop')) {
            const deviceId = action === 'stop_all' ? 0 : parseInt(action.slice(-1));
            
            if (msg.success) {
                if (deviceId === 0) {
                    BleState.devices[1].streaming = false;
                    BleState.devices[2].streaming = false;
                } else {
                    BleState.devices[deviceId].streaming = false;
                }
                updateAllUI();
                showToast('采集已停止');
            } else {
                showToast('停止失败: ' + msg.error, 'error');
            }
        }
        
        // 状态
        else if (action === 'status') {
            if (msg.dev1) updateDeviceState(1, msg.dev1);
            if (msg.dev2) updateDeviceState(2, msg.dev2);
            updateAllUI();
        }

        else if (action === 'welcome') {
            console.log('welcome msg: connected to websocket server', msg);
        }
        
        // 回调
        if (BleState.onStatusChange) {
            BleState.onStatusChange(action, msg);
        }
    }
    
    function handleEvent(msg) {
        const event = msg.event;
        console.log('[BLE] 事件:', event, msg);
        
        if (event === 'device_connected') {
            // 外部连接事件（其他控制端触发）
        } else if (event === 'device_disconnected') {
            // 外部断开事件
        } else if (event === 'stream_started' || event === 'stream_stopped') {
            // 采集状态变更
            updateAllUI();
        }
    }
    
    function updateDeviceState(deviceId, data) {
        BleState.devices[deviceId] = {
            connected: data.connected,
            streaming: data.streaming,
            mac: data.mac,
            name: data.name,
            rssi: data.rssi,
            battery_percent: data.battery_percent || 0,
            stream_mode: data.stream_mode || 'idle',
            num_imus: Number.isFinite(data.num_imus) ? data.num_imus : null,
            hw_version: data.hw_version || null,
            firmware_version: data.firmware_version || null,
            hardware_version: data.hardware_version || null,
        };

        // 更新设备状态悬浮窗口
        updateDeviceStatusWidget(deviceId, BleState.devices[deviceId]);
        checkImuCount(deviceId, BleState.devices[deviceId]);

        // 通知设备状态变化回调
        if (BleState.onDeviceChange) {
            BleState.onDeviceChange(deviceId, BleState.devices[deviceId]);
        }
    }

    // ================= UI 更新 =================
    
    function updateDeviceStatusWidget(deviceId, device) {
        if (!window.deviceStatusWidget) return;

        window.deviceStatusWidget.updateDevice(deviceId, {
            connected: !!device.connected,
            battery_percent: device.battery_percent || 0,
            stream_mode: device.stream_mode || 'idle',
            num_imus: Number.isFinite(device.num_imus) ? device.num_imus : null,
            hw_version: device.hw_version || null,
        });
    }

    function checkImuCount(deviceId, device) {
        if (!device || !device.connected) {
            BleState.imuWarningShown[deviceId] = false;
            return;
        }

        const numImus = Number.isFinite(device.num_imus) ? device.num_imus : null;
        const isV2 = String(device.hw_version || '').toUpperCase() === 'V2';
        if (!isV2) {
            BleState.imuWarningShown[deviceId] = false;
            return;
        }

        if (numImus === null || numImus === 0) {
            return;
        }

        if (numImus === 3) {
            BleState.imuWarningShown[deviceId] = false;
            return;
        }

        if (!BleState.imuWarningShown[deviceId]) {
            BleState.imuWarningShown[deviceId] = true;
            const warning = `设备 ${deviceId} 检测到 V2 IMU数量=${numImus}（期望3个），采集将继续进行`;
            showToast(warning, 'warning');
        }
    }

    function updateServerStatus(status) {
        const el = document.getElementById('serverStatus');
        if (el) {
            el.className = 'status-badge ' + status;
            el.textContent = {
                connected: '已连接',
                connecting: '连接中',
                disconnected: '未连接'
            }[status] || status;
        }

        // 【新增】控制端状态变化时，更新扫描按钮状态
        updateScanButton(false);
    }
    
    function updateScanButton(scanning) {
        const btn = document.getElementById('scanAllBtn');
        if (btn) {
            // 【修改】扫描按钮只需要控制端连接即可（8764端口）
            // 数据端（8080端口）是用于波形显示的，扫描蓝牙不需要
            const controlConnected = BleState.connected;
            const connecting = anyDeviceConnecting();
            btn.disabled = scanning || !controlConnected || connecting;
            btn.innerHTML = scanning
                ? '<i class="fas fa-spinner fa-spin"></i> 扫描中'
                : '<i class="fas fa-search"></i> 扫描';

            // 【新增】如果控制端未连接，显示提示
            if (!controlConnected && !scanning) {
                btn.title = '等待BLE服务器连接...';
            } else if (connecting && !scanning) {
                btn.title = '正在连接手环，请等待连接完成后再扫描';
            } else {
                btn.title = '';
            }
        }
    }

    /**
     * 【新增】检查所有连接是否就绪（控制端 + 数据端）
     * 注意：此函数保留供其他功能使用，扫描按钮只需要控制端连接
     */
    function checkAllConnectionsReady() {
        // 检查控制端连接（ble_control.js 自身的 WebSocket）
        const controlConnected = BleState.connected;

        // 检查数据端连接（waveform.js 的 dataReceiver）
        const dataConnected = window.waveformController?.dataReceiver?.isConnected || false;

        console.log(`[BLE] 连接状态检查: 控制端=${controlConnected}, 数据端=${dataConnected}`);

        return controlConnected && dataConnected;
    }
    
    function updateDeviceSelects() {
        const devices = BleState.scannedDevices;
        
        const opts = '<option value="">请选择设备...</option>' + 
            devices.map(d => {
                const isTarget = d.name === 'ESP32S3_EMG' ? ' ★' : '';
                return `<option value="${d.mac}">${d.name} (${d.rssi}dBm)${isTarget}</option>`;
            }).join('');
        
        const select1 = document.getElementById('device1Select');
        const select2 = document.getElementById('device2Select');
        
        if (select1) {
            select1.innerHTML = opts;
            select1.disabled = false;
        }
        if (select2) {
            select2.innerHTML = opts;
            select2.disabled = false;
        }
        
        // 回调
        if (BleState.onScanResult) {
            BleState.onScanResult(devices);
        }
    }

    function anyDeviceConnecting() {
        return BleState.connectingDevices[1].active || BleState.connectingDevices[2].active;
    }

    function setDeviceConnecting(deviceId, mac, message) {
        const state = BleState.connectingDevices[deviceId];
        if (!state.active) {
            state.startedAt = Date.now();
        }
        state.active = true;
        state.mac = mac || state.mac;
        state.message = message || '正在等待蓝牙连接返回...';

        if (!state.timer) {
            state.timer = setInterval(() => updateConnectingUI(deviceId), 1000);
        }

        updateDeviceStatus(deviceId, 'connecting');
        updateConnectingUI(deviceId);
        updateConnectButton(1, false);
        updateConnectButton(2, false);
    }

    function clearDeviceConnecting(deviceId) {
        const state = BleState.connectingDevices[deviceId];
        if (state.timer) {
            clearInterval(state.timer);
        }
        state.active = false;
        state.startedAt = 0;
        state.timer = null;
        state.mac = null;
        state.message = '';
        updateConnectButton(1, true);
        updateConnectButton(2, true);
    }

    function updateConnectingUI(deviceId) {
        const state = BleState.connectingDevices[deviceId];
        if (!state.active) return;

        const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
        const btn = document.getElementById(`connect${deviceId}Btn`);
        if (btn) {
            btn.disabled = true;
            btn.className = 'bt-connect-btn connect';
            btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> 连接中 ${elapsed}s`;
            btn.title = state.message || '正在等待蓝牙连接返回';
        }

        const nameEl = document.getElementById(`device${deviceId}Name`);
        if (nameEl) {
            nameEl.textContent = state.message || `正在连接... ${elapsed}s`;
        }

        if (elapsed * 1000 >= BLE_CONNECT_UI_TIMEOUT_MS) {
            clearDeviceConnecting(deviceId);
            updateDeviceStatus(deviceId, 'disconnected');
            showToast(`设备 ${deviceId} 连接等待超时，请重启手环或重新扫描后再试`, 'error');
        }
    }
    
    function updateDeviceUI(deviceId) {
        if (BleState.connectingDevices[deviceId].active) {
            updateDeviceStatus(deviceId, 'connecting');
            updateConnectingUI(deviceId);
            return;
        }

        const dev = BleState.devices[deviceId];
        
        updateDeviceStatus(deviceId, dev.connected ? 'connected' : 'disconnected');
        updateDeviceInfo(deviceId, dev);
        updateConnectButton(deviceId, true);

        // 【新增】设备状态变化时刷新质量颜色指示
        if (window.waveformController) {
            window.waveformController.refreshQualityVisibility();
        }
    }

    function updateDeviceStatus(deviceId, status) {
        const el = document.getElementById(`slot${deviceId}Status`);
        const slotEl = document.getElementById(`btSlot${deviceId}`);
        
        if (el) {
            el.className = 'status-badge ' + status;
            el.textContent = {
                connected: '已连接',
                connecting: '连接中',
                disconnected: '未连接'
            }[status] || status;
        }
        
        if (slotEl) {
            slotEl.classList.remove('connected');
            if (status === 'connected') {
                slotEl.classList.add('connected');
            }
        }
    }
    
    function updateDeviceInfo(deviceId, dev) {
        const nameEl = document.getElementById(`device${deviceId}Name`);
        const rssiEl = document.getElementById(`device${deviceId}RSSI`);
        const signalEl = document.getElementById(`device${deviceId}Signal`);
        
        if (dev && dev.connected) {
            if (nameEl) nameEl.textContent = dev.name || '--';
            if (rssiEl) rssiEl.textContent = dev.rssi ? `${dev.rssi} dBm` : '-- dBm';
            if (signalEl) {
                const pct = dev.rssi ? Math.max(0, Math.min(100, ((dev.rssi + 90) / 60) * 100)) : 0;
                signalEl.style.width = pct + '%';
            }
        } else {
            if (nameEl) nameEl.textContent = '--';
            if (rssiEl) rssiEl.textContent = '-- dBm';
            if (signalEl) signalEl.style.width = '0%';
        }
    }
    
    function updateConnectButton(deviceId, enabled) {
        const btn = document.getElementById(`connect${deviceId}Btn`);
        const dev = BleState.devices[deviceId];
        const connecting = BleState.connectingDevices[deviceId].active;
        const blockedByOther = anyDeviceConnecting() && !connecting;
        
        if (btn) {
            btn.disabled = !enabled || connecting || blockedByOther;
            
            if (connecting) {
                updateConnectingUI(deviceId);
            } else if (dev.connected) {
                btn.innerHTML = '<i class="fas fa-unlink"></i> 断开';
                btn.className = 'bt-connect-btn disconnect';
                btn.title = blockedByOther ? '等待另一只手环连接完成' : '';
            } else {
                btn.innerHTML = '<i class="fas fa-link"></i> 连接';
                btn.className = 'bt-connect-btn connect';
                btn.title = blockedByOther ? '等待另一只手环连接完成' : '';
            }
        }
    }
    
    function updateAllUI() {
        updateDeviceUI(1);
        updateDeviceUI(2);
    }
    
    function showToast(msg, type = 'success') {
        // 使用页面已有的 toast 函数
        if (typeof window.showToast === 'function') {
            window.showToast(msg, type);
        } else {
            // 简易 toast
            const toast = document.getElementById('toast');
            if (toast) {
                let msgEl = document.getElementById('toastMessage');
                let icon = toast.querySelector('i');

                // 如果 #toastMessage 被其他模块的 innerHTML 销毁，重建结构
                if (!msgEl || !icon) {
                    toast.innerHTML = '<i class="fas fa-check-circle"></i> <span id="toastMessage"></span>';
                    msgEl = document.getElementById('toastMessage');
                    icon = toast.querySelector('i');
                }

                toast.className = `toast ${type}`;
                if (msgEl) msgEl.textContent = msg;
                if (icon) {
                    const iconMap = { success: 'fas fa-check-circle', error: 'fas fa-times-circle', warning: 'fas fa-exclamation-triangle', info: 'fas fa-info-circle' };
                    icon.className = iconMap[type] || 'fas fa-exclamation-circle';
                }
                toast.classList.add('visible');
                setTimeout(() => toast.classList.remove('visible'), 2500);
            } else {
                console.log('[Toast]', type, msg);
            }
        }
    }

    // ================= 公开 API =================
    
    const BleControl = {
        // 连接服务器
        connect: connect,
        disconnect: disconnect,
        
        // 发送命令
        send: send,
        
        // 扫描
        scan: () => {
            if (anyDeviceConnecting()) {
                showToast('正在连接手环，请等待连接完成后再扫描', 'warning');
                return false;
            }
            updateScanButton(true);
            const result = send({ action: 'scan' });
            if (!result) {
                updateScanButton(false);
                showToast('未连接到BLE服务器，无法扫描', 'error');
            }
            return result;
        },
        
        // 连接设备
        connectDevice: (deviceId, mac) => {
            setDeviceConnecting(deviceId, mac, '正在等待蓝牙连接返回...');
            const ok = send({ action: `connect${deviceId}`, mac: mac });
            if (!ok) {
                clearDeviceConnecting(deviceId);
                updateDeviceStatus(deviceId, 'disconnected');
                showToast('未连接到BLE服务器，无法连接设备', 'error');
            }
            return ok;
        },
        
        // 断开设备
        disconnectDevice: (deviceId) => {
            updateConnectButton(deviceId, false);
            return send({ action: `disconnect${deviceId}` });
        },
        
        // 开始采集
        startStream: (deviceId) => {
            return send({ action: `start${deviceId}` });
        },
        
        // 停止采集
        stopStream: (deviceId) => {
            return send({ action: `stop${deviceId}` });
        },
        
        // 同时开始/停止
        startAll: () => {
            // 【新增】在开始采集前，先发送会话ID
            const sessionIdInput = document.getElementById('sessionIdInput');
            if (sessionIdInput && sessionIdInput.value.trim()) {
                const sessionId = sessionIdInput.value.trim();
                send({ action: 'set_session_id', session_id: sessionId });
                console.log('[BLE] 已发送会话ID:', sessionId);
            }
            return send({ action: 'start_all' });
        },
        stopAll: () => send({ action: 'stop_all' }),

        // 【新增】Preview / Collection 流管理 API
        // 启动 preview stream（进入采集页时使用）
        startPreviewStream: () => send({ action: 'start_preview_stream' }),
        // 停止 preview stream
        stopPreviewStream: () => send({ action: 'stop_preview_stream' }),
        // 核心：preview → collection 切流（开始采集前使用）
        switchPreviewToCollection: () => send({ action: 'switch_preview_to_collection' }),
        // 核心：collection → preview 切流（采集完成后使用）
        switchCollectionToPreview: () => send({ action: 'switch_collection_to_preview' }),
        // 停止 collection stream
        stopCollectionStream: () => send({ action: 'stop_collection_stream' }),
        // 停止任意活跃流（返回首页/断开连接时使用）
        stopAnyStream: () => send({ action: 'stop_any_stream' }),

        // 【新增】设置会话ID
        setSessionId: (sessionId) => {
            return send({ action: 'set_session_id', session_id: sessionId || '' });
        },

        // 【新增】设置会话ID并等待确认（用于采集流切换前确保 session_id 生效）
        setSessionIdAndWait: (sessionId) => {
            return BleControl.sendAndWait('set_session_id', { session_id: sessionId || '' }, 5000);
        },
        
        // 获取状态
        getStatus: () => send({ action: 'status' }),

        // 【新增】发送命令并等待响应（用于 stream 切换等需要确认的异步操作）
        // 返回 Promise，成功时 resolve(msg)，失败/超时时 reject(error)
        sendAndWait: (action, extraData = {}, timeoutMs = 12000) => {
            return new Promise((resolve, reject) => {
                if (commandQueue.length >= 32) {
                    reject(new Error('BLE 命令队列已满，请等待当前操作完成'));
                    return;
                }
                commandQueue.push({ action, extraData, timeoutMs, resolve, reject });
                pumpCommands();
            });
        },

        // 【新增】检查是否有待处理的响应
        getPendingAction: () => BleState._pendingResponse?.action || null,

        // 状态访问
        get state() { return BleState; },
        get isConnected() { return BleState.connected; },
        get devices() { return BleState.devices; },
        get scannedDevices() { return BleState.scannedDevices; },
        
        // 回调设置
        onStatusChange: (fn) => { BleState.onStatusChange = fn; },
        onDeviceChange: (fn) => { BleState.onDeviceChange = fn; },
        onScanResult: (fn) => { BleState.onScanResult = fn; },
        onError: (fn) => { BleState.onError = fn; },

        // 【新增】更新扫描按钮状态（供外部调用，如 waveform.js）
        updateScanButtonState: () => {
            updateScanButton(false);
        },
    };

    // ================= 初始化 =================
    
    function init() {
        console.log('[BLE] 初始化蓝牙控制模块');

        // 绑定扫描按钮
        const scanBtn = document.getElementById('scanAllBtn');
        if (scanBtn) {
            scanBtn.addEventListener('click', () => BleControl.scan());
            // 【新增】初始化时禁用扫描按钮，等待控制端连接就绪
            scanBtn.disabled = true;
            scanBtn.title = '等待BLE服务器连接...';
        }
        
        // 绑定设备选择
        const select1 = document.getElementById('device1Select');
        const select2 = document.getElementById('device2Select');
        
        if (select1) {
            select1.addEventListener('change', (e) => {
                const btn = document.getElementById('connect1Btn');
                if (btn) btn.disabled = !e.target.value;
            });
        }
        
        if (select2) {
            select2.addEventListener('change', (e) => {
                const btn = document.getElementById('connect2Btn');
                if (btn) btn.disabled = !e.target.value;
            });
        }
        
        /**
         * 检查 BLE/相机 side 匹配约束：
         * - 如果只打开了一侧摄像头，BLE 只能连接对应侧
         * - 如果两侧都开了或都没开，不限制
         * @returns {string|null} 错误消息，null 表示通过
         */
        function checkBleCameraSideMatch(targetBleSide) {
            // 获取相机打开状态
            let camLeft = false, camRight = false;
            if (window.CameraControl) {
                const camState = window.CameraControl.getCameraState();
                camLeft = !!(camState.left && camState.left.opened);
                camRight = !!(camState.right && camState.right.opened);
            }

            // 两侧都开了或都没开 → 不限制
            if (camLeft === camRight) return null;

            // 只有一侧相机打开 → BLE 必须匹配
            const camSide = camLeft ? '左手' : '右手';
            const expectedBleSide = camLeft ? 1 : 2;

            if (targetBleSide !== expectedBleSide) {
                return `只打开了${camSide}摄像头，只能连接${camLeft ? '左手(设备1)' : '右手(设备2)'}腕带`;
            }
            return null;
        }

        // 绑定连接按钮
        const connect1Btn = document.getElementById('connect1Btn');
        const connect2Btn = document.getElementById('connect2Btn');

        if (connect1Btn) {
            connect1Btn.addEventListener('click', () => {
                if (BleState.devices[1].connected) {
                    BleControl.disconnectDevice(1);
                } else {
                    const err = checkBleCameraSideMatch(1);
                    if (err) { showToast(err, 'warning'); return; }
                    const mac = document.getElementById('device1Select')?.value;
                    if (mac) {
                        BleControl.connectDevice(1, mac);
                    } else {
                        showToast('请先选择设备', 'warning');
                    }
                }
            });
        }

        if (connect2Btn) {
            connect2Btn.addEventListener('click', () => {
                if (BleState.devices[2].connected) {
                    BleControl.disconnectDevice(2);
                } else {
                    const err = checkBleCameraSideMatch(2);
                    if (err) { showToast(err, 'warning'); return; }
                    const mac = document.getElementById('device2Select')?.value;
                    if (mac) {
                        BleControl.connectDevice(2, mac);
                    } else {
                        showToast('请先选择设备', 'warning');
                    }
                }
            });
        }
        
        // 检查重复设备选择
        if (select1 && select2) {
            const checkDuplicate = () => {
                const v1 = select1.value;
                const v2 = select2.value;
                
                if (v1 && v1 === v2) {
                    showToast('不能选择相同的设备', 'warning');
                    select2.value = '';
                    const btn = document.getElementById('connect2Btn');
                    if (btn) btn.disabled = true;
                }
            };
            
            select1.addEventListener('change', checkDuplicate);
            select2.addEventListener('change', checkDuplicate);
        }

        // 自动连接服务器
        connect();
    }

    // DOM 加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 【新增】页面刷新/关闭前主动断开WebSocket连接
    window.addEventListener('beforeunload', () => {
        disconnect();
    });

    // 导出到全局
    window.BleControl = BleControl;

})();
