# 11 - 构建与部署

## 2026-10-07 启动与验收补充

日常使用与验证命令见根目录 [README](../../README.md)，详细证据见 [系统审查](13-system-review.md)。Python选择顺序为 `SEMG_PYTHON` → 激活环境 `CONDA_PREFIX` → PATH；打包环境兼容配套服务exe。

服务以真实端口/连接就绪为准，启动失败回滚自己拥有的进程；退出等待资源释放，不按端口杀死其他程序。BLE与存储为必需服务，动捕/摄像头不可用时健康接口明确降级；`/api/health` 提供状态。

录像编码和视频压缩需要ffmpeg（PATH或现有打包位置）。当前验收环境没有ffmpeg，视频故障测试使用真实OpenCV视频和受控进程替身；真实编码与手环/摄像头/Nokov长时运行仍需现场验收。

## 1. 概述

系统支持两种运行方式：开发环境直接运行源码，生产环境通过 Electron + PyInstaller 打包为独立应用。

---

## 2. Python 依赖

**文件**: `requirements.txt`

```
numpy>=1.24.0
scipy>=1.10.0
h5py>=3.8.0
pyzmq>=25.0.0
websockets>=11.0
bleak>=0.19.0
msgpack>=1.0.5
pyqt5>=5.15.0       # GUI 工具 (hdf5_tool, calibrate_tool)
pyqtgraph>=0.13.0   # 科学绘图 (EMG/IMU 波形)
opencv-python>=4.8.0 # 视频帧读取 (calibrate_tool 可选)
```

### 2.1 外部可执行文件

| 工具 | 用途 | 安装方式 |
|------|------|---------|
| **ffmpeg** | 摄像头 MJPEG 采集 + AVI 编码 | 系统 PATH 或 WinGet (`Gyan.FFmpeg`) |
| **ffprobe** | 提取视频帧 PTS 时间戳 | 随 ffmpeg 安装 |

### 2.2 BLE 适配器

- 需要 Windows 10+ 蓝牙 4.0+ 适配器
- 使用 `bleak` 库 (跨平台 BLE)
- 首次运行需安装蓝牙驱动

---

## 3. 运行方式

### 3.1 开发环境

```bash
# 1. 安装依赖
pip install -r requirements.txt
npm install

# 2. 启动服务 (Node.js + Python)
node server.js

# 3. 访问前端
http://localhost:3000

# 4. 离线工具
python tools/hdf5_tool.py
```

### 3.2 Electron 打包

```bash
# 使用 electron-builder 打包为 Windows .exe
npx electron-builder --win

# 目录结构:
# dist/
# └── sEMG_Collection_System/
#     ├── sEMG_Collection_System.exe  (Electron 壳)
#     ├── resources/app.asar           (Node.js 源码)
#     ├── ble_server.exe               (PyInstaller)
#     ├── storage_server.exe           (PyInstaller)
#     ├── camera_server.exe            (PyInstaller)
#     ├── storage/ config/ log/        (可写目录)
#     └── public/                      (前端静态资源)
```

### 3.3 Python 工具打包

```bash
# PyInstaller 打包各 Python 服务为独立 exe
python build_python.py

# 产物:
# dist/ble_server.exe
# dist/storage_server.exe
# dist/camera_server.exe
```

---

## 4. Electron 主进程 (main.js)

**文件**: `main.js` (124 行)

```javascript
// 核心逻辑
app.on('ready', createWindow);  // 启动 Electron → require server.js
app.on('quit', cleanup);       // 退出 → taskkill Python 子进程
```

### 4.1 子进程清理

```javascript
const PYTHON_PROCESSES = ['ble_server.exe', 'storage_server.exe', 'mocap_server.exe'];

function killAllPythonProcesses() {
    for (const procName of PYTHON_PROCESSES) {
        execSync(`taskkill /F /IM ${procName} 2>nul`);
    }
}
```

### 4.2 路径管理

`paths.js` 自动检测运行环境：
- **开发环境**: `storage/`, `config/`, `log/` 在源码目录下
- **打包环境**: 在 `process.execPath` 同级目录 (可写)

---

## 5. 配置文件

采集配置文件存储在 `config/*.json`，格式：

```json
{
  "templateName": "default",
  "task": "离散手势采集",
  "subject": {
    "id": "S001",
    "name": "张三",
    "age": 25,
    "gender": "男"
  },
  "category1": "static",
  "category2": "sitting",
  "category4": "normal",
  "stages": [
    {
      "id": "palm_up",
      "name": "手心朝上",
      "promptSequence": ["thumb_up", "grasp", "pinch", ...],
      "shuffle": true,
      "needMocap": false
    }
  ],
  "gestureLibrary": {
    "thumb_up": { "name": "竖起大拇指", "icon": "👍", "gifFile": "thumb_up.gif" },
    "grasp": { "name": "抓握", "icon": "✊", "gifFile": "grasp.gif" }
  }
}
```

通过 `/api/config/save` / `/api/config/load/:filename` 管理。

---

## 6. 日志系统

**Node.js 侧**: `logger.js`
- 日志目录: `log/`
- 文件名: `server_YYYY-MM-DD_HH-mm-ss.log`
- 轮转策略: 单文件最大 20MB，最多保留 10 个

**Python 侧**:
- `ble_server.py` → stdout/stderr (由 deviceSync 转发)
- `storage_server.py` → `debug_log()` (stderr, 由 dataStorage 转发)
- `camera_server.py` → stdout (由 server.js 转发)

---

## 7. 目录规范

### 7.1 开发环境
```
sEMG_Collection_System/
├── node_modules/        # npm 依赖 (gitignore)
├── storage/             # H5 数据
├── config/              # 采集配置 .json
├── log/                 # 运行日志
├── public/              # 前端
├── tools/               # Python 工具
├── docs/                # 文档
└── *.js / *.py          # 源码
```

### 7.2 打包环境
```
sEMG_Collection_System/
├── sEMG_Collection_System.exe
├── resources/app.asar
├── ble_server.exe / storage_server.exe / camera_server.exe
├── storage/ config/ log/
└── public/
```

---

## 8. 新电脑部署检查清单

1. **Python 3.10+** 安装
2. `pip install -r requirements.txt`
3. **ffmpeg** 安装 (PATH 可用)
4. **Node.js 18+** 安装 (开发模式需要)
5. **蓝牙适配器** (Windows 蓝牙设置中确认可用)
6. **USB 摄像头** 驱动安装
7. **Nokov SDK** 安装 (动捕功能需要，可选)
