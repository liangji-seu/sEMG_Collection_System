'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const EventEmitter = require('node:events');

class BrowserSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
        this.messages = [];
    }
    addEventListener(name, fn) { this.on(name, fn); }
    removeEventListener(name, fn) { this.off(name, fn); }
    send(message) { this.messages.push(JSON.parse(message)); }
}

function loadController() {
    let nextTimerId = 1;
    const timers = new Map();
    const setTimer = (fn, delay, interval) => {
        const id = nextTimerId++;
        timers.set(id, { fn, delay, interval, cleared: false });
        return id;
    };
    const clearTimer = id => {
        const timer = timers.get(id);
        if (timer) timer.cleared = true;
    };
    const socket = new BrowserSocket();
    const alerts = [];
    const status = [];
    const elements = new Map();
    for (const id of ['startTaskBtn', 'testModeBtn', 'startAllSessionsBtn', 'sessionSwitchSelect',
        'stageSwitchSelect', 'stopTaskBtn']) {
        elements.set(id, { disabled: false, textContent: '', parentNode: null });
    }
    const document = {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id) { return elements.get(id) || null; }
    };
    let animationStops = 0;
    const window = {
        waveformController: { dataReceiver: { ws: socket } },
        discreteGestureAnimation: { stop() { animationStops++; } },
        continualGesture1Animation: { stop() { animationStops++; } },
        continualGesture2Animation: { stop() { animationStops++; } },
        animationController: { stop() { animationStops++; } }
    };
    const source = fs.readFileSync(require.resolve('../public/scripts/collection-controller.js'), 'utf8')
        .replace('    function initController() {', '    window.TestController = CollectionController;\n    function initController() {');
    const context = {
        window, document, console, Date, JSON, Math, WebSocket: { OPEN: 1 },
        localStorage: { getItem() { return null; } },
        setTimeout(fn, delay) { return setTimer(fn, delay, false); },
        clearTimeout: clearTimer,
        setInterval(fn, delay) { return setTimer(fn, delay, true); },
        clearInterval: clearTimer,
        alert(message) { alerts.push(message); }
    };
    vm.runInNewContext(source, context, { filename: 'collection-controller.js' });
    const controller = Object.create(window.TestController.prototype);
    Object.assign(controller, {
        _isRunning: true, _isPaused: false, _isAllSessionsMode: true,
        _saveState: 'collecting', _spaceKeyEnabled: true,
        _restCountdownTimer: null, phaseTimer: null, countdownTimer: null,
        continualProgressTimer: null, calibrationTimer: null,
        _autoStartTimer: null, _autoStartGeneration: 0,
        _guideTimeouts: new Set(), _guideTimeoutGeneration: 0,
        _collectionFaultId: null, _collectionFaultPhases: new Set(),
        _collectionFault: null, _collectionFaultRetryCount: 0,
        _collectionSessionGeneration: 0,
        _collectionFaultModalKeys: new Set(), _previewResumeTimer: null,
        _previewResumeGeneration: 0,
        updateStatus(message) { status.push(message); },
        updateControlButtons() {}, updateNextStageButton() {}, updateGestureList() {},
        hideGestureGif() {}, showToast() {}, sendToRealtimeEngineAndWait: async () => ({})
    });
    return { controller, socket, timers, alerts, status, elements, window,
        setTimeout(fn, delay) { return setTimer(fn, delay, false); },
        setInterval(fn, delay) { return setTimer(fn, delay, true); },
        get animationStops() { return animationStops; } };
}

function emitFault(socket, fault) {
    socket.emit('message', { data: JSON.stringify({ type: 'collection_fault', ...fault }) });
}

test('stopping fault synchronously freezes all activity and ignores an already queued auto-start', () => {
    const env = loadController();
    const { controller: c, socket, timers } = env;
    let started = 0;
    c.startTask = () => { started++; };
    c._scheduleAutoStart(() => c.startTask(false));
    const staleAutoStart = timers.get(c._autoStartTimer).fn;
    c.currentSessionIndex = 0;
    c.sessionCount = 2;
    c._restBetweenSessions = 1;
    c.showSessionOverlay = () => {};
    c.hideSessionOverlay = () => {};
    c.updateSessionOverlayCountdown = () => {};
    c.updateSessionSelect = () => {};
    c.updateGestureList = () => {};
    c.resetAnimationModules = () => {};
    c.showRestCountdownAndContinue();
    c.phaseTimer = env.setTimeout(() => {}, 500);
    c.countdownTimer = env.setInterval(() => {}, 1000);
    c.continualProgressTimer = env.setInterval(() => {}, 1000);
    c.calibrationTimer = env.setInterval(() => {}, 1000);
    const staleRestTick = timers.get(c._restCountdownTimer).fn;
    const handles = [c._autoStartTimer, c._restCountdownTimer, c.phaseTimer,
        c.countdownTimer, c.continualProgressTimer, c.calibrationTimer];

    c.getWebSocket();
    emitFault(socket, { fault_id: 'fault-1', phase: 'stopping', source: 'ble', code: 'disconnect', message: '蓝牙断开' });
    staleAutoStart();
    staleRestTick();

    assert.equal(c._isRunning, false);
    assert.equal(c._isAllSessionsMode, false);
    assert.equal(c._spaceKeyEnabled, false);
    assert.equal(c._saveState, 'stopping');
    assert.ok(handles.every(id => timers.get(id).cleared), 'all collection and rest timers should be cancelled');
    assert.ok(env.animationStops >= 4);
    assert.equal(started, 0, 'a queued auto-start must be fenced off after cancellation');
    assert.deepEqual(socket.messages, [], 'backend already owns stop/save; do not send a second command');
    assert.match(env.status.at(-1), /尽量保存已有数据/);
    assert.equal(env.alerts.length, 0, 'the final dialog waits for the stopped phase');
});

test('stopped fault restores manual start only after H5 success and shows deduplicated text results', () => {
    const env = loadController();
    const { controller: c, socket } = env;
    c.getWebSocket();
    const fault = {
        fault_id: 'camera-7', phase: 'stopped', source: 'camera', code: 'camera_write_failed',
        error: '摄像头写入失败', file_path: 'D:\\data\\trial_007.h5',
        save_result: {
            h5: { status: 'success', file_path: 'D:\\data\\trial_007.h5' },
            video: { status: 'error', msg: 'AVI文件未完成' },
            ble: { status: 'success', msg: '设备流已停止' }
        }
    };
    emitFault(socket, fault);
    emitFault(socket, fault);

    assert.equal(c._saveState, 'idle');
    assert.equal(c._isRunning, false);
    assert.equal(env.elements.get('startTaskBtn').disabled, false);
    assert.equal(env.alerts.length, 1, 'duplicate stopped packets must not open another dialog');
    assert.match(env.alerts[0], /摄像头写入失败/);
    assert.match(env.alerts[0], /trial_007\.h5/);
    assert.match(env.alerts[0], /H5：成功/);
    assert.match(env.alerts[0], /视频：失败；AVI文件未完成/);
    assert.match(env.alerts[0], /设备链路：成功/);
    assert.match(env.alerts[0], /不能视为完整保存/);
    assert.deepEqual(socket.messages, []);
});

test('H5 failure keeps retry state; retry uses the fault-specific command and opens a fresh result dialog', async () => {
    const env = loadController();
    const { controller: c, socket, elements } = env;
    c.getWebSocket();
    emitFault(socket, {
        fault_id: 'disk-9', phase: 'stopped', source: 'storage', code: 'disk_full', error: '磁盘已满',
        save_result: { h5: { status: 'error', msg: '磁盘空间不足' }, video: { status: 'success' }, ble: { status: 'success' } }
    });
    assert.equal(c._saveState, 'save_failed');
    assert.equal(elements.get('stopTaskBtn').textContent, '重试保存');
    assert.equal(env.alerts.length, 1);

    let attempt = 0;
    const requests = [];
    c.sendToRealtimeEngineAndWait = async (action, data) => {
        requests.push({ action, data });
        attempt++;
        if (attempt === 1) return { save_result: { h5: { status: 'error', msg: '仍然磁盘已满' }, video: { status: 'success' }, ble: { status: 'success' } } };
        return { save_result: { h5: { status: 'success', file_path: 'E:\\trial.h5' }, video: { status: 'success' }, ble: { status: 'success' } } };
    };

    await c.stopTask();
    assert.equal(c._saveState, 'save_failed');
    assert.equal(elements.get('stopTaskBtn').textContent, '重试保存');
    assert.equal(env.alerts.length, 2, 'a completed retry produces its own result dialog');
    assert.match(env.alerts[1], /仍然磁盘已满/);

    await c.stopTask();
    assert.equal(c._saveState, 'idle');
    assert.equal(c._isRunning, false);
    assert.equal(env.alerts.length, 3);
    assert.match(env.alerts[2], /H5：成功/);
    assert.match(env.alerts[2], /不会自动继续/);
    assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
        { action: 'retry_collection_fault', data: { fault_id: 'disk-9' } },
        { action: 'retry_collection_fault', data: { fault_id: 'disk-9' } }
    ]);
    assert.deepEqual(socket.messages, []);
});

test('missing H5 or video confirmation is stated as uncertain and cannot claim complete success', () => {
    const env = loadController();
    const { controller: c, socket } = env;
    c.getWebSocket();
    emitFault(socket, {
        fault_id: 'unknown-3', phase: 'stopped', source: 'engine', message: '数据链路错误',
        save_result: { h5: { status: 'success' } }
    });
    assert.equal(env.alerts.length, 1);
    assert.match(env.alerts[0], /视频：结果不确定，未收到保存确认/);
    assert.match(env.alerts[0], /不能视为完整保存/);
});

test('closed H5 with failed final validation unlocks manual start and reports readable partial data', () => {
    const env = loadController();
    const { controller: c, socket, elements } = env;
    c.getWebSocket();
    emitFault(socket, {
        fault_id: 'disk-closed-4', phase: 'stopped', source: 'storage', code: 'attribute_write_failed',
        error: '最终属性写入失败', file_path: 'D:\\data\\partial.h5',
        save_result: {
            h5: {
                status: 'error', file_closed: true, file_path: 'D:\\data\\partial.h5',
                readback: { ok: true, emg_rows: { dev1: 120, dev2: 118 } }, msg: '属性写入失败'
            },
            video: { status: 'success' }, ble: { status: 'success' }
        }
    });

    assert.equal(c._saveState, 'idle');
    assert.equal(elements.get('startTaskBtn').disabled, false);
    assert.equal(elements.get('stopTaskBtn').textContent, '停止');
    assert.match(env.alerts[0], /文件已关闭，但最终保存校验不完整/);
    assert.match(env.alerts[0], /已读回部分数据/);
    assert.match(env.alerts[0], /dev1 120/);
    assert.match(env.alerts[0], /不能视为完整保存/);
});

test('H5 not created unlocks manual start and clearly states that this run data was not saved', () => {
    const env = loadController();
    const { controller: c, socket, elements } = env;
    c.getWebSocket();
    emitFault(socket, {
        fault_id: 'create-failed-5', phase: 'stopped', source: 'storage', code: 'create_failed',
        save_result: {
            h5: { status: 'not_created', no_file: true, msg: '本轮未创建H5文件' },
            video: { status: 'success', sides: { left: { status: 'success' } } },
            ble: { status: 'error', msg: '设备链路已停止' }
        }
    });

    assert.equal(c._saveState, 'idle');
    assert.equal(elements.get('startTaskBtn').disabled, false);
    assert.equal(elements.get('stopTaskBtn').textContent, '停止');
    assert.match(env.alerts[0], /H5：本轮未创建H5，未保存采集数据/);
    assert.match(env.alerts[0], /本轮未创建H5文件/);
    assert.doesNotMatch(env.alerts[0], /H5：成功|文件已关闭/);
    assert.match(env.alerts[0], /不能视为完整保存/);
});

test('fault during pending collection_start fences the resumed start chain', async () => {
    const env = loadController();
    const { controller: c, socket } = env;
    let resolveStart;
    const startPromise = new Promise(resolve => { resolveStart = resolve; });
    const commands = [];
    c._isRunning = false;
    env.window.waveformController.refreshQualityVisibility = () => {};
    c._saveState = 'idle';
    c.currentTaskId = 'discrete_gesture';
    c.currentStageIndex = 0;
    c.stages = [{ name: 'Stage 1' }];
    c.gestures = [];
    c.collectionConfig = {};
    c._isResumeMode = false;
    c._isAllSessionsMode = false;
    c.sessionCount = 1;
    c.currentSessionIndex = 0;
    c.loadCollectionConfig = () => {};
    c._syncCollectionConfigTask = () => {};
    c.updateTaskHeader = () => {};
    c.sendToRealtimeEngine = action => commands.push(action);
    c.resetAnimationModules = () => {};
    c.updateControlButtons = () => {};
    c.updateNextStageButton = () => {};
    c.updateGestureList = () => {};
    c._enableSpaceKey = () => {};
    c._disableSpaceKey = () => {};
    c._generateRecordingSessionId = () => 'recording-1';
    c.sendToRealtimeEngineAndWait = (action) => {
        commands.push(action);
        return action === 'collection_start' ? startPromise : Promise.resolve({});
    };
    c.startDiscreteGestureCollection = async () => { commands.push('stage_start'); };
    c.getWebSocket();

    const starting = c.startTask(false);
    assert.equal(c._saveState, 'starting');
    emitFault(socket, {
        fault_id: 'start-race', phase: 'stopping', source: 'storage', error: '磁盘已满'
    });
    emitFault(socket, {
        fault_id: 'start-race', phase: 'stopped', source: 'storage', error: '磁盘已满',
        save_result: { h5: { status: 'success' } }
    });
    resolveStart({});
    await starting;

    assert.equal(c._saveState, 'idle', 'the old start continuation must preserve the fault result');
    assert.equal(c._isRunning, false);
    assert.equal(commands.includes('stage_start'), false);
    assert.equal(commands.includes('abnormal_interrupt_freeze'), false);
});

test('fault during pending stage close fences completion UI and automatic next-session path', async () => {
    const env = loadController();
    const { controller: c, socket } = env;
    let resolveStop;
    const stopPromise = new Promise(resolve => { resolveStop = resolve; });
    let restStarts = 0;
    let breakpointClears = 0;
    c._collectionSessionGeneration = 8;
    c._saveState = 'collecting';
    c._isRunning = true;
    c._isAllSessionsMode = true;
    c.currentSessionIndex = 0;
    c.sessionCount = 2;
    c.currentStageIndex = 0;
    c.stages = [{ name: 'Stage 1' }];
    c.sendToRealtimeEngine = () => {};
    c.hideGestureGif = () => {};
    c._setSaveState = state => { c._saveState = state; };
    c.sendToRealtimeEngineAndWait = () => stopPromise;
    c.showRestCountdownAndContinue = () => { restStarts++; };
    c._clearBreakpointState = () => { breakpointClears++; };
    c.getWebSocket();

    const completing = c.onAllGesturesComplete();
    assert.equal(c._saveState, 'stopping');
    emitFault(socket, {
        fault_id: 'complete-race', phase: 'stopping', source: 'engine', error: '数据链路故障'
    });
    emitFault(socket, {
        fault_id: 'complete-race', phase: 'stopped', source: 'engine', error: '数据链路故障',
        save_result: { h5: { status: 'success' } }
    });
    resolveStop({ ok: true });
    await completing;

    assert.equal(c._saveState, 'idle');
    assert.equal(c._isRunning, false);
    assert.equal(restStarts, 0, 'faulted completion must not enter rest or automatically start another session');
    assert.equal(breakpointClears, 0, 'faulted completion must not clear state as a normal completion');
    assert.match(env.status.at(-1), /异常采集已停止/);
});
