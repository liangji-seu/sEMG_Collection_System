'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const consolePatch = { originals: null, logger: null };

function formatArgs(args) {
    try {
        return util.format(...args);
    } catch (error) {
        return args.map(value => {
            try { return util.inspect(value, { depth: 5, breakLength: Infinity }); }
            catch { return `[Unformattable: ${error.message}]`; }
        }).join(' ');
    }
}

class Logger {
    constructor(options = {}) {
        this.logDir = options.logDir || path.join(__dirname, 'log');
        this.maxFileSize = options.maxFileSize ?? 20 * 1024 * 1024;
        this.maxFiles = options.maxFiles ?? 10;
        this.maxLineBytes = options.maxLineBytes ?? 64 * 1024;
        this.filePrefix = options.filePrefix || 'server';
        this.currentLogFile = null;
        this.currentStream = null;
        this.currentFileSize = 0;
        this.sequence = 0;
        this.closed = false;
        this.droppedLogCount = 0;
        this.backpressured = false;
        this._closePromise = null;
        this.endingStreams = new Set();
        this.originalLog = consolePatch.originals?.log || console.log;
        this.originalError = consolePatch.originals?.error || console.error;
        this.originalWarn = consolePatch.originals?.warn || console.warn;
        this.init();
    }

    init() {
        fs.mkdirSync(this.logDir, { recursive: true });
        this.cleanOldLogs();
        this.openLogFile();
        this.overrideConsole();
        this.originalLog(`[Logger] 日志系统已启动，日志目录: ${this.logDir}`);
    }

    generateFileName() {
        const now = new Date();
        const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '_').replace('Z', '');
        this.sequence = (this.sequence + 1) % 1000000;
        return `${this.filePrefix}_${stamp}_${process.pid}_${String(this.sequence).padStart(6, '0')}.log`;
    }

    _attachStream(stream) {
        this.endingStreams.add(stream);
        stream.once('close', () => this.endingStreams.delete(stream));
        stream.on('error', error => {
            // A disk error must never become an uncaught exception in the collector.
            if (this.currentStream === stream) {
                this.currentStream = null;
                this.backpressured = false;
            }
            this.originalError(`[Logger] 日志流错误: ${error.message}`);
        });
        stream.on('drain', () => {
            this.backpressured = false;
            if (this.droppedLogCount > 0 && this.currentStream === stream) {
                const dropped = this.droppedLogCount;
                this.droppedLogCount = 0;
                const warning = `[${new Date().toISOString()}] [WARN] 日志背压期间丢弃 ${dropped} 条日志\n`;
                try {
                    if (stream.write(warning)) this.currentFileSize += Buffer.byteLength(warning);
                    else this.backpressured = true;
                } catch (error) {
                    this.originalWarn(`[Logger] 日志背压期间丢弃 ${dropped} 条日志`);
                }
            }
        });
    }

    openLogFile() {
        const previous = this.currentStream;
        if (previous) {
            previous.end();
        }
        this.currentLogFile = path.join(this.logDir, this.generateFileName());
        this.currentStream = fs.createWriteStream(this.currentLogFile, { flags: 'wx' });
        this.currentFileSize = 0;
        this.backpressured = false;
        this._attachStream(this.currentStream);
    }

    cleanOldLogs() {
        try {
            const files = fs.readdirSync(this.logDir)
                .filter(name => name.startsWith(`${this.filePrefix}_`) && name.endsWith('.log'))
                .map(name => {
                    const filePath = path.join(this.logDir, name);
                    const stat = fs.statSync(filePath);
                    return { name, filePath, mtimeMs: stat.mtimeMs };
                })
                .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
            for (const file of files.slice(this.maxFiles)) {
                try { fs.unlinkSync(file.filePath); }
                catch (error) { this.originalError(`[Logger] 清理旧日志失败: ${error.message}`); }
            }
        } catch (error) {
            this.originalError(`[Logger] 清理旧日志失败: ${error.message}`);
        }
    }

    rotate() {
        if (this.closed) return;
        this.originalLog('[Logger] 日志文件达到大小限制，正在轮换...');
        this.openLogFile();
        this.cleanOldLogs();
    }

    write(...args) {
        if (this.closed) return false;
        let message = formatArgs(args);
        if (Buffer.byteLength(message, 'utf8') > this.maxLineBytes) {
            message = Buffer.from(message, 'utf8').subarray(0, this.maxLineBytes)
                .toString('utf8') + ' [log entry truncated]';
        }
        const logLine = `[${new Date().toISOString()}] ${message}\n`;
        const lineSize = Buffer.byteLength(logLine, 'utf8');
        if (this.currentFileSize + lineSize > this.maxFileSize) this.rotate();
        const stream = this.currentStream;
        if (!stream || this.backpressured) {
            this.droppedLogCount += 1;
            return false;
        }
        try {
            const accepted = stream.write(logLine);
            this.currentFileSize += lineSize;
            if (!accepted) this.backpressured = true;
            return accepted;
        } catch (error) {
            this.originalError(`[Logger] 写入日志失败: ${error.message}`);
            return false;
        }
    }

    overrideConsole() {
        if (!consolePatch.originals) {
            consolePatch.originals = {
                log: console.log.bind(console),
                error: console.error.bind(console),
                warn: console.warn.bind(console)
            };
        }
        consolePatch.logger = this;
        this.originalLog = consolePatch.originals.log;
        this.originalError = consolePatch.originals.error;
        this.originalWarn = consolePatch.originals.warn;
        const logger = this;
        console.log = (...args) => { logger.write(...args); logger.originalLog(...args); };
        console.error = (...args) => { logger.write('[ERROR]', ...args); logger.originalError(...args); };
        console.warn = (...args) => { logger.write('[WARN]', ...args); logger.originalWarn(...args); };
    }

    close() {
        if (this._closePromise) return this._closePromise;
        this.closed = true;
        if (consolePatch.logger === this && consolePatch.originals) {
            console.log = consolePatch.originals.log;
            console.error = consolePatch.originals.error;
            console.warn = consolePatch.originals.warn;
            consolePatch.logger = null;
        }
        const stream = this.currentStream;
        this.currentStream = null;
        if (stream && this.droppedLogCount > 0 && !stream.destroyed) {
            const dropped = this.droppedLogCount;
            this.droppedLogCount = 0;
            try { stream.write(`[${new Date().toISOString()}] [WARN] 关闭前累计丢弃 ${dropped} 条日志\n`); }
            catch (error) { this.originalWarn(`[Logger] 关闭前累计丢弃 ${dropped} 条日志`); }
        }
        this._closePromise = new Promise(resolve => {
            const streams = [...this.endingStreams];
            if (!streams.length) return resolve();
            let remaining = streams.length;
            for (const item of streams) {
                let settled = false;
                const done = () => {
                    if (settled) return;
                    settled = true;
                    remaining -= 1;
                    item.removeListener?.('finish', done);
                    item.removeListener?.('close', done);
                    if (remaining <= 0) resolve();
                };
                item.once('close', done);
                if (item.closed) done();
                else if (item === stream) item.end();
            }
        });
        return this._closePromise;
    }
}

let loggerInstance = null;
function initLogger(options) {
    if (!loggerInstance || loggerInstance.closed) loggerInstance = new Logger(options);
    return loggerInstance;
}
function getLogger() { return loggerInstance; }
function resetLogger() {
    const current = loggerInstance;
    loggerInstance = null;
    return current?.close();
}

module.exports = { Logger, initLogger, getLogger, resetLogger, formatArgs };
