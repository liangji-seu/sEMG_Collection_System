# sEMG Collection System

华为肌电手环数据采集与离线处理系统。采集入口是浏览器界面，离线入口是 `tools/hdf5_tool.py`。

## 启动

```powershell
conda activate sEMG_Collection_System
npm start
```

录像编码和视频压缩需要可用的ffmpeg（PATH或现有打包位置）。

首次配置环境时，分别安装 `package.json` 和 `requirements.txt` 中的依赖。`tools/requirements.txt` 引用同一份 Python 清单，避免两个环境声明漂移。

Python 解释器优先使用 `SEMG_PYTHON`，其次使用激活环境的 `CONDA_PREFIX`，最后使用 PATH 中的 `python`。打包程序仍优先使用配套的服务 exe。可显式指定：

```powershell
$env:SEMG_PYTHON='E:\miniconda\envs\sEMG_Collection_System\python.exe'
npm start
```

离线工具：

```powershell
python tools/hdf5_tool.py
```

## 模块与维护入口

| 功能 | 入口 | 说明 |
|---|---|---|
| 启动与接口 | `server.js` | HTTP、子进程编排、健康状态、文件列表 |
| 采集编排 | `realtimeEngine.js` | 设备数据通道、采集生命周期、保存确认 |
| 数据存储 | `storage_server.py` | HDF5 追加、序号栅栏、完整／不完整收尾 |
| 设备服务 | `ble_server.py` / `camera_server.py` / `mocap_server.py` | BLE、摄像头、动捕 |
| 离线处理 | `tools/hdf5_tool.py` | 同步、浏览、校准、视频处理 |
| 同步算法 | `tools/bin_sync_tool.py` | bin 内容映射与时间轴重建 |
| 文件事务 | `tools/file_access.py` | 离线排他修改、工作副本与提交 |
| 进程与日志 | `lib/service-process.js` / `logger.js` | 就绪、退出、日志轮转和背压 |

从 [项目架构](docs/project/01-architecture.md) 开始阅读。详细功能见 [采集界面](docs/project/04-collection-ui.md)、[数据格式](docs/project/07-data-format.md)、[离线同步](docs/project/08-bin-sync-tool.md)、[HDF5 工具](docs/project/09-hdf5-tool.md)。本轮问题、实现边界和实际验收证据在 [系统审查](docs/project/13-system-review.md)。

## 验证

在上述 Conda 环境中运行：

```powershell
npm test
npm run test:python
```

Python GUI 测试使用离屏模式，不需要显示窗口；测试仅创建临时合成数据。进程就绪测试需要允许本机回环 TCP 通信。真实数据验收只能对工作副本运行，具体清单与逐帧校验方法见系统审查。

`/api/health` 提供服务就绪和降级状态。日志位于 `log/`。异常保存时应先保留故障原因并完成明确的不完整收尾；正常“保存成功”必须有存储确认。硬件断连续采、SD 尾帧和摄像头实际帧率仍需在连接设备后做现场验收。
