/**
 * continual-gesture-1-animation.js - 连续手势1采集动画模块
 * 
 * 【同心圆版】
 * 动画说明：
 * - 画面中心有一个半径100的外圆（目标圆）
 * - 引导同心圆：半径从0逐渐增加到100，引导区域是 r±5
 * - 用户通过鼠标滚轮控制另一个同心圆的半径（滚轮向后=半径增大）
 * - 受试者需要让自己控制的圆尽量保持在引导区域内
 * - 一次采集周期：引导圆从0→100（扩张），保持1秒，然后100→0（收缩）
 * 
 * Stage结构：
 * - 每个Stage包含多个Trial（采集周期）
 * - 每个Trial = 扩张阶段 + 保持阶段 + 收缩阶段
 */

(function() {
    'use strict';

    console.log('[ContinualGesture1Animation] 同心圆版动画模块开始加载...');

    class ContinualGesture1AnimationController {
        constructor() {
            // Canvas相关
            this.canvas = null;
            this.ctx = null;
            this.containerElement = null;
            
            // 任务状态
            this.isRunning = false;
            this.animationId = null;
            this.stageTimer = null;
            
            // 当前Stage信息
            this.currentStage = null;
            this.currentTaskId = 'continual_gesture_1';
            this.onComplete = null;
            this.onTrialComplete = null;
            
            // 同心圆参数（可配置）
            this.maxRadius = 150;              // 外圆最大半径
            this.guideBandWidth = 10;          // 引导区域宽度（半径±10）
            this.guideRadius = 0;              // 当前引导圆半径
            this.userRadius_L = 0;             // 左手控制的圆半径（红色）
            this.userRadius_R = 0;             // 右手控制的圆半径（蓝色）
            this.userRadius = 0;               // 兼容旧接口（取左手值）
            
            // 动画阶段
            this.phase = 'idle';               // 'idle' | 'expand' | 'hold' | 'contract'
            this.phaseStartTime = 0;           // 当前阶段开始时间
            this.expandDuration = 3000;        // 扩张阶段时长（ms）
            this.holdDuration = 1000;          // 保持阶段时长（ms）
            this.contractDuration = 3000;      // 收缩阶段时长（ms）
            
            // Trial计数
            this.trial = 0;                    // 当前Trial索引
            this.maxTrials = 5;                // 每个Stage的Trial数量
            this.stageTimeout = 120000;        // Stage超时时间（120秒）
            
            // 计时相关
            this.startTime = null;             // Stage开始时间
            this.remainingTime = 0;            // 剩余时间
            
            // 跟踪精度统计（双手）
            this.trackingData_L = [];          // 左手跟踪数据
            this.trackingData_R = [];          // 右手跟踪数据
            this.trackingData = [];            // 兼容旧接口
            this.trialAccuracy_L = [];         // 左手每个Trial的平均精度
            this.trialAccuracy_R = [];         // 右手每个Trial的平均精度
            this.trialAccuracy = [];           // 兼容旧接口
            
            // 配置
            this.config = {
                canvasWidth: 0,
                canvasHeight: 0,
                centerX: 0,
                centerY: 0,
                colors: {
                    background: 'rgba(248, 250, 252, 0.98)',
                    outerCircle: 'rgba(15, 23, 42, 0.12)',
                    outerCircleBorder: 'rgba(15, 23, 42, 0.25)',
                    guideZone: 'rgba(59, 130, 246, 0.20)',
                    guideZoneBorder: 'rgba(59, 130, 246, 0.5)',
                    // 左手颜色（红色系）
                    userCircle_L: '#ef4444',
                    userCircleBorder_L: '#991b1b',
                    userCircleOnTarget_L: '#f87171',
                    userCircleOnTargetBorder_L: '#dc2626',
                    // 右手颜色（蓝色系）
                    userCircle_R: '#3b82f6',
                    userCircleBorder_R: '#1d4ed8',
                    userCircleOnTarget_R: '#60a5fa',
                    userCircleOnTargetBorder_R: '#2563eb',
                    // 兼容旧接口
                    userCircle: '#ef4444',
                    userCircleBorder: '#991b1b',
                    userCircleOnTarget: '#10b981',
                    userCircleOnTargetBorder: '#065f46',
                    text: '#1e40af',
                    muted: 'rgba(107, 114, 128, 0.9)',
                    success: '#10b981',
                    warning: '#f59e0b'
                }
            };
            
            // 绑定事件处理器
            this._wheelHandler = this.handleWheel.bind(this);
            this._resizeHandler = this.resizeCanvas.bind(this);

            // 输入接口
            this.inputInterface = null;
        }

        /**
         * 从配置加载
         */
        loadConfig(executionParams) {
            console.log('[ContinualGesture1Animation] loadConfig() 开始');
            
            let templateConfig = null;
            
            // 第一优先级：直接从localStorage读取最新配置
            const saved = localStorage.getItem('emg_collection_template');
            if (saved) {
                try {
                    const template = JSON.parse(saved);
                    if (template.execution?.continual_gesture_1) {
                        templateConfig = template.execution.continual_gesture_1;
                        console.log('[ContinualGesture1Animation] 从localStorage读取配置:', templateConfig);
                    }
                } catch (e) {
                    console.warn('[ContinualGesture1Animation] 解析localStorage失败:', e);
                }
            }
            
            // 第二优先级：从templateConfigManager读取
            if (!templateConfig && window.templateConfigManager?.currentTemplate?.execution?.continual_gesture_1) {
                templateConfig = window.templateConfigManager.currentTemplate.execution.continual_gesture_1;
                console.log('[ContinualGesture1Animation] 从templateConfigManager读取配置');
            }
            
            // 第三优先级：从collectionController获取
            if (!templateConfig && window.collectionController?.currentExecutionParams) {
                const params = window.collectionController.currentExecutionParams;
                if (params.trialsPerStage !== undefined) {
                    templateConfig = params;
                    console.log('[ContinualGesture1Animation] 从collectionController读取配置');
                }
            }

            // 使用本次采集的快照，避免速度参数与后台模板混用。
            if (executionParams) templateConfig = { ...executionParams };
            this.guideMotionParams = templateConfig || {};
            this.baseExpandDuration = 3000;
            this.baseContractDuration = 3000;
            this.holdDuration = 1000;
            this.restBetweenTrials = 1;
            if (templateConfig) {
                this.maxTrials = templateConfig.trialsPerStage || 5;
                this.stageTimeout = (templateConfig.stageTimeout || 120) * 1000;
                this.restBetweenTrials = templateConfig.restBetweenTrials ?? 1;

                // 同心圆动画配置 - 【修改】这里保存的是基准时长
                if (templateConfig.expandDuration !== undefined) {
                    this.baseExpandDuration = templateConfig.expandDuration * 1000;
                    this.expandDuration = this.baseExpandDuration;  // 兼容性
                }
                if (templateConfig.holdDuration !== undefined) {
                    this.holdDuration = templateConfig.holdDuration * 1000;
                }
                if (templateConfig.contractDuration !== undefined) {
                    this.baseContractDuration = templateConfig.contractDuration * 1000;
                    this.contractDuration = this.baseContractDuration;  // 兼容性
                }
                if (templateConfig.guideBandWidth !== undefined) {
                    this.guideBandWidth = templateConfig.guideBandWidth;
                }
                if (templateConfig.maxRadius !== undefined) {
                    this.maxRadius = templateConfig.maxRadius;
                }

                // 【新增】速度变化配置
                this.speedLevels = templateConfig.speedLevels || [0.5, 1.0, 1.5, 2.0];
                this.trialSpeedSequence = templateConfig.trialSpeedSequence || [];

                console.log('[ContinualGesture1Animation] 配置加载完成:', {
                    maxTrials: this.maxTrials,
                    stageTimeout: this.stageTimeout,
                    restBetweenTrials: this.restBetweenTrials,
                    baseExpandDuration: this.baseExpandDuration,
                    holdDuration: this.holdDuration,
                    baseContractDuration: this.baseContractDuration,
                    guideBandWidth: this.guideBandWidth,
                    maxRadius: this.maxRadius,
                    speedLevels: this.speedLevels,
                    trialSpeedSequence: this.trialSpeedSequence
                });
            } else {
                console.log('[ContinualGesture1Animation] 未找到配置，使用默认值');
                // 设置默认的基准值
                this.expandDuration = this.baseExpandDuration;
                this.contractDuration = this.baseContractDuration;
                this.speedLevels = [0.5, 1.0, 1.5, 2.0];
                this.trialSpeedSequence = [];
            }
        }

        /**
         * 初始化Canvas
         */
        init(containerSelector) {
            this.loadConfig();
            
            this.containerElement = document.getElementById('gestureAnimationViewport') ||
                                    document.querySelector('.animation-area') ||
                                    document.querySelector(containerSelector) ||
                                    document.getElementById('gestureDisplay');
            
            if (!this.containerElement) {
                console.warn('[ContinualGesture1Animation] 未找到容器元素');
                return false;
            }
            
            const containerStyle = window.getComputedStyle(this.containerElement);
            if (containerStyle.position === 'static') {
                this.containerElement.style.position = 'relative';
            }
            
            // 创建或获取Canvas
            this.canvas = document.getElementById('continualGesture1Canvas');
            if (!this.canvas) {
                this.canvas = document.createElement('canvas');
                this.canvas.id = 'continualGesture1Canvas';
                this.canvas.style.cssText = `
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    z-index: 50;
                    background: ${this.config.colors.background};
                `;
                this.containerElement.appendChild(this.canvas);
            }
            
            // 让canvas可以获取焦点以接收滚轮事件
            this.canvas.tabIndex = 0;
            this.canvas.style.outline = 'none';
            
            this.ctx = this.canvas.getContext('2d');
            this.resizeCanvas();
            
            // 绑定事件
            window.addEventListener('resize', this._resizeHandler);
            
            console.log('[ContinualGesture1Animation] 初始化完成');
            return true;
        }

        /**
         * 调整Canvas大小
         */
        resizeCanvas() {
            if (!this.canvas || !this.containerElement) return false;
            
            const rect = this.containerElement.getBoundingClientRect();
            
            if (rect.width > 0 && rect.height > 0) {
                const dpr = window.devicePixelRatio || 1;
                
                this.canvas.width = rect.width * dpr;
                this.canvas.height = rect.height * dpr;
                this.canvas.style.width = rect.width + 'px';
                this.canvas.style.height = rect.height + 'px';
                this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                
                this.config.canvasWidth = rect.width;
                this.config.canvasHeight = rect.height;

                // 计算圆心位置（画布中心偏上一点，留出底部信息区域）
                this.config.centerX = rect.width / 2;
                this.config.centerY = (rect.height - 60) / 2 + 30; // 上方留30px，下方留60px

                // 根据画布大小计算可用的最大半径
                const maxPossibleRadius = Math.min(
                    this.config.centerX - 20,           // 左右边距20px
                    this.config.centerY - 50,           // 上边距50px（留给标题）
                    rect.height - this.config.centerY - 70  // 下边距70px（留给进度信息）
                );
                // 【修复】不再硬编码150的上限，使用配置的maxRadius或画布允许的最大值
                // 如果配置的maxRadius超过画布允许的范围，则使用画布允许的最大值
                const configuredMaxRadius = this.maxRadius || 150;
                this.maxRadius = Math.max(80, Math.min(configuredMaxRadius, maxPossibleRadius));

                return true;
            }
            return false;
        }

        /**
         * 重置状态
         */
        reset() {
            this.stop();
            console.log('[ContinualGesture1Animation] 重置状态');
            this.trial = 0;
            this.guideRadius = 0;
            this.userRadius_L = 0;
            this.userRadius_R = 0;
            this.userRadius = 0;
            this.phase = 'idle';
            this.trackingData_L = [];
            this.trackingData_R = [];
            this.trackingData = [];
            this.trialAccuracy_L = [];
            this.trialAccuracy_R = [];
            this.trialAccuracy = [];
        }

        /**
         * 开始Stage动画
         */
        start(stage, onComplete, onTrialComplete, executionParams) {
            console.log('[ContinualGesture1Animation] ====== 开始Stage动画 ======');
            console.log('[ContinualGesture1Animation] stage:', stage.name);

            // 获取输入接口
            this.inputInterface = window.animationInputInterface || null;
            if (this.inputInterface) {
                this.inputInterface.setCurrentTask('continual_gesture_1');
            }

            if (!this.canvas) {
                if (!this.init('.animation-area')) {
                    console.error('[ContinualGesture1Animation] Canvas初始化失败');
                    if (onComplete) onComplete();
                    return;
                }
            }
            
            // 本次采集快照覆盖模板，所有参数使用同一来源。
            this.loadConfig(executionParams);

            console.log('[ContinualGesture1Animation] ★★★ 最终参数 ★★★');
            console.log('[ContinualGesture1Animation] maxTrials:', this.maxTrials);
            console.log('[ContinualGesture1Animation] restBetweenTrials:', this.restBetweenTrials);  // 【新增】
            console.log('[ContinualGesture1Animation] maxRadius:', this.maxRadius);
            console.log('[ContinualGesture1Animation] guideBandWidth:', this.guideBandWidth);
            
            this.currentStage = stage;
            this.onComplete = onComplete;
            this.onTrialComplete = onTrialComplete;
            
            // 重置状态
            this.reset();
            this._motionWallOffset = Date.now() / 1000 - performance.now() / 1000;
            this._guideMotion = new window.ContinuousGuideMotion(this.guideMotionParams, {
                onEvent: event => this.recordGuideMotionEvent(event)
            });
            this.isRunning = true;
            this.startTime = Date.now();
            this.remainingTime = this.stageTimeout;
            
            // 调整Canvas
            this.resizeCanvas();
            this.canvas.style.display = 'block';
            window.animationPositionManager?.showAnimationPanel();
            this.canvas.focus();
            
            // 绑定滚轮事件
            this.canvas.addEventListener('wheel', this._wheelHandler, { passive: false });

            // 【修复】延迟开始第一个Trial，等待H5文件打开
            // stage_start 命令是异步的，需要等文件创建完成
            this._trialTimer = setTimeout(() => {
                this._trialTimer = null;
                if (this.isRunning) {
                    this.startTrial();
                }
            }, 200);
            
            // 设置超时计时器
            this.stageTimer = setTimeout(() => {
                console.log('[ContinualGesture1Animation] Stage超时');
                this.completeStage();
            }, this.stageTimeout);
            
            // 开始动画循环
            this.animate();
        }

        /**
         * 开始一个新的Trial（采集周期）
         */
        startTrial() {
            if (!this.isRunning) return;
            console.log(`[ContinualGesture1Animation] 开始Trial ${this.trial + 1}/${this.maxTrials}`);

            // 【新增】根据速度序列计算当前Trial的实际时间参数
            this.applySpeedMultiplier();

            // 【新增】发送 prompt: start
            if (window.collectionController) {
                window.collectionController.sendToRealtimeEngine('prompt', {
                    name: 'start',
                    stageName: this.currentStage?.name || 'unknown',
                    trialIndex: this.trial,
                    speedMultiplier: this.currentSpeedMultiplier || 1.0,  // 【新增】记录速度倍率
                    timestamp: Date.now() / 1000  // 【修改】转换为秒，与ble_server时间戳一致
                });
            }

            this.beginGuidePhase('expand');
            this.guideRadius = 0;
            this.trackingData_L = [];
            this.trackingData_R = [];
            this.trackingData = [];
        }

        /**
         * 【新增】根据速度序列应用速度倍率
         */
        applySpeedMultiplier() {
            // 默认倍率为1.0（正常速度）
            let multiplier = 1.0;

            // 如果配置了速度序列
            if (this.trialSpeedSequence && this.trialSpeedSequence.length > 0) {
                // 获取当前trial对应的速度等级索引（序列是1-based索引）
                const sequenceIndex = this.trial % this.trialSpeedSequence.length;
                const speedLevelIndex = this.trialSpeedSequence[sequenceIndex];

                // 从速度等级数组中获取倍率（索引是1-based，需要减1）
                if (speedLevelIndex >= 1 && speedLevelIndex <= this.speedLevels.length) {
                    multiplier = this.speedLevels[speedLevelIndex - 1];
                }
            }

            if (!Number.isFinite(multiplier) || multiplier <= 0) multiplier = 1;
            this.currentSpeedMultiplier = multiplier;

            // 应用倍率：倍率越大，时间越短（速度越快）
            // 基准时间 / 倍率 = 实际时间
            this.expandDuration = this.baseExpandDuration / multiplier;
            this.contractDuration = this.baseContractDuration / multiplier;

            console.log(`[ContinualGesture1Animation] Trial ${this.trial + 1} 速度倍率: ${multiplier}x`);
            console.log(`  - expandDuration: ${this.baseExpandDuration}ms -> ${this.expandDuration}ms`);
            console.log(`  - contractDuration: ${this.baseContractDuration}ms -> ${this.contractDuration}ms`);
        }

        /**
         * 更新引导圆半径（根据当前阶段和时间）
         */
        updateGuideRadius() {
            const now = performance.now();
            if (this.phase === 'expand' || this.phase === 'contract') {
                const state = this._guideMotion.advance(now);
                this._guidePaused = state.paused;
                this.currentSpeedMultiplier = state.speedMultiplier;
                const progress = this.easeInOutSine(state.progress);
                this.guideRadius = this.maxRadius * (this.phase === 'expand' ? progress : 1 - progress);
                if (state.complete) {
                    this._guidePaused = false;
                    if (this.phase === 'expand') {
                        this.phase = 'hold';
                        this.phaseStartTime = now;
                        this.guideRadius = this.maxRadius;
                    } else {
                        this.guideRadius = 0;
                        this.completeTrial();
                    }
                }
            } else if (this.phase === 'hold') {
                this.guideRadius = this.maxRadius;
                if (now - this.phaseStartTime >= this.holdDuration) {
                    this.beginGuidePhase('contract');
                }
            }
        }

        beginGuidePhase(phase) {
            this.phase = phase;
            this.phaseStartTime = performance.now();
            this._guidePaused = false;
            const duration = phase === 'expand' ? this.baseExpandDuration : this.baseContractDuration;
            this._guideMotion.beginPhase(duration, this.phaseStartTime, this.currentSpeedMultiplier || 1);
        }

        recordGuideMotionEvent(event) {
            const params = this.guideMotionParams;
            if (params.randomSpeedEnabled !== true && params.randomPauseEnabled !== true) return;
            // 沿用 prompts/names 与 prompts/times，不改变原 start/end 标签。
            const details = {
                type: event.type, trial: this.trial + 1, phase: this.phase,
                speedMultiplier: event.speedMultiplier
            };
            if (event.durationMs !== undefined) details.durationMs = event.durationMs;
            window.collectionController?.sendToRealtimeEngine('prompt', {
                name: 'guide_motion:' + JSON.stringify(details),
                stageName: this.currentStage?.name || 'unknown',
                timestamp: this._motionWallOffset + event.timeMs / 1000
            });
        }

        /**
         * 缓动函数：easeInOutSine
         */
        easeInOutSine(t) {
            return -(Math.cos(Math.PI * t) - 1) / 2;
        }

        /**
         * 完成当前Trial
         */
        completeTrial() {
            // 【新增】发送 prompt: end
            if (window.collectionController) {
                window.collectionController.sendToRealtimeEngine('prompt', {
                    name: 'end',
                    stageName: this.currentStage?.name || 'unknown',
                    trialIndex: this.trial,
                    timestamp: Date.now() / 1000  // 【修改】转换为秒，与ble_server时间戳一致
                });
            }

            // 计算左手本次Trial的平均跟踪精度
            let accuracy_L = 0;
            if (this.trackingData_L.length > 0) {
                const totalError_L = this.trackingData_L.reduce((sum, d) => sum + Math.abs(d.error), 0);
                accuracy_L = 1 - (totalError_L / this.trackingData_L.length / this.maxRadius);
                accuracy_L = Math.max(0, Math.min(1, accuracy_L));
            }
            this.trialAccuracy_L.push(accuracy_L);

            // 计算右手本次Trial的平均跟踪精度
            let accuracy_R = 0;
            if (this.trackingData_R.length > 0) {
                const totalError_R = this.trackingData_R.reduce((sum, d) => sum + Math.abs(d.error), 0);
                accuracy_R = 1 - (totalError_R / this.trackingData_R.length / this.maxRadius);
                accuracy_R = Math.max(0, Math.min(1, accuracy_R));
            }
            this.trialAccuracy_R.push(accuracy_R);

            // 兼容旧接口（取平均）
            const accuracy = (accuracy_L + accuracy_R) / 2;
            this.trialAccuracy.push(accuracy);

            console.log(`[ContinualGesture1Animation] Trial ${this.trial + 1} 完成, 精度: L=${(accuracy_L * 100).toFixed(1)}%, R=${(accuracy_R * 100).toFixed(1)}%`);

            this.trial++;

            // 调用试次完成回调
            if (this.onTrialComplete) {
                this.onTrialComplete(this.trial - 1);
            }

            // 检查是否完成所有Trial
            if (this.trial >= this.maxTrials) {
                console.log('[ContinualGesture1Animation] 所有Trial完成');
                this.completeStage();
            } else {
                // 【修改】使用配置的试次间隔休息时间
                this.phase = 'rest';
                const restTime = (this.restBetweenTrials ?? 1) * 1000;  // 默认1秒
                console.log(`[ContinualGesture1Animation] 休息 ${restTime/1000} 秒后开始下一个Trial`);

                this._trialTimer = setTimeout(() => {
                    this._trialTimer = null;
                    if (this.isRunning) {
                        this.startTrial();
                    }
                }, restTime);
            }
        }

        /**
         * 完成Stage
         */
        completeStage() {
            const avgAccuracy = this.trialAccuracy.length > 0 
                ? this.trialAccuracy.reduce((a, b) => a + b, 0) / this.trialAccuracy.length 
                : 0;
            console.log(`[ContinualGesture1Animation] Stage完成: ${this.trial} Trials, 平均精度 ${(avgAccuracy * 100).toFixed(1)}%`);
            this.stop();
            if (this.onComplete) {
                this.onComplete();
            }
        }

        /**
         * 处理滚轮事件（仅用于调试/鼠标模式）
         */
        handleWheel(e) {
            if (!this.isRunning) return;

            e.preventDefault();
            e.stopPropagation();

            // 标准化delta
            let multiplier = 0.5; // pixels
            if (e.deltaMode === 1) multiplier = 5; // lines
            if (e.deltaMode === 2) multiplier = 20; // pages

            const rawDelta = e.deltaY * multiplier;
            const delta = Math.max(-5, Math.min(5, rawDelta));

            // 滚轮向下（正值）= 半径增大（同时控制双手，仅用于调试）
            this.userRadius_L = Math.max(0, Math.min(this.maxRadius, this.userRadius_L + delta));
            this.userRadius_R = Math.max(0, Math.min(this.maxRadius, this.userRadius_R + delta));
            this.userRadius = this.userRadius_L;  // 兼容

            // 记录跟踪数据
            if (this.phase !== 'idle' && this.phase !== 'rest') {
                const now = performance.now();
                // 左手
                this.trackingData_L.push({
                    time: now,
                    guideRadius: this.guideRadius,
                    userRadius: this.userRadius_L,
                    error: this.userRadius_L - this.guideRadius
                });
                // 右手
                this.trackingData_R.push({
                    time: now,
                    guideRadius: this.guideRadius,
                    userRadius: this.userRadius_R,
                    error: this.userRadius_R - this.guideRadius
                });
                // 兼容
                this.trackingData.push({
                    time: now,
                    guideRadius: this.guideRadius,
                    userRadius: this.userRadius,
                    error: this.userRadius - this.guideRadius
                });
            }
        }

        /**
         * 检查用户圆是否在引导区域内
         * @param {string} hand - 'L' | 'R' | undefined (undefined时检查左手，兼容旧接口)
         */
        isOnTarget(hand = 'L') {
            if (this.phase === 'idle' || this.phase === 'rest') return false;
            const userRadius = hand === 'R' ? this.userRadius_R : this.userRadius_L;
            const diff = Math.abs(userRadius - this.guideRadius);
            return diff <= this.guideBandWidth;
        }

        /**
         * 动画循环
         */
        animate() {
            if (!this.isRunning) return;

            // 更新剩余时间
            this.remainingTime = Math.max(0, this.stageTimeout - (Date.now() - this.startTime));

            // 更新引导圆半径
            this.updateGuideRadius();
            if (!this.isRunning) return;

            // 从输入接口更新用户控制的半径（双手）
            if (this.inputInterface) {
                const dualInput = this.inputInterface.getNormalizedInputDual();
                // 左手
                if (this.inputInterface.calibration.isCalibrated_L) {
                    this.userRadius_L = dualInput.left * this.maxRadius;
                }
                // 右手
                if (this.inputInterface.calibration.isCalibrated_R) {
                    this.userRadius_R = dualInput.right * this.maxRadius;
                }
                // 兼容旧接口
                this.userRadius = this.userRadius_L;

                // 记录跟踪数据
                if (this.phase !== 'idle' && this.phase !== 'rest') {
                    const now = performance.now();
                    // 左手
                    this.trackingData_L.push({
                        time: now,
                        guideRadius: this.guideRadius,
                        userRadius: this.userRadius_L,
                        error: this.userRadius_L - this.guideRadius
                    });
                    // 右手
                    this.trackingData_R.push({
                        time: now,
                        guideRadius: this.guideRadius,
                        userRadius: this.userRadius_R,
                        error: this.userRadius_R - this.guideRadius
                    });
                }
            }

            // 清除画布
            this.ctx.clearRect(0, 0, this.config.canvasWidth, this.config.canvasHeight);

            // 绘制所有元素
            this.drawStageInfo();
            this.drawOuterCircle();
            this.drawGuideZone();
            this.drawUserCircles();  // 【修改】绘制双手圆
            this.drawProgress();
            this.drawInstructions();

            // 继续下一帧
            this.animationId = requestAnimationFrame(() => this.animate());
        }

        /**
         * 绘制Stage信息
         */
        drawStageInfo() {
            const ctx = this.ctx;
            const stageConfig = this.currentStage;
            
            let stageLabel = stageConfig?.label || stageConfig?.name || '连续手势采集';
            let stageIcon = stageConfig?.icon || '🎯';
            
            ctx.save();
            
            // 左上角显示当前Stage名称
            ctx.fillStyle = this.config.colors.text;
            ctx.font = '700 22px ui-sans-serif, system-ui, -apple-system';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(`${stageIcon} ${stageLabel}`, 20, 20);
            
            // 显示指导文字
            ctx.fillStyle = this.config.colors.muted;
            ctx.font = '500 14px ui-sans-serif, system-ui';
            ctx.fillText('滚动滚轮控制圆的大小，跟随蓝色引导区域', 20, 48);
            
            // 显示当前阶段
            const phaseText = {
                'idle': '准备中...',
                'expand': '扩张阶段 ↗',
                'hold': '保持阶段 ●',
                'contract': '收缩阶段 ↘'
            };
            ctx.fillStyle = this.config.colors.text;
            ctx.font = '600 16px ui-sans-serif, system-ui';
            ctx.fillText(this._guidePaused ? '引导停顿中，请保持当前位置' : (phaseText[this.phase] || ''), 20, 72);
            
            // 右上角显示倒计时
            const seconds = Math.ceil(this.remainingTime / 1000);
            const timeColor = seconds <= 10 ? this.config.colors.warning : this.config.colors.muted;
            ctx.fillStyle = timeColor;
            ctx.font = '600 18px ui-sans-serif, system-ui';
            ctx.textAlign = 'right';
            ctx.fillText(`⏱ ${seconds}s`, this.config.canvasWidth - 20, 24);
            
            ctx.restore();
        }

        /**
         * 绘制外圆（目标边界）
         */
        drawOuterCircle() {
            const ctx = this.ctx;
            const cx = this.config.centerX;
            const cy = this.config.centerY;
            
            ctx.save();
            
            // 外圆背景
            ctx.fillStyle = this.config.colors.outerCircle;
            ctx.strokeStyle = this.config.colors.outerCircleBorder;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, this.maxRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            
            // 中心点
            ctx.fillStyle = this.config.colors.outerCircleBorder;
            ctx.beginPath();
            ctx.arc(cx, cy, 3, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.restore();
        }

        /**
         * 绘制引导区域（带状区域）
         */
        drawGuideZone() {
            if (this.phase === 'idle') return;
            
            const ctx = this.ctx;
            const cx = this.config.centerX;
            const cy = this.config.centerY;
            
            const innerR = Math.max(0, this.guideRadius - this.guideBandWidth);
            const outerR = Math.min(this.maxRadius, this.guideRadius + this.guideBandWidth);
            
            ctx.save();
            
            // 绘制引导带（环形区域）
            ctx.fillStyle = this.config.colors.guideZone;
            ctx.strokeStyle = this.config.colors.guideZoneBorder;
            ctx.lineWidth = 2;
            
            ctx.beginPath();
            // 外圆（顺时针）
            ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
            // 内圆（逆时针，形成环形）
            ctx.arc(cx, cy, innerR, Math.PI * 2, 0, true);
            ctx.closePath();
            ctx.fill();
            
            // 绘制引导圆的中心线
            ctx.strokeStyle = this.config.colors.guideZoneBorder;
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.arc(cx, cy, this.guideRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            
            // 显示引导圆半径值
            ctx.fillStyle = this.config.colors.text;
            ctx.font = '600 12px ui-sans-serif, system-ui';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            const labelX = cx + this.guideRadius + 10;
            const labelY = cy;
            if (labelX < this.config.canvasWidth - 50) {
                ctx.fillText(`r=${this.guideRadius.toFixed(0)}`, labelX, labelY);
            }
            
            ctx.restore();
        }

        /**
         * 绘制用户控制的圆（双手：红色=左手，蓝色=右手）
         */
        drawUserCircles() {
            const ctx = this.ctx;
            const cx = this.config.centerX;
            const cy = this.config.centerY;

            // 绘制左手圆（红色）
            this._drawSingleUserCircle(ctx, cx, cy, this.userRadius_L, 'L');

            // 绘制右手圆（蓝色）
            this._drawSingleUserCircle(ctx, cx, cy, this.userRadius_R, 'R');
        }

        /**
         * 绘制单个用户圆
         */
        _drawSingleUserCircle(ctx, cx, cy, radius, hand) {
            const isOnTarget = this.isOnTarget(hand);
            const colors = this.config.colors;

            // 根据手选择颜色
            let strokeColor, fillColor;
            if (hand === 'R') {
                strokeColor = isOnTarget ? colors.userCircleOnTargetBorder_R : colors.userCircleBorder_R;
                fillColor = isOnTarget ? colors.userCircleOnTarget_R : colors.userCircle_R;
            } else {
                strokeColor = isOnTarget ? colors.userCircleOnTargetBorder_L : colors.userCircleBorder_L;
                fillColor = isOnTarget ? colors.userCircleOnTarget_L : colors.userCircle_L;
            }

            ctx.save();

            // 用户圆
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = 3;

            // 添加发光效果（在目标区域内时）
            if (isOnTarget) {
                ctx.shadowColor = fillColor;
                ctx.shadowBlur = 10;
            }

            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.stroke();

            // 重置阴影
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;

            // 在圆上绘制一个小标记点（方便看到圆的位置，即使半径很小）
            // 左手标记在顶部，右手标记在底部，避免重叠
            const markerAngle = hand === 'R' ? Math.PI / 2 : -Math.PI / 2;
            const markerX = cx + radius * Math.cos(markerAngle);
            const markerY = cy + radius * Math.sin(markerAngle);

            ctx.fillStyle = fillColor;
            ctx.beginPath();
            ctx.arc(markerX, markerY, 6, 0, Math.PI * 2);
            ctx.fill();

            // 在标记点旁边显示手的标识
            ctx.fillStyle = fillColor;
            ctx.font = '600 10px ui-sans-serif, system-ui';
            ctx.textAlign = 'center';
            ctx.textBaseline = hand === 'R' ? 'top' : 'bottom';
            const labelY = hand === 'R' ? markerY + 10 : markerY - 10;
            ctx.fillText(hand === 'R' ? '右' : '左', markerX, labelY);

            ctx.restore();
        }

        /**
         * 绘制用户控制的圆（旧接口，保留兼容）
         */
        drawUserCircle() {
            this.drawUserCircles();
        }

        /**
         * 绘制进度信息
         */
        drawProgress() {
            const ctx = this.ctx;
            const bottomY = this.config.canvasHeight - 20;

            ctx.save();

            // 右下角显示进度
            ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
            ctx.font = '700 16px ui-sans-serif, system-ui';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`Trial ${this.trial} / ${this.maxTrials}`, this.config.canvasWidth - 20, bottomY);

            // 进度条
            const barWidth = 150;
            const barHeight = 8;
            const barX = this.config.canvasWidth - 20 - barWidth;
            const barY = bottomY - 30;
            const progress = this.maxTrials > 0 ? this.trial / this.maxTrials : 0;

            // 进度条背景
            ctx.fillStyle = '#e5e7eb';
            ctx.beginPath();
            ctx.roundRect(barX, barY, barWidth, barHeight, 4);
            ctx.fill();

            // 进度条填充
            ctx.fillStyle = this.config.colors.success;
            ctx.beginPath();
            ctx.roundRect(barX, barY, barWidth * progress, barHeight, 4);
            ctx.fill();

            // 左下角显示双手状态信息
            ctx.fillStyle = this.config.colors.muted;
            ctx.font = '500 14px ui-sans-serif, system-ui';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';

            const isOnTarget_L = this.isOnTarget('L');
            const isOnTarget_R = this.isOnTarget('R');

            // 显示双手半径和误差
            const error_L = this.phase !== 'idle' && this.phase !== 'rest'
                ? (this.userRadius_L - this.guideRadius).toFixed(1)
                : '-';
            const error_R = this.phase !== 'idle' && this.phase !== 'rest'
                ? (this.userRadius_R - this.guideRadius).toFixed(1)
                : '-';

            ctx.fillText(`引导: ${this.guideRadius.toFixed(0)} | 左手: ${this.userRadius_L.toFixed(0)} (误差:${error_L}) | 右手: ${this.userRadius_R.toFixed(0)} (误差:${error_R})`, 20, bottomY - 20);

            // 显示双手状态
            const statusText_L = isOnTarget_L ? '✓左' : '○左';
            const statusText_R = isOnTarget_R ? '✓右' : '○右';

            ctx.fillStyle = isOnTarget_L ? this.config.colors.userCircle_L : this.config.colors.muted;
            ctx.fillText(statusText_L, 20, bottomY);

            ctx.fillStyle = isOnTarget_R ? this.config.colors.userCircle_R : this.config.colors.muted;
            ctx.fillText(statusText_R, 60, bottomY);

            ctx.restore();
        }

        /**
         * 绘制操作说明
         */
        drawInstructions() {
            const ctx = this.ctx;
            const cx = this.config.centerX;
            const bottomY = this.config.centerY + this.maxRadius + 20;
            
            // 如果说明文字会超出画布，就不绘制
            if (bottomY > this.config.canvasHeight - 80) return;
            
            ctx.save();
            
            ctx.fillStyle = this.config.colors.muted;
            ctx.font = '500 12px ui-sans-serif, system-ui';
            ctx.textAlign = 'center';
            
            ctx.fillText('↓ 滚轮向下：圆变大 | ↑ 滚轮向上：圆变小', cx, bottomY);
            
            ctx.restore();
        }

        /**
         * 停止动画
         */
        stop() {
            console.log('[ContinualGesture1Animation] 停止动画');
            this.isRunning = false;
            this._guideMotion?.stop();
            this._guideMotion = null;
            this._guidePaused = false;
            if (this._trialTimer != null) {
                clearTimeout(this._trialTimer);
                this._trialTimer = null;
            }

            // 清除计时器
            if (this.animationId) {
                cancelAnimationFrame(this.animationId);
                this.animationId = null;
            }
            if (this.stageTimer) {
                clearTimeout(this.stageTimer);
                this.stageTimer = null;
            }
            
            // 移除事件监听
            if (this.canvas) {
                this.canvas.removeEventListener('wheel', this._wheelHandler);
            }
            
            // 清除画布
            if (this.ctx && this.config.canvasWidth && this.config.canvasHeight) {
                this.ctx.clearRect(0, 0, this.config.canvasWidth, this.config.canvasHeight);
            }
            
            // 隐藏Canvas
            if (this.canvas) {
                this.canvas.style.display = 'none';
            }
            window.animationPositionManager?.hideAnimationPanel();
        }

        /**
         * 销毁
         */
        destroy() {
            this.stop();
            
            window.removeEventListener('resize', this._resizeHandler);
            
            if (this.canvas && this.canvas.parentElement) {
                this.canvas.parentElement.removeChild(this.canvas);
            }
            
            this.canvas = null;
            this.ctx = null;
            this.containerElement = null;
        }

        /**
         * 检查动画是否在运行
         */
        isAnimationRunning() {
            return this.isRunning;
        }

        /**
         * 获取进度信息
         */
        getProgress() {
            return {
                trial: this.trial,
                maxTrials: this.maxTrials,
                phase: this.phase,
                percent: this.maxTrials > 0 ? (this.trial / this.maxTrials * 100) : 0,
                remainingTime: this.remainingTime,
                accuracy: this.trialAccuracy
            };
        }
    }

    // 创建全局实例
    const continualGesture1Animation = new ContinualGesture1AnimationController();
    window.continualGesture1Animation = continualGesture1Animation;
    
    console.log('[ContinualGesture1Animation] 同心圆版动画模块加载完成');

})();
