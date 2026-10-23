/**
 * template-config.js - 采集模板配置管理器
 * 
 * 功能：
 * 1. 后台配置页面：创建/编辑采集模板
 * 2. 分类层级管理：大类、大场景、子场景、人群
 * 3. 手势库管理
 * 4. 受试者字段配置
 * 5. 执行参数配置
 * 6. 模板导入/导出
 */

(function() {
    'use strict';

    console.log('[TemplateConfig] 模块开始加载...');

    // ==================== 默认配置模板 ====================
    const DEFAULT_TEMPLATE = {
        templateName: '标准采集模板',
        version: '2.1',
        created: new Date().toISOString().split('T')[0],
        lastModified: new Date().toISOString(),

        // Session配置（穿戴次数）
        sessionConfig: {
            count: 3,           // session数量（即穿戴次数）
            description: '每个Session代表一次设备穿戴，受试者需要摘下重新穿戴采集设备'
        },

        // 分类标签（可自定义名称）
        categoryLabels: {
            category1: '大类',
            category2: '大场景',
            category3: '子场景',
            category4: '人群'
        },

        // 采集任务选项
        tasks: [
            { id: 'discrete_gesture', name: '离散手势采集', enabled: true },
            { id: 'continual_gesture_1', name: '连续手势采集1', enabled: true },
            { id: 'continual_gesture_2', name: '连续手势采集2', enabled: true },
            { id: 'continual_gesture_3', name: '连续手势采集3', enabled: true }
        ],

        // 分类1: 大类
        category1: [
            { id: 'static', name: '静态采集', enabled: true },
            { id: 'dynamic', name: '动态采集', enabled: true }
        ],

        // 分类2: 大场景
        category2: [
            { id: 'sitting', name: '坐姿', enabled: true },
            { id: 'lying', name: '卧姿', enabled: true },
            { id: 'standing', name: '站姿', enabled: false }
        ],

        // 分类3: 子场景/Stage（顺序执行，不选择）
        category3: [
            { id: 'palm_up', name: '手心朝上', instruction: '请保持手心朝上的姿势', enabled: true },
            { id: 'palm_inward', name: '手心朝内', instruction: '请保持手心朝内的姿势', enabled: true },
            { id: 'hand_on_knee', name: '手放膝盖', instruction: '请将手放在膝盖上', enabled: true },
            { id: 'hand_on_desk', name: '手放桌上', instruction: '请将手放在桌面上', enabled: true },
            { id: 'arm_straight', name: '手臂伸直', instruction: '请将手臂向前伸直', enabled: false },
            { id: 'arm_bent', name: '手臂弯曲', instruction: '请将手臂弯曲90度', enabled: false }
        ],

        // 分类4: 人群
        category4: [
            { id: 'normal', name: '正常状态', description: '正常静态状态', enabled: true },
            { id: 'exercise', name: '运动/力竭', description: '运动后或力竭状态', enabled: true },
            { id: 'cold', name: '低温环境', description: '低温环境下采集', enabled: false }
        ],

        // 手势库
        // gestureType: 'instant' 瞬时手势（原有模式）, 'sustained' 持续手势（长方形动画）
        gestures: {
            discrete: [
                { id: 'thumb_up', name: '拇指上滑', icon: '👆', gifFile: 'thumb_up.gif', enabled: true, gestureType: 'instant' },
                { id: 'thumb_down', name: '拇指下滑', icon: '👇', gifFile: 'thumb_down.gif', enabled: true, gestureType: 'instant' },
                { id: 'thumb_left', name: '拇指左滑', icon: '👈', gifFile: 'thumb_left.gif', enabled: true, gestureType: 'instant' },
                { id: 'thumb_right', name: '拇指右滑', icon: '👉', gifFile: 'thumb_right.gif', enabled: true, gestureType: 'instant' },
                { id: 'thumb_press', name: '拇指按压', icon: '👍', gifFile: 'thumb_press.gif', enabled: true, gestureType: 'instant' },
                { id: 'index_tap', name: '食指点击', icon: '☝️', gifFile: 'index_tap.gif', enabled: true, gestureType: 'instant' },
                { id: 'index_double_tap', name: '食指双击', icon: '✌️', gifFile: 'index_double_tap.gif', enabled: true, gestureType: 'instant' },
                { id: 'middle_tap', name: '中指点击', icon: '🖕', gifFile: 'middle_tap.gif', enabled: true, gestureType: 'instant' },
                { id: 'pinch', name: '捏合', icon: '🤏', gifFile: 'pinch.gif', enabled: true, gestureType: 'instant' },
                { id: 'spread', name: '张开', icon: '🖐️', gifFile: 'spread.gif', enabled: true, gestureType: 'instant' },
                { id: 'fist', name: '握拳', icon: '✊', gifFile: 'fist.gif', enabled: true, gestureType: 'instant' },
                { id: 'release', name: '松开', icon: '✋', gifFile: 'release.gif', enabled: true, gestureType: 'instant' },
                { id: 'wrist_up', name: '手腕上抬', icon: '⬆️', gifFile: 'wrist_up.gif', enabled: true, gestureType: 'instant' },
                { id: 'wrist_down', name: '手腕下压', icon: '⬇️', gifFile: 'wrist_down.gif', enabled: true, gestureType: 'instant' },
                { id: 'wrist_rotate_cw', name: '手腕顺时针', icon: '🔃', gifFile: 'wrist_rotate_cw.gif', enabled: true, gestureType: 'instant' },
                { id: 'wrist_rotate_ccw', name: '手腕逆时针', icon: '🔄', gifFile: 'wrist_rotate_ccw.gif', enabled: true, gestureType: 'instant' },
                { id: 'rest', name: '保持/休息', icon: '⏸️', gifFile: 'rest.gif', enabled: true, gestureType: 'instant' },
                { id: 'pinch_hold', name: '捏住并保持', icon: '🤏', gifFile: 'pinch_hold.gif', enabled: false, gestureType: 'sustained' }
            ],
            continual_1: [],
            continual_2: [],
            continual_3: []
        },

        // 执行参数 - 按任务类型分开配置
        execution: {
            // 离散手势采集参数
            discrete_gesture: {
                repeatPerGesture: 5,           // 每个手势重复次数
                intervalBetweenRepeat: 1.0,    // 重复间隔（秒）
                restBetweenGestures: 30.0,     // 手势间休息时间（秒）
                preparationTime: 3.0,          // Stage开始前准备时间（秒）
                preparationTimeMin: 3.0,       // 【新增】准备时间最小值（秒）
                preparationTimeMax: 3.0,       // 【新增】准备时间最大值（秒）
                gestureDisplayTime: 2.0,       // 手势提示显示时间（秒）
                sustainedDuration: 2.0,        // 持续性手势的持续时间（秒）
                shuffleInterval: 1.0,          // 乱序模式手势间隔（秒）
                shuffleIntervalMin: 1.0,       // 【新增】乱序手势间隔最小值（秒）
                shuffleIntervalMax: 1.0,       // 【新增】乱序手势间隔最大值（秒）
                scrollSpeed: 2,                // 【新增】整体移动速度（px/帧）
                orderedShuffleRatio: 0.6,      // 乱序中顺序占比（0.6 = 前60%顺序，后40%乱序）
                gestureLabelFontSize: 18       // 【新增】手势名称字体大小（px）
            },
            // 连续手势1采集参数（同心圆引导动画）
            continual_gesture_1: {
                trialsPerStage: 5,             // 每个Stage的动作次数（扩张+收缩为一次）
                stageTimeout: 120,             // Stage超时时间（秒）
                preparationTime: 3.0,          // Stage开始前准备时间（秒）
                preparationTimeMin: 3.0,       // 【新增】准备时间最小值（秒）
                preparationTimeMax: 3.0,       // 【新增】准备时间最大值（秒）
                restBetweenTrials: 1,          // 【新增】试次间隔休息时间（秒）
                expandDuration: 3.0,           // 扩张阶段时长（秒）- 基准时长
                holdDuration: 1.0,             // 保持阶段时长（秒）
                contractDuration: 3.0,         // 收缩阶段时长（秒）- 基准时长
                guideBandWidth: 10,            // 引导区域宽度（像素，半径±此值）
                maxRadius: 150,                // 同心圆最大半径（像素）
                // 【新增】速度变化配置
                speedLevels: [0.5, 1.0, 1.5, 2.0],  // 速度等级（倍率：0.5=慢速2倍时间，2.0=快速一半时间）
                trialSpeedSequence: [],        // 每个Trial的速度等级索引（1-based），空=全部使用1.0倍率
                randomSpeedEnabled: false,
                randomSpeedMin: 0.5,
                randomSpeedMax: 2,
                speedChangeIntervalMin: 0.5,
                speedChangeIntervalMax: 1.5,
                randomPauseEnabled: false,
                pauseDurationMin: 0.3,
                pauseDurationMax: 1.2,
                pauseIntervalMin: 1,
                pauseIntervalMax: 3
            },
            // 连续手势2采集参数（同心圆引导动画）
            continual_gesture_2: {
                trialsPerStage: 5,             // 每个Stage的动作次数
                stageTimeout: 120,             // Stage超时时间（秒）
                preparationTime: 3.0,          // Stage开始前准备时间（秒）
                preparationTimeMin: 3.0,       // 【新增】准备时间最小值（秒）
                preparationTimeMax: 3.0,       // 【新增】准备时间最大值（秒）
                restBetweenTrials: 1,          // 【新增】试次间隔休息时间（秒）
                expandDuration: 3.0,           // 扩张阶段时长（秒）- 基准时长
                holdDuration: 1.0,             // 保持阶段时长（秒）
                contractDuration: 3.0,         // 收缩阶段时长（秒）- 基准时长
                guideBandWidth: 10,            // 引导区域宽度（像素）
                maxRadius: 150,                // 同心圆最大半径（像素）
                // 【新增】速度变化配置
                speedLevels: [0.5, 1.0, 1.5, 2.0],  // 速度等级
                trialSpeedSequence: [],        // 每个Trial的速度等级索引
                randomSpeedEnabled: false,
                randomSpeedMin: 0.5,
                randomSpeedMax: 2,
                speedChangeIntervalMin: 0.5,
                speedChangeIntervalMax: 1.5,
                randomPauseEnabled: false,
                pauseDurationMin: 0.3,
                pauseDurationMax: 1.2,
                pauseIntervalMin: 1,
                pauseIntervalMax: 3
            },
            // 连续手势3采集参数（手掌反转引导）
            continual_gesture_3: {
                trialsPerStage: 10,            // 每个Stage的试次数（完整往返次数）
                stageTimeout: 120,             // Stage超时时间（秒）
                restBetweenTrials: 1,          // 【新增】试次间隔休息时间（秒）
                guideSpeed: 0.15,              // 引导速度（每秒移动的比例，0.1-0.5）
                guideSize: 0.15,               // 引导区域大小（占半圆弧比例，0.1-0.3）
                holdDuration: 1.0,             // 端点停留时间（秒）
                preparationTime: 3.0,          // Stage开始前准备时间（秒）
                preparationTimeMin: 3.0,       // 【新增】准备时间最小值（秒）
                preparationTimeMax: 3.0        // 【新增】准备时间最大值（秒）
            }
        },

        // 受试者信息字段
        subjectFields: [
            { id: 'name', label: '姓名', type: 'text', required: true, placeholder: '请输入姓名' },
            { id: 'id', label: '编号', type: 'text', required: true, placeholder: '如 S001' },
            { id: 'age', label: '年龄', type: 'number', required: true, min: 1, max: 120 },
            { id: 'gender', label: '性别', type: 'select', required: true, options: [
                { value: 'male', label: '男' },
                { value: 'female', label: '女' }
            ]},
            { id: 'hand', label: '惯用手', type: 'select', required: true, options: [
                { value: 'right', label: '右手' },
                { value: 'left', label: '左手' },
                { value: 'both', label: '双手' }
            ]},
            { id: 'height', label: '身高(cm)', type: 'number', required: false, min: 50, max: 250 },
            { id: 'weight', label: '体重(kg)', type: 'number', required: false, min: 20, max: 300 },
            { id: 'bmi', label: 'BMI', type: 'number', required: false, readonly: true },
            { id: 'skinColor', label: '肤色', type: 'select', required: false, options: [
                { value: 'light', label: '浅色' },
                { value: 'medium', label: '中等' },
                { value: 'dark', label: '深色' }
            ]},
            { id: 'hairLevel', label: '毛发程度', type: 'select', required: false, options: [
                { value: 'none', label: '无' },
                { value: 'light', label: '少' },
                { value: 'heavy', label: '多' }
            ]},
            { id: 'armCircumference', label: '前臂围(cm)', type: 'number', required: false, min: 10, max: 60 },
            { id: 'note', label: '备注', type: 'textarea', required: false, placeholder: '其他信息' }
        ]
    };

    // ==================== 配置管理器类 ====================
    class TemplateConfigManager {
        constructor() {
            this.currentTemplate = null;
            this.isDirty = false;  // 是否有未保存的修改
            this.activeTab = 'categories';  // 当前激活的配置标签页
        }

        /**
         * 初始化
         */
        init() {
            console.log('[TemplateConfig] 初始化...');
            this.loadTemplate();
            this.bindEvents();
            this.render();
            // 修复 Electron 打包后偶发输入框无法键入问题：
            // 从 display:none 变为可见的容器中通过 innerHTML 动态创建的 input，
            // 需要一次 body 级别的重排才能被 Chromium 文本输入控制器正确注册。
            // 通过创建一个临时不可见元素触发 layout → 下一帧 clean up。
            const _reflowFix = document.createElement('span');
            _reflowFix.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;';
            document.body.appendChild(_reflowFix);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (_reflowFix.parentNode) _reflowFix.parentNode.removeChild(_reflowFix);
                });
            });
            console.log('[TemplateConfig] 初始化完成');
        }

        /**
         * 加载模板（从localStorage或使用默认）
         */
        loadTemplate() {
            const saved = localStorage.getItem('emg_collection_template');
            if (saved) {
                try {
                    this.currentTemplate = JSON.parse(saved);
                    console.log('[TemplateConfig] 已加载保存的模板:', this.currentTemplate.templateName);
                    
                    // 确保所有必要字段都存在（兼容旧模板）
                    this.ensureTemplateFields();
                } catch (e) {
                    console.warn('[TemplateConfig] 解析模板失败，使用默认模板');
                    this.currentTemplate = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE));
                }
            } else {
                this.currentTemplate = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE));
                console.log('[TemplateConfig] 使用默认模板');
            }
        }

        /**
         * 确保模板包含所有必要字段（用于兼容旧版本模板）
         */
        ensureTemplateFields() {
            // 【新增】检查并补充缺失的 tasks（确保新任务类型存在）
            if (!this.currentTemplate.tasks) {
                console.log('[TemplateConfig] 补充缺失的 tasks');
                this.currentTemplate.tasks = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE.tasks));
            } else {
                // 确保所有任务类型都存在
                const defaultTasks = DEFAULT_TEMPLATE.tasks;
                const existingIds = this.currentTemplate.tasks.map(t => t.id);
                defaultTasks.forEach(defaultTask => {
                    if (!existingIds.includes(defaultTask.id)) {
                        console.log(`[TemplateConfig] 补充缺失的任务: ${defaultTask.id}`);
                        this.currentTemplate.tasks.push(JSON.parse(JSON.stringify(defaultTask)));
                    }
                });
            }
            
            // 【新增】修复手势id：如果id是gesture_时间戳格式，则改为使用name作为id
            if (this.currentTemplate.gestures?.discrete) {
                let needsSave = false;
                this.currentTemplate.gestures.discrete.forEach(gesture => {
                    // 检测gesture_时间戳格式（gesture_后跟13位数字）
                    if (gesture.id && /^gesture_\d{13}$/.test(gesture.id)) {
                        console.log(`[TemplateConfig] 修复手势id: ${gesture.id} -> ${gesture.name}`);
                        gesture.id = gesture.name;
                        needsSave = true;
                    }
                });
                if (needsSave) {
                    console.log('[TemplateConfig] 已自动修复手势id，将保存更新');
                    // 标记需要保存
                    this.isDirty = true;
                    // 立即保存修复后的数据
                    setTimeout(() => this.saveTemplate(), 100);
                }
            }
            
            // 检查并补充 subjectFields
            if (!this.currentTemplate.subjectFields || !Array.isArray(this.currentTemplate.subjectFields)) {
                console.log('[TemplateConfig] 补充缺失的 subjectFields');
                this.currentTemplate.subjectFields = DEFAULT_TEMPLATE.subjectFields.map(f => ({...f}));
            }
            
            // 检查并补充 sessionConfig（v2.1新增）
            if (!this.currentTemplate.sessionConfig) {
                console.log('[TemplateConfig] 补充缺失的 sessionConfig');
                this.currentTemplate.sessionConfig = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE.sessionConfig));
            }
            
            // 检查并补充 categoryLabels
            if (!this.currentTemplate.categoryLabels) {
                console.log('[TemplateConfig] 补充缺失的 categoryLabels');
                this.currentTemplate.categoryLabels = {...DEFAULT_TEMPLATE.categoryLabels};
            }

            // 【新增】确保category3中的每个Stage都有gestures字段
            if (this.currentTemplate.category3 && Array.isArray(this.currentTemplate.category3)) {
                this.currentTemplate.category3.forEach(stage => {
                    if (!Object.prototype.hasOwnProperty.call(stage, 'gestures')) {
                        stage.gestures = [];
                    }
                });
            }

            // 检查并补充 execution（兼容旧版本格式）
            if (!this.currentTemplate.execution) {
                console.log('[TemplateConfig] 补充缺失的 execution');
                this.currentTemplate.execution = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE.execution));
            } else {
                // 检查是否为旧版本格式（非按任务分类）
                if (this.currentTemplate.execution.repeatPerGesture !== undefined) {
                    console.log('[TemplateConfig] 检测到旧版本execution格式，正在迁移...');
                    const oldExec = this.currentTemplate.execution;
                    this.currentTemplate.execution = {
                        discrete_gesture: {
                            repeatPerGesture: oldExec.repeatPerGesture || 5,
                            intervalBetweenRepeat: oldExec.intervalBetweenRepeat || 1.0,
                            restBetweenGestures: oldExec.restBetweenGestures || 30.0,
                            preparationTime: oldExec.preparationTime || 3.0,
                            gestureDisplayTime: oldExec.gestureDisplayTime || 2.0,
                            orderedShuffleRatio: 0.6
                        },
                        continual_gesture_1: {
                            trialsPerStage: 5,
                            stageTimeout: 120,
                            preparationTime: oldExec.preparationTime || 3.0,
                            expandDuration: 3.0,
                            holdDuration: 1.0,
                            contractDuration: 3.0,
                            guideBandWidth: 10,
                            maxRadius: 150
                        },
                        continual_gesture_2: {
                            trialsPerStage: 5,
                            stageTimeout: 120,
                            preparationTime: oldExec.preparationTime || 3.0,
                            expandDuration: 3.0,
                            holdDuration: 1.0,
                            contractDuration: 3.0,
                            guideBandWidth: 10,
                            maxRadius: 150
                        }
                    };
                    console.log('[TemplateConfig] execution格式迁移完成');
                }
                
                // 迁移旧版本的连续手势参数（dwellTime, targetSize）到新的同心圆参数
                ['continual_gesture_1', 'continual_gesture_2'].forEach(taskId => {
                    const taskExec = this.currentTemplate.execution[taskId];
                    if (taskExec) {
                        // 检查是否使用旧版本参数（有dwellTime或targetSize，但没有expandDuration）
                        if ((taskExec.dwellTime !== undefined || taskExec.targetSize !== undefined) && 
                            taskExec.expandDuration === undefined) {
                            console.log(`[TemplateConfig] 迁移${taskId}的旧参数到新同心圆参数`);
                            // 保留可用的参数
                            const trialsPerStage = taskExec.trialsPerStage || 5;
                            const stageTimeout = taskExec.stageTimeout || 120;
                            const preparationTime = taskExec.preparationTime || 3.0;
                            // 使用新的默认值
                            this.currentTemplate.execution[taskId] = {
                                trialsPerStage: trialsPerStage,
                                stageTimeout: stageTimeout,
                                preparationTime: preparationTime,
                                expandDuration: 3.0,
                                holdDuration: 1.0,
                                contractDuration: 3.0,
                                guideBandWidth: 10,
                                maxRadius: 150
                            };
                        }
                    }
                });
                
                // 确保所有任务类型都有配置
                const defaultExec = DEFAULT_TEMPLATE.execution;
                ['discrete_gesture', 'continual_gesture_1', 'continual_gesture_2', 'continual_gesture_3'].forEach(taskId => {
                    if (!this.currentTemplate.execution[taskId]) {
                        this.currentTemplate.execution[taskId] = JSON.parse(JSON.stringify(defaultExec[taskId]));
                    }
                });

                // 确保 discrete_gesture 有 orderedShuffleRatio（旧模板迁移后补字段）
                if (this.currentTemplate.execution.discrete_gesture &&
                    this.currentTemplate.execution.discrete_gesture.orderedShuffleRatio === undefined) {
                    this.currentTemplate.execution.discrete_gesture.orderedShuffleRatio = 0.6;
                    console.log('[TemplateConfig] 补充缺失的 orderedShuffleRatio = 0.6');
                }
            }
            
            // 检查并补充 gestures
            if (!this.currentTemplate.gestures) {
                console.log('[TemplateConfig] 补充缺失的 gestures');
                this.currentTemplate.gestures = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE.gestures));
            }

            // Normalize only the new continuous-guide random fields. Older templates
            // keep their existing settings and get the new toggles defaulted off.
            ['continual_gesture_1', 'continual_gesture_2'].forEach(taskId => {
                const taskConfig = this.currentTemplate.execution[taskId];
                const defaults = DEFAULT_TEMPLATE.execution[taskId];
                taskConfig.randomSpeedEnabled = taskConfig.randomSpeedEnabled === true;
                taskConfig.randomPauseEnabled = taskConfig.randomPauseEnabled === true;

                const bounds = {
                    randomSpeedMin: [0.01, 100], randomSpeedMax: [0.01, 100],
                    speedChangeIntervalMin: [0.1, 86400], speedChangeIntervalMax: [0.1, 86400],
                    pauseDurationMin: [0.01, 86400], pauseDurationMax: [0.01, 86400],
                    pauseIntervalMin: [0.1, 86400], pauseIntervalMax: [0.1, 86400]
                };
                Object.entries(bounds).forEach(([field, [min, max]]) => {
                    const value = taskConfig[field];
                    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || !Number.isFinite(value * 1000)) {
                        taskConfig[field] = defaults[field];
                    }
                });

                [
                    ['randomSpeedMin', 'randomSpeedMax'],
                    ['speedChangeIntervalMin', 'speedChangeIntervalMax'],
                    ['pauseDurationMin', 'pauseDurationMax'],
                    ['pauseIntervalMin', 'pauseIntervalMax']
                ].forEach(([minField, maxField]) => {
                    if (taskConfig[minField] > taskConfig[maxField]) {
                        [taskConfig[minField], taskConfig[maxField]] = [taskConfig[maxField], taskConfig[minField]];
                    }
                });
            });
        }

        getEnabledDiscreteGestures() {
            return (this.currentTemplate.gestures?.discrete || []).filter(g => g.enabled);
        }

        getStageGestureIds(stage) {
            if (!stage || !Array.isArray(stage.gestures)) {
                return [];
            }

            return stage.gestures
                .map(gesture => {
                    if (typeof gesture === 'string') return gesture;
                    if (gesture && typeof gesture === 'object') return gesture.id || gesture.name;
                    return null;
                })
                .filter(Boolean);
        }

        getValidStageGestureIds(stage, allGestures = this.getEnabledDiscreteGestures()) {
            const enabledGestureIds = new Set(allGestures.map(g => g.id));
            const validIds = [];
            const seenIds = new Set();

            this.getStageGestureIds(stage).forEach(id => {
                if (enabledGestureIds.has(id) && !seenIds.has(id)) {
                    validIds.push(id);
                    seenIds.add(id);
                }
            });

            return validIds;
        }

        /**
         * 保存模板到localStorage
         */
        saveTemplate() {
            this.currentTemplate.lastModified = new Date().toISOString();
            localStorage.setItem('emg_collection_template', JSON.stringify(this.currentTemplate));
            this.isDirty = false;
            this.showToast('模板已保存到本地', 'success');
            console.log('[TemplateConfig] 模板已保存到localStorage');
        }

        /**
         * 保存模板到服务器 config/ 目录
         */
        async saveTemplateToServer() {
            this.currentTemplate.lastModified = new Date().toISOString();
            
            // 生成文件名：模板名称_日期.json
            const safeName = this.currentTemplate.templateName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_');
            const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
            const filename = `${safeName}_${dateStr}.json`;
            
            try {
                const response = await fetch('/api/config/save', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        filename: filename,
                        config: this.currentTemplate
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    // 同时保存到localStorage
                    localStorage.setItem('emg_collection_template', JSON.stringify(this.currentTemplate));
                    this.isDirty = false;
                    this.showToast(`已保存到 config/${result.filename}`, 'success');
                    console.log('[TemplateConfig] 模板已保存到服务器:', result.filename);
                } else {
                    this.showToast('保存失败: ' + result.error, 'error');
                }
            } catch (err) {
                console.error('[TemplateConfig] 保存到服务器失败:', err);
                // 回退到本地保存
                this.saveTemplate();
                this.showToast('服务器保存失败，已保存到本地', 'warning');
            }
        }

        /**
         * 导出模板为JSON文件
         */
        exportTemplate() {
            const dataStr = JSON.stringify(this.currentTemplate, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = `${this.currentTemplate.templateName}_${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            this.showToast('模板已导出', 'success');
        }

        /**
         * 导入模板
         */
        importTemplate(file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const template = JSON.parse(e.target.result);
                    // 验证模板格式
                    if (!template.templateName || !template.category1) {
                        throw new Error('无效的模板格式');
                    }
                    this.currentTemplate = template;
                    this.ensureTemplateFields();
                    this.isDirty = true;
                    this.render();
                    this.showToast('模板已导入', 'success');
                } catch (err) {
                    this.showToast('导入失败: ' + err.message, 'error');
                }
            };
            reader.readAsText(file);
        }

        /**
         * 重置为默认模板
         */
        async resetToDefault() {
            const confirmed = await this.showConfirm('确定要重置为默认模板吗？当前的修改将丢失。');
            if (confirmed) {
                this.currentTemplate = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE));
                this.isDirty = true;
                this.render();
                this.showToast('已重置为默认模板', 'success');
            }
        }

        /**
         * 绑定事件
         */
        bindEvents() {
            // 标签页切换
            document.querySelectorAll('.config-tab-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const tab = e.currentTarget.dataset.tab;
                    this.switchTab(tab);
                });
            });

            // 保存按钮 - 保存到服务器
            const saveBtn = document.getElementById('saveTemplateBtn');
            if (saveBtn) {
                saveBtn.addEventListener('click', () => this.saveTemplateToServer());
            }

            // 导出按钮
            const exportBtn = document.getElementById('exportTemplateBtn');
            if (exportBtn) {
                exportBtn.addEventListener('click', () => this.exportTemplate());
            }

            // 导入按钮
            const importBtn = document.getElementById('importTemplateBtn');
            const importInput = document.getElementById('importTemplateInput');
            if (importBtn && importInput) {
                importBtn.addEventListener('click', () => importInput.click());
                importInput.addEventListener('change', (e) => {
                    if (e.target.files.length > 0) {
                        this.importTemplate(e.target.files[0]);
                        e.target.value = '';  // 清空以便再次选择同一文件
                    }
                });
            }

            // 重置按钮
            const resetBtn = document.getElementById('resetTemplateBtn');
            if (resetBtn) {
                resetBtn.addEventListener('click', () => this.resetToDefault());
            }

            // 模板名称输入
            const nameInput = document.getElementById('templateNameInput');
            if (nameInput) {
                nameInput.addEventListener('change', (e) => {
                    this.currentTemplate.templateName = e.target.value.trim() || '未命名模板';
                    this.isDirty = true;
                });
            }
        }

        /**
         * 切换标签页
         */
        switchTab(tabName) {
            this.activeTab = tabName;
            
            // 更新标签按钮状态
            document.querySelectorAll('.config-tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === tabName);
            });

            // 更新内容区域
            document.querySelectorAll('.config-tab-content').forEach(content => {
                content.classList.toggle('active', content.dataset.tab === tabName);
            });

            // 渲染对应内容
            this.renderTabContent(tabName);
        }

        /**
         * 主渲染函数
         */
        render() {
            // 渲染模板名称
            const nameInput = document.getElementById('templateNameInput');
            if (nameInput) {
                nameInput.value = this.currentTemplate.templateName;
            }

            // 渲染当前标签页内容
            this.renderTabContent(this.activeTab);
        }

        /**
         * 渲染标签页内容
         */
        renderTabContent(tabName) {
            switch (tabName) {
                case 'categories':
                    this.renderCategoriesTab();
                    break;
                case 'gestures':
                    this.renderGesturesTab();
                    break;
                case 'execution':
                    this.renderExecutionTab();
                    break;
                case 'subject':
                    this.renderSubjectTab();
                    break;
            }
        }

        /**
         * 渲染分类配置标签页
         */
        renderCategoriesTab() {
            const container = document.getElementById('categoriesTabContent');
            if (!container) return;

            const template = this.currentTemplate;
            
            container.innerHTML = `
                <!-- Session配置 -->
                <div class="config-section">
                    <div class="config-section-header">
                        <h3><i class="fa fa-sync-alt"></i> Session配置（穿戴次数）</h3>
                    </div>
                    <div class="session-config-block">
                        <p class="config-hint" style="margin-bottom: 12px;">
                            ${template.sessionConfig?.description || '每个Session代表一个采集轮次，用于多轮次数据采集'}
                        </p>
                        <div class="session-count-input-group">
                            <label for="sessionCountInput">Session数量：</label>
                            <input type="number" id="sessionCountInput" class="session-count-input"
                                   value="${template.sessionConfig?.count || 3}" min="1" max="20" step="1">
                            <span class="session-count-hint">（1-20之间）</span>
                        </div>
                        <div class="session-count-input-group" style="margin-top: 12px;">
                            <label for="sessionRestTimeInput">轮次间休息时间：</label>
                            <input type="number" id="sessionRestTimeInput" class="session-count-input"
                                   value="${template.sessionConfig?.restBetweenSessions || 30}" min="5" max="300" step="5">
                            <span class="session-count-hint">秒（全部轮次采集时，轮次之间的休息时间）</span>
                        </div>
                    </div>
                </div>

                <!-- 采集任务及手势库 -->
                <div class="config-section">
                    <div class="config-section-header">
                        <h3><i class="fa fa-tasks"></i> 采集任务与手势库</h3>
                    </div>
                    
                    <!-- 离散手势采集任务 -->
                    <div class="task-config-block">
                        <div class="task-header">
                            <label class="config-item-checkbox task-checkbox">
                                <input type="checkbox" data-category="tasks" data-id="discrete_gesture" 
                                       ${template.tasks.find(t => t.id === 'discrete_gesture')?.enabled ? 'checked' : ''}>
                                <span class="checkbox-label task-name">离散手势采集</span>
                            </label>
                            <span class="task-gesture-count">${template.gestures.discrete.filter(g => g.enabled).length}/${template.gestures.discrete.length} 个手势已启用</span>
                        </div>
                        <div class="task-gestures-grid" id="discreteGesturesGrid">
                            ${template.gestures.discrete.map((gesture, index) => `
                                <div class="gesture-chip ${gesture.enabled ? 'enabled' : 'disabled'}"
                                     data-gesture-type="discrete" data-index="${index}">
                                    <div class="gesture-chip-tooltip">
                                        <div class="tooltip-title">${gesture.icon} ${gesture.name}</div>
                                        <div class="tooltip-row">
                                            <span class="tooltip-label">ID:</span>
                                            <span class="tooltip-value">${gesture.id}</span>
                                        </div>
                                        <div class="tooltip-row">
                                            <span class="tooltip-label">类型:</span>
                                            <span class="tooltip-value">${gesture.gestureType === 'sustained' ? '持续手势' : '瞬时手势'}</span>
                                        </div>
                                        ${gesture.gifFile ? `<div class="tooltip-row">
                                            <span class="tooltip-label">GIF:</span>
                                            <span class="tooltip-value">${gesture.gifFile}</span>
                                        </div>` : ''}
                                        <div class="tooltip-row">
                                            <span class="tooltip-label">状态:</span>
                                            <span class="tooltip-value">${gesture.enabled ? '✓ 已启用' : '✗ 已禁用'}</span>
                                        </div>
                                        <div class="tooltip-hint">点击${gesture.enabled ? '禁用' : '启用'}此手势</div>
                                    </div>
                                    <span class="gesture-chip-toggle-indicator">
                                        <i class="fa ${gesture.enabled ? 'fa-check-circle' : 'fa-circle-o'}"></i>
                                    </span>
                                    <span class="gesture-chip-icon">${gesture.icon}</span>
                                    <span class="gesture-chip-name">${gesture.name}</span>
                                </div>
                            `).join('')}
                            <button class="gesture-chip add-gesture-chip" data-gesture-type="discrete">
                                <i class="fa fa-plus"></i> 添加手势
                            </button>
                        </div>
                    </div>

                    <!-- 连续手势采集1 -->
                    <div class="task-config-block">
                        <div class="task-header">
                            <label class="config-item-checkbox task-checkbox">
                                <input type="checkbox" data-category="tasks" data-id="continual_gesture_1" 
                                       ${template.tasks.find(t => t.id === 'continual_gesture_1')?.enabled ? 'checked' : ''}>
                                <span class="checkbox-label task-name">连续手势采集1（滚轮控制）</span>
                            </label>
                        </div>
                        <p class="task-description">滚轮控制光标移动到目标位置的任务，不需要配置手势库</p>
                    </div>

                    <!-- 连续手势采集2 -->
                    <div class="task-config-block">
                        <div class="task-header">
                            <label class="config-item-checkbox task-checkbox">
                                <input type="checkbox" data-category="tasks" data-id="continual_gesture_2" 
                                       ${template.tasks.find(t => t.id === 'continual_gesture_2')?.enabled ? 'checked' : ''}>
                                <span class="checkbox-label task-name">连续手势采集2（手腕控制）</span>
                            </label>
                        </div>
                        <p class="task-description">手腕动作控制光标移动到目标位置的任务，不需要配置手势库</p>
                    </div>

                    <!-- 连续手势采集3 -->
                    <div class="task-config-block">
                        <div class="task-header">
                            <label class="config-item-checkbox task-checkbox">
                                <input type="checkbox" data-category="tasks" data-id="continual_gesture_3" 
                                       ${template.tasks.find(t => t.id === 'continual_gesture_3')?.enabled ? 'checked' : ''}>
                                <span class="checkbox-label task-name">连续手势采集3（自定义控制）</span>
                            </label>
                        </div>
                        <p class="task-description">自定义方式控制光标移动到目标位置的任务，不需要配置手势库</p>
                    </div>
                </div>

                <!-- 分类1: 大类 -->
                <div class="config-section">
                    <div class="config-section-header">
                        <h3><i class="fa fa-layer-group"></i> 
                            <input type="text" class="category-label-input" data-category-label="category1" 
                                   value="${template.categoryLabels.category1}" placeholder="分类1名称">
                        </h3>
                        <button class="config-add-btn" data-add-category="category1">
                            <i class="fa fa-plus"></i> 添加
                        </button>
                    </div>
                    <div class="config-items-list" data-category="category1">
                        ${template.category1.map((item, index) => this.renderCategoryItem('category1', item, index)).join('')}
                    </div>
                </div>

                <!-- 分类2: 大场景 -->
                <div class="config-section">
                    <div class="config-section-header">
                        <h3><i class="fa fa-map-marker-alt"></i>
                            <input type="text" class="category-label-input" data-category-label="category2"
                                   value="${template.categoryLabels.category2}" placeholder="分类2名称">
                        </h3>
                        <button class="config-add-btn" data-add-category="category2">
                            <i class="fa fa-plus"></i> 添加
                        </button>
                    </div>
                    <div class="config-items-list" data-category="category2">
                        ${template.category2.map((item, index) => this.renderCategoryItem('category2', item, index)).join('')}
                    </div>
                </div>

                <!-- 分类3: 子场景/Stage -->
                <div class="config-section">
                    <div class="config-section-header">
                        <h3><i class="fa fa-hand-paper"></i>
                            <input type="text" class="category-label-input" data-category-label="category3"
                                   value="${template.categoryLabels.category3}" placeholder="分类3名称">
                        </h3>
                        <button class="config-add-btn" data-add-category="category3">
                            <i class="fa fa-plus"></i> 添加
                        </button>
                    </div>
                    <p class="config-hint">子场景将按顺序执行，采集时不需要选择</p>
                    <div class="config-items-list sortable" data-category="category3">
                        ${template.category3.map((item, index) => this.renderStageItem(item, index)).join('')}
                    </div>
                </div>

                <!-- 分类4: 人群 -->
                <div class="config-section">
                    <div class="config-section-header">
                        <h3><i class="fa fa-users"></i>
                            <input type="text" class="category-label-input" data-category-label="category4"
                                   value="${template.categoryLabels.category4}" placeholder="分类4名称">
                        </h3>
                        <button class="config-add-btn" data-add-category="category4">
                            <i class="fa fa-plus"></i> 添加
                        </button>
                    </div>
                    <div class="config-items-list" data-category="category4">
                        ${template.category4.map((item, index) => this.renderCategoryItem('category4', item, index)).join('')}
                    </div>
                </div>
            `;

            // 绑定分类配置事件
            this.bindCategoryEvents(container);
        }

        /**
         * 渲染分类项
         */
        renderCategoryItem(category, item, index) {
            return `
                <div class="config-item" data-index="${index}">
                    <div class="config-item-drag">
                        <i class="fa fa-grip-vertical"></i>
                    </div>
                    <label class="config-item-checkbox">
                        <input type="checkbox" data-category="${category}" data-index="${index}" 
                               data-field="enabled" ${item.enabled ? 'checked' : ''}>
                    </label>
                    <input type="text" class="config-item-input" data-category="${category}" 
                           data-index="${index}" data-field="name" value="${item.name}" placeholder="名称">
                    <button class="config-item-delete" data-category="${category}" data-index="${index}">
                        <i class="fa fa-trash"></i>
                    </button>
                </div>
            `;
        }

        /**
         * 渲染Stage项（带指导语和手势选择）
         */
        renderStageItem(item, index) {
            // 获取该Stage已勾选的手势数量
            const allEnabledGestures = this.getEnabledDiscreteGestures();
            const enabledGesturesCount = this.getValidStageGestureIds(item, allEnabledGestures).length;
            // 根据是否配置了手势决定按钮颜色
            const btnBg = enabledGesturesCount > 0 ? '#1e88e5' : '#e0e0e0';
            const btnColor = enabledGesturesCount > 0 ? 'white' : '#666';

            // 【新增】动捕勾选框状态
            const needMocap = item.needMocap || false;

            // 【新增】乱序勾选框状态
            const shuffleGestures = item.shuffleGestures || false;

            return `
                <div class="config-item config-item-stage" data-index="${index}">
                    <div class="config-item-drag">
                        <i class="fa fa-grip-vertical"></i>
                    </div>
                    <label class="config-item-checkbox">
                        <input type="checkbox" data-category="category3" data-index="${index}"
                               data-field="enabled" ${item.enabled ? 'checked' : ''}>
                    </label>
                    <div class="config-item-fields">
                        <input type="text" class="config-item-input" data-category="category3"
                               data-index="${index}" data-field="name" value="${item.name}" placeholder="名称">
                        <input type="text" class="config-item-input config-item-instruction" data-category="category3"
                               data-index="${index}" data-field="instruction" value="${item.instruction || ''}" placeholder="指导语">
                    </div>
                    <!-- 【新增】动捕勾选框 -->
                    <label class="stage-mocap-checkbox" title="勾选后该子场景采集时会记录动捕数据"
                           style="display: flex; align-items: center; gap: 4px; padding: 4px 8px; background: ${needMocap ? '#e8f5e9' : '#f5f5f5'}; border: 1px solid ${needMocap ? '#4caf50' : '#ddd'}; border-radius: 4px; cursor: pointer; font-size: 11px; white-space: nowrap;">
                        <input type="checkbox" data-category="category3" data-index="${index}"
                               data-field="needMocap" ${needMocap ? 'checked' : ''}
                               style="margin: 0; cursor: pointer;">
                        <i class="fa fa-video" style="color: ${needMocap ? '#4caf50' : '#999'};"></i>
                        <span style="color: ${needMocap ? '#2e7d32' : '#666'};">动捕</span>
                    </label>
                    <!-- 【新增】乱序勾选框 -->
                    <label class="stage-shuffle-checkbox" title="勾选后该子场景的手势将随机打乱顺序执行"
                           style="display: flex; align-items: center; gap: 4px; padding: 4px 8px; background: ${shuffleGestures ? '#fff3e0' : '#f5f5f5'}; border: 1px solid ${shuffleGestures ? '#ff9800' : '#ddd'}; border-radius: 4px; cursor: pointer; font-size: 11px; white-space: nowrap;">
                        <input type="checkbox" data-category="category3" data-index="${index}"
                               data-field="shuffleGestures" ${shuffleGestures ? 'checked' : ''}
                               style="margin: 0; cursor: pointer;">
                        <i class="fa fa-random" style="color: ${shuffleGestures ? '#ff9800' : '#999'};"></i>
                        <span style="color: ${shuffleGestures ? '#e65100' : '#666'};">乱序</span>
                    </label>
                    <button class="stage-gestures-btn" data-stage-index="${index}" title="配置该子场景的手势库"
                            style="display: flex; align-items: center; gap: 4px; padding: 6px 10px; background: ${btnBg}; color: ${btnColor}; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; white-space: nowrap;">
                        <i class="fa fa-hand-paper"></i>
                        <span class="gesture-count">${enabledGesturesCount}/${allEnabledGestures.length}</span>
                    </button>
                    <button class="config-item-delete" data-category="category3" data-index="${index}">
                        <i class="fa fa-trash"></i>
                    </button>
                </div>
            `;
        }

        /**
         * 绑定分类配置事件
         */
        bindCategoryEvents(container) {
            // Session数量变化
            const sessionCountInput = container.querySelector('#sessionCountInput');
            if (sessionCountInput) {
                sessionCountInput.addEventListener('change', (e) => {
                    const count = parseInt(e.target.value);
                    if (count >= 1 && count <= 20) {
                        if (!this.currentTemplate.sessionConfig) {
                            this.currentTemplate.sessionConfig = { count: 3, description: '', restBetweenSessions: 30 };
                        }
                        this.currentTemplate.sessionConfig.count = count;
                        this.isDirty = true;
                        console.log('[TemplateConfig] Session数量已更新为:', count);
                    } else {
                        e.target.value = this.currentTemplate.sessionConfig?.count || 3;
                        this.showToast('Session数量必须在1-20之间', 'warning');
                    }
                });
            }

            // 【新增】Session间休息时间变化
            const sessionRestTimeInput = container.querySelector('#sessionRestTimeInput');
            if (sessionRestTimeInput) {
                sessionRestTimeInput.addEventListener('change', (e) => {
                    const restTime = parseInt(e.target.value);
                    if (restTime >= 5 && restTime <= 300) {
                        if (!this.currentTemplate.sessionConfig) {
                            this.currentTemplate.sessionConfig = { count: 3, description: '', restBetweenSessions: 30 };
                        }
                        this.currentTemplate.sessionConfig.restBetweenSessions = restTime;
                        this.isDirty = true;
                        console.log('[TemplateConfig] Session间休息时间已更新为:', restTime, '秒');
                    } else {
                        e.target.value = this.currentTemplate.sessionConfig?.restBetweenSessions || 30;
                        this.showToast('休息时间必须在5-300秒之间', 'warning');
                    }
                });
            }

            // 复选框变化
            container.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
                checkbox.addEventListener('change', (e) => {
                    const { category, id, index, field } = e.target.dataset;

                    if (category === 'tasks') {
                        const task = this.currentTemplate.tasks.find(t => t.id === id);
                        if (task) task.enabled = e.target.checked;
                    } else if (index !== undefined) {
                        this.currentTemplate[category][index][field || 'enabled'] = e.target.checked;
                    }
                    this.isDirty = true;

                    // 【新增】如果是needMocap或shuffleGestures字段变化，重新渲染以更新UI样式
                    if (field === 'needMocap' || field === 'shuffleGestures') {
                        this.renderCategoriesTab();
                    }
                });
            });

            // 文本输入变化
            container.querySelectorAll('input[type="text"].config-item-input').forEach(input => {
                input.addEventListener('change', (e) => {
                    const { category, index, field } = e.target.dataset;
                    if (category && index !== undefined && field) {
                        const newValue = e.target.value.trim();
                        this.currentTemplate[category][index][field] = newValue;
                        
                        // 如果修改的是name字段，同步更新id（支持中文目录）
                        if (field === 'name' && newValue) {
                            this.currentTemplate[category][index].id = newValue;
                        }
                        
                        this.isDirty = true;
                    }
                });
            });

            // 分类标签名称变化
            container.querySelectorAll('.category-label-input').forEach(input => {
                input.addEventListener('change', (e) => {
                    const categoryLabel = e.target.dataset.categoryLabel;
                    if (categoryLabel) {
                        this.currentTemplate.categoryLabels[categoryLabel] = e.target.value.trim();
                        this.isDirty = true;
                    }
                });
            });

            // 添加按钮
            container.querySelectorAll('[data-add-category]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const category = e.currentTarget.dataset.addCategory;
                    this.addCategoryItem(category);
                });
            });

            // 删除按钮
            container.querySelectorAll('.config-item-delete').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const { category, index } = e.currentTarget.dataset;
                    this.deleteCategoryItem(category, parseInt(index));
                });
            });

            // 【新增】Stage手势配置按钮
            const stageGesturesBtns = container.querySelectorAll('.stage-gestures-btn');
            console.log('[TemplateConfig] 找到 stage-gestures-btn 数量:', stageGesturesBtns.length);
            stageGesturesBtns.forEach(btn => {
                console.log('[TemplateConfig] 绑定点击事件到按钮:', btn, 'stageIndex:', btn.dataset.stageIndex);
                btn.addEventListener('click', (e) => {
                    console.log('[TemplateConfig] stage-gestures-btn 被点击! stageIndex:', e.currentTarget.dataset.stageIndex);
                    e.stopPropagation();
                    const stageIndex = parseInt(e.currentTarget.dataset.stageIndex);
                    this.showStageGesturesDialog(stageIndex);
                });
            });

            // ========== 手势相关事件 ==========
            
            // 手势卡片点击切换启用状态 - 整个卡片都可以点击
            container.querySelectorAll('.gesture-chip:not(.add-gesture-chip)').forEach(chip => {
                chip.addEventListener('click', (e) => {
                    const gestureType = chip.dataset.gestureType;
                    const index = parseInt(chip.dataset.index);
                    
                    if (gestureType === 'discrete') {
                        this.currentTemplate.gestures.discrete[index].enabled = 
                            !this.currentTemplate.gestures.discrete[index].enabled;
                        this.isDirty = true;
                        
                        // 添加点击反馈动画
                        chip.style.transform = 'scale(0.95)';
                        setTimeout(() => {
                            chip.style.transform = '';
                            this.renderCategoriesTab();
                        }, 100);
                    }
                });
            });

            // 添加手势按钮
            container.querySelectorAll('.add-gesture-chip').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const gestureType = e.currentTarget.dataset.gestureType;
                    this.showAddGestureDialog(gestureType);
                });
            });
        }

        /**
         * 显示添加手势对话框
         */
        async showAddGestureDialog(gestureType) {
            const name = await this.showPrompt('请输入手势名称：');
            if (name && name.trim()) {
                const trimmedName = name.trim();
                const icon = await this.showPrompt('请输入手势图标（emoji）：', '✋');

                this.currentTemplate.gestures[gestureType].push({
                    id: trimmedName,  // 使用名称作为id
                    name: trimmedName,
                    icon: icon || '✋',
                    enabled: true
                });
                this.isDirty = true;
                this.renderCategoriesTab();
                this.showToast('手势已添加', 'success');
            }
        }

        /**
         * 【新增】显示Stage手势配置对话框
         * @param {number} stageIndex - Stage索引
         */
        showStageGesturesDialog(stageIndex) {
            console.log('[TemplateConfig] showStageGesturesDialog 被调用, stageIndex:', stageIndex);
            console.log('[TemplateConfig] currentTemplate:', this.currentTemplate);
            console.log('[TemplateConfig] category3:', this.currentTemplate?.category3);

            const stage = this.currentTemplate.category3[stageIndex];
            console.log('[TemplateConfig] stage:', stage);
            if (!stage) {
                console.log('[TemplateConfig] stage为空，退出');
                return;
            }

            // 【修改】只显示已启用的手势，而不是全部手势
            const allGestures = this.getEnabledDiscreteGestures();
            const stageGestureIds = this.getValidStageGestureIds(stage, allGestures);

            // 创建对话框 - 注意：不使用 modal-overlay 类，因为该类有 opacity:0 visibility:hidden
            const overlay = document.createElement('div');
            overlay.className = 'stage-gestures-modal-overlay';
            overlay.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 10000; display: flex; justify-content: center; align-items: center;';

            const dialog = document.createElement('div');
            dialog.className = 'stage-gestures-dialog';
            dialog.style.cssText = 'background: white; border-radius: 12px; max-width: 600px; width: 90%; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,0.3);';

            dialog.innerHTML = `
                <div style="padding: 20px 24px; border-bottom: 1px solid #e9ecef; display: flex; justify-content: space-between; align-items: center;">
                    <h3 style="margin: 0; font-size: 18px; color: #333;">
                        <i class="fa fa-hand-paper" style="color: #1e88e5; margin-right: 8px;"></i>
                        配置手势库 - ${stage.name}
                    </h3>
                    <button class="close-dialog-btn" style="background: none; border: none; font-size: 24px; cursor: pointer; color: #999; padding: 0; line-height: 1;">&times;</button>
                </div>
                <div style="padding: 16px 24px; border-bottom: 1px solid #e9ecef; background: #f8f9fa;">
                    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                        <button class="select-all-btn" style="padding: 6px 12px; background: #1e88e5; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
                            <i class="fa fa-check-double"></i> 全选
                        </button>
                        <button class="select-none-btn" style="padding: 6px 12px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px;">
                            <i class="fa fa-times"></i> 全不选
                        </button>
                        <span style="margin-left: auto; color: #666; font-size: 13px; line-height: 32px;">
                            已选 <span class="selected-count">${stageGestureIds.length}</span>/${allGestures.length} 个手势
                        </span>
                    </div>
                </div>
                <div class="gestures-grid" style="padding: 20px 24px; overflow-y: auto; flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px;">
                    ${allGestures.map((gesture, idx) => {
                        const isSelected = stageGestureIds.includes(gesture.id);
                        return `
                            <label class="gesture-select-item" data-gesture-id="${gesture.id}" style="
                                display: flex; align-items: center; gap: 8px; padding: 10px 12px;
                                border: 2px solid ${isSelected ? '#1e88e5' : '#e0e0e0'};
                                background: ${isSelected ? '#e3f2fd' : 'white'};
                                border-radius: 8px; cursor: pointer; transition: all 0.2s;
                            ">
                                <input type="checkbox" data-gesture-id="${gesture.id}" ${isSelected ? 'checked' : ''}
                                       style="width: 16px; height: 16px; cursor: pointer;">
                                <span style="font-size: 18px;">${gesture.icon || '✋'}</span>
                                <span style="flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${gesture.name}</span>
                            </label>
                        `;
                    }).join('')}
                </div>
                <div style="padding: 16px 24px; border-top: 1px solid #e9ecef; display: flex; justify-content: flex-end; gap: 10px;">
                    <button class="cancel-btn" style="padding: 10px 24px; background: #f5f5f5; color: #333; border: 1px solid #ddd; border-radius: 6px; cursor: pointer; font-size: 14px;">取消</button>
                    <button class="confirm-btn" style="padding: 10px 24px; background: #1e88e5; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500;">确定</button>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            console.log('[TemplateConfig] 对话框已添加到DOM, overlay:', overlay);

            // 更新选中计数
            const updateCount = () => {
                const count = dialog.querySelectorAll('input[type="checkbox"]:checked').length;
                dialog.querySelector('.selected-count').textContent = count;
            };

            // 绑定事件
            dialog.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    const item = e.target.closest('.gesture-select-item');
                    if (e.target.checked) {
                        item.style.borderColor = '#1e88e5';
                        item.style.background = '#e3f2fd';
                    } else {
                        item.style.borderColor = '#e0e0e0';
                        item.style.background = 'white';
                    }
                    updateCount();
                });
            });

            // 点击整个label也切换checkbox
            dialog.querySelectorAll('.gesture-select-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.tagName !== 'INPUT') {
                        const cb = item.querySelector('input[type="checkbox"]');
                        cb.checked = !cb.checked;
                        cb.dispatchEvent(new Event('change'));
                    }
                });
            });

            // 全选
            dialog.querySelector('.select-all-btn').addEventListener('click', () => {
                dialog.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('change'));
                });
            });

            // 全不选
            dialog.querySelector('.select-none-btn').addEventListener('click', () => {
                dialog.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    cb.checked = false;
                    cb.dispatchEvent(new Event('change'));
                });
            });

            // 关闭
            const closeDialog = () => {
                overlay.remove();
            };

            dialog.querySelector('.close-dialog-btn').addEventListener('click', closeDialog);
            dialog.querySelector('.cancel-btn').addEventListener('click', closeDialog);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeDialog();
            });

            // 确定
            dialog.querySelector('.confirm-btn').addEventListener('click', () => {
                const selectedIds = [];
                dialog.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
                    selectedIds.push(cb.dataset.gestureId);
                });

                // 保存到stage
                this.currentTemplate.category3[stageIndex].gestures = selectedIds;
                this.isDirty = true;

                closeDialog();
                this.renderCategoriesTab();
                this.showToast(`已更新 "${stage.name}" 的手势库 (${selectedIds.length}个)`, 'success');
            });
        }

        /**
         * 添加分类项
         */
        async addCategoryItem(category) {
            // 弹出对话框让用户输入名称
            const name = await this.showPrompt('请输入名称：');
            if (!name || !name.trim()) {
                return; // 用户取消或未输入
            }
            
            const trimmedName = name.trim();
            
            // 使用名称作为id（支持中文），同时添加时间戳确保唯一性
            const newItem = {
                id: trimmedName,  // 直接使用名称作为id，支持中文目录
                name: trimmedName,
                enabled: true
            };

            if (category === 'category3') {
                const instruction = await this.showPrompt('请输入指导语（可选）：', '');
                newItem.instruction = instruction || '';
                newItem.gestures = [];  // 【新增】初始化空手势列表
            }
            if (category === 'category4') {
                newItem.description = '';
            }

            this.currentTemplate[category].push(newItem);
            this.isDirty = true;
            this.renderCategoriesTab();
            this.showToast(`已添加: ${trimmedName}`, 'success');
        }

        /**
         * 删除分类项
         */
        async deleteCategoryItem(category, index) {
            const confirmed = await this.showConfirm('确定要删除这个项目吗？');
            if (confirmed) {
                this.currentTemplate[category].splice(index, 1);
                this.isDirty = true;
                this.renderCategoriesTab();
            }
        }

        /**
         * 渲染手势库标签页
         */
        renderGesturesTab() {
            const container = document.getElementById('gesturesTabContent');
            if (!container) return;

            const gestures = this.currentTemplate.gestures.discrete;
            const continualGestures = this.currentTemplate.gestures;

            container.innerHTML = `
                <div class="config-section">
                    <div class="config-section-header">
                        <h3><i class="fa fa-hand-paper"></i> 离散手势库</h3>
                        <div class="gesture-add-btns">
                            <button class="config-add-btn" id="addInstantGestureBtn">
                                <i class="fa fa-bolt"></i> 添加瞬时手势
                            </button>
                            <button class="config-add-btn config-add-btn-sustained" id="addSustainedGestureBtn">
                                <i class="fa fa-arrows-alt-h"></i> 添加持续手势
                            </button>
                        </div>
                    </div>
                    <p class="config-hint">
                        <span class="gesture-type-legend">
                            <span class="type-instant"><i class="fa fa-bolt"></i> 瞬时</span>
                            <span class="type-sustained"><i class="fa fa-arrows-alt-h"></i> 持续</span>
                        </span>
                        勾选启用的手势。持续手势会显示横向长方形，触发 _start 和 _end 两个标签。
                    </p>
                    <div class="config-gestures-grid">
                        ${gestures.map((gesture, index) => `
                            <div class="config-gesture-item ${gesture.enabled ? 'enabled' : 'disabled'} ${gesture.gestureType === 'sustained' ? 'gesture-sustained' : 'gesture-instant'}">
                                <label class="gesture-checkbox">
                                    <input type="checkbox" data-index="${index}" ${gesture.enabled ? 'checked' : ''}>
                                    <span class="gesture-icon" data-index="${index}" title="点击修改图标">${gesture.icon}</span>
                                </label>
                                <div class="gesture-type-badge" title="${gesture.gestureType === 'sustained' ? '持续手势' : '瞬时手势'}">
                                    <i class="fa ${gesture.gestureType === 'sustained' ? 'fa-arrows-alt-h' : 'fa-bolt'}"></i>
                                </div>
                                <input type="text" class="gesture-name-input" data-index="${index}"
                                       value="${gesture.name}" placeholder="手势名称" title="手势名称">
                                <select class="gesture-type-select" data-index="${index}" title="手势类型">
                                    <option value="instant" ${gesture.gestureType !== 'sustained' ? 'selected' : ''}>瞬时</option>
                                    <option value="sustained" ${gesture.gestureType === 'sustained' ? 'selected' : ''}>持续</option>
                                </select>
                                ${gesture.gestureType === 'sustained' ? `
                                <div class="gesture-duration-wrapper" title="持续时间（秒），留空则使用执行参数中的默认值">
                                    <input type="number" class="gesture-duration-input" data-index="${index}"
                                           value="${gesture.duration || ''}" placeholder="时长" min="0.5" max="30" step="0.5">
                                    <span class="duration-unit">秒</span>
                                </div>
                                ` : ''}
                                <button class="gesture-gif-btn" data-index="${index}" title="点击选择GIF文件">
                                    ${gesture.gifFile ? `📁 ${gesture.gifFile}` : '📁 选择GIF'}
                                </button>
                                <button class="gesture-delete-btn" data-index="${index}">
                                    <i class="fa fa-times"></i>
                                </button>
                            </div>
                        `).join('')}
                    </div>
                </div>

                <!-- 连续手势 GIF 配置 -->
                <div class="config-section">
                    <div class="config-section-header">
                        <h3><i class="fa fa-sync-alt"></i> 连续手势示范 GIF</h3>
                    </div>
                    <p class="config-hint">为每种连续手势任务配置示范 GIF，文件放在对应的 tutorial/gestures/ 子目录下</p>
                    <div class="continual-gif-config">
                        <div class="continual-gif-item">
                            <label>连续手势1 (滚轮控制)</label>
                            <button class="continual-gif-btn" data-task="continual_1" title="点击选择GIF文件">
                                ${continualGestures.continual_1?.[0]?.gifFile ? `📁 ${continualGestures.continual_1[0].gifFile}` : '📁 选择GIF'}
                            </button>
                            <span class="gif-path-hint">tutorial/gestures/continual_1/</span>
                        </div>
                        <div class="continual-gif-item">
                            <label>连续手势2 (手腕控制)</label>
                            <button class="continual-gif-btn" data-task="continual_2" title="点击选择GIF文件">
                                ${continualGestures.continual_2?.[0]?.gifFile ? `📁 ${continualGestures.continual_2[0].gifFile}` : '📁 选择GIF'}
                            </button>
                            <span class="gif-path-hint">tutorial/gestures/continual_2/</span>
                        </div>
                        <div class="continual-gif-item">
                            <label>连续手势3 (自定义控制)</label>
                            <button class="continual-gif-btn" data-task="continual_3" title="点击选择GIF文件">
                                ${continualGestures.continual_3?.[0]?.gifFile ? `📁 ${continualGestures.continual_3[0].gifFile}` : '📁 选择GIF'}
                            </button>
                            <span class="gif-path-hint">tutorial/gestures/continual_3/</span>
                        </div>
                    </div>
                </div>

                <div class="config-section">
                    <div class="config-section-header">
                        <h3><i class="fa fa-info-circle"></i> 手势统计</h3>
                    </div>
                    <div class="gesture-stats">
                        <div class="stat-item">
                            <span class="stat-value">${gestures.length}</span>
                            <span class="stat-label">总手势数</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value">${gestures.filter(g => g.enabled).length}</span>
                            <span class="stat-label">已启用</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-value">${gestures.filter(g => g.gifFile).length}</span>
                            <span class="stat-label">已配置GIF</span>
                        </div>
                    </div>
                </div>
            `;

            // 绑定手势事件
            this.bindGestureEvents(container);
        }

        /**
         * 绑定手势配置事件
         */
        bindGestureEvents(container) {
            // 复选框
            container.querySelectorAll('.gesture-checkbox input').forEach(checkbox => {
                checkbox.addEventListener('change', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    this.currentTemplate.gestures.discrete[index].enabled = e.target.checked;
                    this.isDirty = true;
                    this.renderGesturesTab();
                });
            });

            // 名称输入
            container.querySelectorAll('.gesture-name-input').forEach(input => {
                input.addEventListener('change', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    const newName = e.target.value.trim();
                    // 同时更新name和id，确保一致性
                    this.currentTemplate.gestures.discrete[index].name = newName;
                    this.currentTemplate.gestures.discrete[index].id = newName;
                    this.isDirty = true;
                });
            });

            // 点击图标修改emoji
            container.querySelectorAll('.gesture-icon[data-index]').forEach(iconSpan => {
                iconSpan.style.cursor = 'pointer';
                iconSpan.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const index = parseInt(e.target.dataset.index);
                    const currentIcon = this.currentTemplate.gestures.discrete[index].icon;
                    const newIcon = await this.showPrompt('请输入新的手势图标（emoji）：', currentIcon);
                    if (newIcon && newIcon.trim() && newIcon !== currentIcon) {
                        this.currentTemplate.gestures.discrete[index].icon = newIcon.trim();
                        this.isDirty = true;
                        this.renderGesturesTab();
                        this.showToast('图标已更新', 'success');
                    }
                });
            });

            // 【新增】手势类型选择
            container.querySelectorAll('.gesture-type-select').forEach(select => {
                select.addEventListener('change', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    this.currentTemplate.gestures.discrete[index].gestureType = e.target.value;
                    // 如果切换为瞬时手势，清除duration字段
                    if (e.target.value === 'instant') {
                        delete this.currentTemplate.gestures.discrete[index].duration;
                    }
                    this.isDirty = true;
                    this.renderGesturesTab();
                });
            });

            // 【新增】持续时间输入
            container.querySelectorAll('.gesture-duration-input').forEach(input => {
                input.addEventListener('change', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    const duration = parseFloat(e.target.value);
                    if (!isNaN(duration) && duration > 0) {
                        this.currentTemplate.gestures.discrete[index].duration = duration;
                    } else {
                        // 留空则删除duration字段，使用默认值
                        delete this.currentTemplate.gestures.discrete[index].duration;
                    }
                    this.isDirty = true;
                });
            });

            // GIF文件选择按钮
            container.querySelectorAll('.gesture-gif-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    const index = parseInt(e.currentTarget.dataset.index);
                    const gifFile = await this.pickGifFile();
                    if (gifFile) {
                        this.currentTemplate.gestures.discrete[index].gifFile = gifFile;
                        this.isDirty = true;
                        this.renderGesturesTab();
                    }
                });
            });

            // 删除按钮
            container.querySelectorAll('.gesture-delete-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const index = parseInt(e.currentTarget.dataset.index);
                    const confirmed = await this.showConfirm('确定要删除这个手势吗？');
                    if (confirmed) {
                        this.currentTemplate.gestures.discrete.splice(index, 1);
                        this.isDirty = true;
                        this.renderGesturesTab();
                    }
                });
            });

            // 【修改】添加瞬时手势按钮
            const addInstantBtn = document.getElementById('addInstantGestureBtn');
            if (addInstantBtn) {
                addInstantBtn.addEventListener('click', async () => {
                    const name = await this.showPrompt('请输入瞬时手势名称：');
                    if (name && name.trim()) {
                        const trimmedName = name.trim();
                        const icon = await this.showPrompt('请输入手势图标（emoji）：', '✋');
                        const gifFile = await this.pickGifFile();

                        this.currentTemplate.gestures.discrete.push({
                            id: trimmedName,
                            name: trimmedName,
                            icon: icon || '✋',
                            gifFile: gifFile || '',
                            enabled: true,
                            gestureType: 'instant'
                        });
                        this.isDirty = true;
                        this.renderGesturesTab();
                        this.showToast('瞬时手势已添加', 'success');
                    }
                });
            }

            // 【新增】添加持续手势按钮
            const addSustainedBtn = document.getElementById('addSustainedGestureBtn');
            if (addSustainedBtn) {
                addSustainedBtn.addEventListener('click', async () => {
                    const name = await this.showPrompt('请输入持续手势名称：');
                    if (name && name.trim()) {
                        const trimmedName = name.trim();
                        const icon = await this.showPrompt('请输入手势图标（emoji）：', '🤏');
                        const gifFile = await this.pickGifFile();

                        this.currentTemplate.gestures.discrete.push({
                            id: trimmedName,
                            name: trimmedName,
                            icon: icon || '🤏',
                            gifFile: gifFile || '',
                            enabled: true,
                            gestureType: 'sustained'
                        });
                        this.isDirty = true;
                        this.renderGesturesTab();
                        this.showToast('持续手势已添加', 'success');
                    }
                });
            }

            // 连续手势 GIF 选择按钮
            container.querySelectorAll('.continual-gif-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    const taskType = e.currentTarget.dataset.task;
                    const gifFile = await this.pickGifFile();
                    if (!gifFile) return;

                    // 确保连续手势数组存在
                    if (!this.currentTemplate.gestures[taskType]) {
                        this.currentTemplate.gestures[taskType] = [];
                    }

                    // 如果数组为空，添加一个默认手势对象
                    if (this.currentTemplate.gestures[taskType].length === 0) {
                        this.currentTemplate.gestures[taskType].push({
                            id: taskType,
                            name: taskType,
                            gifFile: gifFile,
                            enabled: true
                        });
                    } else {
                        // 更新第一个手势的 gifFile
                        this.currentTemplate.gestures[taskType][0].gifFile = gifFile;
                    }

                    this.isDirty = true;
                    console.log(`[TemplateConfig] 更新 ${taskType} GIF:`, gifFile);
                    this.renderGesturesTab();
                });
            });
        }

        /**
         * 渲染执行参数标签页 - 按任务类型分开配置
         */
        renderExecutionTab() {
            const container = document.getElementById('executionTabContent');
            if (!container) return;

            const exec = this.currentTemplate.execution;
            const tasks = this.currentTemplate.tasks || [];
            const enabledTasks = tasks.filter(t => t.enabled);

            // 获取任务名称映射
            const getTaskName = (taskId) => {
                const task = tasks.find(t => t.id === taskId);
                return task ? task.name : taskId;
            };

            let html = '';

            // 为每个启用的任务类型渲染参数配置
            enabledTasks.forEach(task => {
                const taskExec = exec[task.id] || {};
                
                html += `
                    <div class="config-section" data-task="${task.id}">
                        <div class="config-section-header">
                            <h3><i class="fa fa-clock"></i> ${task.name} - 时间参数</h3>
                        </div>
                        <div class="config-params-grid">
                `;

                // 根据任务类型渲染不同的参数
                if (task.id === 'discrete_gesture') {
                    html += `
                        <div class="config-param-item">
                            <label>每个手势重复次数</label>
                            <input type="number" data-task="${task.id}" data-param="repeatPerGesture"
                                   value="${taskExec.repeatPerGesture || 5}" min="1" max="20">
                            <span class="param-unit">次</span>
                        </div>
                        <div class="config-param-item">
                            <label>重复间隔时间</label>
                            <input type="number" data-task="${task.id}" data-param="intervalBetweenRepeat"
                                   value="${taskExec.intervalBetweenRepeat || 1.0}" min="0.5" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                        </div>
                        <div class="config-param-item">
                            <label>手势间休息时间</label>
                            <input type="number" data-task="${task.id}" data-param="restBetweenGestures"
                                   value="${taskExec.restBetweenGestures || 30.0}" min="5" max="120" step="5">
                            <span class="param-unit">秒</span>
                        </div>
                        <div class="config-param-item">
                            <label>Stage开始前准备时间</label>
                            <input type="number" data-task="${task.id}" data-param="preparationTime"
                                   value="${taskExec.preparationTime || 3.0}" min="1" max="10" step="1">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（固定时间，若需要随机则设置下方范围）</span>
                        </div>
                        <div class="config-param-item">
                            <label><i class="fa fa-random"></i> 准备时间随机范围（最小值）</label>
                            <input type="number" data-task="${task.id}" data-param="preparationTimeMin"
                                   value="${taskExec.preparationTimeMin !== undefined ? taskExec.preparationTimeMin : (taskExec.preparationTime || 3.0)}" min="1" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（每次随机选择该范围内的时间）</span>
                        </div>
                        <div class="config-param-item">
                            <label><i class="fa fa-random"></i> 准备时间随机范围（最大值）</label>
                            <input type="number" data-task="${task.id}" data-param="preparationTimeMax"
                                   value="${taskExec.preparationTimeMax !== undefined ? taskExec.preparationTimeMax : (taskExec.preparationTime || 3.0)}" min="1" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（最小值=最大值时为固定时间）</span>
                        </div>
                        <div class="config-param-item">
                            <label>手势提示显示时间</label>
                            <input type="number" data-task="${task.id}" data-param="gestureDisplayTime"
                                   value="${taskExec.gestureDisplayTime || 2.0}" min="1" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                        </div>
                        <div class="config-param-item config-param-sustained">
                            <label><i class="fa fa-arrows-alt-h"></i> 持续手势时长</label>
                            <input type="number" data-task="${task.id}" data-param="sustainedDuration"
                                   value="${taskExec.sustainedDuration || 2.0}" min="0.5" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（持续手势从_start到_end的时间）</span>
                        </div>
                        <div class="config-param-item config-param-shuffle">
                            <label><i class="fa fa-random"></i> 乱序间隔随机范围（最小值）</label>
                            <input type="number" data-task="${task.id}" data-param="shuffleIntervalMin"
                                   value="${taskExec.shuffleIntervalMin !== undefined ? taskExec.shuffleIntervalMin : (taskExec.shuffleInterval || 1.0)}" min="0.5" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（乱序模式下每个手势间隔在此范围内随机）</span>
                        </div>
                        <div class="config-param-item config-param-shuffle">
                            <label><i class="fa fa-random"></i> 乱序间隔随机范围（最大值）</label>
                            <input type="number" data-task="${task.id}" data-param="shuffleIntervalMax"
                                   value="${taskExec.shuffleIntervalMax !== undefined ? taskExec.shuffleIntervalMax : (taskExec.shuffleInterval || 1.0)}" min="0.5" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（最小值=最大值时为固定间隔）</span>
                        </div>
                        <div class="config-param-item config-param-shuffle">
                            <label><i class="fa fa-tachometer-alt"></i> 整体移动速度</label>
                            <input type="number" data-task="${task.id}" data-param="scrollSpeed"
                                   value="${taskExec.scrollSpeed || 2}" min="1" max="10" step="0.5">
                            <span class="param-unit">px/帧</span>
                            <span class="param-hint">（动画滚动速度，与时间配合计算距离）</span>
                        </div>
                        <div class="config-param-item config-param-shuffle">
                            <label><i class="fa fa-chart-pie"></i> 乱序中顺序占比</label>
                            <input type="number" data-task="${task.id}" data-param="orderedShuffleRatio"
                                   value="${taskExec.orderedShuffleRatio !== undefined ? taskExec.orderedShuffleRatio : 0.6}" min="0" max="1" step="0.05">
                            <span class="param-unit">比例</span>
                            <span class="param-hint">（0.6 = 前60%按顺序采集，剩余进入乱序。0=全部乱序，1=全部顺序）</span>
                        </div>
                        <div class="config-param-item">
                            <label><i class="fa fa-font"></i> 手势名称字体大小</label>
                            <input type="number" data-task="${task.id}" data-param="gestureLabelFontSize"
                                   value="${taskExec.gestureLabelFontSize || 18}" min="12" max="36" step="2">
                            <span class="param-unit">px</span>
                            <span class="param-hint">（手势下方中文名称的字体大小）</span>
                        </div>
                    `;
                } else if (task.id === 'continual_gesture_1' || task.id === 'continual_gesture_2') {
                    // 连续手势1和2的同心圆动画参数
                    html += `
                        <div class="config-param-item">
                            <label>每个Stage的动作次数</label>
                            <input type="number" data-task="${task.id}" data-param="trialsPerStage"
                                   value="${taskExec.trialsPerStage || 5}" min="1" max="1000" step="1">
                            <span class="param-unit">次</span>
                            <span class="param-hint">（扩张+保持+收缩为一次）</span>
                        </div>
                        <div class="config-param-item">
                            <label>Stage超时时间</label>
                            <input type="number" data-task="${task.id}" data-param="stageTimeout"
                                   value="${taskExec.stageTimeout || 120}" min="30" max="600" step="10">
                            <span class="param-unit">秒</span>
                        </div>
                        <div class="config-param-item">
                            <label>Stage开始前准备时间</label>
                            <input type="number" data-task="${task.id}" data-param="preparationTime"
                                   value="${taskExec.preparationTime || 3.0}" min="1" max="10" step="1">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（固定时间，若需要随机则设置下方范围）</span>
                        </div>
                        <div class="config-param-item">
                            <label><i class="fa fa-random"></i> 准备时间随机范围（最小值）</label>
                            <input type="number" data-task="${task.id}" data-param="preparationTimeMin"
                                   value="${taskExec.preparationTimeMin !== undefined ? taskExec.preparationTimeMin : (taskExec.preparationTime || 3.0)}" min="1" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（每次随机选择该范围内的时间）</span>
                        </div>
                        <div class="config-param-item">
                            <label><i class="fa fa-random"></i> 准备时间随机范围（最大值）</label>
                            <input type="number" data-task="${task.id}" data-param="preparationTimeMax"
                                   value="${taskExec.preparationTimeMax !== undefined ? taskExec.preparationTimeMax : (taskExec.preparationTime || 3.0)}" min="1" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（最小值=最大值时为固定时间）</span>
                        </div>
                        <div class="config-param-item">
                            <label>试次间隔休息时间</label>
                            <input type="number" data-task="${task.id}" data-param="restBetweenTrials"
                                   value="${taskExec.restBetweenTrials || 1}" min="0" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（每次动作之间的休息时间）</span>
                        </div>
                        <div class="config-param-item">
                            <label>扩张阶段时长</label>
                            <input type="number" data-task="${task.id}" data-param="expandDuration"
                                   value="${taskExec.expandDuration || 3.0}" min="1" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（引导圆从0扩大到最大）</span>
                        </div>
                        <div class="config-param-item">
                            <label>保持阶段时长</label>
                            <input type="number" data-task="${task.id}" data-param="holdDuration"
                                   value="${taskExec.holdDuration || 1.0}" min="0.5" max="5" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（在最大半径保持）</span>
                        </div>
                        <div class="config-param-item">
                            <label>收缩阶段时长</label>
                            <input type="number" data-task="${task.id}" data-param="contractDuration"
                                   value="${taskExec.contractDuration || 3.0}" min="1" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（引导圆从最大缩小到0）</span>
                        </div>
                        <div class="config-param-item">
                            <label>引导区域宽度</label>
                            <input type="number" data-task="${task.id}" data-param="guideBandWidth"
                                   value="${taskExec.guideBandWidth || 10}" min="5" max="30" step="1">
                            <span class="param-unit">像素</span>
                            <span class="param-hint">（引导圆半径±此值）</span>
                        </div>
                        <div class="config-param-item">
                            <label>同心圆最大半径</label>
                            <input type="number" data-task="${task.id}" data-param="maxRadius"
                                   value="${taskExec.maxRadius || 150}" min="80" max="250" step="10">
                            <span class="param-unit">像素</span>
                            <span class="param-hint">（圆的最大尺寸）</span>
                        </div>

                        <!-- 动作途中随机变化配置 -->
                        <div class="config-section-divider">
                            <span class="divider-title">动作途中随机变化（两个开关可独立启用）</span>
                        </div>
                        <div class="config-param-item config-random-guide-param">
                            <label><input type="checkbox" data-task="${task.id}" data-param="randomSpeedEnabled" data-type="boolean" ${taskExec.randomSpeedEnabled === true ? 'checked' : ''}> 动作途中随机变速</label>
                            <span class="param-hint">只在扩张和收缩过程中变速，保持阶段不变；设备持续记录。每次进入扩张或收缩都会重新抽取速度和计时，不跨阶段或Trial累计。启用后优先使用随机速度，关闭后恢复下方原速度序列。</span>
                        </div>
                        <div class="config-param-item config-random-guide-param">
                            <label>随机速度倍率范围（最小值）</label>
                            <input type="number" data-task="${task.id}" data-param="randomSpeedMin" value="${taskExec.randomSpeedMin !== undefined ? taskExec.randomSpeedMin : 0.5}" min="0.01" max="100" step="0.01"><span class="param-unit">倍速</span>
                        </div>
                        <div class="config-param-item config-random-guide-param">
                            <label>随机速度倍率范围（最大值）</label>
                            <input type="number" data-task="${task.id}" data-param="randomSpeedMax" value="${taskExec.randomSpeedMax !== undefined ? taskExec.randomSpeedMax : 2}" min="0.01" max="100" step="0.01"><span class="param-unit">倍速</span>
                        </div>
                        <div class="config-param-item config-random-guide-param">
                            <label>两次变速间隔（最短有效运动时间）</label>
                            <input type="number" data-task="${task.id}" data-param="speedChangeIntervalMin" value="${taskExec.speedChangeIntervalMin !== undefined ? taskExec.speedChangeIntervalMin : 0.5}" min="0.1" max="86400" step="0.1"><span class="param-unit">秒</span>
                        </div>
                        <div class="config-param-item config-random-guide-param">
                            <label>两次变速间隔（最长有效运动时间）</label>
                            <input type="number" data-task="${task.id}" data-param="speedChangeIntervalMax" value="${taskExec.speedChangeIntervalMax !== undefined ? taskExec.speedChangeIntervalMax : 1.5}" min="0.1" max="86400" step="0.1"><span class="param-unit">秒</span>
                            <span class="param-hint">暂停期间不计入有效运动时间；最大值86400秒。</span>
                        </div>
                        <div class="config-param-item config-random-guide-param">
                            <label><input type="checkbox" data-task="${task.id}" data-param="randomPauseEnabled" data-type="boolean" ${taskExec.randomPauseEnabled === true ? 'checked' : ''}> 动作途中随机冻结引导圆</label>
                            <span class="param-hint">只在扩张和收缩过程中随机暂停引导动画，保持阶段不变，不影响设备采集；两只手看到同一个目标圆。每次进入扩张或收缩都会重抽冻结间隔，不跨阶段或Trial累计。</span>
                        </div>
                        <div class="config-param-item config-random-guide-param">
                            <label>每次冻结时长（最短）</label>
                            <input type="number" data-task="${task.id}" data-param="pauseDurationMin" value="${taskExec.pauseDurationMin !== undefined ? taskExec.pauseDurationMin : 0.3}" min="0.01" max="86400" step="0.01"><span class="param-unit">秒</span>
                        </div>
                        <div class="config-param-item config-random-guide-param">
                            <label>每次冻结时长（最长）</label>
                            <input type="number" data-task="${task.id}" data-param="pauseDurationMax" value="${taskExec.pauseDurationMax !== undefined ? taskExec.pauseDurationMax : 1.2}" min="0.01" max="86400" step="0.01"><span class="param-unit">秒</span>
                        </div>
                        <div class="config-param-item config-random-guide-param">
                            <label>两次冻结间隔（最短有效运动时间）</label>
                            <input type="number" data-task="${task.id}" data-param="pauseIntervalMin" value="${taskExec.pauseIntervalMin !== undefined ? taskExec.pauseIntervalMin : 1}" min="0.1" max="86400" step="0.1"><span class="param-unit">秒</span>
                        </div>
                        <div class="config-param-item config-random-guide-param">
                            <label>两次冻结间隔（最长有效运动时间）</label>
                            <input type="number" data-task="${task.id}" data-param="pauseIntervalMax" value="${taskExec.pauseIntervalMax !== undefined ? taskExec.pauseIntervalMax : 3}" min="0.1" max="86400" step="0.1"><span class="param-unit">秒</span>
                        </div>
                        <div class="config-section-divider">
                            <span class="divider-title">原速度序列（随机变速关闭时使用）</span>
                        </div>
                        <div class="config-param-item config-random-guide-param">
                            <label>速度等级（倍率）</label>
                            <input type="text" data-task="${task.id}" data-param="speedLevels" data-type="array"
                                   value="${(taskExec.speedLevels || [0.5, 1.0, 1.5, 2.0]).join(', ')}"
                                   class="wide-input">
                            <span class="param-hint">（逗号分隔，如: 0.5, 1.0, 1.5, 2.0。倍率越大速度越快）</span>
                        </div>
                        <div class="config-param-item">
                            <label>Trial速度序列</label>
                            <input type="text" data-task="${task.id}" data-param="trialSpeedSequence" data-type="array"
                                   value="${(taskExec.trialSpeedSequence || []).join(', ')}"
                                   class="wide-input"
                                   placeholder="留空=全部使用1.0倍速">
                            <span class="param-hint">（逗号分隔，每个Trial对应的速度等级序号，如: 1, 1, 2, 2, 3, 3, 4, 4, 3, 2）</span>
                        </div>
                        <div class="speed-sequence-helper" data-task="${task.id}">
                            <button type="button" class="btn-small btn-outline" onclick="window.templateConfigManager.generateSpeedSequence('${task.id}', 'gradual')">
                                渐进加速
                            </button>
                            <button type="button" class="btn-small btn-outline" onclick="window.templateConfigManager.generateSpeedSequence('${task.id}', 'wave')">
                                快慢交替
                            </button>
                            <button type="button" class="btn-small btn-outline" onclick="window.templateConfigManager.generateSpeedSequence('${task.id}', 'random')">
                                随机速度
                            </button>
                            <button type="button" class="btn-small btn-outline" onclick="window.templateConfigManager.generateSpeedSequence('${task.id}', 'clear')">
                                清空（全用1.0x）
                            </button>
                        </div>
                    `;
                } else if (task.id === 'continual_gesture_3') {
                    // 连续手势3（手掌反转引导）的特有参数
                    html += `
                        <div class="config-param-item">
                            <label>每个Stage的试次数</label>
                            <input type="number" data-task="${task.id}" data-param="trialsPerStage"
                                   value="${taskExec.trialsPerStage || 10}" min="1" max="50">
                            <span class="param-unit">次</span>
                            <span class="param-hint">（完整往返次数）</span>
                        </div>
                        <div class="config-param-item">
                            <label>Stage超时时间</label>
                            <input type="number" data-task="${task.id}" data-param="stageTimeout"
                                   value="${taskExec.stageTimeout || 120}" min="30" max="600" step="10">
                            <span class="param-unit">秒</span>
                        </div>
                        <div class="config-param-item">
                            <label>试次间隔休息时间</label>
                            <input type="number" data-task="${task.id}" data-param="restBetweenTrials"
                                   value="${taskExec.restBetweenTrials || 1}" min="0" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（每次动作之间的休息时间）</span>
                        </div>
                        <div class="config-param-item">
                            <label>引导速度</label>
                            <input type="number" data-task="${task.id}" data-param="guideSpeed"
                                   value="${taskExec.guideSpeed || 0.15}" min="0.05" max="0.5" step="0.05">
                            <span class="param-unit">比例/秒</span>
                            <span class="param-hint">（越大越快）</span>
                        </div>
                        <div class="config-param-item">
                            <label>引导区域大小</label>
                            <input type="number" data-task="${task.id}" data-param="guideSize"
                                   value="${taskExec.guideSize || 0.15}" min="0.08" max="0.3" step="0.02">
                            <span class="param-unit">比例</span>
                            <span class="param-hint">（占半圆弧比例）</span>
                        </div>
                        <div class="config-param-item">
                            <label>端点停留时间</label>
                            <input type="number" data-task="${task.id}" data-param="holdDuration"
                                   value="${taskExec.holdDuration || 1.0}" min="0.5" max="3" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（在掌心向上位置停留）</span>
                        </div>
                        <div class="config-param-item">
                            <label>Stage开始前准备时间</label>
                            <input type="number" data-task="${task.id}" data-param="preparationTime"
                                   value="${taskExec.preparationTime || 3.0}" min="1" max="10" step="1">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（固定时间，若需要随机则设置下方范围）</span>
                        </div>
                        <div class="config-param-item">
                            <label><i class="fa fa-random"></i> 准备时间随机范围（最小值）</label>
                            <input type="number" data-task="${task.id}" data-param="preparationTimeMin"
                                   value="${taskExec.preparationTimeMin !== undefined ? taskExec.preparationTimeMin : (taskExec.preparationTime || 3.0)}" min="1" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（每次随机选择该范围内的时间）</span>
                        </div>
                        <div class="config-param-item">
                            <label><i class="fa fa-random"></i> 准备时间随机范围（最大值）</label>
                            <input type="number" data-task="${task.id}" data-param="preparationTimeMax"
                                   value="${taskExec.preparationTimeMax !== undefined ? taskExec.preparationTimeMax : (taskExec.preparationTime || 3.0)}" min="1" max="10" step="0.5">
                            <span class="param-unit">秒</span>
                            <span class="param-hint">（最小值=最大值时为固定时间）</span>
                        </div>
                    `;
                }

                html += `
                        </div>
                    </div>
                `;
            });

            // 时间估算区域
            html += `
                <div class="config-section">
                    <div class="config-section-header">
                        <h3><i class="fa fa-calculator"></i> 时间估算</h3>
                    </div>
                    <div class="time-estimation" id="timeEstimationContent">
                        ${this.renderTimeEstimation()}
                    </div>
                </div>
            `;

            container.innerHTML = html;

            // 绑定参数输入事件
            container.querySelectorAll('.config-param-item input').forEach(input => {
                input.addEventListener('change', (e) => {
                    const taskId = e.target.dataset.task;
                    const param = e.target.dataset.param;
                    const dataType = e.target.dataset.type;  // 【新增】获取数据类型

                    let value;
                    if (dataType === 'boolean' || e.target.type === 'checkbox') {
                        value = e.target.checked;
                    } else if (dataType === 'array') {
                        // 【新增】处理数组类型输入（逗号分隔的数字）
                        const strValue = e.target.value.trim();
                        if (strValue === '') {
                            value = [];
                        } else {
                            value = strValue.split(',').map(s => {
                                const num = parseFloat(s.trim());
                                return isNaN(num) ? 0 : num;
                            }).filter(n => n !== 0 || strValue.includes('0'));
                        }
                    } else {
                        value = parseFloat(e.target.value);
                    }

                    if (taskId && param) {
                        if (!this.currentTemplate.execution[taskId]) {
                            this.currentTemplate.execution[taskId] = {};
                        }
                        const taskConfig = this.currentTemplate.execution[taskId];
                        const previousValue = taskConfig[param];
                        if (dataType !== 'array' && dataType !== 'boolean' && e.target.type !== 'checkbox') {
                            const isNewRandomField = ['randomSpeedMin', 'randomSpeedMax', 'speedChangeIntervalMin', 'speedChangeIntervalMax', 'pauseDurationMin', 'pauseDurationMax', 'pauseIntervalMin', 'pauseIntervalMax'].includes(param);
                            const isTrialsCount = param === 'trialsPerStage' && (taskId === 'continual_gesture_1' || taskId === 'continual_gesture_2');
                            const minimum = param === 'speedChangeIntervalMin' || param === 'speedChangeIntervalMax' || param === 'pauseIntervalMin' || param === 'pauseIntervalMax' ? 0.1 : 0.01;
                            const isSpeedField = param === 'randomSpeedMin' || param === 'randomSpeedMax';
                            const maximum = isSpeedField ? 100 : 86400;
                            const millisecondsAreSafe = isSpeedField || (Number.isFinite(value * 1000) && value * 1000 <= Number.MAX_SAFE_INTEGER);
                            const randomFieldDefaults = DEFAULT_TEMPLATE.execution[taskId] || {};
                            const isValidRandomField = (field, candidate) => {
                                if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return false;
                                const lower = field === 'speedChangeIntervalMin' || field === 'speedChangeIntervalMax' || field === 'pauseIntervalMin' || field === 'pauseIntervalMax' ? 0.1 : 0.01;
                                const upper = field === 'randomSpeedMin' || field === 'randomSpeedMax' ? 100 : 86400;
                                return candidate >= lower && candidate <= upper && Number.isFinite(candidate * 1000);
                            };
                            const effectiveCurrentValue = isNewRandomField
                                ? (isValidRandomField(param, previousValue) ? previousValue : randomFieldDefaults[param])
                                : previousValue;
                            if (isNewRandomField) taskConfig[param] = effectiveCurrentValue;
                            if ((isNewRandomField && (!Number.isFinite(value) || value < minimum || value > maximum || !millisecondsAreSafe)) ||
                                (isTrialsCount && (!Number.isInteger(value) || value < 1 || value > 1000))) {
                                e.target.value = isNewRandomField ? effectiveCurrentValue : (previousValue !== undefined ? previousValue : (isTrialsCount ? 5 : minimum));
                                this.showToast(isTrialsCount ? '动作次数必须是1到1000之间的整数' : (isSpeedField ? `速度倍率必须在${minimum}到${maximum}之间` : `时间必须在${minimum}到${maximum}秒之间，且毫秒换算不能溢出`), 'warning');
                                return;
                            }

                            const rangePairs = {
                                randomSpeedMin: 'randomSpeedMax', randomSpeedMax: 'randomSpeedMin',
                                speedChangeIntervalMin: 'speedChangeIntervalMax', speedChangeIntervalMax: 'speedChangeIntervalMin',
                                pauseDurationMin: 'pauseDurationMax', pauseDurationMax: 'pauseDurationMin',
                                pauseIntervalMin: 'pauseIntervalMax', pauseIntervalMax: 'pauseIntervalMin'
                            };
                            const pairedParam = rangePairs[param];
                            if (pairedParam) {
                                let pairedValue = taskConfig[pairedParam];
                                if (!isValidRandomField(pairedParam, pairedValue)) {
                                    pairedValue = randomFieldDefaults[pairedParam];
                                    taskConfig[pairedParam] = pairedValue;
                                }
                                const isMin = param.endsWith('Min');
                                if ((isMin && value > pairedValue) || (!isMin && value < pairedValue)) {
                                    taskConfig[param] = pairedValue;
                                    taskConfig[pairedParam] = value;
                                    const pairedInput = container.querySelector(`input[data-task="${taskId}"][data-param="${pairedParam}"]`);
                                    if (pairedInput) pairedInput.value = value;
                                    e.target.value = pairedValue;
                                    this.showToast('范围上下限已交换，保持最小值不大于最大值', 'warning');
                                } else {
                                    taskConfig[param] = value;
                                }
                            } else if (!Number.isFinite(value)) {
                                e.target.value = previousValue !== undefined ? previousValue : '';
                                this.showToast('请输入有效数字', 'warning');
                                return;
                            } else {
                                taskConfig[param] = value;
                            }
                        } else {
                            taskConfig[param] = value;
                        }
                        this.isDirty = true;

                        // 更新时间估算
                        const estimation = document.getElementById('timeEstimationContent');
                        if (estimation) {
                            estimation.innerHTML = this.renderTimeEstimation();
                        }
                    }
                });
            });
        }

        /**
         * 渲染时间估算 - 按任务类型分别计算单个Stage耗时
         */
        renderTimeEstimation() {
            const exec = this.currentTemplate.execution;
            const tasks = this.currentTemplate.tasks || [];
            const enabledTasks = tasks.filter(t => t.enabled);

            const formatTime = (seconds) => {
                if (seconds < 60) return `${Math.round(seconds)}秒`;
                if (seconds < 3600) return `${Math.round(seconds / 60)}分钟`;
                return `${(seconds / 3600).toFixed(1)}小时`;
            };

            let html = '<div class="estimation-grid">';
            let maxStageTime = 0; // 记录最长的单个Stage时间
            let hasRandomizedContinuousTask = false;

            enabledTasks.forEach(task => {
                const taskExec = exec[task.id] || {};
                let singleStageTime = 0;
                let taskDetails = '';

                if (task.id === 'discrete_gesture') {
                    const enabledGestures = this.currentTemplate.gestures.discrete.filter(g => g.enabled).length;
                    const repeatPerGesture = taskExec.repeatPerGesture || 5;
                    const gestureDisplayTime = taskExec.gestureDisplayTime || 2.0;
                    const intervalBetweenRepeat = taskExec.intervalBetweenRepeat || 1.0;
                    const restBetweenGestures = taskExec.restBetweenGestures || 30.0;
                    const preparationTime = taskExec.preparationTime || 3.0;

                    // 每种手势执行完总耗时 = 重复次数 * (提示时间 + 间隔) + 休息时间
                    const singleGestureTime = repeatPerGesture * (gestureDisplayTime + intervalBetweenRepeat) + restBetweenGestures;
                    // 单个Stage时间 = 所有手势时间 + 准备时间
                    singleStageTime = enabledGestures * singleGestureTime + preparationTime;

                    taskDetails = `
                        <div class="estimation-detail">
                            <span>手势数量: ${enabledGestures}个</span>
                            <span>每手势重复: ${repeatPerGesture}次</span>
                            <span>每种手势耗时: ${formatTime(singleGestureTime)}</span>
                        </div>
                    `;
                } else if (task.id === 'continual_gesture_1' || task.id === 'continual_gesture_2') {
                    hasRandomizedContinuousTask = hasRandomizedContinuousTask || taskExec.randomSpeedEnabled === true || taskExec.randomPauseEnabled === true;
                    const trialsPerStage = taskExec.trialsPerStage || 5;
                    const preparationTime = taskExec.preparationTime || 3.0;
                    const expandDuration = taskExec.expandDuration || 3.0;
                    const holdDuration = taskExec.holdDuration || 1.0;
                    const contractDuration = taskExec.contractDuration || 3.0;
                    const restBetweenTrials = taskExec.restBetweenTrials || 1;

                    // 单次动作耗时 = 扩张 + 保持 + 收缩 + 间隔
                    const singleTrialTime = expandDuration + holdDuration + contractDuration + restBetweenTrials;
                    // 单个Stage时间 = 所有动作时间 + 准备时间
                    singleStageTime = trialsPerStage * singleTrialTime + preparationTime;

                    taskDetails = `
                        <div class="estimation-detail">
                            <span>动作数量: ${trialsPerStage}次</span>
                            <span>单次动作: ${formatTime(singleTrialTime)}</span>
                            ${(taskExec.randomSpeedEnabled === true || taskExec.randomPauseEnabled === true) ? '<span>随机动作时长仅作估算；Stage超时可能提前终止</span>' : ''}
                        </div>
                    `;
                } else if (task.id === 'continual_gesture_3') {
                    const trialsPerStage = taskExec.trialsPerStage || 10;
                    const preparationTime = taskExec.preparationTime || 3.0;
                    const guideSpeed = taskExec.guideSpeed || 0.15;
                    const holdDuration = taskExec.holdDuration || 1.0;
                    const restBetweenTrials = taskExec.restBetweenTrials || 1;

                    // 单次动作耗时 = 往返时间(约6.67秒，速度0.15) + 两次停留 + 间隔
                    const singleTrialTime = (1 / guideSpeed) + holdDuration * 2 + restBetweenTrials;
                    // 单个Stage时间 = 所有动作时间 + 准备时间
                    singleStageTime = trialsPerStage * singleTrialTime + preparationTime;

                    taskDetails = `
                        <div class="estimation-detail">
                            <span>动作数量: ${trialsPerStage}次</span>
                            <span>单次动作: ${formatTime(singleTrialTime)}</span>
                        </div>
                    `;
                }

                if (singleStageTime > maxStageTime) {
                    maxStageTime = singleStageTime;
                }

                html += `
                    <div class="estimation-item estimation-task">
                        <div class="estimation-task-header">
                            <span class="estimation-label">${task.name}</span>
                            <span class="estimation-value estimation-stage-time">${(task.id === 'continual_gesture_1' || task.id === 'continual_gesture_2') && (taskExec.randomSpeedEnabled === true || taskExec.randomPauseEnabled === true) ? `估算约 ${formatTime(singleStageTime)}` : formatTime(singleStageTime)}</span>
                        </div>
                        ${taskDetails}
                    </div>
                `;
            });

            // 右上角显示单个Stage最长耗时汇总（如果有多个任务）
            if (enabledTasks.length > 1) {
                html += `
                    <div class="estimation-item estimation-summary">
                        <span class="estimation-label">单个Stage总耗时（所有任务）</span>
                        <span class="estimation-value estimation-stage-time">${hasRandomizedContinuousTask ? `估算约 ${formatTime(maxStageTime * enabledTasks.length)}` : formatTime(maxStageTime * enabledTasks.length)}</span>
                    </div>
                `;
            }

            html += '</div>';
            return html;
        }

        /**
         * 渲染受试者字段标签页
         */
        renderSubjectTab() {
            const container = document.getElementById('subjectTabContent');
            if (!container) {
                console.warn('[TemplateConfig] subjectTabContent container not found');
                return;
            }

            // 确保 subjectFields 存在，如果不存在则使用默认值
            if (!this.currentTemplate.subjectFields || !Array.isArray(this.currentTemplate.subjectFields)) {
                console.warn('[TemplateConfig] subjectFields not found, using default');
                this.currentTemplate.subjectFields = DEFAULT_TEMPLATE.subjectFields.map(f => ({...f}));
            }

            const fields = this.currentTemplate.subjectFields;
            console.log('[TemplateConfig] Rendering subject fields:', fields.length, 'fields');

            container.innerHTML = `
                <div class="config-section">
                    <div class="config-section-header">
                        <h3><i class="fa fa-user"></i> 受试者信息字段</h3>
                        <button class="config-add-btn" id="addFieldBtn">
                            <i class="fa fa-plus"></i> 添加字段
                        </button>
                    </div>
                    <p class="config-hint">配置采集时需要填写的受试者信息</p>
                    <div class="config-fields-list">
                        ${fields.map((field, index) => this.renderSubjectField(field, index)).join('')}
                    </div>
                </div>
            `;

            // 绑定字段事件
            this.bindSubjectFieldEvents(container);
        }

        /**
         * 渲染受试者字段项
         */
        renderSubjectField(field, index) {
            return `
                <div class="config-field-item" data-index="${index}">
                    <div class="field-row">
                        <div class="field-drag">
                            <i class="fa fa-grip-vertical"></i>
                        </div>
                        <input type="text" class="field-label-input" data-field="label" value="${field.label}" placeholder="字段名称">
                        <select class="field-type-select" data-field="type">
                            <option value="text" ${field.type === 'text' ? 'selected' : ''}>文本</option>
                            <option value="number" ${field.type === 'number' ? 'selected' : ''}>数字</option>
                            <option value="select" ${field.type === 'select' ? 'selected' : ''}>下拉选择</option>
                            <option value="textarea" ${field.type === 'textarea' ? 'selected' : ''}>多行文本</option>
                        </select>
                        <label class="field-required">
                            <input type="checkbox" data-field="required" ${field.required ? 'checked' : ''}>
                            <span>必填</span>
                        </label>
                        <button class="field-delete-btn" data-index="${index}">
                            <i class="fa fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }

        /**
         * 绑定受试者字段事件
         */
        bindSubjectFieldEvents(container) {
            // 字段属性变化
            container.querySelectorAll('.config-field-item').forEach(item => {
                const index = parseInt(item.dataset.index);
                
                item.querySelectorAll('input, select').forEach(input => {
                    input.addEventListener('change', (e) => {
                        const field = e.target.dataset.field;
                        let value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
                        this.currentTemplate.subjectFields[index][field] = value;
                        this.isDirty = true;
                    });
                });
            });

            // 删除字段
            container.querySelectorAll('.field-delete-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const index = parseInt(e.currentTarget.dataset.index);
                    const confirmed = await this.showConfirm('确定要删除这个字段吗？');
                    if (confirmed) {
                        this.currentTemplate.subjectFields.splice(index, 1);
                        this.isDirty = true;
                        this.renderSubjectTab();
                    }
                });
            });

            // 添加字段
            const addBtn = document.getElementById('addFieldBtn');
            if (addBtn) {
                addBtn.addEventListener('click', async () => {
                    // 弹窗让用户输入字段ID
                    const fieldId = await this.showPrompt(
                        '请输入字段ID（英文，用于数据存储，如 wrist_size）',
                        ''
                    );
                    if (!fieldId) return;  // 用户取消

                    // 验证ID格式：只允许英文字母、数字和下划线
                    const idPattern = /^[a-zA-Z][a-zA-Z0-9_]*$/;
                    if (!idPattern.test(fieldId)) {
                        this.showToast('字段ID必须以英文字母开头，只能包含字母、数字和下划线', 'error');
                        return;
                    }

                    // 检查ID是否已存在
                    const existingIds = this.currentTemplate.subjectFields.map(f => f.id);
                    if (existingIds.includes(fieldId)) {
                        this.showToast('该字段ID已存在，请使用其他ID', 'error');
                        return;
                    }

                    // 弹窗让用户输入字段显示名称
                    const fieldLabel = await this.showPrompt(
                        '请输入字段显示名称（如 腕围）',
                        ''
                    );
                    if (!fieldLabel) return;  // 用户取消

                    this.currentTemplate.subjectFields.push({
                        id: fieldId,
                        label: fieldLabel,
                        type: 'text',
                        required: false,
                        placeholder: ''
                    });
                    this.isDirty = true;
                    this.renderSubjectTab();
                });
            }
        }

        /**
         * 获取当前模板
         */
        getTemplate() {
            return this.currentTemplate;
        }

        /**
         * 获取启用的分类
         */
        getEnabledCategories() {
            return {
                tasks: this.currentTemplate.tasks.filter(t => t.enabled),
                category1: this.currentTemplate.category1.filter(c => c.enabled),
                category2: this.currentTemplate.category2.filter(c => c.enabled),
                category3: this.currentTemplate.category3.filter(c => c.enabled),
                category4: this.currentTemplate.category4.filter(c => c.enabled),
                gestures: this.currentTemplate.gestures.discrete.filter(g => g.enabled)
            };
        }

        /**
         * 【新增】生成速度序列
         * @param {string} taskId - 任务ID（continual_gesture_1 或 continual_gesture_2）
         * @param {string} pattern - 模式：'gradual'渐进 | 'wave'快慢交替 | 'random'随机 | 'clear'清空
         */
        generateSpeedSequence(taskId, pattern) {
            const taskExec = this.currentTemplate.execution[taskId];
            if (!taskExec) return;

            const trialsPerStage = taskExec.trialsPerStage || 5;
            const speedLevels = taskExec.speedLevels || [0.5, 1.0, 1.5, 2.0];
            const numLevels = speedLevels.length;

            let sequence = [];

            switch (pattern) {
                case 'gradual':
                    // 渐进加速：从慢到快
                    for (let i = 0; i < trialsPerStage; i++) {
                        // 均匀分布在速度等级上
                        const levelIndex = Math.min(Math.floor(i * numLevels / trialsPerStage) + 1, numLevels);
                        sequence.push(levelIndex);
                    }
                    break;

                case 'wave':
                    // 快慢交替：慢-快-慢-快...
                    for (let i = 0; i < trialsPerStage; i++) {
                        sequence.push(i % 2 === 0 ? 1 : numLevels);
                    }
                    break;

                case 'random':
                    // 随机速度
                    for (let i = 0; i < trialsPerStage; i++) {
                        sequence.push(Math.floor(Math.random() * numLevels) + 1);
                    }
                    break;

                case 'clear':
                    // 清空（全部使用默认1.0倍速）
                    sequence = [];
                    break;
            }

            // 更新配置
            taskExec.trialSpeedSequence = sequence;
            this.isDirty = true;

            // 更新输入框显示
            const input = document.querySelector(`input[data-task="${taskId}"][data-param="trialSpeedSequence"]`);
            if (input) {
                input.value = sequence.join(', ');
            }

            // 显示提示
            const patternNames = {
                'gradual': '渐进加速',
                'wave': '快慢交替',
                'random': '随机速度',
                'clear': '已清空'
            };
            this.showToast(`速度序列已设为: ${patternNames[pattern]}`, 'success');
            console.log(`[TemplateConfig] ${taskId} 速度序列已生成:`, sequence);
        }

        /**
         * 显示Toast提示
         */
        showToast(message, type = 'success') {
            let toast = document.getElementById('configToast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'configToast';
                toast.className = 'toast';
                document.body.appendChild(toast);
            }

            const iconMap = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
            const icon = iconMap[type] || 'fa-exclamation-circle';
            toast.className = `toast ${type}`;
            toast.innerHTML = `<i class="fa ${icon}"></i> ${message}`;
            toast.classList.add('visible');

            setTimeout(() => {
                toast.classList.remove('visible');
            }, 2500);
        }

        /**
         * 自定义prompt对话框（兼容Electron环境）
         * @param {string} message - 提示信息
         * @param {string} defaultValue - 默认值
         * @returns {Promise<string|null>} - 用户输入的值，取消返回null
         */
        showPrompt(message, defaultValue = '') {
            return new Promise((resolve) => {
                // 创建遮罩层
                const overlay = document.createElement('div');
                overlay.className = 'custom-prompt-overlay';
                overlay.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10000;
                `;

                // 创建对话框
                const dialog = document.createElement('div');
                dialog.className = 'custom-prompt-dialog';
                dialog.style.cssText = `
                    background: white;
                    border-radius: 12px;
                    padding: 24px;
                    min-width: 320px;
                    max-width: 400px;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                `;

                dialog.innerHTML = `
                    <div style="margin-bottom: 16px; font-size: 15px; color: #333; font-weight: 500;">${message}</div>
                    <input type="text" class="prompt-input" value="${defaultValue}" style="
                        width: 100%;
                        padding: 10px 12px;
                        border: 2px solid #e5e7eb;
                        border-radius: 8px;
                        font-size: 14px;
                        outline: none;
                        box-sizing: border-box;
                        transition: border-color 0.2s;
                    " />
                    <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
                        <button class="prompt-cancel" style="
                            padding: 8px 20px;
                            border: 1px solid #d1d5db;
                            background: white;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 14px;
                            color: #666;
                        ">取消</button>
                        <button class="prompt-confirm" style="
                            padding: 8px 20px;
                            border: none;
                            background: #3b82f6;
                            color: white;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 14px;
                        ">确定</button>
                    </div>
                `;

                overlay.appendChild(dialog);
                document.body.appendChild(overlay);

                const input = dialog.querySelector('.prompt-input');
                const confirmBtn = dialog.querySelector('.prompt-confirm');
                const cancelBtn = dialog.querySelector('.prompt-cancel');

                // 自动聚焦并选中
                input.focus();
                input.select();

                // 输入框焦点样式
                input.addEventListener('focus', () => {
                    input.style.borderColor = '#3b82f6';
                });
                input.addEventListener('blur', () => {
                    input.style.borderColor = '#e5e7eb';
                });

                const cleanup = () => {
                    document.body.removeChild(overlay);
                };

                confirmBtn.addEventListener('click', () => {
                    cleanup();
                    resolve(input.value);
                });

                cancelBtn.addEventListener('click', () => {
                    cleanup();
                    resolve(null);
                });

                // 回车确认
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        cleanup();
                        resolve(input.value);
                    } else if (e.key === 'Escape') {
                        cleanup();
                        resolve(null);
                    }
                });

                // 点击遮罩取消
                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) {
                        cleanup();
                        resolve(null);
                    }
                });
            });
        }

        /**
         * 自定义confirm对话框（兼容Electron环境）
         * @param {string} message - 确认信息
         * @returns {Promise<boolean>} - 用户选择确认返回true，取消返回false
         */
        showConfirm(message) {
            return new Promise((resolve) => {
                // 创建遮罩层
                const overlay = document.createElement('div');
                overlay.className = 'custom-confirm-overlay';
                overlay.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.5);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10000;
                `;

                // 创建对话框
                const dialog = document.createElement('div');
                dialog.className = 'custom-confirm-dialog';
                dialog.style.cssText = `
                    background: white;
                    border-radius: 12px;
                    padding: 24px;
                    min-width: 300px;
                    max-width: 400px;
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
                `;

                dialog.innerHTML = `
                    <div style="display: flex; align-items: flex-start; gap: 12px; margin-bottom: 20px;">
                        <div style="
                            width: 40px;
                            height: 40px;
                            border-radius: 50%;
                            background: #fef3c7;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            flex-shrink: 0;
                        ">
                            <i class="fa fa-exclamation-triangle" style="color: #f59e0b; font-size: 18px;"></i>
                        </div>
                        <div style="font-size: 15px; color: #333; line-height: 1.5; padding-top: 8px;">${message}</div>
                    </div>
                    <div style="display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="confirm-cancel" style="
                            padding: 8px 20px;
                            border: 1px solid #d1d5db;
                            background: white;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 14px;
                            color: #666;
                        ">取消</button>
                        <button class="confirm-ok" style="
                            padding: 8px 20px;
                            border: none;
                            background: #ef4444;
                            color: white;
                            border-radius: 6px;
                            cursor: pointer;
                            font-size: 14px;
                        ">确定</button>
                    </div>
                `;

                overlay.appendChild(dialog);
                document.body.appendChild(overlay);

                const confirmBtn = dialog.querySelector('.confirm-ok');
                const cancelBtn = dialog.querySelector('.confirm-cancel');

                const cleanup = () => {
                    document.body.removeChild(overlay);
                };

                confirmBtn.addEventListener('click', () => {
                    cleanup();
                    resolve(true);
                });

                cancelBtn.addEventListener('click', () => {
                    cleanup();
                    resolve(false);
                });

                // ESC取消
                const keyHandler = (e) => {
                    if (e.key === 'Escape') {
                        cleanup();
                        resolve(false);
                        document.removeEventListener('keydown', keyHandler);
                    } else if (e.key === 'Enter') {
                        cleanup();
                        resolve(true);
                        document.removeEventListener('keydown', keyHandler);
                    }
                };
                document.addEventListener('keydown', keyHandler);

                // 点击遮罩取消
                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) {
                        cleanup();
                        resolve(false);
                    }
                });
            });
        }

        /**
         * 弹出文件选择器，选择 GIF 文件
         * @returns {Promise<string>} - 返回选中的文件名，取消返回空字符串
         */
        pickGifFile() {
            return new Promise((resolve) => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.gif';
                input.style.display = 'none';
                document.body.appendChild(input);
                input.addEventListener('change', () => {
                    const file = input.files[0];
                    document.body.removeChild(input);
                    resolve(file ? file.name : '');
                });
                // 用户取消选择
                input.addEventListener('cancel', () => {
                    document.body.removeChild(input);
                    resolve('');
                });
                // 兼容：focus 丢失也视为取消
                window.addEventListener('focus', function onFocus() {
                    window.removeEventListener('focus', onFocus);
                    setTimeout(() => {
                        if (input.parentNode && !input.files.length) {
                            document.body.removeChild(input);
                            resolve('');
                        }
                    }, 300);
                });
                input.click();
            });
        }
    }

    // ==================== 初始化 ====================
    window.TemplateConfigManager = TemplateConfigManager;
    
    // 创建全局实例
    document.addEventListener('DOMContentLoaded', () => {
        window.templateConfigManager = new TemplateConfigManager();
        console.log('[TemplateConfig] 管理器实例已创建');
    });

    console.log('[TemplateConfig] 模块加载完成');

})();
