# 10 - 数据可视化 (calibrate_tool)

## 2026-10-07 预览与时间轴基线

验收与兼容性见 [系统审查](13-system-review.md)。EMG缓存各设备时间列，16通道按可见窗口与滤波padding读取；不同设备可有不同采样率、开始时间和缺口。重复/回退时间戳提示先修复；加载失败释放文件、播放计时器和视频句柄。

视频首尾映射由 `video_timeline.py` 统一：N帧包含N-1个间隔，单帧时长为0；历史头部600fps可用真实首尾时间校正。当前采集格式主要保存首尾时间，不据此声称获得逐帧不规则时间戳。IMU启发式结果仍需核验。

## 1. 概述

**文件**: `tools/calibrate_tool.py` (2800+ 行)  
**依赖**: PyQt5, pyqtgraph, h5py, numpy, (可选) cv2

calibrate_tool 是数据可视化组件，支持 EMG/IMU 波形显示、频谱分析、视频同步预览和 IMU 健康诊断。可独立运行或嵌入 `hdf5_tool`。

---

## 2. 核心类

### 2.1 CalibrateWidget (line 131)

```python
class CalibrateWidget(QWidget):
    """可视化主组件"""
    
    # === 数据 ===
    h5_path: str                   # 当前 H5 文件路径
    emg_data: dict                 # {dev}_2khz_adc 完整数据
    imu_data: dict                 # {dev}{ch}_100hz 完整数据
    current_time: float            # 当前时间轴位置 (秒)
    time_window: float = 2.0       # 时间窗口 (秒)
    
    # === IMU 通道信息 ===
    _imu_dev1_ble_channels: []     # ['a', 'b'] — BLE 实测通道
    _imu_dev1_sync_channels: []    # ['a', 'b'] — 同步后活跃通道
    _imu_dev2_ble_channels: []
    _imu_dev2_sync_channels: []
    
    # === 视频 ===
    video_caps: {}                 # {'left': cv2.VideoCapture, 'right': ...}
    video_fps: {}
    video_frame_count: {}
    
    # === 标定 ===
    calibration_mode: bool = False  # 是否处于标定模式
    clamp_enabled: bool = True      # Clamp 滤波器 (默认开启)
```

### 2.2 CalibrateTool (line 2774)

```python
class CalibrateTool(QMainWindow):
    """独立运行时的主窗口包装器"""
```

### 2.3 EMGFilter (line 82)

```python
class EMGFilter:
    """EMG 滤波: 带通 + 陷波 (50Hz) + Clamp"""
```

---

## 3. 界面布局

```
┌─────────────────────────────────────────────────┐
│  功能标签行: H5路径 | 时间窗口 [+ ] [−]          │
├─────────────────────────────────────────────────┤
│  左侧控制面板                   │ 右侧主视图      │
│  ┌─────────────────────┐      │ ┌────────────┐  │
│  │ ⏮ ⏪ ▶ ⏩ ⏭ 播放控制│      │ │            │  │
│  │ Clamp ☑ 标定模式 ☐  │      │ │ EMG 波形   │  │
│  │ 导出数据 [按钮]       │      │ │ (16通道)    │  │
│  │                     │      │ │            │  │
│  │ 手环1 EMG           │      │ ├────────────┤  │
│  │ ☑ ch1 ☑ ch2 ...    │      │ │ IMU Acc    │  │
│  │ 手环2 EMG           │      │ │ (X/Y/Z)    │  │
│  │ ☑ ch1 ☑ ch2 ...    │      │ ├────────────┤  │
│  │                     │      │ │ IMU Gyr    │  │
│  │ 手环1 IMU           │      │ │ (X/Y/Z)    │  │
│  │ ☑ Acc ☑ Gyr         │      │ ├────────────┤  │
│  │ 手环2 IMU           │      │ │ 频谱/FFT    │  │
│  │ ☑ Acc ☑ Gyr         │      │ │            │  │
│  │                     │      │ └────────────┘  │
│  │ Prompt 跳转按钮      │      │                 │
│  │ [thumb_up] [grasp]  │      │                 │
│  │                     │      │                 │
│  │ 视频预览             │      │                 │
│  │ [左1s] [右1s]        │      │                 │
│  │ 摄像头帧             │      │                 │
│  └─────────────────────┘      └─────────────────┘
└─────────────────────────────────────────────────┘
```

---

## 4. 数据加载

### 4.1 load_h5_file()

```python
def load_h5_file(self, h5_path):
    # 1. 打开 H5
    # 2. 读取所有 EMG/IMU 数据集到内存 (支持懒加载大数据集)
    # 3. 解析时间戳范围
    # 4. _infer_imu_counts() — IMU 数量推断 (可视化侧)
    # 5. _load_videos() — 加载关联视频 (需 cv2)
    # 6. update_imu_plot() — 初始绑定
```

### 4.2 _infer_imu_counts()

```python
def _infer_imu_counts(self, f):
    """可视化侧的 IMU 数量/通道推断
    
    优先级:
    1. imu{dev}_active_count (sync 校验结果) ← 最优先
    2. imu_all_ble imu_index (BLE 实测)
    3. 已加载数据 + 质量过滤
    4. H5 attrs (BLE 握手)
    5. 默认 2
    """
    for dev in [1, 2]:
        # BLE 通道: 从 imu_all_ble 读取 imu_index → ['a','b','c']
        indices = sorted(set(int(x) for x in ds['imu_index'][:]))
        ble_chs = [ch_labels[i] for i in indices if i < len(ch_labels)]
        
        # Sync 通道: 从 active_indices attr 或数据质量过滤
        sync_chs = [ch_labels[int(n)] for n in nums if int(n) < len(ch_labels)]
```

### 4.3 _load_videos()

```python
def _load_videos(self, f):
    """从 H5 attrs 读取 video_left/video_right 路径 → cv2.VideoCapture"""
    # 智能路径搜索: H5 目录 → 上级目录 → 子目录遍历
```

---

## 5. 可视化功能

### 5.1 EMG 波形

- 16 通道叠加显示 (pyqtgraph PlotItem)
- 支持 Clamp 滤波 (去除异常尖峰)
- Y 轴: μV 值 (原始 ADC × LSB 系数)
- X 轴: 时间 (秒)，可缩放窗口 (0.5s ~ 10s)
- 按设备分组 (手环1/手环2)，可独立控制通道勾选

### 5.2 IMU 波形

- **加速度计**: 3 轴 (X/Y/Z) 叠加, 单位 g
- **陀螺仪**: 3 轴 (X/Y/Z) 叠加, 单位 °/s
- 标题显示: `手环1 (3IMU) | BLE: a,b | Sync活跃: a,b`
- 每个 IMU 通道独立图表 (拆分子标题)

### 5.3 频谱分析 (FFT)

- EMG 频谱: 0-1000Hz (2kHz 采样)
- IMU 频谱: 0-50Hz (100Hz 采样)
- 实时跟随当前时间窗口

### 5.4 Prompt 跳转

- 读取 H5 `prompts` 数据集
- 按钮列表: `thumb_up_start`, `grasp_end` 等
- 点击 → 时间轴跳转到对应位置
- 视频帧同步跳转 + 显示 EMG 对齐时间

### 5.5 视频同步预览

- 左右摄像头各一个 2s 预览按钮
- 读取当前时间窗口附近的视频帧
- 帧标签显示 EMG 对齐时间
- 支持逐帧前进/后退 (← → 键)
- Prompt 红/蓝线标注

### 5.6 时间轴控制

- `⏮ ⏪ ▶ ⏩ ⏭` 播放控制
- 拖拽时间轴滑块
- 鼠标滚轮缩放时间窗口
- 键盘快捷键: Space(播放/暂停), ←→(移动)

---

## 6. IMU 通道信息展示

```python
# 标题格式
f'{dev_label} ({imu_count}IMU) | BLE: {ble_chs} | Sync活跃: {sync_chs}'
# 例如: "手环1 (2IMU) | BLE: a,c | Sync活跃: a,c"
#       "手环2 (3IMU) | BLE: a,b,c | Sync活跃: a,b"
```

- `_imu_dev{1,2}_ble_channels` — 从 `imu_all_ble` 推断 (实际蓝牙发送的通道)
- `_imu_dev{1,2}_sync_channels` — 从 H5 attrs 推断 (同步后验证活跃的通道)
- `_update_imu_channel_labels()` — 更新标题栏 QLabel
