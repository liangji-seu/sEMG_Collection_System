# 09 - H5 整合管理工具 (hdf5_tool)

## 2026-10-07 离线维护基线

完整契约见 [系统审查](13-system-review.md)。写入先获取稳定的 `.offline.lock`，在同目录副本完成后验证并原子替换；需要约一个原文件大小的空闲空间。锁文件正常保留，勿用删除锁文件处理占用。

同步列表区分 `partial` / `unverified` / 已验证，按实际设备与源指纹判断。清除同步也清理质量诊断和旧同步属性，原始采集数据保留。

视频压缩先完整解码核对帧数、尺寸与时长，再发布MP4；保留原AVI。多个H5的引用逐文件事务更新，中途失败报告partial，不声明跨文件原子性。失败、空视频或截断输出均保留原数据。

## 1. 概述

**文件**: `tools/hdf5_tool.py` (4800+ 行)  
**依赖**: PyQt5, h5py

hdf5_tool 是 H5 文件的**瑞士军刀** — 集文件管理、同步、可视化和断点恢复于一体。是整个项目中最大的单体 GUI 应用。

---

## 2. 架构

```
HDF5Tool (QMainWindow)
├── QTabWidget
│   ├── ViewerTab          # H5 元数据查看
│   ├── SyncTab            # 同步 (单个 H5)
│   ├── OneToManySyncTab   # 批量同步 (多 H5)
│   ├── SyncCalibrationTab # 精确对齐标定 (视频帧)
│   ├── SyncToolsTab       # 同步工具 (批量 ADC search / 清除)
│   ├── CalibrateTab       # 数据可视化 (嵌入 calibrate_tool)
│   └── BreakpointTab      # 断点恢复
│
└── Worker Threads
    ├── SyncWorker(QThread)         # 同步工作线程
    ├── OneToManySyncWorker(QThread) # 批量同步
    └── ClearSyncWorker(QThread)    # 清除同步结果
```

---

## 3. 标签页详解

### 3.1 ViewerTab — 元数据查看器

**核心类**: `StatisticsPanel` (line 808, ~500 行)

分区域展示 H5 文件元数据：
- **文件信息**: 名称/大小/时间
- **采集配置**: task_id, stage_name, 分类标签
- **受试者信息**: ID, 姓名, 年龄等
- **硬件信息**: BLE 设备名称, SD bin 文件名, HW 版本
- **IMU 设备详情**: BLE 实测通道 + 同步活跃通道
  - 根据 `imu_all_ble` 的 `imu_index` 推算 BLE 实测通道 (a/b/c)
  - 从 H5 attrs 读取 `imu{dev}_active_count/indices` 显示同步后活跃 IMU
- **采集状态**: collection_status, sync_status, segment_index
- **视频信息**: video_left/right 路径
- **断点信息**: is_resumed, breakpoint_state, resume_progress

关键方法:
- `load_h5_file(h5_path)` — 加载 H5
- `update_stats(meta)` — 更新所有面板 (line 1025+)
- `_wristband_dev{1,2}_keys` — 控制通道标签颜色编码

### 3.2 SyncTab — 单 H5 同步

- 选择 H5 文件 + bin 目录
- `SyncWorker` → `sync_h5_with_bin()` 后台执行
- 自动保存 + 恢复 bin 目录 (QSettings)
- 同步完成后自动刷新文件列表颜色

### 3.3 OneToManySyncTab — 批量同步

- 多 H5 文件列表，拖拽添加
- `OneToManySyncWorker` 串行处理
- 进度条 + 状态反馈
- 完成后自动清除列表

### 3.4 SyncCalibrationTab — 精确对齐标定

**核心类**: `SyncCalibrationTab` (line 2358)

利用视频帧 + EMG prompt 时间戳，人工标定 offset 消除 EMG-视频延迟：
- 加载视频（opencv）、选择 prompt 事件
- 逐帧前进/后退寻找 prompt 对应的视频帧
- 计算 `delta_t = video_timestamp - prompt_timestamp`
- 支持左右摄像头独立标定

### 3.5 SyncToolsTab — 同步工具

- **批量 ADC Search**: 对多个 H5 执行 adc_search 模式同步
- **批量清除**: 清除 H5 中的同步结果 (备份原始数据)
- 完成后自动刷新文件列表颜色

### 3.6 CalibrateTab — 数据可视化

嵌入 `calibrate_tool.CalibrateWidget`，提供完整的数据可视化功能（详见文档 10）。

### 3.7 BreakpointTab — 断点恢复

**核心类**: `BreakpointTab` (line 3684)

扫描 storage 目录下所有异常中断的 H5：
- 读取 `breakpoint_state` (优先) / `resume_progress`
- 解析进度: `collectionConfig`, `gesturesSnapshot`, `currentGestureIndex`
- 支持**导出断点 JSON** → 在主采集界面导入恢复

输出示例:
```
[RECOVERABLE] S001 | session1 | Stage: palm_up | 手势 12/50 | 时间: 2026-06-24T15:30:00
[RESUMED]     S001 | session1 | Stage: palm_up | 手势 50/50 → 已被 seg2 续采
```

---

## 4. HDF5Tool 主窗口

**核心类**: `HDF5Tool(QMainWindow)` (line 4424)

```python
class HDF5Tool(QMainWindow):
    def __init__(self):
        self.tabs = QTabWidget()
        self.viewer_tab = ViewerTab(self)
        self.sync_tab = SyncTab(self)
        self.one_to_many_sync_tab = OneToManySyncTab(self)
        self.sync_calibration_tab = SyncCalibrationTab(self)  # 【新增】
        self.sync_tools_tab = SyncToolsTab(self)
        self.calibrate_tab = CalibrateTab(self)
        self.breakpoint_tab = BreakpointTab(self)
        
        # 文件列表 (左侧栏)
        self.file_list = QListWidget()
        self.refresh_file_list()    # 扫描 storage/*.h5
```

### 4.1 文件列表颜色编码

| 颜色 | 含义 |
|------|------|
| 绿色 `#16a34a` | 已同步 `sync_status == "synced"` |
| 红色 `#ef4444` | 同步失败 `sync_status == "sync_failed"` |
| 蓝色 `#3b82f6` | 等待同步 `sync_status == "pending"` |
| 橙色 `#f97316` | 异常中断 `collection_status == "abnormal_interrupted"` |

### 4.2 辅助方法

| 方法 | 说明 |
|------|------|
| `refresh_file_list()` | 完整扫描 storage 目录 (含颜色) |
| `refresh_file_list_colors()` | 仅刷新颜色 (不重扫，更高效) |
| `load_h5_metadata(filepath)` | 读取单个 H5 元数据 (350+ 行) |
| `scan_segment_chain(h5_dir)` | 扫描多 segment 链 |

---

## 5. 元数据解析

`load_h5_metadata()` (line 346+) 返回约 **50 个字段**的综合元数据字典，包含：

- 文件基础: `filename`, `filepath`, `file_size`, `created_at`
- 配置信息: `task_id`, `stage_name`, `session_index/number/count`
- 设备信息: `sd_bin_dev1/2`, `ble_dev1/2`, `hw_version`, `num_imus`
- 状态信息: `collection_status`, `sync_status`, `segment_index`
- 续采信息: `is_resumed`, `resumed_by_segment_index`, `resumed_by_file`
- 断点信息: `resume_progress_raw/parsed`, `breakpoint_state`
- 统计信息: `total_emg_frames`, `total_imu_frames`, `total_prompts`
- 视频信息: `video_left/right`
- IMU 信息: `imu{dev}_active_count/indices`, `imu{dev}_num_imus`
