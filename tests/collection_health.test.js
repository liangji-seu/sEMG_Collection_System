const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadEngine({ captureLogs = false } = {}) {
    class FakeSocket {
        async connect() {}
        async send() {}
        async receive() { return [Buffer.from('{"status":"success"}')]; }
        close() {}
    }
    const express = () => ({ use() {}, json() {} });
    express.json = () => ({});
    const module = { exports: {} };
    const logs = [];
    const context = {
        AggregateError, Buffer, Date, JSON, Math, Number, Promise, Set, String,
        console: {
            log(...args) { if (captureLogs) logs.push(args.join(' ')); },
            warn(...args) { if (captureLogs) logs.push(args.join(' ')); },
            error(...args) { if (captureLogs) logs.push(args.join(' ')); }
        }, clearTimeout, setTimeout,
        require(name) {
            if (name === 'events') return require('events');
            if (name === 'ws') return { OPEN: 1, Server: class {} };
            if (name === 'zeromq') return { Request: FakeSocket, Push: FakeSocket };
            if (name === 'express') return express;
            if (name === 'cors') return () => {};
            if (name === './constants.js') return { collection_task_name: {}, discrete_gesture_prompt_name: {} };
            throw new Error(`Unexpected module: ${name}`);
        },
        module, exports: module.exports
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../realtimeEngine.js'), 'utf8'), context);
    if (captureLogs) module.exports.__testLogs = logs;
    return module.exports;
}

function prepareHealth(engine, initialTime = 0) {
    let now = initialTime;
    const ticks = [];
    const notifications = [];
    engine.collectionHealthClock = () => now;
    engine.collectionHealthSetTimeout = callback => {
        ticks.push(callback);
        return { unref() {} };
    };
    engine.collectionHealthClearTimeout = () => {};
    engine.notifyCollectionHealthWarning = message => notifications.push(message);
    engine.isCollecting = true;
    engine.collectionPaused = false;
    engine.isTestMode = false;
    engine.collectionState = 'collecting';
    engine.streamMode = 'collection';
    engine._resetCollectionHealth();
    engine._startCollectionHealthTimer();
    return {
        notifications,
        advance(ms) { now += ms; },
        tick() { const callback = ticks.shift(); assert.ok(callback, 'expected a scheduled health tick'); callback(); }
    };
}

test('both hands with recent raw EMG stay healthy without a warning', () => {
    const e = loadEngine();
    const clock = prepareHealth(e);
    e._recordCollectionHealthReceived('dev1', 20);
    e._recordCollectionHealthReceived('dev2', 18);
    clock.advance(4000);
    clock.tick();
    assert.deepEqual(clock.notifications, []);
    assert.equal(e.collectionHealth.sides.dev1.received_valid_emg_rows, 20);
    assert.equal(e.collectionHealth.sides.dev2.received_valid_emg_rows, 18);
    e._stopCollectionHealthTimer();
});

test('timer warns when neither hand has sent a packet callback and does not repeat while missing', () => {
    const e = loadEngine();
    const clock = prepareHealth(e);
    clock.advance(5000);
    clock.tick();
    assert.equal(clock.notifications.length, 1);
    assert.match(clock.notifications[0], /左手、右手/);
    clock.advance(5000);
    clock.tick();
    assert.equal(clock.notifications.length, 1);
    e._stopCollectionHealthTimer();
});

test('empty active-device packets do not count as valid EMG or clear a missing warning', () => {
    const e = loadEngine();
    const clock = prepareHealth(e);
    clock.advance(5000);
    clock.tick();
    e.isRunning = true;
    e.realtimeDataMaxDelay = 100000;
    e.handleBleDataPacket({ dev1: { raw: [], uv: [], n: 0 }, active: [1] });
    assert.equal(e.collectionHealth.sides.dev1.received_valid_emg_rows, 0);
    assert.equal(e.collectionHealth.sides.dev1.warningActive, true);
    e.handleBleDataPacket({ dev1: { raw: [[1], [2], [3]], uv: [], n: 3 }, active: [1] });
    assert.equal(e.collectionHealth.sides.dev1.received_valid_emg_rows, 3);
    assert.equal(e.collectionHealth.sides.dev1.warningActive, false);
    clearTimeout(e.realtimeDataTimer);
    e.realtimeDataTimer = null;
    e._stopCollectionHealthTimer();
});

test('preview packets count as received while remaining filtered from storage', () => {
    const e = loadEngine();
    prepareHealth(e);
    e.streamMode = 'preview';
    e.isRunning = true;
    e.realtimeDataMaxDelay = 100000;
    e.stageFileOpen = true;
    e.handleBleDataPacket({ dev1: { raw: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], uv: [], n: 3 }, active: [1] });
    assert.equal(e.collectionHealth.sides.dev1.received_valid_emg_rows, 3);
    assert.equal(e.collectionHealth.sides.dev1.sent_to_storage_rows, 0);
    assert.equal(e.collectionHealth.sides.dev1.filtered_rows_by_reason.stream_not_collection, 3);
    clearTimeout(e.realtimeDataTimer);
    e.realtimeDataTimer = null;
    e._stopCollectionHealthTimer();
});

test('data before stage_start is filtered but never treated as a storage fault', () => {
    const e = loadEngine();
    prepareHealth(e);
    e.isRunning = true;
    e.isCollecting = true;
    e.collectionState = 'starting';
    e.streamMode = 'collection';
    e.stageStartRequested = false;   // 标定/准备阶段：还没发 stage_start
    e.stageFileOpen = false;
    e.collectionDataStartTs = 0;     // 宽限早已过期
    e._finalizeCollectionFault = async () => ({});
    e.handleBleDataPacket({ dev1: { raw: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], uv: [], n: 3 }, active: [1] });
    assert.equal(e.collectionHealth.sides.dev1.filtered_rows_by_reason.file_not_open, 3);
    assert.equal(e.collectionFault, null);
    clearTimeout(e.realtimeDataTimer);
    e.realtimeDataTimer = null;
    e._stopCollectionHealthTimer();
});

test('data after stage_start without an open H5 still raises a storage fault', () => {
    const e = loadEngine();
    prepareHealth(e);
    e.isRunning = true;
    e.isCollecting = true;
    e.collectionState = 'starting';
    e.streamMode = 'collection';
    e.stageStartRequested = true;    // stage_start 已发出，H5 却没打开
    e.stageFileOpen = false;
    e.collectionDataStartTs = 0;
    e._finalizeCollectionFault = async () => ({});
    e.handleBleDataPacket({ dev1: { raw: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], uv: [], n: 3 }, active: [1] });
    assert.ok(e.collectionFault, 'storage fault should be raised');
    assert.equal(e.collectionFault.code, 'storage_write_failed');
    clearTimeout(e.realtimeDataTimer);
    e.realtimeDataTimer = null;
    e._stopCollectionHealthTimer();
});

test('recovered data clears the warning state and a later interruption can warn again', () => {
    const e = loadEngine();
    const clock = prepareHealth(e);
    clock.advance(5000);
    clock.tick();
    assert.equal(clock.notifications.length, 1);
    e._recordCollectionHealthReceived('dev1', 3);
    assert.equal(e.collectionHealth.sides.dev1.warningActive, false);
    clock.advance(5000);
    clock.tick();
    assert.equal(clock.notifications.length, 2);
    e._stopCollectionHealthTimer();
});

test('pause and test mode suppress health alerts, and stop releases the timer', () => {
    const paused = loadEngine();
    const clock = prepareHealth(paused);
    clock.advance(4000);
    paused.onCollectionPause();
    clock.advance(20000);
    clock.tick();
    assert.deepEqual(clock.notifications, []);
    paused.onCollectionResume();
    clock.tick();
    assert.deepEqual(clock.notifications, []);
    clock.advance(1000);
    clock.tick();
    assert.equal(clock.notifications.length, 1);
    paused._releaseCollection();
    assert.equal(paused.collectionHealthTimer, null);

    const testMode = loadEngine();
    const testClock = prepareHealth(testMode);
    testMode.isTestMode = true;
    testMode._startCollectionHealthTimer();
    testClock.advance(10000);
    assert.equal(testMode.collectionHealthTimer, null);
    assert.deepEqual(testClock.notifications, []);
});

test('only successful storage sends increment per-hand forwarded rows', async () => {
    const e = loadEngine();
    e.collectionHealthClock = () => 100;
    e.isCollecting = true;
    e.streamMode = 'collection';
    e.stageFileOpen = true;
    e.storageFileToken = 'token-a';
    e.storage_push_connected = true;
    e.storagePushSendChain = Promise.resolve();
    e._resetCollectionHealth();
    e.storage_push_socket.send = async () => {};
    await e.saveDataToStorage({ emg1: [[1, 2, 3]], emg2: [[4, 5]] });
    assert.equal(e.collectionHealth.sides.dev1.sent_to_storage_rows, 3);
    assert.equal(e.collectionHealth.sides.dev2.sent_to_storage_rows, 2);

    const failed = loadEngine();
    failed.collectionHealthClock = () => 100;
    failed.isCollecting = true;
    failed.streamMode = 'collection';
    failed.stageFileOpen = true;
    failed.storage_push_connected = true;
    failed.storagePushSendChain = Promise.resolve();
    failed._resetCollectionHealth();
    failed.storage_push_socket.send = async () => { throw new Error('socket down'); };
    failed.sendStorageCommand = async () => { throw new Error('REP unavailable'); };
    await failed.saveDataToStorage({ emg1: [[1, 2]], emg2: [[3, 4]] });
    assert.equal(failed.collectionHealth.sides.dev1.sent_to_storage_rows, 0);
    assert.equal(failed.collectionHealth.sides.dev2.sent_to_storage_rows, 0);
    assert.equal(failed.collectionHealth.sides.dev1.pending, 0);
    assert.match(failed.storageDataSendError.message, /PUSH失败\(socket down\)/);
});

test('queued send failures retain each append sequence and do not mutate a replacement file health object', async () => {
    const e = loadEngine({ captureLogs: true });
    e.collectionHealthClock = () => 100;
    e.isCollecting = true;
    e.streamMode = 'collection';
    e.stageFileOpen = true;
    e.storage_push_connected = true;
    e.storagePushSendChain = Promise.resolve();
    e._resetCollectionHealth();
    const originalHealth = e.collectionHealth;
    e.storage_push_socket.send = async () => { throw new Error('socket down'); };
    e.sendStorageCommand = async () => { throw new Error('REP unavailable'); };
    const first = e.saveDataToStorage({ emg1: [[1]], emg2: [] });
    const second = e.saveDataToStorage({ emg1: [[2]], emg2: [] });
    e._resetCollectionHealth();
    e.collectionHealth.filename = 'replacement.h5';
    e.collectionHealth.sides.dev1.received_valid_emg_rows = 99;
    await Promise.all([first, second]);
    const failureLines = e.__testLogs.filter(line => line.includes('PUSH数据发送失败 seq='));
    const sequences = failureLines.map(line => Number(line.match(/seq=(\d+)/)?.[1]));
    assert.deepEqual(sequences, [1, 2]);
    assert.equal(originalHealth.sides.dev1.pending, 0);
    assert.equal(originalHealth.sides.dev1.sent_to_storage_rows, 0);
    assert.equal(e.collectionHealth.filename, 'replacement.h5');
});

test('failure bursts retain one complete pre-stop health snapshot and every short sequence error', async () => {
    const e = loadEngine({ captureLogs: true });
    let now = 0;
    e.collectionHealthClock = () => now;
    e.isCollecting = true;
    e.streamMode = 'collection';
    e.stageFileOpen = true;
    e.storage_push_connected = true;
    e.storagePushSendChain = Promise.resolve();
    e._resetCollectionHealth();
    e.storage_push_socket.send = async () => { throw new Error('burst socket failure'); };
    e.sendStorageCommand = async () => { throw new Error('REP burst failure'); };
    const burst = Array.from({ length: 134 }, (_, index) => e.saveDataToStorage({ emg1: [[index]], emg2: [] }));
    await Promise.all(burst);
    const snapshotCount = () => e.__testLogs.filter(line => line.includes('"event":"storage_send_failed"')).length;
    const shortFailures = () => e.__testLogs.filter(line => line.includes('PUSH数据发送失败 seq='));
    assert.equal(snapshotCount(), 1);
    assert.equal(shortFailures().length, 134);
    assert.match(shortFailures()[0], /seq=1: .*burst socket failure/);
    assert.match(shortFailures()[133], /seq=134: .*burst socket failure/);

    assert.equal(e.collectionFault.code, 'storage_write_failed');
    assert.equal(e.collectionState, 'fault_stopping');
});

test('Python close warnings are blocking, localized, and still allow the next collection', async () => {
    const e = loadEngine();
    const sent = [];
    e.clients.add({ readyState: 1, send: value => sent.push(JSON.parse(value)) });
    e.stageFileOpen = true;
    e.storagePushSendChain = Promise.resolve();
    e.storage_push_connected = false;
    e.collectionState = 'collecting';
    e.currentSessionNumber = 4;
    e.isCollecting = true;
    e.sendStorageCommand = async cmd => cmd === 'close' ? {
        status: 'success', capture_warnings: ['emg_dev2_empty'], data_health: {
            save_validation: 'valid', content_status: 'partial', emg_rows: { dev1: 12, dev2: 0 },
            file_path: 'C:\\captures\\actual_trial.h5', file_token: 'token-a', session_id: 'session-a'
        }
    } : { status: 'success' };
    const result = await e.onCollectionStop(true);
    assert.equal(result.status, 'success');
    assert.equal(e.collectionState, 'idle');
    const warning = sent.find(packet => packet.type === 'h5_storage_warning');
    assert.equal(warning.level, 'error');
    assert.equal(warning.nonBlocking, false);
    assert.equal(warning.blocking, true);
    assert.match(warning.message, /右手没有有效肌电行/);
    assert.match(warning.message, /左手 12行，右手 0行/);
    assert.match(warning.message, /actual_trial\.h5/);
    assert.match(warning.message, /第4轮/);
    assert.match(warning.message, /已完成读回校验/);
    assert.equal(await e.onCollectionStart({ taskId: 'discrete_gesture', isTestMode: true }), undefined);
    e._releaseCollection();
});

test('successful create adopts Python file_path while retaining requested filename separately', async () => {
    const e = loadEngine();
    e.storage_connected = true;
    e.sd_filenames = { dev1: 'subject.with.dot-long-bin-id.bin', dev2: null };
    e.collectionBinFilenames = { dev1: 'subject.with.dot-long-bin-id.bin', dev2: null };
    e.currentUser = { id: 'subject-a' };
    e.collectionConfig = { task_id: 'discrete_gesture' };
    e.collectionHealth = { sessionId: 'session-a', sides: { dev1: { received_valid_emg_rows: 0, sent_to_storage_rows: 0, lastValidEmgAt: null, pending: 0, filtered_rows_by_reason: {} }, dev2: { received_valid_emg_rows: 0, sent_to_storage_rows: 0, lastValidEmgAt: null, pending: 0, filtered_rows_by_reason: {} } } };
    const healthLogs = [];
    e._logCollectionHealth = (event, fields) => healthLogs.push({ event, ...fields });
    e.sendStorageCommand = async cmd => cmd === 'create' ? { status: 'success', file_path: 'C:\\captures\\python_actual_name.h5' } : { status: 'success' };
    await e._openStageFile('stage-a', 0);
    assert.equal(e.collectionHealth.filename, 'C:\\captures\\python_actual_name.h5');
    assert.ok(e.collectionHealth.requestedFilename.endsWith('.h5'));
    const opened = healthLogs.find(item => item.event === 'file_opened');
    assert.equal(opened.filename, 'C:\\captures\\python_actual_name.h5');
    assert.equal(opened.requested_filename, e.collectionHealth.requestedFilename);
    e._releaseCollection();
});

test('expected device ids from collection_start reach the H5 create params', async () => {
    const e = loadEngine();
    e.storage_connected = true;
    e.camera_connected = false;
    e._markVideoRecordingStart = async () => { e.videoRecordingStarted = false; };
    let createParams = null;
    e.sendStorageCommand = async (cmd, params) => {
        if (cmd === 'create') {
            createParams = params;
            return { status: 'success', file_path: 'C:\\captures\\two_hands.h5' };
        }
        return { status: 'success' };
    };
    await e.onCollectionStart({
        taskId: 'discrete_gesture', stageName: 'stage-a', userId: 'subject-a',
        config: { task_id: 'discrete_gesture' },
        collectionBins: { dev1: 'L-bin', dev2: 'R-bin' },
        collectionDeviceIds: [2, 1, 2]
    });
    // 引擎在 vm 沙箱里运行，数组原型与宿主不同，用 JSON 比较避免 deepStrictEqual 误报。
    assert.equal(JSON.stringify(e.collectionExpectedDeviceIds), '[1,2]');
    await e._openStageFile('stage-a', 0);
    assert.equal(JSON.stringify(createParams.physical_device_ids), '[1,2]');
    e._releaseCollection();
});

test('waveform routes nonblocking warnings to warning toast and leaves real errors blocking', () => {
    const messages = [];
    const window = { collectionController: { showToast: (message, level) => messages.push({ message, level }) }, addEventListener() {} };
    const document = { addEventListener() {} };
    const source = fs.readFileSync(require.resolve('../public/scripts/waveform.js'), 'utf8')
        .replace('    class WaveformController {', '    window.TestReceiver = RealtimeDataReceiver;\n    class WaveformController {');
    const context = { window, document, WebSocket: { OPEN: 1, CONNECTING: 0 }, console: { log() {}, warn() {}, error() {} },
        alert(message) { throw new Error(`unexpected alert: ${message}`); }, setTimeout, clearTimeout, Date, JSON, Math };
    vm.runInNewContext(source, context);
    const receiver = new window.TestReceiver({});
    receiver.handleMessage(JSON.stringify({ type: 'h5_storage_warning', level: 'warning', nonBlocking: true, message: '缺少右手数据' }));
    receiver.handleMessage(JSON.stringify({ type: 'h5_storage_warning', level: 'error', message: '磁盘写入失败' }));
    assert.deepEqual(messages.map(item => item.level), ['warning', 'error']);
});
