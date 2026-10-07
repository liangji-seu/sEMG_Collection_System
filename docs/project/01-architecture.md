# 01 - 系统架构概览

## 2026-10-07 维护基线

本轮系统性审查与验收以 [系统审查](13-system-review.md) 为准。日常入口保持 `npm start` 与 `python tools/hdf5_tool.py`。

- `lib/service-process.js` 统一子进程拥有权、真实就绪与退出等待；`pythonPath.js` 统一解释器选择。
- `realtimeEngine.js` 负责采集生命周期与跨服务确认；`storage_server.py` 负责文件token、批次序号、写入及关闭栅栏。
- 离线共享模块：`file_access.py` 管排他锁和副本提交，`alignment.py` 管计数器规则，`video_timeline.py` 管首尾帧时间映射。
- 设备与存储故障进入明确失败状态；停止失败保留会话所有权，允许重试或明确保留为不完整采集。后台任务和消息队列均有边界。

以下章节保留原模块背景；旧行号、规模统计和行为描述若与上述审查冲突，以当前源码与验收契约为准。

## 1. 项目概述

sEMG Collection System 是一个**多模态生理信号采集系统**，支持同步采集表面肌电（sEMG）、惯性测量单元（IMU）、USB摄像头视频和动作捕捉（Mocap）数据。系统采用 **Electron + Node.js + Python** 混合架构，前端基于 Web 技术栈。

### 1.1 核心能力

| 能力 | 描述 |
|------|------|
| **双腕带采集** | 同时连接两个 ESP32S3_EMG 腕带，每个腕带 8 通道 sEMG + 1~3 个 IMU 传感器 |
| **SD 卡 bin 同步** | BLE 传输 250Hz 压缩数据，SD 卡写入完整 2kHz (EMG) / 100Hz (IMU)，采集后离线同步补齐 |
| **摄像头同步录制** | 2 路 USB 摄像头（左手+右手），MJPEG 预览 + AVI 连续录制，与 EMG 共用统一时间戳 |
| **动捕系统** | 支持光学动捕 SDK 数据接入，解算指关节角度或拇指-食指距离驱动采集引导 |
| **断点续采** | 异常中断后保存完整断点快照，支持从断点手势索引继续采集 |
| **数据可视化** | 离线 H5 数据可视化工具，含 EMG/IMU 波形、频谱、视频同步预览、IMU 通道健康诊断 |

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Electron Shell (main.js)                         │
│                   启动/停止所有模块，子进程生命周期管理                    │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ require()
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Express HTTP Server (server.js :3000)               │
│  启动顺序: realtimeEngine → deviceSync → cameraServer → dataStorage     │
│  静态服务(public/) + REST API(/api/*) + 统一生命周期管理                  │
└───────┬──────────────────┬──────────────────┬───────────────────────────┘
        │ require()        │ spawn()          │ spawn()
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│realtimeEngine │  │  deviceSync   │  │  dataStorage   │
│  (WS :8080)   │  │  (进程管理)    │  │  (进程管理)     │
│  数据中枢      │  │               │  │                │
└───┬───┬───┬───┘  └───────┬───────┘  └───────┬───────┘
    │   │   │              │ spawn()           │ spawn()
    │   │   │              ▼                   ▼
    │   │   │      ┌───────────────┐  ┌───────────────────┐
    │   │   │      │ ble_server.py │  │ storage_server.py │
    │   │   │      │ :8764 (控制)   │  │ :5555 (REP)        │
    │   │   │      │ :8766 (数据)   │  │ :5556 (PUSH)       │
    │   │   │      └───────────────┘  └───────────────────┘
    │   │   │
    │   │   └──(WS :8767)──► mocap_server.py    (动作捕捉)
    │   │   └──(WS :8768)──► camera_server.py   (USB摄像头)
    │   │
    │   └──(WS :8080)──► 前端浏览器 (index.html)
    │
    └──(WS :8764)──► ble_control.js (前端直连 ble_server 控制端)

┌─────────────────────────────────────────────────────────────────────────┐
│                           Python 工具链 (离线)                           │
│  tools/hdf5_tool.py       — H5 文件管理、同步、可视化主界面              │
│  tools/bin_sync_tool.py   — bin 解析、IMU 数量推断、H5 同步写入         │
│  tools/calibrate_tool.py  — 数据可视化、视频同步预览、IMU 诊断           │
│  tools/diagnose_imu.py    — IMU 数据健康状态对比诊断                     │
│  tools/hdf5_stage_viewer.py — H5 多 segment 链查看器                    │
│  tools/build_tool.py      — 打包构建                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 进程拓扑与端口

| 进程 | 角色 | 端口 | 协议 | 通信对象 |
|------|------|------|------|---------|
| `main.js` | Electron 壳 | — | — | 管理 server.js 生命周期 |
| `server.js` | HTTP 服务 + 编排 | 3000 | HTTP | 前端浏览器 |
| `realtimeEngine.js` | 数据中枢 | 8080 | WebSocket | 前端浏览器 |
| `realtimeEngine.js` | BLE 数据接收 | → 8766 | WebSocket | ble_server.py (数据端) |
| `realtimeEngine.js` | Mocap 接收 | → 8767 | WebSocket | mocap_server.py |
| `realtimeEngine.js` | Camera 控制 | → 8768 | WebSocket | camera_server.py |
| `realtimeEngine.js` | Storage 控制 | → 5555 | ZMQ REP | storage_server.py |
| `realtimeEngine.js` | Storage 数据 | → 5556 | ZMQ PUSH | storage_server.py |
| `deviceSync.js` | BLE 生命周期 | spawn | — | ble_server.py (进程管理) |
| `dataStorage.js` | Storage 生命周期 | spawn | — | storage_server.py (进程管理) |
| `ble_server.py` | BLE 控制 | 8764 | WebSocket | 前端 ble_control.js |
| `ble_server.py` | BLE 数据 | 8766 | WebSocket | realtimeEngine.js |
| `mocap_server.py` | 动捕数据 | 8767 | WebSocket | realtimeEngine.js |
| `camera_server.py` | 摄像头 | 8768 | WebSocket | 前端 camera_control.js + realtimeEngine.js |
| `storage_server.py` | H5 存储 | 5555 | ZMQ REP | realtimeEngine.js |
| `storage_server.py` | H5 存储 | 5556 | ZMQ PUSH | realtimeEngine.js |
| 前端 `ble_control.js` | BLE 控制 | → 8764 | WebSocket | ble_server.py (控制端) |
| 前端 `camera_control.js` | 摄像头预览 | → 8768 | WebSocket | camera_server.py |

---

## 4. 核心数据流

### 4.1 实时采集数据流

```
ESP32S3_EMG 腕带 (Dev1 + Dev2)
    │ BLE 通知 (250Hz EMG + 27.8Hz IMU)
    ▼
ble_server.py
    │ 解析、滤波、打包
    ├──► realtimeEngine.js (:8766 WebSocket)
    │       │ 转发 EMG/IMU/Mocap 数据
    │       ├──► 前端浏览器 (:8080 WebSocket) → 波形实时显示
    │       └──► storage_server.py (:5556 ZMQ PUSH) → H5 写入
    │
    └──► 前端 ble_control.js (:8764 WebSocket) —— 设备扫描/连接/配置

camera_server.py
    │ USB 摄像头 MJPEG 采集
    ├──► 前端 camera_control.js (:8768 WebSocket) → 预览缩略图
    └──► realtimeEngine.js → 录制控制(start/stop/save AVI)

mocap_server.py
    │ 动捕 SDK 数据
    └──► realtimeEngine.js (:8767 WebSocket)
            ├──► 前端 → 采集引导 (手指关节角度/距离 → 同心圆光标)
            └──► storage_server.py → H5 写入
```

### 4.2 离线同步数据流

```
采集完成后:
  H5 文件 (BLE 250Hz EMG + 27.8Hz IMU)
  + SD 卡 bin 文件 (2kHz EMG + 100Hz IMU)
      │
      ▼
tools/bin_sync_tool.py
      │ 读取 bin → 解析帧结构 → 推断 IMU 数量
      │ → 按 sd_frame_id 对齐写入 H5
      │ → 生成 emg{dev}_2khz_adc + imu{dev}{ch}_100hz 数据集
      ▼
  完整 H5 文件 (含 2kHz EMG + 100Hz IMU)
      │
      ▼
tools/calibrate_tool.py (可视化)
  EMG/IMU 波形、频谱、视频帧同步、IMU 健康诊断
```

---

## 5. 目录结构

```
sEMG_Collection_System/
├── main.js                     # Electron 主进程
├── server.js                   # Express HTTP 服务 + 模块编排
├── realtimeEngine.js           # 实时数据中枢 (1700+ 行)
├── deviceSync.js               # BLE/Mocap 子进程管理
├── dataStorage.js              # Storage 子进程管理
├── cameraManager.js            # 摄像头设备枚举与管理
├── paths.js                    # 路径管理 (dev/打包自适应)
├── logger.js                   # Node.js 日志系统
├── constants.js                # 全局常量
├── pythonPath.js               # Python 解释器路径解析
│
├── ble_server.py               # BLE 数据采集服务 (Python)
├── storage_server.py           # HDF5 数据存储服务 (Python)
├── camera_server.py            # USB 摄像头管理服务 (Python)
├── mocap_server.py             # 动作捕捉服务 (Python)
├── mocap_client_demo.py        # 动捕客户端示例
├── mocap_simulator.py          # 动捕模拟器
│
├── public/                     # Web 前端
│   ├── index.html              # 主页面 (6300+ 行)
│   ├── lib/                    # 第三方库
│   │   ├── lab.js / lab.dev.js # labjs 动画引擎
│   │   └── fontawesome/        # 图标库
│   └── scripts/                # 前端脚本
│       ├── collection-controller.js    # 采集流程控制 (3700+ 行)
│       ├── discrete-gesture-animation.js # 离散手势动画
│       ├── continual-gesture-{1,2,3}-animation.js # 连续手势动画
│       ├── animation-controller.js      # 动画控制器
│       ├── animation-input-interface.js # 动画输入接口
│       ├── animation-position-manager.js # 动画面板拖拽
│       ├── backend-manager.js           # 后端 WebSocket 管理
│       ├── ble_control.js               # BLE 设备控制
│       ├── camera_control.js            # 摄像头控制 (WS 直连)
│       ├── config-manager.js            # 采集配置管理
│       ├── page-switch.js               # 页面切换
│       ├── waveform.js                  # 波形显示
│       ├── waveform-renderer.js         # 波形渲染器
│       ├── signal-quality.js            # 信号质量指示
│       ├── device-status-widget.js      # 设备状态组件
│       └── collection-constants.js      # 采集常量
│
├── tools/                      # Python 离线工具
│   ├── hdf5_tool.py            # H5 整合工具主界面 (4800+ 行)
│   ├── bin_sync_tool.py        # Bin 同步核心逻辑 (2600+ 行)
│   ├── calibrate_tool.py       # 数据可视化组件 (2600+ 行)
│   ├── hdf5_stage_viewer.py    # Stage 查看器
│   ├── diagnose_imu.py         # IMU 诊断工具
│   ├── build_tool.py           # 打包构建
│   ├── build_viewer.py         # 可视化工具构建
│   └── mp4_2_gif.py            # 视频转 GIF
│
├── docs/                       # 文档
│   └── project/                # 项目审查文档 (本系列)
├── config/                     # 采集配置文件 (*.json)
├── storage/                    # H5 数据存储目录
├── log/                        # 日志目录
└── requirements.txt            # Python 依赖
```

---

## 6. 启动流程

```
1. main.js (Electron 壳)
   └─→ require('./server.js')

2. server.js → startServer()
   ├─→ realtimeEngine.start(8080)          # WebSocket 中枢就绪
   │     ├─→ ble_server_connect()           # 延迟 5s 连接 :8766
   │     ├─→ mocap_server_connect()         # 延迟 5.5s 连接 :8767
   │     ├─→ camera_server_connect()        # 延迟 6s 连接 :8768
   │     └─→ storage_server_connect()       # ZMQ :5555/:5556
   │
   ├─→ deviceSync.initialize()             # spawn ble_server.py
   │     └─→ spawn mocap_server.py (可选)
   │
   ├─→ startCameraServer()                 # spawn camera_server.py
   │
   ├─→ dataStorage.initialize()            # spawn storage_server.py
   │
   └─→ app.listen(3000)                    # HTTP 服务启动
        └─→ 8s 后 printSystemStatus()       # 打印连接状态

3. 用户打开浏览器 → http://localhost:3000
   └─→ 前端 page-switch.js → 连接 :8080 (realtimeEngine)
                              → 连接 :8764 (ble_server 控制)
                              → 连接 :8768 (camera_server 预览)
```

---

## 7. 关键技术决策

| 决策 | 方案 | 原因 |
|------|------|------|
| **BLE 控制与数据分离** | ble_server 两个 WebSocket 端口 (:8764/:8766) | 控制命令低延迟优先，数据流独立避免阻塞 |
| **Storage 双通道** | ZMQ REP (:5555) 控制 + PUSH (:5556) 数据 | REP 保证控制命令可靠响应；PUSH 非阻塞写入保证实时性 |
| **统一时钟** | Python `time.time()` 作为唯一时钟源 | EMG/IMU/视频时间戳同源，消除 Node.js `Date.now()` 与 Python `time.time()` 偏差 |
| **Preview/Collection 切流** | ble_server 维护两套 SD 卡 bin 文件 | Preview 的 bin 不参与 H5 同步，避免污染数据 |
| **IMU 多源融合** | BLE 实测 + BLE 握手 + Bin 检测 → 帧 ID 验证仲裁 | 鲁棒处理传感器损坏、bin 截断、BLE 限传等场景 |
| **断点续采** | localStorage 完整断点快照 → H5 标记 `abnormal_interrupted` | 支持异常中断后从具体手势索引恢复 |
| **打包方案** | Electron (main.js) 内嵌 Node.js 服务 + Python 子进程 | 跨平台桌面应用，无需用户手动启动多个进程 |

---

## 8. 模块文档索引

| 编号 | 文档 | 核心文件 | 行数(约) |
|------|------|---------|---------|
| 02 | Python 服务层 | ble_server, storage_server, camera_server, mocap_server | 6000+ |
| 03 | Node.js 中间层 | realtimeEngine, deviceSync, dataStorage | 2500+ |
| 04 | Web 采集界面 | index.html, collection-controller, config-manager | 10000+ |
| 05 | 动画引擎 | discrete-gesture, continual-gesture-1/2/3, animation-controller | 4000+ |
| 06 | 设备监控与摄像头 | waveform, signal-quality, ble_control, camera-* | 3000+ |
| 07 | H5 数据格式 | storage_server (schema), bin format, prompt protocol | — |
| 08 | 同步工具 | bin_sync_tool | 2600+ |
| 09 | H5 整合管理 | hdf5_tool, hdf5_stage_viewer | 5500+ |
| 10 | 数据可视化 | calibrate_tool | 2600+ |
| 11 | 构建与部署 | build_tool, requirements, Electron 打包 | — |
