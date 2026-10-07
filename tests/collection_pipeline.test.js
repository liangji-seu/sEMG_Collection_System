const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadEngineWithoutNativeSockets() {
    class FakeSocket {
        async connect() {}
        async send() {}
        async receive() { return [Buffer.from('{"status":"success"}')]; }
        close() {}
    }
    const fakeExpress = () => ({ use() {}, json() {} });
    fakeExpress.json = () => ({});
    const fakeModules = {
        ws: { OPEN: 1, Server: class {} },
        zeromq: { Request: FakeSocket, Push: FakeSocket },
        express: fakeExpress,
        cors: () => {},
        './constants.js': {
            discrete_gesture_prompt_name: {},
            collection_task_name: {}
        }
    };
    const module = { exports: {} };
    const source = fs.readFileSync(require.resolve('../realtimeEngine.js'), 'utf8');
    const context = {
        Buffer, Date, JSON, Math, Number, Promise, Set, String,
        console, clearTimeout, setTimeout,
        require(name) {
            if (name === 'events') return require('events');
            if (fakeModules[name]) return fakeModules[name];
            throw new Error(`Unexpected module: ${name}`);
        },
        module,
        exports: module.exports
    };
    vm.runInNewContext(source, context, { filename: 'realtimeEngine.js' });
    return module.exports;
}

const engine = loadEngineWithoutNativeSockets();

test('REP fallback shares PUSH ordering, file identity and the close barrier', async () => {
    const e = loadEngineWithoutNativeSockets();
    e.streamMode = 'collection'; e.stageFileOpen = true;
    e.storageFileToken = 'file-a'; e.storage_push_connected = true;
    let releasePush, releaseRep;
    const pushGate = new Promise(resolve => { releasePush = resolve; });
    const repGate = new Promise(resolve => { releaseRep = resolve; });
    const events = [];
    e.storage_push_socket.send = async request => {
        const params = JSON.parse(request).params;
        assert.equal(params._storage_file_token, 'file-a');
        assert.equal(params._storage_seq, 1);
        events.push('push'); await pushGate;
    };
    e.sendStorageCommand = async (cmd, params) => {
        events.push(cmd);
        assert.equal(params._storage_file_token, 'file-a');
        if (cmd === 'append') {
            assert.equal(params._storage_seq, 2); await repGate;
        } else assert.equal(params._storage_data_seq, 2);
        return { status: 'success' };
    };
    const first = e.saveDataToStorage({});
    await new Promise(resolve => setImmediate(resolve));
    e.storage_push_connected = false;
    const second = e.saveDataToStorage({});
    const close = e.closeStageFile();
    releasePush();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['push', 'append']);
    releaseRep();
    await Promise.all([first, second, close]);
    assert.deepEqual(events, ['push', 'append', 'close']);
});

test('close waits for queued PUSH data before sending close', async () => {
    const original = {
        streamMode: engine.streamMode,
        stageFileOpen: engine.stageFileOpen,
        stageFileOpening: engine.stageFileOpening,
        stageFileOpenPromise: engine.stageFileOpenPromise,
        isClosingStageFile: engine.isClosingStageFile,
        storage_push_connected: engine.storage_push_connected,
        storage_push_socket: engine.storage_push_socket,
        storagePushSendChain: engine.storagePushSendChain,
        storageDataSequence: engine.storageDataSequence,
        storageDataLastSentSequence: engine.storageDataLastSentSequence,
        sendStorageCommand: engine.sendStorageCommand
    };

    const events = [];
    let releaseSend;
    const sendGate = new Promise(resolve => { releaseSend = resolve; });
    engine.streamMode = 'collection';
    engine.stageFileOpen = true;
    engine.stageFileOpening = false;
    engine.stageFileOpenPromise = null;
    engine.isClosingStageFile = false;
    engine.storage_push_connected = true;
    engine.storage_push_socket = {
        send: async () => {
            events.push('push-start');
            await sendGate;
            events.push('push-done');
        }
    };
    engine.storagePushSendChain = Promise.resolve();
    engine.storageDataSequence = 0;
    engine.storageDataLastSentSequence = 0;
    engine.sendStorageCommand = async (cmd, params) => {
        events.push({ cmd, params });
        return { status: 'success' };
    };

    try {
        const appendPromise = engine.saveDataToStorage({ emg1: [[[1]]] });
        const closePromise = engine.closeStageFile();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(events, ['push-start']);

        releaseSend();
        await Promise.all([appendPromise, closePromise]);

        assert.deepEqual(events.map(event => typeof event === 'string' ? event : event.cmd), [
            'push-start', 'push-done', 'close'
        ]);
        assert.equal(events[2].params._storage_data_seq, 1);
    } finally {
        Object.assign(engine, original);
        engine.activeCloseStageFilePromise = null;
    }
});

test('collection stop closes a file that finishes opening during stop', async () => {
    const original = {
        stageFileOpen: engine.stageFileOpen,
        stageFileOpening: engine.stageFileOpening,
        stageFileOpenPromise: engine.stageFileOpenPromise,
        isClosingStageFile: engine.isClosingStageFile,
        isCollecting: engine.isCollecting,
        collectionPaused: engine.collectionPaused,
        isTestMode: engine.isTestMode,
        sendStorageCommand: engine.sendStorageCommand
    };

    let resolveOpen;
    const openPromise = new Promise(resolve => { resolveOpen = resolve; });
    let closeCount = 0;
    engine.stageFileOpen = false;
    engine.stageFileOpening = true;
    engine.stageFileOpenPromise = openPromise;
    engine.isClosingStageFile = false;
    engine.isCollecting = true;
    engine.collectionPaused = false;
    engine.isTestMode = false;
    engine.sendStorageCommand = async cmd => {
        if (cmd === 'close') closeCount += 1;
        return { status: 'success' };
    };

    try {
        const stopPromise = engine.onCollectionStop(false);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(closeCount, 0);

        engine.stageFileOpen = true;
        engine.stageFileOpening = false;
        resolveOpen();
        await stopPromise;
        assert.equal(closeCount, 1);
    } finally {
        Object.assign(engine, original);
        engine.activeCloseStageFilePromise = null;
    }
});

test('a PUSH failure makes close fail and keeps the file open', async () => {
    const original = {
        streamMode: engine.streamMode,
        stageFileOpen: engine.stageFileOpen,
        stageFileOpening: engine.stageFileOpening,
        stageFileOpenPromise: engine.stageFileOpenPromise,
        isClosingStageFile: engine.isClosingStageFile,
        storage_push_connected: engine.storage_push_connected,
        storage_push_socket: engine.storage_push_socket,
        storagePushSendChain: engine.storagePushSendChain,
        storageDataSequence: engine.storageDataSequence,
        storageDataLastSentSequence: engine.storageDataLastSentSequence,
        storageDataSendError: engine.storageDataSendError,
        sendStorageCommand: engine.sendStorageCommand
    };
    let closeCount = 0;
    engine.streamMode = 'collection';
    engine.stageFileOpen = true;
    engine.stageFileOpening = false;
    engine.stageFileOpenPromise = null;
    engine.isClosingStageFile = false;
    engine.storage_push_connected = true;
    engine.storage_push_socket = { send: async () => { throw new Error('socket down'); } };
    engine.storagePushSendChain = Promise.resolve();
    engine.storageDataSequence = 0;
    engine.storageDataLastSentSequence = 0;
    engine.storageDataSendError = null;
    engine.sendStorageCommand = async cmd => {
        if (cmd === 'close') closeCount += 1;
        return { status: 'success' };
    };

    try {
        await engine.saveDataToStorage({ emg1: [[[1]]] });
        const result = await engine.closeStageFile();
        assert.equal(result.status, 'error');
        assert.equal(closeCount, 0);
        assert.equal(engine.stageFileOpen, true);
    } finally {
        Object.assign(engine, original);
        engine.activeCloseStageFilePromise = null;
    }
});

test('collection stop reports H5 close and create failures', async () => {
    const original = {
        stageFileOpen: engine.stageFileOpen,
        stageFileCreateFailed: engine.stageFileCreateFailed,
        videoRecordingStarted: engine.videoRecordingStarted,
        isTestMode: engine.isTestMode,
        closeStageFile: engine.closeStageFile
    };
    engine.videoRecordingStarted = false;
    engine.isTestMode = false;
    try {
        engine.stageFileOpen = true;
        engine.stageFileCreateFailed = false;
        engine.closeStageFile = async () => ({ status: 'error', msg: 'disk full' });
        const closeResult = await engine.onCollectionStop(false);
        assert.equal(closeResult.status, 'error');

        engine.stageFileOpen = false;
        engine.stageFileCreateFailed = true;
        const createResult = await engine.onCollectionStop(false);
        assert.equal(createResult.status, 'error');

        engine.stageFileCreateFailed = false;
        engine.stageFileOpening = true;
        engine.stageFileOpenPromise = Promise.reject(new Error('create failed'));
        engine.stageFileOpenPromise.catch(() => {});
        const openingFailure = await engine.onCollectionStop(false);
        assert.equal(openingFailure.status, 'error');
    } finally {
        Object.assign(engine, original);
    }
});

test('REQ timeout rebuilds the socket and rejects queued commands together', async () => {
    const localEngine = loadEngineWithoutNativeSockets();
    const failingSocket = {
        sendTimeout: 5000,
        receiveTimeout: 10000,
        async send() {},
        async receive() { const error = new Error('EAGAIN'); error.code = 'EAGAIN'; throw error; },
        close() {}
    };
    localEngine.storage_server_socket = failingSocket;
    localEngine.storage_connected = true;

    const results = await Promise.allSettled([
        localEngine.sendStorageCommand('one'),
        localEngine.sendStorageCommand('two'),
        localEngine.sendStorageCommand('three')
    ]);

    assert.equal(results.every(result => result.status === 'rejected'), true);
    assert.notEqual(localEngine.storage_server_socket, failingSocket);
    assert.equal(localEngine.storage_server_socket.sendTimeout, 5000);
    assert.equal(localEngine.storage_server_socket.receiveTimeout, 10000);
    assert.equal(localEngine.storageRequestQueue.length, 0);
});

test('PUSH pending limit rejects data and makes close fail without sending', async () => {
    const localEngine = loadEngineWithoutNativeSockets();
    let sendCount = 0;
    localEngine.streamMode = 'collection';
    localEngine.stageFileOpen = true;
    localEngine.storage_push_connected = true;
    localEngine.storagePushPendingCount = 1000;
    localEngine.storage_push_socket = { send: async () => { sendCount += 1; } };
    localEngine.notifyH5StorageWarning = () => {};
    localEngine.sendStorageCommand = async () => {
        throw new Error('close must be blocked');
    };

    await localEngine.saveDataToStorage({ emg1: [[[1]]] });
    const closeResult = await localEngine.closeStageFile();
    assert.equal(sendCount, 0);
    assert.match(localEngine.storageDataSendError.message, /队列已满/);
    assert.equal(closeResult.status, 'error');
});

test('stop waits for opening close and leaves sockets open on close failure', async () => {
    const localEngine = loadEngineWithoutNativeSockets();
    let releaseOpen;
    const opening = new Promise(resolve => { releaseOpen = resolve; });
    const events = [];
    localEngine.stageFileOpen = true;
    localEngine.stageFileOpening = true;
    localEngine.stageFileOpenPromise = opening;
    localEngine.storage_push_connected = false;
    localEngine.storage_push_socket = { close: () => events.push('push-close') };
    localEngine.storage_server_socket = { close: () => events.push('req-close') };
    localEngine.sendStorageCommand = async cmd => {
        events.push(cmd);
        return { status: 'error', msg: 'disk full' };
    };

    const stopPromise = localEngine.stop();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, []);
    localEngine.stageFileOpening = false;
    releaseOpen();
    await assert.rejects(stopPromise, /disk full/);
    assert.deepEqual(events, ['close']);
});

test('opening failure makes collection stop return error', async () => {
    const localEngine = loadEngineWithoutNativeSockets();
    localEngine.stageFileOpening = true;
    localEngine.stageFileOpenPromise = Promise.reject(new Error('create failed'));
    localEngine.stageFileOpenPromise.catch(() => {});
    localEngine.stageFileCreateFailed = false;
    const result = await localEngine.onCollectionStop(false);
    assert.equal(result.status, 'error');
});

test('failed stage blocks a new collection without clearing sticky error', async () => {
    const localEngine = loadEngineWithoutNativeSockets();
    const stickyError = new Error('previous write failed');
    localEngine.stageFileCreateFailed = true;
    localEngine.storageDataSendError = stickyError;
    let createCount = 0;
    localEngine.sendStorageCommand = async cmd => {
        if (cmd === 'create') createCount += 1;
        return { status: 'success' };
    };

    await assert.rejects(
        localEngine.onCollectionStart({ taskId: 'test', stageName: 'stage', userId: 'u' }),
        /上一Stage仍未安全收尾/
    );
    assert.equal(createCount, 0);
    assert.equal(localEngine.storageDataSendError, stickyError);
});

test('rejected collection_start returns a structured control error', async () => {
    const localEngine = loadEngineWithoutNativeSockets();
    localEngine.stageFileCreateFailed = true;
    let response;
    const ws = {
        readyState: 1,
        send(message) { response = JSON.parse(message); }
    };

    await localEngine.handleFrontendMessage(JSON.stringify({
        type: 'control_command',
        action: 'collection_start',
        commandId: 'start-1',
        data: {}
    }), ws);

    assert.equal(response.status, 'error');
    assert.equal(response.commandId, 'start-1');
});


function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function command(engine, action, data = {}, ws = { readyState: 1, send() {} }) {
    return engine.handleFrontendMessage(JSON.stringify({ type: 'control_command', action, data, commandId: action }), ws);
}

test('global command order waits for camera and uses complete new session metadata', async () => {
    const e = loadEngineWithoutNativeSockets();
    const camera = gate(); const created = [];
    e.camera_connected = true;
    e.storage_connected = true;
    e.sd_filenames = { dev1: 'old', dev2: null };
    e.sendCameraCommand = async cmd => {
        if (cmd === 'get_server_time') { await camera.promise; return { server_time: 123 }; }
        if (cmd === 'get_status') return { cameras: {} };
        return { success: true };
    };
    e.sendStorageCommand = async (cmd, params) => {
        if (cmd === 'create') created.push(params);
        return { status: 'success' };
    };
    const start = command(e, 'collection_start', {
        taskId: 'discrete_gesture', userId: 'u', stageName: 's', recordingSessionId: 'new-recording',
        isResume: true, resumeSegmentIndex: 2, collectionBins: { dev1: 'new-bin' }
    });
    const stage = command(e, 'stage_start', { stageName: 's', stageIndex: 0 });
    await new Promise(r => setImmediate(r));
    assert.equal(created.length, 0);
    assert.equal(e.recordingSessionId, 'new-recording');
    assert.equal(e.resumeSegmentIndex, 2);
    camera.resolve(); await Promise.all([start, stage]);
    assert.equal(created.length, 1);
    assert.equal(created[0].sd_bin_dev1, 'new-bin');
    assert.equal(created[0].recording_session_id, 'new-recording');
    assert.equal(created[0].segment_index, 2);
    assert.equal(created[0].start_time, 123);
    assert.ok(created[0]._storage_file_token);
});

test('freeze bypasses pending start and abort closes a file still opening', async () => {
    const e = loadEngineWithoutNativeSockets(); const create = gate();
    e.storage_connected = true; e.sd_filenames.dev1 = 'bin';
    e.sendStorageCommand = async cmd => {
        if (cmd === 'create') await create.promise;
        return { status: 'success' };
    };
    await command(e, 'collection_start', { stageName: 's', collectionBins: { dev1: 'bin' } });
    const stage = command(e, 'stage_start', { stageName: 's' });
    await new Promise(r => setImmediate(r));
    assert.equal(e.stageFileOpening, true);
    await command(e, 'abnormal_interrupt_freeze');
    assert.equal(e.isCollecting, false);
    const abort = command(e, 'abnormal_interrupt', { reason: 'disconnect' });
    create.resolve(); await stage;
    assert.equal((await abort).status, 'success');
    assert.equal(e.stageFileOpen, false);
    assert.equal(e.collectionState, 'interrupted');
});

test('create response loss reconciles file identity without duplicate create', async () => {
    const e = loadEngineWithoutNativeSockets(); e.storage_connected = true; e.sd_filenames.dev1 = 'bin';
    let creates = 0;
    e.sendStorageCommand = async cmd => {
        if (cmd === 'create') { creates++; throw new Error('response lost'); }
        return { status: 'success', open: true, file_token: e.storageFileToken };
    };
    await e.openStageFile('s', 0);
    assert.equal(creates, 1); assert.equal(e.stageFileOpen, true);
});

test('unreachable create reconciliation never releases uncertain ownership', async () => {
    const e = loadEngineWithoutNativeSockets(); e.storage_connected = true; e.sd_filenames.dev1 = 'bin';
    e.sendStorageCommand = async () => { throw new Error('service down'); };
    await e.openStageFile('s', 0);
    assert.equal(e.stageFileCreateFailed, true);
    assert.equal((await e.finalizeIncomplete()).status, 'error');
    assert.equal(e.collectionState, 'save_failed');
    await assert.rejects(e.onCollectionStart({}), /上一Stage/);
});

test('failed PUSH can finalize incomplete and admit a clean next session', async () => {
    const e = loadEngineWithoutNativeSockets(); const commands = [];
    e.stageFileOpen = true; e.storageFileToken = 'old'; e.streamMode = 'collection';
    e.storage_push_connected = true;
    e.storage_push_socket.send = async () => { throw new Error('connection lost'); };
    e.sendStorageCommand = async (cmd, params) => { commands.push({ cmd, params }); return { status: 'success' }; };
    await e.saveDataToStorage({ emg1: [[1]] });
    assert.equal((await e.onCollectionStop(true)).status, 'error');
    assert.equal((await e.finalizeIncomplete()).status, 'success');
    assert.equal(commands[0].cmd, 'finalize_incomplete');
    assert.equal(commands[0].params._storage_file_token, 'old');
    assert.equal(commands[0].params._storage_data_seq, 0);
    await e.onCollectionStart({ isTestMode: true });
    assert.equal(e.storageDataSendError, null); assert.equal(e.isCollecting, true);
});

test('retrying stop preserves video association and stable operation ID', async () => {
    const e = loadEngineWithoutNativeSockets(); e.stageFileOpen = true;
    e.videoRecordingStarted = true; e.videoFileNames = { left: 'a.avi' };
    e.videoStopOperationId = 'stop-a'; const ids = []; let attempts = 0; let closes = 0;
    e.sendCameraCommand = async (cmd, data) => {
        ids.push(data.operation_id);
        if (++attempts === 1) throw new Error('temporary disconnect');
        return { success: true, output_path: 'a.avi' };
    };
    e.sendStorageCommand = async () => { closes++; return { status: 'success' }; };
    assert.equal((await e.onCollectionStop(true)).status, 'error');
    assert.equal(e.videoFileNames.left, 'a.avi'); assert.equal(closes, 0);
    assert.equal((await e.onCollectionStop(true)).status, 'success');
    assert.deepEqual(ids, ['stop-a_left', 'stop-a_left']); assert.equal(closes, 1);
});

test('slow preview clients are byte bounded and transport fault is fatal for collection', async () => {
    const e = loadEngineWithoutNativeSockets(); let sent = 0; let terminated = 0;
    const slow = { readyState: 1, bufferedAmount: 1024 * 1024, send() { sent++; }, terminate() { terminated++; } };
    e.clients.add(slow);
    for (let i = 0; i < 25; i++) e.broadcastToClients({ type: 'realtime_data', data: [] });
    assert.equal(sent, 0); assert.equal(terminated, 1); assert.equal(e.previewDroppedPackets, 20);
    e.isCollecting = true;
    e.onTransportFault({ source: 'ble', error: 'overflow', dropped: 1 });
    assert.equal(e.isCollecting, false); assert.equal(e.collectionState, 'save_failed');
    assert.match(e.storageDataSendError.message, /overflow/);
    assert.equal((await e.onCollectionStop(true)).status, 'error');
});

function loadCollectionPrototype() {
    const window = {};
    const source = fs.readFileSync(require.resolve('../public/scripts/collection-controller.js'), 'utf8')
        .replace('    function initController() {', '    window.TestController = CollectionController;\n    function initController() {');
    const context = { window, console, Date, Math, JSON, setTimeout, clearTimeout, clearInterval,
        WebSocket: { OPEN: 1 }, document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; } } };
    vm.runInNewContext(source, context);
    return { controller: Object.create(window.TestController.prototype), window };
}

class BrowserSocket extends require('events') {
    constructor() { super(); this.readyState = 1; this.messages = []; }
    addEventListener(name, fn) { this.on(name, fn); }
    removeEventListener(name, fn) { this.off(name, fn); }
    send(message) { this.messages.push(JSON.parse(message)); }
}

test('frontend control RPC rejects immediately on disconnect and removes listeners', async () => {
    const { controller } = loadCollectionPrototype(); const socket = new BrowserSocket();
    controller.getWebSocket = () => socket;
    const pending = controller.sendToRealtimeEngineAndWait('collection_stop_and_wait', {});
    socket.emit('close');
    await assert.rejects(pending, /连接已断开/);
    assert.equal(socket.listenerCount('message'), 0); assert.equal(socket.listenerCount('close'), 0);
    assert.equal(socket.listenerCount('error'), 0);
});

test('frontend stop failure stays failed and retry only restores preview after ACK', async () => {
    const { controller: c } = loadCollectionPrototype(); let preview = 0; let attempts = 0;
    Object.assign(c, { _isRunning: true, _isAllSessionsMode: false,
        cancelAllSessionsMode() {}, hideGestureGif() {}, _disableSpaceKey() {}, resetDisplay() {},
        updateNextStageButton() {}, updateGestureList() {}, updateStatus() {}, showToast() {},
        sendToRealtimeEngineAndWait: async () => { if (++attempts === 1) throw new Error('disk full'); },
        _resumePreviewAfterCollection() { preview++; }
    });
    await c.stopTask(); assert.equal(c._saveState, 'save_failed'); assert.equal(preview, 0);
    await c.stopTask(); assert.equal(c._saveState, 'idle'); assert.equal(attempts, 2);
});


test('abort shares an in-flight close and propagates its failure without releasing', async () => {
    const e = loadEngineWithoutNativeSockets(); const close = gate(); let calls = 0;
    e.stageFileOpen = true;
    e.sendStorageCommand = async () => { calls++; return close.promise; };
    const firstClose = e.closeStageFile();
    await new Promise(r => setImmediate(r));
    const abort = e.onAbnormalInterrupt({ reason: 'test' });
    close.resolve({ status: 'error', msg: 'disk full' });
    await firstClose;
    assert.equal((await abort).status, 'error');
    assert.equal(calls, 1); assert.equal(e.stageFileOpen, true);
    assert.equal(e.collectionState, 'save_failed'); assert.equal(e.abortFreezeActive, true);
});

test('control replies report unknown commands and queue survives failure', async () => {
    const e = loadEngineWithoutNativeSockets(); const replies = [];
    const ws = { readyState: 1, send(message) { replies.push(JSON.parse(message)); } };
    await command(e, 'unknown_action', {}, ws);
    await command(e, 'collection_pause', {}, ws);
    assert.deepEqual(replies.map(r => r.status), ['error', 'success']);
    assert.equal(replies[0].commandId, 'unknown_action');
});

test('camera disconnect rejects pending finalization without waiting for budget', async () => {
    const e = loadEngineWithoutNativeSockets(); const socket = new BrowserSocket();
    e.camera_client = socket;
    const pending = e.sendCameraCommand('stop_and_save', { side: 'left', operation_id: 's_left' });
    socket.emit('close');
    await assert.rejects(pending, /连接已断开/);
    assert.equal(socket.listenerCount('message'), 0);
    assert.equal(socket.listenerCount('error'), 0);
});

test('failed status response cannot release a failed create', async () => {
    const e = loadEngineWithoutNativeSockets(); e.storage_connected = true; e.sd_filenames.dev1 = 'b';
    e.sendStorageCommand = async () => ({ status: 'error', msg: 'unavailable' });
    await e.openStageFile('s', 0);
    assert.equal((await e.finalizeIncomplete()).status, 'error');
    assert.equal(e.stageFileCreateFailed, true);
    assert.equal(e.collectionState, 'save_failed');
});


test('incomplete finalization preserves terminal video failure but not unknown ownership', async () => {
    const e = loadEngineWithoutNativeSockets(); let closes = 0;
    e.stageFileOpen = true; e.videoRecordingStarted = true; e.videoFileNames = { left: 'a.avi' };
    e.sendStorageCommand = async (cmd, params) => { closes++; assert.match(params.error_reason, /remux/); return { status: 'success' }; };
    e.sendCameraCommand = async () => { throw new Error('disconnected'); };
    assert.equal((await e.finalizeIncomplete()).status, 'error');
    assert.equal(closes, 0); assert.equal(e.videoRecordingStarted, true);
    e.sendCameraCommand = async () => ({ success: false, error: 'remux failed' });
    assert.equal((await e.onCollectionStop(true)).status, 'error');
    assert.equal((await e.finalizeIncomplete()).status, 'success');
    assert.equal(closes, 1); assert.equal(e.videoRecordingStarted, false);
});


test('unknown video start retains recorder ownership for confirmed stop', async () => {
    const e = loadEngineWithoutNativeSockets();
    e.camera_connected = true; e.videoStopOperationId = 'session-a';
    e.collectionBins = { dev1: 'left-bin', dev2: 'right-bin' };
    e.sendCameraCommand = async command => {
        if (command === 'get_status') return { captures: { left: { running: true } } };
        throw new Error('start reply lost');
    };
    await assert.rejects(e._markVideoRecordingStart(100, 'stage'), /reply lost/);
    assert.equal(e.videoRecordingStarted, true);
    assert.equal(e.videoFileNames.left, 'left-bin.avi');
});

test('single camera is not assigned twice when two bins exist', async () => {
    const e = loadEngineWithoutNativeSockets(); e.camera_connected = true;
    e.videoStopOperationId = 'session-b'; e.collectionBins = {dev1:'a',dev2:'b'};
    const starts = [];
    e.sendCameraCommand = async (command, data) => {
        if (command === 'get_status') return {captures:{left:{running:true}}};
        starts.push(data); return {success:true};
    };
    await e._markVideoRecordingStart(100, 'stage');
    assert.equal(starts.length, 1); assert.equal(starts[0].side, 'left');
    assert.equal(starts[0].recording_id, 'session-b_left');
});

test('pending camera result blocks incomplete release and can be retried', async () => {
    const e = loadEngineWithoutNativeSockets();
    e.videoRecordingStarted = true; e.videoFileNames = {left:'a.avi'};
    e.sendCameraCommand = async () => ({success:false,pending:true,error:'still finalizing'});
    await assert.rejects(e._saveCollectionVideos(true), /still finalizing/);
    assert.equal(e.videoRecordingStarted, true);
    assert.equal(e.videoStopResults.left, undefined);
});
