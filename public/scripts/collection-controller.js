/**
 * collection-controller.js - 采集任务控制器（v3 - 修复版v3）
 * 
 * 修复内容：
 * 1. 切换Stage时重置动画模块的试次计数
 * 2. 将执行参数直接传递给动画模块的start函数
 * 3. 左侧列表正确显示试次进度
 */

console.log('[Collection] ====== 脚本开始加载 (v3-fixed-v3) ======');

(function() {
    'use strict';

    class CollectionController {
        constructor() {
            console.log('[Collection] 构造函数开始');
            
            this.collectionConfig = null;
            this.currentTaskId = 'discrete_gesture';
            
            // Session相关状态
            this.sessionCount = 3;           // session总数
            this.currentSessionIndex = 0;    // 当前session索引
            
            this.stages = [];
            this.currentStageIndex = 0;
            this.allGestures = [];   // 【新增】全局手势库
            this.gestures = [];      // 当前Stage使用的手势库
            this.currentGestureIndex = 0;
            this.gestureRepeatCount = 0;
            
            this.executionParams = {
                discrete_gesture: {
                    repeatPerGesture: 5,
                    intervalBetweenRepeat: 1.0,
                    restBetweenGestures: 30.0,
                    preparationTime: 3.0,
                    gestureDisplayTime: 2.0
                },
                continual_gesture_1: {
                    trialsPerStage: 10,
                    stageTimeout: 120,
                    dwellTime: 0.5,
                    preparationTime: 3.0,
                    targetSize: 0.12
                },
                continual_gesture_2: {
                    trialsPerStage: 10,
                    stageTimeout: 120,
                    dwellTime: 0.5,
                    preparationTime: 3.0,
                    targetSize: 0.12
                }
            };
            
            this.currentExecutionParams = this.executionParams.discrete_gesture;
            this._isRunning = false;
            this._isPaused = false;
            this.currentPhase = null;
            this.continualTrialCount = 0;
            this.continualProgressTimer = null;
            this.phaseTimer = null;
            this.countdownTimer = null;

            // ===== 标定相关状态 =====
            this.calibrationEnabled = true;     // 是否启用标定流程
            this.isCalibrating = false;         // 是否正在标定
            this.calibrationPhase = null;       // 'demo' | 'min' | 'max' | null
            this.calibrationTimer = null;       // 标定计时器
            this.skipCalibration = false;       // 是否跳过标定

            // ===== 全部轮次采集相关状态 =====
            this._isAllSessionsMode = false;    // 是否为全部轮次采集模式
            this._restBetweenSessions = 30;     // 轮次间休息时间（秒）
            this._restCountdownTimer = null;    // 休息倒计时定时器

            // ===== 精确对齐同步状态 =====
            this._sessionSyncDone = false;      // 当前session是否已完成同步prompt

            // ===== 录像同步相关状态 =====
            this._recordingSessionId = null;    // 录像会话ID，格式: rec_YYYYMMDD_HHMMSS_N
            this._spaceKeyEnabled = false;      // 是否启用空格键监听
            this._spaceKeyHandler = null;       // 空格键事件处理函数引用
            this._cameraRecordingStarted = false; // 摄像头录制是否已启动
            this._currentVideoStartTimestamp = null; // 当前视频录制启动的时间戳
            this._currentH5FileName = null;      // 当前H5文件名（用于关联视频文件）

            // ===== 乱序模式相关状态 =====
            this._shuffleMode = false;          // 当前Stage是否为乱序模式

            // ===== 断点续采相关状态（Phase 2） =====
            this._isResumeMode = false;         // 是否为续采模式
            this._resumeState = null;           // 断点状态快照
            this._resumeSegmentIndex = 1;       // 当前 segment 序号

            // ===== Stream 切换相关状态 =====
            this._switchInProgress = false;     // preview ↔ collection 切换进行中（防止重复点击）
            this._lastPreviewResumeCall = null; // 防重入：{ reason, time }

            // ===== 全部轮次切流优化 =====
            // 短休息（<此阈值）不切 preview，保持 idle 减少不必要的 bin 切流
            this.MIN_REST_FOR_PREVIEW_STREAM_SECONDS = 10;

            console.log('[Collection] 构造函数结束');
        }

        init() {
            console.log('[Collection] init() 开始');
            try {
                this.bindEvents();
                this._bindDeviceStatusListener();
                this.loadCollectionConfig();
                this.updateUI();
                // 【新增】初始化空格键监听器
                this._initSpaceKeyListener();
                console.log('[Collection] init() 完成 ✓');
            } catch (error) {
                console.error('[Collection] init() 错误:', error);
            }
        }

        /**
         * 【新增】监听手环设备连接/断开，实时更新按钮状态
         */
        _bindDeviceStatusListener() {
            if (!window.BleControl) return;

            // BLE 设备状态变化（connect/disconnect/status 推送）
            window.BleControl.onDeviceChange = (deviceId, state) => {
                if (!this._isRunning) {
                    this.updateControlButtons(false);
                    this.resetDisplay();
                }
            };
        }

        bindEvents() {
            console.log('[Collection] bindEvents() 开始');
            
            // Session选择事件
            const sessionSelect = document.getElementById('sessionSwitchSelect');
            if (sessionSelect) {
                sessionSelect.addEventListener('change', (e) => {
                    if (!this._isRunning) {
                        this.switchSession(parseInt(e.target.value));
                    } else {
                        e.target.value = this.currentSessionIndex;
                        this.showToast('采集进行中，无法切换轮次', 'warning');
                    }
                });
            }
            
            const stageSelect = document.getElementById('stageSwitchSelect');
            if (stageSelect) {
                stageSelect.addEventListener('change', (e) => {
                    if (!this._isRunning) {
                        this.switchStage(parseInt(e.target.value));
                    } else {
                        e.target.value = this.currentStageIndex;
                        this.showToast('采集进行中，无法切换Stage', 'warning');
                    }
                });
            }

            const startBtn = document.getElementById('startTaskBtn');
            if (startBtn) {
                startBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    console.log('[Collection] ★★★ 开始按钮被点击 ★★★');
                    this.startTask(false);  // 正常采集模式
                });
            }

            // 【修改】测试模式按钮（替换暂停按钮）
            const testBtn = document.getElementById('testModeBtn');
            if (testBtn) {
                testBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    console.log('[Collection] ★★★ 测试模式按钮被点击 ★★★');
                    this.startTask(true);  // 测试模式，不保存H5文件
                });
            }

            // 【新增】全部轮次采集按钮
            const startAllBtn = document.getElementById('startAllSessionsBtn');
            if (startAllBtn) {
                startAllBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    console.log('[Collection] ★★★ 全部轮次采集按钮被点击 ★★★');
                    this.startAllSessions();
                });
            }

            const stopBtn = document.getElementById('stopTaskBtn');
            if (stopBtn) {
                stopBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.stopTask();
                });
            }

            // 【新增】异常中断按钮
            const abortBtn = document.getElementById('abortTaskBtn');
            if (abortBtn) {
                abortBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.abortTask();
                });
            }

            const nextStageBtn = document.getElementById('nextStageBtn');
            if (nextStageBtn) {
                nextStageBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.goToNextStage();
                });
            }

            // 【新增】初始化空格键监听器（但不立即启用）
            this._initSpaceKeyListener();

            console.log('[Collection] bindEvents() 完成 ✓');
        }

        // ==================== 配置加载 ====================

        _normalizeTaskId(taskId) {
            const taskIdMap = {
                'discrete': 'discrete_gesture',
                'continuous1': 'continual_gesture_1',
                'continuous2': 'continual_gesture_2',
                'continuous3': 'continual_gesture_3',
                '离散手势采集': 'discrete_gesture',
                '离散手势': 'discrete_gesture',
                '连续手势采集1': 'continual_gesture_1',
                '连续手势1': 'continual_gesture_1',
                '连续手势采集2': 'continual_gesture_2',
                '连续手势2': 'continual_gesture_2',
                '连续手势采集3': 'continual_gesture_3',
                '连续手势3': 'continual_gesture_3'
            };
            return taskIdMap[taskId] || taskId || 'discrete_gesture';
        }

        _getTaskDisplayName(taskId) {
            const normalizedTaskId = this._normalizeTaskId(taskId);
            const taskNames = {
                'discrete_gesture': '离散手势采集',
                'continual_gesture_1': '连续手势采集1',
                'continual_gesture_2': '连续手势采集2',
                'continual_gesture_3': '连续手势采集3'
            };
            return taskNames[normalizedTaskId] || normalizedTaskId;
        }

        _syncCollectionConfigTask(taskId) {
            const normalizedTaskId = this._normalizeTaskId(taskId);
            this.currentTaskId = normalizedTaskId;

            if (this.collectionConfig) {
                this.collectionConfig.task_id = normalizedTaskId;
                this.collectionConfig.task = this._getTaskDisplayName(normalizedTaskId);
                if (window.currentCollectionConfig === this.collectionConfig) {
                    window.currentCollectionConfig.task_id = normalizedTaskId;
                    window.currentCollectionConfig.task = this.collectionConfig.task;
                }
                try {
                    localStorage.setItem('emg_current_collection_config', JSON.stringify(this.collectionConfig));
                } catch (error) {
                    console.warn('[Collection] 同步任务ID到localStorage失败:', error);
                }
            }

            return normalizedTaskId;
        }

        _getDefaultStageMarkerForTask(taskId) {
            const markerMap = {
                'continual_gesture_1': '连续手势1',
                'continual_gesture_2': '连续手势2',
                'continual_gesture_3': '连续手势3'
            };
            return markerMap[this._normalizeTaskId(taskId)] || null;
        }

        _applyTaskDefaultStage() {
            const marker = this._getDefaultStageMarkerForTask(this.currentTaskId);
            if (!marker || !Array.isArray(this.stages) || this.stages.length === 0) return false;

            const matchedIndex = this.stages.findIndex(stage => {
                const stageText = `${stage?.id || ''} ${stage?.name || ''}`;
                return stageText.includes(marker);
            });

            if (matchedIndex < 0 || matchedIndex === this.currentStageIndex) return false;

            console.log('[Collection] 连续手势任务自动选择Stage:', {
                taskId: this.currentTaskId,
                marker,
                stageIndex: matchedIndex,
                stageName: this.stages[matchedIndex]?.name || this.stages[matchedIndex]?.id
            });
            this.currentStageIndex = matchedIndex;
            this.currentGestureIndex = 0;
            this.gestureRepeatCount = 0;
            this.continualTrialCount = 0;
            return true;
        }

        loadCollectionConfig(options = {}) {
            console.log('[Collection] ========== loadCollectionConfig 开始 ==========');

            this.collectionConfig = window.currentCollectionConfig ||
                JSON.parse(localStorage.getItem('emg_current_collection_config') || 'null');

            console.log('[Collection] collectionConfig:', this.collectionConfig);

            if (this.collectionConfig) {
                console.log('[Collection] 加载采集配置:', this.collectionConfig);

                const configTaskId = this.collectionConfig.task_id || this.collectionConfig.task || 'discrete_gesture';
                const effectiveTaskId = options.preferredTaskId || configTaskId;
                this._syncCollectionConfigTask(effectiveTaskId);
                console.log('[Collection] currentTaskId:', this.currentTaskId);

                // 【关键】强制从localStorage读取最新模板
                const template = this.getLatestTemplate();
                console.log('[Collection] template:', template);
                console.log('[Collection] template.category3长度:', template?.category3?.length);

                if (this.collectionConfig.category3List && this.collectionConfig.category3List.length > 0) {
                    this.stages = this.collectionConfig.category3List;
                    console.log('[Collection] ✅ 从collectionConfig.category3List加载stages，数量:', this.stages.length);
                } else {
                    this.stages = (template.category3 || []).filter(s => s.enabled);
                    console.log('[Collection] ✅ 从template.category3加载stages，数量:', this.stages.length);
                }

                console.log('[Collection] 最终stages:', this.stages);
                console.log('[Collection] stages详情:', JSON.stringify(this.stages, null, 2));
                this._applyTaskDefaultStage();

                // 加载Session数量（优先从collectionConfig，其次从template）
                if (this.collectionConfig.sessionConfig?.count) {
                    this.sessionCount = this.collectionConfig.sessionConfig.count;
                } else {
                    this.sessionCount = template.sessionConfig?.count || 3;
                }
                console.log('[Collection] Session数量:', this.sessionCount);

                // 【新增】加载轮次间休息时间
                if (this.collectionConfig.sessionConfig?.restBetweenSessions) {
                    this._restBetweenSessions = this.collectionConfig.sessionConfig.restBetweenSessions;
                } else {
                    this._restBetweenSessions = template.sessionConfig?.restBetweenSessions || 30;
                }
                console.log('[Collection] 轮次间休息时间:', this._restBetweenSessions, '秒');

                // 【修改】先加载全局手势库作为后备
                if (this.collectionConfig.gestures?.discrete) {
                    this.allGestures = this.collectionConfig.gestures.discrete.filter(g => g.enabled);
                } else {
                    this.allGestures = (template.gestures?.discrete || []).filter(g => g.enabled);
                }
                console.log('[Collection] 全局手势库数量:', this.allGestures.length);

                // 【新增】根据当前Stage加载对应手势库
                this.loadGesturesForCurrentStage();

                // 【关键修复】优先从collectionConfig.execution读取执行参数
                // 这确保了从选择器保存的配置能正确传递
                const executionSource = this.collectionConfig.execution || template.execution;
                if (executionSource) {
                    if (executionSource[this.currentTaskId]) {
                        this.executionParams = { ...executionSource };
                        this.currentExecutionParams = { ...executionSource[this.currentTaskId] };
                        console.log('[Collection] ★★★ 加载执行参数 ★★★');
                        console.log('[Collection] 参数来源:', this.collectionConfig.execution ? 'collectionConfig' : 'template');
                        console.log('[Collection] 任务类型:', this.currentTaskId);
                        console.log('[Collection] trialsPerStage:', this.currentExecutionParams.trialsPerStage);
                    } else if (executionSource.repeatPerGesture !== undefined) {
                        console.log('[Collection] 检测到旧版本执行参数格式');
                        this.executionParams.discrete_gesture = { ...executionSource };
                        this.currentExecutionParams = this.executionParams[this.currentTaskId] || this.executionParams.discrete_gesture;
                    }
                }

                console.log('[Collection] 当前任务执行参数:', this.currentExecutionParams);
            } else {
                console.warn('[Collection] 未找到采集配置，使用默认值');
                this.loadDefaultConfig();
            }
        }

        /**
         * 【Phase 2 - Bug 1 fix】轻量重载执行参数
         * 仅刷新 executionParams / currentExecutionParams，不重建 gestures 和进度。
         * 用于续采模式下避免 loadCollectionConfig() 覆盖断点恢复的状态。
         */
        _reloadExecutionParams() {
            const template = this.getLatestTemplate();
            const config = this.collectionConfig || {};

            // 优先从 collectionConfig.execution，其次从 template.execution
            const executionSource = config.execution || template.execution;
            if (executionSource) {
                if (executionSource[this.currentTaskId]) {
                    this.executionParams = { ...executionSource };
                    this.currentExecutionParams = { ...executionSource[this.currentTaskId] };
                } else if (executionSource.repeatPerGesture !== undefined) {
                    this.executionParams.discrete_gesture = { ...executionSource };
                    this.currentExecutionParams = this.executionParams[this.currentTaskId] || this.executionParams.discrete_gesture;
                }
            }

            console.log('[Collection] ★ _reloadExecutionParams (续采模式) ★');
            console.log('[Collection]   taskId:', this.currentTaskId);
            console.log('[Collection]   params:', JSON.stringify(Object.keys(this.currentExecutionParams || {})));
        }

        /**
         * 【Phase 2 - Bug fix】按任务类型校验执行参数完整性
         * discrete_gesture: 需要 repeatPerGesture
         * continual_gesture_*: 需要 trialsPerStage
         */
        _hasValidExecutionParamsForTask(taskId) {
            const p = this.currentExecutionParams;
            if (!p) return false;
            if (taskId === 'discrete_gesture') {
                return typeof p.repeatPerGesture === 'number' &&
                       typeof p.gestureDisplayTime === 'number' &&
                       typeof p.preparationTime === 'number';
            }
            // continual_gesture_1 / 2 / 3
            return typeof p.trialsPerStage === 'number' &&
                   typeof p.preparationTime === 'number';
        }

        /**
         * 【Phase 2 - Bug fix】用任务类型对应的默认执行参数兜底
         * 仅在续采模式下 _reloadExecutionParams() 失败时调用。
         * 不调用 loadCollectionConfig()，不重建 gestures。
         */
        _applyExecutionDefaultsForTask(taskId) {
            const defaults = this.getDefaultTemplate().execution;
            if (defaults[taskId]) {
                this.executionParams = { ...defaults };
                this.currentExecutionParams = { ...defaults[taskId] };
            } else {
                // ultimate fallback
                this.currentExecutionParams = {
                    repeatPerGesture: 5,
                    intervalBetweenRepeat: 1.0,
                    restBetweenGestures: 30.0,
                    preparationTime: 3.0,
                    gestureDisplayTime: 2.0,
                    trialsPerStage: 10,
                    stageTimeout: 120,
                    dwellTime: 0.5,
                    targetSize: 0.12
                };
            }
            console.warn('[Collection] 已应用默认执行参数兜底:', this.currentExecutionParams);
        }

        /**
         * 【修复】强制从localStorage读取最新的模板配置
         */
        getLatestTemplate() {
            const saved = localStorage.getItem('emg_collection_template');
            if (saved) {
                try {
                    const template = JSON.parse(saved);
                    console.log('[Collection] 从localStorage读取最新模板');
                    console.log('[Collection] execution:', template.execution);
                    return template;
                } catch (e) {
                    console.warn('[Collection] 解析localStorage模板失败:', e);
                }
            }
            
            if (window.templateConfigManager?.currentTemplate) {
                return window.templateConfigManager.currentTemplate;
            }
            
            return this.getDefaultTemplate();
        }

        getTemplate() {
            return this.getLatestTemplate();
        }

        getDefaultTemplate() {
            return {
                category3: [
                    { id: 'palm_up', name: '手心朝上', enabled: true },
                    { id: 'palm_inward', name: '手心朝内', enabled: true },
                    { id: 'hand_on_knee', name: '手放膝盖', enabled: true },
                    { id: 'hand_on_desk', name: '手放桌上', enabled: true }
                ],
                gestures: {
                    discrete: [
                        { id: 'pinch', name: '捏合', icon: '🤏', enabled: true },
                        { id: 'spread', name: '张开', icon: '🖐️', enabled: true },
                        { id: 'fist', name: '握拳', icon: '✊', enabled: true },
                        { id: 'release', name: '松开', icon: '✋', enabled: true }
                    ]
                },
                execution: {
                    discrete_gesture: {
                        repeatPerGesture: 5,
                        intervalBetweenRepeat: 1.0,
                        restBetweenGestures: 30.0,
                        preparationTime: 3.0,
                        gestureDisplayTime: 2.0
                    },
                    continual_gesture_1: {
                        trialsPerStage: 10,
                        stageTimeout: 120,
                        dwellTime: 0.5,
                        preparationTime: 3.0,
                        targetSize: 0.12
                    },
                    continual_gesture_2: {
                        trialsPerStage: 10,
                        stageTimeout: 120,
                        dwellTime: 0.5,
                        preparationTime: 3.0,
                        targetSize: 0.12
                    }
                }
            };
        }

        loadDefaultConfig() {
            const template = this.getDefaultTemplate();
            this.stages = template.category3;
            this.allGestures = template.gestures.discrete;  // 【新增】保存全局手势库
            this.gestures = [...this.allGestures];          // 【修改】初始使用全局手势库
            this.executionParams = template.execution;
            this.currentExecutionParams = this.executionParams[this.currentTaskId] || this.executionParams.discrete_gesture;
            // 加载默认Session数量
            this.sessionCount = 3;
        }

        // ==================== 页面显示 ====================

        onPageShow() {
            console.log('[Collection] 页面显示');
            // 【修复】重新进入采集页时清空采集进度，避免残留旧进度
            this.currentSessionIndex = 0;
            this.currentStageIndex = 0;
            this._applyTaskDefaultStage();
            this.currentGestureIndex = 0;
            this.gestureRepeatCount = 0;
            this.continualTrialCount = 0;
            this.loadCollectionConfig();
            // 【修复】重置动画模块状态
            this.resetAnimationModules();
            this.updateUI();
        }

        /**
         * 【新增】重置所有动画模块的状态
         */
        resetAnimationModules() {
            // 重置离散手势动画模块
            if (window.discreteGestureAnimation) {
                window.discreteGestureAnimation.reset?.();
            }
            // 重置连续手势动画模块
            if (window.continualGesture1Animation) {
                window.continualGesture1Animation.reset?.();
            }
            if (window.continualGesture2Animation) {
                window.continualGesture2Animation.reset?.();
            }
            if (window.continualGesture3Animation) {
                window.continualGesture3Animation.reset?.();
            }
            this.continualTrialCount = 0;
        }

        updateUI() {
            this.updateTaskHeader();
            this.updateSessionSelect();
            this.updateStageSelect();
            this.updateGestureList();
            this.updateControlButtons(false);
            this.updateNextStageButton();
            this.resetDisplay();
        }

        updateTaskHeader() {
            const taskNameEl = document.getElementById('currentTaskName');
            const configBadgeEl = document.getElementById('taskConfigBadge');
            
            const taskConfig = this.getTaskConfig();
            if (taskNameEl) {
                taskNameEl.textContent = taskConfig.name || this.currentTaskId;
            }
            
            if (configBadgeEl && this.collectionConfig) {
                const cat1Name = this.getCategoryName('category1', this.collectionConfig.category1);
                const cat2Name = this.getCategoryName('category2', this.collectionConfig.category2);
                const cat4Name = this.getCategoryName('category4', this.collectionConfig.category4);
                
                configBadgeEl.innerHTML = `
                    <span class="badge badge-primary">${cat1Name}</span>
                    <span class="badge badge-info">${cat2Name}</span>
                    <span class="badge badge-secondary">${cat4Name}</span>
                `;
                configBadgeEl.style.display = 'flex';
            }
        }

        getCategoryName(category, id) {
            const template = this.getTemplate();
            const item = template[category]?.find(c => c.id === id);
            return item?.name || id || '未知';
        }

        /**
         * 更新Session选择器
         */
        updateSessionSelect() {
            const select = document.getElementById('sessionSwitchSelect');
            if (!select) return;

            select.innerHTML = '';
            for (let i = 0; i < this.sessionCount; i++) {
                const option = document.createElement('option');
                option.value = i;
                option.textContent = `第 ${i + 1} 轮`;
                if (i === this.currentSessionIndex) {
                    option.selected = true;
                }
                select.appendChild(option);
            }

            console.log('[Collection] 轮次选择器已更新, 当前轮次:', this.currentSessionIndex + 1);
        }

        updateStageSelect() {
            const select = document.getElementById('stageSwitchSelect');
            if (!select) return;

            select.innerHTML = '';
            this.stages.forEach((stage, index) => {
                const option = document.createElement('option');
                option.value = index;
                option.textContent = `${index + 1}. ${stage.name}`;
                if (index === this.currentStageIndex) {
                    option.selected = true;
                }
                select.appendChild(option);
            });
        }

        /**
         * 【修复】更新手势/试次列表
         * 【修改】乱序模式下隐藏手势库
         */
        updateGestureList() {
            const gestureList = document.getElementById('gestureList');
            if (!gestureList) {
                console.warn('[Collection] 未找到 #gestureList 元素');
                return;
            }

            // 【新增】乱序模式下隐藏手势库
            if (this._shuffleMode && this._isRunning) {
                gestureList.style.display = 'none';
                return;
            }

            gestureList.style.display = 'block';

            if (this.currentTaskId === 'discrete_gesture') {
                this.renderDiscreteGestureList(gestureList);
            } else {
                this.renderContinualTrialProgress(gestureList);
            }
        }

        renderDiscreteGestureList(gestureList) {
            const titleEl = gestureList.querySelector('.gesture-list-title');
            if (titleEl) {
                titleEl.innerHTML = '<i class="fas fa-hand-paper"></i> 手势库';
            }
            
            let html = '';

            html += `
                <div class="gesture-progress-summary" style="font-size: 9px; padding: 1px 4px; margin: 0;">
                    <span>轮次: ${this.currentSessionIndex + 1}/${this.sessionCount}</span>
                    <span>Stage: ${this.currentStageIndex + 1}/${this.stages.length}</span>
                    <span>手势: ${this.currentGestureIndex}/${this.gestures.length}</span>
                </div>
            `;
            
            this.gestures.forEach((gesture, index) => {
                let status = 'pending';
                let progressText = '';

                const isActivelyCollecting = this._isRunning && this.currentPhase === 'gesture';

                // 【修复】乱序模式下每个手势实例只执行1次
                const repeatCount = this._shuffleMode ? 1 : this.currentExecutionParams.repeatPerGesture;

                if (index < this.currentGestureIndex) {
                    status = 'completed';
                    progressText = `<span class="gesture-progress" style="font-size: 9px;">✓ 完成</span>`;
                } else if (index === this.currentGestureIndex && isActivelyCollecting) {
                    status = 'current';
                    progressText = `<span class="gesture-progress" style="font-size: 9px;">${this.gestureRepeatCount}/${repeatCount}</span>`;
                } else {
                    status = 'pending';
                    progressText = `<span class="gesture-progress" style="font-size: 9px; color: #999;">${repeatCount}次</span>`;
                }

                const iconClass = status === 'completed' ? 'check-circle' :
                                 status === 'current' ? 'circle-notch fa-spin' : 'circle';

                html += `
                    <div class="gesture-item ${status}" data-index="${index}">
                        <span class="gesture-icon" style="font-size: 10px;">${gesture.icon || '✋'}</span>
                        <span class="gesture-name" style="flex: 1; font-size: 9px;">${gesture.name}</span>
                        ${progressText}
                        <i class="fas fa-${iconClass} status-icon" style="font-size: 8px;"></i>
                    </div>
                `;
            });
            
            this.updateGestureListContent(gestureList, html);
        }

        /**
         * 【修复】渲染连续手势试次进度 - 使用配置中的trialsPerStage
         */
        renderContinualTrialProgress(gestureList) {
            const titleEl = gestureList.querySelector('.gesture-list-title');
            if (titleEl) {
                titleEl.innerHTML = '<i class="fas fa-bullseye"></i> 试次进度';
            }
            
            // 【关键修复】从currentExecutionParams获取trialsPerStage
            const trialsPerStage = this.currentExecutionParams.trialsPerStage || 10;
            
            // 【修复】获取正确的当前进度
            let currentTrial = 0;
            if (this._isRunning) {
                currentTrial = this.getCurrentTrialProgress();
            }
            // 如果没有运行，显示0
            
            let html = '';

            html += `
                <div class="gesture-progress-summary" style="font-size: 9px; padding: 1px 4px; margin: 0; background: #f0f9ff; border-radius: 3px;">
                    <div style="display: flex; justify-content: space-between;">
                        <span><i class="fas fa-sync-alt"></i> 轮次 ${this.currentSessionIndex + 1}/${this.sessionCount}</span>
                        <span><i class="fas fa-layer-group"></i> Stage ${this.currentStageIndex + 1}/${this.stages.length}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between;">
                        <span>试次进度:</span>
                        <span style="font-weight: 600; color: #1e40af;">${currentTrial}/${trialsPerStage}</span>
                    </div>
                </div>
            `;
            
            const percent = trialsPerStage > 0 ? (currentTrial / trialsPerStage * 100) : 0;
            html += `
                <div style="padding: 0 4px; margin: 0;">
                    <div style="height: 3px; background: #e5e7eb; border-radius: 2px; overflow: hidden;">
                        <div style="height: 100%; width: ${percent}%; background: linear-gradient(90deg, #3b82f6, #1e40af); border-radius: 2px; transition: width 0.3s;"></div>
                    </div>
                </div>
            `;
            
            const currentStage = this.stages[this.currentStageIndex];
            if (currentStage) {
                html += `
                    <div style="padding: 1px 4px; background: #fafafa; border-radius: 2px; margin: 0;">
                        <div style="font-size: 9px; font-weight: 600; color: #1f2937;">
                            <i class="fas fa-hand-point-right" style="color: #3b82f6;"></i> ${currentStage.name}
                        </div>
                        ${currentStage.instruction ? `<div style="font-size: 8px; color: #6b7280;">${currentStage.instruction}</div>` : ''}
                    </div>
                `;
            }
            
            let statusText = '准备就绪';
            let statusColor = '#6b7280';
            if (this._isRunning) {
                if (this.currentPhase === 'prepare') {
                    statusText = '准备中...';
                    statusColor = '#f59e0b';
                } else if (this.currentPhase === 'continual') {
                    statusText = '采集中';
                    statusColor = '#10b981';
                }
            }
            
            html += `
                <div style="padding: 1px 4px; font-size: 9px; color: ${statusColor}; display: flex; align-items: center; gap: 2px;">
                    <span style="width: 4px; height: 4px; border-radius: 50%; background: ${statusColor};"></span>
                    ${statusText}
                </div>
            `;
            
            this.updateGestureListContent(gestureList, html);
        }

        updateGestureListContent(gestureList, html) {
            const titleElement = gestureList.querySelector('.gesture-list-title');
            if (titleElement) {
                const children = Array.from(gestureList.children);
                children.forEach(child => {
                    if (!child.classList.contains('gesture-list-title')) {
                        child.remove();
                    }
                });
                titleElement.insertAdjacentHTML('afterend', html);
            } else {
                gestureList.innerHTML = `<div class="gesture-list-title"></div>` + html;
            }
        }

        getCurrentTrialProgress() {
            if (this.currentTaskId === 'continual_gesture_1' && window.continualGesture1Animation) {
                const progress = window.continualGesture1Animation.getProgress();
                return progress.trial || 0;
            } else if (this.currentTaskId === 'continual_gesture_2' && window.continualGesture2Animation) {
                const progress = window.continualGesture2Animation.getProgress();
                return progress.trial || 0;
            }
            return this.continualTrialCount || 0;
        }

        updateNextStageButton() {
            const nextStageBtn = document.getElementById('nextStageBtn');
            if (!nextStageBtn) return;

            if (this.currentStageIndex < this.stages.length - 1 && !this._isRunning) {
                nextStageBtn.style.display = 'inline-flex';
                nextStageBtn.textContent = `进入下一Stage: ${this.stages[this.currentStageIndex + 1]?.name || ''}`;
            } else {
                nextStageBtn.style.display = 'none';
            }
        }

        getTaskConfig() {
            if (window.TaskConfig?.DEFINITIONS?.[this.currentTaskId]) {
                return window.TaskConfig.DEFINITIONS[this.currentTaskId];
            }
            
            const taskNames = {
                'discrete_gesture': '离散手势采集',
                'continual_gesture_1': '连续手势采集1',
                'continual_gesture_2': '连续手势采集2'
            };
            
            return { name: taskNames[this.currentTaskId] || this.currentTaskId };
        }

        // ==================== 轮次切换 ====================

        /**
         * 切换轮次
         */
        switchSession(sessionIndex) {
            if (sessionIndex < 0 || sessionIndex >= this.sessionCount) return;

            console.log('[Collection] 切换轮次:', sessionIndex + 1);

            this.currentSessionIndex = sessionIndex;
            // 切换轮次时重置Stage为第一个 + 重置同步标记
            this.currentStageIndex = 0;
            this._applyTaskDefaultStage();
            this.currentGestureIndex = 0;
            this.gestureRepeatCount = 0;
            this.continualTrialCount = 0;
            this._sessionSyncDone = false;  // 新session需要重新做同步

            // 重置动画模块的试次计数
            this.resetAnimationModules();

            this.updateSessionSelect();
            this.updateStageSelect();
            this.updateGestureList();
            this.updateNextStageButton();
            this.resetDisplay();

            // 发送session变更消息
            this.sendToRealtimeEngine('session_change', {
                sessionIndex: sessionIndex,
                sessionNumber: sessionIndex + 1
            });

            this.showToast(`已切换到第 ${sessionIndex + 1} 轮，请重新穿戴采集设备`, 'info');
        }

        /**
         * 获取当前Session索引
         */
        getCurrentSessionIndex() {
            return this.currentSessionIndex;
        }

        /**
         * 获取Session总数
         */
        getSessionCount() {
            return this.sessionCount;
        }

        // ==================== Stage切换 ====================

        /**
         * 【修复】切换Stage时重置动画模块状态，并加载该Stage的手势库
         */
        switchStage(stageIndex) {
            if (stageIndex < 0 || stageIndex >= this.stages.length) return;

            console.log('[Collection] 切换Stage:', stageIndex, this.stages[stageIndex]?.name);

            this.currentStageIndex = stageIndex;
            this.currentGestureIndex = 0;
            this.gestureRepeatCount = 0;
            this.continualTrialCount = 0;

            // 【新增】加载该Stage对应的手势库
            this.loadGesturesForCurrentStage();

            // 【关键修复】重置动画模块的试次计数
            this.resetAnimationModules();

            this.updateStageSelect();
            this.updateGestureList();
            this.updateNextStageButton();
            this.resetDisplay();

            this.sendToRealtimeEngine('stage_change', {
                stageIndex: stageIndex,
                stageName: this.stages[stageIndex]?.name || this.stages[stageIndex]?.id,
                sessionIndex: this.currentSessionIndex,
                sessionNumber: this.currentSessionIndex + 1
            });
        }

        /**
         * 【新增】加载当前Stage对应的手势库
         * 如果Stage有配置gestures字段，则只加载该Stage指定的手势
         * 否则加载全局手势库
         *
         * 【新增】乱序模式：如果Stage配置了shuffleGestures=true，则会：
         * 1. 先按照每个手势的重复次数生成完整的实例序列
         * 2. 然后打乱顺序
         * 3. 设置repeatPerGesture=1，让每个实例只执行一次
         */
        loadGesturesForCurrentStage() {
            const currentStage = this.stages[this.currentStageIndex];
            const template = this.getLatestTemplate();

            // 获取全局手势库（优先使用已加载的allGestures）
            const allGestures = this.allGestures ||
                (template.gestures?.discrete || []).filter(g => g.enabled);

            let baseGestures = [];
            if (currentStage?.gestures && currentStage.gestures.length > 0) {
                // Stage有自己的手势配置，根据ID或name筛选（兼容修改过名称的配置）
                const stageGestureIds = currentStage.gestures;
                baseGestures = allGestures.filter(g =>
                    stageGestureIds.includes(g.id) || stageGestureIds.includes(g.name)
                );
                // 按配置顺序排序（优先匹配id，其次匹配name）
                baseGestures.sort((a, b) => {
                    const indexA = stageGestureIds.indexOf(a.id) !== -1
                        ? stageGestureIds.indexOf(a.id)
                        : stageGestureIds.indexOf(a.name);
                    const indexB = stageGestureIds.indexOf(b.id) !== -1
                        ? stageGestureIds.indexOf(b.id)
                        : stageGestureIds.indexOf(b.name);
                    return indexA - indexB;
                });
                console.log(`[Collection] Stage "${currentStage.name}" 加载专属手势库: ${baseGestures.length}个`);
            } else {
                // Stage没有配置手势，使用全局手势库
                baseGestures = [...allGestures];
                console.log(`[Collection] Stage "${currentStage?.name}" 使用全局手势库: ${baseGestures.length}个`);
            }

            // 【新增】检查是否启用乱序模式
            const shuffleGestures = currentStage?.shuffleGestures || false;

            if (shuffleGestures && this.currentTaskId === 'discrete_gesture') {
                // 部分顺序 + 部分乱序模式
                const repeatCount = this._isTestMode ? 2 : (this.currentExecutionParams?.repeatPerGesture || 5);

                // 读取 orderedShuffleRatio 并做容错
                let orderedRatio = this.currentExecutionParams?.orderedShuffleRatio;
                if (typeof orderedRatio !== 'number' || isNaN(orderedRatio)) {
                    orderedRatio = 0.6;
                }
                orderedRatio = Math.max(0, Math.min(1, orderedRatio));

                const result = this.buildPartiallyShuffledGestureSequence(baseGestures, repeatCount, orderedRatio);

                this.gestures = result.sequence;
                this._shuffleMode = true;

                console.log(`[Collection] ★ 部分乱序模式已启用 ★`);
                console.log(`[Collection] 测试模式: ${this._isTestMode ? '是' : '否'}`);
                console.log(`[Collection] 原始手势: ${result.baseCount}个, 每个重复${result.repeatCount}次`);
                console.log(`[Collection] orderedShuffleRatio: ${result.orderedRatio}`);
                console.log(`[Collection] orderedRepeat: ${result.orderedRepeat}, shuffledRepeat: ${result.shuffledRepeat}`);
                console.log(`[Collection] orderedPart: ${result.orderedCount}个, shuffledPart: ${result.shuffledCount}个`);
                console.log(`[Collection] 序列总长度: ${result.totalLength}个`);
            } else {
                // 正常模式
                this.gestures = baseGestures;
                this._shuffleMode = false;
            }
        }

        /**
         * 构建"部分顺序 + 部分乱序"的手势实例序列
         *
         * 规则：按 orderedRatio 控制顺序段占比（默认 0.6），剩余进入 Fisher-Yates 打乱。
         *
         * @param {Array} baseGestures - Stage 手势库（已按顺序排列）
         * @param {number} repeatCount - 每个手势总重复次数
         * @param {number} orderedRatio - 顺序段占比，默认 0.6
         * @returns {{ sequence: Array, baseCount: number, repeatCount: number,
         *             orderedRatio: number, orderedRepeat: number, shuffledRepeat: number,
         *             orderedCount: number, shuffledCount: number, totalLength: number }}
         */
        buildPartiallyShuffledGestureSequence(baseGestures, repeatCount, orderedRatio = 0.6) {
            const orderedRepeat = Math.floor(repeatCount * orderedRatio);
            const shuffledRepeat = repeatCount - orderedRepeat;

            const orderedPart = [];
            const shuffledPart = [];

            baseGestures.forEach((gesture, gestureIndex) => {
                for (let i = 0; i < orderedRepeat; i++) {
                    orderedPart.push({
                        ...gesture,
                        _shuffled: true,
                        _shuffleSegment: 'ordered',
                        _baseGestureIndex: gestureIndex,
                        _repeatIndex: i + 1,
                        _repeatTotal: repeatCount
                    });
                }

                for (let i = 0; i < shuffledRepeat; i++) {
                    shuffledPart.push({
                        ...gesture,
                        _shuffled: true,
                        _shuffleSegment: 'shuffled',
                        _baseGestureIndex: gestureIndex,
                        _repeatIndex: orderedRepeat + i + 1,
                        _repeatTotal: repeatCount
                    });
                }
            });

            // Fisher-Yates 仅打乱 shuffledPart
            for (let i = shuffledPart.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffledPart[i], shuffledPart[j]] = [shuffledPart[j], shuffledPart[i]];
            }

            return {
                sequence: orderedPart.concat(shuffledPart),
                baseCount: baseGestures.length,
                repeatCount,
                orderedRatio,
                orderedRepeat,
                shuffledRepeat,
                orderedCount: orderedPart.length,
                shuffledCount: shuffledPart.length,
                totalLength: orderedPart.length + shuffledPart.length
            };
        }

        goToNextStage() {
            if (this.currentStageIndex < this.stages.length - 1) {
                this.switchStage(this.currentStageIndex + 1);
                this.showToast(`已切换到Stage: ${this.stages[this.currentStageIndex]?.name}`, 'success');
            }
        }

        // ==================== 采集控制 ====================

        /**
         * 开始采集任务
         * @param {boolean} isTestMode - 是否为测试模式（不保存H5文件）
         */
        async startTask(isTestMode = false) {
            if (this._isRunning || ['starting', 'stopping', 'save_failed'].includes(this._saveState)) return;
            this._saveState = 'starting';

            // 【新增】保存测试模式状态
            this._isTestMode = isTestMode;

            // 【精准对齐同步】每次开始新的采集任务时重置同步标记
            this._sessionSyncDone = false;

            console.log('[Collection] ===== 开始采集任务 =====');
            console.log('[Collection] 任务类型:', this.currentTaskId);
            console.log('[Collection] 测试模式:', isTestMode ? '是（不保存H5文件）' : '否');
            console.log('[Collection] 续采模式:', this._isResumeMode ? '是' : '否');
            console.log('[Collection] 当前Stage:', this.stages[this.currentStageIndex]?.name);

            // 【Phase 2 - Bug 1 fix】续采模式仅重载执行参数，不覆盖断点恢复的 gestures/进度
            if (!this._isResumeMode) {
                const selectedTaskId = this.currentTaskId;
                this.loadCollectionConfig({ preferredTaskId: selectedTaskId });
                this._syncCollectionConfigTask(selectedTaskId);
            } else {
                this._reloadExecutionParams();
                if (!this._hasValidExecutionParamsForTask(this.currentTaskId)) {
                    console.warn('[Collection] 续采模式执行参数不完整，使用默认值兜底');
                    this._applyExecutionDefaultsForTask(this.currentTaskId);
                }
            }
            console.log('[Collection] ★★★ 配置加载后 ★★★');
            console.log('[Collection] currentExecutionParams:', this.currentExecutionParams);
            console.log('[Collection] gestures 数量:', this.gestures.length);
            this.updateTaskHeader();
            this.sendToRealtimeEngine('task_change', { taskId: this.currentTaskId });

            // 【关键修复】重置动画模块状态
            this.resetAnimationModules();

            // ==================== 【新增】停止摄像头预览流，释放摄像头给后端录制 ====================
            if (window.cameraControl && window.cameraControl.isStreaming) {
                console.log('[Collection] 停止摄像头预览流，释放摄像头...');
                try {
                    await window.cameraControl.stopStreaming('both');
                    console.log('[Collection] ✅ 摄像头预览流已停止');
                } catch (error) {
                    console.warn('[Collection] 停止摄像头预览流失败:', error);
                }
            }

            // ==================== 【修复】Stream 切换: preview → collection ====================
            // 非测试模式下，在开始 H5 记录前先切换 BLE 流
            let switchResponse = null;  // 保存切换响应，用于传递 collection_bins 到 realtimeEngine
            if (!isTestMode && window.BleControl && window.BleControl.isConnected) {
                this.updateStatus('切换采集流中，请稍候...');
                this._setAllButtonsDisabled(true);
                this._switchInProgress = true;

                try {
                    // Step 1: 确保 session_id 已设置（collection bin 文件名需要）
                    const sessionId = this._getEffectiveSessionId();
                    console.log('[Collection] ★ Step 1: 设置 session_id:', sessionId);
                    await window.BleControl.setSessionIdAndWait(sessionId);
                    console.log('[Collection] ★ set_session_id 完成');

                    // Step 2: preview → collection 切流
                    console.log('[Collection] ★ Step 2: preview → collection 切换...');
                    switchResponse = await window.BleControl.sendAndWait('switch_preview_to_collection');
                    console.log('[Collection] ★ switch_preview_to_collection 完成:', switchResponse);

                    if (switchResponse.collection_bins) {
                        console.log('[Collection] Collection bins:', switchResponse.collection_bins);
                    }
                } catch (err) {
                    console.error('[Collection] ★ 切换采集流失败:', err);
                    this.showToast('切换采集流失败: ' + err.message, 'error');
                    this._setAllButtonsDisabled(false);
                    this._switchInProgress = false;
                    this.updateControlButtons(false);
                    this._saveState = 'idle';
                    this.updateStatus('切换失败');
                    return;
                }
                this._switchInProgress = false;
                this.updateStatus('采集流已就绪，开始记录...');
            }
            // ==================== Stream 切换结束 ====================

            this._isRunning = true;
            this._isPaused = false;

            // 【Phase 2】续采模式下不重置进度索引
            if (!this._isResumeMode) {
                this.currentGestureIndex = 0;
                this.gestureRepeatCount = 0;
                this.continualTrialCount = 0;
            } else {
                console.log('[Collection] 续采模式：保留进度');
                console.log('[Collection]   gestureIndex:', this.currentGestureIndex);
                console.log('[Collection]   repeatCount:', this.gestureRepeatCount);
                console.log('[Collection]   trialCount:', this.continualTrialCount);
            }

            this.updateControlButtons(true);

            // 【新增】开始采集后隐藏质量颜色指示
            if (window.waveformController) {
                window.waveformController.refreshQualityVisibility();
            }

            // 禁用Session和Stage选择器
            const sessionSelect = document.getElementById('sessionSwitchSelect');
            if (sessionSelect) sessionSelect.disabled = true;
            const stageSelect = document.getElementById('stageSwitchSelect');
            if (stageSelect) stageSelect.disabled = true;

            this.updateNextStageButton();

            const currentStage = this.stages[this.currentStageIndex];
            const userData = JSON.parse(localStorage.getItem('emg_current_user') || '{}');

            const userId = userData.id ||
                           this.collectionConfig?.subject?.id ||
                           `S${Date.now().toString().slice(-6)}`;

            // 【Phase 2】续采模式下保留断点的 recordingSessionId，其他情况正常生成
            if (!this._isResumeMode) {
                if (!this._isAllSessionsMode) {
                    this._recordingSessionId = this._generateRecordingSessionId(1);
                    console.log('[Collection] 单轮采集，生成录像会话ID:', this._recordingSessionId);
                }
                // 全部轮次模式下，录像会话ID在 startAllSessions 中已生成
            } else {
                console.log('[Collection] 续采模式，复用录像会话ID:', this._recordingSessionId);
            }

            // 【新增】启用空格键监听
            this._enableSpaceKey();

            // 【新增】重置摄像头录制状态
            this._cameraRecordingStarted = false;
            this._currentVideoStartTimestamp = null;
            this._currentH5FileName = null;

            // 【注释】HLS 录制已在配置摄像头时启动，不需要在采集开始时再启动
            // 按空格键时会标记录制起始分段

            // 构建 collection_start payload
            const startPayload = {
                taskId: this.currentTaskId,
                sessionIndex: this.currentSessionIndex,
                sessionNumber: this.currentSessionIndex + 1,
                sessionCount: this.sessionCount,
                stageName: currentStage?.name || currentStage?.id || 'stage_1',
                stageIndex: this.currentStageIndex,
                userId: userId,
                // 【新增】测试模式标志
                isTestMode: isTestMode,
                // 【新增】录像会话信息
                recordingSessionId: this._recordingSessionId,
                isMultiSession: this._isAllSessionsMode,
                // 文件名建议格式: userId_session{N}_{stageName}_{timestamp}
                suggestedFileName: `${userId}_session${this.currentSessionIndex + 1}_${currentStage?.name || currentStage?.id || 'stage'}`,
                config: this.collectionConfig,
                // 【修复 Issue 3】直接传递 switch 响应中的 collection_bins，不依赖 600ms 竞态
                collectionBins: switchResponse?.collection_bins || null,
                collectionDeviceNames: switchResponse?.device_names || null,
                streamMode: 'collection',
                collectionStreamId: switchResponse?.collection_stream_id || null,
            };

            // 【Phase 2】续采模式下附加 resume 元数据
            if (this._isResumeMode && this._resumeState) {
                startPayload.isResume = true;
                startPayload.resumeFromInterruptedAt = this._resumeState.interruptedAt;
                startPayload.resumeReason = this._resumeState.interruptReason;
                startPayload.resumeSegmentIndex = this._resumeSegmentIndex;
                startPayload.resumeParentRecordingSessionId = this._resumeState.recordingSessionId;
                startPayload.resumeParentSegmentIndex = this._resumeState.segmentIndex || null;  // Phase 3
                console.log('[Collection] 续采元数据已附加:');
                console.log('  isResume:', true);
                console.log('  resumeSegmentIndex:', this._resumeSegmentIndex);
                console.log('  resumeParentSegmentIndex:', this._resumeState.segmentIndex);
                console.log('  resumeReason:', this._resumeState.interruptReason);
            }

            // 【新增】保存 collectionBins 供视频录制使用
            this._collectionBins = startPayload.collectionBins || {};
            console.log('[Collection] 已保存 collectionBins:', this._collectionBins);

            try {
                await this.sendToRealtimeEngineAndWait('collection_start', startPayload);
                if (this._saveState !== 'starting') return;
                if (this.currentTaskId === 'discrete_gesture') {
                    await this.startDiscreteGestureCollection();
                } else {
                    this.startContinualGestureCollection();
                }
                if (this._saveState === 'starting') this._saveState = 'collecting';
            } catch (error) {
                this.sendToRealtimeEngine('abnormal_interrupt_freeze', {});
                this._retrySave = () => this.stopTask();
                this._setSaveState('save_failed', error.message);
            }
        }

        /**
         * 【新增】开始全部轮次采集
         * 始终从 Session 1 开始，自动循环完成所有轮次
         */
        startAllSessions() {
            if (this._isRunning || ['starting', 'stopping', 'save_failed'].includes(this._saveState)) return;

            console.log('[Collection] ===== 开始全部轮次采集 =====');
            console.log('[Collection] 总Session数:', this.sessionCount);
            console.log('[Collection] 轮次间休息时间:', this._restBetweenSessions, '秒');

            // 【修复】始终从 Session 1 开始
            this.currentSessionIndex = 0;
            this.currentStageIndex = 0;
            this._applyTaskDefaultStage();
            this.currentGestureIndex = 0;
            this.gestureRepeatCount = 0;
            this.continualTrialCount = 0;
            this._sessionSyncDone = false;  // 新session需要重新做同步

            // 重置动画模块
            this.resetAnimationModules();

            // 更新UI显示
            this.updateSessionSelect();
            this.updateStageSelect();
            this.updateGestureList();

            console.log('[Collection] 重置到 Session 1 开始采集');

            // 设置全部轮次模式标志
            this._isAllSessionsMode = true;

            // 【新增】生成录像会话ID（全部轮次共用一个ID）
            this._recordingSessionId = this._generateRecordingSessionId(this.sessionCount);
            console.log('[Collection] 全部轮次采集，生成录像会话ID:', this._recordingSessionId);
            if (window.CameraControl && window.CameraControl.setVideoCollectionActive) {
                window.CameraControl.setVideoCollectionActive(true, {
                    mode: 'all_sessions',
                    recordingSessionId: this._recordingSessionId,
                    sessionCount: this.sessionCount
                });
            }

            // 显示开始提示弹窗
            this.showSessionOverlay({
                title: '开始第 1 轮',
                subtitle: `共 ${this.sessionCount} 轮，准备开始采集...`,
                icon: '🚀',
                type: 'start'
            });

            // 2秒后隐藏弹窗并开始采集
            setTimeout(() => {
                this.hideSessionOverlay();
                this.startTask(false);
            }, 2000);
        }

        /**
         * 【新增】显示休息倒计时并继续下一轮
         */
        showRestCountdownAndContinue() {
            const nextSessionIndex = this.currentSessionIndex + 1;
            let remainingSeconds = this._restBetweenSessions;
            const totalSeconds = this._restBetweenSessions;

            console.log('[Collection] 开始休息倒计时:', remainingSeconds, '秒');
            console.log('[Collection] 下一轮Session:', nextSessionIndex + 1);

            // 【优化】轮次间休息切流策略
            if (window.BleControl && window.BleControl.isConnected) {
                if (remainingSeconds >= this.MIN_REST_FOR_PREVIEW_STREAM_SECONDS) {
                    // 长休息：collection → preview，保持波形预览
                    console.log(`[Collection] 长休息 (${remainingSeconds}s >= ${this.MIN_REST_FOR_PREVIEW_STREAM_SECONDS}s)：collection → preview`);
                    this._showRingStreamTransition('preview');
                    window.BleControl.switchCollectionToPreview();
                } else {
                    // 短休息：collection → idle，不产生中间 PREVIEW bin
                    console.log(`[Collection] 短休息 (${remainingSeconds}s < ${this.MIN_REST_FOR_PREVIEW_STREAM_SECONDS}s)：collection → idle, skip preview`);
                    this._showRingStreamTransition('idle');
                    window.BleControl.stopCollectionStream();
                }
            }

            // 【修改】使用全屏居中弹窗显示休息倒计时
            this.showSessionOverlay({
                title: '休息时间',
                subtitle: `第 ${this.currentSessionIndex + 1} 轮完成！\n即将开始第 ${nextSessionIndex + 1}/${this.sessionCount} 轮`,
                icon: '☕',
                countdown: remainingSeconds,
                type: 'rest'
            });

            this.updateStatus(`休息中 - ${remainingSeconds}秒后开始第${nextSessionIndex + 1}轮`);

            // 清理之前的定时器
            if (this._restCountdownTimer) {
                clearInterval(this._restCountdownTimer);
                this._restCountdownTimer = null;
            }

            this._restCountdownTimer = setInterval(() => {
                remainingSeconds--;

                // 更新全屏弹窗的倒计时
                this.updateSessionOverlayCountdown(remainingSeconds, totalSeconds);
                this.updateStatus(`休息中 - ${remainingSeconds}秒后开始第${nextSessionIndex + 1}轮`);

                if (remainingSeconds <= 0) {
                    clearInterval(this._restCountdownTimer);
                    this._restCountdownTimer = null;

                    // 隐藏休息弹窗
                    this.hideSessionOverlay();

                    // 切换到下一个Session并开始采集
                    this.currentSessionIndex = nextSessionIndex;
                    this.currentGestureIndex = 0;
                    this.gestureRepeatCount = 0;
                    this.continualTrialCount = 0;

                    // 重置动画模块
                    this.resetAnimationModules();

                    // 更新UI
                    this.updateSessionSelect();
                    this.updateGestureList();

                    console.log('[Collection] 休息结束，开始第', nextSessionIndex + 1, '轮采集');

                    // 【修改】显示开始新轮次的提示弹窗（短暂显示后自动开始）
                    this.showSessionOverlay({
                        title: `开始第 ${nextSessionIndex + 1} 轮`,
                        subtitle: `共 ${this.sessionCount} 轮，准备开始采集...`,
                        icon: '🚀',
                        type: 'start'
                    });

                    // 2秒后隐藏弹窗并开始采集
                    setTimeout(() => {
                        this.hideSessionOverlay();
                        this.startTask(false);
                    }, 2000);
                }
            }, 1000);
        }

        /**
         * 【新增】取消全部轮次采集模式
         */
        cancelAllSessionsMode() {
            this._isAllSessionsMode = false;
            if (window.CameraControl && window.CameraControl.setVideoCollectionActive) {
                window.CameraControl.setVideoCollectionActive(false, {
                    mode: 'all_sessions',
                    recordingSessionId: this._recordingSessionId,
                    sessionCount: this.sessionCount
                });
            }
            if (this._restCountdownTimer) {
                clearInterval(this._restCountdownTimer);
                this._restCountdownTimer = null;
            }
            // 隐藏全屏弹窗
            this.hideSessionOverlay();
        }

        async stopTask(opts = {}) {
            // opts.restartPreview: 默认 true（正常停止后切回 preview），false 时抑制（返回首页等场景）
            const { restartPreview = true } = opts;

            if (this._saveState === 'stopping') return;
            if (this._saveState === 'save_failed' && this._retrySave && !opts.retrying) {
                const retry = this._retrySave; this._retrySave = null; return retry();
            }
            if (!this._isRunning && !this._isAllSessionsMode && this._saveState !== 'save_failed') return;
            this._retrySave = () => this.stopTask({ ...opts, retrying: true });
            this._setSaveState('stopping');

            console.log('[Collection] ===== 停止采集任务 =====');
            console.log('[Collection] restartPreview:', restartPreview);

            this._isRunning = false;
            this._isPaused = false;

            // 【新增】取消全部轮次模式
            this.cancelAllSessionsMode();

            if (this.phaseTimer) {
                clearTimeout(this.phaseTimer);
                this.phaseTimer = null;
            }
            if (this.countdownTimer) {
                clearInterval(this.countdownTimer);
                this.countdownTimer = null;
            }
            if (this.continualProgressTimer) {
                clearInterval(this.continualProgressTimer);
                this.continualProgressTimer = null;
            }

            // 清理标定状态
            if (this.calibrationTimer) {
                clearInterval(this.calibrationTimer);
                this.calibrationTimer = null;
            }
            this.isCalibrating = false;
            this.calibrationPhase = null;

            // 隐藏标定指导动画
            if (window.calibrationGuideAnimation) {
                window.calibrationGuideAnimation.hide();
            }

            // 【新增】隐藏手势示范 GIF
            this.hideGestureGif();

            // 【修改】停止动画时也要处理乱序模式
            if (window.discreteGestureAnimation) {
                window.discreteGestureAnimation.stop();
                // 【新增】如果是乱序模式，也调用专用的停止方法
                if (window.discreteGestureAnimation._shuffleModeActive) {
                    window.discreteGestureAnimation.stopShuffleMode();
                }
            }
            if (window.continualGesture1Animation) {
                window.continualGesture1Animation.stop();
            }
            if (window.continualGesture2Animation) {
                window.continualGesture2Animation.stop();
            }
            if (window.animationController) {
                window.animationController.stop();
            }

            // 【新增】重置乱序模式标志
            this._shuffleMode = false;

            // 重新启用Session和Stage选择器
            const sessionSelect = document.getElementById('sessionSwitchSelect');
            if (sessionSelect) sessionSelect.disabled = false;
            const stageSelect = document.getElementById('stageSwitchSelect');
            if (stageSelect) stageSelect.disabled = false;

            // 【新增】禁用空格键监听
            this._disableSpaceKey();

            this._setSaveState('stopping');

            try {
                await this.sendToRealtimeEngineAndWait('collection_stop_and_wait', { completed: false });
            } catch (error) {
                this._setSaveState('save_failed', error.message);
                return;
            }
            this._retrySave = null;
            this._setSaveState('idle');
            this._cameraRecordingStarted = false;
            this.updateControlButtons(false);
            this.updateNextStageButton();
            this.updateGestureList();
            this.updateStatus('已停止');
            this.resetDisplay();

            // 【修复 Issue 5】停止采集后切换回 preview stream（除非被抑制）
            if (restartPreview && !this._switchInProgress && window.BleControl && window.BleControl.isConnected) {
                this._resumePreviewAfterCollection('manual_stop');
            }

            // 【新增】重新启动摄像头预览流
            if (restartPreview && window.cameraControl && !window.cameraControl.isStreaming) {
                console.log('[Collection] 重新启动摄像头预览流...');
                try {
                    // 检查是否已配置摄像头
                    if (window.cameraControl.selectedCameras.left || window.cameraControl.selectedCameras.right) {
                        await window.cameraControl.startStreaming('both');
                        console.log('[Collection] ✅ 摄像头预览流已重启');
                    } else {
                        console.log('[Collection] 摄像头未配置，跳过重启预览流');
                    }
                } catch (error) {
                    console.warn('[Collection] 重启摄像头预览流失败:', error);
                }
            }
        }

        // 【已移除】togglePause 方法已被测试模式替代

        // ==================== 异常中断 ====================

        /**
         * 【Bugfix】异常中断采集任务
         * 点击按钮瞬间立即冻结业务 + 创建 _pendingAbortSnapshot，
         * 然后弹出原因选择对话框（不可取消）。
         * 断点以"点击按钮那一刻"的状态为准，不再继续采集。
         */
        async abortTask(reason) {
            // 如果已经传了 reason（从弹窗回调），直接执行中断
            if (reason !== undefined) {
                this._executeAbort(reason);
                return;
            }

            // 续采准备态：处理"放弃断点"
            if (!this._isRunning && this._isResumeMode) {
                this._confirmAbandonBreakpoint();
                return;
            }

            // 检查是否正在运行
            if (!this._isRunning) {
                console.warn('[Collection] 采集未运行，无法异常中断');
                return;
            }

            // 测试模式不支持异常中断
            if (this._isTestMode) {
                this.showToast('测试模式无需保存断点', 'warning');
                return;
            }

            // ===== 立即冻结业务，创建断点快照 =====
            console.log('[Collection] ===== 点击异常中断，立即冻结 =====');

            const interruptedAt = new Date().toISOString();

            // 进度快照（必须在停止前复制）
            const progress = {
                currentSessionIndex: this.currentSessionIndex,
                currentStageIndex: this.currentStageIndex,
                currentGestureIndex: this.currentGestureIndex,
                gestureRepeatCount: this.gestureRepeatCount,
                continualTrialCount: this.continualTrialCount,
                currentPhase: this.currentPhase,
                _shuffleMode: this._shuffleMode,
                isAllSessionsMode: this._isAllSessionsMode,
                sessionCount: this.sessionCount
            };

            // 手势快照（乱序模式下保存完整序列，便于恢复）
            const gesturesSnapshot = this.gestures.map((g, i) => ({
                id: g.id,
                name: g.name,
                icon: g.icon,
                gifFile: g.gifFile,
                _shuffled: g._shuffled || false,
                _shuffleSegment: g._shuffleSegment || null,
                _baseGestureIndex: g._baseGestureIndex !== undefined ? g._baseGestureIndex : null,
                _repeatIndex: g._repeatIndex !== undefined ? g._repeatIndex : null,
                _repeatTotal: g._repeatTotal !== undefined ? g._repeatTotal : null
            }));

            const currentSegmentIndex = this._isResumeMode ? this._resumeSegmentIndex : 1;

            // 保存到待决快照，供 _executeAbort 使用
            this._pendingAbortSnapshot = {
                interruptedAt,
                progress,
                gesturesSnapshot,
                currentSegmentIndex,
                collectionConfig: this.collectionConfig,
                currentTaskId: this.currentTaskId,
                recordingSessionId: this._recordingSessionId,
                isAllSessionsMode: this._isAllSessionsMode,
                sessionCount: this.sessionCount,
                stages: this.stages.map(s => ({ id: s.id, name: s.name }))
            };

            console.log('[Collection] 断点快照已创建:');
            console.log('  session:', progress.currentSessionIndex + 1);
            console.log('  stage:', progress.currentStageIndex);
            console.log('  gestureIndex:', progress.currentGestureIndex);
            console.log('  repeatCount:', progress.gestureRepeatCount);
            console.log('  shuffleMode:', progress._shuffleMode);

            // ===== 停止业务推进 =====
            this._isRunning = false;
            this._isPaused = false;

            // 取消全部轮次模式
            this.cancelAllSessionsMode();

            // 清除所有定时器
            if (this.phaseTimer) { clearTimeout(this.phaseTimer); this.phaseTimer = null; }
            if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
            if (this.continualProgressTimer) { clearInterval(this.continualProgressTimer); this.continualProgressTimer = null; }
            if (this.calibrationTimer) { clearInterval(this.calibrationTimer); this.calibrationTimer = null; }
            if (this._restCountdownTimer) { clearInterval(this._restCountdownTimer); this._restCountdownTimer = null; }

            // 停止动画
            if (window.discreteGestureAnimation) {
                window.discreteGestureAnimation.stop();
                if (window.discreteGestureAnimation._shuffleModeActive) {
                    window.discreteGestureAnimation.stopShuffleMode();
                }
            }
            if (window.continualGesture1Animation) { window.continualGesture1Animation.stop(); }
            if (window.continualGesture2Animation) { window.continualGesture2Animation.stop(); }
            if (window.animationController) { window.animationController.stop(); }

            // 隐藏 UI
            this.hideGestureGif();
            if (window.calibrationGuideAnimation) { window.calibrationGuideAnimation.hide(); }

            // 禁用空格键
            this._disableSpaceKey();

            this._showRingStreamTransition('idle');

            // Camera finalization belongs to the acknowledged backend transaction.
            this._setSaveState('stopping');

            // 重新启用选择器
            const sessionSelect = document.getElementById('sessionSwitchSelect');
            if (sessionSelect) sessionSelect.disabled = false;
            const stageSelect = document.getElementById('stageSwitchSelect');
            if (stageSelect) stageSelect.disabled = false;

            // 重置乱序模式标志
            this._shuffleMode = false;

            // 更新 UI
            this.updateControlButtons(false);
            this.updateNextStageButton();
            this.updateGestureList();
            this.updateStatus('已冻结-等待选择中断原因');

            // 恢复质量颜色指示
            if (window.waveformController) {
                window.waveformController.refreshQualityVisibility();
            }

            // ===== 发送冻结信号到 realtimeEngine，立即停止 H5 append =====
            this.sendToRealtimeEngine('abnormal_interrupt_freeze', {
                interruptedAt: this._pendingAbortSnapshot.interruptedAt,
                progress: this._pendingAbortSnapshot.progress
            });
            console.log('[Collection] abnormal_interrupt_freeze 已发送，H5 写入已冻结');

            // ===== 弹出原因选择对话框（不可取消） =====
            this._showAbortReasonDialog((selectedReason) => {
                // selectedReason 必然非 null（无取消按钮）
                this._executeAbort(selectedReason);
            });
        }

        /**
         * 【Bugfix】显示异常中断原因选择对话框
         *
         * 采集已在 abortTask() 中冻结，弹窗只用于选择中断原因。
         * 不可取消 — 点击中断按钮即确定中断。
         */
        _showAbortReasonDialog(callback) {
            const existing = document.getElementById('abortReasonDialog');
            if (existing) existing.remove();

            const overlay = document.createElement('div');
            overlay.id = 'abortReasonDialog';
            overlay.style.cssText = `
                position: fixed; top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(15,23,42,0.92); display: flex; align-items: center;
                justify-content: center; z-index: 10000;
            `;

            const reasons = [
                { value: '设备没电', label: '🔋 设备没电' },
                { value: '丢包严重', label: '📉 丢包严重' },
                { value: '双设备不同步', label: '🔗 双设备不同步' },
                { value: '信号异常', label: '📊 信号异常' },
                { value: '其他', label: '📝 其他' }
            ];

            overlay.innerHTML = `
                <div style="
                    background: white; border-radius: 16px; padding: 32px;
                    min-width: 420px; max-width: 520px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                ">
                    <h3 style="margin:0 0 8px 0; font-size:20px; color:#dc2626;">
                        ⚠️ 异常中断
                    </h3>
                    <p style="margin:0 0 12px 0; color:#6b7280; font-size:14px;">
                        采集已冻结，请选择中断原因。
                    </p>
                    <p style="margin:0 0 20px 0; padding:10px 14px; background:#fef3c7; border-radius:8px;
                        color:#92400e; font-size:12px; line-height:1.5;">
                        💡 当前采集进度已保存为断点<br>
                        选择原因后将自动返回首页，后续可从首页继续采集。
                    </p>
                    <div id="abortReasonList" style="display:flex; flex-direction:column; gap:10px; margin-bottom:24px;">
                        ${reasons.map((r, i) => `
                            <button class="abort-reason-btn" data-reason="${r.value}"
                                style="
                                    padding:12px 16px; border:2px solid #e5e7eb; border-radius:8px;
                                    background:white; cursor:pointer; font-size:14px; text-align:left;
                                    transition: all 0.2s;
                                "
                                onmouseover="this.style.borderColor='#f97316';this.style.background='#fff7ed';"
                                onmouseout="this.style.borderColor='#e5e7eb';this.style.background='white';"
                            >${r.label}</button>
                        `).join('')}
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            // 绑定原因选择事件（无取消按钮，点击即确定）
            const reasonButtons = overlay.querySelectorAll('.abort-reason-btn');
            reasonButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    const selectedReason = btn.dataset.reason;
                    overlay.remove();
                    callback(selectedReason);
                });
            });

            // 不再绑定取消按钮或点击遮罩关闭 — 中断不可取消
        }

        /**
         * 【新增】执行异常中断
         */
        async _executeAbort(reason) {
            console.log('[Collection] ===== 异常中断执行 =====');
            console.log('[Collection] 中断原因:', reason);

            // 【Bugfix】优先使用 _pendingAbortSnapshot（点击中断按钮瞬间的快照）
            const snap = this._pendingAbortSnapshot;
            if (!snap) {
                console.error('[Collection] _pendingAbortSnapshot 缺失，无法执行中断');
                return;
            }
            this._retrySave = () => this._executeAbort(reason);
            this._setSaveState('stopping');

            console.log('[Collection] 快照进度: Session', snap.progress.currentSessionIndex + 1,
                ', Stage', snap.progress.currentStageIndex,
                ', Gesture', snap.progress.currentGestureIndex,
                ', Repeat', snap.progress.gestureRepeatCount);

            // ---- 1. 写入 localStorage（使用快照数据） ----
            const breakpointState = {
                version: 1,
                status: 'save_pending',
                interruptedAt: snap.interruptedAt,
                interruptReason: reason,
                collectionConfig: snap.collectionConfig,
                currentTaskId: snap.currentTaskId,
                currentSessionIndex: snap.progress.currentSessionIndex,
                currentStageIndex: snap.progress.currentStageIndex,
                currentGestureIndex: snap.progress.currentGestureIndex,
                gestureRepeatCount: snap.progress.gestureRepeatCount,
                continualTrialCount: snap.progress.continualTrialCount,
                currentPhase: snap.progress.currentPhase,
                _shuffleMode: snap.progress._shuffleMode,
                segmentIndex: snap.currentSegmentIndex,
                isAllSessionsMode: snap.progress.isAllSessionsMode,
                sessionCount: snap.progress.sessionCount,
                gesturesSnapshot: snap.gesturesSnapshot,
                recordingSessionId: snap.recordingSessionId,
                stages: snap.stages
            };

            localStorage.setItem('emg_breakpoint_state', JSON.stringify(breakpointState));
            localStorage.setItem('emg_breakpoint_exists', 'true');
            console.log('[Collection] breakpoint 状态已写入 localStorage');

            // ---- 2. 发送异常中断到 realtimeEngine（使用快照进度 + 完整 breakpointState） ----
            try {
                await this.sendToRealtimeEngineAndWait('abnormal_interrupt', {
                reason: reason,
                interruptedAt: snap.interruptedAt,
                progress: snap.progress,
                breakpointState: breakpointState  // Phase 6 fix: 完整可恢复状态
            });

            } catch (error) {
                this._setSaveState('save_failed', error.message);
                return;
            }
            breakpointState.status = 'abnormal_interrupted';
            localStorage.setItem('emg_breakpoint_state', JSON.stringify(breakpointState));
            this._pendingAbortSnapshot = null;
            this._retrySave = null;
            this._setSaveState('idle');

            // ---- 3. 停止 collection stream（异常中断，不重启 preview） ----
            if (window.BleControl && window.BleControl.isConnected) {
                window.BleControl.stopCollectionStream();
                console.log('[Collection] 已停止 collection stream（异常中断，不重启 preview）');
            }

            // ---- 4. 前端清理已在 abortTask() 中完成，此处无需重复 ----

            // 更新状态
            this.updateStatus('已中断');
            this.showToast(`已保存断点: ${reason}`, 'success');

            console.log('[Collection] 异常中断流程完成，breakpoint 已保存');

            // ---- 4. 自动返回首页（设置一次性标记，仅此次显示续采按钮） ----
            window.__showBreakpointResumeAfterAbort = true;
            setTimeout(() => {
                if (window.pageSwitchController) {
                    console.log('[Collection] 自动返回首页 (续采按钮标记已设置)');
                    window.pageSwitchController.showWelcome();
                }
            }, 400);
        }

        // 【已移除】togglePause 方法已被测试模式替代

        isRunning() {
            return !!(this._isRunning || this._isAllSessionsMode || this._switchInProgress || this._restCountdownTimer);
        }

        // ==================== 标定流程（单阶段） ====================

        /**
         * 启动标定流程
         * 流程：demo（可选）→ calibrate（受试者做完整动作范围）→ 完成
         */
        startCalibrationFlow() {
            console.log('[Collection] ====== 启动标定流程 ======');

            this.isCalibrating = true;
            this.currentPhase = 'calibration';
            this.updateGestureList();

            const inputInterface = window.animationInputInterface;
            if (inputInterface) {
                inputInterface.setCurrentTask(this.currentTaskId);
            }

            this.sendToRealtimeEngine('task_change', { taskId: this.currentTaskId });

            // 直接开始标定（跳过 demo）
            this.startCalibration();
        }

        /**
         * 开始标定（单阶段：受试者做完整动作范围）
         */
        startCalibration() {
            console.log('[Collection] 开始标定');

            this.calibrationPhase = 'calibrating';

            const inputInterface = window.animationInputInterface;
            const guideAnimation = window.calibrationGuideAnimation;

            // 开始记录数据
            if (inputInterface) {
                inputInterface.startCalibration(this.currentTaskId);
            }

            // 显示标定指导
            if (guideAnimation) {
                guideAnimation.show(
                    this.currentTaskId,
                    'calibrate',  // 单阶段标定
                    () => { this.endCalibration(); }
                );
            } else {
                // 没有指导动画时，使用简单倒计时
                this.showSimpleCalibrationCountdown('标定', () => { this.endCalibration(); });
            }
        }

        /**
         * 结束标定
         */
        endCalibration() {
            console.log('[Collection] 标定结束');

            const inputInterface = window.animationInputInterface;
            if (inputInterface) {
                const result = inputInterface.endCalibration();
                console.log('[Collection] 标定结果:', result);
            }

            this.onCalibrationComplete();
        }

        /**
         * 标定流程完成
         */
        onCalibrationComplete() {
            console.log('[Collection] ====== 标定流程完成 ======');

            this.isCalibrating = false;
            this.calibrationPhase = null;

            const inputInterface = window.animationInputInterface;
            if (inputInterface) {
                const status = inputInterface.getCalibrationStatus();
                console.log('[Collection] 标定状态:', status);

                // 【修复】不显示 toast，避免退出后仍然显示
                if (status.isCalibrated) {
                    console.log(`[Collection] 标定完成: min=${status.min?.toFixed(1)}, max=${status.max?.toFixed(1)}`);
                }
            }

            this.updateGestureDisplay({
                name: '标定完成',
                instruction: '即将开始正式采集...',
                showCountdown: false
            });

            setTimeout(() => {
                this.currentPhase = 'prepare';
                this.updateGestureList();
                this.showContinualPreparation(() => {
                    this.startContinualAnimation();
                });
            }, 1500);
        }

        /**
         * 显示简单的标定倒计时（当没有guideAnimation时使用）
         */
        showSimpleCalibrationCountdown(label, callback) {
            const duration = 10;

            this.updateGestureDisplay({
                name: `${label}中`,
                instruction: '请做完整的动作范围（从最小到最大）',
                showCountdown: true,
                countdownValue: duration
            });

            let countdown = duration;
            const countdownEl = document.getElementById('countdown');

            this.calibrationTimer = setInterval(() => {
                countdown--;
                if (countdownEl) countdownEl.textContent = countdown;

                if (countdown <= 0) {
                    clearInterval(this.calibrationTimer);
                    this.calibrationTimer = null;
                    if (countdownEl) countdownEl.style.display = 'none';
                    callback();
                }
            }, 1000);
        }

        /**
         * 跳过标定流程
         */
        skipCalibrationFlow() {
            console.log('[Collection] 跳过标定流程');

            if (this.calibrationTimer) {
                clearInterval(this.calibrationTimer);
                this.calibrationTimer = null;
            }

            const guideAnimation = window.calibrationGuideAnimation;
            if (guideAnimation) guideAnimation.hide();

            this.skipCalibration = true;
            this.isCalibrating = false;
            this.calibrationPhase = null;

            this.currentPhase = 'prepare';
            this.updateGestureList();
            this.showContinualPreparation(() => {
                this.startContinualAnimation();
            });
        }

        /**
         * 重置标定
         */
        resetCalibration() {
            const inputInterface = window.animationInputInterface;
            if (inputInterface) {
                inputInterface.resetCalibration(this.currentTaskId);
                this.showToast('标定已重置', 'info');
            }
            this.skipCalibration = false;
        }

        // ==================== 离散手势采集流程 ====================

        async startDiscreteGestureCollection() {
            console.log('[Collection] 开始离散手势采集');
            console.log('[Collection] 乱序模式:', this._shuffleMode ? '是' : '否');

            // 【修复】发送 stage_start 命令打开 H5 文件
            const currentStage = this.stages[this.currentStageIndex];
            // 【新增】离散手势采集时，根据stage配置决定是否需要动捕数据
            const needMocap = currentStage?.needMocap || false;
            await this.sendToRealtimeEngineAndWait('stage_start', {
                stageName: currentStage?.name || currentStage?.id,
                stageIndex: this.currentStageIndex,
                timestamp: Date.now() / 1000,  // 【修改】转换为秒，与ble_server时间戳一致
                needMocap: needMocap  // 【新增】传递动捕需求标志
            });
            console.log(`[Collection] Stage "${currentStage?.name}" needMocap: ${needMocap}`);

            // 【精准对齐同步】每个session的第一个stage有独立的同步阶段
            if (!this._sessionSyncDone && this.currentTaskId === 'discrete_gesture') {
                this._sessionSyncDone = true;
                this._syncPhaseActive = true;

                // 保存后续的真正手势库（去掉 sync prompt）
                this._syncRemainingGestures = this.gestures.filter(g => !g._isSyncPrompt);

                // 【Bugfix】续采模式下保存当前手势索引，防止同步阶段覆盖
                this._resumeGestureStartIndex = this._isResumeMode ? this.currentGestureIndex : 0;

                const syncGesture = {
                    id: 'sync_alignment',
                    name: 'sync_alignment',
                    label: '精准对齐同步',
                    icon: '🎯',
                    color: '#ef4444',
                    gifFile: 'sync_alignment.gif',
                    _isSyncPrompt: true
                };

                console.log('[Collection] ★★★ 同步阶段：独立运行精准对齐同步prompt ★★★');
                console.log('[Collection] ★ 同步后剩余手势:', this._syncRemainingGestures.length, '个');
                if (this._isResumeMode) {
                    console.log('[Collection] ★ 续采模式：同步后将从手势索引', this._resumeGestureStartIndex, '继续');
                }

                // Phase 1: 只播放同步prompt
                this.currentPhase = 'sync_prepare';
                this._showSyncPreparation(() => {
                    this._startSyncAnimation(syncGesture);
                });
                return;  // 不执行后续的正常采集流程
            }

            // 清理：确保 gestures 中没有残留的 sync prompt
            this.gestures = this.gestures.filter(g => !g._isSyncPrompt);

            this.currentPhase = 'prepare';

            // 【Bugfix】续采模式下传递 startIndex，从断点索引继续
            if (this._shuffleMode) {
                const startIndex = this._isResumeMode ? this.currentGestureIndex : 0;
                this.showPreparation(() => {
                    this.startShuffleModeAnimation({ startIndex });
                });
            } else {
                this.showPreparation(() => {
                    this.startNextGesture();
                });
            }
        }

        /**
         * 【精准对齐同步】显示同步阶段准备倒计时
         */
        _showSyncPreparation(callback) {
            console.log('[Collection] 🎯 同步阶段：准备中...');

            // 显示同步水印
            this._showSyncWatermark();

            this.updateGestureDisplay({
                name: '🎯 精准对齐同步',
                instruction: '请观察光标！当到达采集线时，立即做出标定动作',
                showCountdown: true,
                countdownValue: 2
            });

            let countdown = 2;
            const countdownEl = document.getElementById('countdown');

            this.countdownTimer = setInterval(() => {
                countdown--;
                if (countdownEl) countdownEl.textContent = countdown;

                if (countdown <= 0) {
                    clearInterval(this.countdownTimer);
                    this.countdownTimer = null;
                    if (countdownEl) countdownEl.style.display = 'none';
                    callback();
                }
            }, 1000);
        }

        /**
         * 【精准对齐同步】启动同步prompt动画（单prompt）
         * startGesture 内部已通过 onPromptTriggered 回调自动发送 prompt 到后端
         */
        _startSyncAnimation(syncGesture) {
            console.log('[Collection] 🎯 同步动画开始');

            this.currentPhase = 'sync';
            this.currentGestureIndex = 0;

            // 显示手势GIF
            this.showGestureGif(syncGesture);

            if (window.discreteGestureAnimation) {
                // 使用 startGesture 播放单个手势（repeatPerGesture=1）
                // 触发时自动发送 sync_alignment prompt 到 H5（由 startGesture 的 onPromptTriggered 回调处理）
                window.discreteGestureAnimation.startGesture(
                    syncGesture,
                    { repeatPerGesture: 1, intervalBetweenRepeat: 1.0 },
                    () => {
                        // 单次重复完成 → 进入过渡阶段
                        this._onSyncPhaseComplete();
                    }
                );
            } else {
                // 没有动画模块时直接过渡
                console.warn('[Collection] 无动画模块，跳过同步动画');
                this._onSyncPhaseComplete();
            }
        }

        /**
         * 【精准对齐同步】同步阶段完成 → 过渡到真正的手势采集
         * 注意：sync_alignment prompt 已由 startGesture 动画的 onPromptTriggered 回调发送，
         *       这里只做阶段过渡，不重复发送 prompt。
         */
        _onSyncPhaseComplete() {
            console.log('[Collection] ✅ 同步阶段完成 — 开始过渡到手势采集');

            // 隐藏同步水印
            this._hideSyncWatermark();

            // 停止同步动画
            if (window.discreteGestureAnimation) {
                window.discreteGestureAnimation.stop();
            }

            // 隐藏GIF
            this.hideGestureGif();

            // 恢复真正的手势库（不含 sync prompt）
            this.gestures = this._syncRemainingGestures || this.gestures.filter(g => !g._isSyncPrompt);

            // 【Bugfix】续采模式下恢复断点手势索引，不为0
            const resumeStartIndex = this._resumeGestureStartIndex || 0;
            this.currentGestureIndex = this._isResumeMode ? resumeStartIndex : 0;
            this._syncPhaseActive = false;

            if (this._isResumeMode && resumeStartIndex > 0) {
                console.log('[Collection] ★ 续采模式：恢复手势索引到', resumeStartIndex);
            }

            // 显示过渡信息
            this.updateGestureDisplay({
                name: '✅ 同步完成',
                instruction: '即将开始手势采集...',
                showCountdown: true,
                countdownValue: 2
            });

            let transCountdown = 2;
            const countdownEl = document.getElementById('countdown');

            this.countdownTimer = setInterval(() => {
                transCountdown--;
                if (countdownEl) countdownEl.textContent = transCountdown;

                if (transCountdown <= 0) {
                    clearInterval(this.countdownTimer);
                    this.countdownTimer = null;
                    if (countdownEl) countdownEl.style.display = 'none';

                    console.log('[Collection] ★ 开始真正的手势采集阶段');
                    console.log('[Collection] gestures 数量:', this.gestures.length);

                    // 进入正常的手势采集流程
                    this.currentPhase = 'prepare';
                    this.showPreparation(() => {
                        if (this._shuffleMode) {
                            this.startShuffleModeAnimation({ startIndex: resumeStartIndex });
                        } else {
                            this.startNextGesture();
                        }
                    });
                }
            }, 1000);
        }

        /**
         * 【精准对齐同步】显示"同步"半透明水印覆盖层
         */
        _showSyncWatermark() {
            // 移除旧水印（防御）
            this._hideSyncWatermark();

            const watermark = document.createElement('div');
            watermark.id = 'sync-watermark-overlay';
            watermark.style.cssText = `
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                pointer-events: none;
                z-index: 100;
                display: flex;
                align-items: center;
                justify-content: center;
                background: transparent;
            `;

            const text = document.createElement('div');
            text.textContent = '同步';
            text.style.cssText = `
                font-size: 120px;
                font-weight: 900;
                color: rgba(239, 68, 68, 0.12);
                letter-spacing: 40px;
                user-select: none;
                transform: rotate(-15deg);
            `;
            watermark.appendChild(text);
            document.body.appendChild(watermark);
            console.log('[Collection] 🎯 同步水印已显示');
        }

        /**
         * 【精准对齐同步】移除"同步"水印
         */
        _hideSyncWatermark() {
            const el = document.getElementById('sync-watermark-overlay');
            if (el) {
                el.remove();
                console.log('[Collection] 🎯 同步水印已移除');
            }
        }

        /**
         * 【新增】启动乱序模式动画
         * 所有手势连续滚动显示，不进入休息时间
         */
        startShuffleModeAnimation(opts = {}) {
            const { startIndex = 0 } = opts;
            console.log('[Collection] ★★★ 启动乱序模式动画 ★★★');
            console.log('[Collection] 乱序手势数量:', this.gestures.length);
            console.log('[Collection] startIndex:', startIndex);

            const currentStage = this.stages[this.currentStageIndex];

            // 构建Stage配置
            const stageConfig = {
                name: currentStage?.name || currentStage?.id || 'shuffle_stage',
                label: currentStage?.name || '乱序采集',
                instruction: currentStage?.instruction || '请跟随手势指示执行动作'
            };

            // 【Bugfix】续采时显示 startIndex 对应的手势 GIF，不是 gestures[0]
            if (this.gestures.length > 0) {
                const gifIndex = Math.min(startIndex, this.gestures.length - 1);
                this.showGestureGif(this.gestures[gifIndex]);
            }

            // 【Bugfix】续采时跳过已执行的手势，从 startIndex 推进 currentGestureIndex
            if (startIndex > 0 && this._isResumeMode) {
                this.currentGestureIndex = startIndex;
                console.log('[Collection] 续采从手势索引', startIndex, '开始');
            }

            this.updateProgress();  // 【Bugfix】乱序模式启动时初始化底部进度条

            this.currentPhase = 'gesture';
            this.updateGestureList();

            if (window.discreteGestureAnimation) {
                window.discreteGestureAnimation.startShuffleMode(
                    this.gestures,                    // 乱序后的手势数组
                    this.currentExecutionParams,       // 执行参数
                    stageConfig,                       // Stage配置
                    () => {
                        // 完成回调
                        this.onShuffleModeComplete();
                    },
                    (promptName, index, stageName, promptType) => {
                        // Prompt触发回调
                        this.onShufflePromptTriggered(promptName, index, stageName, promptType);
                    },
                    (upcomingGesture) => {
                        // 即将到达的手势回调 - 更新左下角GIF示范
                        this.showGestureGif(upcomingGesture);
                    },
                    startIndex                         // 【Bugfix】传给动画模块
                );
            } else {
                console.error('[Collection] 未找到离散手势动画模块');
                this.showToast('动画模块未加载', 'error');
            }
        }

        /**
         * 【新增】乱序模式Prompt触发回调
         */
        onShufflePromptTriggered(promptName, index, stageName, promptType) {
            console.log(`[Collection] 乱序模式Prompt触发: ${promptName}, index=${index}, type=${promptType}`);

            // 更新计数
            this.currentGestureIndex = index;
            this.gestureRepeatCount = 1;
            this.updateProgress();  // 【Bugfix】乱序模式下同步更新底部进度条

            // 获取原始手势名称（去除shuffle_前缀）
            const gesture = this.gestures[index];
            const gestureName = gesture?.id || gesture?.name || promptName;

            // 发送prompt信号到后端
            let finalPromptName = gestureName;
            if (promptType === 'start') {
                finalPromptName = `${gestureName}_start`;
            } else if (promptType === 'end') {
                finalPromptName = `${gestureName}_end`;
            }

            this.sendToRealtimeEngine('prompt', {
                name: finalPromptName,
                stageName: stageName,
                repeatIndex: index,
                promptType: promptType,
                timestamp: Date.now() / 1000
            });
        }

        /**
         * 【新增】乱序模式完成回调
         */
        onShuffleModeComplete() {
            console.log('[Collection] ★★★ 乱序模式采集完成 ★★★');

            // 隐藏手势GIF
            this.hideGestureGif();

            // 调用通用的完成处理
            this.onAllGesturesComplete();
        }


        showPreparation(callback) {
            // 【修改】支持准备时间随机范围
            let prepTime = this.currentExecutionParams.preparationTime || 3.0;
            const prepTimeMin = this.currentExecutionParams.preparationTimeMin;
            const prepTimeMax = this.currentExecutionParams.preparationTimeMax;

            // 如果配置了随机范围（最小值和最大值不同），则在范围内随机选择
            if (prepTimeMin !== undefined && prepTimeMax !== undefined && prepTimeMin !== prepTimeMax) {
                // 在 [min, max] 范围内随机选择，保留1位小数
                prepTime = Math.round((prepTimeMin + Math.random() * (prepTimeMax - prepTimeMin)) * 10) / 10;
                console.log(`[Collection] 准备时间随机: ${prepTime}秒 (范围: ${prepTimeMin}-${prepTimeMax}秒)`);
            } else if (prepTimeMin !== undefined && prepTimeMax !== undefined) {
                // 最小值=最大值，使用该值作为固定时间
                prepTime = prepTimeMin;
            }

            const currentStage = this.stages[this.currentStageIndex];

            this.updateGestureDisplay({
                name: '准备开始',
                instruction: currentStage?.instruction || `采集即将开始，请保持 ${currentStage?.name || ''} 姿势...`,
                showCountdown: true,
                countdownValue: prepTime
            });

            let countdown = prepTime;
            const countdownEl = document.getElementById('countdown');

            this.countdownTimer = setInterval(() => {
                countdown--;
                if (countdownEl) countdownEl.textContent = countdown;

                if (countdown <= 0) {
                    clearInterval(this.countdownTimer);
                    this.countdownTimer = null;
                    if (countdownEl) countdownEl.style.display = 'none';
                    callback();
                }
            }, 1000);
        }

        startNextGesture() {
            if (!this._isRunning || this._isPaused) return;

            if (this.currentGestureIndex >= this.gestures.length) {
                this.onAllGesturesComplete();
                return;
            }

            const gesture = this.gestures[this.currentGestureIndex];
            console.log(`[Collection] 开始手势: ${gesture.name} (${this.currentGestureIndex + 1}/${this.gestures.length})`);

            this.currentPhase = 'gesture';
            this.gestureRepeatCount = 0;

            this.updateProgress();
            this.updateGestureList();

            // 【新增】显示手势示范 GIF
            this.showGestureGif(gesture);

            if (window.discreteGestureAnimation) {
                // 【新增】乱序模式下，每个实例只执行一次
                let execParams = this.currentExecutionParams;
                if (this._shuffleMode && gesture._shuffled) {
                    // 创建执行参数副本，设置重复次数为1
                    execParams = {
                        ...this.currentExecutionParams,
                        repeatPerGesture: 1
                    };
                    console.log(`[Collection] 乱序模式: 实例 ${this.currentGestureIndex + 1}/${this.gestures.length}, 手势: ${gesture.name}`);
                } else if (this._isTestMode) {
                    // 【新增】测试模式下，顺序模式每个手势只执行2次
                    execParams = {
                        ...this.currentExecutionParams,
                        repeatPerGesture: 2
                    };
                    console.log(`[Collection] 测试模式(顺序): 手势 ${gesture.name} 只执行2次`);
                }

                window.discreteGestureAnimation.startGesture(gesture, execParams, () => {
                    this.onGestureAnimationComplete();
                });
            } else {
                this.doGestureRepeatSimple();
            }
        }

        onGestureAnimationComplete() {
            console.log(`[Collection] 手势 ${this.gestures[this.currentGestureIndex]?.name} 采集完成`);

            this.currentGestureIndex++;
            this.updateProgress();
            this.updateGestureList();

            if (this.currentGestureIndex >= this.gestures.length) {
                this.onAllGesturesComplete();
            } else {
                // 【新增】乱序模式下使用较短的间隔时间
                if (this._shuffleMode) {
                    this.showShortInterval(() => {
                        this.startNextGesture();
                    });
                } else {
                    this.showRestPeriod(() => {
                        this.startNextGesture();
                    });
                }
            }
        }

        /**
         * 【新增】乱序模式下的短间隔（使用intervalBetweenRepeat）
         */
        showShortInterval(callback) {
            const intervalTime = this.currentExecutionParams.intervalBetweenRepeat || 1.0;
            const nextGesture = this.gestures[this.currentGestureIndex];

            this.currentPhase = 'interval';

            // 如果间隔时间很短（<=1秒），直接继续不显示倒计时
            if (intervalTime <= 1) {
                setTimeout(() => {
                    callback();
                }, intervalTime * 1000);
                return;
            }

            // 显示短倒计时
            this.updateGestureDisplay({
                name: nextGesture?.name || '准备',
                instruction: `下一个: ${nextGesture?.icon || '✋'} ${nextGesture?.name || ''}`,
                showCountdown: true,
                countdownValue: Math.ceil(intervalTime)
            });

            let countdown = Math.ceil(intervalTime);
            const countdownEl = document.getElementById('countdown');
            if (countdownEl) {
                countdownEl.style.display = 'block';
                countdownEl.textContent = countdown;
            }

            this.countdownTimer = setInterval(() => {
                countdown--;
                if (countdownEl) countdownEl.textContent = countdown;

                if (countdown <= 0) {
                    clearInterval(this.countdownTimer);
                    this.countdownTimer = null;
                    if (countdownEl) countdownEl.style.display = 'none';
                    callback();
                }
            }, 1000);
        }

        doGestureRepeatSimple() {
            if (!this._isRunning || this._isPaused) return;
            
            const gesture = this.gestures[this.currentGestureIndex];
            const repeatMax = this.currentExecutionParams.repeatPerGesture;
            
            if (this.gestureRepeatCount >= repeatMax) {
                this.onGestureAnimationComplete();
                return;
            }
            
            this.gestureRepeatCount++;
            console.log(`[Collection] 手势 ${gesture.name} - 第 ${this.gestureRepeatCount}/${repeatMax} 次`);
            
            this.sendToRealtimeEngine('prompt', {
                name: gesture.id || gesture.name,
                stageName: this.stages[this.currentStageIndex]?.name || this.stages[this.currentStageIndex]?.id,
                timestamp: Date.now() / 1000  // 【修改】转换为秒，与ble_server时间戳一致
            });
            
            this.updateGestureDisplay({
                name: `${gesture.icon || '✋'} ${gesture.name}`,
                instruction: `请执行手势动作 (${this.gestureRepeatCount}/${repeatMax})`,
                showCountdown: false
            });
            
            this.updateGestureList();
            
            const displayTime = this.currentExecutionParams.gestureDisplayTime * 1000;
            const intervalTime = this.currentExecutionParams.intervalBetweenRepeat * 1000;
            
            this.phaseTimer = setTimeout(() => {
                this.updateGestureDisplay({
                    name: '准备下一次',
                    instruction: '...',
                    showCountdown: false
                });
                
                this.phaseTimer = setTimeout(() => {
                    this.doGestureRepeatSimple();
                }, intervalTime);
            }, displayTime);
        }

        showRestPeriod(callback) {
            const restTime = this.currentExecutionParams.restBetweenGestures;
            const nextGesture = this.gestures[this.currentGestureIndex];
            
            this.currentPhase = 'rest';
            this.gestureRepeatCount = 0;
            
            this.updateGestureList();
            
            this.updateGestureDisplay({
                name: '休息时间',
                instruction: `下一个手势: ${nextGesture?.icon || '✋'} ${nextGesture?.name || ''}`,
                showCountdown: true,
                countdownValue: restTime
            });
            
            let countdown = restTime;
            const countdownEl = document.getElementById('countdown');
            if (countdownEl) {
                countdownEl.style.display = 'block';
                countdownEl.textContent = countdown;
            }
            
            this.countdownTimer = setInterval(() => {
                if (this._isPaused) return;
                
                countdown--;
                if (countdownEl) countdownEl.textContent = countdown;
                
                if (countdown <= 0) {
                    clearInterval(this.countdownTimer);
                    this.countdownTimer = null;
                    if (countdownEl) countdownEl.style.display = 'none';
                    callback();
                }
            }, 1000);
        }

        async onAllGesturesComplete() {
            if (this._saveState === 'stopping') return;
            console.log('[Collection] ===== 当前Stage所有手势采集完成 =====');

            this.currentPhase = 'complete';

            // 【新增】隐藏手势示范 GIF
            this.hideGestureGif();

            // 【新增】重置乱序模式标志
            this._shuffleMode = false;

            const currentStage = this.stages[this.currentStageIndex];
            this.sendToRealtimeEngine('stage_end', {
                stageName: currentStage?.name || currentStage?.id
            });

            this._retrySave = () => this.onAllGesturesComplete();
            this._setSaveState('stopping');
            try {
                await this.sendToRealtimeEngineAndWait('collection_stop_and_wait', { completed: true });
            } catch (error) {
                this._setSaveState('save_failed', error.message);
                return;
            }
            this._retrySave = null;
            this._setSaveState('idle');

            this._isRunning = false;

            // 【Phase 2】resumed Stage 正常完成 → 清除断点状态
            this._clearBreakpointState();

            // 重新启用Session和Stage选择器
            const sessionSelect = document.getElementById('sessionSwitchSelect');
            if (sessionSelect) sessionSelect.disabled = false;
            const stageSelect = document.getElementById('stageSwitchSelect');
            if (stageSelect) stageSelect.disabled = false;

            this.updateControlButtons(false);
            this.updateNextStageButton();
            this.updateGestureList();
            this.updateStatus('采集完成');

            // 【修复 Issue 1 二次审核】先判断全部轮次模式，避免与 showRestCountdownAndContinue 重复切流
            if (this._isAllSessionsMode) {
                const hasMoreSessions = this.currentSessionIndex < this.sessionCount - 1;
                if (hasMoreSessions) {
                    // 还有更多轮次：showRestCountdownAndContinue 内部已处理 stream 切换
                    this.showRestCountdownAndContinue();
                    return;
                } else {
                    // 所有轮次完成 → 切回 preview
                    this._resumePreviewAfterCollection('stage_complete');
                    if (window.CameraControl && window.CameraControl.setVideoCollectionActive) {
                        window.CameraControl.setVideoCollectionActive(false, {
                            mode: 'all_sessions',
                            recordingSessionId: this._recordingSessionId,
                            sessionCount: this.sessionCount
                        });
                    }
                    this._isAllSessionsMode = false;

                    // 【修改】使用全屏弹窗显示完成信息
                    this.showSessionOverlay({
                        title: '全部轮次采集完成！',
                        subtitle: `已完成所有 ${this.sessionCount} 轮采集\n感谢您的配合！`,
                        icon: '🎉',
                        type: 'complete'
                    });

                    // 5秒后自动隐藏
                    setTimeout(() => {
                        this.hideSessionOverlay();
                    }, 5000);

                    this.updateGestureDisplay({
                        name: '🎉 全部轮次采集完成！',
                        instruction: `已完成所有 ${this.sessionCount} 轮采集`,
                        showCountdown: false
                    });
                    return;
                }
            }

            // 单轮模式：切回 preview + 显示正常完成信息
            this._resumePreviewAfterCollection('stage_complete');
            const hasMoreStages = this.currentStageIndex < this.stages.length - 1;
            const nextStageName = hasMoreStages ? this.stages[this.currentStageIndex + 1]?.name : '';

            this.updateGestureDisplay({
                name: '🎉 Stage采集完成！',
                instruction: hasMoreStages ?
                    `可以点击"进入下一Stage"继续采集: ${nextStageName}` :
                    '所有Stage已完成！',
                showCountdown: false
            });

            this.showToast('当前Stage采集完成！', 'success');
        }

        // ==================== 连续手势采集流程 ====================

        startContinualGestureCollection() {
            console.log('[Collection] 开始连续手势采集');
            console.log('[Collection] 任务类型:', this.currentTaskId);
            console.log('[Collection] ★★★ 执行参数 ★★★:', this.currentExecutionParams);

            const currentStage = this.stages[this.currentStageIndex];
            this.continualTrialCount = 0;

            // 【修改】每次采集前都重新标定（不使用缓存）
            const inputInterface = window.animationInputInterface;
            const needCalibration = this.calibrationEnabled !== false && inputInterface;

            if (needCalibration && !this.skipCalibration) {
                console.log('[Collection] 开始标定流程');
                // 重置标定状态，确保每次都重新标定
                if (inputInterface) {
                    inputInterface.resetCalibration(this.currentTaskId);
                }
                this.startCalibrationFlow();
            } else {
                console.log('[Collection] 跳过标定，直接开始采集');
                this.currentPhase = 'prepare';
                this.updateGestureList();

                this.showContinualPreparation(() => {
                    this.startContinualAnimation();
                });
            }
        }

        showContinualPreparation(callback) {
            const prepTime = this.currentExecutionParams.preparationTime || 3;
            const currentStage = this.stages[this.currentStageIndex];
            
            this.updateGestureDisplay({
                name: '准备开始',
                instruction: currentStage?.instruction || `即将开始光标移动任务，请准备...`,
                showCountdown: true,
                countdownValue: prepTime
            });
            
            let countdown = prepTime;
            const countdownEl = document.getElementById('countdown');
            
            this.countdownTimer = setInterval(() => {
                countdown--;
                if (countdownEl) countdownEl.textContent = countdown;
                
                if (countdown <= 0) {
                    clearInterval(this.countdownTimer);
                    this.countdownTimer = null;
                    if (countdownEl) countdownEl.style.display = 'none';
                    callback();
                }
            }, 1000);
        }

        /**
         * 【关键修复】启动连续手势动画 - 传递执行参数给动画模块
         */
        async startContinualAnimation() {
            console.log('[Collection] ====== 启动连续手势动画 ======');
            console.log('[Collection] 任务类型:', this.currentTaskId);
            console.log('[Collection] ★★★ trialsPerStage:', this.currentExecutionParams.trialsPerStage);

            const currentStage = this.stages[this.currentStageIndex];
            this.currentPhase = 'continual';

            this.updateGestureDisplay({
                name: '光标移动任务',
                instruction: '请通过滚轮移动光标到目标位置',
                showCountdown: false
            });

            this.updateGestureList();

            // 【新增】显示连续手势的 GIF 示范
            this.showContinualGestureGif();

            const stageConfig = {
                name: currentStage?.name || currentStage?.id || 'stage',
                label: currentStage?.name || 'Stage',
                instruction: currentStage?.instruction || '请将光标移动到目标区域'
            };
            
            let animationModule = null;
            if (this.currentTaskId === 'continual_gesture_1') {
                animationModule = window.continualGesture1Animation;
            } else if (this.currentTaskId === 'continual_gesture_2') {
                animationModule = window.continualGesture2Animation;
            }
            
            if (animationModule) {
                // 【关键修复】传递执行参数给动画模块的start函数
                // 【新增】测试模式下限制 trialsPerStage 为 2
                let execParams = this.currentExecutionParams;
                if (this._isTestMode) {
                    execParams = {
                        ...this.currentExecutionParams,
                        trialsPerStage: 2
                    };
                    console.log('[Collection] 测试模式: trialsPerStage 限制为 2');
                }
                console.log('[Collection] 传递执行参数给动画模块:', execParams);

                // 【修复】发送 stage_start 命令打开 H5 文件
                // 【新增】连续手势采集必须记录动捕数据，needMocap 始终为 true
                try {
                await this.sendToRealtimeEngineAndWait('stage_start', {
                    stageName: currentStage?.name || currentStage?.id,
                    stageIndex: this.currentStageIndex,
                    timestamp: Date.now() / 1000,
                    needMocap: true  // 【新增】连续手势必须记录动捕数据
                });
                } catch (error) {
                    this._retrySave = () => this.stopTask();
                    this._setSaveState('save_failed', error.message);
                    this.sendToRealtimeEngine('abnormal_interrupt_freeze', {});
                    return;
                }
                if (this._saveState === 'stopping' || this._saveState === 'save_failed') return;
                console.log(`[Collection] 连续手势 Stage "${currentStage?.name}" needMocap: true (强制)`);

                this.setupContinualProgressUpdater(animationModule);

                // 调用start时传入executionParams
                animationModule.start(
                    stageConfig,
                    () => {
                        this.onContinualAnimationComplete();
                    },
                    (trialIndex) => {
                        this.onContinualTrialComplete(trialIndex);
                    },
                    execParams  // 【修改】使用可能被测试模式修改的参数
                );

                console.log('[Collection] 连续手势动画已启动');
                console.log('[Collection] 确认 maxTrials =', animationModule.maxTrials);
            } else {
                console.error('[Collection] 未找到连续手势动画模块:', this.currentTaskId);
                this.showToast('动画模块未加载', 'error');
                this.stopTask();
            }

            this.updateStatus('采集中');
        }

        setupContinualProgressUpdater(animationModule) {
            this.continualProgressTimer = setInterval(() => {
                if (this._isRunning && animationModule.isAnimationRunning()) {
                    this.updateGestureList();
                } else {
                    clearInterval(this.continualProgressTimer);
                    this.continualProgressTimer = null;
                }
            }, 500);
        }

        onContinualTrialComplete(trialIndex) {
            this.continualTrialCount = trialIndex + 1;
            console.log(`[Collection] 试次完成: ${this.continualTrialCount}`);
            
            this.sendToRealtimeEngine('trial_complete', {
                trialIndex: trialIndex,
                stageName: this.stages[this.currentStageIndex]?.name
            });
            
            this.updateGestureList();
        }

        onContinualAnimationComplete() {
            console.log('[Collection] 连续手势动画完成');
            
            if (this.continualProgressTimer) {
                clearInterval(this.continualProgressTimer);
                this.continualProgressTimer = null;
            }
            
            this.onContinualStageComplete();
        }

        async onContinualStageComplete() {
            if (this._saveState === 'stopping') return;
            console.log('[Collection] 连续手势Stage完成');

            // 【新增】隐藏手势示范 GIF
            this.hideGestureGif();

            const currentStage = this.stages[this.currentStageIndex];
            this.sendToRealtimeEngine('stage_end', {
                stageName: currentStage?.name || currentStage?.id
            });

            this._retrySave = () => this.onContinualStageComplete();
            this._setSaveState('stopping');
            try {
                await this.sendToRealtimeEngineAndWait('collection_stop_and_wait', { completed: true });
            } catch (error) {
                this._setSaveState('save_failed', error.message);
                return;
            }
            this._retrySave = null;
            this._setSaveState('idle');

            if (this.currentStageIndex < this.stages.length - 1) {
                this.updateGestureDisplay({
                    name: 'Stage完成',
                    instruction: '可以点击开始进行下一个Stage',
                    showCountdown: false
                });
            }

            this._isRunning = false;

            // 【Phase 2】resumed Stage 完成 → 清除断点状态
            this._clearBreakpointState();

            // 重新启用Session和Stage选择器
            const sessionSelect = document.getElementById('sessionSwitchSelect');
            if (sessionSelect) sessionSelect.disabled = false;
            const stageSelect = document.getElementById('stageSwitchSelect');
            if (stageSelect) stageSelect.disabled = false;

            this.updateControlButtons(false);
            this.updateNextStageButton();
            this.updateGestureList();
            this.updateStatus('采集完成');

            // 【修复 Issue 1 二次审核】先判断全部轮次模式，避免与 showRestCountdownAndContinue 重复切流
            if (this._isAllSessionsMode) {
                const hasMoreSessions = this.currentSessionIndex < this.sessionCount - 1;
                if (hasMoreSessions) {
                    // 还有更多轮次：showRestCountdownAndContinue 内部已处理 stream 切换
                    this.showRestCountdownAndContinue();
                    return;
                } else {
                    // 所有轮次完成 → 切回 preview
                    this._resumePreviewAfterCollection('stage_complete');
                    if (window.CameraControl && window.CameraControl.setVideoCollectionActive) {
                        window.CameraControl.setVideoCollectionActive(false, {
                            mode: 'all_sessions',
                            recordingSessionId: this._recordingSessionId,
                            sessionCount: this.sessionCount
                        });
                    }
                    this._isAllSessionsMode = false;

                    // 使用全屏弹窗显示完成信息
                    this.showSessionOverlay({
                        title: '全部轮次采集完成！',
                        subtitle: `已完成所有 ${this.sessionCount} 轮采集\n感谢您的配合！`,
                        icon: '🎉',
                        type: 'complete'
                    });

                    // 5秒后自动隐藏
                    setTimeout(() => {
                        this.hideSessionOverlay();
                    }, 5000);

                    this.updateGestureDisplay({
                        name: '🎉 全部轮次采集完成！',
                        instruction: `已完成所有 ${this.sessionCount} 轮采集`,
                        showCountdown: false
                    });
                    return;
                }
            }

            // 单轮模式：切回 preview + 显示正常完成信息
            this._resumePreviewAfterCollection('stage_complete');
            const hasMoreStages = this.currentStageIndex < this.stages.length - 1;
            const nextStageName = hasMoreStages ? this.stages[this.currentStageIndex + 1]?.name : '';

            this.updateGestureDisplay({
                name: '🎉 Stage采集完成！',
                instruction: hasMoreStages ?
                    `可以点击"进入下一Stage"继续采集: ${nextStageName}` :
                    '所有Stage已完成！',
                showCountdown: false
            });

            this.showToast('当前Stage采集完成！', 'success');
        }

        // ==================== WebSocket通信 ====================

        _setSaveState(state, error = '') {
            this._saveState = state;
            if (state === 'stopping' || state === 'save_failed') {
                for (const name of ['phaseTimer', 'countdownTimer', 'continualProgressTimer', 'calibrationTimer']) {
                    if (this[name]) { clearTimeout(this[name]); clearInterval(this[name]); this[name] = null; }
                }
                for (const name of ['discreteGestureAnimation', 'continualGesture1Animation', 'continualGesture2Animation']) {
                    window[name]?.stop?.();
                }
            }
            const locked = state === 'stopping' || state === 'save_failed';
            for (const id of ['startTaskBtn', 'testModeBtn', 'startAllSessionsBtn', 'sessionSwitchSelect', 'stageSwitchSelect']) {
                const el = document.getElementById(id);
                if (el) el.disabled = locked;
            }
            const stop = document.getElementById('stopTaskBtn');
            if (stop) {
                stop.disabled = state === 'stopping';
                stop.textContent = state === 'save_failed' ? '重试保存' : '停止';
                let recover = document.getElementById('finalizeIncompleteBtn');
                if (!recover && stop.parentNode) {
                    recover = document.createElement('button');
                    recover.id = 'finalizeIncompleteBtn';
                    recover.className = stop.className;
                    recover.textContent = '保留为不完整采集并结束';
                    recover.addEventListener('click', () => this.finalizeIncomplete());
                    stop.parentNode.appendChild(recover);
                }
                if (recover) recover.hidden = state !== 'save_failed';
            }
            if (state === 'stopping') this.updateStatus('正在保存，请等待');
            if (state === 'save_failed') {
                this.updateStatus('保存失败，可重试');
                this.showToast(error || '保存未完成', 'error');
            }
        }

        async finalizeIncomplete() {
            if (this._saveState !== 'save_failed') return;
            this._setSaveState('stopping');
            try {
                await this.sendToRealtimeEngineAndWait('finalize_incomplete', { reason: '操作员选择保留为不完整采集' });
                this._isRunning = false;
                this._retrySave = null;
                this._setSaveState('idle');
                this.cancelAllSessionsMode();
                this.updateControlButtons(false);
                this.updateStatus('已保留不完整采集');
                if (window.BleControl?.isConnected) await window.BleControl.stopCollectionStream();
            } catch (error) {
                this._setSaveState('save_failed', error.message);
            }
        }

        sendToRealtimeEngine(action, data) {
            console.log(`[Collection] >>> realtimeEngine: ${action}`, data);
            
            const ws = this.getWebSocket();
            
            if (ws && ws.readyState === WebSocket.OPEN) {
                const message = JSON.stringify({
                    type: 'control_command',
                    action: action,
                    data: data,
                    timestamp: Date.now() / 1000  // 【修改】转换为秒，与ble_server时间戳一致
                });
                ws.send(message);
            }
        }

        sendToRealtimeEngineAndWait(action, data, timeoutMs = null) {
            timeoutMs = timeoutMs ?? (['collection_stop_and_wait', 'abnormal_interrupt', 'finalize_incomplete'].includes(action) ? 3780000 : 60000);
            console.log(`[Collection] >>> realtimeEngine(wait): ${action}`, data);

            const ws = this.getWebSocket();
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                return Promise.reject(new Error('realtimeEngine WebSocket 未连接'));
            }

            const commandId = `${action}_${Date.now()}_${Math.random().toString(16).slice(2)}`;

            return new Promise((resolve, reject) => {
                const cleanup = () => {
                    clearTimeout(timer);
                    ws.removeEventListener('message', onMessage);
                    ws.removeEventListener('close', onDisconnect);
                    ws.removeEventListener('error', onDisconnect);
                };

                const onDisconnect = () => {
                    cleanup();
                    reject(new Error('采集服务连接已断开，保存结果待核对'));
                };
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new Error(`${action} 等待响应超时`));
                }, timeoutMs);

                const onMessage = (event) => {
                    let packet = null;
                    try {
                        packet = JSON.parse(event.data);
                    } catch (err) {
                        return;
                    }

                    if (packet.type !== 'control_response' || packet.commandId !== commandId) {
                        return;
                    }

                    cleanup();
                    if (packet.status === 'success') {
                        resolve(packet.result);
                    } else {
                        reject(new Error(packet.error || `${action} 执行失败`));
                    }
                };

                ws.addEventListener('message', onMessage);
                ws.addEventListener('close', onDisconnect);
                ws.addEventListener('error', onDisconnect);
                try { ws.send(JSON.stringify({
                    type: 'control_command',
                    action,
                    data,
                    commandId,
                    timestamp: Date.now() / 1000
                })); } catch (error) { cleanup(); reject(error); }
            });
        }

        getWebSocket() {
            if (window.waveformController?.dataReceiver?.ws) {
                const socket = window.waveformController.dataReceiver.ws;
                if (this._collectionSocket !== socket) {
                    if (this._collectionSocket && this._collectionFaultListener) {
                        this._collectionSocket.removeEventListener('message', this._collectionFaultListener);
                    }
                    this._collectionSocket = socket;
                    this._collectionFaultListener = event => {
                        let packet;
                        try { packet = JSON.parse(event.data); } catch (_) { return; }
                        if (packet.type === 'collection_fault') {
                            this._retrySave = () => this.stopTask({ retrying: true });
                            this._setSaveState('save_failed', packet.error);
                        }
                    };
                    socket.addEventListener('message', this._collectionFaultListener);
                }
                return socket;
            }
            return null;
        }

        // ==================== UI更新 ====================

        updateGestureDisplay({ name, instruction, showCountdown, countdownValue }) {
            const gestureNameEl = document.getElementById('gestureName');
            const gestureInstructionEl = document.getElementById('gestureInstruction');
            const countdownEl = document.getElementById('countdown');
            const gestureIcon = document.getElementById('gestureIcon');
            
            if (gestureIcon?.parentElement) {
                gestureIcon.parentElement.style.display = 'none';
            }
            
            if (gestureNameEl) gestureNameEl.textContent = name || '';
            if (gestureInstructionEl) gestureInstructionEl.textContent = instruction || '';
            
            if (countdownEl) {
                countdownEl.style.display = showCountdown ? 'block' : 'none';
                if (showCountdown && countdownValue !== undefined) {
                    countdownEl.textContent = countdownValue;
                }
            }
        }

        /**
         * 【修复 Issue 2】获取有效的 session_id。
         * 优先级：页面上 sessionIdInput > collectionConfig.subject.id > localStorage user id > 默认
         */
        _getEffectiveSessionId() {
            // 1. 页面上的 session ID 输入框
            const sessionIdInput = document.getElementById('sessionIdInput');
            if (sessionIdInput && sessionIdInput.value.trim()) {
                return sessionIdInput.value.trim();
            }
            // 2. 采集配置中的受试者 ID
            if (this.collectionConfig?.subject?.id) {
                return this.collectionConfig.subject.id;
            }
            // 3. localStorage 中的用户 ID
            const userData = JSON.parse(localStorage.getItem('emg_current_user') || '{}');
            if (userData.id) {
                return userData.id;
            }
            // 4. 默认
            return `S${Date.now().toString().slice(-6)}`;
        }

        /**
         * 采集停止/轮次结束后，设备实际还在 BLE 切流收尾。
         * 先把状态栏从“采集中”切到“切换中”，避免工作人员误以为手环阻塞。
         */
        _showRingStreamTransition(targetMode = 'preview') {
            if (!window.deviceStatusWidget || !window.BleControl || !window.BleControl.devices) {
                return;
            }
            const text = targetMode === 'preview' ? '切回预览中' : '停止收尾中';
            [1, 2].forEach((deviceId) => {
                const dev = window.BleControl.devices[deviceId];
                if (dev && dev.connected && dev.stream_mode === 'collection') {
                    window.deviceStatusWidget.setStreamModeOverride(deviceId, 'transition', text);
                }
            });
        }

        /**
         * 【修复 Issue 4】正常完成 collection 后切回 preview stream。
         * 带防重入：同一 reason 在 5 秒内最多调用一次。
         */
        _resumePreviewAfterCollection(reason) {
            const now = Date.now();
            const lastCall = this._lastPreviewResumeCall || {};
            if (lastCall.reason === reason && (now - (lastCall.time || 0)) < 5000) {
                console.log(`[Collection] _resumePreviewAfterCollection("${reason}") 跳过（5s 内已调用）`);
                return;
            }
            this._lastPreviewResumeCall = { reason, time: now };

            if (!window.BleControl || !window.BleControl.isConnected) {
                console.log('[Collection] 设备未连接，跳过 preview 恢复');
                return;
            }
            if (this._switchInProgress) {
                console.log('[Collection] 切流进行中，跳过 preview 恢复');
                return;
            }

            console.log(`[Collection] 切回 preview stream (reason: ${reason})`);
            this._showRingStreamTransition('preview');
            // 延迟给 close H5 和 stop collection 一些时间
            setTimeout(() => {
                if (!this._switchInProgress && window.BleControl && window.BleControl.isConnected) {
                    window.BleControl.switchCollectionToPreview();
                }
            }, 800);
        }

        _setAllButtonsDisabled(disabled) {
            const startBtn = document.getElementById('startTaskBtn');
            const testBtn = document.getElementById('testModeBtn');
            const stopBtn = document.getElementById('stopTaskBtn');
            const abortBtn = document.getElementById('abortTaskBtn');
            const startAllBtn = document.getElementById('startAllSessionsBtn');
            if (startBtn) startBtn.disabled = disabled;
            if (testBtn) testBtn.disabled = disabled;
            if (stopBtn) stopBtn.disabled = disabled;
            if (abortBtn) abortBtn.disabled = disabled;
            if (startAllBtn) startAllBtn.disabled = disabled;
        }

        updateControlButtons(running) {
            if (['stopping', 'save_failed'].includes(this._saveState)) {
                this._setSaveState(this._saveState);
                return;
            }
            // 【新增】切流进行中时所有按钮已禁用，不覆盖
            if (this._switchInProgress) {
                return;
            }
            const startBtn = document.getElementById('startTaskBtn');
            const testBtn = document.getElementById('testModeBtn');
            const stopBtn = document.getElementById('stopTaskBtn');
            const abortBtn = document.getElementById('abortTaskBtn');
            const startAllBtn = document.getElementById('startAllSessionsBtn');

            // 【新增】检测是否有手环设备已连接
            const hasDevice = this._isAnyDeviceConnected();
            const noDeviceTip = '未连接手环设备，无法开始采集';

            if (this._isResumeMode && !running) {
                // 续采准备态：startTaskBtn 改为"开始续采"，全轮次/测试禁用
                if (startBtn) {
                    startBtn.innerHTML = '<i class="fas fa-redo-alt"></i> 开始续采';
                    startBtn.disabled = !hasDevice;
                    startBtn.title = hasDevice ? '' : noDeviceTip;
                }
                if (testBtn) testBtn.disabled = true;
                if (stopBtn) stopBtn.disabled = true;
                if (startAllBtn) {
                    startAllBtn.disabled = true;
                    startAllBtn.title = '';
                }
                // abortBtn 作为"放弃断点"
                if (abortBtn) {
                    abortBtn.innerHTML = '<i class="fas fa-times-circle"></i> 放弃断点';
                    abortBtn.style.background = '#9ca3af';
                    abortBtn.disabled = false;
                }
            } else {
                // 普通模式
                if (startBtn) {
                    startBtn.innerHTML = '<i class="fas fa-play"></i> 开始采集（单个轮次）';
                    startBtn.disabled = running || !hasDevice;
                    startBtn.title = (!hasDevice && !running) ? noDeviceTip : '';
                }
                if (testBtn) {
                    testBtn.disabled = running;
                    testBtn.title = '';
                }
                if (stopBtn) stopBtn.disabled = !running;
                if (startAllBtn) {
                    startAllBtn.disabled = running || !hasDevice;
                    startAllBtn.title = (!hasDevice && !running) ? noDeviceTip : '';
                }
                if (abortBtn) {
                    abortBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> 异常中断';
                    abortBtn.style.background = '#f97316';
                    abortBtn.disabled = !running || this._isTestMode;
                }
            }
        }

        /**
         * 【新增】检查是否有手环设备已连接
         */
        _isAnyDeviceConnected() {
            // 优先通过 BleControl 检查
            if (window.BleControl && window.BleControl.devices) {
                const dev1 = window.BleControl.devices[1];
                const dev2 = window.BleControl.devices[2];
                if ((dev1 && dev1.connected) || (dev2 && dev2.connected)) {
                    return true;
                }
            }
            // 备用：通过 deviceStatusWidget 检查
            if (window.deviceStatusWidget) {
                const w = window.deviceStatusWidget;
                if (w.device1Status?.connected || w.device2Status?.connected) {
                    return true;
                }
            }
            return false;
        }

        updateStatus(text) {
            const statusText = document.getElementById('statusText');
            const statusDot = document.getElementById('statusDot');

            if (statusText) statusText.textContent = text;
            if (statusDot) {
                let dotClass = 'idle';
                if (this._isRunning) {
                    dotClass = this._isPaused ? 'idle' : 'recording';
                }
                statusDot.className = 'status-dot ' + dotClass;
            }
        }

        updateProgress() {
            const total = this.gestures.length;
            const current = this.currentGestureIndex;
            // 1-based 显示，与 labjs 动画右下角进度一致
            const displayCurrent = Math.min(current + 1, total);
            const percent = total > 0 ? (displayCurrent / total) * 100 : 0;

            const progressFill = document.getElementById('progressFill');
            const progressText = document.getElementById('progressText');
            const phaseLabel = document.getElementById('shufflePhaseLabel');

            if (progressFill) progressFill.style.width = `${percent}%`;
            if (progressText) {
                progressText.textContent = `${displayCurrent} / ${total} 手势`;
            }

            // 乱序模式：显示阶段标签 + 变色
            if (phaseLabel) {
                if (this._shuffleMode && this._isRunning && current < total) {
                    const gesture = this.gestures[current];
                    const segment = gesture?._shuffleSegment;
                    if (segment === 'ordered') {
                        phaseLabel.textContent = '顺序';
                        phaseLabel.className = 'shuffle-phase-label visible phase-ordered';
                        if (progressFill) {
                            progressFill.style.background = 'linear-gradient(90deg, #0d9488 0%, #14b8a6 100%)';
                        }
                    } else if (segment === 'shuffled') {
                        phaseLabel.textContent = '乱序';
                        phaseLabel.className = 'shuffle-phase-label visible phase-shuffled';
                        if (progressFill) {
                            progressFill.style.background = 'linear-gradient(90deg, #ef4444 0%, #dc2626 100%)';
                        }
                    } else {
                        phaseLabel.className = 'shuffle-phase-label';
                        phaseLabel.textContent = '';
                        if (progressFill) {
                            progressFill.style.background = '';
                        }
                    }
                } else {
                    phaseLabel.className = 'shuffle-phase-label';
                    phaseLabel.textContent = '';
                    if (progressFill) {
                        progressFill.style.background = '';
                    }
                }
            }
        }

        resetDisplay() {
            const gestureNameEl = document.getElementById('gestureName');
            const gestureInstructionEl = document.getElementById('gestureInstruction');
            const gestureIcon = document.getElementById('gestureIcon');
            const progressFill = document.getElementById('progressFill');
            const progressText = document.getElementById('progressText');
            const countdownEl = document.getElementById('countdown');
            const phaseLabel = document.getElementById('shufflePhaseLabel');

            const hasDevice = this._isAnyDeviceConnected();

            if (gestureNameEl) {
                gestureNameEl.textContent = hasDevice ? '准备就绪' : '未连接设备';
            }
            if (gestureInstructionEl) {
                gestureInstructionEl.textContent = this._getContextualHint(hasDevice);
            }
            if (gestureIcon?.parentElement) gestureIcon.parentElement.style.display = '';
            if (progressFill) {
                progressFill.style.width = '0%';
                progressFill.style.background = '';
            }
            if (progressText) progressText.textContent = `0 / ${this.gestures.length} 手势`;

            if (phaseLabel) {
                phaseLabel.className = 'shuffle-phase-label';
                phaseLabel.textContent = '';
            }

            if (countdownEl) countdownEl.style.display = 'none';

            this.updateStatus(hasDevice ? '准备就绪' : '未连接设备');
        }

        /**
         * 【新增】根据设备连接状态返回引导提示文案
         */
        _getContextualHint(hasDevice) {
            if (!hasDevice) {
                return '当前没有连接手环，无法采集数据，请退出并重新连接手环';
            }

            if (this._isResumeMode) {
                const stageName = this.stages[this.currentStageIndex]?.name || '';
                return `断点续采模式 — 当前Stage: ${stageName}，点击「开始续采」继续采集`;
            }

            const stageName = this.stages[this.currentStageIndex]?.name || '';
            if (this.stages.length > 1) {
                return `当前Stage: ${stageName}，选择对应Stage后点击「开始采集（全部轮次）」`;
            }
            return `当前Stage: ${stageName}，点击「开始采集（全部轮次）」开始采集`;
        }

        showToast(message, type = 'info') {
            const toast = document.getElementById('toast');
            if (!toast) return;

            // 确保 #toastMessage 存在（可能被其他模块的 innerHTML 销毁）
            let msgEl = document.getElementById('toastMessage');
            let iconEl = toast.querySelector('i');
            if (!msgEl || !iconEl) {
                toast.innerHTML = '<i class="fas fa-check-circle"></i> <span id="toastMessage"></span>';
                msgEl = document.getElementById('toastMessage');
                iconEl = toast.querySelector('i');
            }

            const iconMap = { success: 'check-circle', error: 'times-circle', warning: 'exclamation-triangle', info: 'info-circle' };
            const icon = iconMap[type] || 'info-circle';
            toast.className = `toast ${type}`;
            iconEl.className = `fas fa-${icon}`;
            msgEl.textContent = message;
            toast.classList.add('visible');
            setTimeout(() => toast.classList.remove('visible'), 3000);
        }

        // ==================== 全屏Session提示弹窗 ====================

        /**
         * 【新增】显示全屏居中的Session提示弹窗
         * @param {Object} options - 配置选项
         * @param {string} options.title - 标题
         * @param {string} options.subtitle - 副标题
         * @param {string} options.icon - 图标（emoji）
         * @param {number} options.countdown - 倒计时秒数（可选）
         * @param {string} options.type - 类型：'rest' | 'start' | 'complete'
         */
        showSessionOverlay(options) {
            const { title, subtitle, icon = '⏸️', countdown, type = 'rest' } = options;

            // 移除已存在的弹窗
            this.hideSessionOverlay();

            // 根据类型选择颜色
            const colorMap = {
                'rest': { bg: '#3b82f6', light: '#dbeafe' },
                'start': { bg: '#22c55e', light: '#dcfce7' },
                'complete': { bg: '#f59e0b', light: '#fef3c7' }
            };
            const colors = colorMap[type] || colorMap.rest;

            // 创建全屏遮罩和弹窗
            const overlay = document.createElement('div');
            overlay.id = 'sessionOverlay';
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                animation: fadeIn 0.3s ease;
            `;

            overlay.innerHTML = `
                <style>
                    @keyframes fadeIn {
                        from { opacity: 0; }
                        to { opacity: 1; }
                    }
                    @keyframes scaleIn {
                        from { transform: scale(0.8); opacity: 0; }
                        to { transform: scale(1); opacity: 1; }
                    }
                    @keyframes pulse {
                        0%, 100% { transform: scale(1); }
                        50% { transform: scale(1.05); }
                    }
                </style>
                <div id="sessionOverlayPanel" style="
                    background: white;
                    border-radius: 24px;
                    padding: 48px 64px;
                    text-align: center;
                    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
                    min-width: 500px;
                    max-width: 700px;
                    animation: scaleIn 0.3s ease;
                ">
                    <!-- 图标 -->
                    <div style="
                        font-size: 80px;
                        margin-bottom: 24px;
                        animation: pulse 2s infinite;
                    ">${icon}</div>

                    <!-- 标题 -->
                    <div style="
                        font-size: 42px;
                        font-weight: 700;
                        color: ${colors.bg};
                        margin-bottom: 16px;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    ">${title}</div>

                    <!-- 副标题 -->
                    <div style="
                        font-size: 24px;
                        color: #6b7280;
                        margin-bottom: 32px;
                        line-height: 1.5;
                    ">${subtitle}</div>

                    <!-- 倒计时（如果有） -->
                    ${countdown !== undefined ? `
                    <div style="
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 16px;
                        padding: 24px;
                        background: ${colors.light};
                        border-radius: 16px;
                    ">
                        <span style="font-size: 20px; color: #6b7280;">倒计时</span>
                        <span id="sessionOverlayCountdown" style="
                            font-size: 72px;
                            font-weight: 800;
                            color: ${colors.bg};
                            min-width: 100px;
                            line-height: 1;
                        ">${countdown}</span>
                        <span style="font-size: 24px; color: #6b7280;">秒</span>
                    </div>
                    ` : ''}

                    <!-- 进度条（如果有倒计时） -->
                    ${countdown !== undefined ? `
                    <div style="
                        margin-top: 24px;
                        background: #e5e7eb;
                        border-radius: 8px;
                        height: 8px;
                        overflow: hidden;
                    ">
                        <div id="sessionOverlayProgress" style="
                            height: 100%;
                            background: linear-gradient(90deg, ${colors.bg}, ${colors.bg}88);
                            border-radius: 8px;
                            width: 100%;
                            transition: width 1s linear;
                        "></div>
                    </div>
                    ` : ''}
                </div>
            `;

            document.body.appendChild(overlay);
        }

        /**
         * 【新增】更新Session弹窗的倒计时
         * @param {number} seconds - 剩余秒数
         * @param {number} total - 总秒数
         */
        updateSessionOverlayCountdown(seconds, total) {
            const countdownEl = document.getElementById('sessionOverlayCountdown');
            const progressEl = document.getElementById('sessionOverlayProgress');

            if (countdownEl) {
                countdownEl.textContent = seconds;
                // 最后3秒变红色
                if (seconds <= 3) {
                    countdownEl.style.color = '#ef4444';
                }
            }

            if (progressEl && total > 0) {
                const percent = (seconds / total) * 100;
                progressEl.style.width = `${percent}%`;
            }
        }

        /**
         * 【新增】隐藏Session弹窗
         */
        hideSessionOverlay() {
            const overlay = document.getElementById('sessionOverlay');
            if (overlay) {
                overlay.remove();
            }
        }

        // ==================== GIF 手势示范 ====================

        /**
         * 获取当前任务类型对应的 GIF 目录
         */
        getGifDirectory() {
            const dirMap = {
                'discrete_gesture': 'discrete',
                'continual_gesture_1': 'continual_1',
                'continual_gesture_2': 'continual_2'
            };
            return dirMap[this.currentTaskId] || 'discrete';
        }

        /**
         * 显示手势示范 GIF
         * @param {Object} gesture - 手势对象，包含 gifFile 字段
         */
        showGestureGif(gesture) {
            const container = document.getElementById('gestureGifContainer');
            const image = document.getElementById('gestureGifImage');
            const placeholder = document.getElementById('gestureGifPlaceholder');

            if (!container || !image || !placeholder) {
                console.warn('[Collection] GIF 显示元素未找到');
                return;
            }

            // 获取 GIF 文件路径
            const gifFile = gesture?.gifFile;
            if (!gifFile) {
                // 没有配置 GIF 文件，显示占位符
                image.classList.remove('loaded');
                placeholder.classList.remove('hidden');
                placeholder.querySelector('span').textContent = gesture?.name || '无示范';
                container.classList.add('active');
                console.log('[Collection] 手势无 GIF 配置:', gesture?.name);
                return;
            }

            const gifDir = this.getGifDirectory();
            const gifPath = `tutorial/gestures/${gifDir}/${gifFile}`;

            console.log('[Collection] 显示 GIF:', gifPath);

            // 加载 GIF
            image.onload = () => {
                image.classList.add('loaded');
                placeholder.classList.add('hidden');
            };

            image.onerror = () => {
                console.warn('[Collection] GIF 加载失败:', gifPath);
                image.classList.remove('loaded');
                placeholder.classList.remove('hidden');
                placeholder.querySelector('span').textContent = '加载失败';
            };

            image.src = gifPath;
            container.classList.add('active');
        }

        /**
         * 隐藏手势示范 GIF
         */
        hideGestureGif() {
            const container = document.getElementById('gestureGifContainer');
            const image = document.getElementById('gestureGifImage');

            if (container) {
                container.classList.remove('active');
            }

            if (image) {
                image.classList.remove('loaded');
                image.src = '';
            }

            console.log('[Collection] 隐藏 GIF 显示');
        }

        /**
         * 显示连续手势的 GIF 示范
         * 连续手势每个任务类型只有一个 GIF
         */
        showContinualGestureGif() {
            // 任务ID到手势配置key的映射
            const gestureKeyMap = {
                'continual_gesture_1': 'continual_1',
                'continual_gesture_2': 'continual_2',
                'continual_gesture_3': 'continual_3'
            };

            const gestureKey = gestureKeyMap[this.currentTaskId];
            if (!gestureKey) {
                console.log('[Collection] 非连续手势任务，跳过 GIF 显示');
                return;
            }

            // 从 collectionConfig 中获取连续手势的 GIF 配置
            const gestureConfig = this.collectionConfig?.gestures?.[gestureKey];

            if (gestureConfig && gestureConfig.length > 0 && gestureConfig[0].gifFile) {
                console.log('[Collection] 显示连续手势 GIF:', gestureKey, gestureConfig[0].gifFile);
                this.showGestureGif(gestureConfig[0]);
            } else {
                // 尝试从 template 中读取
                const template = this.getLatestTemplate();
                const templateGesture = template?.gestures?.[gestureKey];

                if (templateGesture && templateGesture.length > 0 && templateGesture[0].gifFile) {
                    console.log('[Collection] 从 template 显示连续手势 GIF:', gestureKey, templateGesture[0].gifFile);
                    this.showGestureGif(templateGesture[0]);
                } else {
                    console.log('[Collection] 连续手势无 GIF 配置:', gestureKey);
                }
            }
        }

        // ==================== 外部接口 ====================

        selectTask(htmlTaskId) {
            const selectedTaskId = this._normalizeTaskId(htmlTaskId);
            this.currentTaskId = selectedTaskId;
            console.log('[Collection] 设置任务类型:', this.currentTaskId);

            // 【修复】重新选择任务时清空采集进度
            this.currentSessionIndex = 0;
            this.currentStageIndex = 0;
            this.currentGestureIndex = 0;
            this.gestureRepeatCount = 0;
            this.continualTrialCount = 0;

            // 重新加载配置
            this.loadCollectionConfig({ preferredTaskId: selectedTaskId });
            this._syncCollectionConfigTask(selectedTaskId);
            this._applyTaskDefaultStage();
            this.sendToRealtimeEngine('task_change', { taskId: this.currentTaskId });

            if (window.animationController) {
                window.animationController.setCurrentTask(this.currentTaskId);
            }

            // 重置动画模块
            this.resetAnimationModules();

            this.updateUI();
        }

        getCurrentTaskId() {
            return this.currentTaskId;
        }

        getCurrentExecutionParams() {
            return this.currentExecutionParams;
        }

        // ==================== 断点续采（Phase 2） ====================

        /**
         * 【Phase 2】从断点状态恢复采集进度
         *
         * @param {Object} state - localStorage emg_breakpoint_state 解析后的对象
         */
        loadBreakpointState(state) {
            console.log('[Collection] ===== loadBreakpointState 开始恢复 =====');
            console.log('[Collection] 断点状态:', state);

            // 校验
            if (!state || state.status !== 'abnormal_interrupted') {
                console.error('[Collection] 无效的断点状态');
                this.showToast('断点状态无效，无法恢复', 'error');
                return;
            }

            // ---- 恢复采集配置 ----
            this.collectionConfig = state.collectionConfig;
            this.currentTaskId = state.currentTaskId;

            // ---- 恢复进度 ----
            this.currentSessionIndex = state.currentSessionIndex ?? 0;
            this.currentStageIndex = state.currentStageIndex ?? 0;
            this.currentGestureIndex = state.currentGestureIndex ?? 0;
            this.gestureRepeatCount = state.gestureRepeatCount ?? 0;
            this.continualTrialCount = state.continualTrialCount ?? 0;
            this.currentPhase = state.currentPhase || null;
            this._shuffleMode = state._shuffleMode || false;
            this.sessionCount = state.sessionCount || 3;
            this._isAllSessionsMode = state.isAllSessionsMode || false;

            // ---- 恢复 stages ----
            if (state.stages && state.stages.length > 0) {
                this.stages = state.stages;
            }

            // ---- 恢复手势库（优先使用快照）----
            if (state.gesturesSnapshot && state.gesturesSnapshot.length > 0) {
                // 乱序模式下 gesturesSnapshot 保留了打乱后的完整序列
                this.gestures = state.gesturesSnapshot;
                console.log('[Collection] 从快照恢复手势库:', this.gestures.length, '个');
            } else {
                // 无快照时重新加载
                this.loadGesturesForCurrentStage();
                console.log('[Collection] 无快照，重新加载手势库:', this.gestures.length, '个');
            }

            // ---- 恢复 recordingSessionId ----
            this._recordingSessionId = state.recordingSessionId || null;

            // ---- 设置续采模式标志 ----
            this._isResumeMode = true;
            this._resumeState = state;
            // segment_index 自动递增（第一个续采 segment = 2）
            this._resumeSegmentIndex = (state.segmentIndex || 1) + 1;

            console.log('[Collection] 恢复结果:');
            console.log('  taskId:', this.currentTaskId);
            console.log('  session:', this.currentSessionIndex + 1, '/', this.sessionCount);
            console.log('  stage:', this.currentStageIndex, this.stages[this.currentStageIndex]?.name);
            console.log('  gestureIndex:', this.currentGestureIndex, '/', this.gestures.length);
            console.log('  repeatCount:', this.gestureRepeatCount);
            console.log('  trialCount:', this.continualTrialCount);
            console.log('  shuffleMode:', this._shuffleMode);
            console.log('  resumeSegmentIndex:', this._resumeSegmentIndex);

            // ---- 恢复UI ----
            this.updateSessionSelect();
            this.updateStageSelect();
            this.updateGestureList();
            this.updateNextStageButton();
            this.updateControlButtons(false);
            this.updateStatus('就绪（续采模式）');

            this.showToast(`已恢复断点: 第 ${this.currentSessionIndex + 1} 轮 ${this.stages[this.currentStageIndex]?.name || ''}`, 'success');

            // Phase 2 限制提示：连续手势只能恢复到 stage 级别
            if (this.currentTaskId !== 'discrete_gesture' && this.continualTrialCount > 0) {
                console.warn('[Collection] ⚠️ 连续手势续采限制：动画将从 trial 0 重新开始');
                console.warn('[Collection] 已恢复的 trialCount:', this.continualTrialCount);
                console.warn('[Collection] Phase 2 仅恢复计数，动画模块不支持从 trialIndex 开始');
                this.showToast('注意：连续手势将从当前Stage重新开始', 'warning');
            }

            // ---- UX fix: 更新续采准备态 UI ----
            this._updateResumeReadyUI();
        }

        /**
         * 【UX fix】更新续采准备态 UI
         * - startTaskBtn 文案改为"开始续采"
         * - startAllSessionsBtn / testModeBtn 禁用
         * - 显示"取消续采"按钮
         * - 更新状态文本
         */
        _updateResumeReadyUI() {
            // 按钮文案
            const startBtn = document.getElementById('startTaskBtn');
            if (startBtn) {
                startBtn.innerHTML = '<i class="fas fa-redo-alt"></i> 开始续采';
                startBtn.disabled = false;
            }

            // 全轮次/测试按钮禁用
            const startAllBtn = document.getElementById('startAllSessionsBtn');
            if (startAllBtn) startAllBtn.disabled = true;
            const testBtn = document.getElementById('testModeBtn');
            if (testBtn) testBtn.disabled = true;

            // 显示放弃断点按钮
            const abortBtn = document.getElementById('abortTaskBtn');
            if (abortBtn) {
                abortBtn.innerHTML = '<i class="fas fa-times-circle"></i> 放弃断点';
                abortBtn.style.background = '#9ca3af';
                abortBtn.disabled = false;
            }

            // 更新状态显示
            const stageName = this.stages[this.currentStageIndex]?.name || '未知';
            this.updateStatus(`续采就绪 | 第 ${this.currentSessionIndex + 1}/${this.sessionCount} 轮 | ${stageName} | 手势 ${this.currentGestureIndex + 1}/${this.gestures.length}`);

            console.log('[Collection] 续采准备态 UI 已更新');
        }

        /**
         * 【UX fix】退出续采模式，恢复普通 UI
         * @param {Object} opts - {clearBreakpoint: boolean}
         */
        exitResumeMode(opts = {}) {
            const { clearBreakpoint = false } = opts;

            if (clearBreakpoint) {
                localStorage.removeItem('emg_breakpoint_state');
                localStorage.setItem('emg_breakpoint_exists', 'false');
                console.log('[Collection] 断点已清除');
            }

            this._isResumeMode = false;
            this._resumeState = null;
            this._resumeSegmentIndex = 1;

            // 恢复按钮文案和状态
            const startBtn = document.getElementById('startTaskBtn');
            if (startBtn) {
                startBtn.innerHTML = '<i class="fas fa-play"></i> 开始采集（单个轮次）';
                startBtn.disabled = false;
            }
            const startAllBtn = document.getElementById('startAllSessionsBtn');
            if (startAllBtn) startAllBtn.disabled = false;
            const testBtn = document.getElementById('testModeBtn');
            if (testBtn) testBtn.disabled = false;

            // 恢复异常中断按钮
            const abortBtn = document.getElementById('abortTaskBtn');
            if (abortBtn) {
                abortBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> 异常中断';
                abortBtn.style.background = '#f97316';
                abortBtn.disabled = true;
            }

            this.updateControlButtons(false);
            this.updateStatus('准备就绪');

            // 清除续采按钮一次性标记
            delete window.__showBreakpointResumeAfterAbort;

            console.log('[Collection] 已退出续采模式');
        }

        /**
         * 【UX fix】确认放弃断点
         */
        _confirmAbandonBreakpoint() {
            const stageName = this.stages[this.currentStageIndex]?.name || '未知';
            const confirmed = confirm(
                '确定要放弃断点吗？\n\n' +
                `中断任务: ${this.currentTaskId}\n` +
                `轮次: 第 ${this.currentSessionIndex + 1}/${this.sessionCount} 轮\n` +
                `Stage: ${stageName}\n` +
                `手势进度: 第 ${this.currentGestureIndex + 1}/${this.gestures.length} 个\n\n` +
                '放弃后断点将被清除，需重新开始新采集。'
            );

            if (!confirmed) {
                console.log('[Collection] 用户取消放弃断点');
                return;
            }

            console.log('[Collection] 确认放弃断点');
            this.exitResumeMode({ clearBreakpoint: true });
            this.showToast('断点已放弃', 'info');

            // 返回首页
            setTimeout(() => {
                if (window.pageSwitchController) {
                    window.pageSwitchController.showWelcome();
                }
            }, 300);
        }

        /**
         * 【Phase 2】清除断点状态（resumed Stage 正常完成后调用）
         */
        _clearBreakpointState() {
            if (!this._isResumeMode) return;
            console.log('[Collection] 清除断点状态...');
            // 使用 exitResumeMode 统一处理 UI 恢复 + localStorage 清除
            this.exitResumeMode({ clearBreakpoint: true });
        }

        // ==================== 录像同步相关方法 ====================

        /**
         * 生成录像会话ID
         * 格式: rec_YYYYMMDD_HHMMSS_N
         * @param {number} totalSessions - 总轮次数
         * @returns {string} 录像会话ID
         */
        _generateRecordingSessionId(totalSessions) {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            const seconds = String(now.getSeconds()).padStart(2, '0');

            return `rec_${year}${month}${day}_${hours}${minutes}${seconds}_${totalSessions}`;
        }

        /**
         * 初始化空格键监听器
         */
        _initSpaceKeyListener() {
            this._spaceKeyHandler = (e) => {
                // 只在启用状态下响应空格键
                if (!this._spaceKeyEnabled) return;

                // 检查是否是空格键
                if (e.code === 'Space' || e.key === ' ') {
                    // 防止页面滚动
                    e.preventDefault();

                    // 触发空格键同步信号
                    this._onSpaceKeyPressed();
                }
            };

            // 添加事件监听器
            document.addEventListener('keydown', this._spaceKeyHandler);
            console.log('[Collection] 空格键监听器已初始化');
        }

        /**
         * 启用空格键监听
         */
        _enableSpaceKey() {
            this._spaceKeyEnabled = true;
            console.log('[Collection] 空格键监听已启用');
        }

        /**
         * 禁用空格键监听
         */
        _disableSpaceKey() {
            this._spaceKeyEnabled = false;
            console.log('[Collection] 空格键监听已禁用');
        }

        /**
         * 空格键按下时的处理
         */
        async _onSpaceKeyPressed() {
            if (!this._isRunning) {
                console.log('[Collection] 采集未运行，忽略空格键');
                return;
            }

            const timestamp = Date.now() / 1000;  // 转换为秒
            console.log('[Collection] ★★★ 空格键同步信号 ★★★');
            console.log('[Collection] 时间戳:', timestamp);
            console.log('[Collection] 录像会话ID:', this._recordingSessionId);

            // 发送 space prompt 到 realtimeEngine
            this.sendToRealtimeEngine('prompt', {
                name: 'space',
                stageName: this.stages[this.currentStageIndex]?.name || 'unknown',
                timestamp: timestamp,
                recordingSessionId: this._recordingSessionId
            });

            // 【修改】不再在第一个space按下时启动录制
            // 录制已在采集开始时启动，这里只记录时间戳
            console.log('[Collection] 🎥 记录空格时间戳:', timestamp);
            if (this._currentVideoStartTimestamp) {
                const offset = timestamp - this._currentVideoStartTimestamp;
                console.log('[Collection] 空格相对于视频开始的偏移:', offset.toFixed(3), '秒');
            }

            // 显示视觉同步信号
            this._showSyncVisualSignal();

            // 显示提示
            this.showToast('已记录同步信号 ⌨️', 'success');
        }

        /**
         * 启动摄像头录制
         * @param {number} timestamp - space按下的时间戳
         */
        async _startCameraRecording(timestamp) {
            console.log('[Collection] 🎥 启动摄像头录制...');

            // 检查摄像头控制模块是否可用
            if (!window.cameraControl) {
                console.warn('[Collection] cameraControl未初始化，跳过摄像头录制');
                return;
            }

            // 检查摄像头是否正在推流
            const status = window.cameraControl.getStatus();
            if (!status.isStreaming) {
                console.warn('[Collection] 摄像头未推流，跳过录制');
                this.showToast('摄像头未推流，无法录制', 'warning');
                return;
            }

            try {
                // 【修改】使用bin文件名作为视频文件名基础
                // 从 collectionBins 获取bin文件名（例如：dev1: "R001_L_260614_153129"）
                const collectionBins = this._collectionBins || {};
                console.log('[Collection] collectionBins:', collectionBins);

                // dev1对应左手，dev2对应右手
                const binFileNameLeft = collectionBins.dev1;  // R001_L_260614_153129
                const binFileNameRight = collectionBins.dev2; // R001_R_260614_153129 (如果有)

                if (!binFileNameLeft && !binFileNameRight) {
                    console.warn('[Collection] 未找到bin文件名，无法生成视频文件名');
                    this.showToast('未找到bin文件名，无法录制视频', 'warning');
                    return;
                }

                // 使用bin文件名（去掉后缀）作为视频文件名基础
                // 例如：R001_L_260614_153129 -> R001_L_260614_153129_video
                const videoBaseNameLeft = binFileNameLeft ? `${binFileNameLeft}_video` : null;
                const videoBaseNameRight = binFileNameRight ? `${binFileNameRight}_video` : null;

                console.log('[Collection] 视频文件名基础:', {
                    left: videoBaseNameLeft,
                    right: videoBaseNameRight
                });

                // 保存H5文件名（用于后续写入H5属性）
                const currentStage = this.stages[this.currentStageIndex];
                const userData = JSON.parse(localStorage.getItem('emg_current_user') || '{}');
                const userId = userData.id ||
                               this.collectionConfig?.subject?.id ||
                               `S${Date.now().toString().slice(-6)}`;
                const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
                const timeStr = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
                const h5BaseFileName = `${userId}_session${this.currentSessionIndex + 1}_${currentStage?.name || 'stage'}_${dateStr}_${timeStr}`;
                this._currentH5FileName = h5BaseFileName + '.h5';

                // 录制元数据
                const metadata = {
                    h5FileName: this._currentH5FileName,
                    subjectId: userId,
                    sessionIndex: this.currentSessionIndex,
                    sessionNumber: this.currentSessionIndex + 1,
                    stageName: currentStage?.name || 'unknown',
                    stageIndex: this.currentStageIndex,
                    recordingSessionId: this._recordingSessionId,
                    videoStartTimestamp: timestamp,
                    binFileNameLeft: binFileNameLeft,
                    binFileNameRight: binFileNameRight
                };

                // 保存视频启动时间戳
                this._currentVideoStartTimestamp = timestamp;

                // 启动录制（传递bin文件名）
                const result = await window.cameraControl.startRecording({
                    left: videoBaseNameLeft,
                    right: videoBaseNameRight,
                    taskId: this.currentTaskId
                }, metadata);

                if (result.left?.success || result.right?.success) {
                    console.log('[Collection] ✅ 摄像头录制已启动');
                    console.log('[Collection] 视频文件:', {
                        left: result.left?.fileName,
                        right: result.right?.fileName
                    });

                    // 通知后端记录视频文件信息到H5
                    this._notifyVideoRecordingToBackend(result, metadata);

                    this.showToast('摄像头录制已启动 🎥', 'success');
                } else {
                    console.error('[Collection] ❌ 摄像头录制启动失败');
                    this.showToast('摄像头录制启动失败', 'error');
                }

            } catch (error) {
                console.error('[Collection] 启动摄像头录制失败:', error);
                this.showToast('摄像头录制失败: ' + error.message, 'error');
            }
        }

        /**
         * 停止摄像头录制
         */
        /**
         * 通知后端记录视频文件信息到H5
         */
        _notifyVideoRecordingToBackend(recordingResult, metadata) {
            console.log('[Collection] 通知后端记录视频文件信息...');

            // 构建视频文件信息
            const videoInfo = {
                video_left: recordingResult.left?.fileName || null,
                video_right: recordingResult.right?.fileName || null,
                video_start_timestamp: metadata.videoStartTimestamp,
                h5_file_name: metadata.h5FileName
            };

            console.log('[Collection] 视频文件信息:', videoInfo);

            // 通过 realtimeEngine 发送到后端
            this.sendToRealtimeEngine('video_recording_started', videoInfo);
        }

        /**
         * 显示视觉同步信号（全屏闪烁 + 大字提示）
         * 让相机能够清楚拍到
         */
        _showSyncVisualSignal() {
            // 创建全屏闪烁遮罩
            const overlay = document.createElement('div');
            overlay.id = 'syncVisualOverlay';
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(255, 255, 255, 0.95);
                z-index: 99999;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                animation: syncFlash 0.8s ease-out forwards;
            `;

            // 添加大字提示
            overlay.innerHTML = `
                <div style="
                    font-size: 200px;
                    font-weight: 900;
                    color: #2563eb;
                    text-shadow: 0 0 30px rgba(37, 99, 235, 0.5);
                    animation: syncPulse 0.4s ease-out;
                ">SYNC</div>
                <div style="
                    font-size: 48px;
                    color: #1e40af;
                    margin-top: 20px;
                    font-weight: 600;
                ">⌨️ 空格键已按下</div>
                <div style="
                    font-size: 24px;
                    color: #6b7280;
                    margin-top: 10px;
                ">${new Date().toLocaleTimeString()}</div>
            `;

            // 添加动画样式
            const style = document.createElement('style');
            style.id = 'syncVisualStyle';
            style.textContent = `
                @keyframes syncFlash {
                    0% { opacity: 1; }
                    100% { opacity: 0; }
                }
                @keyframes syncPulse {
                    0% { transform: scale(0.8); opacity: 0; }
                    50% { transform: scale(1.1); }
                    100% { transform: scale(1); opacity: 1; }
                }
            `;

            // 移除之前的样式和遮罩（如果存在）
            const existingStyle = document.getElementById('syncVisualStyle');
            const existingOverlay = document.getElementById('syncVisualOverlay');
            if (existingStyle) existingStyle.remove();
            if (existingOverlay) existingOverlay.remove();

            // 添加到页面
            document.head.appendChild(style);
            document.body.appendChild(overlay);

            // 0.8秒后移除
            setTimeout(() => {
                overlay.remove();
                style.remove();
            }, 800);
        }
    }

    // ==================== 初始化 ====================
    console.log('[Collection] 准备初始化控制器 (v3-fixed-v3)');
    
    function initController() {
        console.log('[Collection] ====== 开始初始化控制器 (v3-fixed-v3) ======');
        
        try {
            const controller = new CollectionController();
            window.collectionController = controller;
            console.log('[Collection] 控制器已创建并挂载到 window.collectionController');
            
            setTimeout(() => {
                console.log('[Collection] 延迟初始化开始...');
                controller.init();
            }, 100);
            
        } catch (error) {
            console.error('[Collection] 初始化失败:', error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initController);
    } else {
        initController();
    }

    console.log('[Collection] 脚本主体执行完毕 (v3-fixed-v3)');

})();

console.log('[Collection] ====== 脚本加载结束 (v3-fixed-v3) ======');
