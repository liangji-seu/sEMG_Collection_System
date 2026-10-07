/**
 * Python 可执行文件路径解析器
 *
 * 策略：
 * - 优先使用 Python 运行 .py 脚本（需要预先安装 Python 环境）
 * - 如果 .py 不存在，才尝试使用 exe
 *
 * 部署说明：
 * - 新机器需要先运行 install_python_env.bat 安装 Python 和依赖
 * - 然后才能运行数据采集系统
 */

const path = require('path');
const fs = require('fs');

// Python exe 输出目录（备用）
const PYTHON_DIST_DIR = path.join(__dirname, 'python_dist');

/**
 * 获取 Python 脚本的执行命令和参数
 * @param {string} scriptName - 脚本名称（不含扩展名），如 'ble_server'
 * @param {string[]} extraArgs - 额外的命令行参数
 * @returns {{command: string, args: string[]}}
 */
function getPythonCommand(scriptName, extraArgs = []) {
    const pyPath = path.join(__dirname, `${scriptName}.py`);
    const exePath = path.join(PYTHON_DIST_DIR, `${scriptName}.exe`);
    const onedirExePath = path.join(PYTHON_DIST_DIR, scriptName, `${scriptName}.exe`);

    // 优先使用 Python 脚本
    if (fs.existsSync(pyPath)) {
        const interpreter = getPythonInterpreter();
        console.log(`[pythonPath] 使用 Python 脚本: ${pyPath} (${interpreter})`);
        return {
            command: interpreter,
            args: [pyPath, ...extraArgs]
        };
    }

    // 备用：使用 exe
    if (fs.existsSync(exePath)) {
        console.log(`[pythonPath] 使用 exe: ${exePath}`);
        return {
            command: exePath,
            args: [...extraArgs]
        };
    }

    if (fs.existsSync(onedirExePath)) {
        console.log(`[pythonPath] 使用 onedir exe: ${onedirExePath}`);
        return {
            command: onedirExePath,
            args: [...extraArgs]
        };
    }

    throw new Error(`找不到: ${scriptName}.py 或 ${scriptName}.exe`);
}

/**
 * Python interpreter precedence is explicit and deterministic:
 * SEMG_PYTHON > CONDA_PREFIX/python.exe > python on PATH.
 */
function getPythonInterpreter(env = process.env) {
    const explicit = String(env.SEMG_PYTHON || '').trim().replace(/^"|"$/g, '');
    if (explicit) return explicit;

    const condaPrefix = String(env.CONDA_PREFIX || '').trim();
    if (condaPrefix) {
        const condaPython = path.join(condaPrefix, process.platform === 'win32' ? 'python.exe' : 'bin/python');
        if (fs.existsSync(condaPython)) return condaPython;
    }
    return 'python';
}

module.exports = { getPythonCommand, getPythonInterpreter, PYTHON_DIST_DIR };
