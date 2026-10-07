'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(script, name) {
    class Socket {
        static OPEN = 1; static CONNECTING = 0;
        constructor() { this.readyState = 1; this.sent = []; Socket.last = this; }
        send(value) { this.sent.push(JSON.parse(value)); }
        close() { this.readyState = 3; }
    }
    const context = { window: { addEventListener() {} },
        document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
        WebSocket: Socket, Blob, ArrayBuffer, TextDecoder, console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, setInterval, clearInterval, Date };
    vm.runInNewContext(fs.readFileSync(require.resolve(`../public/scripts/${script}`), 'utf8'), context);
    const control = context.window[name]; control.connect();
    return { control, socket: Socket.last };
}

test('BLE serial RPC matches request identity and ignores a timed-out response', async () => {
    const { control, socket } = load('ble_control.js', 'BleControl');
    const first = control.sendAndWait('set_session_id', {}, 10);
    const firstFailure = assert.rejects(first, /超时/);
    const second = control.sendAndWait('set_session_id', {}, 1000);
    assert.equal(socket.sent.length, 1);
    await firstFailure;
    assert.equal(socket.sent.length, 2);
    const respond = request => socket.onmessage({ data: JSON.stringify({ type: 'response',
        action: request.action, request_id: request.request_id, success: true }) });
    respond(socket.sent[0]);
    assert.equal(control.getPendingAction(), 'set_session_id');
    respond(socket.sent[1]);
    assert.equal((await second).request_id, socket.sent[1].request_id);
    control.disconnect();
});

test('BLE disconnect rejects active and queued commands immediately', async () => {
    const { control } = load('ble_control.js', 'BleControl');
    const first = control.sendAndWait('a'); const second = control.sendAndWait('b');
    const checks = [assert.rejects(first, /关闭/), assert.rejects(second, /关闭/)];
    control.disconnect(); await Promise.all(checks);
    assert.equal(control.getPendingAction(), null);
});

test('intentional camera disconnect rejects pending RPC and clears timeout ownership', async () => {
    const { control } = load('camera_control.js', 'CameraControl');
    // getStatus converts errors to null; the internal map still must clear immediately.
    const pending = control.getStatus();
    control.disconnect();
    const result = await pending;
    assert.equal(result.success, false);
    assert.match(result.error, /关闭/);
});
