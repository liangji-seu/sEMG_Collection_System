const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadEngine(WebSocketCtor = null) {
    class FakeSocket { async connect() {} async send() {} async receive() { return [Buffer.from('{"status":"success"}')]; } close() {} }
    const express = () => ({ use() {}, json() {} }); express.json = () => ({});
    const module = { exports: {} };
    const context = {
        AggregateError, Buffer, Date, JSON, Math, Number, Promise, Set, String, console,
        clearTimeout, setTimeout,
        require(name) {
            if (name === 'events') return require('events');
            if (name === 'ws') return WebSocketCtor || { OPEN: 1, Server: class {} };
            if (name === 'zeromq') return { Request: FakeSocket, Push: FakeSocket };
            if (name === 'express') return express;
            if (name === 'cors') return () => {};
            if (name === './constants.js') return { collection_task_name: {}, discrete_gesture_prompt_name: {} };
            throw new Error(`Unexpected module: ${name}`);
        }, module, exports: module.exports
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../realtimeEngine.js'), 'utf8'), context);
    return module.exports;
}

function active(engine, { camera = false, bins = { dev1: 'left-bin', dev2: 'right-bin' } } = {}) {
    engine.collectionState = 'collecting';
    engine.isCollecting = true;
    engine.streamMode = 'collection';
    engine.collectionPaused = false;
    engine.collectionBinFilenames = bins;
    engine.stageFileOpen = true;
    engine.storageFileToken = 'file-token';
    engine.collectionHealth = { filename: 'capture.h5', fileToken: 'file-token', sides: {
        dev1: { received_valid_emg_rows: 12, sent_to_storage_rows: 10, lastValidEmgAt: 0, pending: 2, filtered_rows_by_reason: {} },
        dev2: { received_valid_emg_rows: 8, sent_to_storage_rows: 8, lastValidEmgAt: 0, pending: 0, filtered_rows_by_reason: {} }
    } };
    engine.videoFileNames = camera ? { left: 'left.avi', right: null } : { left: null, right: null };
    engine.videoRecordingStarted = camera;
    engine._stopBleCollectionForFault = async () => ({ success: true });
    engine.closeStageFile = async (_params, incomplete) => {
        assert.equal(incomplete, true);
        engine.stageFileOpen = false;
        return { status: 'success', file_closed: true };
    };
}

test('a fault synchronously freezes admission, deduplicates causes, and waits for queued PUSH before close', async () => {
    const e = loadEngine(); active(e);
    let releasePush;
    e.storagePushSendChain = new Promise(resolve => { releasePush = resolve; });
    const first = e.requestCollectionFault({ source: 'ble', code: 'ble_disconnected', device_id: 1, sd_prefix: 'left-bin', message: '断开' });
    const faultId = e.collectionFault.fault_id;
    const second = e.requestCollectionFault({ source: 'storage', code: 'disk_full', message: '磁盘满' });
    assert.equal(e.isCollecting, false);
    assert.equal(e.collectionState, 'fault_stopping');
    assert.equal(e.storageDataSendError, null);
    assert.equal(e.collectionFault.causes.length, 2);
    assert.equal(e.collectionFault.file_token, 'file-token');
    let closed = false;
    e.closeStageFile = async (_params, incomplete) => { closed = true; assert.equal(incomplete, true); return { status: 'success', file_closed: true }; };
    await Promise.resolve(); await Promise.resolve();
    assert.equal(closed, false);
    releasePush();
    await first; await second;
    assert.equal(closed, true);
    assert.equal(e.collectionFault.fault_id, faultId);
    assert.equal(e.collectionState, 'interrupted');
    assert.equal(e.collectionFault.save_result.h5.status, 'success');
});

test('camera save failure does not prevent H5 close; no configured camera is not a fault target', async () => {
    const e = loadEngine(); active(e);
    assert.equal(e.requestCollectionFault({ source: 'camera', side: 'left', code: 'camera_disconnected' }), false);
    await e.collectionCommandChain;
    active(e, { camera: true });
    e.sendCameraCommand = async (_command, _data, timeout) => { assert.equal(timeout, 30000); throw new Error('camera offline'); };
    const pending = e.requestCollectionFault({ source: 'camera', side: 'left', code: 'camera_disconnected', message: '服务断开' });
    await pending;
    assert.equal(e.collectionFault.save_result.h5.status, 'success');
    assert.match(e.collectionFault.save_result.video.msg, /camera offline/);
    assert.match(e.collectionFault.save_result.video.sides.left.error, /camera offline/);
    assert.equal(e.collectionState, 'interrupted');
});

test('fatal H5 create warning stops collection even when the toast warning was already shown', async () => {
    const e = loadEngine(); active(e);
    e.stageFileOpen = false;
    e.stageFileCreateFailed = true;
    e.h5StorageWarningShown = true;
    e.closeStageFile = Object.getPrototypeOf(e).closeStageFile.bind(e);
    e.sendStorageCommand = async command => command === 'get_file_status'
        ? { status: 'success', open: false, file_token: 'file-token' }
        : { status: 'success' };
    e.notifyH5StorageWarning('H5创建失败：磁盘已满');
    assert.equal(e.collectionFault.code, 'disk_full');
    await e.collectionFaultFinalizePromise;
    assert.equal(e.collectionState, 'interrupted');
    assert.equal(e.collectionFault.save_result.h5.status, 'not_created');
    assert.equal(e.collectionFault.save_result.h5.no_file, true);
});

test('normal video save failure remains an error and still triggers incomplete H5 finalization', async () => {
    const e = loadEngine(); active(e, { camera: true });
    let incompleteClose = 0;
    e.sendCameraCommand = async () => { throw new Error('AVI save failed'); };
    e.closeStageFile = async (_params, incomplete) => {
        assert.equal(incomplete, true);
        incompleteClose++;
        e.stageFileOpen = false;
        return { status: 'success', file_closed: true };
    };
    const stop = await e.onCollectionStop(true);
    assert.equal(stop.status, 'error');
    await e.collectionFaultFinalizePromise;
    assert.equal(incompleteClose, 1);
    assert.equal(e.collectionFault.source, 'camera');
    assert.equal(e.collectionFault.save_result.h5.status, 'success');
    assert.equal(e.collectionFault.save_result.video.status, 'error');
});

test('BLE stop result reports per-device STOP failures and does not overstate legacy ACKs', async () => {
    const e = loadEngine(); active(e);
    e._stopBleCollectionForFault = async () => ({ success: true, stop_results: {
        dev1: { device_id: 1, local_stopped: true, stop_command_sent: true },
        dev2: { device_id: 2, local_stopped: true, stop_command_sent: false, error: '设备未响应' }
    } });
    await e.requestCollectionFault({ source: 'ble', code: 'ble_disconnected', device_id: 2, sd_prefix: 'right-bin', message: '断开' });
    assert.equal(e.collectionFault.save_result.ble.status, 'error');
    assert.match(e.collectionFault.save_result.ble.msg, /右手 right-bin/);
    assert.match(e.collectionFault.save_result.ble.msg, /服务端本地已停止接收，设备侧STOP未确认/);

    const legacy = loadEngine(); active(legacy);
    legacy._stopBleCollectionForFault = async () => ({ success: true });
    await legacy.requestCollectionFault({ source: 'ble', code: 'ble_disconnected', device_id: 1, message: '断开' });
    assert.equal(legacy.collectionFault.save_result.ble.status, 'unverified');
    assert.match(legacy.collectionFault.save_result.ble.msg, /设备侧未核实/);
    assert.notEqual(legacy.collectionFault.save_result.ble.status, 'success');
});

test('fault causes deduplicate repeats, cap detail at sixteen, and count omitted causes', async () => {
    const e = loadEngine(); active(e);
    e._finalizeCollectionFault = async () => ({ status: 'success' });
    e.requestCollectionFault({ source: 'storage', code: 'storage_write_failed', message: 'same error' });
    for (let i = 0; i < 50; i++) e.requestCollectionFault({ source: 'storage', code: 'storage_write_failed', message: 'same error' });
    for (let i = 0; i < 20; i++) e.requestCollectionFault({ source: 'storage', code: `error_${i}`, message: `detail ${i}` });
    assert.equal(e.collectionFault.causes.length, 16);
    assert.equal(e.collectionFault.repeated_causes_count, 50);
    assert.equal(e.collectionFault.omitted_causes_count, 5);
    await e.collectionFaultFinalizePromise;
});

test('H5 close retry reflects an emergency closed file and unlocks only after confirmed close', async () => {
    const e = loadEngine(); active(e);
    let attempt = 0;
    e.closeStageFile = async () => ++attempt === 1
        ? { status: 'error', msg: 'metadata write failed' }
        : { status: 'error', msg: 'metadata write failed', file_closed: true, readback: { emg_rows: { dev1: 12, dev2: 8 } } };
    const first = e.requestCollectionFault({ source: 'storage', code: 'storage_write_failed', message: 'write error' });
    await first;
    assert.equal(e.collectionState, 'save_failed');
    assert.equal(e.stageFileOpen, true);
    const retry = await e.retryCollectionFault({ fault_id: e.collectionFault.fault_id });
    assert.equal(retry.status, 'success');
    assert.equal(retry.save_complete, false);
    assert.equal(e.stageFileOpen, false);
    assert.equal(e.collectionState, 'interrupted');
    assert.equal(e.collectionFault.save_result.h5.file_closed, true);
    assert.equal(e.collectionFault.save_result.h5.readback.emg_rows.dev1, 12);
});

test('retry failure returns an RPC result with live save_result and preserves save_failed state', async () => {
    const e = loadEngine(); active(e);
    e.closeStageFile = async () => ({ status: 'error', msg: 'disk remains full' });
    const initial = e.requestCollectionFault({ source: 'storage', code: 'disk_full', message: 'disk full' });
    await initial;
    const sent = [];
    const ws = { readyState: 1, send: value => sent.push(JSON.parse(value)) };
    await e.handleFrontendMessage(Buffer.from(JSON.stringify({ type: 'control_command', action: 'retry_collection_fault', data: { fault_id: e.collectionFault.fault_id }, commandId: 'retry' })), ws);
    const reply = sent.find(packet => packet.commandId === 'retry');
    assert.equal(reply.status, 'success');
    assert.equal(reply.result.save_complete, false);
    assert.equal(reply.result.save_result.h5.status, 'error');
    assert.match(reply.result.save_result.h5.msg, /disk remains full/);
    assert.equal(e.collectionState, 'save_failed');
});

test('PUSH failure retries the exact append through REP and continues the round without fault', async () => {
    const e = loadEngine(); active(e);
    e.storage_push_connected = true;
    e.storage_push_socket.send = async () => { throw new Error('socket ACK lost'); };
    const attempts = [];
    e.sendStorageCommand = async (command, params) => {
        attempts.push({ command, params });
        return { status: 'success' };
    };
    await e.saveDataToStorage({ emg1: [[1, 2]], emg2: [[3]] });
    await e.saveDataToStorage({ emg1: [[4]], emg2: [] });
    assert.deepEqual(attempts.map(item => item.params._storage_seq), [1, 2]);
    assert.equal(attempts[0].params._storage_file_token, 'file-token');
    assert.equal(attempts[0].params.data.emg1[0].length, 2);
    assert.equal(e.storagePushFallbackActive, true);
    assert.equal(e.storageDataSendError, null);
    assert.equal(e.collectionFault, null);
});

test('storage poll detects low reserve, write_error and 10 second stalled actual rows', async () => {
    const e = loadEngine(); active(e);
    e.collectionDiskReserveBytes = 256;
    e.sendStorageCommand = async () => ({ status: 'success', file_token: 'file-token', open: true,
        data_health: { disk_free_bytes: 128, emg_rows: { dev1: 2, dev2: 2 }, sequences: { written: 4 } } });
    e.collectionHealthClock = () => 0;
    await e._pollCollectionFaultHealth();
    assert.equal(e.collectionFault.code, 'disk_space_low');
    assert.match(e.collectionFault.message, /预留收尾空间/);

    const writeError = loadEngine(); active(writeError);
    writeError.sendStorageCommand = async () => ({ status: 'success', file_token: 'file-token', open: true,
        data_health: { write_error: 'disk full', disk_free_bytes: 4096 } });
    await writeError._pollCollectionFaultHealth();
    assert.equal(writeError.collectionFault.code, 'disk_full');

    const stalled = loadEngine(); active(stalled);
    let now = 1000; stalled.collectionHealthClock = () => now;
    stalled.collectionHealth.sides.dev1.received_valid_emg_rows = 100;
    stalled.collectionHealth.sides.dev1.sent_to_storage_rows = 90;
    stalled.storageDataLastSentSequence = 9;
    stalled.sendStorageCommand = async () => ({ status: 'success', file_token: 'file-token', open: true,
        data_health: { disk_free_bytes: 999999999, emg_rows: { dev1: 5, dev2: 5 }, sequences: { written: 7 } } });
    await stalled._pollCollectionFaultHealth();
    now += 10000;
    stalled.collectionHealth.sides.dev1.received_valid_emg_rows += 5;
    stalled.collectionHealth.sides.dev1.sent_to_storage_rows += 5;
    stalled.storageDataLastSentSequence = 10;
    await stalled._pollCollectionFaultHealth();
    assert.equal(stalled.collectionFault.code, 'storage_write_stalled');
    assert.match(stalled.collectionFault.message, /received=105, sent=95, actual=5/);
});

test('unexpected collection stream stop faults only an active collecting stage with participant bins', async () => {
    const e = loadEngine(); active(e);
    e.onSdFilenamesUpdated({ dev1: 'left-bin', dev2: 'right-bin' }, {}, 'preview');
    assert.equal(e.collectionFault.code, 'collection_stream_stopped');

    const idle = loadEngine(); idle.streamMode = 'preview';
    idle.onSdFilenamesUpdated({ dev1: 'left-bin', dev2: null }, {}, 'idle');
    assert.equal(idle.collectionFault, null);
});

test('fault BLE stop ignores mismatched ACKs and absorbs late errors after CONNECTING timeout', async () => {
    const EventEmitter = require('events');
    const sockets = [];
    class FakeWebSocket extends EventEmitter {
        constructor(url) { super(); this.url = url; this.readyState = 0; sockets.push(this); }
        send(payload) { this.sent = JSON.parse(payload); }
        close() { this.closed = true; }
    }
    const e = loadEngine(FakeWebSocket);
    const pending = e._stopBleCollectionForFault({ fault_id: 'f-ack' });
    const socket = sockets[0];
    socket.emit('open');
    socket.emit('message', Buffer.from(JSON.stringify({ action: 'stop_collection_stream', request_id: 'wrong', success: true })));
    let settled = false; pending.finally(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    socket.emit('message', Buffer.from(JSON.stringify({ action: 'stop_collection_stream', request_id: socket.sent.request_id, success: true })));
    assert.equal((await pending).success, true);
    assert.equal(socket.closed, true);
    socket.emit('error', new Error('late close error'));

    e.bleFaultStopTimeoutMs = 5;
    const timeout = e._stopBleCollectionForFault({ fault_id: 'f-timeout' });
    const connecting = sockets[1];
    await assert.rejects(timeout, /超时/);
    assert.equal(connecting.closed, true);
    connecting.emit('error', new Error('closed before connection established'));
});

test('stale H5 and camera status poll replies cannot fault a replacement collection', async () => {
    const e = loadEngine(); active(e, { camera: true });
    let rejectOldH5;
    e.sendStorageCommand = () => new Promise((_resolve, reject) => { rejectOldH5 = reject; });
    e.sendCameraCommand = async () => ({ disk_free_bytes: 999999999, recording: { left: true } });
    const oldH5Poll = e._pollCollectionFaultHealth();
    e.storageFileToken = 'new-token'; e.collectionHealth = { fileToken: 'new-token' };
    rejectOldH5(new Error('old file status unavailable'));
    await oldH5Poll;
    assert.equal(e.collectionFault, null);

    active(e, { camera: true });
    let rejectOldCamera;
    e.sendStorageCommand = async () => ({ status: 'success', file_token: 'file-token', open: true,
        data_health: { disk_free_bytes: 999999999, emg_rows: { dev1: 1, dev2: 1 } } });
    e.sendCameraCommand = () => new Promise((_resolve, reject) => { rejectOldCamera = reject; });
    const oldCameraPoll = e._pollCollectionFaultHealth();
    e.storageFileToken = 'newer-token'; e.collectionHealth = { fileToken: 'newer-token' };
    rejectOldCamera(new Error('old camera status unavailable'));
    await oldCameraPoll;
    assert.equal(e.collectionFault, null);
    assert.equal(e.collectionStorageProgress, null);
});

test('a collection_start queued before a fault cannot revive after fault cleanup', async () => {
    const e = loadEngine(); active(e);
    let releaseQueue;
    e.collectionCommandChain = new Promise(resolve => { releaseQueue = resolve; });
    let startCount = 0;
    e.onCollectionStart = async () => {
        startCount++;
        e.collectionFault = null;
        e.collectionState = 'starting';
        return { status: 'success' };
    };
    e._finalizeCollectionFault = async fault => {
        e.collectionState = 'interrupted';
        e.stageFileOpen = false;
        fault.phase = 'stopped';
        return { status: 'success', fault_id: fault.fault_id };
    };
    const replies = [];
    const client = { readyState: 1, send: value => replies.push(JSON.parse(value)) };
    const queuedStart = e.handleFrontendMessage(Buffer.from(JSON.stringify({ type: 'control_command', action: 'collection_start', commandId: 'queued' })), client);
    const finalize = e.requestCollectionFault({ source: 'ble', code: 'ble_disconnected', device_id: 1 });
    releaseQueue();
    await queuedStart;
    await finalize;
    assert.equal(startCount, 0);
    assert.match(replies.find(item => item.commandId === 'queued').error, /已取消/);

    const stageSelection = await e.handleFrontendMessage(Buffer.from(JSON.stringify({ type: 'control_command', action: 'stage_change', data: { stageIndex: 1, stageName: 'manual-stage' }, commandId: 'stage-select' })), client);
    assert.equal(stageSelection, undefined);
    assert.equal(replies.find(item => item.commandId === 'stage-select').status, 'success');
    const sessionSelection = await e.handleFrontendMessage(Buffer.from(JSON.stringify({ type: 'control_command', action: 'session_change', data: { sessionIndex: 1, sessionNumber: 2 }, commandId: 'session-select' })), client);
    assert.equal(sessionSelection, undefined);
    assert.equal(replies.find(item => item.commandId === 'session-select').status, 'success');
    const blockedStageStart = await e.handleFrontendMessage(Buffer.from(JSON.stringify({ type: 'control_command', action: 'stage_start', data: { stageName: 'stage-a' }, commandId: 'stage-start' })), client);
    assert.equal(blockedStageStart.status, 'error');

    const manualStart = e.handleFrontendMessage(Buffer.from(JSON.stringify({ type: 'control_command', action: 'collection_start', commandId: 'manual' })), client);
    await manualStart;
    assert.equal(startCount, 1);
});
