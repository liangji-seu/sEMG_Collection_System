'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const PYTHON = require('../pythonPath').getPythonInterpreter();
const SERVICE_PORTS = [8080, 8764, 8766, 8767, 8768, 5555, 5556];
let ZMQ_LOAD_ERROR = null;
try {
    require('zeromq');
} catch (error) {
    ZMQ_LOAD_ERROR = error;
}

function listenOnce(port = 0) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen({ host: '::', port, exclusive: true }, () => resolve(server));
    });
}

async function isPortFree(port) {
    const probe = host => new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
    });
    const results = [await probe('127.0.0.1'), await probe('::')];
    return results.every(Boolean);
}

async function waitForPortsFree(ports, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const states = await Promise.all(ports.map(isPortFree));
        if (states.every(Boolean)) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

async function findFreePort() {
    const server = await listenOnce(0);
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

function helperScript() {
    return `
const { startServer, shutdown } = require('./server');
let stopping = false;
startServer().then(() => {
  console.log('TEST_STARTED');
}).catch(async error => {
  console.error('TEST_START_ERROR:' + (error && error.message || error));
  try { await shutdown(); } catch (shutdownError) {
    console.error('TEST_START_SHUTDOWN_ERROR:' + shutdownError.message);
  }
  process.exitCode = 17;
  process.stdin.destroy();
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', async data => {
  if (!data.includes('shutdown') || stopping) return;
  stopping = true;
  try {
    await Promise.all([shutdown(), shutdown()]);
    console.log('TEST_SHUTDOWN');
    process.exitCode = 0;
  } catch (error) {
    console.error('TEST_SHUTDOWN_ERROR:' + error.message);
    process.exitCode = 18;
  }
  process.stdin.destroy();
});
`;
}

function spawnServer(port) {
    const child = spawn(process.execPath, ['-e', helperScript()], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            SEMG_PYTHON: PYTHON,
            SEMG_NO_AUTO_START: '1',
            SEMG_NO_BROWSER: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.output = () => output;
    return child;
}

function waitForOutput(child, marker, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            const output = child.output();
            if (output.includes(marker)) {
                clearInterval(timer);
                resolve(output);
            } else if (Date.now() - started >= timeoutMs) {
                clearInterval(timer);
                reject(new Error(`等待 ${marker} 超时\n${output.slice(-6000)}`));
            }
        }, 100);
        child.once('exit', (code, signal) => {
            if (child.output().includes(marker)) return;
            clearInterval(timer);
            reject(new Error(`子进程提前退出 code=${code} signal=${signal}\n${child.output().slice(-6000)}`));
        });
    });
}

function waitForExit(child, timeoutMs = 10000) {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('子进程退出超时')), timeoutMs);
        child.once('exit', code => {
            clearTimeout(timer);
            resolve(code);
        });
    });
}

async function readHealth(port) {
    return new Promise((resolve, reject) => {
        const request = http.get({ host: '127.0.0.1', port, path: '/api/health' }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve({ statusCode: response.statusCode, body: JSON.parse(body) }); }
                catch (error) { reject(error); }
            });
        });
        request.setTimeout(1000, () => request.destroy(new Error('health timeout')));
        request.on('error', reject);
    });
}

async function waitForReadyHealth(port, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const health = await readHealth(port);
            if (health.statusCode === 200 && health.body.status === 'ready') return health;
            lastError = new Error(`health=${JSON.stringify(health.body)}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw lastError || new Error('health ready timeout');
}

async function stopOwnedChild(child) {
    if (!child || child.exitCode !== null) return;
    child.stdin.write('shutdown\n');
    try { await waitForExit(child, 15000); }
    catch (_) { child.kill(); }
}

async function skipIfServicePortsBusy(t) {
    if (ZMQ_LOAD_ERROR) {
        t.skip(`zeromq native addon unavailable: ${ZMQ_LOAD_ERROR.message}`);
        return true;
    }
    const states = await Promise.all(SERVICE_PORTS.map(isPortFree));
    if (!states.every(Boolean)) {
        t.skip(`已有服务占用端口: ${SERVICE_PORTS.filter((_, i) => !states[i]).join(', ')}`);
        return true;
    }
    return false;
}

test('server starts real services, reports ready health, and idempotently releases owned ports', async t => {
    if (await skipIfServicePortsBusy(t)) return;
    const port = await findFreePort();
    const child = spawnServer(port);
    try {
        await waitForOutput(child, 'TEST_STARTED');
        const health = await waitForReadyHealth(port);
        assert.equal(health.body.status, 'ready');
        assert.equal(health.body.services.realtimeEngine.ready, true);
        assert.equal(health.body.services.ble.ready, true);
        assert.equal(health.body.services.storage.ready, true);

        child.stdin.write('shutdown\n');
        await waitForOutput(child, 'TEST_SHUTDOWN');
        assert.equal(await waitForExit(child), 0);
        assert.equal(await waitForPortsFree([port, ...SERVICE_PORTS]), true);
    } finally {
        await stopOwnedChild(child);
    }
});

test('HTTP port collision rolls back all services without touching the owner', async t => {
    if (await skipIfServicePortsBusy(t)) return;
    const occupied = await listenOnce(0);
    const port = occupied.address().port;
    const child = spawnServer(port);
    try {
        await waitForOutput(child, 'TEST_START_ERROR');
        assert.equal(await waitForExit(child), 17);
        assert.equal(await isPortFree(port), false);
        assert.equal(await waitForPortsFree(SERVICE_PORTS), true);
    } finally {
        await stopOwnedChild(child);
        await new Promise(resolve => occupied.close(resolve));
    }
});
