'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ManagedProcess } = require('../lib/service-process');
const EventEmitter = require('node:events');

const port = 18771 + (process.pid % 1000);

test('managed process waits for a real port and stops only its child', async () => {
    const service = new ManagedProcess({
        name: 'test-helper',
        command: process.execPath,
        args: ['-e', `require('net').createServer().listen(${port}, '127.0.0.1'); setInterval(()=>{}, 1000)`],
        readyPorts: port,
        readyTimeoutMs: 3000
    });
    try {
        await service.start();
        assert.equal(service.getStatus().ready, true);
    } finally {
        await service.stop({ timeoutMs: 1000 });
    }
    assert.equal(service.getStatus().state, 'stopped');
});

test('managed process rejects an early exit', async () => {
    const service = new ManagedProcess({
        name: 'early-helper', command: process.execPath,
        args: ['-e', 'process.exit(9)'], readyPorts: port + 1, readyTimeoutMs: 1000
    });
    await assert.rejects(service.start(), error => error.code === 'PROCESS_EARLY_EXIT');
    await service.stop();
});

function mockChild(kill) {
    const child = new EventEmitter();
    child.pid = 1000001;
    child.kill = kill || (() => { queueMicrotask(() => child.emit('close', 0)); return true; });
    return child;
}

test('stop failure rejects and retains ownership instead of claiming success', async () => {
    const child = mockChild(() => { throw new Error('kill denied'); });
    const service = new ManagedProcess({ command: 'mock', spawnFn: () => child,
                                         logger: { warn() {} } });
    await service.start();
    await assert.rejects(service.stop({ timeoutMs: 10 }), /kill denied/);
    assert.equal(service.child, child);
    assert.equal(service.getStatus().state, 'failed');
    await assert.rejects(service.start(), /旧进程尚未退出/);
    child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
    await service.stop({ timeoutMs: 10 });
    assert.equal(service.child, null);
});

test('stop timeout rejects when neither termination attempt confirms exit', async () => {
    const signals = [];
    const child = mockChild(signal => { signals.push(signal); return true; });
    const service = new ManagedProcess({ command: 'mock', spawnFn: () => child });
    await service.start();
    await assert.rejects(service.stop({ timeoutMs: 10 }), error => error.code === 'STOP_TIMEOUT');
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(service.child, child);
    assert.equal(service.getStatus().state, 'failed');
    child.emit('close', 0);
});

test('failed readiness stops the spawned child', async () => {
    let killed = false;
    const child = mockChild(() => {
        killed = true;
        queueMicrotask(() => child.emit('close', 0));
        return true;
    });
    const service = new ManagedProcess({ command: 'mock', spawnFn: () => child,
                                         readyCheck: () => { throw new Error('not ready'); } });
    await assert.rejects(service.start(), /not ready/);
    await service.stop();
    assert.equal(killed, true);
    assert.equal(service.child, null);
});

test('a readiness hook that never resolves times out and releases its child', async () => {
    const child = mockChild();
    const service = new ManagedProcess({ command: 'mock', spawnFn: () => child,
        readyCheck: () => new Promise(() => {}), readyTimeoutMs: 10 });
    await assert.rejects(service.start(), error => error.code === 'READY_TIMEOUT');
    await service.stop();
    assert.equal(service.child, null);
});
