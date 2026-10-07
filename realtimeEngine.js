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
        this.storageFileToken = null;
        this.collectionCommandChain = Promise.resolve();
        this.collectionState = 'idle';
        this.previewDroppedPackets = 0;
        this.previewByteLimit = 1024 * 1024;
        this.storagePushPendingCount = 0;

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
        const execute = async () => {
            const { action, data = {}, commandId } = message;
            try {
                let result;
                switch (action) {
                    case 'task_change': result = this.onTaskChange(data.taskId); break;
                    case 'collection_start': result = await this.onCollectionStart(data); break;
                    case 'collection_pause': result = this.onCollectionPause(); break;
                    case 'collection_resume': result = this.onCollectionResume(); break;
                    case 'collection_stop':
                    case 'collection_stop_and_wait': result = await this.onCollectionStop(data.completed); break;
                    case 'finalize_incomplete': result = await this.finalizeIncomplete(data); break;
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
            this.videoRecordingStarted = !!(this.videoFileNames?.left || this.videoFileNames?.right);
        }
    }

    onCollectionPause() { this.collectionPaused = true; }
    onCollectionResume() { this.collectionPaused = false; }

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
    }

    async _finishCollection(params, incomplete = false) {
        this.isCollecting = false;
        this.collectionPaused = true;
        this.collectionState = 'stopping';
        try {
            if (!incomplete && this.storageDataSendError) throw this.storageDataSendError;
            // Unknown camera outcomes (disconnect/timeout) keep ownership.
            // A terminal negative save reply may be preserved as incomplete.
            await this._saveCollectionVideos(incomplete);
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
            return { status: 'error', msg: error.message, h5_close: { status: 'error', msg: error.message } };
        }
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
        this.currentStageName = stageName;
        // 【统一时钟】优先使用 Python 时钟（来自 onCollectionStart 查询 camera_server），
        // 确保 H5 中 start_time 属性与 EMG/视频数据时间戳同源
        this.stage_start_time = this.collectionDataStartTs || timestamp || Date.now();
        // 【新增】保存当前stage是否需要动捕数据
        this.currentStageNeedMocap = needMocap;
        console.log(`[realtimeEngine] Stage开始: ${stageName}, needMocap: ${needMocap}`);
        if (this.abortFreezeActive) throw new Error('采集已冻结');
        await this.openStageFile(stageName, stageIndex);
        if (this.stageFileCreateFailed) throw new Error('H5文件创建失败');
        if (this.abortFreezeActive) throw new Error('采集已冻结，等待异常收尾');
        this.collectionState = 'collecting';
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
                console.log(`[realtimeEngine] ✅ 文件已打开: ${filename}`);
            } else {
                console.error(`[realtimeEngine] ❌ 打开文件失败:`, response);
                this.stageFileOpen = false;
                this.stageFileOpening = false;
                this.stageFileCreateFailed = true;
                this.notifyH5StorageWarning(`H5创建失败：${response.msg || response.error || response.status || '未知错误'}；请紧急中断并重采本轮`);
            }
        } catch (error) {
            console.error('[realtimeEngine] 打开Stage文件失败:', error);
            this.stageFileOpen = false;
            this.stageFileOpening = false;
            this.stageFileCreateFailed = true;
            this.notifyH5StorageWarning(`H5创建异常：${error.message || error}；请紧急中断并重采本轮`);
        }
    }

    notifyH5StorageWarning(message, force = false) {
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
            } else {
                console.error('[realtimeEngine] ❌ Storage拒绝关闭文件:', response);
            }
            return response;
        })().catch(error => {
            console.error('[realtimeEngine] 关闭Stage文件失败:', error);
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
        const error = new Error(`${packet.source || 'device'} 数据传输失败: ${packet.error || '数据丢失'} (dropped=${packet.dropped || 0})`);
        if (this.isCollecting || this.stageFileOpening || this.stageFileOpen) {
            this.storageDataSendError = this.storageDataSendError || error;
            this.onAbnormalInterruptFreeze({});
            this.collectionState = 'save_failed';
            this.broadcastToClients({ type: 'collection_fault', error: error.message, source: packet.source });
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
                    if (packet.type === 'transport_fault') { this.onTransportFault(packet); return; }
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
                    console.log('[realtimeEngine] Camera服务器响应:', response);
                    // 这里可以处理响应，例如录制状态更新
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
    async sendCameraCommand(command, data = {}) {
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
            const timeout = setTimeout(() => fail(new Error('Camera命令超时；保存结果待核对')),
                command === 'stop_and_save' ? 1860000 : 15000);
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

                // Send raw data to storage_server for this sub-packet pair
                if (this.isCollecting && !this.collectionPaused && this.stageFileOpen && !this.isClosingStageFile && isFreshCollectionPacket) {
                    this.saveDataToStorage({
                        emg1: emg1RawData, emg2: emg2RawData, emg1_t: emg1Timestamps, emg2_t: emg2Timestamps,
                        emg1_frame_ids: emg1FrameIds, emg2_frame_ids: emg2FrameIds,
                        imu1a: imu1aData, imu1b: imu1bData, imu1_t: imu1Timestamps,
                        imu2a: imu2aData, imu2b: imu2bData, imu2_t: imu2Timestamps,
                        imu1_all: imu1All, imu2_all: imu2All,
                        imu1_hw_version: imu1HwVersion, imu2_hw_version: imu2HwVersion,
                        imu1_num_imus: imu1NumImus, imu2_num_imus: imu2NumImus,
                    });
                } else if (this.isCollecting && !this.collectionPaused && !this.isTestMode && !this.stageFileOpen && !this.stageFileOpening && !this.isClosingStageFile && h5OpenGraceExpired) {
                    this.notifyH5StorageWarning('已收到手环数据，但H5文件未打开，当前轮次数据不会落盘；请紧急中断并重采本轮');
                } else if (this.isCollecting && this.stageFileOpen && !isFreshCollectionPacket) {
                    this.collectionDroppedStaleBlePackets++;
                    if (this.collectionDroppedStaleBlePackets <= 3) {
                        console.log(`[realtimeEngine] drop stale BLE packet before collection_start: packet_ts=${storagePacketTs}, start_ts=${this.collectionDataStartTs}`);
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
        // 【新增】preview stream 数据不写入 H5（仅 collection stream 写入）
        if (this.streamMode !== 'collection') {
            return;
        }
        if (this.isClosingStageFile || !this.stageFileOpen) return;
        if (this.storageDataSendError) return;
        if (this.storagePushPendingCount >= 1000) {
            this.storageDataSendError = new Error('Storage数据发送队列已满');
            this.notifyH5StorageWarning(this.storageDataSendError.message);
            return;
        }
        this.storagePushPendingCount++;
        try {
            const sequence = ++this.storageDataSequence;
            const params = { data: sensorData, _storage_seq: sequence,
                             _storage_file_token: this.storageFileToken };
            // Both transports use the same ordering, identity and close barrier.
            const sendOperation = this.storagePushSendChain.then(async () => {
                if (this.storageDataSendError) throw this.storageDataSendError;
                if (this.storage_push_connected) {
                    await this.storage_push_socket.send(JSON.stringify({ cmd: 'append', params }));
                } else {
                    const response = await this.sendStorageCommand('append', params);
                    if (response.status !== 'success') throw new Error(response.msg || 'Storage append failed');
                }
                this.storageDataLastSentSequence = sequence;
            });
            this.storagePushSendChain = sendOperation.catch(() => {});
            await sendOperation;
        } catch (error) {
            this.storageDataSendError = error;
            console.error('[realtimeEngine] ❌ PUSH数据发送失败:', error.message || error);
            this.notifyH5StorageWarning(`H5数据写入失败：${error.message || error}；当前文件不会标记为完成`);
        } finally {
            this.storagePushPendingCount = Math.max(0, this.storagePushPendingCount - 1);
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
            for (const name of ['connectTimeoutTimer', 'mocapConnectTimeoutTimer',
                'cameraConnectTimeoutTimer', 'reconnectTimer', 'mocap_reconnectTimer', 'camera_reconnectTimer']) {
                clearTimeout(this[name]); this[name] = null;
            }
            this.isRunning = false;
            this.isCollecting = false;
            this.collectionPaused = true;

            await this.collectionCommandChain;
            if (this.stageFileOpen || this.stageFileOpening || this.stageFileOpenPromise || this.isClosingStageFile || this.stageFileCreateFailed || this.videoRecordingStarted) {
                const result = await this.onCollectionStop(false);
                if (result.status !== 'success') throw new Error(result.msg || '采集收尾失败');
            }

            this.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) client.close(1001, '服务器关闭');
            });
            this.clients.clear();

            if (this.websocket_server) await new Promise(resolve => {
                const closeTimeout = setTimeout(resolve, 3000);
                this.websocket_server.close(() => { clearTimeout(closeTimeout); resolve(); });
            });

            if (this.ble_client) { this.ble_client.close(1000); this.ble_client = null; }
            if (this.mocap_client) { this.mocap_client.close(1000); this.mocap_client = null; }
            if (this.camera_client) { this.camera_client.close(1000); this.camera_client = null; }
            this.camera_connected = this.mocap_connected = false;
            this.storage_connected = this.storage_push_connected = false;

            // 【新增】关闭 ZMQ sockets
            try {
                if (this.storage_push_socket) { this.storage_push_socket.close(); }
                if (this.storage_server_socket) { this.storage_server_socket.close(); }
            } catch (e) {}

            clearTimeout(this.reconnectTimer);
            clearTimeout(this.mocap_reconnectTimer);
            return { status: 'success' };
    }
}

const realtimeEngine = new RealtimeEngine();
module.exports = realtimeEngine;
