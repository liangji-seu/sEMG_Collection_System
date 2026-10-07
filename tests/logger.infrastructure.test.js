'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Logger } = require('../logger');
const { Writable } = require('node:stream');

test('logger formats circular objects and rotates uniquely', async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'logger-test-'));
    const logger = new Logger({ logDir: dir, maxFileSize: 40, filePrefix: 'test' });
    const circular = {}; circular.self = circular;
    logger.write('circular', circular, new Error('expected'));
    logger.write('second line');
    await logger.close();
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.log'));
    assert.ok(files.length >= 2);
    assert.equal(new Set(files).size, files.length);
    const content = files.map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('');
    assert.match(content, /Circular/);
    assert.match(content, /Error: expected/);
    assert.match(content, /second line/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('stream write errors are reported without crashing the collector', async t => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'logger-test-'));
    const stream = new Writable({ write(_chunk, _encoding, done) { done(new Error('disk full')); } });
    t.mock.method(fs, 'createWriteStream', () => stream);
    const logger = new Logger({ logDir: dir });
    const errors = [];
    logger.originalError = (...args) => errors.push(args.join(' '));
    logger.write('data');
    await new Promise(resolve => setImmediate(resolve));
    await logger.close();
    assert.equal(logger.currentStream, null);
    assert.ok(errors.some(line => line.includes('disk full')));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('backpressure drops bounded entries and records the dropped count', async t => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'logger-test-'));
    const written = [];
    const callbacks = [];
    const stream = new Writable({ highWaterMark: 1,
        write(chunk, _encoding, done) { written.push(chunk.toString()); callbacks.push(done); } });
    t.mock.method(fs, 'createWriteStream', () => stream);
    const logger = new Logger({ logDir: dir });
    logger.write('first entry');
    logger.write('discarded entry');
    assert.equal(logger.droppedLogCount, 1);
    assert.equal(written.length, 1);
    callbacks.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(written.join(''), /丢弃 1 条日志/);
    callbacks.shift()();
    await logger.close();
    assert.doesNotMatch(written.join(''), /discarded entry/);
    fs.rmSync(dir, { recursive: true, force: true });
});
