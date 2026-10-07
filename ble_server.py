"""
BLE Server for ESP32S3_EMG Device (Dual Device + Dual WebSocket)
=================================================================
支持：
  - 两个蓝牙设备（独立控制）
  - 两个 WebSocket 客户端：
    * 控制端（index.html）: 端口 8764，处理控制命令
    * 数据端（realtimeEngine.js）: 端口 8766，接收数据流

依赖安装：
  pip install websockets bleak msgpack

架构：
  ┌─────────────────┐     ┌─────────────────┐
  │  index.html     │     │ realtimeEngine  │
  │  (控制端)       │     │   (数据端)      │
  └────────┬────────┘     └────────┬────────┘
           │ :8764                 │ :8766
           │ 控制命令              │ 数据流
           ▼                       ▼
  ┌─────────────────────────────────────────┐
  │            ble_server.py                │
  │  ┌─────────────┐   ┌─────────────┐     │
  │  │   Device 1  │   │   Device 2  │     │
  │  └─────────────┘   └─────────────┘     │
  └─────────────────────────────────────────┘
"""

import asyncio
import contextlib
import struct
import time
import traceback
import sys
import io
from collections import deque
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List, Set
from queue import PriorityQueue
from datetime import datetime
import threading
import itertools
from contextvars import ContextVar

import msgpack
import json
import websockets
from bleak import BleakScanner, BleakClient, BleakError

# 尝试导入scipy用于滤波
try:
    from scipy import signal as scipy_signal
    import numpy as np
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    print("[警告] scipy未安装，滤波功能不可用。请运行: pip install scipy numpy", file=sys.stderr)

# ================= 编码配置 =================
try:
    sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
    sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)
except (AttributeError, ValueError):
    pass

# ================= 服务配置 =================
WEBSOCKET_HOST = "localhost"
CONTROL_PORT = 8764   # 控制端口（index.html）
DATA_PORT = 8766      # 数据端口（realtimeEngine.js）

# ================= ESP32 设备配置 =================
TARGET_DEVICE_NAME = "ESP32S3_EMG"

CONTROL_CHAR_UUID = "9e5c100d-afc2-4e4b-b132-f2c0032f7a0b"
EMG_DATA_CHAR_UUID = "9e5c100d-afc2-4e4b-b132-f2c0032f7a0c"

CMD_MAP = {
    '500Hz': 0x10,
    '1kHz': 0x11,
    '2kHz': 0x12,
    'START': 0xA0,
    'STOP': 0xA1,
    'CONFIG': 0xC0,  # 【新增】复合配置命令
    'SET_FILENAME': 0xD0,  # 【新增】设置SD卡文件名命令
}

# ================= 默认配置 =================
# 【修改】默认使用2kHz采样率，与SD卡存储一致
DEFAULT_CONFIG = {
    'sample_rate': 2000,      # 【修改】2kHz采样率（ADC采样率，用于SD卡存储）
    'gain': 1,
    'gain_index': 0,          # 增益索引：0 对应增益1
    'is_16bit': False,        # 24-bit模式
    'shift': 4,
    'imu_enabled': True,
    'frames_per_packet': 9,
}

# ================= Preview / Collection 流切换配置 =================
# STOP → 下一次 START 之间的等待时间（ms），给 ESP32 sd_write_task 足够时间关闭 bin
STREAM_SWITCH_DELAY_MS = 3000
# TIMESTAMP 发送后 → START 之间的等待时间（ms），确保 ESP32 更新了文件名
TIMESTAMP_TO_START_DELAY_MS = 200
# preview bin 文件名前缀标识（用于区分 preview bin 和 collection bin）
PREVIEW_FILENAME_PREFIX = "PREVIEW"
# collection bin 文件名前缀标识（用于区分 collection bin）
COLLECTION_FILENAME_PREFIX = "COLLECT"

# ================= 转换系数 =================
SCALE_ACCEL = 32.0 / 32768.0              # V2 默认: LSM6DSV32X ±32g
SCALE_ACCEL_V1 = 16.0 / 32768.0           # V1: ICM-20948 ±16g
SCALE_GYRO = 70.0 / 1000.0                # Supplier update: 0.07 dps/LSB
SCALE_MAG = 0.15                           # 仅 V1 使用, V2 无磁力计
# 【修正】与供应商代码/bin_sync_tool 保持一致
BASE_LSB_24BIT = 0.476837     # 4.0V ref / 2^23 * 1e6 (μV) — 对齐供应商 V3
HARDWARE_FRONTEND_GAIN = 10    # 硬件前端增益

# ================= IMU 配置 =================
BLE_SAMPLE_RATE = 250           # BLE实际传输频率（固定250Hz，与供应商一致）
BYTES_PER_IMU = 18              # 单 IMU 数据长度 (Acc6+Gyro6+Reserved6)
MAX_NUM_IMUS_V1 = 2             # V1 固定 2 个 IMU (ICM-20948)
MAX_NUM_IMUS_V2 = 3             # V2 最多 3 个 IMU (LSM6DSV32X)

# ================= 通道映射 =================
# 物理通道 → 逻辑显示顺序 (1-indexed, 对齐供应商上位机)
CHANNELS_MAP_V1 = [14, 15, 16, 3, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
CHANNELS_MAP_V2 = [15, 16, 14, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]

# ================= V2 新增: 设备状态特征 =================
STATUS_CHAR_UUID = "9e5c100d-afc2-4e4b-b132-f2c0032f7a0e"
STATUS_PACKET_SNAPSHOT = 0x01
STATUS_PACKET_EVENT = 0x02
STATUS_SNAPSHOT_FORMAT = "<BBBBHBBHBBIIIIIII16s16s"

# ================= 滤波器配置 =================
# 【重要】参考供应商滤波参数，优化实时显示效果
FILTER_ENABLED = True          # 总开关：是否启用滤波
FILTER_LOWCUT = 20             # 带通下限 (Hz) - 与供应商一致，去除运动伪迹
FILTER_HIGHCUT = 100           # 带通上限 (Hz) - 与供应商一致，EMG主要能量在20-100Hz
FILTER_NOTCH_FREQ = 50         # 工频频率 (Hz)
FILTER_NOTCH_Q = 15            # 陷波器Q值 - 与供应商一致，较低Q值更稳定
FILTER_BANDPASS_ENABLED = True # 启用带通滤波
FILTER_NOTCH_ENABLED = True    # 启用工频陷波

# 注意：如果前端显示信号幅度太小，可以在前端调整 Offset 值
# 典型EMG信号幅度：静息时 10-50μV，收缩时 100-500μV
# 建议前端 Offset 设置：100-200μV (默认300可能太大)


# ================= EMG实时滤波器类 =================
class EMGRealtimeFilter:
    """
    EMG实时滤波器（参考供应商实现优化）

    功能：
    - 带通滤波 (默认20-100Hz)：去除直流分量和高频噪声，聚焦EMG主要频率
    - 工频陷波 (50Hz及谐波)：去除电源干扰

    使用单一带通滤波器（而非分离的高通+低通），保持相位响应一致性
    使用IIR滤波器，保持状态实现流式处理
    """

    def __init__(self, fs=1000, num_channels=16,
                 lowcut=FILTER_LOWCUT, highcut=FILTER_HIGHCUT,
                 notch_freq=FILTER_NOTCH_FREQ, notch_q=FILTER_NOTCH_Q,
                 enable_bandpass=FILTER_BANDPASS_ENABLED,
                 enable_notch=FILTER_NOTCH_ENABLED):
        """
        初始化滤波器

        参数:
            fs: 采样率 (Hz)
            num_channels: 通道数
            lowcut: 带通下限 (Hz)
            highcut: 带通上限 (Hz)
            notch_freq: 工频频率 (Hz)
            notch_q: 陷波器Q值（较低值更稳定，推荐15）
            enable_bandpass: 是否启用带通滤波
            enable_notch: 是否启用工频陷波
        """
        if not HAS_SCIPY:
            log("[滤波器] scipy未安装，滤波功能不可用")
            self.enabled = False
            return

        self.enabled = True
        self.fs = fs
        self.num_channels = num_channels
        self.lowcut = lowcut
        self.highcut = min(highcut, fs / 2 * 0.9)  # 不能超过奈奎斯特频率的90%
        self.notch_freq = notch_freq
        self.notch_q = notch_q
        self.enable_bandpass = enable_bandpass
        self.enable_notch = enable_notch

        # 带通滤波器系数（单一带通，而非分离的高通+低通）
        self.b_bandpass = None
        self.a_bandpass = None
        self.zi_bandpass = None

        # 陷波滤波器列表
        self.notch_filters = []  # [(b, a), ...]
        self.zi_notch = None

        # 初始化滤波器
        self._init_filters()

        log(f"[滤波器] 初始化完成: fs={fs}Hz, 带通={self.lowcut}-{self.highcut}Hz, 陷波Q={notch_q}")

    def _init_filters(self):
        """初始化滤波器系数和状态（参考供应商实现）"""
        if not self.enabled:
            return

        # 1. 带通滤波器 - 使用单一4阶Butterworth带通（与供应商一致）
        if self.enable_bandpass:
            # 计算归一化频率
            wn = [self.lowcut * 2 / self.fs, self.highcut * 2 / self.fs]
            # 4阶带通滤波器
            self.b_bandpass, self.a_bandpass = scipy_signal.butter(4, wn, btype='bandpass')
            # 初始化状态
            zi = scipy_signal.lfilter_zi(self.b_bandpass, self.a_bandpass)
            self.zi_bandpass = np.tile(zi[:, np.newaxis], (1, self.num_channels))

        # 2. 工频陷波滤波器 (50Hz及谐波)
        if self.enable_notch:
            self.notch_filters = []
            self.zi_notch = []

            # 陷波50Hz及其谐波 (100Hz, 150Hz, ...)，直到接近奈奎斯特频率
            for freq in range(self.notch_freq, int(self.fs / 2), self.notch_freq):
                w0 = freq / (self.fs / 2)  # 归一化频率
                b, a = scipy_signal.iirnotch(w0, self.notch_q)
                self.notch_filters.append((b, a))

                zi = scipy_signal.lfilter_zi(b, a)
                self.zi_notch.append(np.tile(zi[:, np.newaxis], (1, self.num_channels)))

    def reset(self):
        """重置滤波器状态"""
        if not self.enabled:
            return
        self._init_filters()
        log("[滤波器] 状态已重置")

    def filter_frame(self, uv_data: list) -> list:
        """
        滤波单帧数据 (16通道)

        参数:
            uv_data: 16通道的μV数据列表 [ch0, ch1, ..., ch15]

        返回:
            滤波后的数据列表
        """
        if not self.enabled or not HAS_SCIPY:
            return uv_data

        # 转换为numpy数组 (1, num_channels)
        data = np.array(uv_data, dtype=np.float64).reshape(1, -1)

        # 应用带通滤波（单一带通滤波器）
        if self.enable_bandpass and self.b_bandpass is not None:
            data, self.zi_bandpass = scipy_signal.lfilter(
                self.b_bandpass, self.a_bandpass, data, axis=0, zi=self.zi_bandpass
            )

        # 应用工频陷波
        if self.enable_notch and self.notch_filters:
            for i, (b, a) in enumerate(self.notch_filters):
                data, self.zi_notch[i] = scipy_signal.lfilter(
                    b, a, data, axis=0, zi=self.zi_notch[i]
                )

        return data.flatten().tolist()

    def filter_batch(self, uv_data_batch: list) -> list:
        """
        滤波批量数据 (多帧)

        参数:
            uv_data_batch: 多帧数据 [[ch0, ch1, ...], [ch0, ch1, ...], ...]

        返回:
            滤波后的数据列表
        """
        if not self.enabled or not HAS_SCIPY:
            return uv_data_batch

        # 转换为numpy数组 (num_frames, num_channels)
        data = np.array(uv_data_batch, dtype=np.float64)

        # 应用带通滤波（单一带通滤波器）
        if self.enable_bandpass and self.b_bandpass is not None:
            data, self.zi_bandpass = scipy_signal.lfilter(
                self.b_bandpass, self.a_bandpass, data, axis=0, zi=self.zi_bandpass
            )

        # 应用工频陷波
        if self.enable_notch and self.notch_filters:
            for i, (b, a) in enumerate(self.notch_filters):
                data, self.zi_notch[i] = scipy_signal.lfilter(
                    b, a, data, axis=0, zi=self.zi_notch[i]
                )

        return data.tolist()


# ================= 全局滤波器实例 =================
# 设备1和设备2各自独立的滤波器
emg_filter_dev1 = None
emg_filter_dev2 = None

def init_filters():
    """初始化全局滤波器"""
    global emg_filter_dev1, emg_filter_dev2

    if not FILTER_ENABLED:
        log("[滤波器] 滤波功能已禁用")
        return

    if not HAS_SCIPY:
        log("[滤波器] scipy未安装，无法初始化滤波器")
        return

    # 【修正】使用BLE实际传输频率250Hz，而不是ADC采样率2kHz
    emg_filter_dev1 = EMGRealtimeFilter(
        fs=BLE_SAMPLE_RATE,  # 250Hz
        num_channels=16,
        enable_bandpass=FILTER_BANDPASS_ENABLED,
        enable_notch=FILTER_NOTCH_ENABLED
    )

    emg_filter_dev2 = EMGRealtimeFilter(
        fs=BLE_SAMPLE_RATE,  # 250Hz
        num_channels=16,
        enable_bandpass=FILTER_BANDPASS_ENABLED,
        enable_notch=FILTER_NOTCH_ENABLED
    )

    log(f"[滤波器] 双设备滤波器初始化完成 (fs={BLE_SAMPLE_RATE}Hz)")

# ================= 连接配置 =================
CONNECT_TIMEOUT = 20.0
CONNECT_SCAN_TIMEOUT = 6.0
SCAN_TIMEOUT = 3.0
MAX_RETRIES = 2
RETRY_DELAY = 1.0

# ================= 批量发送配置 =================
BATCH_INTERVAL = 0.005  # 5ms
RAW_DRAIN_LIMIT_PER_TICK = 100

# ================= 数据超时检测 =================
DATA_TIMEOUT = 3.0  # 3秒无数据则认为设备停止发送

# ================= 优先级 =================
PRIORITY_CONTROL = 0   # 控制命令（最高优先级）
PRIORITY_HIGH = 1      # 控制响应
PRIORITY_LOW = 2       # 传感器数据


# ================= 单设备状态类 =================
@dataclass
class DeviceState:
    """单个 BLE 设备的状态"""
    device_id: int

    client: Optional[BleakClient] = None
    device: Any = None
    mac: Optional[str] = None
    name: Optional[str] = None
    rssi: Optional[int] = None

    is_streaming: bool = False
    total_frames: int = 0
    lost_frames: int = 0
    last_frame_index: int = -1
    last_packet_counter: int = -1  # 上一包 counters，用于检测 BLE 丢包
    packet_counter_base: Optional[int] = None
    # 固件包计数器复位（重启/回绕）后累加的续接偏移，保证 frame_id 全程单调
    packet_counter_offset: int = 0
    # 采样计数时间轴：(样本序号 n_ref, 该样本对应的墙钟 t_ref)。
    # 帧时间戳 = t_ref + (n - n_ref)/rate，只允许往后推，见 _counter_timeline()
    sample_clock_ref: Optional[tuple] = None
    last_emit_time: Optional[float] = None
    last_data_time: float = 0.0  # 【新增】最后收到数据的时间戳
    sd_filename: Optional[str] = None  # 【新增】当前采集的SD卡bin文件名前缀
    stream_mode: str = "idle"  # "idle" | "preview" | "collection" — 当前流模式

    config: Dict = field(default_factory=lambda: DEFAULT_CONFIG.copy())
    raw_buffer: deque = field(default_factory=lambda: deque(maxlen=1000))
    data_buffer: deque = field(default_factory=lambda: deque(maxlen=500))
    raw_dropped_packets: int = 0
    notification_epoch: int = 0
    connect_task: Any = None

    # ===== V2 新增: 设备状态字段 =====
    hw_version: str = "V1"                     # 硬件版本: "V1" 或 "V2"
    firmware_version: str = ""                  # 固件版本字符串 (STATUS_CHAR)
    hardware_version: str = ""                  # 硬件版本字符串 (STATUS_CHAR)
    num_imus: int = 2                           # 检测到的 IMU 数量
    channel_map: List[int] = field(default_factory=lambda: CHANNELS_MAP_V1)
    status_flags: int = 0                       # 设备状态标志位
    storage_state: int = 0                      # SD 卡状态
    sd_free_kb: int = 0                         # SD 卡剩余空间
    battery_percent: int = 0                    # 电池百分比 (0-100)

    def reset_stats(self):
        self.total_frames = 0
        self.lost_frames = 0
        self.last_frame_index = -1
        self.last_packet_counter = -1
        self.packet_counter_base = None
        self.packet_counter_offset = 0
        self.sample_clock_ref = None
        self.last_emit_time = None
        self.raw_buffer.clear()
        self.data_buffer.clear()
        self.raw_dropped_packets = 0
        self.notification_epoch += 1
        self.sd_filename = None  # 【新增】重置SD卡文件名
        self.stream_mode = "idle"  # 【新增】重置流模式

        # 重置对应设备的滤波器状态
        if FILTER_ENABLED and HAS_SCIPY:
            emg_filter = emg_filter_dev1 if self.device_id == 1 else emg_filter_dev2
            if emg_filter:
                emg_filter.reset()
        # 【注意】hw_version / channel_map / num_imus 不重置，
        # 由连接时的 V1/V2 检测确定，reset_stats 不应改变版本判定
    
    def is_connected(self) -> bool:
        if self.client is None:
            return False
        try:
            # 显式转换为 bool，避免 _DeprecatedIsConnectedReturn 类型无法 JSON 序列化
            return bool(self.client.is_connected)
        except:
            return False
    
    def to_dict(self) -> dict:
        """转换为字典（用于状态响应）"""
        emg_config = self.get_emg_config()
        return {
            'connected': self.is_connected(),
            'mac': self.mac,
            'name': self.name,
            'rssi': self.rssi,
            'streaming': self.is_streaming,
            'total': self.total_frames,
            'lost': self.lost_frames,
            'hw_version': self.hw_version,
            'num_imus': self.num_imus,
            'firmware_version': self.firmware_version,
            'hardware_version': self.hardware_version,
            'stream_mode': self.stream_mode,
            'battery_percent': self.battery_percent,  # 新增电池百分比
            'gain': emg_config['gain'],
            'gain_index': emg_config['gain_index'],
            'emg_lsb_uv_24bit': emg_config['emg_lsb_uv_24bit'],
        }

    def get_emg_config(self) -> dict:
        """Return the effective EMG gain metadata used for HDF5 attributes."""
        gain = self.config.get('gain', DEFAULT_CONFIG['gain'])
        try:
            gain = float(gain)
        except (TypeError, ValueError):
            gain = float(DEFAULT_CONFIG['gain'])
        if gain <= 0:
            gain = float(DEFAULT_CONFIG['gain'])

        gain_index = self.config.get('gain_index', DEFAULT_CONFIG['gain_index'])
        try:
            gain_index = int(gain_index)
        except (TypeError, ValueError):
            gain_index = int(DEFAULT_CONFIG['gain_index'])

        return {
            'gain': gain,
            'gain_index': gain_index,
            'emg_lsb_uv_24bit': BASE_LSB_24BIT / (gain * HARDWARE_FRONTEND_GAIN),
        }


# ================= 全局状态 =================
class ServerState:
    def __init__(self):
        # WebSocket 客户端
        self.control_clients: Set = set()  # 控制端（可能多个）
        self.data_clients: Set = set()     # 数据端（可能多个）

        # 双设备
        self.dev1 = DeviceState(device_id=1)
        self.dev2 = DeviceState(device_id=2)

        # 扫描结果
        self.devices_found: Dict[str, Any] = {}
        self.scan_results: List[dict] = []
        self.connection_lock = asyncio.Lock()

        # 消息队列
        self.msg_queue = PriorityQueue()
        self.queue_seq = itertools.count()
        self.main_loop = None
        self.queue_task = None
        self.queue_limit = 1000
        self.queue_low_limit = 500
        self.queue_lock = threading.Lock()
        self.transport_fault_dropped = 0
        self.transport_fault_last_emit = 0.0

        # 数据发送线程
        self.data_thread = None
        self.stop_thread = False

        # 【新增】会话ID，用于SD卡文件命名
        self.session_id: str = ""  # 例如 "S001"
    
    def get_device(self, device_id: int) -> DeviceState:
        return self.dev1 if device_id == 1 else self.dev2
    
    def get_active_devices(self) -> List[int]:
        active = []
        if self.dev1.is_streaming:
            active.append(1)
        if self.dev2.is_streaming:
            active.append(2)
        return active
    
    def get_connected_devices(self) -> List[int]:
        connected = []
        if self.dev1.is_connected():
            connected.append(1)
        if self.dev2.is_connected():
            connected.append(2)
        return connected


state = ServerState()
_control_request_id = ContextVar('ble_control_request_id', default=None)


# ================= 工具函数 =================

def log(message: str):
    print(f"[BLE-Server] {message}", file=sys.stderr)


def calculate_lsb_uv(config: dict) -> float:
    lsb_uv = BASE_LSB_24BIT / (config['gain'] * HARDWARE_FRONTEND_GAIN)
    if config['is_16bit']:
        lsb_uv = lsb_uv * (2 ** config['shift'])
    return lsb_uv


def get_packet_params(config: dict) -> dict:
    bps = 2 if config['is_16bit'] else 3
    emg_len = config['frames_per_packet'] * 16 * bps
    imu_len = 36 if config['imu_enabled'] else 0
    return {
        'bps': bps,
        'emg_len': emg_len,
        'imu_len': imu_len,
        'total_len': 4 + emg_len + imu_len,
        'fpkt': config['frames_per_packet'],
    }


# ================= 数据解析 =================

def parse_imu_v1(data: bytearray, emg_len: int) -> list:
    """
    解析 V1 IMU 数据 (ICM-20948, 固定 2 个 IMU, 各 18 bytes)
    Accel/Gyro: Big Endian, Mag: Little Endian
    """
    imu_start = 4 + emg_len
    imu_len = 36  # 2 × 18
    imu_bytes = data[imu_start: imu_start + imu_len]

    def parse_chip(b):
        ag = struct.unpack('<6h', b[0:12])
        m = struct.unpack('<3h', b[12:18])
        return [
            [x * SCALE_ACCEL_V1 for x in ag[0:3]],
            [x * SCALE_GYRO for x in ag[3:6]],
            [x * SCALE_MAG for x in m[0:3]],
        ]

    return [
        parse_chip(imu_bytes[0:18]),
        parse_chip(imu_bytes[18:36]),
    ]


def parse_imu_v2(data: bytearray, emg_len: int, num_imus: int) -> list:
    """
    解析 V2 IMU 数据 (LSM6DSV32X, 可变 0-3 个 IMU, 各 18 bytes)
    Accel/Gyro: 全部 Little Endian, 无磁力计
    """
    imu_start = 4 + emg_len
    imus = []
    for i in range(num_imus):
        offset = imu_start + i * BYTES_PER_IMU
        b = data[offset: offset + BYTES_PER_IMU]
        ag = struct.unpack('<6h', b[0:12])       # V2: Little Endian
        imus.append([
            [x * SCALE_ACCEL for x in ag[0:3]],   # Accel X/Y/Z
            [x * SCALE_GYRO for x in ag[3:6]],    # Gyro X/Y/Z
        ])
    return imus


def parse_packet(data: bytearray, dev: DeviceState) -> Optional[dict]:
    params = get_packet_params(dev.config)

    emg_len = params['emg_len']
    payload_len = len(data) - 4

    # ===== 包长校验 (V1 固定 / V2 动态) =====
    if dev.hw_version == "V2":
        if payload_len < emg_len:
            log(f"[Dev{dev.device_id}] 包过短: {len(data)}, 期望至少 {4 + emg_len}")
            return None
        imu_byte_count = payload_len - emg_len
        if imu_byte_count % BYTES_PER_IMU != 0:
            log(f"[Dev{dev.device_id}] IMU 数据异常: {imu_byte_count} bytes (非 18 的倍数)")
            return None
        num_imus = imu_byte_count // BYTES_PER_IMU
        if num_imus > MAX_NUM_IMUS_V2:
            log(f"[Dev{dev.device_id}] IMU 数量超限: {num_imus} > {MAX_NUM_IMUS_V2}")
            return None
        if num_imus != dev.num_imus:
            dev.num_imus = num_imus
            log(f"[Dev{dev.device_id}] IMU 数量已更新: {num_imus}")
    else:
        if len(data) != params['total_len']:
            log(f"[Dev{dev.device_id}] 包长错误: {len(data)} != {params['total_len']}")
            return None
        num_imus = MAX_NUM_IMUS_V1  # V1 固定 2 个 IMU

    try:
        config = dev.config
        lsb_uv = calculate_lsb_uv(config)
        bps = params['bps']
        fpkt = params['fpkt']

        # 包头 4 字节是 ESP32 固件的 ble_frame_counter（包计数器），不是帧号
        # 每个 BLE 包包含 fpkt 个 250Hz EMG 帧，真实帧号 = 包号 × fpkt + 帧内偏移
        packet_counter = struct.unpack('<I', data[0:4])[0]
        if dev.packet_counter_base is None:
            dev.packet_counter_base = packet_counter
            dev.packet_counter_offset = 0
            log(f"[Dev{dev.device_id}] stream packet counter base: {dev.packet_counter_base}")
        elif packet_counter < dev.last_packet_counter:
            # 固件包计数器复位（重启/回绕）。绝不能像以前那样把 base 挪过去、
            # 让帧号从 0 重新开始：那会让写进 H5 的 frame_id / sd_frame_id 在会话
            # 中途倒退，后处理会把它当成时间回退去修（实测 38080→0 造出 19s 折叠）。
            # 这里只累加一个续接偏移，帧号继续往后走。
            jump = dev.last_packet_counter - packet_counter + 1
            dev.packet_counter_offset += jump
            log(f"[Dev{dev.device_id}] 包计数器复位 {dev.last_packet_counter}→{packet_counter}，"
                f"帧号续接 +{jump}（累计偏移 {dev.packet_counter_offset}）")
        relative_packet_counter = packet_counter - dev.packet_counter_base + dev.packet_counter_offset
        start_frame = relative_packet_counter * fpkt

        # ===== EMG 解析 (物理顺序) =====
        emg_raw = []
        emg_uv = []
        raw_bytes = data[4: 4 + emg_len]
        stride = 16 * bps

        for i in range(fpkt):
            offset = i * stride
            raw_row = []
            uv_row = []

            for ch in range(16):
                ch_offset = offset + ch * bps
                chunk = raw_bytes[ch_offset: ch_offset + bps]
                val = int.from_bytes(chunk, 'big', signed=True)
                raw_row.append(val)
                uv_row.append(val * lsb_uv)

            emg_raw.append(raw_row)
            emg_uv.append(uv_row)

        # ===== 通道映射 (对齐供应商上位机显示顺序) =====
        emg_raw_mapped = []
        emg_uv_mapped = []
        for row_raw, row_uv in zip(emg_raw, emg_uv):
            mapped_raw = [row_raw[i - 1] for i in dev.channel_map]
            mapped_uv = [row_uv[i - 1] for i in dev.channel_map]
            emg_raw_mapped.append(mapped_raw)
            emg_uv_mapped.append(mapped_uv)

        # ===== IMU 解析 (按版本分叉) =====
        imu = None
        if config['imu_enabled'] and num_imus > 0:
            if dev.hw_version == "V2":
                imu = parse_imu_v2(data, emg_len, num_imus)
            else:
                imu = parse_imu_v1(data, emg_len)

        dev.total_frames += fpkt

        # ===== 丢包检测：跟踪 packet_counter 连续性 =====
        if dev.last_packet_counter >= 0:
            expected_packet = dev.last_packet_counter + 1
            if packet_counter > expected_packet:
                lost_packets = packet_counter - expected_packet
                lost_frames_delta = lost_packets * fpkt
                dev.lost_frames += lost_frames_delta
                log(f"[Dev{dev.device_id}] BLE 丢包检测: packet_counter {expected_packet}→{packet_counter}, "
                    f"丢失 {lost_packets} 包 ({lost_frames_delta} 帧)")

        dev.last_packet_counter = packet_counter
        dev.last_frame_index = start_frame + fpkt - 1

        # ===== 生成每帧的BLE帧号 =====
        frame_ids = [start_frame + i for i in range(fpkt)]

        # ===== 应用滤波 =====
        emg_uv_filtered = emg_uv_mapped  # 默认使用已映射的原始数据

        if FILTER_ENABLED and HAS_SCIPY:
            emg_filter = emg_filter_dev1 if dev.device_id == 1 else emg_filter_dev2

            if emg_filter and emg_filter.enabled:
                try:
                    emg_uv_filtered = emg_filter.filter_batch(emg_uv_mapped)
                except Exception as e:
                    log(f"[Dev{dev.device_id}] 滤波错误: {e}")
                    emg_uv_filtered = emg_uv_mapped

        return {
            'f': start_frame,
            'packet_counter': packet_counter,  # 原始包号（诊断用）
            'n': fpkt,
            'frame_ids': frame_ids,
            'raw': emg_raw_mapped,
            'uv': emg_uv_filtered,
            'imu': imu,
            'num_imus': num_imus,
            'hw_version': dev.hw_version,
            's': [dev.total_frames, dev.lost_frames],
        }

    except Exception as e:
        log(f"[Dev{dev.device_id}] 解析错误: {e}")
        return None


# ================= BLE 回调 =================

# 【诊断】用于跟踪notification回调的调用情况
_last_callback_time = {}
_callback_interval_warning_printed = {}
_callback_interval_last_log = {}

# 【修复】高精度时间基准 — 解决 Windows time.time() 15ms 精度导致 BLE 帧时间戳回退
# time.time() 在 Windows 上分辨率约 15.6ms，而 BLE 通知每 4ms 到达一次，
# 导致连续 3~5 个包获得相同 time.time() 值 → 反推帧时间戳重叠/回退。
# 方案：用 time.perf_counter()（微秒精度）做相对计时，映射到 wall-clock 时间。
_time_base_wall = time.time()
_time_base_perf = time.perf_counter()
_time_base_lock = __import__('threading').Lock()


def _precise_time():
    """返回高精度 wall-clock 时间（微秒级精度）

    原理：perf_counter() 提供微秒级相对计时，映射到 time.time() 绝对时间基准。
    每隔 60 秒自动重新校准基准，消除可能的漂移。
    """
    global _time_base_wall, _time_base_perf
    now_perf = time.perf_counter()
    # 定期重新校准（60s），让 wall clock 基准保持在合理范围内
    if now_perf - _time_base_perf > 60.0:
        with _time_base_lock:
            # 双重检查
            if now_perf - _time_base_perf > 60.0:
                _time_base_wall = time.time()
                _time_base_perf = time.perf_counter()
    return _time_base_wall + (now_perf - _time_base_perf)


def reset_callback_timing(device_id: int):
    _last_callback_time.pop(device_id, None)
    _callback_interval_warning_printed.pop(device_id, None)
    _callback_interval_last_log.pop(device_id, None)


def create_status_handler(dev: DeviceState):
    """V2 设备状态通知回调 — 仅更新本地状态，不影响控制流"""

    def handler(sender: int, data: bytearray):
        try:
            if not data or len(data) < 1:
                return
            packet_type = data[0]

            expected_size = struct.calcsize(STATUS_SNAPSHOT_FORMAT)
            if packet_type == STATUS_PACKET_SNAPSHOT and len(data) >= expected_size:
                s = struct.unpack(STATUS_SNAPSHOT_FORMAT, data[:expected_size])
                # 同步 IMU 数量 (仅当固件上报值在有效范围内)
                fw_num_imus = s[6]
                if 0 <= fw_num_imus <= MAX_NUM_IMUS_V2:
                    if fw_num_imus != dev.num_imus:
                        log(f"[Dev{dev.device_id}] STATUS IMU 数量: {fw_num_imus}")
                    dev.num_imus = fw_num_imus
                dev.status_flags = s[7]
                dev.battery_percent = s[8]  # 解析电池百分比
                dev.storage_state = s[9]
                dev.sd_free_kb = s[10]
                dev.firmware_version = s[17].split(b'\x00')[0].decode('ascii', errors='ignore')
                dev.hardware_version = s[18].split(b'\x00')[0].decode('ascii', errors='ignore')

            elif packet_type == STATUS_PACKET_EVENT:
                # 事件记录（后续可扩展透传给前端用于诊断）
                pass

        except Exception as e:
            log(f"[Dev{dev.device_id}] 状态解析错误: {e}")

    return handler


def enqueue_raw_packet(dev: DeviceState, ts: float, data: bytearray):
    if len(dev.raw_buffer) >= dev.raw_buffer.maxlen:
        dev.raw_dropped_packets += 1
        _report_transport_drop(f'Dev{dev.device_id} 原始数据缓冲溢出')
    dev.raw_buffer.append((ts, bytes(data)))


def _counter_timeline(dev: DeviceState, start_frame: int, fpkt: int, arrival_ts: float):
    """按"采样计数"给出本包 fpkt 帧的时间戳，保证会话内严格单调递增。

    为什么不用"到达时刻往前反推"（旧行为 t = ts - (fpkt-1-i)/250）：
    一包 9 帧代表 36ms 的采样，但 BLE 通知是突发的 —— 两包可能几乎同时到达。
    按到达时刻反推会把整包 36ms 叠到前一包上，于是 H5 里出现整包量级的重叠
    （实测 L001 dev1 有 1713 处回退，最深倒回 54s）。包计数器才是采样时刻的
    唯一可信来源：丢包时它自己会跳，因此时间轴也跟着跳，不会压缩也不会重叠。

    规则（只会往后推，绝不拉早）：
      1) 时间轴 time(n) = t_ref + (n - n_ref)/rate；
      2) 若本包最后一帧的推算时刻早于到达时刻，说明时间轴落后于墙钟（丢包累积
         或主机时钟被校准过），把整条轴前移补齐 —— 保持与墙钟/相机的时间对齐；
      3) 最后强制第一帧不早于上一包最后一帧加一个采样间隔（计数器复位等异常兜底）。

    返回 fpkt 个时间戳（严格递增，步长恰为 1/rate）。
    """
    frame_interval = 1.0 / BLE_SAMPLE_RATE
    n_first = int(start_frame)
    n_last = n_first + fpkt - 1

    if dev.sample_clock_ref is None:
        # 会话第一包：把最后一个样本对齐到到达时刻
        dev.sample_clock_ref = (n_last, float(arrival_ts))
    n_ref, t_ref = dev.sample_clock_ref

    t_first = t_ref + (n_first - n_ref) * frame_interval
    t_last = t_ref + (n_last - n_ref) * frame_interval

    drift = arrival_ts - t_last
    if drift > 0:
        t_ref += drift
        t_first += drift
        t_last += drift

    if dev.last_emit_time is not None and t_first <= dev.last_emit_time:
        push = dev.last_emit_time + frame_interval - t_first
        t_ref += push
        t_first += push
        t_last += push

    dev.sample_clock_ref = (n_ref, t_ref)
    dev.last_emit_time = t_last
    return [t_first + i * frame_interval for i in range(fpkt)]


def finalize_parsed_packet(dev: DeviceState, parsed: dict, ts: float):
    parsed['t'] = ts

    if dev.total_frames % 100 == 0:
        log(f"[Dev{dev.device_id}] 已收到 {dev.total_frames} 帧, 丢帧: {dev.lost_frames}, "
            f"原始缓冲区: {len(dev.raw_buffer)}, 解析缓冲区: {len(dev.data_buffer)}, "
            f"原始丢弃: {dev.raw_dropped_packets}")

    fpkt = parsed.get('n', 9)
    emg_t = _counter_timeline(dev, parsed.get('f', 0), fpkt, ts)
    parsed['emg_t'] = emg_t

    if parsed.get('imu'):
        # IMU 行按包写入（每包每颗 IMU 一行），取本包最后一帧的时刻，
        # 与 EMG 同一条单调时间轴，避免 IMU 侧再出现墙钟回退
        parsed['imu_t'] = [emg_t[-1]] * len(parsed['imu'])

    if len(dev.data_buffer) >= dev.data_buffer.maxlen:
        _report_transport_drop(f'Dev{dev.device_id} 解析数据缓冲溢出')
    dev.data_buffer.append(parsed)


def drain_raw_packets(dev: DeviceState, limit: int = RAW_DRAIN_LIMIT_PER_TICK):
    processed = 0
    while dev.raw_buffer and processed < limit:
        ts, raw = dev.raw_buffer.popleft()
        parsed = parse_packet(raw, dev)
        if parsed:
            finalize_parsed_packet(dev, parsed, ts)
        processed += 1
    return processed


def clear_stream_buffers(dev: DeviceState):
    dev.raw_buffer.clear()
    dev.data_buffer.clear()
    dev.last_data_time = 0.0
    dev.notification_epoch += 1
    reset_callback_timing(dev.device_id)




# ================= 消息队列 =================

def create_notification_handler(dev: DeviceState):
    handler_epoch = dev.notification_epoch

    def handler(sender: int, data: bytearray):
        try:
            if handler_epoch != dev.notification_epoch:
                return
            ts = _precise_time()  # 高精度时间戳，避免 time.time() 15ms 精度导致回退
            device_key = dev.device_id

            if device_key in _last_callback_time:
                interval = ts - _last_callback_time[device_key]
                if interval > 0.1:
                    last_log = _callback_interval_last_log.get(device_key, 0)
                    if ts - last_log >= 1.0:
                        log(f"[Dev{dev.device_id}] 回调间隔异常: {interval*1000:.1f}ms (正常应<40ms)")
                        _callback_interval_last_log[device_key] = ts
            _last_callback_time[device_key] = ts

            dev.last_data_time = ts
            if dev.is_streaming:
                enqueue_raw_packet(dev, ts, data)
        except Exception as e:
            log(f"[Dev{dev.device_id}] 回调错误: {e}")
    return handler


def data_sender_thread():
    """数据发送线程 - 发送到数据端"""
    log("数据发送线程启动")
    send_count = 0
    last_log_time = time.time()

    # 【新增】超时警告标记，避免重复打印
    dev1_timeout_warned = False
    dev2_timeout_warned = False
    # 【新增】超时状态，用于发送空包
    dev1_timeout = False
    dev2_timeout = False

    while not state.stop_thread:
        try:
            now = time.time()

            if state.dev1.is_streaming:
                drain_raw_packets(state.dev1)
            else:
                clear_stream_buffers(state.dev1)

            if state.dev2.is_streaming:
                drain_raw_packets(state.dev2)
            else:
                clear_stream_buffers(state.dev2)

            # 【新增】检测数据超时
            if state.dev1.is_streaming and state.dev1.last_data_time > 0:
                if now - state.dev1.last_data_time > DATA_TIMEOUT:
                    dev1_timeout = True
                    if not dev1_timeout_warned:
                        log(f"[Dev1] ⚠️ 数据超时！已 {now - state.dev1.last_data_time:.1f} 秒未收到数据，将发送空包保持连接")
                        dev1_timeout_warned = True
                else:
                    dev1_timeout = False
                    dev1_timeout_warned = False
            else:
                dev1_timeout = False
                dev1_timeout_warned = False

            if state.dev2.is_streaming and state.dev2.last_data_time > 0:
                if now - state.dev2.last_data_time > DATA_TIMEOUT:
                    dev2_timeout = True
                    if not dev2_timeout_warned:
                        log(f"[Dev2] ⚠️ 数据超时！已 {now - state.dev2.last_data_time:.1f} 秒未收到数据，将发送空包保持连接")
                        dev2_timeout_warned = True
                else:
                    dev2_timeout = False
                    dev2_timeout_warned = False
            else:
                dev2_timeout = False
                dev2_timeout_warned = False

            active = state.get_active_devices()

            if state.data_clients and active:
                dev1_data = None
                dev2_data = None

                if state.dev1.is_streaming and state.dev1.data_buffer:
                    batch1 = []
                    while state.dev1.data_buffer and len(batch1) < 5:
                        batch1.append(state.dev1.data_buffer.popleft())
                    if batch1:
                        dev1_data = batch1 if len(batch1) > 1 else batch1[0]

                if state.dev2.is_streaming and state.dev2.data_buffer:
                    batch2 = []
                    while state.dev2.data_buffer and len(batch2) < 5:
                        batch2.append(state.dev2.data_buffer.popleft())
                    if batch2:
                        dev2_data = batch2 if len(batch2) > 1 else batch2[0]

                # 【修改】即使没有数据，如果设备处于超时状态也发送空包
                has_data = dev1_data is not None or dev2_data is not None
                has_timeout = dev1_timeout or dev2_timeout

                if has_data or has_timeout:
                    msg = {
                        'type': 'data',
                        'ts': time.time(),
                        'dev1': dev1_data,
                        'dev2': dev2_data,
                        'active': active,
                        'timeout': {  # 【新增】超时状态信息
                            'dev1': dev1_timeout,
                            'dev2': dev2_timeout
                        }
                    }
                    add_to_queue(PRIORITY_LOW, 'data', msg)
                    send_count += 1

            # 每5秒打印一次发送统计
            now = time.time()
            if now - last_log_time >= 5.0:
                if send_count > 0 or active:
                    timeout_info = ""
                    if dev1_timeout or dev2_timeout:
                        timeout_devs = []
                        if dev1_timeout:
                            timeout_devs.append("Dev1")
                        if dev2_timeout:
                            timeout_devs.append("Dev2")
                        timeout_info = f", 超时: {timeout_devs}"
                    log(f"[数据发送] 已发送 {send_count} 批数据, 数据端客户端: {len(state.data_clients)}, 活跃设备: {active}{timeout_info}")
                last_log_time = now
                send_count = 0

            time.sleep(BATCH_INTERVAL)
            
        except Exception as e:
            if not state.stop_thread:
                log(f"发送线程错误: {e}")
    
    log("数据发送线程结束")


def _schedule_queue_locked():
    if state.main_loop and not getattr(state, 'queue_wake_pending', False):
        state.queue_wake_pending = True
        try:
            state.main_loop.call_soon_threadsafe(_ensure_process_queue)
        except RuntimeError:
            state.queue_wake_pending = False


def _report_transport_drop(error):
    with state.queue_lock:
        _report_transport_drop_locked(error)


def _report_transport_drop_locked(error):
    state.transport_fault_dropped += 1
    now = time.monotonic()
    if now - state.transport_fault_last_emit >= 1.0 and state.msg_queue.qsize() < state.queue_limit:
        count = state.transport_fault_dropped
        state.transport_fault_dropped = 0
        state.transport_fault_last_emit = now
        state.msg_queue.put((PRIORITY_HIGH, next(state.queue_seq), 'broadcast', {
            'type': 'transport_fault', 'source': 'ble', 'error': error, 'dropped': count}, None))
        _schedule_queue_locked()


def add_to_queue(priority: int, msg_type: str, data: dict, target_ws=None):
    """Bound both the message queue and cross-thread loop wakeups."""
    with state.queue_lock:
        size = state.msg_queue.qsize()
        if priority == PRIORITY_LOW and size >= state.queue_low_limit:
            _report_transport_drop_locked('BLE发送队列数据溢出')
            return False
        if size >= state.queue_limit:
            log(f'发送队列已满，拒绝 {msg_type} 消息')
            if target_ws is not None and state.main_loop:
                state.main_loop.call_soon_threadsafe(
                    lambda: asyncio.create_task(target_ws.close(code=1013, reason='发送队列已满')))
            return False
        state.msg_queue.put((priority, next(state.queue_seq), msg_type, data, target_ws))
        _schedule_queue_locked()
    return True


def _ensure_process_queue():
    with state.queue_lock:
        state.queue_wake_pending = False
        if state.queue_task is None or state.queue_task.done():
            state.queue_task = asyncio.create_task(process_queue())


async def process_queue():
    """处理消息队列"""
    q = state.msg_queue
    
    try:
        while not q.empty():
            prio, seq, msg_type, data, target_ws = q.get_nowait()
            
            try:
                #payload = msgpack.packb(data)
                payload = json.dumps(data, ensure_ascii=False)
                
                if msg_type == 'control':
                    # 控制响应 -> 发送到控制端
                    targets = [target_ws] if target_ws else list(state.control_clients)
                    for ws in targets:
                        if ws:
                            try:
                                await asyncio.wait_for(ws.send(payload), timeout=1.0)
                            except Exception:
                                state.control_clients.discard(ws)
                
                elif msg_type == 'data':
                    # 数据 -> 发送到数据端
                    for ws in list(state.data_clients):
                        try:
                            await asyncio.wait_for(ws.send(payload), timeout=1.0)
                        except Exception:
                            state.data_clients.discard(ws)
                
                elif msg_type == 'broadcast':
                    # 广播 -> 发送到所有客户端
                    all_clients = list(state.control_clients) + list(state.data_clients)
                    for ws in all_clients:
                        try:
                            await asyncio.wait_for(ws.send(payload), timeout=1.0)
                        except Exception:
                            state.control_clients.discard(ws)
                            state.data_clients.discard(ws)
                            
            except Exception as e:
                log(f"发送错误: {e}")
                
    except Exception as e:
        log(f"队列处理错误: {e}")
    finally:
        state.queue_task = None
        if not state.stop_thread and not q.empty() and state.main_loop:
            _ensure_process_queue()


async def send_to_control(ws, action: str, data: dict):
    """发送响应到控制端"""
    msg = {'type': 'response', 'action': action, **data}
    request_id = _control_request_id.get()
    if request_id is not None:
        msg['request_id'] = request_id
    add_to_queue(PRIORITY_HIGH, 'control', msg, ws)


async def broadcast_event(event: str, data: dict):
    """广播事件到所有客户端"""
    msg = {'type': 'event', 'event': event, **data}
    add_to_queue(PRIORITY_HIGH, 'broadcast', msg)


# ================= BLE 操作 =================

async def scan_devices(ws):
    """扫描设备"""
    log(f"扫描设备（{SCAN_TIMEOUT}秒）...")
    
    try:
        state.devices_found.clear()
        state.scan_results.clear()
        
        devices = await BleakScanner.discover(
            timeout=SCAN_TIMEOUT,
            return_adv=True,
            scanning_mode="active"
        )
        
        targets = []
        seen_macs = set()
        
        for d, adv in devices.values():
            if d.address and d.address.upper() not in seen_macs:
                seen_macs.add(d.address.upper())

                display = f"{d.name} ({d.address})"
                state.devices_found[display] = d
                
                # 尝试获取 RSSI
                #rssi = getattr(d, 'rssi', None) or -100
                
                info = {
                    'name': d.name or adv.local_name or "未知设备",
                    'mac': d.address.upper(),
                    'display': display,
                    "rssi": adv.rssi if adv.rssi is not None else None,
                    "manufacturer": str(adv.manufacturer_data)[:50]
                }
                state.scan_results.append(info)
                
                # if d.name == TARGET_DEVICE_NAME:
                #     targets.append(info)
        
        # 按 RSSI 排序
        state.scan_results.sort(key=lambda x: x['rssi'], reverse=True)
        
        #log(f"找到 {len(state.scan_results)} 个设备，目标 {len(targets)} 个")
        log(f"找到 {len(state.scan_results)} 个设备")
        
        await send_to_control(ws, 'scan', {
            'success': True,
            'devices': state.scan_results,
            'count': len(state.scan_results),
            'targets': targets,
        })
        
    except Exception as e:
        log(f"扫描失败: {e}")
        await send_to_control(ws, 'scan', {
            'success': False,
            'error': str(e),
        })


async def send_control_command(dev: DeviceState, payload: bytes, timeout: float = 3.0):
    """V1/V2 统一的控制命令写入封装

    V2 设备使用 Write with Response + 超时保护（与 main_windows 原始逻辑一致）。
    V1 设备使用 Write without Response。

    注意：response=True 会阻塞事件循环最多 timeout 秒。V2 设备仅在连接后的
    初始配置（connect_device）和启停流（_do_start_stream）时调用，总共 2-4 次。
    这个阻塞量级在 04-55 工作日志中验证正常，不会导致 BLE 参数协商失败。
    真正导致 70% 丢包的是后来叠加上去的 retry+fallback 逻辑（每次 13s+）。
    """
    if dev.client is None or not dev.is_connected():
        raise RuntimeError(f"Dev{dev.device_id} not connected")

    if dev.hw_version != "V2":
        await dev.client.write_gatt_char(CONTROL_CHAR_UUID, payload, response=False)
        return

    try:
        await asyncio.wait_for(
            dev.client.write_gatt_char(CONTROL_CHAR_UUID, payload, response=True),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        # 设备响应慢但命令可能已生效，对 SET_FILENAME 做一次 without-response 兜底
        if payload and payload[0] == CMD_MAP['SET_FILENAME']:
            log(f"[Dev{dev.device_id}] SET_FILENAME response timeout; retry write without response")
            await asyncio.sleep(0.1)
            await dev.client.write_gatt_char(CONTROL_CHAR_UUID, payload, response=False)
        else:
            raise


async def refresh_device_for_connect(mac: str, fallback_device=None):
    """连接前刷新目标 BLEDevice，避免 Windows 使用旧扫描对象卡住。"""
    target = mac.upper()
    try:
        log(f"[BLE] 连接前刷新目标设备: {target} ({CONNECT_SCAN_TIMEOUT}s)")
        device = await BleakScanner.find_device_by_address(target, timeout=CONNECT_SCAN_TIMEOUT)
        if device:
            return device
    except Exception as e:
        log(f"[BLE] 连接前刷新目标设备失败: {e}")
    return fallback_device


async def connect_device(ws, device_id: int, mac_or_name: str):
    """连接设备"""
    dev = state.get_device(device_id)
    action = f'connect{device_id}'
    
    # 查找设备
    device = None
    rssi = None
    
    if mac_or_name in state.devices_found:
        device = state.devices_found[mac_or_name]
    else:
        mac_upper = mac_or_name.upper()
        for info in state.scan_results:
            if info['mac'] == mac_upper:
                device = state.devices_found.get(info['display'])
                rssi = info.get('rssi')
                break
        
        if device is None:
            for name, d in state.devices_found.items():
                if d.address.upper() == mac_upper:
                    device = d
                    break
    
    if device is None:
        log(f"[Dev{device_id}] 直接查找: {mac_or_name}")
        device = await BleakScanner.find_device_by_address(
            mac_or_name.upper(), timeout=5.0
        )
    
    if device is None:
        await send_to_control(ws, action, {
            'success': False,
            'device_id': device_id,
            'error': f"未找到设备: {mac_or_name}",
        })
        return
    
    mac = device.address.upper()
    log(f"[Dev{device_id}] 连接: {device.name} ({mac})")

    other_dev = state.dev2 if device_id == 1 else state.dev1
    if other_dev.mac and other_dev.mac.upper() == mac and other_dev.is_connected():
        log(f"[Dev{device_id}] 目标设备已挂在 Dev{other_dev.device_id}，先断开旧连接")
        await disconnect_device(ws, other_dev.device_id, silent=True)
        await asyncio.sleep(1.0)
    
    if dev.is_connected():
        await disconnect_device(ws, device_id, silent=True)
        # 【修复重连】等待 BLE 栈完全释放资源后再建新连接
        await asyncio.sleep(0.5)

    if state.connection_lock.locked():
        await send_to_control(ws, action, {
            'success': None,
            'device_id': device_id,
            'message': "等待蓝牙适配器空闲...",
            'mac': mac,
        })

    async with state.connection_lock:
        device = await refresh_device_for_connect(mac, fallback_device=device)
        if device is None:
            await send_to_control(ws, action, {
                'success': False,
                'device_id': device_id,
                'error': f"连接前无法重新发现设备 {mac}，请确认手环仍在广播",
                'mac': mac,
            })
            return

        for retry in range(MAX_RETRIES):
            client = None
            try:
                strategy = "BLEDevice" if retry == 0 else "address"
                await send_to_control(ws, action, {
                    'success': None,
                    'device_id': device_id,
                    'message': f"连接中 ({retry+1}/{MAX_RETRIES})，最长等待 {int(CONNECT_TIMEOUT)} 秒...",
                    'mac': mac,
                })
                log(f"[Dev{device_id}] GATT connect start: strategy={strategy}, timeout={CONNECT_TIMEOUT}s, retry={retry+1}/{MAX_RETRIES}")

                connect_target = device if retry == 0 else mac
                client = BleakClient(connect_target, timeout=CONNECT_TIMEOUT)
                await asyncio.wait_for(client.connect(), timeout=CONNECT_TIMEOUT)
            
                if client.is_connected:
                    dev.client = client
                    dev.device = device
                    dev.mac = mac
                    dev.name = device.name
                    dev.rssi = rssi
                    dev.reset_stats()

                    log(f"[Dev{device_id}] 连接成功: {mac}")

                    # ===================== V1/V2 检测 (方法A: STATUS_CHAR 特征) ======
                    # 必须在配置命令之前检测，以便配置正确的 channel_map 和 num_imus
                    try:
                        await dev.client.start_notify(
                            STATUS_CHAR_UUID,
                            create_status_handler(dev)
                        )
                        dev.hw_version = "V2"
                        dev.channel_map = CHANNELS_MAP_V2
                        dev.num_imus = 0  # 等待 Snapshot 更新实际值
                        log(f"[Dev{device_id}] 检测到 V2 设备，已订阅状态通知")
                    except Exception as e:
                        dev.hw_version = "V1"
                        dev.channel_map = CHANNELS_MAP_V1
                        dev.num_imus = MAX_NUM_IMUS_V1
                        log(f"[Dev{device_id}] V1 设备 (STATUS_CHAR 不可用: {e})")
                    # ===================== V1/V2 检测结束 =====================

                    # ===================== 连接成功后发送配置命令 =====================
                    try:
                        # 1. 发送采样率配置 (2kHz = 0x12)
                        sample_rate_cmd = bytes([CMD_MAP['2kHz']])
                        await send_control_command(dev, sample_rate_cmd)
                        log(f"[Dev{device_id}] 已发送采样率配置: 2kHz (0x12)")
                        await asyncio.sleep(0.1)  # 等待ESP32处理

                        # 2. 发送复合配置命令 (0xC0 + [gain_index, mode, shift, imu_en])
                        config = dev.config
                        config_cmd = bytes([
                            CMD_MAP['CONFIG'],
                            config['gain_index'],
                            0 if not config['is_16bit'] else 1,
                            config['shift'],
                            1 if config['imu_enabled'] else 0,
                        ])
                        await send_control_command(dev, config_cmd)
                        log(f"[Dev{device_id}] 已发送复合配置: Gain={config['gain_index']}, Mode={'16bit' if config['is_16bit'] else '24bit'}, Shift={config['shift']}, IMU={config['imu_enabled']}")
                        await asyncio.sleep(0.1)  # 等待ESP32处理

                    except Exception as e:
                        log(f"[Dev{device_id}] 配置命令发送失败: {e}")
                    # ===================== 配置命令结束 =====================

                    await send_to_control(ws, action, {
                        'success': True,
                        'device_id': device_id,
                        'mac': mac,
                        'name': device.name,
                        'rssi': rssi,
                        'hw_version': dev.hw_version,
                        'num_imus': dev.num_imus,
                        'firmware_version': dev.firmware_version,
                        'hardware_version': dev.hardware_version,
                        'battery_percent': dev.battery_percent,
                        'stream_mode': dev.stream_mode,
                        'connected': state.get_connected_devices(),
                    })

                    # 广播连接事件
                    await broadcast_event('device_connected', {
                        'device_id': device_id,
                        'mac': mac,
                        'name': device.name,
                        'hw_version': dev.hw_version,
                        'num_imus': dev.num_imus,
                    })
                    return
                
            except TimeoutError:
                log(f"[Dev{device_id}] 连接超时（strategy={strategy}, GATT connect 未在 {CONNECT_TIMEOUT}s 内返回）")
            except BleakError as e:
                log(f"[Dev{device_id}] BLE 错误 (strategy={strategy}): {e}")
            except Exception as e:
                log(f"[Dev{device_id}] 连接异常 (strategy={strategy}): {e}")

            try:
                if client and client.is_connected:
                    await client.disconnect()
                if dev.client and dev.client.is_connected:
                    await dev.client.disconnect()
            except Exception:
                pass
            dev.client = None

            if retry < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY)
    
    await send_to_control(ws, action, {
        'success': False,
        'device_id': device_id,
        'error': f"连接失败：蓝牙 GATT 连接超时或系统蓝牙栈无响应，请关闭手环电源重启/重新扫描后再试",
        'mac': mac,
    })


async def disconnect_device(ws, device_id: int, silent=False):
    """断开设备"""
    dev = state.get_device(device_id)
    action = f'disconnect{device_id}'
    mac = dev.mac

    try:
        if dev.is_streaming:
            await stop_stream(ws, device_id, silent=True)
            dev.stream_mode = "idle"

        if dev.client:
            try:
                await dev.client.disconnect()
            except:
                pass
            dev.client = None

        dev.device = None
        dev.mac = None
        dev.name = None
        dev.rssi = None
        dev.connect_task = None
        dev.sd_filename = None  # 【修复】断开连接时清除SD卡文件名

        # 重置 V2 字段到默认值
        dev.hw_version = "V1"
        dev.channel_map = CHANNELS_MAP_V1
        dev.num_imus = MAX_NUM_IMUS_V1
        dev.firmware_version = ""
        dev.hardware_version = ""
        dev.status_flags = 0
        dev.storage_state = 0
        dev.sd_free_kb = 0

        log(f"[Dev{device_id}] 已断开: {mac}")
        
        if not silent:
            await send_to_control(ws, action, {
                'success': True,
                'device_id': device_id,
                'mac': mac,
                'connected': state.get_connected_devices(),
            })
            
            await broadcast_event('device_disconnected', {
                'device_id': device_id,
                'mac': mac,
            })
            
    except Exception as e:
        log(f"[Dev{device_id}] 断开失败: {e}")
        if not silent:
            await send_to_control(ws, action, {
                'success': False,
                'device_id': device_id,
                'error': str(e),
            })


async def start_stream(ws, device_id: int):
    """开始采集"""
    dev = state.get_device(device_id)
    action = f'start{device_id}'

    if not dev.is_connected():
        await send_to_control(ws, action, {
            'success': False,
            'device_id': device_id,
            'error': "设备未连接",
        })
        return

    if dev.is_streaming:
        await send_to_control(ws, action, {
            'success': False,
            'device_id': device_id,
            'error': "已在采集中",
        })
        return

    try:
        dev.reset_stats()

        # ===================== 发送SD卡文件名命令 =====================
        # 格式: 0xD0 + "S001_L_20260312_143025" (最大31字节)
        # 生成文件名字符串: 会话ID + 左右手标识 + 时间戳
        now_str = datetime.now().strftime("%y%m%d_%H%M%S")  # 例如 "260312_143025" (6位年份节省空间)

        # 根据设备ID确定左右手标识: 设备1=左手(L), 设备2=右手(R)
        hand_label = "L" if device_id == 1 else "R"

        if state.session_id:
            # 有会话ID: "S001_L_260312_143025"
            filename_str = f"{state.session_id}_{hand_label}_{now_str}"
        else:
            # 无会话ID: "L_260312_143025"
            filename_str = f"{hand_label}_{now_str}"

        # 确保不超过31字节
        if len(filename_str) > 31:
            filename_str = filename_str[:31]

        filename_cmd = bytes([CMD_MAP['SET_FILENAME']]) + filename_str.encode('ascii')
        await send_control_command(dev, filename_cmd)
        log(f"[Dev{device_id}] 已发送SD卡文件名: {filename_str} ({'左手' if device_id == 1 else '右手'})")

        # 【新增】保存文件名到设备状态，用于后续传递给storage_server
        dev.sd_filename = filename_str

        await asyncio.sleep(0.1)  # 等待ESP32处理
        # ===================== SD卡文件名命令结束 =====================

        # 【重要】不再发送额外的配置命令，使用ESP32的默认配置
        # 供应商代码也是这样做的：只在用户点击"应用配置"时才发送配置命令
        # ESP32默认配置: 24-bit, 9帧/包, IMU启用; 上位机连接时会下发 gain=1

        dev.notification_epoch += 1
        handler = create_notification_handler(dev)
        reset_callback_timing(dev.device_id)
        await dev.client.start_notify(EMG_DATA_CHAR_UUID, handler)
        log(f"[Dev{device_id}] 已订阅数据通知")

        if dev.hw_version == "V2":
            await asyncio.sleep(0.25)  # V2 START_NOTIFY_SETTLE_DELAY_S

        await send_control_command(dev, bytes([CMD_MAP['START']]))
        log(f"[Dev{device_id}] 已发送 START 命令")

        dev.is_streaming = True

        await send_to_control(ws, action, {
            'success': True,
            'device_id': device_id,
            'active': state.get_active_devices(),
        })

        await broadcast_event('stream_started', {
            'device_id': device_id,
            'active': state.get_active_devices(),
        })

    except Exception as e:
        log(f"[Dev{device_id}] 启动失败: {e}")
        import traceback
        traceback.print_exc()
        await send_to_control(ws, action, {
            'success': False,
            'device_id': device_id,
            'error': str(e),
        })


async def stop_stream(ws, device_id: int, silent=False):
    """停止采集"""
    dev = state.get_device(device_id)
    action = f'stop{device_id}'
    
    if not dev.is_streaming:
        if not silent:
            await send_to_control(ws, action, {
                'success': False,
                'device_id': device_id,
                'error': "未在采集",
            })
        return
    
    try:
        if dev.client and dev.is_connected():
            await send_control_command(dev, bytes([CMD_MAP['STOP']]))
            log(f"[Dev{device_id}] 已发送 STOP")
            
            await dev.client.stop_notify(EMG_DATA_CHAR_UUID)
            log(f"[Dev{device_id}] 已取消订阅")
        
        dev.is_streaming = False
        clear_stream_buffers(dev)

        if not silent:
            await send_to_control(ws, action, {
                'success': True,
                'device_id': device_id,
                'total': dev.total_frames,
                'lost': dev.lost_frames,
                'active': state.get_active_devices(),
            })
            
            await broadcast_event('stream_stopped', {
                'device_id': device_id,
                'total': dev.total_frames,
                'lost': dev.lost_frames,
                'active': state.get_active_devices(),
            })
            
    except Exception as e:
        log(f"[Dev{device_id}] 停止失败: {e}")
        if not silent:
            await send_to_control(ws, action, {
                'success': False,
                'device_id': device_id,
                'error': str(e),
            })


def collect_device_configs() -> dict:
    """Collect per-device EMG metadata for HDF5 provenance."""
    configs = {}
    for dev_key, dev in (('dev1', state.dev1), ('dev2', state.dev2)):
        if dev.is_connected() or dev.name or dev.sd_filename:
            configs[dev_key] = dev.get_emg_config()
    return configs


async def start_all(ws):
    """同时开始"""
    started = []

    if state.dev1.is_connected() and not state.dev1.is_streaming:
        await start_stream(ws, 1)
        if state.dev1.is_streaming:
            started.append(1)

    if state.dev2.is_connected() and not state.dev2.is_streaming:
        await start_stream(ws, 2)
        if state.dev2.is_streaming:
            started.append(2)

    # 【新增】收集当前采集的SD卡bin文件名
    sd_filenames = {}
    if state.dev1.sd_filename:
        sd_filenames['dev1'] = state.dev1.sd_filename  # 例如 "S001_L_260312_143025"
    if state.dev2.sd_filename:
        sd_filenames['dev2'] = state.dev2.sd_filename  # 例如 "S001_R_260312_143025"

    # 【新增】收集BLE设备名称（用于H5文件追溯数据来源）
    device_names = {}
    if state.dev1.name:
        device_names['dev1'] = state.dev1.name  # 例如 "WristBand_3A76"
    if state.dev2.name:
        device_names['dev2'] = state.dev2.name  # 例如 "WristBand_5B12"

    device_configs = collect_device_configs()

    await send_to_control(ws, 'start_all', {
        'success': True,
        'started': started,
        'active': state.get_active_devices(),
        'sd_filenames': sd_filenames,  # 【新增】返回bin文件名
        'device_names': device_names,  # 【新增】返回BLE设备名称
        'device_configs': device_configs,
    })

    # 【新增】广播bin文件名和设备名称事件给数据端（realtimeEngine）
    # 旧 API (start_all) 无法确定 stream_mode，标记为 "legacy"
    if sd_filenames or device_names:
        await broadcast_event('sd_filenames_updated', {
            'sd_filenames': sd_filenames,
            'device_names': device_names,  # 【新增】BLE设备名称
            'device_configs': device_configs,
            'stream_mode': 'legacy',  # 旧 API 无法区分 preview/collection
        })


async def stop_all(ws):
    """同时停止"""
    stopped = []
    
    if state.dev1.is_streaming:
        await stop_stream(ws, 1, silent=True)
        stopped.append(1)
    
    if state.dev2.is_streaming:
        await stop_stream(ws, 2, silent=True)
        stopped.append(2)
    
    await send_to_control(ws, 'stop_all', {
        'success': True,
        'stopped': stopped,
        'active': state.get_active_devices(),
        'stats': {
            'dev1': {'total': state.dev1.total_frames, 'lost': state.dev1.lost_frames},
            'dev2': {'total': state.dev2.total_frames, 'lost': state.dev2.lost_frames},
        }
    })


# ================= Preview / Collection 流管理 =================

def _build_stream_filename(dev, prefix_hint=None):
    """构建 stream 的 bin 文件名前缀，区分 preview / collection。

    Args:
        dev: DeviceState
        prefix_hint: "PREVIEW" | "COLLECT" | None (自动从 stream_mode 推断)

    Returns:
        str: 文件名前缀，如 "S001_L_260601_143025" 或 "PREVIEW_L_260601_143025"
    """
    now_str = datetime.now().strftime("%y%m%d_%H%M%S")
    hand_label = "L" if dev.device_id == 1 else "R"

    if prefix_hint is None:
        prefix_hint = "PREVIEW" if dev.stream_mode == "preview" else "COLLECT"

    if prefix_hint == "PREVIEW":
        # preview bin: PREVIEW_{hand}_{timestamp}
        return f"{PREVIEW_FILENAME_PREFIX}_{hand_label}_{now_str}"
    elif state.session_id:
        # collection bin with session id: S001_L_260601_143025
        return f"{state.session_id}_{hand_label}_{now_str}"
    else:
        # collection bin without session id: COLLECT_L_260601_143025
        return f"{COLLECTION_FILENAME_PREFIX}_{hand_label}_{now_str}"


async def _do_start_stream_for_device(dev, filename_str):
    """对单个设备执行: TIMESTAMP → delay → subscribe → START 的底层逻辑。

    Returns:
        bool: 成功返回 True
    """
    try:
        # 0. 【修复重连 0 数据】先发送 STOP 重置设备状态，再走正常启流流程。
        # 重连场景下设备可能还处于上次会话的 streaming 状态，直接发 START 会被忽略。
        # 用 response=False 快速发送，不阻塞流程。
        try:
            await dev.client.write_gatt_char(CONTROL_CHAR_UUID, bytes([CMD_MAP['STOP']]), response=False)
        except Exception:
            pass  # 设备可能未在 streaming，忽略错误

        # 1. 发送 TIMESTAMP（SD 卡文件名）
        filename_bytes = filename_str.encode('ascii')
        if len(filename_bytes) > 31:
            filename_bytes = filename_bytes[:31]
        filename_cmd = bytes([CMD_MAP['SET_FILENAME']]) + filename_bytes
        await send_control_command(dev, filename_cmd)
        log(f"[Dev{dev.device_id}] TIMESTAMP 已发送: {filename_str}")

        # 2. 等待 ESP32 处理 TIMESTAMP
        await asyncio.sleep(TIMESTAMP_TO_START_DELAY_MS / 1000.0)

        # 3. 订阅 EMG 数据通知
        # 【修复】先设 is_streaming=True 再创建 handler，阻止 data_sender_thread
        # 反复调用 clear_stream_buffers() 递增 notification_epoch 导致 handler 失效。
        # 之前 handler_epoch 在 create_notification_handler 时捕获，但 start_notify/
        # sleep/send_control_command 都是 async，期间 is_streaming=False 让
        # clear_stream_buffers 被调用数百次，epoch 远超 handler_epoch，所有 BLE
        # 通知被静默丢弃 → 前端 0 信号。
        dev.is_streaming = True
        handler = create_notification_handler(dev)
        reset_callback_timing(dev.device_id)
        await dev.client.start_notify(EMG_DATA_CHAR_UUID, handler)
        log(f"[Dev{dev.device_id}] EMG 数据通知已订阅")

        # 4. V2 额外 settle delay
        if dev.hw_version == "V2":
            await asyncio.sleep(0.25)

        # 5. 发送 START 命令
        await send_control_command(dev, bytes([CMD_MAP['START']]))
        log(f"[Dev{dev.device_id}] START 命令已发送")

        dev.sd_filename = filename_str
        return True

    except Exception as e:
        log(f"[Dev{dev.device_id}] 启动 stream 失败: {e}")
        import traceback
        traceback.print_exc()
        # 失败时确保 is_streaming 回滚，防止 data_sender_thread 在无效状态下持续运行
        dev.is_streaming = False
        return False


async def _do_stop_stream_for_device(dev):
    """对单个设备执行: STOP → unsubscribe 的底层逻辑。"""
    try:
        if dev.is_streaming and dev.client and dev.is_connected():
            await send_control_command(dev, bytes([CMD_MAP['STOP']]))
            log(f"[Dev{dev.device_id}] STOP 命令已发送")
            try:
                await dev.client.stop_notify(EMG_DATA_CHAR_UUID)
            except Exception:
                pass
        dev.is_streaming = False
        clear_stream_buffers(dev)
    except Exception as e:
        log(f"[Dev{dev.device_id}] 停止 stream 失败: {e}")
        dev.is_streaming = False
        clear_stream_buffers(dev)


async def start_preview_stream(ws, device_id=None):
    """启动 preview stream。

    对指定设备（或所有已连接设备）发送 TIMESTAMP(preview) + START。
    preview bin 文件名含 PREVIEW_ 前缀，不参与 H5 同步。
    """
    devices_to_start = []
    if device_id is not None:
        dev = state.get_device(device_id)
        if dev.is_connected() and not dev.is_streaming:
            devices_to_start.append(dev)
    else:
        for did in [1, 2]:
            dev = state.get_device(did)
            if dev.is_connected() and not dev.is_streaming:
                devices_to_start.append(dev)

    if not devices_to_start:
        device_status = {
            f'dev{did}': {
                'connected': state.get_device(did).is_connected(),
                'streaming': state.get_device(did).is_streaming,
                'stream_mode': state.get_device(did).stream_mode,
                'name': state.get_device(did).name,
            }
            for did in [1, 2]
        }
        log(f"[preview] 没有需要启动 preview 的设备: {device_status}")
        if ws:
            has_connected = any(info['connected'] for info in device_status.values())
            await send_to_control(ws, 'start_preview_stream', {
                'success': False,
                'started': [],
                'stream_mode': 'preview',
                'device_status': device_status,
                'error': '没有已连接设备' if not has_connected else '设备已全部在采集中',
            })
        return

    started_ids = []
    errors = {}
    for dev in devices_to_start:
        dev.reset_stats()
        dev.stream_mode = "preview"
        filename_str = _build_stream_filename(dev, prefix_hint="PREVIEW")
        ok = await _do_start_stream_for_device(dev, filename_str)
        if ok:
            started_ids.append(dev.device_id)
            log(f"[preview] Dev{dev.device_id} preview stream 已启动: {filename_str}")
        else:
            # 【修复】失败时回滚 stream_mode，避免卡在 preview 状态
            dev.stream_mode = "idle"
            errors[f'dev{dev.device_id}'] = '启动 stream 失败，请检查设备连接和蓝牙状态'

    if ws:
        await send_to_control(ws, 'start_preview_stream', {
            'success': bool(started_ids),
            'started': started_ids,
            'stream_mode': 'preview',
            'errors': errors if errors else None,
        })


async def stop_preview_stream(ws, device_id=None, silent=False):
    """停止 preview stream。"""
    devices_to_stop = []
    if device_id is not None:
        dev = state.get_device(device_id)
        if dev.stream_mode == "preview" and dev.is_streaming:
            devices_to_stop.append(dev)
    else:
        for did in [1, 2]:
            dev = state.get_device(did)
            if dev.stream_mode == "preview" and dev.is_streaming:
                devices_to_stop.append(dev)

    stopped_ids = []
    for dev in devices_to_stop:
        await _do_stop_stream_for_device(dev)
        dev.stream_mode = "idle"
        stopped_ids.append(dev.device_id)
        log(f"[preview] Dev{dev.device_id} preview stream 已停止")

    if ws and not silent:
        await send_to_control(ws, 'stop_preview_stream', {
            'success': True,
            'stopped': stopped_ids,
            'stream_mode': 'preview',
        })


async def stop_collection_stream(ws, device_id=None, silent=False):
    """停止 collection stream。"""
    devices_to_stop = []
    if device_id is not None:
        dev = state.get_device(device_id)
        if dev.stream_mode == "collection" and dev.is_streaming:
            devices_to_stop.append(dev)
    else:
        for did in [1, 2]:
            dev = state.get_device(did)
            if dev.stream_mode == "collection" and dev.is_streaming:
                devices_to_stop.append(dev)

    stopped_ids = []
    sd_filenames = {}
    for dev in devices_to_stop:
        sd_filenames[f'dev{dev.device_id}'] = dev.sd_filename
        await _do_stop_stream_for_device(dev)
        dev.stream_mode = "idle"
        stopped_ids.append(dev.device_id)
        log(f"[collection] Dev{dev.device_id} collection stream 已停止: {dev.sd_filename}")

    # 等待 ESP32 sd_write_task drain + close bin
    log(f"[collection] 等待 {STREAM_SWITCH_DELAY_MS}ms 让 ESP32 关闭 bin...")
    await asyncio.sleep(STREAM_SWITCH_DELAY_MS / 1000.0)

    if ws and not silent:
        await send_to_control(ws, 'stop_collection_stream', {
            'success': True,
            'stopped': stopped_ids,
            'sd_filenames': sd_filenames,
            'stream_mode': 'collection',
        })

    # 广播 collection_stopped 事件
    await broadcast_event('collection_stopped', {
        'stopped': stopped_ids,
        'sd_filenames': sd_filenames,
    })


async def switch_preview_to_collection(ws):
    """核心：将 preview stream 切换为 collection stream。

    时序:
    1. 停止所有 preview stream
    2. 等待 STREAM_SWITCH_DELAY_MS（让 ESP32 关闭 preview bin）
    3. 发送 collection TIMESTAMP 给每个已连接设备
    4. 等待 TIMESTAMP_TO_START_DELAY_MS
    5. 发送 START（collection stream）
    6. 返回 collection bin 文件名

    Returns:
        通过 send_to_control 返回 {success, collection_bins: {dev1, dev2}, started: [...]}
    """
    action = 'switch_preview_to_collection'
    log("=" * 50)
    log(f"[switch] === preview → collection 切换开始 ===")
    log("=" * 50)

    connected_ids = state.get_connected_devices()
    if not connected_ids:
        await send_to_control(ws, action, {
            'success': False,
            'error': '没有已连接的设备',
        })
        return

    # ---- Phase 1: 停止所有活跃 stream ----
    log("[switch] Phase 1: 停止活跃 stream...")
    any_was_streaming = False
    for did in connected_ids:
        dev = state.get_device(did)
        if dev.is_streaming:
            await _do_stop_stream_for_device(dev)
            dev.stream_mode = "idle"
            any_was_streaming = True
            log(f"[switch] Dev{did} 已发送 STOP")
        else:
            log(f"[switch] Dev{did} 已 idle，跳过 STOP")

    # ---- Phase 2: 等待 ESP32 关闭 bin（仅当确实有活跃 stream 时） ----
    skipped_delay_when_idle = not any_was_streaming
    if any_was_streaming:
        delay_s = STREAM_SWITCH_DELAY_MS / 1000.0
        log(f"[switch] Phase 2: 等待 {STREAM_SWITCH_DELAY_MS}ms (ESP32 关闭 bin)...")
        await asyncio.sleep(delay_s)
    else:
        log(f"[switch] Phase 2: SKIP — 所有设备已 idle，无需等待 {STREAM_SWITCH_DELAY_MS}ms")

    # ---- Phase 3: 启动 collection stream ----
    log("[switch] Phase 3: 启动 collection stream...")
    collection_bins = {}
    started_ids = []
    device_names = {}

    for did in connected_ids:
        dev = state.get_device(did)
        if not dev.is_connected():
            log(f"[switch] Dev{did} 已断开，跳过")
            continue

        dev.reset_stats()
        dev.stream_mode = "collection"

        # 生成 collection bin 文件名（含 session_id，不含 PREVIEW_ 前缀）
        filename_str = _build_stream_filename(dev, prefix_hint="COLLECT")
        ok = await _do_start_stream_for_device(dev, filename_str)
        if ok:
            started_ids.append(did)
            collection_bins[f'dev{did}'] = filename_str
            if dev.name:
                device_names[f'dev{did}'] = dev.name
            log(f"[switch] Dev{did} collection stream 已启动: {filename_str}")

    if not started_ids:
        await send_to_control(ws, action, {
            'success': False,
            'error': '所有设备启动 collection stream 失败',
        })
        return

    log("=" * 50)
    log(f"[switch] === preview → collection 切换完成 ===")
    log(f"[switch] collection bins: {collection_bins}")
    log("=" * 50)

    # 生成 collection_stream_id（ISO timestamp，前端和 realtimeEngine 共用）
    collection_stream_id = datetime.now().isoformat()

    # ---- Phase 4: 返回结果 + 广播事件 ----
    await send_to_control(ws, action, {
        'success': True,
        'started': started_ids,
        'collection_bins': collection_bins,
        'device_names': device_names,
        'device_configs': collect_device_configs(),
        'stream_mode': 'collection',
        'collection_stream_id': collection_stream_id,
        'switch_delay_ms': STREAM_SWITCH_DELAY_MS,
        'timestamp_to_start_delay_ms': TIMESTAMP_TO_START_DELAY_MS,
        'skipped_delay_when_idle': skipped_delay_when_idle,
    })

    # 广播 collection stream 的 sd_filenames（realtimeEngine 监听此事件，作为兜底）
    await broadcast_event('sd_filenames_updated', {
        'sd_filenames': collection_bins,
        'device_names': device_names,
        'device_configs': collect_device_configs(),
        'stream_mode': 'collection',
        'collection_stream_id': collection_stream_id,
        'switch_delay_ms': STREAM_SWITCH_DELAY_MS,
    })


async def switch_collection_to_preview(ws):
    """核心：将 collection stream 切换回 preview stream。

    时序:
    1. 停止所有 collection stream
    2. 等待 STREAM_SWITCH_DELAY_MS
    3. 发送 preview TIMESTAMP
    4. 等待 TIMESTAMP_TO_START_DELAY_MS
    5. 发送 START（preview stream）
    """
    action = 'switch_collection_to_preview'
    log("=" * 50)
    log(f"[switch] === collection → preview 切换开始 ===")
    log("=" * 50)

    connected_ids = state.get_connected_devices()
    if not connected_ids:
        await send_to_control(ws, action, {
            'success': False,
            'error': '没有已连接的设备',
        })
        return

    # ---- Phase 1: 停止所有 collection stream ----
    log("[switch] Phase 1: 停止 collection stream...")
    for did in connected_ids:
        dev = state.get_device(did)
        if dev.is_streaming:
            await _do_stop_stream_for_device(dev)
            dev.stream_mode = "idle"
            log(f"[switch] Dev{did} 已发送 STOP")

    # ---- Phase 2: 等待 ESP32 关闭 collection bin ----
    delay_s = STREAM_SWITCH_DELAY_MS / 1000.0
    log(f"[switch] Phase 2: 等待 {STREAM_SWITCH_DELAY_MS}ms (ESP32 关闭 collection bin)...")
    await asyncio.sleep(delay_s)

    # ---- Phase 3: 启动 preview stream ----
    log("[switch] Phase 3: 启动 preview stream...")
    started_ids = []

    for did in connected_ids:
        dev = state.get_device(did)
        if not dev.is_connected():
            log(f"[switch] Dev{did} 已断开，跳过")
            continue

        dev.reset_stats()
        dev.stream_mode = "preview"

        # preview bin 文件名含 PREVIEW_ 前缀
        filename_str = _build_stream_filename(dev, prefix_hint="PREVIEW")
        ok = await _do_start_stream_for_device(dev, filename_str)
        if ok:
            started_ids.append(did)
            log(f"[switch] Dev{did} preview stream 已启动: {filename_str}")

    log("=" * 50)
    log(f"[switch] === collection → preview 切换完成 ===")
    log("=" * 50)

    await send_to_control(ws, action, {
        'success': True,
        'started': started_ids,
        'stream_mode': 'preview',
    })


async def stop_any_stream(ws, device_id=None, silent=False):
    """停止任意 stream（preview 或 collection），不区分模式。

    用于：返回首页、断开连接等场景。
    """
    devices_to_stop = []
    if device_id is not None:
        dev = state.get_device(device_id)
        if dev.is_streaming:
            devices_to_stop.append(dev)
    else:
        for did in [1, 2]:
            dev = state.get_device(did)
            if dev.is_streaming:
                devices_to_stop.append(dev)

    stopped_ids = []
    for dev in devices_to_stop:
        old_mode = dev.stream_mode
        await _do_stop_stream_for_device(dev)
        dev.stream_mode = "idle"
        stopped_ids.append(dev.device_id)
        log(f"[stop_any] Dev{dev.device_id} stream 已停止 (was: {old_mode})")

    if ws and not silent:
        await send_to_control(ws, 'stop_any_stream', {
            'success': True,
            'stopped': stopped_ids,
        })


async def get_status(ws):
    """获取状态"""
    await send_to_control(ws, 'status', {
        'dev1': state.dev1.to_dict(),
        'dev2': state.dev2.to_dict(),
        'connected': state.get_connected_devices(),
        'active': state.get_active_devices(),
        'control_clients': len(state.control_clients),
        'data_clients': len(state.data_clients),
    })


# ================= WebSocket 处理 =================

async def handle_control_client(websocket):
    """处理控制端客户端（index.html）"""
    state.control_clients.add(websocket)
    log(f"[控制端] 客户端已连接 (总数: {len(state.control_clients)})")

    try:
        # 发送当前状态
        await send_to_control(websocket, 'welcome', {
            'message': '控制端已连接',
            'dev1': state.dev1.to_dict(),
            'dev2': state.dev2.to_dict(),
            'connected': state.get_connected_devices(),
            'active': state.get_active_devices(),
        })
    except Exception:
        # 发送欢迎消息失败，连接可能已断开
        state.control_clients.discard(websocket)
        return

    try:
        async for message in websocket:
            try:
                if isinstance(message, bytes):
                    data = msgpack.unpackb(message)
                else:
                    data = json.loads(message)

                _control_request_id.set(data.get('request_id'))
                action = data.get('action', '')
                # 不打印 status 命令，减少日志噪音
                if action != 'status':
                    log(f"[控制端] 命令: {action}")
                
                # 扫描
                if action == 'scan':
                    if state.connection_lock.locked():
                        await send_to_control(websocket, 'scan', {
                            'success': False,
                            'error': '蓝牙设备正在连接中，请等待连接完成或失败后再扫描',
                            'devices': state.scan_results,
                            'count': len(state.scan_results),
                        })
                    else:
                        await scan_devices(websocket)
                
                # 设备1
                elif action == 'connect1':
                    target = data.get('mac') or data.get('display')
                    if target:
                        if state.dev1.connect_task and not state.dev1.connect_task.done():
                            await send_to_control(websocket, 'connect1', {
                                'success': False, 'device_id': 1, 'error': "连接中"
                            })
                        else:
                            state.dev1.connect_task = asyncio.create_task(
                                connect_device(websocket, 1, target)
                            )
                    else:
                        await send_to_control(websocket, 'connect1', {
                            'success': False, 'device_id': 1, 'error': "请提供 mac"
                        })
                
                elif action == 'disconnect1':
                    await disconnect_device(websocket, 1)
                
                elif action == 'start1':
                    await start_stream(websocket, 1)
                
                elif action == 'stop1':
                    await stop_stream(websocket, 1)
                
                # 设备2
                elif action == 'connect2':
                    target = data.get('mac') or data.get('display')
                    if target:
                        if state.dev2.connect_task and not state.dev2.connect_task.done():
                            await send_to_control(websocket, 'connect2', {
                                'success': False, 'device_id': 2, 'error': "连接中"
                            })
                        else:
                            state.dev2.connect_task = asyncio.create_task(
                                connect_device(websocket, 2, target)
                            )
                    else:
                        await send_to_control(websocket, 'connect2', {
                            'success': False, 'device_id': 2, 'error': "请提供 mac"
                        })
                
                elif action == 'disconnect2':
                    await disconnect_device(websocket, 2)
                
                elif action == 'start2':
                    await start_stream(websocket, 2)
                
                elif action == 'stop2':
                    await stop_stream(websocket, 2)
                
                # 全局
                elif action == 'start_all':
                    await start_all(websocket)
                
                elif action == 'stop_all':
                    await stop_all(websocket)

                # 【新增】Preview / Collection 流管理命令
                elif action == 'start_preview_stream':
                    await start_preview_stream(websocket)

                elif action == 'start_preview_stream_single':
                    device_id = data.get('device_id', 1)
                    await start_preview_stream(websocket, device_id=device_id)

                elif action == 'stop_preview_stream':
                    await stop_preview_stream(websocket)

                elif action == 'stop_preview_stream_single':
                    device_id = data.get('device_id', 1)
                    await stop_preview_stream(websocket, device_id=device_id)

                elif action == 'start_collection_stream':
                    # 直接启动 collection stream（不经过 preview→collection 切换）
                    # 用于设备已 idle 且需要直接进入 collection 的场景
                    connected_ids = state.get_connected_devices()
                    if not connected_ids:
                        await send_to_control(websocket, 'start_collection_stream', {
                            'success': False, 'error': '没有已连接的设备',
                        })
                    else:
                        collection_bins = {}
                        started = []
                        for did in connected_ids:
                            dev = state.get_device(did)
                            if dev.is_connected() and not dev.is_streaming:
                                dev.reset_stats()
                                dev.stream_mode = "collection"
                                fn = _build_stream_filename(dev, prefix_hint="COLLECT")
                                if await _do_start_stream_for_device(dev, fn):
                                    started.append(did)
                                    collection_bins[f'dev{did}'] = fn
                        await send_to_control(websocket, 'start_collection_stream', {
                            'success': len(started) > 0,
                            'started': started,
                            'collection_bins': collection_bins,
                            'device_configs': collect_device_configs(),
                            'stream_mode': 'collection',
                        })
                        if collection_bins:
                            await broadcast_event('sd_filenames_updated', {
                                'sd_filenames': collection_bins,
                                'device_configs': collect_device_configs(),
                                'stream_mode': 'collection',
                            })

                elif action == 'stop_collection_stream':
                    await stop_collection_stream(websocket)

                elif action == 'stop_collection_stream_single':
                    device_id = data.get('device_id', 1)
                    await stop_collection_stream(websocket, device_id=device_id)

                elif action == 'switch_preview_to_collection':
                    # 核心：preview → collection 切流
                    await switch_preview_to_collection(websocket)

                elif action == 'switch_collection_to_preview':
                    # 核心：collection → preview 切流
                    await switch_collection_to_preview(websocket)

                elif action == 'stop_any_stream':
                    # 停止任意活跃流（用于返回首页/断开连接）
                    await stop_any_stream(websocket)

                elif action == 'stop_any_stream_single':
                    device_id = data.get('device_id', 1)
                    await stop_any_stream(websocket, device_id=device_id)

                elif action == 'status':
                    await get_status(websocket)

                # 【新增】设置会话ID
                elif action == 'set_session_id':
                    session_id = data.get('session_id', '')
                    # 验证会话ID格式（只允许字母、数字、下划线，最大10字符）
                    if session_id:
                        # 清理非法字符
                        clean_id = ''.join(c for c in session_id if c.isalnum() or c == '_')
                        if len(clean_id) > 10:
                            clean_id = clean_id[:10]
                        state.session_id = clean_id
                        log(f"[控制端] 会话ID已设置: {state.session_id}")
                        await send_to_control(websocket, 'set_session_id', {
                            'success': True,
                            'session_id': state.session_id,
                        })
                    else:
                        state.session_id = ""
                        log(f"[控制端] 会话ID已清空")
                        await send_to_control(websocket, 'set_session_id', {
                            'success': True,
                            'session_id': "",
                        })

                else:
                    await send_to_control(websocket, 'error', {
                        'error': f"未知命令: {action}"
                    })
                    
            except Exception as e:
                log(f"[控制端] 处理错误: {e}")
                traceback.print_exc()
                await send_to_control(websocket, 'error', {'error': str(e)})
                
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        state.control_clients.discard(websocket)
        log(f"[控制端] 客户端断开 (剩余: {len(state.control_clients)})")


async def handle_data_client(websocket):
    """处理数据端客户端（realtimeEngine.js）"""
    state.data_clients.add(websocket)
    log(f"[数据端] 客户端已连接 (总数: {len(state.data_clients)})")

    # 发送欢迎消息
    welcome = {
        'type': 'welcome',
        'message': '数据端已连接',
        'active': state.get_active_devices(),
        'connected': state.get_connected_devices(),
    }
    try:
        await websocket.send(json.dumps(welcome, ensure_ascii=False))
    except Exception as e:
        # 发送失败，连接可能已断开
        log(f"[数据端] 发送欢迎消息失败: {e}")
        state.data_clients.discard(websocket)
        return

    try:
        # 数据端主要是接收数据，但也可以接收简单命令
        async for message in websocket:
            try:
                if isinstance(message, bytes):
                    data = msgpack.unpackb(message)
                else:
                    data = json.loads(message)

                action = data.get('action', '')
                
                # 数据端只支持状态查询
                if action == 'status':
                    status = {
                        'type': 'status',
                        'active': state.get_active_devices(),
                        'connected': state.get_connected_devices(),
                        'dev1': state.dev1.to_dict(),
                        'dev2': state.dev2.to_dict(),
                    }
                    #await websocket.send(msgpack.packb(status))
                    await websocket.send(json.dumps(status, ensure_ascii=False))
                    
            except Exception as e:
                log(f"[数据端] 处理错误: {e}")
                
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        state.data_clients.discard(websocket)
        log(f"[数据端] 客户端断开 (剩余: {len(state.data_clients)})")


# ================= 主函数 =================

async def warmup_ble_adapter():
    """预热蓝牙适配器 - 解决首次扫描失败的问题"""
    log("预热蓝牙适配器...")
    try:
        # 进行一次快速扫描来初始化Windows蓝牙后端
        await BleakScanner.discover(timeout=2.0)
        log("蓝牙适配器预热完成")
    except Exception as e:
        log(f"蓝牙适配器预热警告: {e} (可忽略)")


async def heartbeat_task():
    """每30秒打印一次心跳，证明服务还活着"""
    while True:
        await asyncio.sleep(30)
        dev1_status = "采集中" if state.dev1.is_streaming else ("已连接" if state.dev1.client and state.dev1.client.is_connected else "未连接")
        dev2_status = "采集中" if state.dev2.is_streaming else ("已连接" if state.dev2.client and state.dev2.client.is_connected else "未连接")
        log(f"[心跳] 服务运行中 | 设备1: {dev1_status} | 设备2: {dev2_status}")


async def main():
    state.main_loop = asyncio.get_running_loop()

    # 预热蓝牙适配器（解决首次扫描失败问题）
    await warmup_ble_adapter()

    # 初始化滤波器
    init_filters()
    
    # 启动数据发送线程
    state.stop_thread = False
    state.data_thread = threading.Thread(target=data_sender_thread, daemon=True)
    state.data_thread.start()
    
    log("=" * 60)
    log("BLE Server (Dual Device + Dual WebSocket) 已启动")
    log("=" * 60)
    log(f"控制端口: ws://{WEBSOCKET_HOST}:{CONTROL_PORT} (index.html)")
    log(f"数据端口: ws://{WEBSOCKET_HOST}:{DATA_PORT} (realtimeEngine.js)")
    log(f"目标设备: {TARGET_DEVICE_NAME}")
    log(f"滤波功能: {'启用' if FILTER_ENABLED and HAS_SCIPY else '禁用'}")
    if FILTER_ENABLED and HAS_SCIPY:
        log(f"  - 带通滤波: {FILTER_LOWCUT}-{FILTER_HIGHCUT}Hz")
        log(f"  - 工频陷波: {FILTER_NOTCH_FREQ}Hz (Q={FILTER_NOTCH_Q})")
    log("=" * 60)
    log("控制命令:")
    log("  scan, connect1/2, disconnect1/2")
    log("  start1/2, stop1/2, start_all, stop_all")
    log("  status")
    log("=" * 60)

    try:
        # 创建一个静默的logger来抑制握手失败的错误日志
        import logging
        ws_logger = logging.getLogger('websockets')
        ws_logger.setLevel(logging.ERROR)  # 只显示ERROR级别，过滤掉握手失败的WARNING

        # 启动两个 WebSocket 服务器
        control_server = await websockets.serve(
            handle_control_client,
            WEBSOCKET_HOST,
            CONTROL_PORT,
            max_size=1 * 1024 * 1024,
            logger=ws_logger,
        )

        data_server = await websockets.serve(
            handle_data_client,
            WEBSOCKET_HOST,
            DATA_PORT,
            max_size=10 * 1024 * 1024,
            logger=ws_logger,
        )

        log("服务器启动完成，等待连接...")

        # 启动心跳任务
        asyncio.create_task(heartbeat_task())

        await asyncio.Future()  # 永久运行
        
    finally:
        state.stop_thread = True
        if state.data_thread:
            state.data_thread.join(timeout=2.0)
        if state.queue_task:
            state.queue_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await state.queue_task
        log("服务已停止")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("用户中断")
    except Exception as e:
        log(f"启动失败: {e}")
        traceback.print_exc()
