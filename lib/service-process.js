'use strict';

const { spawn } = require('child_process');
const net = require('net');
const EventEmitter = require('events');

function waitForPort(port, options = {}) {
    const host = options.host || '127.0.0.1';
    const timeoutMs = options.timeoutMs ?? 15000;
    const intervalMs = options.intervalMs ?? 100;
    const signal = options.signal;
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
        let timer = null;
        let activeSocket = null;
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            activeSocket?.destroy();
            signal?.removeEventListener?.('abort', abort);
            if (error) reject(error); else resolve();
        };
        const abort = () => finish(Object.assign(new Error('端口就绪检查已取消'), { code: 'ABORT_ERR' }));
        signal?.addEventListener?.('abort', abort, { once: true });
        const probe = () => {
            if (settled) return;
            if (signal?.aborted) {
                abort();
                return;
            }
            const socket = net.createConnection({ host, port });
            activeSocket = socket;
            let completed = false;
            const close = () => {
                if (!completed) {
                    completed = true;
                    socket.destroy();
                }
            };
            socket.once('connect', () => {
                close();
                finish();
            });
            socket.once('error', () => {
                close();
                if (settled) return;
                if (Date.now() - startedAt >= timeoutMs) {
                    finish(Object.assign(new Error(`等待 ${host}:${port} 就绪超时`), { code: 'READY_TIMEOUT', port }));
                } else {
                    timer = setTimeout(probe, intervalMs);
                }
            });
            socket.setTimeout(Math.min(intervalMs, 250), () => {
                close();
                if (settled) return;
                if (Date.now() - startedAt >= timeoutMs) {
                    finish(Object.assign(new Error(`等待 ${host}:${port} 就绪超时`), { code: 'READY_TIMEOUT', port }));
                } else {
                    timer = setTimeout(probe, intervalMs);
                }
            });
        };
        probe();
    });
}

function waitForPorts(ports, options = {}) {
    const list = Array.isArray(ports) ? ports : [ports];
    return Promise.all(list.filter(Boolean).map(port => waitForPort(port, options)));
}

function isPortInUse(port, host = '127.0.0.1') {
    return new Promise(resolve => {
        const socket = net.createConnection({ host, port });
        let settled = false;
        const finish = used => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(used);
        };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.setTimeout(250, () => finish(false));
    });
}

class ManagedProcess extends EventEmitter {
    constructor(options = {}) {
        super();
        if (!options.command) throw new TypeError('ManagedProcess requires command');
        this.name = options.name || options.command;
        this.command = options.command;
        this.args = options.args || [];
        this.env = options.env;
        this.cwd = options.cwd;
        this.spawnFn = options.spawnFn || spawn;
        this.readyPorts = options.readyPorts ?? options.port;
        this.readyHost = options.readyHost || '127.0.0.1';
        this.readyTimeoutMs = options.readyTimeoutMs ?? 15000;
        this.readyCheck = options.readyCheck;
        this.logger = options.logger || console;
        this.child = null;
        this.pid = null;
        this.state = 'stopped';
        this.startPromise = null;
        this.stopPromise = null;
        this._readyTimer = null;
        this.readyAbort = null;
        this._settledStart = false;
        this._owned = false;
        this._cancelStart = false;
    }

    _log(level, message) {
        const fn = this.logger?.[level] || this.logger?.log;
        if (typeof fn === 'function') fn.call(this.logger, `[${this.name}] ${message}`);
    }

    _pipe(stream, level) {
        if (!stream || typeof stream.on !== 'function') return;
        let pending = '';
        stream.on('data', chunk => {
            pending += chunk.toString();
            if (pending.length > 64 * 1024) {
                this._log(level, pending.slice(0, 64 * 1024) + ' [output truncated]');
                pending = pending.slice(-1024);
            }
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() || '';
            for (const line of lines) if (line) this._log(level, line);
        });
        stream.on('end', () => {
            if (pending) this._log(level, pending);
            pending = '';
        });
        stream.resume?.();
    }

    _rejectStart(error) {
        if (this._settledStart) return;
        this._settledStart = true;
        this.state = 'failed';
        this.startPromise?.reject(error);
    }

    start() {
        if (this.state === 'ready' || this.state === 'starting') return this.startPromise.promise;
        if (this.state === 'stopping') return this.stopPromise.then(() => this.start());
        if (this.child && this._owned) {
            return Promise.reject(new Error(`${this.name} 旧进程尚未退出，不能重复启动`));
        }
        this.state = 'starting';
        this._cancelStart = false;
        this._settledStart = false;
        let resolveStart;
        let rejectStart;
        const promise = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
        this.startPromise = { promise, resolve: resolveStart, reject: rejectStart };
        let child;
        (async () => {
          try {
            const ports = Array.isArray(this.readyPorts) ? this.readyPorts : [this.readyPorts];
            for (const port of ports.filter(Boolean)) {
                if (await isPortInUse(port, this.readyHost)) {
                    const error = Object.assign(new Error(`${this.name} 端口 ${this.readyHost}:${port} 已被其他进程占用`), { code: 'PORT_IN_USE', port });
                    this._rejectStart(error);
                    return;
                }
            }
            if (this._cancelStart || this.state !== 'starting') {
                this._rejectStart(Object.assign(new Error(`${this.name} 启动已取消`), { code: 'ABORT_ERR' }));
                return;
            }
            child = this.spawnFn(this.command, this.args, {
                env: this.env,
                cwd: this.cwd,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            this.child = child;
            this.pid = child.pid ?? null;
            this._owned = true;
            this._pipe(child.stdout, 'log');
            this._pipe(child.stderr, 'warn');
            child.once('error', error => {
                if (this.listenerCount('error')) this.emit('error', error);
                if (!this._settledStart) this._rejectStart(error);
            });
            child.once('exit', (code, signal) => {
                this.readyAbort?.abort();
                this.emit('exit', { code, signal });
                if (!this._settledStart) {
                    const error = new Error(`${this.name} 在就绪前退出 (code=${code}, signal=${signal || 'none'})`);
                    error.code = 'PROCESS_EARLY_EXIT';
                    error.exitCode = code;
                    this._rejectStart(error);
                }
            });
            child.once('close', (code, signal) => {
                if (this._readyTimer) clearTimeout(this._readyTimer);
                this.readyAbort?.abort();
                this.emit('close', { code, signal });
                this.child = null;
                this.pid = null;
                this._owned = false;
                if (this.state !== 'failed') this.state = 'stopped';
            });
            this._waitReady();
          } catch (error) {
            this._rejectStart(error);
          }
        })();
        return promise;
    }

    _waitReady() {
        this.readyAbort = new AbortController();
        let ready;
        try {
            ready = this.readyCheck
                ? Promise.resolve().then(() => this.readyCheck(this))
                : this.readyPorts ? waitForPorts(this.readyPorts, { host: this.readyHost, timeoutMs: this.readyTimeoutMs, signal: this.readyAbort.signal })
                    : Promise.resolve();
        } catch (error) {
            ready = Promise.reject(error);
        }
        this._readyTimer = setTimeout(() => {
            if (this._settledStart) return;
            this._rejectStart(Object.assign(new Error(`${this.name} 就绪检查超时`), { code: 'READY_TIMEOUT' }));
            this.readyAbort.abort();
            this.stop().catch(error => this._log('warn', error.message));
        }, this.readyTimeoutMs);
        Promise.resolve(ready).then(() => {
            if (this._settledStart || !this.child || (this.child.exitCode != null) || this.child.killed) return;
            this._settledStart = true;
            if (this._readyTimer) clearTimeout(this._readyTimer);
            this.state = 'ready';
            this.emit('ready');
            this.startPromise.resolve(this);
        }, error => {
            if (this._settledStart) return;
            if (this._readyTimer) clearTimeout(this._readyTimer);
            this._rejectStart(error);
            this.stop().catch(() => {});
        });
    }

    async stop(options = {}) {
        if (this.stopPromise) return this.stopPromise;
        const child = this.child;
        if (!child || !this._owned) {
            if (this.state === 'starting') {
                this._cancelStart = true;
                this._rejectStart(Object.assign(new Error(`${this.name} 启动已取消`), { code: 'ABORT_ERR' }));
            }
            this.state = 'stopped';
            return;
        }
        this.state = 'stopping';
        this.readyAbort?.abort();
        const timeoutMs = options.timeoutMs ?? 5000;
        this.stopPromise = new Promise((resolve, reject) => {
            let done = false;
            let timer = null;
            const finish = () => {
                if (done) return;
                done = true;
                if (timer) clearTimeout(timer);
                this.state = 'stopped';
                this.stopPromise = null;
                resolve();
            };
            child.once('close', finish);
            timer = setTimeout(() => {
                if (this._owned && this.child === child) {
                    try { child.kill('SIGKILL'); } catch (error) { this._log('warn', `强制结束失败: ${error.message}`); }
                }
                timer = null;
                const finalTimer = setTimeout(() => {
                    if (done) return;
                    done = true;
                    this.state = 'failed';
                    this.stopPromise = null;
                    const error = new Error(`${this.name} 在强制结束后仍未退出`);
                    error.code = 'STOP_TIMEOUT';
                    reject(error);
                }, timeoutMs);
                child.once('close', () => clearTimeout(finalTimer));
            }, timeoutMs);
            try { child.kill(options.signal || 'SIGTERM'); } catch (error) {
                this._log('warn', `结束失败: ${error.message}`);
                done = true;
                clearTimeout(timer);
                this.state = 'failed';
                this.stopPromise = null;
                reject(error);
            }
        });
        const pending = this.stopPromise;
        return pending.finally(() => {
            if (this.stopPromise === pending) this.stopPromise = null;
        });
    }

    getStatus() {
        return { name: this.name, state: this.state, ready: this.state === 'ready', pid: this.pid };
    }
}

module.exports = { ManagedProcess, waitForPort, waitForPorts };
