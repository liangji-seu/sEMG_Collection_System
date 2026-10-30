// realtimeEngine.js - v4.2 (新增动捕数据支持)
// 修改: 新增mocap_server连接和数据转发

const WebSocket = require('ws');
const EventEmitter = require('events');
const zmq = require('zeromq');
const { collection_task_name } = require('./constants.js');

const DEFAULT_EMG_GAIN = 1;
const DEFAULT_EMG_GAIN_INDEX = 0;
const DEFAULT_EMG_LSB_UV_24BIT = 0.476837 / 10;

function getSysTimeNode() {
    const nsTimestamp = process.hrtime.bigint();
    const sTimestamp = Number(nsTimestamp) / 1000000000.0;
    return Math.round(sTimestamp * 1000000000) / 1000000000;
}

class RealtimeEngine extends EventEmitter {
    constructor() {
        super();
        this.websocket_server = null;
        this.clients = new Set();
        this.isRunning = false;
        this.dataBuffer = [];
        this.maxBufferSize = 1000;

        // BLE服务器
        this.ble_client = null;
        this.ble_clientUrl = 'ws://localhost:8766';
        this.reconnectInterval = 2000;   // 重连间隔2秒
        this.maxReconnectTimes = 10;     // 最多重连10次
        this.currentReconnectTimes = 0;
        this.reconnectTimer = null;
        this.connectTimeoutTimer = null;

        // 【新增】Mocap服务器
        this.mocap_client = null;
        this.mocap_clientUrl = 'ws://localhost:8767';
        this.mocap_reconnectInterval = 2000;
        this.mocap_maxReconnectTimes = 10;
        this.mocap_currentReconnectTimes = 0;
        this.mocap_reconnectTimer = null;
        this.mocap_connected = false;
        this.mocap_activeChannel = null;

        // 【新增】Camera服务器
        this.camera_client = null;
        this.camera_clientUrl = 'ws://localhost:8768';
        this.camera_reconnectInterval = 2000;
        this.camera_maxReconnectTimes = 10;
        this.camera_currentReconnectTimes = 0;
        this.camera_reconnectTimer = null;
        this.camera_connected = false;
        this.camerasConfigured = false;  // 【新增】摄像头是否已配置

        // 数据包计数
        this.emg_packet_count = 0;
        this.emg_5_packets_count = 0;
        this.dev1_packet_count = 0;
        this.dev2_packet_count = 0;
        this.mocap_packet_count = 0;

        // 【优化】批量发送缓冲区
        this.realtimeDataBuffer = [];
        this.realtimeDataBufferLimit = 3;  // 每3个数据包发送一次（约100ms间隔）
        this.realtimeDataTimer = null;
        this.realtimeDataMaxDelay = 50;    // 最大延迟50ms

        // Storage Server
        this.storage_server_socket = new zmq.Request();  // REP socket 用于控制命令
        this.storage_push_socket = new zmq.Push();       // 【新增】PUSH socket 用于数据发送
        this._configureStorageSockets();
        this.storage_server_host = '127.0.0.1';
        this.storage_server_port = 5555;
        this.storage_data_port = 5556;                   // 【新增】数据端口
        this.storage_connected = false;
        this.storage_push_connected = false;             // 【新增】PUSH连接状态
        this.storageRequestQueue = [];
        this.isStorageRequestPending = false;
        this.h5StorageWarningShown = false;
        // PUSH sends are serialized so close can establish a precise data
        // boundary even though control and data use different ZeroMQ sockets.
        this.storagePushSendChain = Promise.resolve();
        this.storageDataSequence = 0;
        this.storageDataLastSentSequence = 0;
        this.storageDataSendError = null;
        this.storagePushFallbackActive = false;
        this.storageFileToken = null;
        this.collectionCommandChain = Promise.resolve();
        this.collectionState = 'idle';
        this.collectionFault = null;
        this.collectionFaultFinalizePromise = null;
        this.collectionFaultEpoch = 0;
        this.previewDroppedPackets = 0;
        this.previewByteLimit = 1024 * 1024;
        this.storagePushPendingCount = 0;
        this.collectionHealth = null;
        this.collectionHealthTimer = null;
        this.collectionHealthIntervalMs = 1000;
        this.collectionHealthWarningMs = 5000;
        this.collectionHealthPollIntervalMs = 2000;
        this.collectionDiskReserveBytes = 256 * 1024 * 1024;
        this.lastCollectionFaultHealthPollAt = null;
        this.collectionFaultHealthPollInFlight = false;
        this.collectionStorageProgress = null;

        // 采集状态
        this.currentTaskId = null;
        this.currentUser = null;
        this.isCollecting = false;
        this.collectionPaused = false;
        this.collectionConfig = null;
        this.isTestMode = false;  // 【新增】测试模式标志（不保存H5文件）

        // Stage状态
        this.currentStageName = null;
        this.stageFileOpen = false;
        this.stageFileOpening = false;
        this.stageFileOpenPromise = null;
        this.stageFileCreateFailed = false;
        this.stage_start_time = 0;
        this.currentStageNeedMocap = false;  // 【新增】当前stage是否需要动捕数据
        
        // Session状态
        this.currentSessionIndex = 0;
        this.currentSessionNumber = 1;
        this.sessionCount = 3;
        this.isClosingStageFile = false;
        this.activeCloseStageFilePromise = null;

        // 动捕数据存储
        this.saveMocapData = false;

        // 【新增】SD卡bin文件名（用于HDF5溯源）
        this.sd_filenames = { dev1: null, dev2: null };
        // 【新增】BLE设备名称（用于HDF5追溯数据来源）
        this.device_names = { dev1: null, dev2: null };
        this.device_configs = { dev1: null, dev2: null };

        // 【新增】Stream mode 状态（preview/collection 切流方案）
        this.streamMode = 'idle';  // 'idle' | 'preview' | 'collection'
        this.collectionStreamId = null;  // collection stream 的唯一标识（ISO timestamp）
        this.collectionBinFilenames = { dev1: null, dev2: null };  // collection stream 产生的 bin
        this.collectionDataStartTs = 0;
        this.collectionDroppedStaleBlePackets = 0;
        this.streamSwitchDelayMs = 3000;  // STOP→START 延迟（与 ble_server.py 保持一致）
        this.timestampToStartDelayMs = 200;

        // 【新增】录像同步相关
        this.recordingSessionId = null;  // 录像会话ID
        this.isMultiSession = false;     // 是否为多轮次采集

        // 【新增】异常中断冻结状态
        this.abortFreezeActive = false;       // 是否已冻结写入
        this.pendingAbortFreeze = null;       // { interruptedAt, progress }
    }

    start(port = 8080) {
        return new Promise((resolve, reject) => {
            try {
                this.stopping = false;
                if (!this.storage_server_socket || this.storage_server_socket.closed) this.storage_server_socket = new zmq.Request();
                if (!this.storage_push_socket || this.storage_push_socket.closed) this.storage_push_socket = new zmq.Push();
                this._configureStorageSockets();
                this.connectTimeoutTimer = setTimeout(() => this.ble_server_connect(), 0);
                this.mocapConnectTimeoutTimer = setTimeout(() => this.mocap_server_connect(), 0);
                this.cameraConnectTimeoutTimer = setTimeout(() => this.camera_server_connect(), 0);

                this.websocket_server = new WebSocket.Server({ port });

                // 【新增】客户端ID计数器
                let clientIdCounter = 0;

                this.websocket_server.on('connection', (ws, req) => {
                    // 【新增】为每个客户端分配唯一ID
                    const clientId = ++clientIdCounter;
                    ws.clientId = clientId;
                    ws.clientName = `未知客户端#${clientId}`;  // 默认名称，等待客户端自报
                    ws.connectedAt = new Date().toISOString();

                    console.log(`[realtimeEngine] 前端client连接已建立 (ID: ${clientId}, 当前总数: ${this.clients.size + 1})`);
                    this.clients.add(ws);

                    ws.send(JSON.stringify({
                        type: 'connection_established',
                        message: '实时数据连接已建立',
                        timestamp: Date.now(),
                        mocap_connected: this.mocap_connected,
                        clientId: clientId  // 【新增】告知客户端其ID
                    }));

                    ws.on('message', (message) => {
                        this.handleFrontendMessage(message, ws).catch((error) => {
                            console.error('[realtimeEngine] handleFrontendMessage failed:', error);
                        });
                    });

                    ws.on('close', () => {
                        console.log(`[realtimeEngine] 前端WebSocket连接已关闭 (ID: ${ws.clientId}, 名称: ${ws.clientName})`);
                        this.clients.delete(ws);
                    });

                    ws.on('error', (error) => {
                        console.error(`[realtimeEngine] WebSocket错误 (ID: ${ws.clientId}):`, error);
                        this.clients.delete(ws);
                    });
                });

                this.websocket_server.on('listening', () => {
                    console.log(`[realtimeEngine] WebSocket服务运行在端口 ${port}`);
                    this.isRunning = true;
                    resolve();
                });

                this.websocket_server.on('error', (error) => {
                    console.error('[realtimeEngine] WebSocket服务器启动失败:', error);
                    reject(error);
                });

                this.storage_server_connect();

            } catch (error) {
                console.error('[realtimeEngine] 启动失败:', error);
                reject(error);
            }
        });
    }

    handleFrontendMessage(rawMessage, ws) {
        let message;
        try { message = JSON.parse(rawMessage.toString()); }
        catch (error) { return Promise.resolve(); }
        if (message.type === 'client_identify') {
            if (ws && message.clientName) ws.clientName = message.clientName;
            return Promise.resolve();
        }
        if (message.type !== 'control_command') return Promise.resolve();
        const commandFaultEpoch = this.collectionFaultEpoch;
        const execute = async () => {
            const { action, data = {}, commandId } = message;
            try {
                let result;
                if (commandFaultEpoch !== this.collectionFaultEpoch && [
                    'collection_start', 'collection_resume', 'stage_start', 'stage_change',
                    'session_change', 'prompt_start', 'prompt_end', 'prompt'
                ].includes(action)) {
                    throw new Error('该推进命令在上一轮故障前已排队，已取消以防止采集被重新启动');
                }
                const faultBlocksProgress = action === 'collection_start'
                    ? this.collectionState !== 'interrupted'
                    : ['collection_resume', 'stage_start', 'prompt_start', 'prompt_end', 'prompt'].includes(action) ||
                        (['stage_change', 'session_change'].includes(action) && this.collectionState !== 'interrupted');
                if (this.collectionFault && faultBlocksProgress) {
                    throw new Error('本轮发生硬件或存储故障，自动收尾完成前不能继续采集');
                }
                switch (action) {
                    case 'task_change': result = this.onTaskChange(data.taskId); break;
                    case 'collection_start': result = await this.onCollectionStart(data); break;
                    case 'collection_pause': result = this.onCollectionPause(); break;
                    case 'collection_resume': result = this.onCollectionResume(); break;
                    case 'collection_stop':
                    case 'collection_stop_and_wait': result = await this.onCollectionStop(data.completed); break;
                    case 'finalize_incomplete': result = await this.finalizeIncomplete(data); break;
                    case 'retry_collection_fault': result = await this.retryCollectionFault(data); break;
                    case 'session_change': result = this.onSessionChange(data.sessionIndex, data.sessionNumber); break;
                    case 'stage_change': result = this.onStageChange(data.stageIndex, data.stageName); break;
                    case 'stage_start': result = await this.onStageStart(data.stageName, data.stageIndex, data.timestamp, data.needMocap); break;
                    case 'stage_end': result = await this.onStageEnd(data.stageName, data.timestamp); break;
                    case 'prompt_start': result = this.onPromptStart(data.promptName, data.promptIndex); break;
                    case 'prompt_end': result = this.onPromptEnd(data.promptName, data.promptIndex); break;
                    case 'prompt': result = this.onPrompt(data.name, data.stageName, data.timestamp); break;
                    case 'video_recording_started': result = this.onVideoRecordingStarted(data); break;
                    case 'abnormal_interrupt_freeze': result = this.onAbnormalInterruptFreeze(data); break;
                    case 'abnormal_interrupt': result = await this.onAbnormalInterrupt(data); break;
                    case 'camera_set_config': result = await this.onCameraSetConfig(data); break;
                    case 'mocap_set_channel': result = this.onMocapSetChannel(data.channel); break;
                    case 'mocap_reset_channel': result = this.onMocapResetChannel(data.channel, data.value); break;
                    case 'mocap_get_status': result = this.onMocapGetStatus(); break;
                    case 'mocap_set_save': this.saveMocapData = data.save === true; break;
                    case 'mocap_sdk_connect': result = this.onMocapSdkConnect(); break;
                    case 'mocap_sdk_disconnect': result = this.onMocapSdkDisconnect(); break;
                    case 'mocap_sdk_get_status': result = this.onMocapSdkGetStatus(); break;
                    default: throw new Error(`未知命令: ${action}`);
                }
                if (result?.status === 'error') throw new Error(result.msg || result.h5_close?.msg || '采集命令失败');
                this._sendControlResponse(ws, { commandId, action, status: 'success', result });
                return result;
            } catch (error) {
                console.error(`[realtimeEngine] 命令失败 (${action}):`, error);
                this._sendControlResponse(ws, { commandId, action, status: 'error', error: error.message });
                return { status: 'error', msg: error.message };
            }
        };
        // Freeze must interrupt data admission even while a slow camera/storage
        // operation is ahead of us. All other commands share one global order.
        if (message.action === 'abnormal_interrupt_freeze') return execute();
        const pending = this.collectionCommandChain.then(execute, execute);
        this.collectionCommandChain = pending.catch(() => {});
        return pending;
    }

    _sendControlResponse(ws, response) {
        if (!response.commandId || !ws) return;
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
            ws.send(JSON.stringify({ type: 'control_response', ...response, timestamp: Date.now() }), error => {
                if (error) { console.error('[realtimeEngine] 控制应答发送失败:', error); ws.terminate?.(); }
            });
        } catch (error) {
            console.error('[realtimeEngine] 控制应答发送失败:', error);
            ws.terminate?.();
        }
    }

    onTaskChange(taskId) {
        console.log(`[realtimeEngine] ========== 任务切换: ${taskId} ==========`);
        this.currentTaskId = taskId;

        // 【修改】通道映射（删除continual_gesture_3，通道名不带后缀，左右手都会计算）
        const channelMapping = {
            'continual_gesture_1': 'finger_joint_angle',
            'continual_gesture_2': 'thumb_index_distance'
        };
        if (channelMapping[taskId]) {
            this.onMocapSetChannel(channelMapping[taskId]);
        }
    }

    onSessionChange(sessionIndex, sessionNumber) {
        this.currentSessionIndex = sessionIndex ?? 0;
        this.currentSessionNumber = sessionNumber ?? (sessionIndex + 1);
    }

    async onCollectionStart(data) {
        console.log(`[realtimeEngine] ========== 开始采集会话 ==========`);
        if (this.collectionFault && this.collectionState !== 'interrupted') {
            throw new Error('上一轮故障仍未安全收尾，拒绝开始新的collection');
        }
        if (this.isCollecting || this.collectionState === 'starting' || this.stageFileOpen || this.stageFileOpening || this.isClosingStageFile ||
            this.stageFileOpenPromise || this.stageFileCreateFailed || this.storageDataSendError) {
            throw new Error('上一Stage仍未安全收尾，拒绝开始新的collection');
        }
        const { taskId, stageName, userId, config, sessionIndex, sessionNumber, sessionCount, isTestMode, recordingSessionId, isMultiSession } = data;
        const effectiveTaskId = taskId || config?.task_id || this.currentTaskId || 'discrete_gesture';

        this.currentTaskId = effectiveTaskId;
        this.currentUser = { id: userId, ...config?.subject };
        this.collectionConfig = config ? { ...config, task_id: effectiveTaskId } : { task_id: effectiveTaskId };
        this.collectionState = 'starting';
        this.collectionFault = null;
        this.collectionFaultFinalizePromise = null;
        this.storagePushFallbackActive = false;
        this.isCollecting = true;
        this.collectionPaused = false;
        this.abortFreezeActive = false;
        this.storageFileToken = null;
        this.videoStopResults = {};
        this.videoStopOperationId = `video_stop_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        this.h5StorageWarningShown = false;
        this.stageFileOpening = false;
        this.stageFileCreateFailed = false;
        this.currentStageName = stageName;
        this.currentSessionIndex = sessionIndex ?? 0;
        this.currentSessionNumber = sessionNumber ?? 1;
        this.sessionCount = sessionCount ?? 3;
        // stage_start may arrive while this async method is still waiting for
        // camera time. Set test-mode and a fresh fallback timestamp before any
        // await so test runs cannot accidentally create H5 files.
        this.isTestMode = isTestMode || false;
        this.collectionDataStartTs = Date.now() / 1000;
        this._resetCollectionHealth();
        this._logCollectionHealth('collection_start');
        if (this.isTestMode) {
            console.log(`[realtimeEngine] ★★★ 测试模式：不会创建H5文件 ★★★`);
        }
        // 【新增】保存录像会话信息
        this.recordingSessionId = recordingSessionId || null;
        this.isMultiSession = isMultiSession || false;
        if (this.recordingSessionId) {
            console.log(`[realtimeEngine] 录像会话ID: ${this.recordingSessionId}`);
            console.log(`[realtimeEngine] 多轮次模式: ${this.isMultiSession}`);
        }

        // 【新增】重置视频录制标志
        this.videoRecordingStarted = false;
        this.videoFileNames = null;
        this.videoTimingLeft = null;
        this.videoTimingRight = null;
        this.videoPathLeft = null;
        this.videoPathRight = null;
        this.collectionBins = null;
        this.collectionBinFilenames = { dev1: null, dev2: null };
        this.collectionStreamId = null;

        // 【Phase 2】保存续采模式元数据
        this.isResume = data.isResume || false;
        this.resumeSegmentIndex = data.resumeSegmentIndex || 1;
        this.resumeFromInterruptedAt = data.resumeFromInterruptedAt || null;
        this.resumeReason = data.resumeReason || null;
        this.resumeParentRecordingSessionId = data.resumeParentRecordingSessionId || null;
        this.resumeParentSegmentIndex = data.resumeParentSegmentIndex || null;  // Phase 3
        if (this.isResume) {
            console.log(`[realtimeEngine] ★ 续采模式 ★`);
            console.log(`  segmentIndex: ${this.resumeSegmentIndex}`);
            console.log(`  resumeFrom: ${this.resumeFromInterruptedAt}`);
            console.log(`  resumeReason: ${this.resumeReason}`);
        }

        // 【修复 Issue 3】直接从 collection_start payload 获取 collection_bins
        // 不依赖异步 broadcast sd_filenames_updated 事件
        if (data.collectionBins) {
            this.streamMode = data.streamMode || 'collection';
            this.collectionBins = data.collectionBins;  // 【新增】保存collectionBins供视频录制使用
            this.collectionBinFilenames = {
                dev1: data.collectionBins?.dev1 || null,
                dev2: data.collectionBins?.dev2 || null
            };
            if (data.collectionDeviceNames) {
                this.device_names = {
                    dev1: data.collectionDeviceNames?.dev1 || this.device_names.dev1,
                    dev2: data.collectionDeviceNames?.dev2 || this.device_names.dev2
                };
            }
            this.collectionStreamId = data.collectionStreamId || new Date().toISOString();
            console.log(`[realtimeEngine] ★ collection bins 来自 payload（同步）:`);
            console.log(`  dev1: ${this.collectionBinFilenames.dev1 || '无'}`);
            console.log(`  dev2: ${this.collectionBinFilenames.dev2 || '无'}`);
            console.log(`  streamMode: ${this.streamMode}`);
            console.log(`  collectionStreamId: ${this.collectionStreamId}`);
        } else {
            console.log(`[realtimeEngine] ⚠️ collection_start payload 中无 collectionBins，将等待 sd_filenames_updated 事件`);
        }

        // sd_filenames_updated 事件作为兜底（见 onSdFilenamesUpdated）

        // 【统一时钟】获取 Python time.time() 作为会话起始时间基准
        // 与 EMG 数据时间戳（ble_server.py）和视频时间戳（camera_server.py）同源，
        // 消除 Node.js Date.now() 与 Python time.time() 之间的潜在时钟偏差
        let sessionStartUnix;
        try {
            if (this.camera_connected) {
                const timeResult = await this.sendCameraCommand('get_server_time', {});
                sessionStartUnix = timeResult.server_time;
                console.log('[realtimeEngine] 🕐 Python统一时钟: session_start_unix =', sessionStartUnix);
            } else {
                sessionStartUnix = Date.now() / 1000;
                console.log('[realtimeEngine] ⚠️ Camera未连接，使用JS时钟作为备选');
            }
        } catch (e) {
            console.warn('[realtimeEngine] ⚠️ 获取Python时钟失败，回退到JS时钟:', e.message);
            sessionStartUnix = Date.now() / 1000;
        }
        this._throwIfCollectionFault();
        this.collectionDataStartTs = sessionStartUnix;
        this.collectionDroppedStaleBlePackets = 0;
        this.realtimeDataBuffer = [];
        if (this.realtimeDataTimer) {
            clearTimeout(this.realtimeDataTimer);
            this.realtimeDataTimer = null;
        }

        // 自动启动摄像头录制（无需按空格触发）
        // 使用 collectionDataStartTs（采集会话起始时间），与 EMG 共用同一时间基准
        if (!this.isTestMode && !this.videoRecordingStarted) {
            const startTs = this.collectionDataStartTs;
            console.log('[realtimeEngine] 🎥 自动启动摄像头录制（t=', startTs, '）...');
            try { await this._markVideoRecordingStart(startTs, stageName); }
            catch (error) {
                this.onTransportFault({ source: 'camera', error: error.message });
                throw error;
            }
            this._throwIfCollectionFault();
            this.videoRecordingStarted = !!(this.videoFileNames?.left || this.videoFileNames?.right);
        }
    }

    onCollectionPause() {
        this._throwIfCollectionFault();
        this.collectionPaused = true;
        this._pauseCollectionHealthClock();
    }
    onCollectionResume() {
        this._throwIfCollectionFault();
        this.collectionPaused = false;
        this._resumeCollectionHealthClock();
    }

    async _saveCollectionVideos(incomplete = false) {
        if (!this.videoRecordingStarted) return;
        this.videoStopResults = this.videoStopResults || {};
        for (const side of ['left', 'right']) {
            if (!this.videoFileNames?.[side]) continue;
            if (this.videoStopResults[side]) {
                if (!this.videoStopResults[side].success && !incomplete) {
                    throw new Error(this.videoStopResults[side].error || `${side} 视频保存失败`);
                }
                continue;
            }
            const result = await this.sendCameraCommand('stop_and_save', {
                side, operation_id: `${this.videoStopOperationId || this.storageFileToken}_${side}`,
                recording_id: `${this.videoStopOperationId}_${side}`
            });
            if (result.pending) throw new Error(result.error || `${side} 视频保存结果尚未确认`);
            this.videoStopResults[side] = result;
            if (!result.success) {
                if (!incomplete) throw new Error(result.error || `${side} 视频保存失败`);
                continue;
            }
            const suffix = side === 'left' ? 'Left' : 'Right';
            if (result.timing) this[`videoTiming${suffix}`] = result.timing;
            if (result.output_path) this[`videoPath${suffix}`] = result.output_path;
        }
        this.videoRecordingStarted = false;
    }

    _videoCloseParams() {
        return {
            video_timing: { left: this.videoTimingLeft || null, right: this.videoTimingRight || null },
            video_left: this.videoPathLeft || this.videoFileNames?.left || null,
            video_right: this.videoPathRight || this.videoFileNames?.right || null
        };
    }

    _releaseCollection(state = 'idle') {
        this._stopCollectionHealthTimer();
        this.collectionState = state;
        this.isCollecting = false;
        this.collectionPaused = false;
        this.isTestMode = false;
        this.abortFreezeActive = false;
        this.pendingAbortFreeze = null;
        this.collectionStreamId = null;
        this.collectionBinFilenames = { dev1: null, dev2: null };
        this.collectionBins = null;
        this.collectionDataStartTs = 0;
        this.stageFileCreateFailed = false;
        this.storageDataSendError = null;
        this.collectionHealth = null;
    }

    async _finishCollection(params, incomplete = false) {
        this.isCollecting = false;
        this.collectionPaused = true;
        this.collectionState = 'stopping';
        this._stopCollectionHealthTimer();
        this._logCollectionHealth('collection_stopping');
        let failureSource = this.storageDataSendError ? 'storage' : 'camera';
        try {
            if (!incomplete && this.storageDataSendError) throw this.storageDataSendError;
            // Unknown camera outcomes (disconnect/timeout) keep ownership.
            // A terminal negative save reply may be preserved as incomplete.
            await this._saveCollectionVideos(incomplete);
            failureSource = 'storage';
            if (incomplete) {
                const videoErrors = Object.values(this.videoStopResults || {}).filter(r => !r.success).map(r => r.error || '视频保存失败');
                params.error_reason = [params.error_reason, ...videoErrors].filter(Boolean).join('; ');
            }
            const response = await this.closeStageFile({ ...this._videoCloseParams(), ...params }, incomplete);
            if (response.status !== 'success') throw new Error(response.msg || 'H5关闭失败');
            this._releaseCollection(params.collection_status === 'abnormal_interrupted' ? 'interrupted' : 'idle');
            return { status: 'success', h5_close: response, collection_status: params.collection_status };
        } catch (error) {
            this.collectionState = 'save_failed';
            const hasSaveResources = this.stageFileOpen || this.stageFileOpening || this.stageFileCreateFailed ||
                this.videoRecordingStarted || Object.values(this.videoFileNames || {}).some(Boolean) ||
                this._collectionParticipantSides().length > 0;
            if (!incomplete && !this.abortFreezeActive && params.collection_status !== 'abnormal_interrupted' &&
                !this.isTestMode && !this.collectionFault && hasSaveResources) {
                const source = failureSource;
                const failedSide = source === 'camera'
                    ? Object.entries(this.videoStopResults || {}).find(([, result]) => !result.success)?.[0] ||
                        Object.keys(this.videoFileNames || {}).find(side => this.videoFileNames[side])
                    : undefined;
                this.collectionState = 'collecting';
                this.isCollecting = true;
                this.requestCollectionFault({ source, side: failedSide,
                    code: source === 'camera' ? 'camera_save_failed' : this._storageFaultCode(error.message || error),
                    message: error.message || String(error) });
            }
            return { status: 'error', msg: error.message, h5_close: { status: 'error', msg: error.message } };
        }
    }

    _throwIfCollectionFault() {
        if (this.collectionFault) {
            throw new Error('本轮发生故障，正在停止采集并保存已接收数据');
        }
    }

    _collectionParticipantSides() {
        return ['dev1', 'dev2'].filter(side => !!this.collectionBinFilenames?.[side]);
    }

    _isRealCollectionActive() {
        return !this.isTestMode && !!(
            this.isCollecting || ['starting', 'collecting', 'paused', 'fault_stopping'].includes(this.collectionState) ||
            ((this.stageFileOpen || this.stageFileOpening || this.stageFileOpenPromise) && this.collectionState !== 'stopping')
        );
    }

    _isCollectionRuntimeActive() {
        return !this.isTestMode && !!(this.isCollecting || ['starting', 'collecting', 'paused'].includes(this.collectionState));
    }

    _matchesCollectionFaultTarget(packet = {}) {
        const source = packet.source || 'device';
        if (source === 'ble') {
            const participants = this._collectionParticipantSides();
            if (!participants.length) return false;
            if (packet.device_id != null) {
                const side = `dev${Number(packet.device_id)}`;
                if (!participants.includes(side)) return false;
                const currentPrefix = this.collectionBinFilenames?.[side];
                if (packet.sd_prefix && currentPrefix && String(packet.sd_prefix) !== String(currentPrefix)) return false;
            }
            return true;
        }
        if (source === 'camera') return !!(this.videoRecordingStarted && Object.values(this.videoFileNames || {}).some(Boolean));
        if (source === 'mocap') return !!this.currentStageNeedMocap;
        return source === 'storage' && this._isRealCollectionActive();
    }

    _faultMessage(packet = {}) {
        let detail = String(packet.message || packet.error || packet.reason || '采集设备或存储发生故障');
        if (packet.source === 'ble' && packet.device_id != null) {
            const side = Number(packet.device_id) === 1 ? '左手' : Number(packet.device_id) === 2 ? '右手' : `设备${packet.device_id}`;
            const key = `dev${Number(packet.device_id)}`;
            const identity = this.device_names?.[key] || packet.sd_prefix || this.collectionBinFilenames?.[key];
            detail = `${side}${identity ? `（${identity}）` : ''}：${detail}`;
        } else if (packet.source === 'camera' && packet.side) {
            detail = `${packet.side === 'left' ? '左侧' : '右侧'}摄像头：${detail}`;
        }
        return detail;
    }

    requestCollectionFault(packet = {}) {
        const source = packet.source || 'device';
        if (!this._isRealCollectionActive() || !this._matchesCollectionFaultTarget(packet)) return false;
        if (this.collectionFault) {
            const cause = { source, code: packet.code || 'capture_fault', message: this._faultMessage(packet), at: Date.now() };
            const sameCause = this.collectionFault.causes.some(item =>
                item.source === cause.source && item.code === cause.code && item.message === cause.message);
            if (sameCause) {
                this.collectionFault.repeated_causes_count++;
                return this.collectionFaultFinalizePromise || true;
            }
            if (this.collectionFault.causes.length < 16) {
                this.collectionFault.causes.push(cause);
                console.warn('[realtimeEngine] 同一采集轮次追加故障原因:', cause);
            } else {
                this.collectionFault.omitted_causes_count++;
            }
            return this.collectionFaultFinalizePromise || true;
        }

        const faultId = `fault_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        this.collectionFaultEpoch++;
        const message = this._faultMessage(packet);
        const progressSnapshot = this._collectionHealthSnapshot();
        const fault = this.collectionFault = {
            fault_id: faultId,
            source,
            code: packet.code || 'capture_fault',
            message,
            started_at: new Date().toISOString(),
            causes: [{ source, code: packet.code || 'capture_fault', message, at: Date.now() }],
            repeated_causes_count: 0,
            omitted_causes_count: 0,
            phase: 'stopping',
            participants: this._collectionParticipantSides(),
            video_sides: Object.keys(this.videoFileNames || {}).filter(side => this.videoFileNames[side]),
            file_path: this.collectionHealth?.filename || null,
            file_token: this.storageFileToken || null,
            save_result: { h5: null, video: null, ble: null },
            video_results: {},
            finalizing: false,
            h5Closed: false,
            h5NoFile: false
        };

        this.isCollecting = false;
        this.collectionPaused = true;
        this.abortFreezeActive = true;
        this.pendingAbortFreeze = { interruptedAt: fault.started_at, reason: message };
        this.collectionState = 'fault_stopping';
        this._stopCollectionHealthTimer();
        console.log(`[采集健康] ${JSON.stringify({ event: 'collection_fault_before_save', fault_id: faultId, file_token: fault.file_token, progress: progressSnapshot })}`);
        this._logCollectionHealth('collection_fault', { fault_id: faultId, source, code: fault.code, error: message });
        this.broadcastToClients({
            type: 'collection_fault', fault_id: faultId, phase: 'stopping', source,
            code: fault.code, error: message, message,
            file_path: fault.file_path, file_token: fault.file_token
        });

        const pending = this.collectionCommandChain.then(
            () => this._finalizeCollectionFault(fault),
            () => this._finalizeCollectionFault(fault)
        );
        this.collectionFaultFinalizePromise = pending;
        this.collectionCommandChain = pending.catch(() => {});
        return pending;
    }

    async _stopBleCollectionForFault(fault) {
        const WebSocketClient = WebSocket;
        const socket = new WebSocketClient('ws://localhost:8764');
        const requestId = `fault_stop_${fault.fault_id}`;
        let timer = null;
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                socket.removeListener?.('open', onOpen);
                socket.removeListener?.('message', onMessage);
                socket.removeListener?.('close', onClose);
                // ws may emit a late error after a timed-out CONNECTING socket is closed.
                socket.on?.('error', () => {});
                try { socket.close(); } catch (_) {}
            };
            const finish = (error, result) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error); else resolve(result);
            };
            const onOpen = () => {
                try { socket.send(JSON.stringify({ action: 'stop_collection_stream', request_id: requestId })); }
                catch (error) { finish(error); }
            };
            const onMessage = payload => {
                let response;
                try { response = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)); }
                catch (_) { return; }
                if (response.request_id !== requestId || response.action !== 'stop_collection_stream') return;
                if (response.success === false) finish(new Error(response.error || 'BLE拒绝停止collection stream'));
                else finish(null, response);
            };
            const onError = error => finish(error instanceof Error ? error : new Error('BLE停止命令连接失败'));
            const onClose = () => { if (!settled) finish(new Error('BLE停止命令连接在确认前关闭')); };
            socket.on('open', onOpen);
            socket.on('message', onMessage);
            socket.on('error', onError);
            socket.on('close', onClose);
            timer = setTimeout(() => finish(new Error('BLE停止collection stream等待确认超时')),
                Number.isFinite(this.bleFaultStopTimeoutMs) && this.bleFaultStopTimeoutMs > 0 ? this.bleFaultStopTimeoutMs : 15000);
            timer?.unref?.();
        });
    }

    async _stopFaultVideoSide(fault, side) {
        const result = fault.video_results[side];
        if (result?.success) return result;
        const fileName = this.videoFileNames?.[side];
        if (!fileName) return { status: 'not_recording', success: true, saved: false };
        try {
            const response = await this.sendCameraCommand('stop_and_save', {
                side,
                operation_id: `${this.videoStopOperationId || fault.fault_id}_${side}`,
                recording_id: `${this.videoStopOperationId || fault.fault_id}_${side}`
            }, 30000);
            const settled = response?.pending
                ? { ...response, success: false, error: response.error || `${side} 视频保存仍在处理中` }
                : { ...response, success: response?.success === true, saved: response?.success === true };
            fault.video_results[side] = settled;
            if (settled.success) {
                if (response.timing) this[`videoTiming${side === 'left' ? 'Left' : 'Right'}`] = response.timing;
                if (response.output_path) this[`videoPath${side === 'left' ? 'Left' : 'Right'}`] = response.output_path;
            }
            return settled;
        } catch (error) {
            const failed = { status: 'error', success: false, pending: true, error: error.message || String(error) };
            fault.video_results[side] = failed;
            return failed;
        }
    }

    async _finalizeCollectionFault(fault) {
        if (!fault || fault.finalizing) return fault?.save_result;
        fault.finalizing = true;
        this.collectionState = 'fault_stopping';
        const reason = fault.causes.map(cause => `${cause.source}/${cause.code}: ${cause.message}`).join('; ');

        const h5Task = async () => {
            if (fault.h5Closed || fault.h5NoFile) return fault.save_result.h5;
            if (!this.stageFileOpen && !this.stageFileOpening && !this.stageFileCreateFailed && !this.stageFileOpenPromise) {
                fault.h5NoFile = true;
                fault.save_result.h5 = { status: 'not_created', no_file: true, saved: false, msg: '本轮故障发生时尚未创建H5文件' };
                return fault.save_result.h5;
            }
            await this.storagePushSendChain;
            const result = await this.closeStageFile({
                ...this._videoCloseParams(),
                collection_status: 'incomplete',
                error_reason: reason
            }, true);
            if (result?.file_closed === true) this.stageFileOpen = false;
            if (result?.status === 'success' && result.msg === 'no_open_file') {
                fault.h5NoFile = true;
                fault.save_result.h5 = { status: 'not_created', no_file: true, saved: false, msg: '本轮没有已打开的H5文件' };
            } else {
                fault.save_result.h5 = result || { status: 'error', msg: 'H5收尾没有返回结果' };
                if (result?.status === 'success' || result?.file_closed === true) fault.h5Closed = true;
            }
            return fault.save_result.h5;
        };

        const videoTask = async () => {
            const sides = fault.video_sides || [];
            const results = await Promise.all(sides.map(side => this._stopFaultVideoSide(fault, side)));
            if (results.every(result => result.success)) this.videoRecordingStarted = false;
            const sideResults = Object.fromEntries(sides.map((side, index) => [side, results[index]]));
            const failed = results.filter(result => !result.success);
            fault.save_result.video = {
                status: failed.length ? 'error' : 'success',
                msg: failed.length ? Object.entries(sideResults).filter(([, result]) => !result.success)
                    .map(([side, result]) => `${side}: ${result.error || result.msg || '保存失败'}`).join('；') :
                    (sides.length ? '本轮录像已保存' : '本轮未启用相机，无需保存'),
                sides: sideResults
            };
            return fault.save_result.video;
        };

        const bleTask = async () => {
            if (fault.save_result.ble?.success) return fault.save_result.ble;
            try {
                const response = await this._stopBleCollectionForFault(fault);
                const stopResults = response?.stop_results;
                if (!stopResults || typeof stopResults !== 'object') {
                    fault.save_result.ble = {
                        status: 'unverified', success: false,
                        msg: 'BLE服务端已确认停止采集数据流，但BLE端未提供设备侧STOP结果，设备侧未核实。', response
                    };
                    return fault.save_result.ble;
                }
                const unsent = (fault.participants || []).filter(side => stopResults[side]?.stop_command_sent !== true || stopResults[side]?.local_stopped !== true);
                if (unsent.length) {
                    const details = unsent.map(side => {
                        const hand = side === 'dev1' ? '左手' : '右手';
                        const identity = this.device_names?.[side] || this.collectionBinFilenames?.[side] || side;
                        const result = stopResults[side];
                        const error = result?.error ? `（${result.error}）` : '';
                        const localStatus = result?.local_stopped === true ? '服务端本地已停止接收' : '服务端本地停止状态未确认';
                        return `${hand} ${identity}：${localStatus}，设备侧STOP未确认${error}`;
                    }).join('；');
                    fault.save_result.ble = { status: 'error', success: false, msg: details, error: details, response };
                    return fault.save_result.ble;
                }
                fault.save_result.ble = {
                    status: 'success', success: true,
                    msg: `已停止本轮BLE数据流，参与设备STOP命令均已发送：${(fault.participants || []).map(side => `${side === 'dev1' ? '左手' : '右手'} ${this.device_names?.[side] || this.collectionBinFilenames?.[side] || side}`).join('、')}`,
                    response
                };
            } catch (error) {
                fault.save_result.ble = { status: 'error', success: false, msg: error.message || String(error), error: error.message || String(error) };
            }
            return fault.save_result.ble;
        };

        const [h5Outcome, videoOutcome, bleOutcome] = await Promise.allSettled([h5Task(), videoTask(), bleTask()]);
        if (h5Outcome.status === 'rejected') fault.save_result.h5 = { status: 'error', msg: h5Outcome.reason?.message || String(h5Outcome.reason) };
        if (videoOutcome.status === 'rejected') fault.save_result.video_error = videoOutcome.reason?.message || String(videoOutcome.reason);
        if (bleOutcome.status === 'rejected') fault.save_result.ble = { status: 'error', success: false, msg: bleOutcome.reason?.message || String(bleOutcome.reason), error: bleOutcome.reason?.message || String(bleOutcome.reason) };
        fault.finalizing = false;

        const safeToRelease = fault.h5Closed || fault.h5NoFile;
        if (safeToRelease) {
            this._releaseCollection('interrupted');
            this.streamMode = 'idle';
        } else {
            this.collectionState = 'save_failed';
            this.isCollecting = false;
            this.collectionPaused = true;
        }
        this.broadcastToClients({
            type: 'collection_fault', fault_id: fault.fault_id, phase: 'stopped',
            source: fault.source, code: fault.code, error: fault.message, message: fault.message,
            file_path: fault.file_path, file_token: fault.file_token,
            save_result: fault.save_result
        });
        fault.phase = 'stopped';
        this._logCollectionHealth('collection_fault_stopped', { fault_id: fault.fault_id, save_result: fault.save_result });
        return { status: safeToRelease ? 'success' : 'error', fault_id: fault.fault_id, save_result: fault.save_result };
    }

    async retryCollectionFault(data = {}) {
        const fault = this.collectionFault;
        if (!fault || data.fault_id !== fault.fault_id) return { status: 'error', msg: '故障编号不存在或已过期' };
        if (fault.finalizing) {
            await this.collectionFaultFinalizePromise;
            return {
                status: 'success', fault_id: fault.fault_id,
                save_complete: this._collectionFaultSavesComplete(fault), save_result: fault.save_result
            };
        }
        this.collectionState = fault.h5Closed || fault.h5NoFile ? 'interrupted' : 'fault_stopping';
        fault.phase = 'stopping';
        this.broadcastToClients({
            type: 'collection_fault', fault_id: fault.fault_id, phase: 'stopping',
            source: fault.source, code: fault.code, error: fault.message, message: fault.message,
            file_path: fault.file_path, file_token: fault.file_token
        });
        await this._finalizeCollectionFault(fault);
        const result = {
            status: 'success', fault_id: fault.fault_id,
            save_complete: this._collectionFaultSavesComplete(fault), save_result: fault.save_result
        };
        this.collectionFaultFinalizePromise = Promise.resolve(result);
        return result;
    }

    _collectionFaultSavesComplete(fault) {
        return fault?.save_result?.h5?.status === 'success' &&
            fault?.save_result?.video?.status === 'success' &&
            fault?.save_result?.ble?.status === 'success';
    }

    onCollectionStop(completed) {
        return this._finishCollection({ collection_status: completed ? 'completed' : 'manual_stopped' });
    }

    finalizeIncomplete(data = {}) {
        return this._finishCollection({
            collection_status: 'incomplete',
            error_reason: data.reason || this.storageDataSendError?.message || '操作员选择按不完整采集收尾'
        }, true);
    }

    // 【新增】异常中断冻结 — 立即停止 append，不关闭 H5
    onAbnormalInterruptFreeze(data) {
        const { interruptedAt, progress } = data || {};
        console.log(`[realtimeEngine] ========== 异常中断冻结 ==========`);
        console.log(`[realtimeEngine] 时间: ${interruptedAt || '未知'}`);

        // 立即停止写入
        this.isCollecting = false;
        this.collectionPaused = true;
        this._stopCollectionHealthTimer();
        this.abortFreezeActive = true;
        this.pendingAbortFreeze = { interruptedAt, progress };

        console.log(`[realtimeEngine] H5 数据写入已冻结 (文件保持 open)`);
        console.log(`[realtimeEngine] isCollecting=${this.isCollecting}, collectionPaused=${this.collectionPaused}`);
    }

    // 【新增】异常中断处理 — 关闭 H5 并标记 abnormal_interrupted
    async onAbnormalInterrupt(data) {
        const { reason, interruptedAt, progress, breakpointState } = data || {};
        this.onAbnormalInterruptFreeze(data);
        return this._finishCollection({
            collection_status: 'abnormal_interrupted',
            interrupted_at: interruptedAt || new Date().toISOString(),
            interrupt_reason: reason || '未知',
            resume_progress: progress ? JSON.stringify(progress) : null,
            breakpoint_state: breakpointState ? JSON.stringify(breakpointState) : null
        });
    }

    onSdFilenamesUpdated(sd_filenames, device_names, stream_mode, collection_stream_id, device_configs = null) {
        if (stream_mode !== 'collection' && this._isCollectionRuntimeActive() && !this.collectionPaused &&
            this.collectionState === 'collecting' && this._collectionParticipantSides().length) {
            this.requestCollectionFault({ source: 'ble', code: 'collection_stream_stopped',
                message: `采集期间BLE数据流意外切换为${stream_mode || '未知状态'}` });
        }
        // 完全替换，只保存当前实际连接设备的文件名
        this.sd_filenames = {
            dev1: sd_filenames?.dev1 || null,
            dev2: sd_filenames?.dev2 || null
        };
        // 【新增】保存BLE设备名称
        this.device_names = {
            dev1: device_names?.dev1 || null,
            dev2: device_names?.dev2 || null
        };
        this.device_configs = {
            dev1: device_configs?.dev1 || this.device_configs.dev1 || null,
            dev2: device_configs?.dev2 || this.device_configs.dev2 || null
        };

        // 【新增】根据 stream_mode 更新 collection bin 记录
        if (stream_mode === 'collection') {
            this.streamMode = 'collection';
            this.collectionBinFilenames = { ...this.sd_filenames };
            // 【修复 Issue 2】优先使用 ble_server 传入的 collection_stream_id；只有未设置时才生成
            if (collection_stream_id) {
                this.collectionStreamId = collection_stream_id;
            } else if (!this.collectionStreamId) {
                this.collectionStreamId = new Date().toISOString();
            }
            console.log(`[realtimeEngine] ★ collection stream 已就绪 (event 兜底路径) ★`);
            console.log(`[realtimeEngine]   collection_bins: dev1=${this.collectionBinFilenames.dev1 || '无'}, dev2=${this.collectionBinFilenames.dev2 || '无'}`);
            console.log(`[realtimeEngine]   collection_stream_id: ${this.collectionStreamId}`);
        } else if (stream_mode === 'preview') {
            this.streamMode = 'preview';
            console.log(`[realtimeEngine] preview stream (bin 不参与 H5 同步)`);
        } else {
            this.streamMode = stream_mode || 'unknown';
        }

        console.log(`[realtimeEngine] SD卡文件名已更新: dev1=${this.sd_filenames.dev1 || '无'}, dev2=${this.sd_filenames.dev2 || '无'}, stream_mode=${this.streamMode}`);
        console.log(`[realtimeEngine] BLE设备名称已更新: dev1=${this.device_names.dev1 || '无'}, dev2=${this.device_names.dev2 || '无'}`);
    }

    getActiveEmgConfig() {
        const config = this.device_configs.dev1 || this.device_configs.dev2 || {};
        const parsedGain = Number(config.gain);
        const gain = Number.isFinite(parsedGain) && parsedGain > 0 ? parsedGain : DEFAULT_EMG_GAIN;
        const gainIndex = Number.isInteger(Number(config.gain_index)) ? Number(config.gain_index) : DEFAULT_EMG_GAIN_INDEX;
        const lsb = Number.isFinite(Number(config.emg_lsb_uv_24bit)) ? Number(config.emg_lsb_uv_24bit) : DEFAULT_EMG_LSB_UV_24BIT;
        return {
            gain,
            gain_index: gainIndex,
            emg_lsb_uv_24bit: lsb
        };
    }

    onStageChange(stageIndex, stageName) { this.currentStageName = stageName; }

    async onStageStart(stageName, stageIndex, timestamp, needMocap = false) {
        this._throwIfCollectionFault();
        this.currentStageName = stageName;
        // 【统一时钟】优先使用 Python 时钟（来自 onCollectionStart 查询 camera_server），
        // 确保 H5 中 start_time 属性与 EMG/视频数据时间戳同源
        this.stage_start_time = this.collectionDataStartTs || timestamp || Date.now();
        // 【新增】保存当前stage是否需要动捕数据
        this.currentStageNeedMocap = needMocap;
        console.log(`[realtimeEngine] Stage开始: ${stageName}, needMocap: ${needMocap}`);
        if (this.abortFreezeActive) throw new Error('采集已冻结');
        await this.openStageFile(stageName, stageIndex);
        this._throwIfCollectionFault();
        if (this.stageFileCreateFailed) throw new Error('H5文件创建失败');
        if (this.abortFreezeActive) throw new Error('采集已冻结，等待异常收尾');
        this.collectionState = 'collecting';
        this._startCollectionHealthTimer();
        this._logCollectionHealth('stage_open');
    }

    async onStageEnd(stageName, timestamp) {
        // Collection stop owns finalization, including video and final status.
        // Closing here used to race the subsequent stop/abort command.
        return { status: 'success' };
    }

    onPromptStart(promptName, promptIndex) {}
    onPromptEnd(promptName, promptIndex) {}

    async onPrompt(name, stageName, timestamp) {
        if (this.abortFreezeActive || this.isTestMode) return;
        const token = this.storageFileToken;
        if (this.stageFileOpenPromise) await this.stageFileOpenPromise;
        if (token !== this.storageFileToken || !this.isCollecting ||
            !this.stageFileOpen || this.isClosingStageFile) throw new Error('当前采集文件未就绪，提示事件未保存');
        await this.saveDataToStorage({ prompt_name: name,
            prompt_time: timestamp || Date.now(), prompt_stage: stageName || this.currentStageName });
        if (this.storageDataSendError) throw this.storageDataSendError;
    }

    // 【新增】处理视频录制信息
    onVideoRecordingStarted(data) {
        console.log('[realtimeEngine] 📹 收到视频录制信息:', data);

        // 测试模式下不保存
        if (this.isTestMode) {
            console.log('[realtimeEngine] 测试模式：跳过保存视频信息');
            return;
        }

        // 检查文件是否打开
        if (!this.stageFileOpen || this.isClosingStageFile) {
            console.warn('[realtimeEngine] 文件未打开，无法保存视频信息');
            return;
        }

        // 发送视频信息到 storage_server
        this.sendStorageCommand('video_recording_started', {
            video_left: data.video_left || null,
            video_right: data.video_right || null,
            video_start_timestamp: data.video_start_timestamp || null,
            h5_file_name: data.h5_file_name || null
        }).then(() => {
            console.log('[realtimeEngine] ✅ 视频信息已保存到H5文件');
        }).catch(err => {
            console.error('[realtimeEngine] ❌ 保存视频信息失败:', err);
        });
    }

    /**
     * 启动摄像头录制（采集开始时自动调用）
     *
     * 当前架构（FrameRecorder）：
     * 不停止MJPEG预览，直接从预览管道保存帧。
     *
     * 智能 side 映射：单摄像头时，自动将 bin 映射到可用摄像头。
     * 例如：摄像头在 left，但只有 dev2 有 bin → left 摄像头录制 dev2 数据。
     */
    async _markVideoRecordingStart(timestamp, stageName) {
        this._throwIfCollectionFault();
        console.log('[realtimeEngine] 🎥 启动摄像头录制...');

        if (!this.camera_connected) {
            console.error('[realtimeEngine] ❌ camera_server未连接，无法标记录制起始');
            return;
        }

        // 获取 collection bins（用于生成视频文件名），兼容两种来源
        const binFileNameLeft = this.collectionBins?.dev1 || this.collectionBinFilenames?.dev1;
        const binFileNameRight = this.collectionBins?.dev2 || this.collectionBinFilenames?.dev2;

        if (!binFileNameLeft && !binFileNameRight) {
            console.warn('[realtimeEngine] 未找到collection bins，无法标记录制');
            return;
        }

        console.log('[realtimeEngine] Collection bins:', this.collectionBins);

        // 初始化 videoFileNames
        this.videoFileNames = this.videoFileNames || {};

        // === 查询 camera_server 哪些摄像头可用（MJPEG 预览已在运行） ===
        let availableSides = [];
        try {
            const status = await this.sendCameraCommand('get_status', {});
            this._throwIfCollectionFault();
            for (const side of ['left', 'right']) {
                if (status.captures && status.captures[side] && status.captures[side].running) {
                    availableSides.push(side);
                }
            }
            console.log(`[realtimeEngine] 可用摄像头: ${availableSides.length > 0 ? availableSides.join(', ') : '无'}`);
        } catch (e) {
            console.warn('[realtimeEngine] 无法获取摄像头状态，假定两侧都可用:', e.message);
            availableSides = ['left', 'right'];
        }

        if (availableSides.length === 0) {
            console.error('[realtimeEngine] ❌ 没有可用的摄像头（请先在UI中打开摄像头）');
            return;
        }

        // === 智能映射：bin → 可用摄像头 ===
        // 优先保持 side 匹配；单摄像头时自动 fallback
        const mapBinToCamera = (preferredSide) => {
            if (availableSides.includes(preferredSide)) return preferredSide;
            // Fallback: 使用第一个可用摄像头
            const fallback = availableSides[0];
            console.log(`[realtimeEngine] ⚠️ ${preferredSide}侧摄像头不可用，改用 ${fallback} 侧摄像头`);
            return fallback;
        };

        // 左手 bin → 摄像头
        if (binFileNameLeft) {
            const cameraSide = mapBinToCamera('left');
            const videoFileName = `${binFileNameLeft}.avi`;
            console.log(`[realtimeEngine] ${cameraSide}侧摄像头 ← 左手bin: ${videoFileName}`);

            this.videoFileNames = this.videoFileNames || {};
            this.videoFileNames[cameraSide] = videoFileName;
            this.videoRecordingStarted = true;
            try {
                const startResult = await this.sendCameraCommand('start_continuous_recording', {
                    side: cameraSide,
                    output_filename: videoFileName,
                    recording_id: `${this.videoStopOperationId}_${cameraSide}`,
                    start_timestamp: timestamp
                });
                this._throwIfCollectionFault();
                if (startResult.success) {
                    console.log(`[realtimeEngine] ✅ ${cameraSide}侧录制已启动`);
                    this.videoFileNames[cameraSide] = videoFileName;
                    // 标记该摄像头已被使用（避免同一摄像头被两个 bin 重复使用）
                    availableSides = availableSides.filter(s => s !== cameraSide);
                } else {
                    throw new Error(startResult.error || `${cameraSide}侧录像启动失败`);
                }
            } catch (error) {
                console.error(`[realtimeEngine] ${cameraSide}侧录制请求失败:`, error);
                throw error;
            }
        }

        // 右手 bin → 摄像头
        if (binFileNameRight && availableSides.length > 0) {
            const cameraSide = mapBinToCamera('right');
            const videoFileName = `${binFileNameRight}.avi`;
            console.log(`[realtimeEngine] ${cameraSide}侧摄像头 ← 右手bin: ${videoFileName}`);

            this.videoFileNames = this.videoFileNames || {};
            this.videoFileNames[cameraSide] = videoFileName;
            this.videoRecordingStarted = true;
            try {
                const startResult = await this.sendCameraCommand('start_continuous_recording', {
                    side: cameraSide,
                    output_filename: videoFileName,
                    recording_id: `${this.videoStopOperationId}_${cameraSide}`,
                    start_timestamp: timestamp
                });
                this._throwIfCollectionFault();
                if (startResult.success) {
                    console.log(`[realtimeEngine] ✅ ${cameraSide}侧录制已启动`);
                    this.videoFileNames[cameraSide] = videoFileName;
                } else {
                    throw new Error(startResult.error || `${cameraSide}侧录像启动失败`);
                }
            } catch (error) {
                console.error(`[realtimeEngine] ${cameraSide}侧录制请求失败:`, error);
                throw error;
            }
        }

    }

    // 【新增】Camera命令处理
    async onCameraSetConfig(data) {
        const { side, device_name, device_id } = data;
        console.log(`[realtimeEngine] 设置摄像头配置: ${side} -> ${device_name}`);

        if (!this.camera_connected) {
            console.warn('[realtimeEngine] camera_server未连接');
            throw new Error('camera_server未连接');
        }

        try {
            const result = await this.sendCameraCommand('set_camera', {
                side: side,
                device_name: device_name,
                device_id: device_id
            });

            if (result.success) {
                console.log(`[realtimeEngine] ✅ 摄像头配置已设置: ${side}`);
                this.camerasConfigured = true;  // 标记为已配置
            } else {
                console.error(`[realtimeEngine] ❌ 设置摄像头配置失败:`, result.error);
            }

            return result;
        } catch (error) {
            console.error('[realtimeEngine] 设置摄像头配置请求失败:', error);
            throw error;
        }
    }

    // 【新增】Mocap命令处理
    onMocapSetChannel(channel) {
        console.log(`[realtimeEngine] 设置Mocap通道: ${channel}`);
        this.mocap_activeChannel = channel;
        
        if (this.mocap_client && this.mocap_client.readyState === WebSocket.OPEN) {
            this.mocap_client.send(JSON.stringify({ cmd: 'set_channel', channel }));
        }
    }
    
    onMocapResetChannel(channel, value) {
        if (this.mocap_client && this.mocap_client.readyState === WebSocket.OPEN) {
            this.mocap_client.send(JSON.stringify({ cmd: 'reset_channel', channel, value }));
        }
    }
    
    onMocapGetStatus() {
        this.broadcastToClients({
            type: 'mocap_status',
            connected: this.mocap_connected,
            activeChannel: this.mocap_activeChannel,
            packetCount: this.mocap_packet_count
        });
    }

    // 【新增】动捕SDK连接控制
    onMocapSdkConnect() {
        console.log('[realtimeEngine] 请求连接动捕SDK');
        if (this.mocap_client && this.mocap_client.readyState === WebSocket.OPEN) {
            this.mocap_client.send(JSON.stringify({ cmd: 'sdk_connect' }));
        } else {
            this.broadcastToClients({
                type: 'mocap_sdk_status',
                connected: false,
                error: 'mocap_server未连接'
            });
        }
    }

    onMocapSdkDisconnect() {
        console.log('[realtimeEngine] 请求断开动捕SDK');
        if (this.mocap_client && this.mocap_client.readyState === WebSocket.OPEN) {
            this.mocap_client.send(JSON.stringify({ cmd: 'sdk_disconnect' }));
        }
    }

    onMocapSdkGetStatus() {
        if (this.mocap_client && this.mocap_client.readyState === WebSocket.OPEN) {
            this.mocap_client.send(JSON.stringify({ cmd: 'sdk_get_status' }));
        } else {
            this.broadcastToClients({
                type: 'mocap_sdk_status',
                connected: false,
                sdk_connected: false
            });
        }
    }

    openStageFile(stageName, stageIndex) {
        if (this.stageFileOpen) return Promise.resolve();
        if (this.stageFileOpenPromise) return this.stageFileOpenPromise;

        const openPromise = this._openStageFile(stageName, stageIndex);
        this.stageFileOpenPromise = openPromise;
        openPromise.finally(() => {
            if (this.stageFileOpenPromise === openPromise) {
                this.stageFileOpenPromise = null;
            }
        }).catch(() => {});
        return openPromise;
    }

    async _openStageFile(stageName, stageIndex) {
        console.log(`[realtimeEngine] 尝试打开Stage文件: ${stageName}`);
        console.log(`[realtimeEngine] storage_connected = ${this.storage_connected}`);
        this.stageFileCreateFailed = false;

        // 【新增】测试模式下跳过创建H5文件
        if (this.isTestMode) {
            console.log(`[realtimeEngine] ★ 测试模式：跳过创建H5文件 ★`);
            this.stageFileOpen = false;  // 确保不会尝试写入
            this.stageFileOpening = false;
            return;
        }

        this.stageFileOpening = true;
        this.storageFileToken = this.storageFileToken || `h5_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        if (!this.storage_connected) {
            console.warn('[realtimeEngine] ⚠️ Storage未连接，尝试立即重连...');
            try {
                await this.storage_server_connect();
            } catch (err) {
                console.error('[realtimeEngine] Storage重连异常:', err);
            }
            if (!this.storage_connected) {
                console.warn('[realtimeEngine] ⚠️ Storage重连失败，无法打开文件');
                this.stageFileCreateFailed = true;
                this.stageFileOpening = false;
                this.notifyH5StorageWarning('Storage Server未连接，当前采集不会写入H5；请紧急中断并重启后端');
                return;
            }
        }

        // 【修复】等待sd_filenames_updated事件到达（最多等待500ms）
        // 因为sd_filenames_updated事件是从ble_server.py的start_all发送的，
        // 可能在stage_start命令之后才到达
        if (!this.sd_filenames.dev1 && !this.sd_filenames.dev2) {
            console.log('[realtimeEngine] 等待SD卡文件名...');
            await new Promise(resolve => setTimeout(resolve, 300));
            console.log(`[realtimeEngine] SD卡文件名: dev1=${this.sd_filenames.dev1 || '无'}, dev2=${this.sd_filenames.dev2 || '无'}`);
        }

        try {
            const config = this.collectionConfig || {};
            const effectiveTaskId = config.task_id || this.currentTaskId || 'discrete_gesture';
            const taskName = collection_task_name[effectiveTaskId] || config.task || effectiveTaskId;
            const userId = this.currentUser?.id || 'unknown';
            const sessionNum = this.currentSessionNumber || 1;

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = `${userId}_${taskName}_session${sessionNum}_${stageName}_${timestamp}.h5`;
            if (this.collectionHealth) this.collectionHealth.requestedFilename = filename;
            this._logCollectionHealth('file_opening', { requested_filename: filename });

            const category1 = config.category1 || 'unknown';
            const category2 = config.category2 || 'unknown';
            const category4 = config.category4 || '';

            let subdirectory = category4
                ? `${category1}/${category2}/${userId}/${category4}`
                : `${category1}/${category2}/${userId}`;

            console.log(`[realtimeEngine] 准备打开文件: ${filename}`);
            console.log(`[realtimeEngine] 子目录: ${subdirectory}`);

            // 使用中文任务名称作为 task_id，这样文件夹名称就是中文的
            const taskIdForFolder = config.task || taskName || effectiveTaskId;

            const emgConfig = this.getActiveEmgConfig();
            const createParams = {
                _storage_file_token: this.storageFileToken,
                filename,
                subdirectory,
                task_id: taskIdForFolder,  // 使用中文任务名称
                user_id: userId,
                stage_name: stageName,
                stage_index: stageIndex,
                session_index: this.currentSessionIndex,
                session_number: sessionNum,
                session_count: this.sessionCount,
                category1: category1,
                category2: category2,
                category4: category4,
                template_name: config.templateName || 'default',
                subject_info: this.currentUser,
                start_time: this.stage_start_time,
                emg_gain: emgConfig.gain,
                emg_gain_index: emgConfig.gain_index,
                emg_lsb_uv_24bit: emgConfig.emg_lsb_uv_24bit,
                emg_gain_dev1: this.device_configs.dev1?.gain ?? null,
                emg_gain_index_dev1: this.device_configs.dev1?.gain_index ?? null,
                emg_lsb_uv_24bit_dev1: this.device_configs.dev1?.emg_lsb_uv_24bit ?? null,
                emg_gain_dev2: this.device_configs.dev2?.gain ?? null,
                emg_gain_index_dev2: this.device_configs.dev2?.gain_index ?? null,
                emg_lsb_uv_24bit_dev2: this.device_configs.dev2?.emg_lsb_uv_24bit ?? null,
                // 【新增】传递 collection stream 的 SD 卡 bin 文件名（用于 HDF5 溯源）
                // 使用 collectionBinFilenames（优先）或 sd_filenames
                sd_bin_dev1: this.collectionBinFilenames.dev1 || this.sd_filenames.dev1,
                sd_bin_dev2: this.collectionBinFilenames.dev2 || this.sd_filenames.dev2,
                // 【新增】IMU bin 文件（兼容未来扩展）
                sd_imu_bin_dev1: null,  // 当前 IMU bin 与 EMG bin 同名
                sd_imu_bin_dev2: null,
                // 【新增】传递BLE设备名称，用于追溯数据来源
                ble_dev1: this.device_names.dev1,  // 例如 "WristBand_3A76"
                ble_dev2: this.device_names.dev2,  // 例如 "WristBand_5B12"
                // 【新增】stream mode 元数据（preview/collection 切流方案）
                stream_mode: this.streamMode,  // "collection" | "preview" | "idle"
                collection_stream_id: this.collectionStreamId,
                stream_switch_delay_ms: this.streamSwitchDelayMs,
                timestamp_to_start_delay_ms: this.timestampToStartDelayMs,
                bin_pair_source: (this.streamMode === 'collection') ? 'collection_stream' : 'unknown',
                // 【新增】录像同步信息
                recording_session_id: this.recordingSessionId,  // 例如 "rec_20260314_153045_5"
                is_multi_session: this.isMultiSession,          // 是否为多轮次采集
                // 【Phase 2】续采模式元数据
                is_resumed: this.isResume || false,
                segment_index: this.resumeSegmentIndex || 1,
                resume_from_interrupted_at: this.resumeFromInterruptedAt || null,
                resume_reason: this.resumeReason || null,
                resume_parent_recording_session_id: this.resumeParentRecordingSessionId || null,
                // Phase 3: 父 segment 序号
                parent_segment_index: this.resumeParentSegmentIndex || null
            };

            let response;
            try { response = await this.sendStorageCommand('create', createParams); }
            catch (error) {
                const status = await this.sendStorageCommand('get_file_status');
                if (status.status !== 'success' || status.file_token !== this.storageFileToken || !status.open || status.create_failed) throw error;
                response = { status: 'success' };
            }

            if (response.status === 'success') {
                this.stageFileOpen = true;
                this.stageFileOpening = false;
                this.stageFileCreateFailed = false;
                if (this.collectionHealth) {
                    this.collectionHealth.fileToken = this.storageFileToken;
                    this.collectionHealth.sessionId = this.collectionStreamId || this.collectionHealth.sessionId;
                    this.collectionHealth.filename = response.file_path || filename;
                }
                this.storageDataSequence = 0;
                this.storageDataLastSentSequence = 0;
                if (!this.abortFreezeActive) this.storageDataSendError = null;
                this.h5StorageWarningShown = false;
                if (this.videoFileNames?.left || this.videoFileNames?.right) {
                    const videoResponse = await this.sendStorageCommand('video_recording_started', {
                        video_left: this.videoFileNames.left || null, video_right: this.videoFileNames.right || null,
                        video_start_timestamp: this.collectionDataStartTs
                    });
                    if (videoResponse.status !== 'success') throw new Error(videoResponse.msg || '视频关联写入失败');
                }
                const actualFilename = response.file_path || filename;
                console.log(`[realtimeEngine] ✅ 文件已打开: ${actualFilename}`);
                this._logCollectionHealth('file_opened', { filename: actualFilename, requested_filename: filename });
            } else {
                console.error(`[realtimeEngine] ❌ 打开文件失败:`, response);
                this.stageFileOpen = false;
                this.stageFileOpening = false;
                this.stageFileCreateFailed = true;
                this._logCollectionHealth('file_open_failed', { filename, error: response.msg || response.error || response.status });
                this.notifyH5StorageWarning(`H5创建失败：${response.msg || response.error || response.status || '未知错误'}；请紧急中断并重采本轮`);
            }
        } catch (error) {
            console.error('[realtimeEngine] 打开Stage文件失败:', error);
            this.stageFileOpen = false;
            this.stageFileOpening = false;
            this.stageFileCreateFailed = true;
            this._logCollectionHealth('file_open_failed', { error: error.message || String(error) });
            this.notifyH5StorageWarning(`H5创建异常：${error.message || error}；请紧急中断并重采本轮`);
        }
    }

    notifyH5StorageWarning(message, force = false) {
        if (this._isCollectionRuntimeActive() && !this.isTestMode) {
            const detail = String(message || 'H5存储发生故障');
            this.requestCollectionFault({ source: 'storage', code: this._storageFaultCode(detail), message: detail });
        }
        if (this.h5StorageWarningShown && !force) return;
        this.h5StorageWarningShown = true;
        this.broadcastToClients({
            type: 'h5_storage_warning',
            level: 'error',
            message,
            stageName: this.currentStageName,
            sessionNumber: this.currentSessionNumber,
            timestamp: Date.now()
        });
    }

    _collectionHealthNow() {
        if (typeof this.collectionHealthClock === 'function') return this.collectionHealthClock();
        if (typeof process !== 'undefined' && process.hrtime?.bigint) return Number(process.hrtime.bigint()) / 1e6;
        return Date.now();
    }

    _resetCollectionHealth() {
        const now = this._collectionHealthNow();
        this.lastCollectionFaultHealthPollAt = null;
        this.collectionStorageProgress = null;
        this.collectionHealth = {
            sessionId: this.collectionStreamId || null, fileToken: this.storageFileToken || null, filename: null, requestedFilename: null,
            startedAt: now, monitorStartedAt: null, lastSummaryAt: now, pausedAt: null, lastStorageFailureSnapshotAt: null,
            sides: Object.fromEntries(['dev1', 'dev2'].map(side => [side, {
                received_valid_emg_rows: 0, sent_to_storage_rows: 0, lastValidEmgAt: null,
                pending: 0, warningActive: false, filtered_rows_by_reason: {}
            }]))
        };
    }

    _collectionHealthSnapshot(healthOverride = null) {
        const health = healthOverride || this.collectionHealth;
        if (!health) return null;
        return {
            session_id: health.sessionId || this.collectionStreamId || null,
            file_token: health.fileToken || this.storageFileToken || null,
            filename: health.filename,
            stream_mode: this.streamMode,
            devices: Object.fromEntries(['dev1', 'dev2'].map((side, index) => {
                const key = index === 0 ? 'dev1' : 'dev2';
                return [key, {
                    name: this.device_names?.[key] || null,
                    bin_prefix: this.collectionBinFilenames?.[key] || this.sd_filenames?.[key] || null,
                    received_valid_emg_rows: health.sides[key].received_valid_emg_rows,
                    sent_to_storage_rows: health.sides[key].sent_to_storage_rows,
                    last_valid_emg_monotonic_age_ms: Math.max(0, Math.round(this._collectionHealthNow() - (health.sides[key].lastValidEmgAt ?? health.startedAt))),
                    filtered_rows_by_reason: health.sides[key].filtered_rows_by_reason,
                    pending: health.sides[key].pending
                }];
            })),
            storage_connected: !!(this.storage_connected || this.storage_push_connected),
            storage_control_connected: !!this.storage_connected,
            storage_data_connected: !!this.storage_push_connected,
            pending: this.storagePushPendingCount || 0,
            last_sent_sequence: this.storageDataLastSentSequence || 0,
            error: this.storageDataSendError?.message || null
        };
    }

    _logCollectionHealth(event, extra = {}) {
        const data = this._collectionHealthSnapshot();
        if (!data) return;
        console.log(`[采集健康] ${JSON.stringify({ event, ...data, ...extra })}`);
    }

    _recordCollectionHealthReceived(side, rows) {
        const health = this.collectionHealth?.sides?.[side];
        if (!health || rows <= 0) return;
        const now = this._collectionHealthNow();
        health.received_valid_emg_rows += rows;
        health.lastValidEmgAt = now;
        if (health.warningActive) {
            health.warningActive = false;
            this._logCollectionHealth('emg_recovered', { device: side, recovered_rows: rows });
        }
        if (health.received_valid_emg_rows === rows) this._logCollectionHealth('first_emg', { device: side, rows });
    }

    _recordCollectionHealthFiltered(reason, side, rows) {
        const health = this.collectionHealth?.sides?.[side];
        if (!health || rows <= 0) return;
        health.filtered_rows_by_reason[reason] = (health.filtered_rows_by_reason[reason] || 0) + rows;
    }

    _collectionHealthRows(sensorData) {
        const rows = value => Array.isArray(value) && Array.isArray(value[0]) ? value[0].length : 0;
        return { dev1: rows(sensorData?.emg1), dev2: rows(sensorData?.emg2) };
    }

    _startCollectionHealthTimer() {
        this._stopCollectionHealthTimer();
        if (!this.collectionHealth || this.isTestMode || this.collectionPaused || this.collectionState !== 'collecting') return;
        if (this.collectionHealth.monitorStartedAt == null) {
            const now = this._collectionHealthNow();
            this.collectionHealth.monitorStartedAt = now;
            this.collectionHealth.startedAt = now;
            this.collectionHealth.lastSummaryAt = now;
        }
        const schedule = callback => {
            this.collectionHealthTimer = (this.collectionHealthSetTimeout || setTimeout)(callback, this.collectionHealthIntervalMs);
            this.collectionHealthTimer?.unref?.();
        };
        const tick = () => {
            this.collectionHealthTimer = null;
            if (!this.collectionHealth || !this.isCollecting || this.collectionPaused || this.isTestMode || this.collectionState !== 'collecting') return;
            const now = this._collectionHealthNow();
            const missing = [];
            for (const side of ['dev1', 'dev2']) {
                const state = this.collectionHealth.sides[side];
                const ageMs = now - (state.lastValidEmgAt ?? this.collectionHealth.startedAt);
                if (ageMs >= this.collectionHealthWarningMs && !state.warningActive) {
                    state.warningActive = true;
                    missing.push({ side, ageMs: Math.round(ageMs), receivedRows: state.received_valid_emg_rows });
                }
            }
            if (missing.length) {
                this._logCollectionHealth('emg_missing_warning', { missing });
                const hands = missing.map(item => item.side === 'dev1' ? '左手' : '右手').join('、');
                const missingParticipant = missing.find(item => this.collectionBinFilenames?.[item.side]);
                if (missingParticipant) {
                    const deviceId = missingParticipant.side === 'dev1' ? 1 : 2;
                    const identity = this.device_names?.[missingParticipant.side] || this.collectionBinFilenames[missingParticipant.side];
                    this.requestCollectionFault({
                        source: 'ble', code: 'ble_no_emg', device_id: deviceId,
                        sd_prefix: this.collectionBinFilenames[missingParticipant.side],
                        message: `${identity ? `${identity} ` : ''}连续5秒未收到有效肌电数据`
                    });
                    return;
                }
                this.notifyCollectionHealthWarning(`${hands}连续5秒未收到有效肌电数据。当前采集仍会继续，请检查手环；该提示不影响本轮流程。`);
            }
            if (this.lastCollectionFaultHealthPollAt == null || now - this.lastCollectionFaultHealthPollAt >= this.collectionHealthPollIntervalMs) {
                this.lastCollectionFaultHealthPollAt = now;
                this._pollCollectionFaultHealth().catch(error => {
                    console.error('[realtimeEngine] 采集设备/存储健康状态轮询失败:', error);
                });
            }
            if (now - this.collectionHealth.lastSummaryAt >= 10000) {
                this.collectionHealth.lastSummaryAt = now;
                this._logCollectionHealth('periodic');
            }
            if (this.collectionHealth && this.isCollecting && !this.collectionPaused && this.collectionState === 'collecting') schedule(tick);
        };
        schedule(tick);
    }

    _stopCollectionHealthTimer() {
        if (this.collectionHealthTimer) (this.collectionHealthClearTimeout || clearTimeout)(this.collectionHealthTimer);
        this.collectionHealthTimer = null;
    }

    _storageFaultCode(message) {
        return /ENOSPC|no space left|disk full|磁盘.*满|空间不足/i.test(String(message || ''))
            ? 'disk_full' : 'storage_write_failed';
    }

    async _pollCollectionFaultHealth() {
        if (this.collectionFaultHealthPollInFlight || !this._isRealCollectionActive() || this.isTestMode ||
            this.collectionState !== 'collecting' || this.collectionPaused) return;
        this.collectionFaultHealthPollInFlight = true;
        const pollToken = this.storageFileToken;
        const pollHealth = this.collectionHealth;
        const pollStreamId = this.collectionStreamId;
        const isCurrentPoll = () => this.storageFileToken === pollToken && this.collectionHealth === pollHealth &&
            this.collectionStreamId === pollStreamId && this.collectionState === 'collecting' &&
            this.isCollecting && !this.collectionPaused && !this.isTestMode && !this.isClosingStageFile;
        const tasks = [];
        if (this.stageFileOpen && !this.isClosingStageFile) {
            tasks.push((async () => {
                const expectedToken = pollToken;
                let status;
                try { status = await this.sendStorageCommand('get_file_status'); }
                catch (error) {
                    if (!isCurrentPoll()) return;
                    this.requestCollectionFault({ source: 'storage', code: 'storage_status_unavailable', message: `无法读取H5存储状态：${error.message || error}` });
                    return;
                }
                if (!isCurrentPoll()) return;
                if (expectedToken !== this.storageFileToken || this.isClosingStageFile) return;
                if (status?.file_token && status.file_token !== expectedToken) {
                    this.requestCollectionFault({ source: 'storage', code: 'storage_file_mismatch', message: 'Storage当前文件编号与本轮不一致' });
                    return;
                }
                if (status?.status !== 'success') {
                    this.requestCollectionFault({ source: 'storage', code: 'storage_status_unavailable', message: status?.msg || '无法读取H5存储状态' });
                    return;
                }
                const health = status.data_health || {};
                this._checkCollectionStorageProgress(status, expectedToken);
                if (this.collectionFault) return;
                const writeError = health.write_error || status.write_error;
                if (writeError) {
                    console.error(`[采集健康] ${JSON.stringify({ event: 'storage_write_error_detected', file_token: expectedToken, data_health: health, error: writeError })}`);
                    this.requestCollectionFault({ source: 'storage', code: this._storageFaultCode(writeError), message: `H5数据写入失败：${writeError}` });
                    return;
                }
                if (status.open === false) {
                    console.error(`[采集健康] ${JSON.stringify({ event: 'storage_file_closed_unexpectedly', file_token: expectedToken, data_health: health })}`);
                    this.requestCollectionFault({ source: 'storage', code: 'storage_file_closed', message: 'H5文件在采集期间意外关闭' });
                    return;
                }
                const free = health.disk_free_bytes;
                if (typeof free === 'number' && Number.isFinite(free) && free >= 0 && free < this.collectionDiskReserveBytes) {
                    this.requestCollectionFault({ source: 'storage', code: 'disk_space_low', message: `H5保存盘剩余 ${(free / 1024 / 1024).toFixed(1)} MiB，保存盘空间不足，预留收尾空间而停止` });
                }
            })());
        }

        const videoSides = Object.keys(this.videoFileNames || {}).filter(side => this.videoFileNames[side]);
        if (this.videoRecordingStarted && videoSides.length) {
            tasks.push((async () => {
                let status;
                try { status = await this.sendCameraCommand('get_status', {}); }
                catch (error) {
                    if (!isCurrentPoll()) return;
                    this.requestCollectionFault({ source: 'camera', code: 'camera_status_unavailable', side: videoSides[0], message: `无法读取录像状态：${error.message || error}` });
                    return;
                }
                if (!isCurrentPoll()) return;
                const free = status?.disk_free_bytes;
                if (typeof free === 'number' && Number.isFinite(free) && free >= 0 && free < this.collectionDiskReserveBytes) {
                    this.requestCollectionFault({ source: 'camera', code: 'disk_space_low', side: videoSides[0], message: `视频保存盘剩余 ${(free / 1024 / 1024).toFixed(1)} MiB，保存盘空间不足，预留收尾空间而停止` });
                    return;
                }
                for (const side of videoSides) {
                    const health = status?.recording_health?.[side];
                    const recording = status?.recording?.[side];
                    const captureRunning = status?.captures?.[side]?.running;
                    if (health?.ok === false || recording === false || captureRunning === false) {
                        const detail = health?.reason || (captureRunning === false ? '摄像头采集进程已停止' : '录像已意外停止');
                        this.requestCollectionFault({ source: 'camera', code: 'camera_recording_failed', side, message: detail });
                        return;
                    }
                }
            })());
        }
        try { await Promise.allSettled(tasks); }
        finally { this.collectionFaultHealthPollInFlight = false; }
    }

    _checkCollectionStorageProgress(status, fileToken) {
        if (this.streamMode !== 'collection' || this.collectionPaused || this.collectionState !== 'collecting') {
            this.collectionStorageProgress = null;
            return;
        }
        const now = this._collectionHealthNow();
        const health = status?.data_health || {};
        const actual = health.emg_rows || {};
        const written = Number(health.sequences?.written ?? status?.written_sequence);
        for (const side of this._collectionParticipantSides()) {
            const sideHealth = this.collectionHealth?.sides?.[side];
            if (!sideHealth) continue;
            const current = {
                fileToken,
                at: now,
                received: sideHealth.received_valid_emg_rows || 0,
                sent: sideHealth.sent_to_storage_rows || 0,
                actual: Number(actual[side] || 0),
                lastSentSequence: this.storageDataLastSentSequence || 0,
                writtenSequence: Number.isFinite(written) ? written : null
            };
            const previous = this.collectionStorageProgress?.[side];
            if (!previous || previous.fileToken !== fileToken || now < previous.at) {
                const lagging = current.sent > current.actual ||
                    (current.writtenSequence != null && current.lastSentSequence > current.writtenSequence);
                this.collectionStorageProgress = { ...(this.collectionStorageProgress || {}), [side]: { ...current, stalledSince: lagging ? now : null } };
                continue;
            }
            const activity = current.received > previous.received || current.sent > previous.sent || current.lastSentSequence > previous.lastSentSequence;
            const actualStalledWithActivity = current.actual <= previous.actual && activity;
            const sequenceStalledWithActivity = current.writtenSequence != null && previous.writtenSequence != null &&
                current.lastSentSequence > current.writtenSequence && current.writtenSequence <= previous.writtenSequence &&
                current.lastSentSequence >= previous.lastSentSequence;
            let stalledSince = previous.stalledSince;
            if (actualStalledWithActivity || sequenceStalledWithActivity) stalledSince ??= now;
            else stalledSince = null;
            const next = { ...current, stalledSince };
            this.collectionStorageProgress = { ...(this.collectionStorageProgress || {}), [side]: next };
            if (stalledSince != null && now - stalledSince >= 10000) {
                const label = side === 'dev1' ? '左手' : '右手';
                const detail = `H5写入停滞10秒（${label} received=${current.received}, sent=${current.sent}, actual=${current.actual}, written_sequence=${current.writtenSequence}, last_sent_sequence=${current.lastSentSequence}）`;
                console.error(`[采集健康] ${JSON.stringify({ event: 'storage_write_stalled', side, file_token: fileToken, ...current, stalled_ms: now - stalledSince })}`);
                this.requestCollectionFault({ source: 'storage', code: 'storage_write_stalled', message: detail });
                return;
            }
        }
    }

    _handleCameraRecordingStatus(status = {}) {
        if (!this._isCollectionRuntimeActive()) return;
        for (const side of Object.keys(this.videoFileNames || {})) {
            if (!this.videoFileNames[side]) continue;
            const health = status.recording_health?.[side];
            if (health?.ok === false) {
                this.requestCollectionFault({ source: 'camera', side, code: 'camera_recording_failed', message: health.reason || '录像写入失败' });
                return;
            }
        }
    }

    _pauseCollectionHealthClock() {
        if (!this.collectionHealth || this.collectionHealth.pausedAt != null) return;
        this.collectionHealth.pausedAt = this._collectionHealthNow();
        this._stopCollectionHealthTimer();
        this._logCollectionHealth('paused');
    }

    _resumeCollectionHealthClock() {
        const health = this.collectionHealth;
        if (!health || health.pausedAt == null) return;
        const pausedMs = this._collectionHealthNow() - health.pausedAt;
        health.startedAt += pausedMs;
        health.lastSummaryAt += pausedMs;
        for (const side of ['dev1', 'dev2']) {
            if (health.sides[side].lastValidEmgAt != null) health.sides[side].lastValidEmgAt += pausedMs;
        }
        health.pausedAt = null;
        this._logCollectionHealth('resumed', { paused_ms: Math.round(pausedMs) });
        this._startCollectionHealthTimer();
    }

    notifyCollectionHealthWarning(message) {
        this.broadcastToClients({
            type: 'h5_storage_warning', level: 'warning', nonBlocking: true, message,
            stageName: this.currentStageName, sessionNumber: this.currentSessionNumber, timestamp: Date.now()
        });
    }

    _reportCaptureWarnings(response) {
        const warnings = Array.isArray(response.capture_warnings) ? response.capture_warnings : [];
        if (!warnings.length) return;
        const health = response.data_health || {};
        const rows = health.emg_rows || {};
        const leftName = health.devices?.dev1?.name || this.device_names?.dev1 || '左手';
        const rightName = health.devices?.dev2?.name || this.device_names?.dev2 || '右手';
        const labels = { emg_dev1_empty: '左手没有有效肌电行', emg_dev2_empty: '右手没有有效肌电行' };
        const reason = warnings.map(code => labels[code]).filter(Boolean);
        const validation = health.save_validation === 'valid' ? '已完成读回校验' :
            health.save_validation === 'pending' ? '读回校验尚未完成' :
            health.save_validation === 'failed' ? '读回校验未通过' : '校验状态未知';
        const actualPath = health.file_path || this.collectionHealth?.filename || null;
        const basename = actualPath ? String(actualPath).split(/[\\/]/).pop() : null;
        const sessionNumber = this.currentSessionNumber || 1;
        const fileContext = `${basename ? `文件 ${basename}` : '本轮文件'}，第${sessionNumber}轮`;
        const message = `${reason.join('；') || '数据完整性提示'}。${fileContext}已关闭：${leftName} ${rows.dev1 ?? 0}行，${rightName} ${rows.dev2 ?? 0}行；${validation}。`;
        console.log(`[采集健康] ${JSON.stringify({ event: 'python_close_warning', filename: actualPath, file_token: health.file_token || this.storageFileToken, session_id: health.session_id || this.collectionStreamId, capture_warnings: warnings, data_health: health })}`);
        this.notifyCollectionHealthWarning(message);
    }

    async closeStageFile(extraParams = {}, incomplete = false) {
        if (this.isClosingStageFile && this.activeCloseStageFilePromise) {
            return this.activeCloseStageFilePromise;
        }
        if (this.stageFileOpening && this.stageFileOpenPromise) {
            try {
                await this.stageFileOpenPromise;
            } catch (error) {
                console.warn('[realtimeEngine] 等待Stage文件打开完成失败:', error.message);
                this.stageFileCreateFailed = true;
            }
        }
        // Another caller may have started closing while we waited for create.
        if (this.isClosingStageFile && this.activeCloseStageFilePromise) {
            return this.activeCloseStageFilePromise;
        }
        if (this.stageFileCreateFailed) {
            if (!incomplete) return { status: 'error', msg: 'H5文件创建失败，无法关闭Stage' };
            const status = await this.sendStorageCommand('get_file_status');
            if (status.status !== 'success' || typeof status.open !== 'boolean') {
                return { status: 'error', msg: status.msg || '无法核对Storage文件状态' };
            }
            if (status.open && status.file_token !== this.storageFileToken) {
                return { status: 'error', msg: 'Storage正在处理其他文件，不能恢复当前会话' };
            }
            this.stageFileOpen = !!status.open;
        }
        if (!this.stageFileOpen) {
            return { status: 'success', msg: 'no_open_file' };
        }

        this.isClosingStageFile = true;
        this._stopCollectionHealthTimer();
        this._logCollectionHealth('close_before', { filename: this.collectionHealth?.filename || null });

        this.activeCloseStageFilePromise = (async () => {
            // Wait until every PUSH send accepted by this process has been
            // issued, then let storage_server drain the same data channel up
            // to this sequence before it closes the H5 file.
            if (incomplete) await this.storagePushSendChain;
            else await this.flushStorageData();
            const params = {
                end_time: Date.now() / 1000,
                _storage_data_seq: this.storageDataLastSentSequence,
                _storage_file_token: this.storageFileToken,
                ...extraParams
            };
            const response = await this.sendStorageCommand(incomplete ? 'finalize_incomplete' : 'close', params);
            if (response.status === 'success') {
                this.stageFileOpen = false;
                const status = params.collection_status || 'completed';
                console.log(`[realtimeEngine] ✅ 文件已关闭 (collection_status: ${status})`);
                this._reportCaptureWarnings(response);
            } else {
                console.error('[realtimeEngine] ❌ Storage拒绝关闭文件:', response);
            }
            this._logCollectionHealth('close_after', { status: response.status, capture_warnings: response.capture_warnings || [] });
            return response;
        })().catch(error => {
            console.error('[realtimeEngine] 关闭Stage文件失败:', error);
            this._logCollectionHealth('close_failed', { error: error.message || String(error) });
            return { status: 'error', msg: error.message || String(error) };
        });

        try {
            return await this.activeCloseStageFilePromise;
        } finally {
            this.isClosingStageFile = false;
            this.activeCloseStageFilePromise = null;
        }
    }

    onTransportFault(packet) {
        if (packet?.type === 'capture_fault') {
            this.requestCollectionFault(packet);
            return;
        }
        const source = packet?.source || 'device';
        const message = `${source} 数据传输失败: ${packet?.error || '数据丢失'} (dropped=${packet?.dropped || 0})`;
        if (this._isRealCollectionActive() && this._matchesCollectionFaultTarget({ ...packet, source })) {
            this.requestCollectionFault({ ...packet, source, code: packet?.code || `${source}_transport_fault`, message });
        } else {
            this.broadcastToClients({ ...packet, type: 'transport_fault' });
        }
    }

    broadcastToClients(dataPacket) {
        const message = JSON.stringify(dataPacket);
        const bytes = Buffer.byteLength(message);
        const preview = ['realtime_data', 'realtime_data_batch', 'mocap_data'].includes(dataPacket.type);
        for (const client of this.clients) {
            if (client.readyState !== WebSocket.OPEN) continue;
            if ((client.bufferedAmount || 0) + bytes > this.previewByteLimit) {
                if (!preview) {
                    console.error('[realtimeEngine] 可靠通知无法发送，断开慢客户端:', dataPacket.type);
                    client.terminate?.(); this.clients.delete(client); continue;
                }
                this.previewDroppedPackets++;
                client.slowPreviewCount = (client.slowPreviewCount || 0) + 1;
                if (client.slowPreviewCount >= 20) { client.terminate?.(); this.clients.delete(client); }
                continue;
            }
            client.slowPreviewCount = 0;
            try { client.send(message); } catch (error) { this.clients.delete(client); client.terminate?.(); }
        }
    }

    ble_server_connect() {
        if (this.stopping) return;
        // 【修复】清理旧连接时先清除事件处理器，避免触发重连
        if (this.ble_client) {
            this.ble_client.onopen = null;
            this.ble_client.onclose = null;
            this.ble_client.onerror = null;
            this.ble_client.onmessage = null;
            try { this.ble_client.close(); } catch (e) {}
            this.ble_client = null;
        }

        try {
            console.log(`[realtimeEngine] 正在连接BLE数据端: ${this.ble_clientUrl} (尝试 ${this.currentReconnectTimes + 1}/${this.maxReconnectTimes})`);
            this.ble_client = new WebSocket(this.ble_clientUrl);

            this.ble_client.onopen = () => {
                console.log(`[realtimeEngine] ✅ BLE数据端连接成功 (${this.ble_clientUrl})`);
                this.currentReconnectTimes = 0;
                clearTimeout(this.reconnectTimer);
                this.broadcastToClients({ type: 'ble_connection_status', connected: true, message: 'BLE服务器已连接' });
            };

            this.ble_client.onmessage = (event) => {
                try {
                    const packet = JSON.parse(event.data);

                    // 调试：打印收到的数据类型
                    if (packet.type === 'capture_fault') { this.requestCollectionFault(packet); return; }
                    if (packet.type === 'transport_fault') { this.onTransportFault(packet); return; }
                    if (packet.type === 'event' && packet.event === 'device_disconnected') {
                        this.requestCollectionFault({ ...packet, source: 'ble', code: 'ble_disconnected', message: '蓝牙设备已断开' });
                        return;
                    }
                    if (packet.type === 'data') {
                        this.handleBleDataPacket(packet);
                        return;
                    }
                    if (packet.type === 'emg_packet') { this.attributeEMGData(packet); return; }
                    // 【新增】监听sd_filenames_updated事件（包含设备名称、stream_mode、collection_stream_id）
                    if (packet.type === 'event' && packet.event === 'sd_filenames_updated') {
                        this.onSdFilenamesUpdated(
                            packet.sd_filenames,
                            packet.device_names,
                            packet.stream_mode,
                            packet.collection_stream_id,
                            packet.device_configs
                        );
                        return;
                    }
                    // 【新增】监听collection_stopped事件
                    if (packet.type === 'event' && packet.event === 'collection_stopped') {
                        console.log(`[realtimeEngine] collection stream 已停止: ${JSON.stringify(packet.sd_filenames)}`);
                        if (this._isCollectionRuntimeActive() && !this.collectionPaused &&
                            this.collectionState === 'collecting' && this._collectionParticipantSides().length) {
                            this.requestCollectionFault({ source: 'ble', code: 'collection_stream_stopped',
                                message: '采集期间BLE collection stream意外停止' });
                        }
                        this.streamMode = 'idle';
                        return;
                    }

                    // 打印欢迎消息
                    if (packet.type === 'welcome') {
                        console.log(`[realtimeEngine] 收到数据端欢迎消息:`, packet.message);
                    }
                } catch (error) {}
            };

            this.ble_client.onerror = (error) => {
                // 【修复】onerror后通常会触发onclose，这里不重复处理
                console.log(`[realtimeEngine] BLE数据端连接错误`);
            };
            this.ble_client.onclose = (event) => {
                console.log(`[realtimeEngine] BLE数据端连接关闭, code: ${event.code}`);
                this.ble_client = null;  // 【修复】清理引用
                this.broadcastToClients({ type: 'ble_connection_status', connected: false, message: 'BLE服务器连接已断开' });
                if (this._isCollectionRuntimeActive() && this._collectionParticipantSides().length) {
                    this.requestCollectionFault({ source: 'ble', code: 'ble_transport_disconnected', message: 'BLE数据连接已断开' });
                }
                if (event.code !== 1000) this.handleReconnect();
            };

        } catch (error) { this.handleReconnect('创建连接失败'); }
    }

    handleReconnect(reason = '连接断开') {
        if (this.stopping) return;
        if (this.currentReconnectTimes >= this.maxReconnectTimes) return;
        this.currentReconnectTimes++;
        this.reconnectTimer = setTimeout(() => { this.ble_server_connect(); }, this.reconnectInterval);
    }

    // 【新增】Mocap Server连接
    mocap_server_connect() {
        if (this.stopping) return;
        // 【修复】清理旧连接时先清除事件处理器，避免触发重连
        if (this.mocap_client) {
            this.mocap_client.onopen = null;
            this.mocap_client.onclose = null;
            this.mocap_client.onerror = null;
            this.mocap_client.onmessage = null;
            try { this.mocap_client.close(); } catch (e) {}
            this.mocap_client = null;
        }

        try {
            console.log(`[realtimeEngine] 正在连接Mocap服务器: ${this.mocap_clientUrl} (尝试 ${this.mocap_currentReconnectTimes + 1}/${this.mocap_maxReconnectTimes})`);
            this.mocap_client = new WebSocket(this.mocap_clientUrl);

            this.mocap_client.onopen = () => {
                console.log(`[realtimeEngine] ✅ Mocap服务器连接成功`);
                this.mocap_currentReconnectTimes = 0;
                this.mocap_connected = true;
                clearTimeout(this.mocap_reconnectTimer);

                this.broadcastToClients({ type: 'mocap_connection_status', connected: true, message: 'Mocap服务器已连接' });

                if (this.mocap_activeChannel) {
                    this.mocap_client.send(JSON.stringify({ cmd: 'set_channel', channel: this.mocap_activeChannel }));
                }
            };

            this.mocap_client.onmessage = (event) => {
                try {
                    const packet = JSON.parse(event.data);
                    if (packet.type === 'transport_fault') { this.onTransportFault(packet); return; }
                    if (packet.type === 'mocap') { this.handleMocapDataPacket(packet); }
                    // 【新增】转发SDK状态响应给前端
                    else if (packet.type === 'response' && packet.cmd && packet.cmd.startsWith('sdk_')) {
                        this.broadcastToClients({
                            type: 'mocap_sdk_status',
                            cmd: packet.cmd,
                            status: packet.status,
                            sdk_connected: packet.sdk_connected,
                            message: packet.message
                        });
                    }
                } catch (error) {}
            };

            this.mocap_client.onerror = (error) => {
                // 【修复】onerror后通常会触发onclose，这里不重复处理
                console.log(`[realtimeEngine] Mocap服务器连接错误`);
            };
            this.mocap_client.onclose = (event) => {
                console.log(`[realtimeEngine] Mocap服务器连接关闭, code: ${event.code}`);
                this.mocap_connected = false;
                this.mocap_client = null;  // 【修复】清理引用
                this.broadcastToClients({ type: 'mocap_connection_status', connected: false, message: 'Mocap服务器连接已断开' });
                if (this._isCollectionRuntimeActive() && this.currentStageNeedMocap) {
                    this.requestCollectionFault({ source: 'mocap', code: 'mocap_disconnected', message: '本Stage需要的动捕连接已断开' });
                }
                if (event.code !== 1000) this.handleMocapReconnect();
            };

        } catch (error) { this.handleMocapReconnect('创建连接失败'); }
    }

    handleMocapReconnect(reason = '连接断开') {
        if (this.stopping) return;
        if (this.mocap_currentReconnectTimes >= this.mocap_maxReconnectTimes) return;
        this.mocap_currentReconnectTimes++;
        this.mocap_reconnectTimer = setTimeout(() => { this.mocap_server_connect(); }, this.mocap_reconnectInterval);
    }

    // ==================== Camera Server 连接管理 ====================

    camera_server_connect() {
        if (this.stopping) return;
        // 清理旧连接
        if (this.camera_client) {
            this.camera_client.onopen = null;
            this.camera_client.onclose = null;
            this.camera_client.onerror = null;
            this.camera_client.onmessage = null;
            try { this.camera_client.close(); } catch (e) {}
            this.camera_client = null;
        }

        try {
            console.log(`[realtimeEngine] 正在连接Camera服务器: ${this.camera_clientUrl} (尝试 ${this.camera_currentReconnectTimes + 1}/${this.camera_maxReconnectTimes})`);
            this.camera_client = new WebSocket(this.camera_clientUrl);

            this.camera_client.onopen = () => {
                console.log(`[realtimeEngine] ✅ Camera服务器连接成功`);
                this.camera_currentReconnectTimes = 0;
                this.camera_connected = true;
                clearTimeout(this.camera_reconnectTimer);

                this.broadcastToClients({ type: 'camera_connection_status', connected: true, message: 'Camera服务器已连接' });
            };

            this.camera_client.onmessage = (event) => {
                try {
                    const response = JSON.parse(event.data);
                    if (response.type === 'recording_status') this._handleCameraRecordingStatus(response);
                } catch (error) {
                    console.error('[realtimeEngine] 解析Camera响应失败:', error);
                }
            };

            this.camera_client.onerror = (error) => {
                console.log(`[realtimeEngine] Camera服务器连接错误`);
            };

            this.camera_client.onclose = (event) => {
                console.log(`[realtimeEngine] Camera服务器连接关闭, code: ${event.code}`);
                this.camera_connected = false;
                this.camera_client = null;
                this.broadcastToClients({ type: 'camera_connection_status', connected: false, message: 'Camera服务器连接已断开' });
                if (this._isCollectionRuntimeActive() && this.videoRecordingStarted && Object.keys(this.videoFileNames || {}).some(side => this.videoFileNames[side])) {
                    const side = Object.keys(this.videoFileNames || {}).find(key => this.videoFileNames[key]);
                    this.requestCollectionFault({ source: 'camera', side, code: 'camera_disconnected', message: '本轮录像期间相机服务连接已断开' });
                }
                if (event.code !== 1000) this.handleCameraReconnect();
            };

        } catch (error) {
            console.error('[realtimeEngine] 创建Camera连接失败:', error);
            this.handleCameraReconnect('创建连接失败');
        }
    }

    handleCameraReconnect(reason = '连接断开') {
        if (this.stopping) return;
        if (this.camera_currentReconnectTimes >= this.camera_maxReconnectTimes) {
            console.log('[realtimeEngine] Camera服务器重连次数已达上限，停止重连');
            return;
        }
        this.camera_currentReconnectTimes++;
        console.log(`[realtimeEngine] 将在${this.camera_reconnectInterval}ms后重连Camera服务器...`);
        this.camera_reconnectTimer = setTimeout(() => {
            this.camera_server_connect();
        }, this.camera_reconnectInterval);
    }

    /**
     * 发送命令到Camera服务器（带 request_id 匹配）
     */
    async sendCameraCommand(command, data = {}, timeoutMs = null) {
        const socket = this.camera_client;
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Camera服务器未连接');
        return new Promise((resolve, reject) => {
            const requestId = `rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const cleanup = () => {
                clearTimeout(timeout);
                socket.removeEventListener('message', onMessage);
                socket.removeEventListener('close', onDisconnect);
                socket.removeEventListener('error', onDisconnect);
            };
            const fail = error => { cleanup(); reject(error); };
            const onDisconnect = () => fail(new Error('Camera连接已断开；保存结果待核对'));
            const onMessage = event => {
                let response;
                try { response = JSON.parse(event.data); } catch (_) { return; }
                if (response.request_id !== requestId) return;
                cleanup(); resolve(response);
            };
            const defaultTimeout = command === 'stop_and_save' ? 1860000 : 15000;
            const timeout = setTimeout(() => fail(new Error('Camera命令超时；保存结果待核对')),
                Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeout);
            socket.addEventListener('message', onMessage);
            socket.addEventListener('close', onDisconnect);
            socket.addEventListener('error', onDisconnect);
            try { socket.send(JSON.stringify({ command, request_id: requestId, ...data })); }
            catch (error) { fail(error); }
        });
    }

    // ==================== End Camera Server ====================

    // 【新增】处理Mocap数据包
    handleMocapDataPacket(packet) {
        if (!this.isRunning) return;

        try {
            this.mocap_packet_count++;
            // 【始终】广播给前端（用于实时显示）
            this.broadcastToClients({ type: 'mocap_data', data: packet });

            // 【修改】采集时批量保存 mocap 原始数据到 storage
            // 【新增】只有当前stage需要动捕数据时才保存
            if (this.isCollecting && !this.collectionPaused && this.stageFileOpen && !this.isClosingStageFile && this.currentStageNeedMocap) {
                // 获取批量帧数据
                const frames = packet.frames;  // [{markers, frame, time, sys_time}, ...]

                if (frames && frames.length > 0) {
                    // 【修改】优先使用 mocap_server 传过来的 sys_time（更精确）
                    // 如果没有 sys_time（兼容旧版），则使用本地时间估算
                    const fallbackSysTime = getSysTimeNode();
                    const framesWithSysTime = frames.map((f, idx) => ({
                        ...f,
                        // 优先使用 mocap_server 的 sys_time，否则用本地估算
                        sys_time: f.sys_time || (fallbackSysTime + idx * 0.005)
                    }));

                    // 批量发送所有帧到 storage
                    this.saveDataToStorage({
                        mocap_frames: framesWithSysTime,  // 批量帧数据（带系统时间戳）
                        mocap_batch_size: framesWithSysTime.length
                    });
                }
            }
        } catch (error) {
            console.error('[realtimeEngine] 处理Mocap数据包错误:', error);
        }
    }

    // V1/V2 统一的 IMU 数据规范化
    // V1: dev.imu = [[acc,gyr,mag], [acc,gyr,mag]]  (2 chips, ICM-20948)
    // V2: dev.imu = [[acc,gyr], [acc,gyr], [acc,gyr]]  (0-3 chips, LSM6DSV32X, no mag)
    normalizeImuData(dev) {
        if (!dev || !dev.imu) return { hwVersion: dev?.hw_version || "V1", numImus: 0, imus: [] };

        const hwVersion = dev.hw_version || "V1";
        const numImus = dev.num_imus || dev.imu.length || 0;
        const imus = [];

        for (let i = 0; i < dev.imu.length; i++) {
            const chip = dev.imu[i];
            imus.push({
                index: i,
                acc: chip[0] || [0, 0, 0],
                gyr: chip[1] || [0, 0, 0],
                mag: hwVersion === "V1" ? (chip[2] || [0, 0, 0]) : null,  // V2 no mag
            });
        }

        return { hwVersion, numImus, imus };
    }

    // Extract a single IMU chip for legacy {acc, gyr, mag} format
    imuChipToLegacy(chip, hwVersion) {
        return {
            acc: chip[0] || [0, 0, 0],
            gyr: chip[1] || [0, 0, 0],
            mag: hwVersion === "V1" ? (chip[2] || [0, 0, 0]) : null,
        };
    }

    handleBleDataPacket(packet) {
        if (!this.isRunning) return;

        try {
            if (!packet.dev1 && !packet.dev2) return;

            // Normalize to arrays, matching ble_server.py data_sender_thread batch behavior
            const dev1List = Array.isArray(packet.dev1) ? packet.dev1 : (packet.dev1 ? [packet.dev1] : []);
            const dev2List = Array.isArray(packet.dev2) ? packet.dev2 : (packet.dev2 ? [packet.dev2] : []);
            const maxLen = Math.max(dev1List.length, dev2List.length);

            for (let i = 0; i < maxLen; i++) {
                const dev1 = dev1List[i] || null;
                const dev2 = dev2List[i] || null;

                if (!dev1 && !dev2) continue;

                let emg1Data = null, emg2Data = null;
                let emg1RawData = null, emg2RawData = null;
                let emg1Timestamps = null, emg2Timestamps = null;
                let emg1FrameIds = null, emg2FrameIds = null;
                let imu1Norm = null, imu2Norm = null;
                let imu1Timestamps = null, imu2Timestamps = null;
                let imu1aData = null, imu1bData = null;
                let imu2aData = null, imu2bData = null;
                let imu1All = null, imu2All = null;
                let imu1HwVersion = null, imu2HwVersion = null;
                let imu1NumImus = null, imu2NumImus = null;
                // Prefer sub-packet's own timestamp (set by ble_server create_notification_handler)
                let timestamp = (dev1 && dev1.t) || (dev2 && dev2.t) || packet.ts;
                let stats1 = null, stats2 = null;
                let framesInPacket = 9;

                // ===== Process dev1 sub-packet =====
                if (dev1) {
                    if (dev1.uv?.length > 0) emg1Data = this.transposeEMG(dev1.uv);
                    if (dev1.raw?.length > 0) emg1RawData = this.transposeEMG(dev1.raw);
                    if (dev1.emg_t?.length > 0) emg1Timestamps = dev1.emg_t;
                    if (dev1.frame_ids?.length > 0) emg1FrameIds = dev1.frame_ids;
                    if (dev1.imu_t?.length > 0) imu1Timestamps = dev1.imu_t;
                    stats1 = dev1.s ? { total: dev1.s[0], lost: dev1.s[1] } : null;
                    framesInPacket = dev1.n || 9;
                    this.dev1_packet_count += framesInPacket;

                    imu1Norm = this.normalizeImuData(dev1);
                    imu1HwVersion = imu1Norm.hwVersion;
                    imu1NumImus = imu1Norm.numImus;
                    imu1All = imu1Norm.imus;

                    if (imu1HwVersion === "V1") {
                        if (dev1.imu?.[0]) imu1aData = this.imuChipToLegacy(dev1.imu[0], imu1HwVersion);
                        if (dev1.imu?.[1]) imu1bData = this.imuChipToLegacy(dev1.imu[1], imu1HwVersion);
                    }
                }

                // ===== Process dev2 sub-packet =====
                if (dev2) {
                    if (dev2.uv?.length > 0) emg2Data = this.transposeEMG(dev2.uv);
                    if (dev2.raw?.length > 0) emg2RawData = this.transposeEMG(dev2.raw);
                    if (dev2.emg_t?.length > 0) emg2Timestamps = dev2.emg_t;
                    if (dev2.frame_ids?.length > 0) emg2FrameIds = dev2.frame_ids;
                    if (dev2.imu_t?.length > 0) imu2Timestamps = dev2.imu_t;
                    stats2 = dev2.s ? { total: dev2.s[0], lost: dev2.s[1] } : null;
                    this.dev2_packet_count += (dev2.n || 9);
                    // Use max when both devices have data in the same pair
                    if (dev2.n && dev2.n > framesInPacket) framesInPacket = dev2.n;

                    imu2Norm = this.normalizeImuData(dev2);
                    imu2HwVersion = imu2Norm.hwVersion;
                    imu2NumImus = imu2Norm.numImus;
                    imu2All = imu2Norm.imus;

                    if (imu2HwVersion === "V1") {
                        if (dev2.imu?.[0]) imu2aData = this.imuChipToLegacy(dev2.imu[0], imu2HwVersion);
                        if (dev2.imu?.[1]) imu2bData = this.imuChipToLegacy(dev2.imu[1], imu2HwVersion);
                    }
                }

                this.emg_packet_count += framesInPacket;

                const dataItem = {
                    emg1: emg1Data, emg2: emg2Data,
                    imu1: imu1Norm?.imus || null, imu2: imu2Norm?.imus || null,
                    timestamp, packetCount: this.emg_packet_count, framesInPacket,
                    stats1, stats2, activeDevices: packet.active || []
                };
                this.realtimeDataBuffer.push(dataItem);

                if (!this.realtimeDataTimer) {
                    this.realtimeDataTimer = setTimeout(() => {
                        this.flushRealtimeDataBuffer();
                    }, this.realtimeDataMaxDelay);
                }

                if (this.realtimeDataBuffer.length >= this.realtimeDataBufferLimit) {
                    this.flushRealtimeDataBuffer();
                }

                const storagePacketTs = Math.max(
                    Number(dev1?.t) || 0,
                    Number(dev2?.t) || 0,
                    Number(timestamp) || 0
                );
                const isFreshCollectionPacket =
                    !this.collectionDataStartTs ||
                    !storagePacketTs ||
                    storagePacketTs >= (this.collectionDataStartTs - 0.05);
                const h5OpenGraceExpired =
                    !this.collectionDataStartTs ||
                    ((Date.now() / 1000) - this.collectionDataStartTs) > 2.0;
                const rawEmgRows = {
                    dev1: emg1RawData?.[0]?.length || 0,
                    dev2: emg2RawData?.[0]?.length || 0
                };
                const shouldOfferToStorage = this.isCollecting && !this.collectionPaused && this.stageFileOpen && !this.isClosingStageFile && isFreshCollectionPacket;
                if (this.isCollecting && !this.collectionPaused) {
                    this._recordCollectionHealthReceived('dev1', rawEmgRows.dev1);
                    this._recordCollectionHealthReceived('dev2', rawEmgRows.dev2);
                }

                // Send raw data to storage_server for this sub-packet pair
                if (shouldOfferToStorage) {
                    this.saveDataToStorage({
                        emg1: emg1RawData, emg2: emg2RawData, emg1_t: emg1Timestamps, emg2_t: emg2Timestamps,
                        emg1_frame_ids: emg1FrameIds, emg2_frame_ids: emg2FrameIds,
                        imu1a: imu1aData, imu1b: imu1bData, imu1_t: imu1Timestamps,
                        imu2a: imu2aData, imu2b: imu2bData, imu2_t: imu2Timestamps,
                        imu1_all: imu1All, imu2_all: imu2All,
                        imu1_hw_version: imu1HwVersion, imu2_hw_version: imu2HwVersion,
                        imu1_num_imus: imu1NumImus, imu2_num_imus: imu2NumImus,
                    });
                } else if (this.isCollecting && !this.collectionPaused && !this.isTestMode && !this.stageFileOpen && !this.stageFileOpening && !this.isClosingStageFile && h5OpenGraceExpired &&
                    (rawEmgRows.dev1 > 0 || rawEmgRows.dev2 > 0)) {
                    this.notifyH5StorageWarning('已收到手环数据，但H5文件未打开，当前轮次数据不会落盘；请紧急中断并重采本轮');
                } else if (this.isCollecting && this.stageFileOpen && !isFreshCollectionPacket) {
                    this.collectionDroppedStaleBlePackets++;
                    if (this.collectionDroppedStaleBlePackets <= 3) {
                        console.log(`[realtimeEngine] drop stale BLE packet before collection_start: packet_ts=${storagePacketTs}, start_ts=${this.collectionDataStartTs}`);
                    }
                }
                if (this.isCollecting && !shouldOfferToStorage) {
                    let filterReason = null;
                    if (this.isTestMode) filterReason = 'test_mode';
                    else if (this.streamMode !== 'collection') filterReason = 'stream_not_collection';
                    else if (this.collectionPaused) filterReason = 'paused';
                    else if (this.isClosingStageFile || this.collectionState === 'stopping') filterReason = 'closing';
                    else if (this.stageFileOpening) filterReason = 'file_opening';
                    else if (!this.stageFileOpen) filterReason = 'file_not_open';
                    else if (!isFreshCollectionPacket) filterReason = 'stale_pre_start';
                    if (filterReason) {
                        this._recordCollectionHealthFiltered(filterReason, 'dev1', rawEmgRows.dev1);
                        this._recordCollectionHealthFiltered(filterReason, 'dev2', rawEmgRows.dev2);
                    }
                }
            }

        } catch (error) {
            console.error('[realtimeEngine] 处理BLE数据包错误:', error);
        }
    }

    // 【新增】批量发送缓冲区数据给前端
    flushRealtimeDataBuffer() {
        if (this.realtimeDataTimer) {
            clearTimeout(this.realtimeDataTimer);
            this.realtimeDataTimer = null;
        }

        if (this.realtimeDataBuffer.length === 0) return;

        // 批量发送所有缓冲的数据
        this.broadcastToClients({
            type: 'realtime_data_batch',
            batch: this.realtimeDataBuffer
        });

        this.realtimeDataBuffer = [];
    }

    transposeEMG(uvData) {
        if (!uvData || uvData.length === 0) return null;
        const numFrames = uvData.length;
        const numChannels = uvData[0].length;
        const transposed = [];
        for (let ch = 0; ch < numChannels; ch++) {
            const channelData = [];
            for (let frame = 0; frame < numFrames; frame++) {
                channelData.push(uvData[frame][ch]);
            }
            transposed.push(channelData);
        }
        return transposed;
    }

    async storage_server_connect() {
        try {
            // 连接 REP socket（用于控制命令）
            const address = `tcp://${this.storage_server_host}:${this.storage_server_port}`;
            await this.storage_server_socket.connect(address);
            this.storage_connected = true;
            console.log(`[realtimeEngine] 已连接到storage_server控制端: ${address}`);

            // 【新增】连接 PUSH socket（用于数据发送）
            const dataAddress = `tcp://${this.storage_server_host}:${this.storage_data_port}`;
            await this.storage_push_socket.connect(dataAddress);
            this.storage_push_connected = true;
            console.log(`[realtimeEngine] 已连接到storage_server数据端: ${dataAddress} (PUSH模式)`);
        } catch (err) {
            this.storage_connected = false;
            this.storage_push_connected = false;
            console.error('[realtimeEngine] 连接storage_server失败:', err);
        }
    }

    _configureStorageSockets() {
        this.storage_server_socket.sendTimeout = 5000;
        this.storage_server_socket.receiveTimeout = 10000;
        this.storage_server_socket.linger = 0;
        this.storage_push_socket.sendTimeout = 5000;
        this.storage_push_socket.linger = 0;
    }

    async _reconnectStorageControlSocket() {
        try { this.storage_server_socket.close(); } catch (e) {}
        this.storage_server_socket = new zmq.Request();
        this._configureStorageSockets();
        const address = `tcp://${this.storage_server_host}:${this.storage_server_port}`;
        await this.storage_server_socket.connect(address);
        this.storage_connected = true;
    }

    async sendStorageCommand(cmd, params = {}) {
        if (!['create', 'get_file_status', 'stats', 'tree'].includes(cmd)) {
            params = { _storage_file_token: this.storageFileToken, ...params };
        }
        return new Promise((resolve, reject) => {
            if (this.storageRequestQueue.length >= 1000) {
                const error = new Error('Storage控制命令队列已满');
                console.error('[realtimeEngine] ❌', error.message);
                reject(error);
                return;
            }
            this.storageRequestQueue.push({ cmd, params, resolve, reject });
            if (!this.isStorageRequestPending) this._processStorageQueue();
        });
    }
    
    async _processStorageQueue() {
        if (this.isStorageRequestPending || this.storageRequestQueue.length === 0) return;
        
        this.isStorageRequestPending = true;
        
        while (this.storageRequestQueue.length > 0) {
            const { cmd, params, resolve, reject } = this.storageRequestQueue.shift();
            try {
                const request = JSON.stringify({ cmd, params });
                await this.storage_server_socket.send(request);
                const [responseBuffer] = await this.storage_server_socket.receive();
                const response = JSON.parse(responseBuffer.toString('utf8'));
                resolve(response);
            } catch (err) {
                this.storage_connected = false;
                try { await this._reconnectStorageControlSocket(); } catch (reconnectError) {
                    console.error('[realtimeEngine] Storage控制socket重建失败:', reconnectError.message);
                }
                const storageError = new Error(`Storage命令失败(${cmd}): ${err.message}`);
                reject(storageError);
                while (this.storageRequestQueue.length > 0) {
                    const queued = this.storageRequestQueue.shift();
                    queued.reject(new Error(`Storage命令因前序失败而取消: ${storageError.message}`));
                }
                break;
            }
        }
        this.isStorageRequestPending = false;
    }

    async saveDataToStorage(sensorData) {
        const healthRows = this._collectionHealthRows(sensorData);
        const healthAtSend = this.collectionHealth;
        const markFiltered = reason => {
            this._recordCollectionHealthFiltered(reason, 'dev1', healthRows.dev1);
            this._recordCollectionHealthFiltered(reason, 'dev2', healthRows.dev2);
        };
        // 【新增】preview stream 数据不写入 H5（仅 collection stream 写入）
        if (this.streamMode !== 'collection') {
            markFiltered('stream_not_collection');
            return;
        }
        if (this.isClosingStageFile || !this.stageFileOpen) {
            markFiltered(this.isClosingStageFile ? 'closing' : (this.stageFileOpening ? 'file_opening' : 'file_not_open'));
            return;
        }
        if (this.storageDataSendError) {
            markFiltered('previous_send_error');
            return;
        }
        if (this.storagePushPendingCount >= 1000) {
            const error = new Error('Storage数据发送队列已满');
            this._logCollectionHealth('storage_send_queue_full', { error: error.message, rows: healthRows });
            this.requestCollectionFault({ source: 'storage', code: 'storage_backpressure', message: error.message });
            return;
        }
        this.storagePushPendingCount++;
        for (const side of ['dev1', 'dev2']) if (healthRows[side] > 0 && healthAtSend?.sides[side]) healthAtSend.sides[side].pending++;
        let sequence = null;
        try {
            sequence = ++this.storageDataSequence;
            const params = { data: sensorData, _storage_seq: sequence,
                             _storage_file_token: this.storageFileToken };
            // Both transports use the same ordering, identity and close barrier.
            const sendOperation = this.storagePushSendChain.then(async () => {
                if (this.storageDataSendError) throw this.storageDataSendError;
                if (this.storage_push_connected && !this.storagePushFallbackActive) {
                    try {
                        await this.storage_push_socket.send(JSON.stringify({ cmd: 'append', params }));
                    } catch (pushError) {
                        let fallback;
                        try { fallback = await this.sendStorageCommand('append', params); }
                        catch (fallbackError) {
                            throw new Error(`PUSH失败(${pushError.message || pushError})，REP回退失败(${fallbackError.message || fallbackError})`);
                        }
                        if (fallback.status !== 'success') throw new Error(`PUSH失败(${pushError.message || pushError})，REP回退失败(${fallback.msg || fallback.status})`);
                        this.storagePushFallbackActive = true;
                        console.warn(`[realtimeEngine] Storage PUSH发送失败，序号${sequence}已由REP幂等补写；本轮后续改用REP (${pushError.message || pushError})`);
                    }
                } else {
                    const response = await this.sendStorageCommand('append', params);
                    if (response.status !== 'success') throw new Error(response.msg || 'Storage append failed');
                }
                this.storageDataLastSentSequence = sequence;
            });
            this.storagePushSendChain = sendOperation.catch(() => {});
            await sendOperation;
            for (const side of ['dev1', 'dev2']) {
                if (healthRows[side] > 0 && healthAtSend?.sides[side]) {
                    healthAtSend.sides[side].sent_to_storage_rows += healthRows[side];
                }
            }
        } catch (error) {
            this.storageDataSendError = error;
            const errorMessage = error.message || String(error);
            const failureNow = this._collectionHealthNow();
            if (healthAtSend && (healthAtSend.lastStorageFailureSnapshotAt == null || failureNow - healthAtSend.lastStorageFailureSnapshotAt >= 10000)) {
                healthAtSend.lastStorageFailureSnapshotAt = failureNow;
                const failureContext = this._collectionHealthSnapshot(healthAtSend);
                console.log(`[采集健康] ${JSON.stringify({ event: 'storage_send_failed', ...failureContext, sequence, rows: healthRows, error: errorMessage })}`);
            }
            console.error(`[realtimeEngine] ❌ PUSH数据发送失败 seq=${sequence}: ${errorMessage}`);
            this.notifyH5StorageWarning(`H5数据写入失败：${error.message || error}；当前文件不会标记为完成`);
            this.requestCollectionFault({ source: 'storage', code: this._storageFaultCode(errorMessage), message: `H5数据写入失败：${errorMessage}` });
        } finally {
            this.storagePushPendingCount = Math.max(0, this.storagePushPendingCount - 1);
            for (const side of ['dev1', 'dev2']) {
                if (healthRows[side] > 0 && healthAtSend?.sides[side]) healthAtSend.sides[side].pending = Math.max(0, healthAtSend.sides[side].pending - 1);
            }
        }
    }

    async flushStorageData() {
        if (this.storagePushSendChain) await this.storagePushSendChain;
        if (this.storageDataSendError) {
            throw new Error(`Storage数据发送失败: ${this.storageDataSendError.message || this.storageDataSendError}`);
        }
    }

    async attributeEMGData(emgData) {
        if (!this.isRunning) return;
        try {
            if (!Array.isArray(emgData.big_bag_raw_data) || emgData.big_bag_raw_data.length !== 5) return;

            this.emg_packet_count += 5;
            this.emg_5_packets_count++;

            this.broadcastToClients({
                type: 'realtime_data',
                data: { emg: emgData.big_bag_raw_data, imu: null, timestamp: Date.now(), packetCount: this.emg_packet_count, framesInPacket: 5 }
            });
        } catch (error) {}
    }

    getStatus() {
        const WebSocket = require('ws');
        const bleConnected = this.ble_client && this.ble_client.readyState === WebSocket.OPEN;

        // 【新增】获取已连接客户端列表
        const connectedClients = [];
        this.clients.forEach(client => {
            connectedClients.push({
                id: client.clientId,
                name: client.clientName,
                connectedAt: client.connectedAt
            });
        });

        return {
            collectionState: this.collectionState, previewDroppedPackets: this.previewDroppedPackets,
            collectionFault: this.collectionFault ? {
                fault_id: this.collectionFault.fault_id, phase: this.collectionFault.phase,
                source: this.collectionFault.source, code: this.collectionFault.code,
                message: this.collectionFault.message, file_path: this.collectionFault.file_path,
                file_token: this.collectionFault.file_token, save_result: this.collectionFault.save_result
            } : null,
            storageFileToken: this.storageFileToken, storageError: this.storageDataSendError?.message || null,
            isRunning: this.isRunning, isCollecting: this.isCollecting, collectionPaused: this.collectionPaused,
            currentTaskId: this.currentTaskId, currentStageName: this.currentStageName, stageFileOpen: this.stageFileOpen,
            clientCount: this.clients.size, packetCount: this.emg_packet_count, mocapPacketCount: this.mocap_packet_count,
            storageConnected: this.storage_connected, mocapConnected: this.mocap_connected,
            bleConnected: bleConnected,
            pendingStorageRequests: this.storageRequestQueue.length,
            connectedClients: connectedClients  // 【新增】客户端列表
        };
    }

    stop() {
        return this._stopInternal();
    }

    async _stopInternal() {
        this.stopping = true;
        let saveError = null;
        const cleanupErrors = [];
        const closeSocket = async (socket, label) => {
            if (!socket) return;
            try { socket.close(1000); }
            catch (error) { cleanupErrors.push(new Error(`${label}: ${error.message}`)); }
        };
        try {
            for (const name of ['connectTimeoutTimer', 'mocapConnectTimeoutTimer',
                'cameraConnectTimeoutTimer', 'reconnectTimer', 'mocap_reconnectTimer', 'camera_reconnectTimer',
                'realtimeDataTimer', 'collectionHealthTimer']) {
                clearTimeout(this[name]); this[name] = null;
            }
            this.isRunning = false;
            this.isCollecting = false;
            this.collectionPaused = true;

            try {
                await this.collectionCommandChain;
                if (this.stageFileOpen || this.stageFileOpening || this.stageFileOpenPromise || this.isClosingStageFile || this.stageFileCreateFailed || this.videoRecordingStarted) {
                    const result = await this.onCollectionStop(false);
                    if (result.status !== 'success') throw new Error(result.msg || '采集收尾失败');
                }
            } catch (error) {
                saveError = error;
                // A failed normal stop must still preserve the open H5 as incomplete.
                // This path also retries a terminal camera save failure using its cached result.
                if (this.stageFileOpen || this.stageFileOpening || this.stageFileOpenPromise || this.isClosingStageFile || this.stageFileCreateFailed || this.videoRecordingStarted) {
                    try {
                        const result = await this.finalizeIncomplete({ reason: error.message || String(error) });
                        if (result.status !== 'success') {
                            console.error('[realtimeEngine] 不完整收尾失败:', result.msg || '未知错误');
                        }
                    } catch (incompleteError) {
                        console.error('[realtimeEngine] 不完整收尾异常:', incompleteError);
                    }
                }
            }
        } catch (error) {
            saveError = saveError || error;
        } finally {
            this.isRunning = false;
            this.isCollecting = false;
            this.collectionPaused = true;
            for (const name of ['connectTimeoutTimer', 'mocapConnectTimeoutTimer',
                'cameraConnectTimeoutTimer', 'reconnectTimer', 'mocap_reconnectTimer', 'camera_reconnectTimer',
                'realtimeDataTimer', 'collectionHealthTimer']) {
                clearTimeout(this[name]); this[name] = null;
            }

            for (const client of this.clients || []) {
                try { if (client.readyState === WebSocket.OPEN) client.close(1001, '服务器关闭'); }
                catch (error) { cleanupErrors.push(new Error(`WebSocket客户端关闭失败: ${error.message}`)); }
            }
            this.clients?.clear();

            if (this.websocket_server) {
                try {
                    await new Promise((resolve, reject) => {
                        const closeTimeout = setTimeout(resolve, 3000);
                        try {
                            this.websocket_server.close(error => {
                                clearTimeout(closeTimeout);
                                if (error) reject(error); else resolve();
                            });
                        } catch (error) { clearTimeout(closeTimeout); reject(error); }
                    });
                } catch (error) { cleanupErrors.push(new Error(`WebSocket服务关闭失败: ${error.message}`)); }
                this.websocket_server = null;
            }

            await closeSocket(this.ble_client, 'BLE连接关闭失败'); this.ble_client = null;
            await closeSocket(this.mocap_client, '动捕连接关闭失败'); this.mocap_client = null;
            await closeSocket(this.camera_client, '相机连接关闭失败'); this.camera_client = null;
            this.camera_connected = this.mocap_connected = false;
            this.storage_connected = this.storage_push_connected = false;
            for (const [socketName, label] of [['storage_push_socket', 'Storage PUSH socket关闭失败'],
                ['storage_server_socket', 'Storage REQ socket关闭失败']]) {
                try { this[socketName]?.close(); }
                catch (error) { cleanupErrors.push(new Error(`${label}: ${error.message}`)); }
                this[socketName] = null;
            }
        }
        if (saveError) {
            if (cleanupErrors.length) console.error('[realtimeEngine] 收尾清理也发生错误:', cleanupErrors);
            throw saveError;
        }
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '实时引擎资源清理失败');
        return { status: 'success' };
    }
}

const realtimeEngine = new RealtimeEngine();
module.exports = realtimeEngine;
