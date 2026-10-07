/*
 dataStorage.js
 负责启动storage_server, 以及监控storage_server的传输信息（数据不接受，只接收一些统计信息，为前端提供api接口）

 修改记录：
 - 引入 paths.js 获取正确的存储路径
 - 启动 Python 时传入 --storage_dir 参数
 - 支持打包后使用 exe 或开发时使用 Python
*/

const EventEmitter = require('events');
const { PATHS } = require('./paths'); // [新增] 引入路径管理模块
const { getPythonCommand } = require('./pythonPath'); // [新增] Python路径解析
const { ManagedProcess } = require('./lib/service-process');

class DataStorage extends EventEmitter {
    constructor() {
        super();
        this.pythonProcess = null; // ManagedProcess
        this.initializePromise = null;
    }

    // 初始化Python进程连接
    async initialize() {
        if (this.pythonProcess?.state === 'ready') return this.getStatus();
        if (this.initializePromise) return this.initializePromise;
        if (this.pythonProcess?.child) throw new Error('Storage旧进程尚未退出，请先重试关闭');
        this.initializePromise = (async () => {
            try {
                console.log('[dataStorage] 正在启动storage_server......');

                // [关键修改] 获取外部可写的 storage 目录 (exe同级目录)
                const storageDir = PATHS.storage;
                console.log(`[dataStorage] 数据存储目标路径: ${storageDir}`);

                // 自动判断使用 Python 脚本还是打包后的 exe
                const { command, args } = getPythonCommand('storage_server', [
                    '--storage_dir',
                    storageDir
                ]);

                console.log(`[dataStorage] 启动命令: ${command} ${args.join(' ')}`);
                this.pythonProcess = new ManagedProcess({
                    name: 'storage_server', command, args,
                    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
                    readyPorts: 5555
                });
                this.pythonProcess.on('error', error => this.emit('error', error));
                this.pythonProcess.on('close', ({ code }) => {
                    console.log(`[dataStorage] storage_server已关闭，退出码: ${code}`);
                    this.emit('disconnected');
                });
                await this.pythonProcess.start();
                console.log('[dataStorage] storage_server已就绪 (端口: 5555)');
                return this.getStatus();
            } catch (error) {
                console.error('[dataStorage] 启动storage_server失败:', error);
                try {
                    await this.pythonProcess?.stop();
                    this.pythonProcess = null;
                } catch (stopError) {
                    console.error('[dataStorage] 启动失败后的进程清理失败，保留句柄:', stopError);
                }
                throw error;
            }
        })().finally(() => { this.initializePromise = null; });
        return this.initializePromise;
    }

    
    // 关闭连接
    async close() {
        const service = this.pythonProcess;
        if (!service) return;
        await service.stop();
        if (this.pythonProcess === service) this.pythonProcess = null;
        console.log('[dataStorage] storage_server关闭');
        this.emit('disconnected');
    }

    // 获取状态
    getStatus() {
        return {
            isRunning: this.pythonProcess?.state === 'ready',
            process: this.pythonProcess?.getStatus() || { state: 'stopped', ready: false }
        };
    }

}

// 创建单例实例
const dataStorage = new DataStorage();

dataStorage.on('error', (error) => {
    console.error('[dataStorage] dataStorage错误:', error.message);
});

dataStorage.on('disconnected', () => {
    console.log('[dataStorage] dataStorage已断开');
});

console.log('[dataStorage] dataStorage模块加载完成');

module.exports = dataStorage;
