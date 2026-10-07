'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const EventEmitter = require('node:events');

test('Electron keeps the window and prevents repeated quit until save is confirmed', async () => {
    const app = new EventEmitter();
    const windows = [];
    const turns = [];
    let acceptedQuits = 0;
    app.quit = () => {
        const event = { prevented: false, preventDefault() { this.prevented = true; } };
        const results = app.listeners('before-quit').map(listener => listener(event));
        turns.push(Promise.all(results));
        if (!event.prevented) acceptedQuits++;
    };
    class Window extends EventEmitter {
        constructor() { super(); windows.push(this); this.webContents = { focus() {} }; }
        loadURL() {} show() {} focus() {}
    }
    let rejectSave;
    let shutdown = () => new Promise((_resolve, reject) => { rejectSave = reject; });
    const server = { startServer: async () => ({ address: () => ({ port: 3000 }) }),
                     shutdown: () => shutdown() };
    const context = {
        __dirname: path.dirname(require.resolve('../main.js')),
        console: { log() {}, error() {} }, setTimeout, clearTimeout,
        process: Object.assign(new EventEmitter(), { env: {}, platform: 'win32' }),
        require(name) {
            if (name === 'electron') return { app, BrowserWindow: Window };
            if (name === 'path') return path;
            if (name.endsWith('server.js')) return server;
            throw new Error(`Unexpected module: ${name}`);
        }
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../main.js'), 'utf8'), context);
    await app.listeners('ready')[0]();
    const windowClose = { prevented: false, preventDefault() { this.prevented = true; } };
    windows[0].emit('close', windowClose);
    const firstQuit = turns[0];
    assert.equal(windowClose.prevented, true);
    app.quit();
    assert.equal(acceptedQuits, 0);
    rejectSave(new Error('disk failure'));
    await firstQuit;
    assert.equal(acceptedQuits, 0);
    shutdown = async () => {};
    app.quit();
    await turns[2];
    assert.equal(acceptedQuits, 1);
});
