#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
calibrate_tool.py - H5数据可视化与滤波工具

功能：
- 读取H5文件中的EMG和IMU原始数据
- 使用与ble_server.py相同的滤波方法处理EMG数据
- 可视化EMG（16通道）和IMU（加速度3通道）数据
- 支持滑块拖动查看不同时间段的数据
"""

import sys
import os
import time
import h5py
import numpy as np
from scipy import signal as scipy_signal

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False
from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QPushButton, QFileDialog, QSlider, QSpinBox, QGroupBox,
    QSplitter, QComboBox, QCheckBox, QMessageBox, QScrollArea
)
from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtGui import QImage, QPixmap
import matplotlib
matplotlib.use('Qt5Agg')

# 设置中文字体支持
import matplotlib.pyplot as plt
plt.rcParams['font.sans-serif'] = ['SimHei', 'Microsoft YaHei', 'Arial Unicode MS', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False  # 解决负号显示问题

from matplotlib.backends.backend_qt5agg import FigureCanvasQTAgg as FigureCanvas
from matplotlib.backends.backend_qt5agg import NavigationToolbar2QT as NavigationToolbar
from matplotlib.figure import Figure
from matplotlib.lines import Line2D
try:
    from video_timeline import VideoTimeline
except ImportError:  # 作为独立脚本运行时的兼容路径
    from tools.video_timeline import VideoTimeline


# ============== EMG滤波参数（对齐供应商 wband_emg_V3）==============
# LSB: 优先使用 H5 dataset attr lsb_uv；无 attr 时用供应商基准值
BASE_LSB_24BIT_VENDOR = 0.476837    # 供应商固件: 4.0V ref / 2^23 * 1e6 (μV)
BASE_LSB_24BIT_LEGACY = 0.2861      # 旧版 ble_server: 2.4V ref（仅 fallback）
HARDWARE_FRONTEND_GAIN = 10         # 硬件前端增益（供应商固件固定）
DEFAULT_GAIN = 1                    # 默认增益
SAMPLE_RATE = 2000                  # EMG采样率 2kHz (同步后的SD卡数据)
SAMPLE_RATE_BLE = 250               # BLE传输采样率 250Hz

# 窗口默认：对齐供应商 5 秒视图
WINDOW_2KHZ = 10000                 # 2kHz 下 5 秒
WINDOW_250HZ = 1250                 # 250Hz 下 5 秒

# 滤波器参数（对齐供应商 signalfilter.py 离线参数）
FILTER_LOWCUT = 20                  # 带通下限 (Hz)
FILTER_HIGHCUT = 100                # 带通上限 (Hz)
FILTER_NOTCH_FREQ = 50              # 工频频率 (Hz)
FILTER_NOTCH_Q_OFFLINE = 50         # 离线陷波 Q 值（供应商 q_offline=50）
FILTER_NOTCH_Q_ONLINE = 15          # 在线陷波 Q 值（供应商 q_online=15）

# IMU 缩放系数
SCALE_ACCEL = 32.0 / 32768.0       # V2 LSM6DSV32X +/-32g, matches ble_server.py
SCALE_GYRO = 70.0 / 1000.0         # Supplier update: 0.07 dps/LSB
SCALE_MAG = 0.15                   # 磁力计 μT


def calculate_lsb_uv(gain=DEFAULT_GAIN, is_16bit=False, shift=4, base_lsb=None):
    """计算ADC原始值到μV的转换系数。base_lsb 为 None 时使用供应商默认值。"""
    if base_lsb is None:
        base_lsb = BASE_LSB_24BIT_VENDOR
    lsb_uv = base_lsb / (gain * HARDWARE_FRONTEND_GAIN)
    if is_16bit:
        lsb_uv = lsb_uv * (2 ** shift)
    return lsb_uv


class EMGFilter:
    """EMG信号滤波器（对齐供应商 signalfilter.py 离线参数：Q=50, filtfilt）"""

    def __init__(self, sample_rate=SAMPLE_RATE, num_channels=16, notch_q=FILTER_NOTCH_Q_OFFLINE):
        self.sample_rate = sample_rate
        self.num_channels = num_channels
        self.notch_q = notch_q

        # 设计带通滤波器 (20-100Hz, 4th-order Butterworth)
        nyq = sample_rate / 2
        low = FILTER_LOWCUT / nyq
        high = FILTER_HIGHCUT / nyq
        low = max(0.001, min(low, 0.99))
        high = max(low + 0.001, min(high, 0.99))
        self.b_bandpass, self.a_bandpass = scipy_signal.butter(4, [low, high], btype='band')

        # 设计工频陷波滤波器 (50Hz及其谐波，Q 对齐供应商离线值)
        self.notch_filters = []
        for harmonic in range(1, 4):  # 50Hz, 100Hz, 150Hz
            freq = FILTER_NOTCH_FREQ * harmonic
            if freq < nyq:
                b, a = scipy_signal.iirnotch(freq, self.notch_q, sample_rate)
                self.notch_filters.append((b, a))

    def filter(self, data):
        """
        对EMG数据进行滤波

        Args:
            data: numpy array, shape (N, 16) 或 (N,) 单通道

        Returns:
            滤波后的数据，shape与输入相同
        """
        if data.ndim == 1:
            data = data.reshape(-1, 1)

        filtered = data.copy().astype(np.float64)

        # 应用带通滤波
        filtered = scipy_signal.filtfilt(self.b_bandpass, self.a_bandpass, filtered, axis=0)

        # 应用工频陷波
        for b, a in self.notch_filters:
            filtered = scipy_signal.filtfilt(b, a, filtered, axis=0)

        return filtered


class CalibrateWidget(QWidget):
    """H5数据可视化控件 — 可嵌入其他应用"""

    def __init__(self, parent=None):
        super().__init__(parent)

        # 数据存储
        self.h5_file = None
        self.h5_path = None
        self.emg1_data = None
        self.emg2_data = None
        # EMG remains lazy: keep HDF5 datasets and read only the visible
        # window.  The legacy ``*_data`` attributes stay for callers that
        # inspect them, but are intentionally left None for large files.
        self.emg1_dataset = None
        self.emg2_dataset = None
        self.emg1_length = 0
        self.emg2_length = 0
        self.emg1_start_time = None
        self.emg2_start_time = None
        self.emg1_time_axis = None
        self.emg2_time_axis = None
        self.emg1_has_time = False
        self.emg2_has_time = False
        self.imu1a_data = None
        self.imu1b_data = None
        self.imu1c_data = None
        self.imu2a_data = None
        self.imu2b_data = None
        self.imu2c_data = None

        # IMU 角速度数据 (gyr) — 供应商风格显示
        self.imu1a_gyr_data = None
        self.imu1b_gyr_data = None
        self.imu1c_gyr_data = None
        self.imu2a_gyr_data = None
        self.imu2b_gyr_data = None
        self.imu2c_gyr_data = None

        # IMU 时间数组 (用于窗口对齐)
        self.imu1a_time = None
        self.imu1b_time = None
        self.imu1c_time = None
        self.imu2a_time = None
        self.imu2b_time = None
        self.imu2c_time = None

        # IMU 数量（2 或 3），从 H5 attrs 或 all_ble 推断
        self.imu1_imu_count = 2
        self.imu2_imu_count = 2

        # IMU 通道详情（用于标题栏展示 BLE / Sync 通道信息）
        self._imu_dev1_ble_channels = []
        self._imu_dev1_sync_channels = []
        self._imu_dev2_ble_channels = []
        self._imu_dev2_sync_channels = []

        # IMU 供应商风格堆叠参数
        self.imu_acc_offset = 4.0       # Acc offset (g)
        self.imu_gyr_offset = 600.0     # Gyr offset (deg/s)

        # 视频预览相关
        self.video_caps = {}            # {'left': cv2.VideoCapture, 'right': cv2.VideoCapture}
        self.video_fps = {}             # {'left': fps, 'right': fps}
        self.video_first_frame_unix = {}  # {'left': unix_ts, 'right': unix_ts}
        self.video_last_frame_unix = {}   # {'left': unix_ts, 'right': unix_ts}
        self.video_duration = {}        # {'left': dur_sec, 'right': dur_sec}
        self.video_frame_count = {}     # {'left': n_frames, 'right': n_frames}
        self.video_timelines = {}       # {'left': VideoTimeline, 'right': VideoTimeline}
        # 旧 AVI 的头部可能把 30fps 写成 600fps。OpenCV 对这类文件按帧号
        # 随机 seek 会落到错误位置，需要按校正后的时间轴并带预滚量定位。
        self.video_seek_preroll = {}    # {'left': n_frames, 'right': n_frames}
        self.video_enabled = False      # 是否有可用的视频
        self._video_current_frame = {'left': None, 'right': None}   # 当前显示的 QPixmap
        self._video_current_idx = {'left': -1, 'right': -1}         # 当前帧索引
        self._last_video_update = 0     # 上次视频更新时间戳
        self._video_update_throttle_drag = 0.15   # 拖动时节流间隔 (秒)
        self._video_update_throttle_static = 0.033 # 静止时更新间隔（对齐视频 30fps）
        self.video_label_height = 200   # 视频预览区域高度

        # 精确对齐标定偏移量（从 H5 attrs 读取，无标定时默认 0）
        self.calib_offset = {}          # {'left': offset_sec, 'right': offset_sec}
        self.calib_present = False      # 是否有标定数据

        # Prompt标签数据
        self.prompt_names = None
        self.prompt_times = None  # 相对时间（秒）
        self.current_prompt_idx = 0  # 当前prompt索引
        self.emg_start_time = None  # EMG数据起始时间戳
        self.session_start_unix = None  # 统一会话起始时间（Python时钟，来自H5 attrs start_time）

        # 滤波器（对齐供应商离线 Q=50）
        self.emg_filter_2k = EMGFilter(sample_rate=2000, notch_q=FILTER_NOTCH_Q_OFFLINE)
        self.emg_filter_250 = EMGFilter(sample_rate=250, notch_q=FILTER_NOTCH_Q_OFFLINE)

        # LSB 系数（加载数据后从 H5 attrs 读取，默认使用供应商值）
        self.emg1_lsb_uv = calculate_lsb_uv()
        self.emg2_lsb_uv = calculate_lsb_uv()

        # 显示参数
        self.window_size = WINDOW_2KHZ  # 默认 5s@2kHz，加载后根据数据源调整
        self.current_pos = 0            # 当前位置

        # 供应商风格视图参数
        self.view_mode = 'stacked'       # 'stacked' (供应商) / 'subplot' (独立子图)
        self.offset_uv = 300             # 通道堆叠 offset (μV)
        self.clamp_enabled = True        # 是否裁剪波形防止重叠（默认开启）

        # 滑块平滑更新相关
        self.update_timer = QTimer()
        self.update_timer.setSingleShot(True)
        self.update_timer.timeout.connect(self._do_update_plots)
        self.pending_update = False
        self.is_dragging = False  # 是否正在拖动滑块

        # 降采样参数：拖动时限制绘图点数以提升流畅度
        self.max_plot_points_fast = 800
        self.max_plot_points_normal = 2500

        # 视频 2s 预览相关
        self.is_playing = False           # 是否正在播放 2s 预览
        self._preview_side = None         # 当前预览的视频侧 ('left' / 'right')
        self._preview_stop_frame = 0      # 预览停止帧
        self._preview_fps = 30.0          # 预览帧率
        self._preview_current_frame = 0   # 当前预览帧号
        self._preview_start_frame = 0     # 本次预览起始帧
        self._preview_started_monotonic = 0.0
        self._preview_duration_seconds = 2.0
        self._preview_rendered_frames = 0
        self.playback_timer = QTimer()
        self.playback_timer.setTimerType(Qt.PreciseTimer)
        self.playback_timer.timeout.connect(self._on_playback_tick)

        # 完整播放控制
        self.is_full_playing = False       # 是否正在完整播放
        self.full_playback_timer = QTimer()
        self.full_playback_timer.timeout.connect(self._on_full_playback_tick)
        self._full_playback_speed = 1.0    # 播放速度倍率 (1.0 = 实时)
        self._show_position_line = False   # 逐帧步进时也显示位置红线

        self.init_ui()

    def _active_emg_sample_rate(self):
        if self.emg1_length > 0 and self.emg1_sample_rate:
            return self.emg1_sample_rate
        if self.emg2_length > 0 and self.emg2_sample_rate:
            return self.emg2_sample_rate
        return 2000

    def _relative_sensor_time(self, times):
        times = np.asarray(times, dtype=np.float64)
        reference = self._ref_time()
        if reference is None or len(times) == 0:
            return times
        if self._time_axis_is_absolute(times):
            return times - float(reference)
        return times

    def init_ui(self):
        """初始化UI"""
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)

        # === 顶部控制栏 ===
        control_widget = QWidget()
        control_layout = QHBoxLayout(control_widget)
        control_layout.setContentsMargins(0, 0, 0, 0)

        # 文件选择
        self.btn_open = QPushButton('打开H5文件')
        self.btn_open.clicked.connect(self.open_file)
        control_layout.addWidget(self.btn_open)

        self.lbl_file = QLabel('未选择文件')
        self.lbl_file.setStyleSheet('color: #666; font-style: italic;')
        control_layout.addWidget(self.lbl_file)
        self.lbl_status = QLabel('')
        self.lbl_status.setStyleSheet('color: #666; font-size: 9px;')
        control_layout.addWidget(self.lbl_status)

        control_layout.addStretch()

        # 显示模式
        control_layout.addWidget(QLabel('显示:'))
        self.combo_view_mode = QComboBox()
        self.combo_view_mode.addItems(['供应商堆叠', '分通道子图'])
        self.combo_view_mode.blockSignals(True)
        self.combo_view_mode.setCurrentIndex(0 if self.view_mode == 'stacked' else 1)
        self.combo_view_mode.blockSignals(False)
        self.combo_view_mode.currentIndexChanged.connect(self.on_view_mode_changed)
        control_layout.addWidget(self.combo_view_mode)

        # Offset (堆叠视图)
        control_layout.addWidget(QLabel('Offset(uV):'))
        self.spin_offset = QSpinBox()
        self.spin_offset.setRange(50, 5000)
        self.spin_offset.setSingleStep(50)
        self.spin_offset.setValue(self.offset_uv)
        self.spin_offset.valueChanged.connect(self.on_offset_changed)
        control_layout.addWidget(self.spin_offset)

        # Clamp
        self.chk_clamp = QCheckBox('Clamp')
        self.chk_clamp.setChecked(self.clamp_enabled)
        self.chk_clamp.stateChanged.connect(self.on_clamp_changed)
        control_layout.addWidget(self.chk_clamp)

        # 窗口大小
        control_layout.addWidget(QLabel(' 窗口:'))
        self.spin_window = QSpinBox()
        self.spin_window.setRange(100, 50000)
        self.spin_window.setValue(self.window_size)
        self.spin_window.setSingleStep(1000)
        self.spin_window.valueChanged.connect(self.on_window_changed)
        control_layout.addWidget(self.spin_window)
        self.lbl_window_sec = QLabel('')
        control_layout.addWidget(self.lbl_window_sec)

        # 滤波开关
        self.chk_filter = QCheckBox('滤波')
        self.chk_filter.setChecked(True)
        self.chk_filter.stateChanged.connect(self.update_plots)
        control_layout.addWidget(self.chk_filter)

        # Prompt跳转 — 上下布局，避免被挤掉
        control_layout.addWidget(QLabel('  |  '))
        prompt_widget = QWidget()
        prompt_layout = QVBoxLayout(prompt_widget)
        prompt_layout.setContentsMargins(0, 0, 0, 0)
        prompt_layout.setSpacing(4)

        # 上方：Prompt 名称（独占一行，不被按钮遮挡）
        self.lbl_prompt_info = QLabel('Prompt: -/-')
        self.lbl_prompt_info.setAlignment(Qt.AlignCenter)
        self.lbl_prompt_info.setStyleSheet(
            'font-size: 13px; font-weight: bold; color: #333;'
            'padding: 4px 10px; background-color: #f0f0f0; border-radius: 6px;'
        )
        prompt_layout.addWidget(self.lbl_prompt_info)

        # 下方：按钮左右并排
        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        prompt_btn_style = (
            'QPushButton {'
            '  font-size: 18px; padding: 8px 16px;'
            '  border-radius: 8px; border: none;'
            '}'
            'QPushButton:enabled {'
            '  color: #fff;'
            '}'
            'QPushButton:disabled {'
            '  color: #aaa; background-color: #e0e0e0;'
            '}'
        )
        self.btn_prev_prompt = QPushButton('⏮')
        self.btn_prev_prompt.clicked.connect(self.goto_prev_prompt)
        self.btn_prev_prompt.setEnabled(False)
        self.btn_prev_prompt.setStyleSheet(
            prompt_btn_style +
            'QPushButton:enabled { background-color: #6c5ce7; }'
            'QPushButton:enabled:hover { background-color: #5a4bd1; }'
            'QPushButton:enabled:pressed { background-color: #4a3db5; }'
        )
        btn_row.addWidget(self.btn_prev_prompt)

        self.btn_next_prompt = QPushButton('⏭')
        self.btn_next_prompt.clicked.connect(self.goto_next_prompt)
        self.btn_next_prompt.setEnabled(False)
        self.btn_next_prompt.setStyleSheet(
            prompt_btn_style +
            'QPushButton:enabled { background-color: #00b894; }'
            'QPushButton:enabled:hover { background-color: #00a381; }'
            'QPushButton:enabled:pressed { background-color: #008f6b; }'
        )
        btn_row.addWidget(self.btn_next_prompt)
        prompt_layout.addLayout(btn_row)

        control_layout.addWidget(prompt_widget)

        # === 完整播放控制按钮 ===
        control_layout.addWidget(QLabel('  |  '))
        playback_widget = QWidget()
        playback_layout = QHBoxLayout(playback_widget)
        playback_layout.setContentsMargins(0, 0, 0, 0)
        playback_layout.setSpacing(4)

        playback_btn_style = (
            'QPushButton {'
            '  font-size: 18px; padding: 4px 6px;'
            '  border-radius: 6px; border: none;'
            '  color: #fff;'
            '}'
        )

        self.btn_reset = QPushButton('⏮')
        self.btn_reset.setFixedWidth(36)
        self.btn_reset.setToolTip('回到数据起始位置')
        self.btn_reset.clicked.connect(self.reset_progress)
        self.btn_reset.setStyleSheet(
            playback_btn_style +
            'QPushButton { background-color: #636e72; }'
        )
        playback_layout.addWidget(self.btn_reset)

        self.btn_play = QPushButton('▶')
        self.btn_play.setFixedWidth(36)
        self.btn_play.setToolTip('从头完整播放 EMG/IMU 信号与视频')
        self.btn_play.clicked.connect(self.toggle_full_playback)
        self.btn_play.setStyleSheet(
            playback_btn_style +
            'QPushButton { background-color: #27ae60; }'
        )
        playback_layout.addWidget(self.btn_play)

        self.btn_pause = QPushButton('⏸')
        self.btn_pause.setFixedWidth(36)
        self.btn_pause.setToolTip('暂停播放')
        self.btn_pause.clicked.connect(self.pause_playback)
        self.btn_pause.setEnabled(False)
        self.btn_pause.setStyleSheet(
            playback_btn_style +
            'QPushButton:enabled { background-color: #e67e22; }'
            'QPushButton:disabled { background-color: #bdc3c7; color: #95a5a6; }'
        )
        playback_layout.addWidget(self.btn_pause)

        control_layout.addWidget(playback_widget)

        # 逐帧步进按钮（按视频帧粒度微调位置，用于精细观察对齐）
        control_layout.addWidget(QLabel('  |  '))
        step_widget = QWidget()
        step_layout = QHBoxLayout(step_widget)
        step_layout.setContentsMargins(0, 0, 0, 0)
        step_layout.setSpacing(2)

        step_btn_style = (
            'QPushButton {'
            '  font-size: 12px; padding: 3px 6px;'
            '  border-radius: 4px; border: none;'
            '  color: #fff;'
            '}'
        )

        self.btn_step_back5 = QPushButton('◀◀')
        self.btn_step_back5.setFixedWidth(36)
        self.btn_step_back5.setToolTip('后退5个视频帧')
        self.btn_step_back5.clicked.connect(lambda: self._step_frames(-5))
        self.btn_step_back5.setStyleSheet(
            step_btn_style + 'QPushButton { background-color: #636e72; }'
            'QPushButton:hover { background-color: #7f8c8d; }')
        step_layout.addWidget(self.btn_step_back5)

        self.btn_step_back1 = QPushButton('◀')
        self.btn_step_back1.setFixedWidth(32)
        self.btn_step_back1.setToolTip('后退1个视频帧')
        self.btn_step_back1.clicked.connect(lambda: self._step_frames(-1))
        self.btn_step_back1.setStyleSheet(
            step_btn_style + 'QPushButton { background-color: #636e72; }'
            'QPushButton:hover { background-color: #7f8c8d; }')
        step_layout.addWidget(self.btn_step_back1)

        self.lbl_step_info = QLabel('帧步')
        self.lbl_step_info.setStyleSheet('color: #666; font-size: 9pt; padding: 0 4px;')
        step_layout.addWidget(self.lbl_step_info)

        self.btn_step_fwd1 = QPushButton('▶')
        self.btn_step_fwd1.setFixedWidth(32)
        self.btn_step_fwd1.setToolTip('前进1个视频帧')
        self.btn_step_fwd1.clicked.connect(lambda: self._step_frames(1))
        self.btn_step_fwd1.setStyleSheet(
            step_btn_style + 'QPushButton { background-color: #0984e3; }'
            'QPushButton:hover { background-color: #3498db; }')
        step_layout.addWidget(self.btn_step_fwd1)

        self.btn_step_fwd5 = QPushButton('▶▶')
        self.btn_step_fwd5.setFixedWidth(36)
        self.btn_step_fwd5.setToolTip('前进5个视频帧')
        self.btn_step_fwd5.clicked.connect(lambda: self._step_frames(5))
        self.btn_step_fwd5.setStyleSheet(
            step_btn_style + 'QPushButton { background-color: #0984e3; }'
            'QPushButton:hover { background-color: #3498db; }')
        step_layout.addWidget(self.btn_step_fwd5)

        control_layout.addWidget(step_widget)

        control_scroll = QScrollArea()
        control_scroll.setWidget(control_widget)
        control_scroll.setWidgetResizable(False)
        control_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        control_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        main_layout.addWidget(control_scroll)

        # === 图表区域 ===
        splitter = QSplitter(Qt.Vertical)

        # ── EMG 图表 ──
        emg_widget = QWidget()
        emg_layout = QVBoxLayout(emg_widget)
        emg_layout.setContentsMargins(0, 0, 0, 0)
        # 中文标题栏
        emg_title = QHBoxLayout()
        emg_title.addWidget(QLabel('✋ 左手 EMG (16通道)'))
        emg_title.addStretch()
        emg_title.addWidget(QLabel('🤚 右手 EMG (16通道)'))
        emg_title.setContentsMargins(0, 2, 0, 2)
        emg_layout.addLayout(emg_title)
        self.fig_emg = Figure(figsize=(16, 10), dpi=100)
        self.fig_emg.set_tight_layout(True)
        self.canvas_emg = FigureCanvas(self.fig_emg)
        emg_layout.addWidget(self.canvas_emg)
        splitter.addWidget(emg_widget)

        # ── 视频预览面板 ──
        video_widget = QWidget()
        video_layout = QHBoxLayout(video_widget)
        video_layout.setContentsMargins(2, 2, 2, 2)
        video_layout.setSpacing(4)

        # 左侧视频
        left_video_group = QGroupBox('📹 左手相机')
        left_video_inner = QVBoxLayout(left_video_group)
        left_video_inner.setContentsMargins(2, 2, 2, 2)
        left_video_inner.setSpacing(2)
        # 按钮栏（右上角 2s 预览按钮）
        left_btn_bar = QHBoxLayout()
        left_btn_bar.addStretch()
        self.btn_preview_left = QPushButton('▶ 2s预览')
        self.btn_preview_left.setFixedWidth(90)
        self.btn_preview_left.setFixedHeight(28)
        self.btn_preview_left.setToolTip('预览当前帧向后 2 秒视频')
        self.btn_preview_left.clicked.connect(lambda: self._start_preview('left'))
        self.btn_preview_left.setEnabled(False)
        self.btn_preview_left.setStyleSheet(
            'QPushButton { font-size: 12px; font-weight: bold; padding: 2px 10px; }'
        )
        left_btn_bar.addWidget(self.btn_preview_left)
        left_video_inner.addLayout(left_btn_bar)
        self.lbl_video_left = QLabel()
        self.lbl_video_left.setAlignment(Qt.AlignCenter)
        self.lbl_video_left.setMinimumHeight(self.video_label_height)
        self.lbl_video_left.setStyleSheet(
            'background-color: #1a1a2e; border: 1px solid #333; color: #666; font-size: 11px;'
        )
        self.lbl_video_left.setText('(无视频)')
        left_video_inner.addWidget(self.lbl_video_left)
        self.lbl_video_left_time = QLabel('--:--')
        self.lbl_video_left_time.setAlignment(Qt.AlignCenter)
        self.lbl_video_left_time.setStyleSheet('color: #e74c3c; font-size: 11px; font-weight: bold;')
        left_video_inner.addWidget(self.lbl_video_left_time)
        video_layout.addWidget(left_video_group)

        # 右侧视频
        right_video_group = QGroupBox('📹 右手相机')
        right_video_inner = QVBoxLayout(right_video_group)
        right_video_inner.setContentsMargins(2, 2, 2, 2)
        right_video_inner.setSpacing(2)
        # 按钮栏（右上角 2s 预览按钮）
        right_btn_bar = QHBoxLayout()
        right_btn_bar.addStretch()
        self.btn_preview_right = QPushButton('▶ 2s预览')
        self.btn_preview_right.setFixedWidth(90)
        self.btn_preview_right.setFixedHeight(28)
        self.btn_preview_right.setToolTip('预览当前帧向后 2 秒视频')
        self.btn_preview_right.clicked.connect(lambda: self._start_preview('right'))
        self.btn_preview_right.setEnabled(False)
        self.btn_preview_right.setStyleSheet(
            'QPushButton { font-size: 12px; font-weight: bold; padding: 2px 10px; }'
        )
        right_btn_bar.addWidget(self.btn_preview_right)
        right_video_inner.addLayout(right_btn_bar)
        self.lbl_video_right = QLabel()
        self.lbl_video_right.setAlignment(Qt.AlignCenter)
        self.lbl_video_right.setMinimumHeight(self.video_label_height)
        self.lbl_video_right.setStyleSheet(
            'background-color: #1a1a2e; border: 1px solid #333; color: #666; font-size: 11px;'
        )
        self.lbl_video_right.setText('(无视频)')
        right_video_inner.addWidget(self.lbl_video_right)
        self.lbl_video_right_time = QLabel('--:--')
        self.lbl_video_right_time.setAlignment(Qt.AlignCenter)
        self.lbl_video_right_time.setStyleSheet('color: #e74c3c; font-size: 11px; font-weight: bold;')
        right_video_inner.addWidget(self.lbl_video_right_time)
        video_layout.addWidget(right_video_group)

        splitter.addWidget(video_widget)

        # ── IMU 加速度计 ──
        imu_acc_widget = QWidget()
        imu_acc_layout = QVBoxLayout(imu_acc_widget)
        imu_acc_layout.setContentsMargins(0, 0, 0, 0)
        # 中文标题 + offset 控件
        acc_title = QHBoxLayout()
        acc_title.addWidget(QLabel('📐 左手加速度计'))
        self.lbl_imu_acc_dev1_info = QLabel('')
        self.lbl_imu_acc_dev1_info.setStyleSheet('color: #2563eb; font-size: 7pt; padding-left: 3px;')
        acc_title.addWidget(self.lbl_imu_acc_dev1_info)
        acc_title.addStretch()
        acc_title.addWidget(QLabel('Offset(g):'))
        self.spin_imu_acc_offset = QSpinBox()
        self.spin_imu_acc_offset.setRange(1, 50)
        self.spin_imu_acc_offset.setValue(int(self.imu_acc_offset))
        self.spin_imu_acc_offset.setSingleStep(1)
        self.spin_imu_acc_offset.valueChanged.connect(self.on_imu_offset_changed)
        acc_title.addWidget(self.spin_imu_acc_offset)
        acc_title.addStretch()
        acc_title.addWidget(QLabel('📐 右手加速度计'))
        self.lbl_imu_acc_dev2_info = QLabel('')
        self.lbl_imu_acc_dev2_info.setStyleSheet('color: #7c3aed; font-size: 7pt; padding-left: 3px;')
        acc_title.addWidget(self.lbl_imu_acc_dev2_info)
        acc_title.setContentsMargins(0, 2, 0, 2)
        imu_acc_layout.addLayout(acc_title)
        self.fig_imu_acc = Figure(figsize=(16, 2.5), dpi=100)
        self.fig_imu_acc.set_tight_layout(True)
        self.canvas_imu_acc = FigureCanvas(self.fig_imu_acc)
        imu_acc_layout.addWidget(self.canvas_imu_acc)
        splitter.addWidget(imu_acc_widget)

        # ── IMU 陀螺仪 ──
        imu_gyr_widget = QWidget()
        imu_gyr_layout = QVBoxLayout(imu_gyr_widget)
        imu_gyr_layout.setContentsMargins(0, 0, 0, 0)
        # 中文标题 + offset 控件
        gyr_title = QHBoxLayout()
        gyr_title.addWidget(QLabel('🔄 左手陀螺仪'))
        self.lbl_imu_gyr_dev1_info = QLabel('')
        self.lbl_imu_gyr_dev1_info.setStyleSheet('color: #2563eb; font-size: 7pt; padding-left: 3px;')
        gyr_title.addWidget(self.lbl_imu_gyr_dev1_info)
        gyr_title.addStretch()
        gyr_title.addWidget(QLabel('Offset(deg/s):'))
        self.spin_imu_gyr_offset = QSpinBox()
        self.spin_imu_gyr_offset.setRange(10, 5000)
        self.spin_imu_gyr_offset.setValue(int(self.imu_gyr_offset))
        self.spin_imu_gyr_offset.setSingleStep(50)
        self.spin_imu_gyr_offset.valueChanged.connect(self.on_imu_offset_changed)
        gyr_title.addWidget(self.spin_imu_gyr_offset)
        gyr_title.addStretch()
        gyr_title.addWidget(QLabel('🔄 右手陀螺仪'))
        self.lbl_imu_gyr_dev2_info = QLabel('')
        self.lbl_imu_gyr_dev2_info.setStyleSheet('color: #7c3aed; font-size: 7pt; padding-left: 3px;')
        gyr_title.addWidget(self.lbl_imu_gyr_dev2_info)
        gyr_title.setContentsMargins(0, 2, 0, 2)
        imu_gyr_layout.addLayout(gyr_title)
        self.fig_imu_gyr = Figure(figsize=(16, 2.5), dpi=100)
        self.fig_imu_gyr.set_tight_layout(True)
        self.canvas_imu_gyr = FigureCanvas(self.fig_imu_gyr)
        imu_gyr_layout.addWidget(self.canvas_imu_gyr)
        splitter.addWidget(imu_gyr_widget)

        main_layout.addWidget(splitter)

        # 禁止面板拖拽拉伸
        for i in range(splitter.count()):
            handle = splitter.handle(i)
            if handle:
                handle.setEnabled(False)

        # === 底部滑块 ===
        slider_layout = QHBoxLayout()

        self.lbl_pos = QLabel('位置: 0')
        slider_layout.addWidget(self.lbl_pos)

        self.slider = QSlider(Qt.Horizontal)
        self.slider.setMinimum(0)
        self.slider.setMaximum(0)
        # 平滑更新：使用节流机制
        self.slider.valueChanged.connect(self.on_slider_changed)
        self.slider.sliderPressed.connect(self.on_slider_pressed)
        self.slider.sliderReleased.connect(self.on_slider_released)
        slider_layout.addWidget(self.slider)

        self.lbl_total = QLabel('/ 0')
        slider_layout.addWidget(self.lbl_total)

        main_layout.addLayout(slider_layout)

        # 初始化图表
        self.init_plots()

    def init_plots(self):
        """初始化图表（默认供应商堆叠视图）"""
        self._init_emg_axes()
        self._init_imu_axes()

    def _init_emg_axes(self):
        """创建 EMG 图表 axes（根据 view_mode）"""
        self.fig_emg.clear()
        if self.view_mode == 'stacked':
            # 供应商堆叠：左右两列，每列 1 个 Axes
            self.ax_emg1_stacked = self.fig_emg.add_subplot(1, 2, 1)
            self.ax_emg2_stacked = self.fig_emg.add_subplot(1, 2, 2)
            self.ax_emg1_channels = []  # 子图模式下才用
            self.ax_emg2_channels = []
        else:
            # 分通道子图：左右两列，每列 16 个 Axes
            from matplotlib.gridspec import GridSpec
            gs = GridSpec(16, 2, figure=self.fig_emg, hspace=0, wspace=0.1)
            self.ax_emg1_channels = []
            self.ax_emg2_channels = []
            self.ax_emg1_stacked = None
            self.ax_emg2_stacked = None
            for i in range(16):
                ax1 = self.fig_emg.add_subplot(gs[i, 0])
                self.ax_emg1_channels.append(ax1)
                ax1.set_ylabel(f'{i}', fontsize=7, rotation=0, labelpad=10)
                ax1.tick_params(axis='y', labelsize=5, length=2)
                ax1.tick_params(axis='x', labelsize=5)
                ax1.spines['top'].set_visible(False)
                ax1.spines['right'].set_visible(False)
                if i < 15:
                    ax1.set_xticklabels([])
                    ax1.spines['bottom'].set_visible(False)
                    ax1.tick_params(axis='x', length=0)
                ax2 = self.fig_emg.add_subplot(gs[i, 1])
                self.ax_emg2_channels.append(ax2)
                ax2.tick_params(axis='y', labelsize=5, length=2)
                ax2.tick_params(axis='x', labelsize=5)
                ax2.set_yticklabels([])
                ax2.spines['top'].set_visible(False)
                ax2.spines['right'].set_visible(False)
                ax2.spines['left'].set_visible(False)
                if i < 15:
                    ax2.set_xticklabels([])
                    ax2.spines['bottom'].set_visible(False)
                    ax2.tick_params(axis='x', length=0)
            self.ax_emg1_channels[0].set_title('左手 EMG (16通道)', fontsize=10, pad=5)
            self.ax_emg2_channels[0].set_title('右手 EMG (16通道)', fontsize=10, pad=5)
            self.ax_emg1_channels[-1].set_xlabel('时间 (秒)', fontsize=8)
            self.ax_emg2_channels[-1].set_xlabel('时间 (秒)', fontsize=8)
        self.canvas_emg.draw_idle()

    def _init_imu_axes(self):
        """创建供应商风格 IMU 图表：Acc 堆叠图 + Gyr 堆叠图"""
        self.fig_imu_acc.clear()
        self.fig_imu_gyr.clear()
        self.ax_imu_acc_dev1 = self.fig_imu_acc.add_subplot(1, 2, 1)
        self.ax_imu_acc_dev2 = self.fig_imu_acc.add_subplot(1, 2, 2)
        self.ax_imu_gyr_dev1 = self.fig_imu_gyr.add_subplot(1, 2, 1)
        self.ax_imu_gyr_dev2 = self.fig_imu_gyr.add_subplot(1, 2, 2)
        # keep legacy ref for compatibility
        self.ax_imu_channels = {}

    def on_view_mode_changed(self, idx):
        """切换 EMG 显示模式"""
        self.view_mode = 'stacked' if idx == 0 else 'subplot'
        self._init_emg_axes()
        self._update_window_sec_label()
        self.update_plots()

    def on_offset_changed(self, value):
        """Offset spinbox 改变"""
        self.offset_uv = value
        if self.view_mode == 'stacked':
            self.update_plots()

    def on_clamp_changed(self, state):
        """Clamp checkbox 改变"""
        self.clamp_enabled = (state == Qt.Checked)
        if self.view_mode == 'stacked':
            self.update_plots()

    def on_imu_offset_changed(self):
        """IMU Acc/Gyr offset 改变"""
        self.imu_acc_offset = self.spin_imu_acc_offset.value()
        self.imu_gyr_offset = self.spin_imu_gyr_offset.value()
        self.update_plots()

    def _update_window_sec_label(self):
        """更新窗口标签显示秒数"""
        sr = self._active_emg_sample_rate()
        sec = self.window_size / sr if sr > 0 else 0
        self.lbl_window_sec.setText(f'≈{sec:.1f}s')

    def _get_lsb_uv_for_dataset(self, ds_name):
        """从 H5 dataset attrs 读取 lsb_uv，无则 fallback 供应商值"""
        file_lsb = None
        if self.h5_file:
            dev_id = 1 if 'emg1' in str(ds_name) else 2 if 'emg2' in str(ds_name) else None
            lsb_keys = []
            if dev_id:
                lsb_keys.append(f'emg_lsb_uv_24bit_dev{dev_id}')
            lsb_keys.append('emg_lsb_uv_24bit')
            for key in lsb_keys:
                try:
                    value = self.h5_file.attrs.get(key)
                    if value is not None:
                        file_lsb = float(value)
                        break
                except (ValueError, TypeError):
                    pass
            if file_lsb is None:
                gain_keys = []
                if dev_id:
                    gain_keys.append(f'emg_gain_dev{dev_id}')
                gain_keys.append('emg_gain')
                for key in gain_keys:
                    try:
                        gain = self.h5_file.attrs.get(key)
                        if gain is not None:
                            gain = float(gain)
                            if gain > 0:
                                file_lsb = calculate_lsb_uv(gain=gain)
                                break
                    except (ValueError, TypeError):
                        pass

        if self.h5_file and ds_name and ds_name in self.h5_file:
            ds_lsb = self.h5_file[ds_name].attrs.get('lsb_uv')
            if ds_lsb is not None:
                try:
                    ds_lsb = float(ds_lsb)
                    if file_lsb and file_lsb > 0 and ds_lsb > 0:
                        ratio = max(file_lsb, ds_lsb) / min(file_lsb, ds_lsb)
                        if ratio > 1.5:
                            print(
                                f'[CalibrateTool] LSB冲突: {ds_name} dataset={ds_lsb:.6f}, '
                                f'file={file_lsb:.6f}; 使用文件级采集配置'
                            )
                            return file_lsb
                    return ds_lsb
                except (ValueError, TypeError):
                    pass
        if file_lsb:
            return file_lsb
        # fallback: 供应商基准值
        return calculate_lsb_uv()

    def open_file(self):
        """打开H5文件"""
        file_path, _ = QFileDialog.getOpenFileName(
            self, '选择H5文件',
            os.path.join(os.path.dirname(__file__), '..', 'storage'),
            'HDF5 Files (*.h5 *.hdf5);;All Files (*)'
        )

        if file_path:
            self.load_h5_file(file_path)

    def load_h5_file(self, file_path):
        """加载H5文件数据"""
        try:
            # 停止正在进行的播放
            if self.is_playing:
                self._stop_playback()
            if self.is_full_playing:
                self._stop_full_playback()

            self._release_loaded_file()

            self.h5_file = h5py.File(file_path, 'r')
            self.h5_path = file_path

            # 更新文件标签
            filename = os.path.basename(file_path)
            self.lbl_file.setText(filename)
            self.lbl_file.setStyleSheet('color: #333; font-weight: bold;')

            # 读取数据（必须先加载 EMG 以获取 dataset 名，供 _load_status_attrs 使用）
            self.load_emg_data()
            self.load_imu_data()

            # 读取 H5 attrs（依赖 emg*_loaded_name）
            self._load_status_attrs()
            self.load_prompt_data()
            self._load_videos()
            self._load_calibration_offset()

            # 计算并保存全局的Y轴范围
            self.calculate_y_limits()

            # 更新滑块范围
            max_len = self.get_max_data_length()
            self.slider.setMaximum(max(0, max_len - self.window_size))
            self.lbl_total.setText(f'/ {max_len}')

            # 重置位置并更新显示
            self.current_pos = 0
            self.slider.setValue(0)
            self.update_plots()

            print(f'[CalibrateTool] 已加载文件: {file_path}')

        except Exception as e:
            self._release_loaded_file()
            self.lbl_file.setText('未加载文件')
            self.slider.setMaximum(0)
            self.lbl_total.setText('/ 0')
            QMessageBox.critical(self, '错误', f'加载文件失败:\n{str(e)}')
            print(f'[CalibrateTool] 加载失败: {e}')

    def _release_loaded_file(self):
        """Release resources even when loading stops halfway through a file."""
        self.is_playing = self.is_full_playing = False
        for timer in (self.playback_timer, self.full_playback_timer, self.update_timer):
            timer.stop()
        self.pending_update = False
        self._close_videos()
        if self.h5_file is not None:
            try:
                self.h5_file.close()
            finally:
                self.h5_file = None
        self.h5_path = None
        for dev in (1, 2):
            for suffix in ('data', 'dataset', 'start_time', 'time_axis', 'loaded_name'):
                setattr(self, f'emg{dev}_{suffix}', None)
            setattr(self, f'emg{dev}_length', 0)
            setattr(self, f'emg{dev}_has_time', False)
            for sensor in ('a', 'b', 'c'):
                for suffix in ('data', 'gyr_data', 'time'):
                    setattr(self, f'imu{dev}{sensor}_{suffix}', None)
        self.prompt_names = self.prompt_times = None
        self.emg_start_time = self.session_start_unix = None
        self.calib_offset.clear()
        self.calib_present = False
        self._update_playback_buttons(playing=False)

    def _load_status_attrs(self):
        """Phase 6: 读取并显示 H5 同步/采集状态 attrs"""
        f = self.h5_file
        parts = []

        def _s(k, d='-'):
            v = f.attrs.get(k)
            if isinstance(v, bytes): v = v.decode('utf-8')
            return str(v) if v is not None else d

        def _safe_int(v, d=1):
            try: return int(v)
            except (ValueError, TypeError): return d

        def _safe_bool(v, d=False):
            if isinstance(v, bool): return v
            if isinstance(v, (int, float)): return bool(v)
            if isinstance(v, str): return v.lower() in ('true', '1', 'yes')
            if isinstance(v, bytes): return v.decode('utf-8').lower() in ('true', '1', 'yes')
            return d

        sync = _s('sync_status')
        cs = _s('collection_status')
        seg = _safe_int(f.attrs.get('segment_index'), 1)
        resumed = 'R' if _safe_bool(f.attrs.get('is_resumed')) else ''
        cm = _s('channel_map_name')
        sfv = f.attrs.get('stream_format_version')
        sm = _s('sync_mode')
        sync_alignment = _s('sync_time_alignment')

        if sync not in ('-', 'unknown'):
            parts.append(f'sync: {sync}')
        if sm not in ('-',):
            parts.append(f'mode: {sm}')
        if sync_alignment not in ('-',):
            parts.append(f'align: {sync_alignment}')
        if cs != '-':
            parts.append(f'collection: {cs}')
        if resumed or seg > 1:
            parts.append(f'seg: {seg}{resumed}')
        if sfv is not None:
            parts.append(f'fmt: v{sfv}')
        else:
            parts.append('fmt: legacy')
        if cm != '-':
            parts.append(f'chan: {cm}')
        # IMU counts
        for dev in (1, 2):
            ni = f.attrs.get(f'imu{dev}_num_imus')
            if ni is not None:
                parts.append(f'imu{dev}: {int(ni)}IMU')
        # show which data source is loaded + LSB
        ds_info = []
        if getattr(self, 'emg1_loaded_name', None):
            src = self.emg1_loaded_name.replace('_adc','')
            lsb1 = getattr(self, 'emg1_lsb_uv', None)
            if lsb1:
                src += f'({lsb1:.4f})'
            ds_info.append(src)
        if getattr(self, 'emg2_loaded_name', None):
            src = self.emg2_loaded_name.replace('_adc','')
            lsb2 = getattr(self, 'emg2_lsb_uv', None)
            if lsb2:
                src += f'({lsb2:.4f})'
            ds_info.append(src)
        if ds_info:
            parts.append('src: ' + ','.join(ds_info))

        # LSB 信息
        lsb1 = getattr(self, 'emg1_lsb_uv', None)
        if lsb1:
            parts.append(f'lsb={lsb1:.4f}uV')
        # 滤波档位显示
        parts.append(f'Q={FILTER_NOTCH_Q_OFFLINE}')
        # 窗口显示信息
        sr = self._active_emg_sample_rate()
        parts.append(f'{self.window_size}pt/{self.window_size/sr:.1f}s')

        for k in ('last_sync_success_time', 'last_sync_error_time'):
            v = f.attrs.get(k)
            if v:
                if isinstance(v, bytes): v = v.decode('utf-8')
                parts.append(v[:19])

        self.lbl_status.setText(' | '.join(parts) if parts else '')
        if sync == 'synced':
            self.lbl_status.setStyleSheet('color: #16a34a; font-size: 9px;')
        elif sync in ('sync_failed',):
            self.lbl_status.setStyleSheet('color: #dc2626; font-size: 9px;')
        elif sync == 'pending':
            self.lbl_status.setStyleSheet('color: #f59e0b; font-size: 9px;')
        else:
            self.lbl_status.setStyleSheet('color: #666; font-size: 9px;')

        # ── 2kHz / legacy frame_id 风险提示（不弹窗阻塞，仅状态栏 WARN）──
        has_2khz_loaded = (getattr(self, 'emg1_loaded_name', '') and '2khz' in self.emg1_loaded_name) or \
                          (getattr(self, 'emg2_loaded_name', '') and '2khz' in self.emg2_loaded_name)
        reliable_sync_modes = ('one_to_many_adc_search', 'one_to_one')

        # 2kHz 未可靠同步 → 状态栏警告（不弹窗）
        if has_2khz_loaded and sync != 'synced' and sm not in reliable_sync_modes:
            self.lbl_status.setText(
                (self.lbl_status.text() or '') + ' | WARN: 2kHz data, sync not verified')

        # diagnose legacy frame_id bug（新版同步不依赖 frame_id，不弹窗）
        try:
            from bin_sync_tool import diagnose_frame_ids
            diag = diagnose_frame_ids(self.h5_path)
            frame_risk = None
            for dev in ('emg1', 'emg2'):
                d = diag.get(dev, {})
                risk = d.get('risk')
                reason = d.get('risk_reason', '')
                if risk == 'high':
                    frame_risk = (dev, risk, reason)
                    break
                elif risk == 'medium' and frame_risk is None:
                    frame_risk = (dev, risk, reason)

            if frame_risk:
                dev, risk, reason = frame_risk
                is_reliably_synced = (sync == 'synced' and sm in reliable_sync_modes)

                if is_reliably_synced:
                    # 新版 sync（ADC search / one_to_one）不依赖 frame_id
                    print(f'[CalibrateTool] legacy frame_id {risk} ({dev}: {reason}), '
                          f'ignored: sync_mode={sm} via ADC search')
                    self.lbl_status.setText(
                        (self.lbl_status.text() or '') + ' | legacy frame_id ignored; synced by ADC search')
                elif has_2khz_loaded:
                    # 2kHz + 不可靠同步 → 明显警告
                    self.lbl_status.setText(
                        (self.lbl_status.text() or '') + f' | WARN: 2kHz may be unreliable (frame_id {risk})')
                else:
                    # 250Hz + frame_id 问题 → 轻提示（250Hz 原始值可正常查看）
                    self.lbl_status.setText(
                        (self.lbl_status.text() or '') + f' | WARN: frame_id {risk}, 250Hz ok')
        except Exception:
            pass

    def load_emg_data(self):
        """加载 EMG 数据：synced→优先2kHz，未同步→优先250Hz"""
        self.emg1_data = None
        self.emg2_data = None
        self.emg1_dataset = None
        self.emg2_dataset = None
        self.emg1_length = 0
        self.emg2_length = 0
        self.emg1_start_time = None
        self.emg2_start_time = None
        self.emg1_time_axis = None
        self.emg2_time_axis = None
        self.emg1_has_time = False
        self.emg2_has_time = False
        self.emg1_sample_rate = None
        self.emg2_sample_rate = None
        self.emg_start_time = None
        self.session_start_unix = None
        self.emg1_loaded_name = None
        self.emg2_loaded_name = None

        # 判断是否已可靠同步 → 优先 2kHz
        sync = self.h5_file.attrs.get('sync_status')
        if isinstance(sync, bytes):
            sync = sync.decode('utf-8')
        synced = (sync == 'synced')
        has_2khz_emg1 = 'emg1_2khz_adc' in self.h5_file or 'emg1_2khz' in self.h5_file
        has_2khz_emg2 = 'emg2_2khz_adc' in self.h5_file or 'emg2_2khz' in self.h5_file

        if synced and (has_2khz_emg1 or has_2khz_emg2):
            # 已同步 → 优先 2kHz
            emg1_names = ['emg1_2khz_adc', 'emg1_2khz', 'emg1_250hz_adc', 'emg1_250hz', 'emg1']
            emg2_names = ['emg2_2khz_adc', 'emg2_2khz', 'emg2_250hz_adc', 'emg2_250hz', 'emg2']
        else:
            # 未同步 → 优先 250Hz
            emg1_names = ['emg1_250hz_adc', 'emg1_250hz', 'emg1_2khz_adc', 'emg1_2khz', 'emg1']
            emg2_names = ['emg2_250hz_adc', 'emg2_250hz', 'emg2_2khz_adc', 'emg2_2khz', 'emg2']

        for device in (1, 2):
            names = emg1_names if device == 1 else emg2_names
            if self.h5_file.attrs.get(f'sync_device_validation_dev{device}', False):
                target = f'emg{device}_2khz_adc'
                if target in names: names.insert(0, names.pop(names.index(target)))

        for name in emg1_names:
            if name in self.h5_file:
                dataset = self.h5_file[name]
                if len(dataset) == 0:
                    print(f'[CalibrateTool] 跳过空数据集 {name}')
                    continue
                self.emg1_dataset = dataset
                self.emg1_length = int(len(dataset))
                self.emg1_loaded_name = name
                names = dataset.dtype.names or ()
                self.emg1_has_time = 'time' in names
                if self.emg1_has_time:
                    self.emg1_time_axis = np.asarray(
                        dataset.fields('time')[:], dtype=np.float64)
                    if not np.all(np.isfinite(self.emg1_time_axis)) or np.any(np.diff(self.emg1_time_axis) <= 0):
                        raise ValueError('设备1时间列存在无效值、回退或重复，请先修复时间戳再预览')
                    self.emg1_start_time = float(self.emg1_time_axis[0])
                    self.emg_start_time = self.emg1_start_time
                self.emg1_sample_rate = 250 if '250hz' in name else 2000
                self.emg1_lsb_uv = self._get_lsb_uv_for_dataset(name)
                print(f'[CalibrateTool] 已加载 {name}: shape={dataset.shape}, '
                      f'rate={self.emg1_sample_rate}, lsb={self.emg1_lsb_uv:.6f}')
                break

        for name in emg2_names:
            if name in self.h5_file:
                dataset = self.h5_file[name]
                if len(dataset) == 0:
                    print(f'[CalibrateTool] 跳过空数据集 {name}')
                    continue
                self.emg2_dataset = dataset
                self.emg2_length = int(len(dataset))
                self.emg2_loaded_name = name
                names = dataset.dtype.names or ()
                self.emg2_has_time = 'time' in names
                if self.emg2_has_time:
                    self.emg2_time_axis = np.asarray(
                        dataset.fields('time')[:], dtype=np.float64)
                    if not np.all(np.isfinite(self.emg2_time_axis)) or np.any(np.diff(self.emg2_time_axis) <= 0):
                        raise ValueError('设备2时间列存在无效值、回退或重复，请先修复时间戳再预览')
                    self.emg2_start_time = float(self.emg2_time_axis[0])
                    if self.emg_start_time is None:
                        self.emg_start_time = self.emg2_start_time
                self.emg2_sample_rate = 250 if '250hz' in name else 2000
                self.emg2_lsb_uv = self._get_lsb_uv_for_dataset(name)
                print(f'[CalibrateTool] 已加载 {name}: shape={dataset.shape}, '
                      f'rate={self.emg2_sample_rate}, lsb={self.emg2_lsb_uv:.6f}')
                break

        # 设置默认窗口（5 秒）
        sr = self._active_emg_sample_rate()
        if sr == 250:
            self.window_size = WINDOW_250HZ
        else:
            self.window_size = WINDOW_2KHZ
        self.spin_window.setValue(self.window_size)
        self._update_window_sec_label()

        # 【统一时钟】读取会话起始时间（Python time.time()，由 realtimeEngine 在采集开始时
        # 查询 camera_server 获取，与 EMG/视频数据时间戳同源）
        # 向后兼容：旧 H5 文件无 start_time 属性时，fallback 到 emg_start_time
        try:
            st = self.h5_file.attrs.get('start_time')
            if st is not None:
                self.session_start_unix = float(st)
                print(f'[CalibrateTool] 统一会话起始时间 (session_start_unix): {self.session_start_unix:.3f}')
                if self.emg_start_time is not None:
                    print(f'[CalibrateTool]   EMG首帧滞后会话起始: {self.emg_start_time - self.session_start_unix:+.3f}s')
            else:
                print('[CalibrateTool] H5无start_time属性，使用emg_start_time作为参考（旧文件兼容）')
        except Exception as e:
            print(f'[CalibrateTool] 读取session_start_unix失败: {e}（使用emg_start_time兜底）')

    def _ref_time(self):
        """对齐参考时间：优先统一会话起始，向后兼容 EMG 起始"""
        if self.session_start_unix is not None:
            return self.session_start_unix
        return self.emg_start_time

    def _extract_emg_channels(self, data):
        """从结构化数组中提取EMG通道数据"""
        print(f'[CalibrateTool] EMG数据类型: {data.dtype}, 字段: {data.dtype.names}')

        # 检查是否为结构化数组
        if data.dtype.names is not None:
            if 'channels' in data.dtype.names:
                # channels 字段本身是一个数组
                channels_data = data['channels']
                print(f'[CalibrateTool] channels字段 shape: {channels_data.shape}')
                # 确保返回 (N, 16) 的形状
                if channels_data.ndim == 1:
                    # 如果是一维结构化数组，需要转换
                    result = np.array([list(row) for row in channels_data])
                else:
                    result = np.array(channels_data)
                print(f'[CalibrateTool] 提取后 shape: {result.shape}')
                return result
            # 尝试其他可能的字段名
            for name in data.dtype.names:
                if 'ch' in name.lower() or 'channel' in name.lower():
                    return np.array(data[name])

        # 普通数组
        return np.array(data)

    def _emg_dataset_info(self, device):
        """Return the lazy dataset metadata for device 1 or 2."""
        prefix = f'emg{int(device)}'
        return (
            getattr(self, f'{prefix}_dataset', None),
            int(getattr(self, f'{prefix}_length', 0) or 0),
            int(getattr(self, f'{prefix}_sample_rate', None) or 2000),
            getattr(self, f'{prefix}_start_time', None),
            bool(getattr(self, f'{prefix}_has_time', False)),
        )

    def _emg_time_axis(self, device):
        return getattr(self, f'emg{int(device)}_time_axis', None)

    def _time_axis_is_absolute(self, axis):
        if axis is None or len(axis) == 0:
            return False
        first = float(axis[0])
        session = getattr(self, 'session_start_unix', None)
        return abs(first) > 1e6 or (
            session is not None and abs(first - float(session)) < 60.0)

    def _read_emg_index_window(self, device, start, end):
        """Read only a bounded structured EMG slice and return channels/time.

        The viewer used to materialize every 16-channel sample during file
        open.  HDF5 field slicing keeps the memory cost proportional to the
        visible window and also works with plain (non-structured) datasets.
        """
        dataset, length, sample_rate, first_time, has_time = self._emg_dataset_info(device)
        if dataset is None or length <= 0:
            return np.empty((0, 16), dtype=np.float32), None
        lo = max(0, int(start))
        hi = min(length, max(lo, int(end)))
        if hi <= lo:
            return np.empty((0, 16), dtype=np.float32), None
        names = dataset.dtype.names or ()
        if 'channels' in names:
            channels = np.asarray(dataset.fields('channels')[lo:hi])
        elif names:
            field = next((n for n in names if 'ch' in n.lower() or 'channel' in n.lower()), None)
            channels = (np.asarray(dataset.fields(field)[lo:hi])
                        if field else np.asarray(dataset[lo:hi]))
        else:
            channels = np.asarray(dataset[lo:hi])
        if channels.ndim == 1:
            channels = channels.reshape(-1, 1) if channels.dtype.names is None else np.asarray([list(row) for row in channels])
        times = None
        if has_time:
            times = np.asarray(dataset.fields('time')[lo:hi], dtype=np.float64)
        elif first_time is not None:
            times = float(first_time) + np.arange(lo, hi, dtype=np.float64) / sample_rate
        else:
            times = np.arange(lo, hi, dtype=np.float64) / sample_rate
        return channels, times

    def _read_emg_time_window(self, device, rel_start, rel_end, padding_seconds=0.0):
        """Read a device window by real time, using bounded searchsorted.

        ``current_pos`` is on the primary device's sample grid; each device
        gets its own sample-rate/start offset and its own H5 slice.  A small
        guard region handles timestamp gaps and filtering edge padding.
        """
        dataset, length, sample_rate, first_time, has_time = self._emg_dataset_info(device)
        if dataset is None or length <= 0:
            return np.empty((0, 16), dtype=np.float32), np.empty(0, dtype=np.float64)
        reference = self._ref_time()
        reference = float(reference) if reference is not None else float(first_time or 0.0)
        axis = self._emg_time_axis(device) if has_time else None
        if axis is not None and len(axis):
            absolute = self._time_axis_is_absolute(axis)
            target_start = ((reference + float(rel_start) - float(padding_seconds))
                            if absolute else
                            (float(rel_start) - float(padding_seconds)))
            target_end = ((reference + float(rel_end) + float(padding_seconds))
                          if absolute else
                          (float(rel_end) + float(padding_seconds)))
            estimate_lo = int(np.searchsorted(axis, target_start, side='left'))
            estimate_hi = int(np.searchsorted(axis, target_end, side='right'))
            estimate_lo = max(0, min(length, estimate_lo))
            estimate_hi = max(estimate_lo, min(length, estimate_hi))
        else:
            # No time field: index mapping is the only available contract.
            if first_time is None:
                first_time = 0.0
            estimate_lo = int(np.floor((float(rel_start) - padding_seconds) * sample_rate)) - 4
            estimate_hi = int(np.ceil((float(rel_end) + padding_seconds) * sample_rate)) + 5
            estimate_lo = max(0, min(length, estimate_lo))
            estimate_hi = max(estimate_lo, min(length, estimate_hi))
        channels, raw_times = self._read_emg_index_window(device, estimate_lo, estimate_hi)
        if len(channels) == 0:
            return channels, np.empty(0, dtype=np.float64)
        if not has_time:
            rel_times = (np.asarray(raw_times, dtype=np.float64) -
                         (reference if self._time_axis_is_absolute(
                             np.asarray([first_time], dtype=np.float64)) else 0.0))
        else:
            rel_times = np.asarray(raw_times, dtype=np.float64) - (reference if absolute else 0.0)
        # Ensure gaps are handled by actual timestamps.  A time field with no
        # samples in the requested interval remains empty; index fallback is
        # only used when the field does not exist.
        if has_time:
            left = int(np.searchsorted(rel_times, float(rel_start) - padding_seconds, side='left'))
            right = int(np.searchsorted(rel_times, float(rel_end) + padding_seconds, side='right'))
            if right <= left:
                return channels[:0], rel_times[:0]
            channels = channels[left:right]
            rel_times = rel_times[left:right]
        return channels, rel_times

    def load_imu_data(self):
        """加载IMU数据（支持 a/b/c、100hz/BLE/legacy、imu*_all_ble 拆分）"""
        self.imu1a_data = None
        self.imu1b_data = None
        self.imu1c_data = None
        self.imu2a_data = None
        self.imu2b_data = None
        self.imu2c_data = None
        self.imu1a_gyr_data = None
        self.imu1b_gyr_data = None
        self.imu1c_gyr_data = None
        self.imu2a_gyr_data = None
        self.imu2b_gyr_data = None
        self.imu2c_gyr_data = None
        self.imu1a_time = None
        self.imu1b_time = None
        self.imu1c_time = None
        self.imu2a_time = None
        self.imu2b_time = None
        self.imu2c_time = None
        self._imu_diag_printed = False  # 每次加载文件时重置诊断标志
        self._imu_diag_strike = 0        # 连续无数据绘制计数器

        # ── 1. 独立 dataset：100hz（同步后）> BLE 原始 > bare name ──
        imu_mapping = {
            'imu1a': ['imu1a_100hz', 'imu1a_ble', 'imu1a'],
            'imu1b': ['imu1b_100hz', 'imu1b_ble', 'imu1b'],
            'imu1c': ['imu1c_100hz', 'imu1c_ble', 'imu1c'],
            'imu2a': ['imu2a_100hz', 'imu2a_ble', 'imu2a'],
            'imu2b': ['imu2b_100hz', 'imu2b_ble', 'imu2b'],
            'imu2c': ['imu2c_100hz', 'imu2c_ble', 'imu2c'],
        }

        for attr_name, possible_names in imu_mapping.items():
            for name in possible_names:
                if name in self.h5_file:
                    raw = self.h5_file[name][:]
                    acc_data = self._extract_imu_acc(raw)
                    gyr_data = self._extract_imu_gyr(raw)
                    # 读取 time 字段用于窗口对齐
                    imu_time = None
                    if hasattr(raw, 'dtype') and raw.dtype.names and 'time' in raw.dtype.names:
                        imu_time = self._relative_sensor_time(raw['time'][:])
                    if acc_data is not None and len(acc_data) > 0:
                        setattr(self, f'{attr_name}_data', acc_data)
                    if gyr_data is not None and len(gyr_data) > 0:
                        setattr(self, f'{attr_name}_gyr_data', gyr_data)
                    if imu_time is not None and len(imu_time) > 0:
                        setattr(self, f'{attr_name}_time', imu_time)
                    if acc_data is not None or gyr_data is not None:
                        t_info = f't={imu_time[0]:.1f}..{imu_time[-1]:.1f}' if imu_time is not None and len(imu_time) > 0 else 't=N/A'
                        print(f'[CalibrateTool] 已加载 {name}: acc={acc_data.shape if acc_data is not None else None}, '
                              f'gyr={gyr_data.shape if gyr_data is not None else None}, {t_info}')
                    break

        # ── 2. imu*_all_ble 按 imu_index 拆分（仅填充未由独立 dataset 加载的项） ──
        self._load_all_ble(1)
        self._load_all_ble(2)

        # ── 3. 推断 IMU 数量 ──
        self._infer_imu_counts()

    def _load_all_ble(self, device_id):
        """从 imu{device}_all_ble 按 imu_index 拆分到 a/b/c"""
        all_name = f'imu{device_id}_all_ble'
        if all_name not in self.h5_file:
            return

        ds = self.h5_file[all_name]
        if not hasattr(ds, 'dtype') or ds.dtype.names is None:
            return
        if 'imu_index' not in ds.dtype.names or 'acc' not in ds.dtype.names:
            return

        labels = ['a', 'b', 'c', 'd']
        for idx, label in enumerate(labels):
            attr_name = f'imu{device_id}{label}_data'
            # 独立 dataset 优先，不覆盖
            if getattr(self, attr_name, None) is not None:
                continue
            try:
                mask = ds['imu_index'][:] == idx
                if np.any(mask):
                    subset = ds[mask]
                    acc_data = self._extract_imu_acc(subset)
                    gyr_data = self._extract_imu_gyr(subset)
                    imu_time = None
                    if hasattr(subset, 'dtype') and subset.dtype.names and 'time' in subset.dtype.names:
                        imu_time = self._relative_sensor_time(subset['time'][:])
                    if acc_data is not None and len(acc_data) > 0:
                        setattr(self, attr_name, acc_data)
                    if gyr_data is not None and len(gyr_data) > 0:
                        setattr(self, f'{attr_name}_gyr_data', gyr_data)
                    if imu_time is not None and len(imu_time) > 0:
                        setattr(self, f'{attr_name}_time', imu_time)
                    if acc_data is not None or gyr_data is not None:
                        print(f'[CalibrateTool] 从 {all_name} 拆分 imu_index={idx} -> {attr_name}: '
                              f'acc={acc_data.shape if acc_data is not None else None}, '
                              f'gyr={gyr_data.shape if gyr_data is not None else None}')
            except Exception as e:
                print(f'[CalibrateTool] 拆分 {all_name} imu_index={idx} 失败: {e}')

    def _infer_imu_counts(self):
        """推断 IMU 数量 —— 多源融合，鲁棒处理 1~3 传感器任意损坏场景。

        优先级（从高到低）：
        1. imu{dev}_active_count attr —— sync 阶段数据质量校验结果（最可靠）
        2. all_ble imu_index —— BLE 实际传输的传感器（硬件真实工作的传感器）
        3. 已加载数据（质量过滤） —— 排除全零率和异常范围的传感器
        4. H5 attrs —— BLE 握手检测值
        5. 默认值 2

        传感器损坏判定（可视化侧）：
        - 非零率 < 10% → 疑似损坏（正常 IMU 几乎不会精确为零）
        - Acc 范围超过 ±8g → 字节错位导致垃圾数据
        - 方差 ≈ 0 → 传感器卡死
        """
        for dev in (1, 2):
            # 0. sync 阶段写入的活跃传感器计数（最高优先级）
            count_from_sync = 0
            active_key = f'imu{dev}_active_count'
            if active_key in self.h5_file.attrs:
                try:
                    count_from_sync = max(1, min(4, int(self.h5_file.attrs[active_key])))
                except (ValueError, TypeError):
                    pass

            # 1. 从 all_ble imu_index 推断 —— 硬件实际传输的传感器
            count_from_all_ble = 0
            all_name = f'imu{dev}_all_ble'
            if all_name in self.h5_file:
                ds = self.h5_file[all_name]
                if hasattr(ds, 'dtype') and ds.dtype.names and 'imu_index' in ds.dtype.names:
                    try:
                        max_idx = int(ds['imu_index'][:].max())
                        count_from_all_ble = max(1, min(4, max_idx + 1))
                    except Exception:
                        pass

            # 2. 从已加载数据推断（质量过滤：排除全零 + 异常范围 + 恒定值）
            count_from_data = 0
            for label in ('c', 'b', 'a'):
                d = getattr(self, f'imu{dev}{label}_data', None)
                if d is not None and len(d) > 0:
                    # 排除全零数据
                    if not np.any(d != 0):
                        continue
                    # 质量校验：非零率过低 → 疑似损坏
                    non_zero_rate = np.count_nonzero(d) / d.size if d.size > 0 else 0
                    if non_zero_rate < 0.05:
                        print(f'[CalibrateTool] ⚠️ IMU{dev}{label}: 非零率={non_zero_rate:.1%} (<5%)，'
                              f'疑似传感器损坏，跳过')
                        continue
                    # 质量校验：Acc 范围异常（正常 ±2g，超过 ±8g 基本可确定字节错位）
                    acc_range = float(np.max(d)) - float(np.min(d))
                    if acc_range > 16.0:
                        print(f'[CalibrateTool] ⚠️ IMU{dev}{label}: Acc范围={acc_range:.1f}g (>16g)，'
                              f'疑似字节错位导致垃圾数据，跳过')
                        continue
                    # 质量校验：方差为零 → 传感器卡死
                    if np.var(d) < 1e-10:
                        print(f'[CalibrateTool] ⚠️ IMU{dev}{label}: 方差≈0，传感器卡死，跳过')
                        continue
                    count_from_data = {'a': 1, 'b': 2, 'c': 3}[label]
                    break
            if count_from_data == 0:
                # 兜底：放宽条件（全零/低非零率也计入）
                for label in ('c', 'b', 'a'):
                    d = getattr(self, f'imu{dev}{label}_data', None)
                    if d is not None and len(d) > 0:
                        count_from_data = {'a': 1, 'b': 2, 'c': 3}[label]
                        break

            # 3. 从 H5 attrs 推断
            count_from_attrs = 0
            for attr_key in (f'imu{dev}_num_imus', 'num_imus'):
                val = self.h5_file.attrs.get(attr_key)
                if val is not None:
                    try:
                        count_from_attrs = max(1, min(4, int(val)))
                        break
                    except (ValueError, TypeError):
                        pass

            # 综合：sync 校验 > all_ble 实测 > 已加载数据 > attrs > 兜底 2
            count = count_from_sync or count_from_all_ble or count_from_data or count_from_attrs or 2

            # 诊断日志
            parts = []
            if count_from_sync:
                parts.append(f'sync={count_from_sync}')
            if count_from_all_ble:
                parts.append(f'all_ble={count_from_all_ble}')
            if count_from_data:
                parts.append(f'data={count_from_data}')
            if count_from_attrs:
                parts.append(f'attrs={count_from_attrs}')
            src = ' → '.join(parts) if parts else 'default'

            if count_from_sync > 0 and count_from_all_ble > 0 and count_from_sync != count_from_all_ble:
                print(f'[CalibrateTool] ⚠️ IMU{dev}: sync活跃={count_from_sync}, '
                      f'all_ble={count_from_all_ble}（不一致，可能有传感器损坏）')
            elif count_from_all_ble > 0 and count_from_attrs > 0 and count_from_all_ble != count_from_attrs:
                print(f'[CalibrateTool] ⚠️ IMU{dev}: all_ble={count_from_all_ble}, '
                      f'attrs={count_from_attrs}（可能被bin_sync覆写）')

            self.__dict__[f'imu{dev}_imu_count'] = count
            print(f'[CalibrateTool] IMU{dev} imu_count={count} (来源: {src})')

            # 计算通道标签信息（用于标题栏展示）
            ch_labels = ['a', 'b', 'c']
            # BLE 实际传输通道
            ble_chs = []
            all_name = f'imu{dev}_all_ble'
            if all_name in self.h5_file and self.h5_file[all_name].shape[0] > 0:
                ds = self.h5_file[all_name]
                if hasattr(ds, 'dtype') and ds.dtype.names and 'imu_index' in ds.dtype.names:
                    try:
                        indices = sorted(set(int(x) for x in ds['imu_index'][:]))
                        ble_chs = [ch_labels[i] for i in indices if i < len(ch_labels)]
                    except Exception:
                        pass
            # 同步后活跃通道（从 active_indices attr 或已加载数据反推）
            sync_chs = []
            active_indices_str = self.h5_file.attrs.get(f'imu{dev}_active_indices')
            if active_indices_str:
                try:
                    if isinstance(active_indices_str, bytes):
                        active_indices_str = active_indices_str.decode('utf-8')
                    import re
                    nums = re.findall(r'\d+', str(active_indices_str))
                    sync_chs = [ch_labels[int(n)] for n in nums if int(n) < len(ch_labels)]
                except Exception:
                    pass
            if not sync_chs:
                # 从已加载数据反推（哪些传感器有非零数据）
                for i, ch in enumerate(ch_labels):
                    d = getattr(self, f'imu{dev}{ch}_data', None)
                    if d is not None and len(d) > 0 and np.any(d != 0):
                        if i < count:  # 在 imu_count 范围内的才算
                            sync_chs.append(ch)

            setattr(self, f'_imu_dev{dev}_ble_channels', ble_chs)
            setattr(self, f'_imu_dev{dev}_sync_channels', sync_chs)

    def _update_imu_channel_labels(self):
        """更新 IMU 标题栏中 BLE / Sync 通道信息标签"""
        for dev in (1, 2):
            ble_chs = getattr(self, f'_imu_dev{dev}_ble_channels', [])
            sync_chs = getattr(self, f'_imu_dev{dev}_sync_channels', [])
            ble_str = f"BLE: {','.join(ble_chs)}" if ble_chs else ''
            sync_str = f"Sync: {','.join(sync_chs)}" if sync_chs else ''
            info = ' | '.join(filter(None, [ble_str, sync_str]))
            # Acc label
            lbl_acc = getattr(self, f'lbl_imu_acc_dev{dev}_info', None)
            if lbl_acc:
                lbl_acc.setText(info)
            # Gyr label
            lbl_gyr = getattr(self, f'lbl_imu_gyr_dev{dev}_info', None)
            if lbl_gyr:
                lbl_gyr.setText(info)

    def _extract_imu_acc(self, data):
        """从结构化数组或普通数组中提取IMU加速度数据；返回 (N, 3) 或 None"""
        if data is None or len(data) == 0:
            return None

        print(f'[CalibrateTool] IMU数据类型: {data.dtype}, 字段: {data.dtype.names}')

        if hasattr(data, 'dtype') and data.dtype.names is not None:
            if 'acc' in data.dtype.names:
                acc_data = data['acc']
                print(f'[CalibrateTool] acc字段 shape: {acc_data.shape}')
                if acc_data.ndim == 1:
                    # 结构化 acc 字段，每行是 tuple/list
                    result = np.array([list(row) for row in acc_data])
                else:
                    result = np.array(acc_data)
                print(f'[CalibrateTool] 提取后 shape: {result.shape}')
                return result
            # 尝试其他字段名
            for name in data.dtype.names:
                if 'acc' in name.lower():
                    return np.array(data[name])

        # 普通数组：假设前 3 列是加速度
        data_arr = np.array(data)
        if data_arr.ndim == 2 and data_arr.shape[1] >= 3:
            return data_arr[:, :3]
        if data_arr.ndim == 1:
            return data_arr.reshape(-1, 1)

        return data_arr

    def _extract_imu_gyr(self, data):
        """从结构化数组或普通数组中提取IMU角速度数据；返回 (N, 3) 或 None"""
        if data is None or len(data) == 0:
            return None

        if hasattr(data, 'dtype') and data.dtype.names is not None:
            if 'gyr' in data.dtype.names:
                gyr_data = data['gyr']
                if gyr_data.ndim == 1:
                    result = np.array([list(row) for row in gyr_data])
                else:
                    result = np.array(gyr_data)
                return result
            # all_ble 格式: acc_x, acc_y, acc_z, gyr_x, gyr_y, gyr_z...
            # 取第 3-5 列作为 gyr
            pass

        # 普通数组：取第 3-5 列（跳过前 3 列 acc）
        data_arr = np.array(data)
        if data_arr.ndim == 2 and data_arr.shape[1] >= 6:
            return data_arr[:, 3:6]
        if data_arr.ndim == 2 and data_arr.shape[1] >= 3:
            return data_arr[:, :3]  # assume first 3 cols (may be acc+gyr merged)
        if data_arr.ndim == 1:
            return data_arr.reshape(-1, 1)
        return data_arr

    def load_prompt_data(self):
        """加载Prompt标签数据"""
        self.prompt_names = None
        self.prompt_times = None

        try:
            if 'prompts' in self.h5_file:
                prompts_group = self.h5_file['prompts']
                if 'names' in prompts_group and 'times' in prompts_group:
                    # 读取names（可能是字符串数组）
                    names_data = prompts_group['names'][:]
                    # 处理字节字符串
                    if names_data.dtype.kind == 'S' or names_data.dtype.kind == 'O':
                        self.prompt_names = [n.decode('utf-8') if isinstance(n, bytes) else str(n) for n in names_data]
                    else:
                        self.prompt_names = [str(n) for n in names_data]

                    # 读取times（绝对时间戳数组）
                    raw_times = prompts_group['times'][:]

                    # 转换为相对时间（相对于统一会话起始时间，向后兼容 emg_start_time）
                    ref_time = self._ref_time()
                    if ref_time is not None:
                        self.prompt_times = raw_times - float(ref_time)
                        if self.session_start_unix is not None:
                            print(f'[CalibrateTool] Prompt时间已转换为相对时间 (参考: session_start_unix={ref_time:.3f})')
                        else:
                            print(f'[CalibrateTool] Prompt时间已转换为相对时间 (参考: emg_start_time={ref_time:.3f})')
                    else:
                        self.prompt_times = raw_times
                        print(f'[CalibrateTool] 警告: 未找到EMG起始时间，使用原始时间戳')

                    print(f'[CalibrateTool] 已加载 {len(self.prompt_names)} 个Prompt标签')
                    for i, (name, time) in enumerate(zip(self.prompt_names[:5], self.prompt_times[:5])):
                        print(f'  [{i}] {name}: {time:.3f}s')
                    if len(self.prompt_names) > 5:
                        print(f'  ... 共 {len(self.prompt_names)} 个')

                    # 重置prompt索引并更新UI
                    self.current_prompt_idx = 0
                    self._update_prompt_info()
        except Exception as e:
            print(f'[CalibrateTool] 加载Prompt数据失败: {e}')

    # ───────────────── 视频预览相关方法 ─────────────────

    def _find_video_files(self):
        """根据 H5 attrs 定位视频文件路径。

        查找策略（按优先级）：
        1. 从 H5 所在目录向上遍历，查找每一层的 video/ 子目录
        2. H5 同目录
        3. 绝对路径
        4. 同时尝试替换后缀（.avi ↔ .mp4 ↔ .mkv ↔ .mov）
        """
        video_files = {}
        if self.h5_file is None or self.h5_path is None:
            return video_files

        h5_dir = os.path.dirname(os.path.abspath(self.h5_path))

        # 构建搜索目录：从 H5 目录向上逐层查找 video/ 子目录
        search_dirs = []
        cur = os.path.abspath(h5_dir)
        project_root = None
        for _ in range(6):  # 最多向上 6 层
            # 当前层的 video/ 子目录
            video_sub = os.path.join(cur, 'video')
            if os.path.isdir(video_sub):
                search_dirs.append(video_sub)
            # 记录 storage/ 的上层目录作为项目根
            if os.path.basename(cur) == 'storage':
                project_root = os.path.dirname(cur)
                storage_video = os.path.join(cur, 'video')
                if os.path.isdir(storage_video) and storage_video not in search_dirs:
                    search_dirs.append(storage_video)
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
        # H5 同目录作为兜底
        if h5_dir not in search_dirs:
            search_dirs.append(h5_dir)

        # 备选视频后缀（用于替换不匹配的后缀）
        ALT_EXTENSIONS = ['.avi', '.mp4', '.mkv', '.mov', '.AVI', '.MP4', '.MKV', '.MOV']

        def _try_find_file(base_filename):
            """在搜索目录中定位文件，支持后缀替换"""
            base_name, base_ext = os.path.splitext(base_filename)
            # 候选文件名：原文件名 + 替换后缀的版本
            candidates = [base_filename]
            for alt_ext in ALT_EXTENSIONS:
                alt_name = base_name + alt_ext
                if alt_name not in candidates:
                    candidates.append(alt_name)

            for search_dir in search_dirs:
                for candidate in candidates:
                    full_path = os.path.normpath(os.path.join(search_dir, candidate))
                    if os.path.isfile(full_path):
                        return full_path
                    # 也尝试只用 basename
                    full_path = os.path.normpath(os.path.join(search_dir, os.path.basename(candidate)))
                    if os.path.isfile(full_path):
                        return full_path
            return None

        for side_key, attr_key in [('left', 'video_left'), ('right', 'video_right')]:
            filename = self.h5_file.attrs.get(attr_key)
            if filename is None:
                continue
            if isinstance(filename, bytes):
                filename = filename.decode('utf-8')
            filename = str(filename).strip()
            if not filename or filename == '-':
                continue

            found_path = _try_find_file(filename)

            # 如果文件路径本身就是绝对路径，直接使用
            if found_path is None and os.path.isabs(filename) and os.path.isfile(filename):
                found_path = filename

            if found_path:
                video_files[side_key] = found_path
                print(f'[CalibrateTool] 找到视频文件 ({side_key}): {found_path}')
            else:
                print(f'[CalibrateTool] 未找到视频文件 ({side_key}): {filename} '
                      f'(搜索目录: {[os.path.basename(d) or d for d in search_dirs[:3]]}...)')

        return video_files

    def _load_videos(self):
        """加载 H5 对应的视频文件"""
        self._close_videos()
        self.video_enabled = False

        if not HAS_CV2:
            print('[CalibrateTool] OpenCV (cv2) 未安装，跳过视频加载')
            self.lbl_video_left.setText('(需安装 opencv-python)')
            self.lbl_video_right.setText('(需安装 opencv-python)')
            return

        video_files = self._find_video_files()
        if not video_files:
            print('[CalibrateTool] 未找到关联视频文件')
            self.lbl_video_left.setText('(无视频)')
            self.lbl_video_right.setText('(无视频)')
            return

        # 读取 video_timing 组获取时间对齐信息
        vt_first = {}
        vt_last = {}
        vt_dur = {}
        if 'video_timing' in self.h5_file:
            try:
                vt = self.h5_file['video_timing']
                sides_raw = vt['sides'][()]
                firsts = np.atleast_1d(vt['first_frame_unix'][()])
                lasts = np.atleast_1d(vt['last_frame_unix'][()])
                durs = np.atleast_1d(vt['duration'][()])
                sides = [s.decode('utf-8') if isinstance(s, bytes) else str(s)
                         for s in np.atleast_1d(sides_raw)]
                for i, side in enumerate(sides):
                    if i < len(firsts):
                        vt_first[side] = float(firsts[i])
                        vt_last[side] = float(lasts[i])
                        vt_dur[side] = float(durs[i])
            except Exception as e:
                print(f'[CalibrateTool] 读取 video_timing 失败: {e}')

        for side, video_path in video_files.items():
            try:
                cap = cv2.VideoCapture(video_path)
                if not cap.isOpened():
                    print(f'[CalibrateTool] 无法打开视频 ({side}): {video_path}')
                    continue

                fps = cap.get(cv2.CAP_PROP_FPS)
                frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                reported_fps = fps
                seek_preroll = 0
                # 兜底：修复旧 AVI 文件 fps header 错误（600fps → 30fps）
                # 仅 nominal fps > 120 时触发（正常 USB 摄像头不会超过 120fps）
                if fps > 120:
                    actual_dur_from_timing = vt_dur.get(side, 0)
                    if actual_dur_from_timing > 0:
                        # 优先用 timing 数据推算正确值
                        corrected_fps = frame_count / actual_dur_from_timing
                        if 20 <= corrected_fps <= 60:
                            fps = corrected_fps
                        else:
                            fps = 30.0
                        frame_count = int(round(fps * actual_dur_from_timing))
                    else:
                        # 无 timing 数据：假定真实 fps=30，按比例修正帧数
                        fps = 30.0
                        frame_count = int(round(frame_count * 30.0 / 600.0))
                    # FFmpeg 生成的错误 AVI 通常为 600/30=20 倍时间基。
                    # OpenCV 时间 seek 会多解码 scale-1 帧，提前该数量即可
                    # 精确落到目标帧。该值由文件头和校正帧率动态推导。
                    seek_scale = max(1, int(round(reported_fps / max(fps, 1.0))))
                    seek_preroll = max(0, seek_scale - 1)
                    print(f'[CalibrateTool] 视频 fps 修正 ({side}): {cap.get(cv2.CAP_PROP_FPS):.0f} → {fps:.0f}, '
                          f'帧数: {int(cap.get(cv2.CAP_PROP_FRAME_COUNT))} → {frame_count}, '
                          f'seek预滚={seek_preroll}帧')
                self.video_caps[side] = cap
                self.video_fps[side] = fps if fps > 0 else 30.0
                self.video_frame_count[side] = frame_count
                self.video_seek_preroll[side] = seek_preroll
                self.video_first_frame_unix[side] = vt_first.get(side, 0)
                self.video_last_frame_unix[side] = vt_last.get(side, 0)
                self.video_duration[side] = vt_dur.get(
                    side, (max(0, frame_count - 1) / self.video_fps[side]
                           if fps > 0 else 0))
                self.video_timelines[side] = VideoTimeline.from_timing(
                    frame_count=frame_count,
                    reported_fps=self.video_fps[side],
                    first_time=self.video_first_frame_unix[side],
                    last_time=(self.video_last_frame_unix[side]
                               if self.video_last_frame_unix[side] > 0 else None),
                    duration=self.video_duration[side],
                )
                self._video_current_idx[side] = -1
                self._video_current_frame[side] = None
                self.video_enabled = True

                # 诊断：打印视频对齐信息（统一时钟参考 + EMG偏移）
                ref_time = self._ref_time()
                nominal_fps = self.video_fps[side]
                first_u = self.video_first_frame_unix[side]
                last_u = self.video_last_frame_unix[side]
                timeline = self.video_timelines[side]
                actual_dur = timeline.duration
                effective_fps = timeline.effective_fps
                vid_ref_offset = first_u - float(ref_time) if ref_time else 0
                emg_offset = first_u - self.emg_start_time if self.emg_start_time else 0

                print(f'[CalibrateTool] 视频已加载 ({side}): {os.path.basename(video_path)}')
                print(f'  名义FPS={nominal_fps:.1f}, 实际FPS={effective_fps:.2f}, 帧数={frame_count}')
                print(f'  first_unix={first_u:.3f}, last_unix={last_u:.3f}, dur={actual_dur:.3f}s')
                if self.session_start_unix is not None:
                    print(f'  会话起始={self.session_start_unix:.3f}, EMG起始={self.emg_start_time}')
                print(f'  视频-会话偏移={vid_ref_offset:+.3f}s, 视频-EMG偏移={emg_offset:+.3f}s')
            except Exception as e:
                print(f'[CalibrateTool] 加载视频失败 ({side}): {e}')

        # 更新 UI 状态
        if not self.video_enabled:
            self.lbl_video_left.setText('(无法加载视频)')
            self.lbl_video_right.setText('(无法加载视频)')
        else:
            for side in ('left', 'right'):
                if side in self.video_caps:
                    lbl = getattr(self, f'lbl_video_{side}')
                    lbl.setText('')
                    btn = getattr(self, f'btn_preview_{side}', None)
                    if btn:
                        btn.setEnabled(True)
            # 更新帧步信息提示
            if hasattr(self, 'lbl_step_info'):
                step_samples = self._get_frame_step_samples()
                step_ms = (step_samples / self._active_emg_sample_rate()) * 1000
                self.lbl_step_info.setToolTip(
                    f'1帧 ≈ {step_samples}样本 ({step_ms:.1f}ms) @ {self._active_emg_sample_rate()}Hz EMG')

    def _close_videos(self):
        """关闭所有视频文件"""
        for side, cap in self.video_caps.items():
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
        self.video_caps.clear()
        self.video_fps.clear()
        self.video_first_frame_unix.clear()
        self.video_last_frame_unix.clear()
        self.video_duration.clear()
        self.video_frame_count.clear()
        self.video_timelines.clear()
        self.video_seek_preroll.clear()
        self._video_current_frame.clear()
        self._video_current_idx.clear()
        self.video_enabled = False
        # 禁用预览按钮
        for side in ('left', 'right'):
            btn = getattr(self, f'btn_preview_{side}', None)
            if btn:
                btn.setEnabled(False)

    def _load_calibration_offset(self):
        """从 H5 attrs 读取精确对齐标定偏移量。

        H5 attrs 命名：
        - calib_offset_left: float (秒), 左手视频偏移量
        - calib_offset_right: float (秒), 右手视频偏移量
        - calib_present: 是否有标定数据（任一 side 有值即为 True）

        偏移量含义：calib_offset = video_frame_unix - prompt_unix
        正值 = 视频帧实际时间戳比 prompt 触发时刻晚（视频滞后于 EMG）
        负值 = 视频帧实际时间戳比 prompt 触发时刻早（视频超前于 EMG）
        在校正时：corrected_video_unix = target_unix + calib_offset
        即：EMG 数据在 target_unix 时，对应视频帧在 target_unix + calib_offset
        """
        self.calib_offset = {}
        self.calib_present = False

        if self.h5_file is None:
            return

        for side in ('left', 'right'):
            key = f'calib_offset_{side}'
            try:
                val = self.h5_file.attrs.get(key)
                if val is not None:
                    self.calib_offset[side] = float(val)
                    self.calib_present = True
                else:
                    self.calib_offset[side] = 0.0
            except Exception:
                self.calib_offset[side] = 0.0

        if self.calib_present:
            offset_info = ', '.join(
                f'{side}={self.calib_offset.get(side, 0):+.3f}s'
                for side in ('left', 'right')
            )
            print(f'[CalibrateTool] 🎯 精确对齐标定偏移量: {offset_info}')
        else:
            print('[CalibrateTool] 无精确对齐标定数据，偏移量默认=0')

    def _seek_video_frame(self, side, target_unix):
        """定位到指定 Unix 时间戳对应的视频帧，返回 (frame_idx, qimage)。

        使用视频文件自身的 timing 数据 (first/last_unix + frame_count)
        计算实际帧率，避免名义帧率偏差导致的累积漂移。

        Args:
            side: 'left' 或 'right'
            target_unix: 目标 Unix 时间戳

        Returns:
            (frame_idx, QImage) 或 (None, None)
        """
        cap = self.video_caps.get(side)
        if cap is None:
            return None, None

        total_frames = self.video_frame_count.get(side, 0)

        if total_frames <= 0:
            return None, None

        # 应用精确对齐标定偏移量
        calib_offset = self.calib_offset.get(side, 0)
        corrected_unix = target_unix + calib_offset

        timeline = self.video_timelines.get(side)
        if timeline is None:
            timeline = VideoTimeline.from_timing(
                total_frames, self.video_fps.get(side, 30.0),
                self.video_first_frame_unix.get(side, 0.0),
                self.video_last_frame_unix.get(side) or None,
                self.video_duration.get(side, 0.0),
            )
        frame_idx = timeline.time_to_frame(corrected_unix)
        effective_fps = timeline.effective_fps

        # 缓存检查：同一帧不需要重新 seek
        if frame_idx == self._video_current_idx.get(side, -1):
            cached = self._video_current_frame.get(side)
            if cached is not None:
                return frame_idx, cached

        # seek 到目标帧。旧 600fps 错误头 AVI 必须按时间定位；直接设置
        # CAP_PROP_POS_FRAMES 会把后段目标错误映射到视频开头。
        self._position_video_capture(side, frame_idx, effective_fps)
        ret, frame = cap.read()

        if not ret or frame is None:
            # 回退：seek 到最近的关键帧后逐帧解码
            # 先往回跳 50 帧，再逐帧前进
            fallback_start = max(0, frame_idx - 50)
            self._position_video_capture(side, fallback_start, effective_fps)
            for _ in range(frame_idx - fallback_start + 1):
                ret, frame = cap.read()
                if not ret:
                    break

        if not ret or frame is None:
            return None, None

        # BGR → RGB 转换
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        h, w, ch = frame_rgb.shape
        bytes_per_line = ch * w
        qimage = QImage(frame_rgb.data, w, h, bytes_per_line, QImage.Format_RGB888).copy()

        # 缓存
        self._video_current_idx[side] = frame_idx
        self._video_current_frame[side] = qimage

        return frame_idx, qimage

    def _position_video_capture(self, side, frame_idx, effective_fps=None):
        """将 VideoCapture 定位到实际帧号，兼容旧 600fps 错误头 AVI。"""
        cap = self.video_caps.get(side)
        if cap is None:
            return False

        frame_idx = max(0, int(frame_idx))
        preroll = self.video_seek_preroll.get(side, 0)
        if effective_fps is None or effective_fps <= 0:
            effective_fps = self.video_fps.get(side, 30.0)

        if preroll > 0 and frame_idx >= preroll:
            seek_seconds = (frame_idx - preroll) / effective_fps
            return bool(cap.set(cv2.CAP_PROP_POS_MSEC, seek_seconds * 1000.0))

        return bool(cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx))

    def _update_video_frames(self, target_unix):
        """更新左右视频 QLabel 显示。

        Args:
            target_unix: 当前 EMG/IMU 显示窗口对应的 Unix 时间戳（窗口中间位置）
        """
        if not self.video_enabled:
            return

        # 播放期间由 _on_playback_tick 直接驱动视频帧，跳过 seek 式更新
        if self.is_playing:
            return

        # 节流：拖动时减少视频更新频率
        now = time.time()
        throttle = (self._video_update_throttle_drag if self.is_dragging
                    else self._video_update_throttle_static)
        if now - self._last_video_update < throttle:
            return
        self._last_video_update = now

        for side in ('left', 'right'):
            lbl = getattr(self, f'lbl_video_{side}')
            lbl_time = getattr(self, f'lbl_video_{side}_time')
            if side not in self.video_caps:
                continue

            frame_idx, qimage = self._seek_video_frame(side, target_unix)

            if qimage is not None and frame_idx is not None:
                lbl_size = lbl.size()
                if lbl_size.width() > 50 and lbl_size.height() > 50:
                    scaled = qimage.scaled(lbl_size, Qt.KeepAspectRatio, Qt.SmoothTransformation)
                else:
                    scaled = qimage.scaled(qimage.width()//2, qimage.height()//2,
                                           Qt.KeepAspectRatio, Qt.SmoothTransformation)
                lbl.setPixmap(QPixmap.fromImage(scaled))

                # 更新时间标签，时间轴与寻帧共用同一个端点映射。
                timeline = self.video_timelines.get(side)
                if timeline is None:
                    timeline = VideoTimeline.from_timing(
                        self.video_frame_count.get(side, 0), self.video_fps.get(side, 30),
                        self.video_first_frame_unix.get(side, 0),
                        self.video_last_frame_unix.get(side) or None,
                        self.video_duration.get(side, 0),
                    )
                frame_unix = timeline.frame_to_time(frame_idx)
                eff_fps = timeline.effective_fps
                frame_time_sec = max(0.0, frame_unix - timeline.first_time)
                minutes = int(frame_time_sec // 60)
                seconds = int(frame_time_sec % 60)
                ms = int((frame_time_sec % 1) * 100)
                # EMG 相对时间（与 Prompt 时间戳对齐，含标定偏移）
                if self.emg_start_time is not None:
                    calib = self.calib_offset.get(side, 0)
                    emg_rel = frame_unix - float(self._ref_time()) - calib
                    if abs(calib) > 0.001:
                        lbl_time.setText(f'Frame #{frame_idx} | 视频 {minutes:02d}:{seconds:02d}.{ms:02d} | EMG {emg_rel:.2f}s | 标定{calib:+.3f}s')
                    else:
                        lbl_time.setText(f'Frame #{frame_idx} | 视频 {minutes:02d}:{seconds:02d}.{ms:02d} | EMG {emg_rel:.2f}s')
                else:
                    lbl_time.setText(f'Frame #{frame_idx} | 视频 {minutes:02d}:{seconds:02d}.{ms:02d}')
            else:
                lbl.setText('(无法定位帧)')
                lbl_time.setText('--:--')

    # ─────────── 视频方法结束 ───────────

    def calculate_y_limits(self):
        """计算全局Y轴范围（用于固定纵轴），使用 per-device LSB"""
        lsb_uv_1 = getattr(self, 'emg1_lsb_uv', calculate_lsb_uv())
        lsb_uv_2 = getattr(self, 'emg2_lsb_uv', calculate_lsb_uv())

        # EMG Y轴范围
        self.emg1_ylim = None
        self.emg2_ylim = None
        self.imu_ylim = None

        # 计算EMG1的范围
        if self.emg1_length > 0:
            sample_size = min(self.emg1_length, 50000)
            sampled_data, _ = self._read_emg_index_window(1, 0, sample_size)
            data_uv = sampled_data * lsb_uv_1
            try:
                filt = self.emg_filter_2k if self.emg1_sample_rate == 2000 else self.emg_filter_250
                filtered = filt.filter(data_uv)
                ymin, ymax = np.min(filtered), np.max(filtered)
                margin = (ymax - ymin) * 0.1
                self.emg1_ylim = (ymin - margin, ymax + margin)
            except:
                self.emg1_ylim = (np.min(sampled_data), np.max(sampled_data))
            print(f'[CalibrateTool] EMG1 Y轴范围: {self.emg1_ylim}')

        # 计算EMG2的范围
        if self.emg2_length > 0:
            sample_size = min(self.emg2_length, 50000)
            sampled_data, _ = self._read_emg_index_window(2, 0, sample_size)
            data_uv = sampled_data * lsb_uv_2
            try:
                filt = self.emg_filter_2k if self.emg2_sample_rate == 2000 else self.emg_filter_250
                filtered = filt.filter(data_uv)
                ymin, ymax = np.min(filtered), np.max(filtered)
                margin = (ymax - ymin) * 0.1
                self.emg2_ylim = (ymin - margin, ymax + margin)
            except:
                self.emg2_ylim = (np.min(sampled_data), np.max(sampled_data))
            print(f'[CalibrateTool] EMG2 Y轴范围: {self.emg2_ylim}')

        # 计算IMU的范围（Acc + Gyr 所有数据）
        all_imu_data = []
        for attr_pattern in ['imu{a}{b}_data', 'imu{a}{b}_gyr_data']:
            for dev in [1, 2]:
                for label in ['a', 'b', 'c']:
                    attr = attr_pattern.format(a=dev, b=label)
                    data = getattr(self, attr, None)
                    if data is not None and len(data) > 0:
                        all_imu_data.append(data)

        if all_imu_data:
            combined = np.vstack(all_imu_data)
            ymin, ymax = np.min(combined), np.max(combined)
            margin = (ymax - ymin) * 0.1
            self.imu_ylim = (ymin - margin, ymax + margin)
            print(f'[CalibrateTool] IMU Y轴范围: {self.imu_ylim}')

    def get_max_data_length(self):
        """获取最大数据长度"""
        _, primary_rate, origin, end = self._emg_session_bounds()
        result = max(1, int(np.ceil((end - origin) * primary_rate)) + 1) if end is not None else 0
        if self.emg1_length > 0:
            print(f'[CalibrateTool] EMG1数据长度: {self.emg1_length}')
        if self.emg2_length > 0:
            print(f'[CalibrateTool] EMG2数据长度: {self.emg2_length}')
        print(f'[CalibrateTool] 最大数据长度: {result}')
        return result

    def on_slider_pressed(self):
        """滑块按下开始拖动"""
        # 用户手动拖动时停止自动播放
        if self.is_playing:
            self._stop_playback()
        if self.is_full_playing:
            self._stop_full_playback()
        self.is_dragging = True

    def on_slider_released(self):
        """滑块释放结束拖动，执行精确更新"""
        self.is_dragging = False
        # 重置视频更新节流，确保释放时立即刷新视频帧
        self._last_video_update = 0
        # 立即执行完整更新
        self.update_timer.stop()
        self._do_update_plots()

    def on_slider_changed(self, value):
        """滑块值改变 - debounce 防抖，拖动 100ms / 点按 40ms"""
        self.current_pos = int(value)
        self.lbl_pos.setText(f'位置: {self.current_pos}')
        delay = 100 if self.is_dragging else 40
        self.update_timer.start(delay)

    def _do_update_plots(self):
        """执行实际的图表更新"""
        self.update_plots()

    def on_window_changed(self, value):
        """窗口大小改变"""
        self.window_size = value
        self._update_window_sec_label()
        max_len = self.get_max_data_length()
        self.slider.setMaximum(max(0, max_len - self.window_size))
        self.update_timer.start(40)

    def _display_time_window(self):
        """Return the visible interval in the shared session-relative clock."""
        _, rate, origin, _ = self._emg_session_bounds()
        rel_start = origin + self.current_pos / float(rate)
        return rel_start, rel_start + self.window_size / float(rate)

    def _emg_session_bounds(self):
        """Return primary rate and min/max real time across both EMG devices."""
        entries = []
        reference = self._ref_time()
        reference = float(reference) if reference is not None else 0.0
        for device in (1, 2):
            dataset, length, rate, first_time, has_time = self._emg_dataset_info(device)
            if dataset is None or length <= 0:
                continue
            axis = self._emg_time_axis(device) if has_time else None
            if axis is not None and len(axis):
                absolute = self._time_axis_is_absolute(axis)
                first = float(axis[0]) - reference if absolute else float(axis[0])
                last = float(axis[-1]) - reference if absolute else float(axis[-1])
            else:
                first = ((float(first_time) - reference)
                         if first_time is not None else 0.0)
                last = first + max(0, length - 1) / float(rate)
            entries.append((rate, first, last))
        if not entries:
            return 0, 2000, 0.0, 0.0
        primary_rate = int(entries[0][0])
        origin = min(item[1] for item in entries)
        end = max(item[2] for item in entries)
        return 0, primary_rate, origin, end

    def update_plots(self):
        """更新所有图表"""
        # 没有打开文件时不绘制
        if self.h5_file is None:
            return
        fast_mode = self.is_dragging
        self.update_emg_plot(fast_mode)
        self.update_imu_plot(fast_mode)

        # 视频帧同步更新
        if self.video_enabled and self._ref_time() is not None:
            time_start, time_end = self._display_time_window()
            target_unix = float(self._ref_time()) + (time_start + time_end) / 2.0
            self._update_video_frames(target_unix)

    def _downsample_for_plot(self, data, max_points):
        """降采样到最多 max_points 个点，返回 (data_downsampled, step)"""
        if data is None or len(data) == 0:
            return data, 1
        step = max(1, int(np.ceil(len(data) / max_points)))
        return data[::step], step

    def update_emg_plot(self, fast_mode=False):
        """更新EMG图表 — 根据 view_mode 分发"""
        if self.view_mode == 'stacked':
            self._draw_emg_stacked(fast_mode)
        else:
            self._draw_emg_subplots(fast_mode)

    def _draw_emg_stacked(self, fast_mode=False):
        """供应商风格堆叠视图：每设备 1 个 Axes，16 通道同轴堆叠 Offset=offset_uv"""
        ax1 = getattr(self, 'ax_emg1_stacked', None)
        ax2 = getattr(self, 'ax_emg2_stacked', None)
        if ax1 is None and ax2 is None:
            return
        if ax1: ax1.clear()
        if ax2: ax2.clear()

        time_start, time_end = self._display_time_window()
        use_filter = self.chk_filter.isChecked() and not fast_mode
        max_plot_points = self.max_plot_points_fast if fast_mode else self.max_plot_points_normal
        colors = plt.cm.tab20(np.linspace(0, 1, 16))
        offset = self.offset_uv
        clip_limit = offset * 0.48  # 供应商 clamp 阈值

        def _draw_device(ax, device, lsb, label, invert_channels=False):
            if ax is None or self._emg_dataset_info(device)[1] <= 0:
                return
            _, _, sample_rate, _, _ = self._emg_dataset_info(device)
            filter_padding = 0 if not use_filter else min(0.5, max(0.05, 0.25))
            region, region_times = self._read_emg_time_window(
                device, time_start, time_end, filter_padding)
            if len(region) == 0:
                return
            data_uv = region.astype(np.float64) * lsb
            if use_filter and len(data_uv) > 50:
                try:
                    filt = self.emg_filter_2k if sample_rate == 2000 else self.emg_filter_250
                    data_uv = filt.filter(data_uv)
                except Exception as e:
                    print(f'[CalibrateTool] {label} 滤波失败: {e}')
            if filter_padding > 0 and len(region_times) > 0:
                left = np.searchsorted(region_times, time_start, side='left')
                right = np.searchsorted(region_times, time_end, side='right')
                data_uv = data_uv[left:right]
                region_times = region_times[left:right]
            data_uv, step = self._downsample_for_plot(data_uv, max_plot_points)
            x = region_times[::step][:len(data_uv)] if len(region_times) else np.empty(0)
            if len(x) != len(data_uv):
                x = np.linspace(time_start, time_end, len(data_uv)) if len(data_uv) else x
            num_ch = min(16, data_uv.shape[1] if data_uv.ndim > 1 else 1)
            ch_order = range(num_ch - 1, -1, -1) if invert_channels else range(num_ch)
            for i, ch in enumerate(ch_order):
                ch_data = data_uv[:, ch] if data_uv.ndim > 1 else data_uv
                y = ch_data + (15 - i) * offset
                if self.clamp_enabled:
                    y = np.clip(y, (15 - i) * offset - clip_limit, (15 - i) * offset + clip_limit)
                ax.plot(x, y, color=colors[ch], linewidth=0.5)

            ax.set_xlim(time_start, time_end)
            ax.set_xlabel('时间 (秒)', fontsize=8)
            # Y 轴：CH1-CH16 标签
            y_ticks = [i * offset for i in range(16)]
            y_labels = [f'CH{i+1}' for i in range(16)]
            ax.set_yticks(y_ticks)
            ax.set_yticklabels(y_labels, fontsize=6)
            total_height = 16 * offset
            ax.set_ylim(-offset * 0.3, total_height - offset * 0.7)
            ax.set_autoscale_on(False)  # 禁止自动缩放，防止工具栏或 resize 改变视图
            # 播放红线：窗口中央 = 当前时间
            if self.is_full_playing or self._show_position_line:
                window_center = (time_start + time_end) / 2.0
                ax.axvline(x=window_center, color='#e74c3c', linewidth=2.0, alpha=0.9, zorder=10)
            title_suffix = '滤波后' if use_filter else '原始'
            ax.set_title(f'{label} — {title_suffix} (Offset={offset}uV)', fontsize=10, pad=5)
            self.draw_prompt_markers(ax, time_start, time_end, show_text=True)

        _draw_device(ax1, 1, self.emg1_lsb_uv, '左手 EMG')
        _draw_device(ax2, 2, self.emg2_lsb_uv, '右手 EMG')
        self.canvas_emg.draw_idle()

    def _draw_emg_subplots(self, fast_mode=False):
        """分通道子图模式（保留原逻辑）"""
        # 清除所有通道的图表
        for ax in self.ax_emg1_channels + self.ax_emg2_channels:
            ax.clear()

        start = self.current_pos
        end = start + self.window_size
        lsb_uv_1 = getattr(self, 'emg1_lsb_uv', calculate_lsb_uv())
        lsb_uv_2 = getattr(self, 'emg2_lsb_uv', calculate_lsb_uv())
        use_filter = self.chk_filter.isChecked() and not fast_mode
        time_start, time_end = self._display_time_window()
        max_plot_points = self.max_plot_points_fast if fast_mode else self.max_plot_points_normal
        colors = plt.cm.tab20(np.linspace(0, 1, 16))

        def _draw_channels(device, axes_list, lsb):
            if self._emg_dataset_info(device)[1] <= 0:
                return
            _, _, sample_rate, _, _ = self._emg_dataset_info(device)
            filter_padding = 0 if not use_filter else 0.25
            data_padded, times_padded = self._read_emg_time_window(
                device, time_start, time_end, filter_padding)
            if len(data_padded) == 0:
                return
            data_uv_padded = data_padded * lsb
            if use_filter and len(data_uv_padded) > 50:
                try:
                    filt = self.emg_filter_2k if sample_rate == 2000 else self.emg_filter_250
                    data_uv_padded = filt.filter(data_uv_padded)
                except Exception as e:
                    print(f'[CalibrateTool] 滤波失败: {e}')
            left = np.searchsorted(times_padded, time_start, side='left')
            right = np.searchsorted(times_padded, time_end, side='right')
            data_uv = data_uv_padded[left:right]
            times = times_padded[left:right]
            data_uv, step = self._downsample_for_plot(data_uv, max_plot_points)
            x = times[::step][:len(data_uv)] if len(times) else np.empty(0)
            if len(x) != len(data_uv):
                x = np.linspace(time_start, time_end, len(data_uv)) if len(data_uv) else x
            num_channels = min(16, data_uv.shape[1] if data_uv.ndim > 1 else 1)
            for ch in range(num_channels):
                ax = axes_list[ch]
                if data_uv.ndim > 1:
                    ax.plot(x, data_uv[:, ch], color=colors[ch], linewidth=0.5)
                else:
                    ax.plot(x, data_uv, color=colors[0], linewidth=0.5)

        _draw_channels(1, self.ax_emg1_channels, lsb_uv_1)
        _draw_channels(2, self.ax_emg2_channels, lsb_uv_2)

        # 设置每个通道的属性
        for i in range(16):
            ax1 = self.ax_emg1_channels[i]
            ax2 = self.ax_emg2_channels[i]
            ax1.set_ylabel(f'{i}', fontsize=7, rotation=0, labelpad=10)
            ax1.tick_params(axis='y', labelsize=5, length=2)
            ax1.tick_params(axis='x', labelsize=5)
            ax1.set_xlim(time_start, time_end)
            ax1.spines['top'].set_visible(False)
            ax1.spines['right'].set_visible(False)
            if i < 15:
                ax1.set_xticklabels([])
                ax1.spines['bottom'].set_visible(False)
                ax1.tick_params(axis='x', length=0)
            ax2.tick_params(axis='y', labelsize=5, length=2)
            ax2.tick_params(axis='x', labelsize=5)
            ax2.set_yticklabels([])
            ax2.set_xlim(time_start, time_end)
            ax2.spines['top'].set_visible(False)
            ax2.spines['right'].set_visible(False)
            ax2.spines['left'].set_visible(False)
            if i < 15:
                ax2.set_xticklabels([])
                ax2.spines['bottom'].set_visible(False)
                ax2.tick_params(axis='x', length=0)
            # 播放红线（仅第一个通道显示，避免重复）
            if (self.is_full_playing or self._show_position_line) and i == 0:
                window_center = (time_start + time_end) / 2.0
                ax1.axvline(x=window_center, color='#e74c3c', linewidth=2.0, alpha=0.9, zorder=10)
                ax2.axvline(x=window_center, color='#e74c3c', linewidth=2.0, alpha=0.9, zorder=10)
            self.draw_prompt_markers(ax1, time_start, time_end, show_text=(i == 0))
            self.draw_prompt_markers(ax2, time_start, time_end, show_text=(i == 0))

        title_suffix = '滤波后' if use_filter else '原始'
        self.ax_emg1_channels[0].set_title(f'EMG1 (16通道) - {title_suffix}', fontsize=10, pad=5)
        self.ax_emg2_channels[0].set_title(f'EMG2 (16通道) - {title_suffix}', fontsize=10, pad=5)
        self.ax_emg1_channels[-1].set_xlabel('时间 (秒)', fontsize=8)
        self.ax_emg2_channels[-1].set_xlabel('时间 (秒)', fontsize=8)
        self.canvas_emg.draw_idle()

    def update_imu_plot(self, fast_mode=False):
        """供应商风格 IMU 显示：Acc + Gyr 堆叠图，每图同轴 XYZ 通道 × 多 IMU"""
        # 更新标题栏通道信息标签
        self._update_imu_channel_labels()
        # 清除
        for ax_name in ('ax_imu_acc_dev1', 'ax_imu_acc_dev2', 'ax_imu_gyr_dev1', 'ax_imu_gyr_dev2'):
            ax = getattr(self, ax_name, None)
            if ax: ax.clear()

        start = self.current_pos
        emg_sample_rate = self._active_emg_sample_rate()
        # 显示窗口使用统一会话相对时间；EMG1/EMG2 可有不同采样率和起点。
        time_start, time_end = self._display_time_window()
        max_plot_points = self.max_plot_points_fast if fast_mode else self.max_plot_points_normal
        imu_sample_rate = 100  # IMU 默认采样率，用于 fallback 时的索引映射

        axis_colors = ['#d62728', '#2ca02c', '#1f77b4']  # XYZ: 红绿蓝
        axis_names = ['X', 'Y', 'Z']
        # IMU 线型: solid / dashed / dotted
        imu_styles = ['-', '--', ':']

        # 诊断: 打印当前已加载 IMU 数据的概要
        _diag_printed = getattr(self, '_imu_diag_printed', False)
        if not _diag_printed:
            self._imu_diag_printed = True
            labels = ['a', 'b', 'c']
            for dev_id in [1, 2]:
                for suffix, data_type in [('data', 'Acc'), ('gyr_data', 'Gyr')]:
                    for label in labels:
                        attr = f'imu{dev_id}{label}_{suffix}'
                        d = getattr(self, attr, None)
                        time_attr = f'imu{dev_id}{label}_time'
                        t = getattr(self, time_attr, None)
                        if d is not None and len(d) > 0:
                            print(f'[CalibrateTool] IMU诊断 {attr}: shape={d.shape}, '
                                  f'range=[{np.min(d):.4f}, {np.max(d):.4f}], '
                                  f'time_len={len(t) if t is not None else "N/A"}, '
                                  f'time_range=[{t[0]:.2f}, {t[-1]:.2f}]' if t is not None and len(t) > 0 else 'time=N/A')

        def _get_sensor_window(dev_id, label):
            """根据单个 IMU 传感器的时间字段获取当前窗口内的数据切片索引。
            每个传感器独立计算，避免不同传感器时间/长度差异导致的数据错位。"""
            time_attr = f'imu{dev_id}{label}_time'
            imu_time = getattr(self, time_attr, None)
            if imu_time is not None and len(imu_time) > 0:
                mask = (imu_time >= time_start) & (imu_time <= time_end)
                indices = np.where(mask)[0]
                if len(indices) > 0:
                    return indices, imu_time[indices]
                # 有真实时间但窗口为空时保持空，避免把不相邻的数据误画进来。
                return np.empty(0, dtype=int), np.empty(0, dtype=np.float64)
            # 只有没有 time 字段时才按采样率比例映射。
            imu_start = int(time_start * imu_sample_rate)
            imu_end = int(time_end * imu_sample_rate)
            imu_start = max(0, imu_start)
            imu_end = max(imu_start + 1, imu_end)
            indices = np.arange(imu_start, imu_end)
            return indices, None

        def _draw_imu_device(ax, dev_id, imu_count, data_attr, offset):
            """在 ax 上画 dev_id 的 acc 或 gyr 数据 (供应商堆叠，自动 Y 轴范围)
            每个 IMU 传感器独立计算时间窗口，避免跨传感器索引错位。"""
            if ax is None:
                return
            labels = ['a', 'b', 'c']
            all_y_min = []
            all_y_max = []
            any_drawn = False
            for imu_idx in range(imu_count):
                label = labels[imu_idx]
                attr = f'imu{dev_id}{label}_{data_attr}'
                data = getattr(self, attr, None)
                if data is None or len(data) == 0:
                    continue
                # 每个传感器独立获取时间窗口内的索引
                sensor_indices, sensor_times = _get_sensor_window(dev_id, label)
                if len(sensor_indices) == 0:
                    continue
                # 过滤越界索引
                valid_mask = sensor_indices < len(data)
                imu_idx_subset = sensor_indices[valid_mask]
                if len(imu_idx_subset) == 0:
                    continue
                imu_t_subset = sensor_times[valid_mask] if sensor_times is not None else None
                chunk = data[imu_idx_subset]
                if len(chunk) == 0:
                    continue
                chunk, step = self._downsample_for_plot(chunk, max_plot_points)
                # X 轴：优先用 IMU time，否则线性插值
                if imu_t_subset is not None and len(imu_t_subset) > 0:
                    t_sub = imu_t_subset[::step] if step > 1 else imu_t_subset
                    x = t_sub[:len(chunk)]
                else:
                    x = np.linspace(time_start, time_start + len(chunk) * step / imu_sample_rate, len(chunk))
                num_axis = min(3, chunk.shape[1] if chunk.ndim > 1 else 1)
                for axis_idx in range(num_axis):
                    ch_data = chunk[:, axis_idx] if chunk.ndim > 1 else chunk
                    y = ch_data + (2 - axis_idx) * offset  # X=2*offset(top), Z=0*offset(bottom)
                    ax.plot(x, y, color=axis_colors[axis_idx],
                            linestyle=imu_styles[imu_idx % 3], linewidth=0.8)
                    all_y_min.append(float(np.min(y)))
                    all_y_max.append(float(np.max(y)))
                any_drawn = True

            if not any_drawn:
                # 无数据可画时，仍设好 x 轴范围避免空白图看起来像 bug
                ax.set_xlim(time_start, time_end)

            ax.set_xlim(time_start, time_end)
            ax.set_xlabel('时间 (秒)', fontsize=8)
            # Y轴标签: 在各通道基线处
            y_ticks = [i * offset for i in range(3)]
            y_labels = [f'{axis_names[i]}' for i in range(3)]
            ax.set_yticks(y_ticks)
            ax.set_yticklabels(y_labels, fontsize=7)
            # 自动 Y 轴范围 — 根据实际数据缩放，加 10% margin
            if all_y_min and all_y_max:
                ymin, ymax = min(all_y_min), max(all_y_max)
                margin = max((ymax - ymin) * 0.1, offset * 0.1)
                ax.set_ylim(ymin - margin, ymax + margin)
            else:
                ax.set_ylim(-offset * 0.2, 3 * offset - offset * 0.2)
            dev_label = '左手' if dev_id == 1 else '右手'
            # 线型图例
            legend_lines = []
            legend_labels_list = []
            for imu_idx in range(imu_count):
                legend_lines.append(Line2D([0], [0], color='gray', linestyle=imu_styles[imu_idx % 3], linewidth=1))
                legend_labels_list.append(f'IMU{imu_idx+1}')
            if legend_lines:
                ax.legend(legend_lines, legend_labels_list, fontsize=6, loc='upper right')
            # 标题：设备 + IMU数量 + BLE通道 + 同步通道
            ble_chs = getattr(self, f'_imu_dev{dev_id}_ble_channels', [])
            sync_chs = getattr(self, f'_imu_dev{dev_id}_sync_channels', [])
            title_parts = [f'{dev_label} ({imu_count}IMU)']
            if ble_chs:
                title_parts.append(f'BLE: {",".join(ble_chs)}')
            if sync_chs:
                title_parts.append(f'Sync活跃: {",".join(sync_chs)}')
            ax.set_title(' | '.join(title_parts), fontsize=9, pad=3)
            # 播放红线
            if self.is_full_playing or self._show_position_line:
                window_center = (time_start + time_end) / 2.0
                ax.axvline(x=window_center, color='#e74c3c', linewidth=2.0, alpha=0.9, zorder=10)
            self.draw_prompt_markers(ax, time_start, time_end, show_text=True)
            return any_drawn

        # ── Acc 图 ──
        d1 = _draw_imu_device(getattr(self, 'ax_imu_acc_dev1', None), 1, self.imu1_imu_count, 'data', self.imu_acc_offset)
        d2 = _draw_imu_device(getattr(self, 'ax_imu_acc_dev2', None), 2, self.imu2_imu_count, 'data', self.imu_acc_offset)
        any_acc_drawn = d1 or d2
        self.fig_imu_acc.suptitle('加速度 (g)', fontsize=11, fontweight='bold')
        self.canvas_imu_acc.draw_idle()

        # ── Gyr 图 ──
        d3 = _draw_imu_device(getattr(self, 'ax_imu_gyr_dev1', None), 1, self.imu1_imu_count, 'gyr_data', self.imu_gyr_offset)
        d4 = _draw_imu_device(getattr(self, 'ax_imu_gyr_dev2', None), 2, self.imu2_imu_count, 'gyr_data', self.imu_gyr_offset)
        any_gyr_drawn = d3 or d4
        self.fig_imu_gyr.suptitle('角速度 (deg/s)', fontsize=11, fontweight='bold')
        self.canvas_imu_gyr.draw_idle()

        # 运行时诊断：连续多次无数据绘制时打印详情
        if not any_acc_drawn and not any_gyr_drawn:
            self._imu_diag_strike += 1
        else:
            self._imu_diag_strike = 0
        if self._imu_diag_strike == 5:
            # 连续 5 帧无 IMU 数据 → 诊断
            labels = ['a', 'b', 'c']
            loaded_attrs = []
            for dev_id in [1, 2]:
                for suffix in ['data', 'gyr_data']:
                    for label in labels:
                        attr = f'imu{dev_id}{label}_{suffix}'
                        d = getattr(self, attr, None)
                        if d is not None and len(d) > 0:
                            loaded_attrs.append(f'{attr}({d.shape})')
            print(f'[CalibrateTool] ⚠️ IMU无数据绘制(连续{self._imu_diag_strike}帧)')
            print(f'  已加载属性: {loaded_attrs if loaded_attrs else "无"}')
            print(f'  窗口: [{time_start:.2f}, {time_end:.2f}]s, start={start}, emg_rate={emg_sample_rate}')
            print(f'  IMU计数: dev1={self.imu1_imu_count}, dev2={self.imu2_imu_count}')
            if loaded_attrs:
                # 对已加载的属性，检查它们的 time 属性
                for attr_short in loaded_attrs[:3]:
                    parts = attr_short.split('(')[0]  # e.g., 'imu1a_data'
                    base = parts.rsplit('_', 1)[0] if '_data' in parts or '_gyr' in parts else parts
                    # derive time attr name: imu1a_data -> imu1a_time, imu1a_gyr_data -> imu1a_time
                    if base.endswith('_gyr'):
                        time_key = base.replace('_gyr', '')
                    else:
                        time_key = base
                    t_attr = f'{time_key}_time'
                    t = getattr(self, t_attr, None)
                    if t is not None and len(t) > 0:
                        print(f'  {time_key}_time: [{t[0]:.2f}, {t[-1]:.2f}]s, len={len(t)}')
                    else:
                        print(f'  {time_key}_time: None (将使用fallback索引映射)')

    def draw_prompt_markers(self, ax, time_start, time_end, show_text=True):
        """在图表上绘制Prompt标签

        - 红线上方：prompt 名称
        - 红线下方：时间戳 (s)
        - 窗口内 ≥2 个 prompt：标注 start/end 时间 + 间隔
        """
        if self.prompt_names is None or self.prompt_times is None:
            return

        ylim = ax.get_ylim()
        y_range = ylim[1] - ylim[0]

        # 收集当前窗口内的 prompt
        in_window = []
        for prompt_idx, (name, t) in enumerate(zip(self.prompt_names, self.prompt_times)):
            if time_start <= t <= time_end:
                in_window.append((prompt_idx, name, float(t)))

        if not in_window:
            return

        n = len(in_window)
        first_t = in_window[0][2]
        last_t = in_window[-1][2]

        for prompt_idx, name, t in in_window:
            # 红色虚线
            ax.axvline(x=t, color='red', linestyle='--', linewidth=1, alpha=0.7)

            if not show_text:
                continue

            # 上方：名称（换行处理）
            max_chars = 8
            label = f'{prompt_idx + 1}. {name}'
            if len(label) > max_chars:
                wrapped_name = '\n'.join([label[i:i+max_chars] for i in range(0, len(label), max_chars)])
            else:
                wrapped_name = label
            ax.text(t, ylim[1] - y_range * 0.02, wrapped_name,
                    rotation=0, verticalalignment='bottom', horizontalalignment='left',
                    fontsize=11, color='#c0392b', alpha=1.0, fontweight='bold',
                    bbox=dict(boxstyle='round,pad=0.3', facecolor='#fff3cd', alpha=0.9,
                              edgecolor='#e74c3c', linewidth=1.2))

            # 下方：时间戳（大字醒目）
            ax.text(t, ylim[0] + y_range * 0.02, f'{t:.2f}s',
                    rotation=0, verticalalignment='top', horizontalalignment='left',
                    fontsize=13, color='#c0392b', alpha=0.9, style='italic',
                    fontweight='bold')

        # 仅当窗口内存在 start/end 配对时才标注间隔
        if n >= 2 and show_text:
            # 查找配对：相邻 prompt 中基础名称相同、仅 start/end 后缀不同
            pair_start_idx = -1
            pair_end_idx = -1
            SUFFIX_PAIRS = [('start', 'end'), ('开始', '结束'), ('_s', '_e')]
            for i in range(n - 1):
                na = in_window[i][1].lower()
                nb = in_window[i + 1][1].lower()
                for sa, sb in SUFFIX_PAIRS:
                    ba = na.replace(sa, '').rstrip('_')
                    bb = nb.replace(sb, '').rstrip('_')
                    if ba and ba == bb:
                        pair_start_idx = i
                        pair_end_idx = i + 1
                        break
                    ba2 = na.replace(sb, '').rstrip('_')
                    bb2 = nb.replace(sa, '').rstrip('_')
                    if ba2 and ba2 == bb2:
                        pair_start_idx = i
                        pair_end_idx = i + 1
                        break
                if pair_start_idx >= 0:
                    break

            if pair_start_idx >= 0:
                interval = in_window[pair_end_idx][2] - in_window[pair_start_idx][2]
                ax.text(in_window[pair_start_idx][2], ylim[0] + y_range * 0.08,
                        f'start: {in_window[pair_start_idx][2]:.2f}s',
                        fontsize=11, color='#e74c3c', alpha=0.9,
                        fontweight='bold', style='italic')
                ax.text(in_window[pair_end_idx][2], ylim[0] + y_range * 0.08,
                        f'end: {in_window[pair_end_idx][2]:.2f}s',
                        fontsize=11, color='#e74c3c', alpha=0.9,
                        fontweight='bold', style='italic',
                        horizontalalignment='right')
                mid_t = (in_window[pair_start_idx][2] + in_window[pair_end_idx][2]) / 2.0
                ax.annotate(f'Δ {interval:.2f}s',
                            xy=(mid_t, ylim[1] - y_range * 0.02),
                            fontsize=12, color='#d63031', alpha=0.9,
                            fontweight='bold',
                            ha='center', va='bottom',
                            bbox=dict(boxstyle='round,pad=0.3', facecolor='#ffeaa7', alpha=0.85, edgecolor='#fdcb6e'))

    def goto_prev_prompt(self):
        """跳转到上一个Prompt"""
        if self.prompt_times is None or len(self.prompt_times) == 0:
            return

        if self.current_prompt_idx > 0:
            self.current_prompt_idx -= 1
            self._jump_to_prompt(self.current_prompt_idx)

    def goto_next_prompt(self):
        """跳转到下一个Prompt"""
        if self.prompt_times is None or len(self.prompt_times) == 0:
            return

        if self.current_prompt_idx < len(self.prompt_times) - 1:
            self.current_prompt_idx += 1
            self._jump_to_prompt(self.current_prompt_idx)

    def _jump_to_prompt(self, idx):
        """跳转到指定索引的Prompt位置"""
        if self.prompt_times is None or idx < 0 or idx >= len(self.prompt_times):
            return

        # 获取prompt时间（秒）
        prompt_time = self.prompt_times[idx]

        # 转换为采样点位置
        sample_rate = self._active_emg_sample_rate()
        _, _, origin, _ = self._emg_session_bounds()
        sample_pos = int((float(prompt_time) - origin) * sample_rate)

        # 将 prompt 放在窗口正中间，视频帧时间与 prompt 时间戳对齐
        target_pos = sample_pos - self.window_size // 2

        # 限制范围
        max_pos = self.slider.maximum()
        target_pos = max(0, min(target_pos, max_pos))

        # 先停止当前播放（如果有的话）
        if self.is_playing:
            self._stop_playback()
        if self.is_full_playing:
            self._stop_full_playback()

        # 更新滑块位置（会触发update_plots）
        self.slider.setValue(target_pos)

        # 更新prompt信息显示
        self._update_prompt_info()

    def _update_prompt_info(self):
        """更新Prompt信息显示"""
        if self.prompt_times is None or len(self.prompt_times) == 0:
            self.lbl_prompt_info.setText('Prompt: -/-')
            self.btn_prev_prompt.setEnabled(False)
            self.btn_next_prompt.setEnabled(False)
            return

        total = len(self.prompt_times)
        current = self.current_prompt_idx + 1
        name = self.prompt_names[self.current_prompt_idx] if self.prompt_names else ''

        # 截断过长的名称
        if len(name) > 15:
            name = name[:12] + '...'

        self.lbl_prompt_info.setText(f'Prompt: {current}/{total} ({name})')
        self.btn_prev_prompt.setEnabled(self.current_prompt_idx > 0)
        self.btn_next_prompt.setEnabled(self.current_prompt_idx < total - 1)

    # ───────────────── 视频 2s 预览 ─────────────────

    def _start_preview(self, side):
        """开始 2s 预览：仅播放指定侧视频当前帧向后 2 秒"""
        if self.is_playing:
            self._stop_playback()
            return
        cap = self.video_caps.get(side)
        if cap is None or self.h5_file is None:
            return

        # 直接根据当前数据窗口重新计算起播帧，避免 Prompt/滑块刚跳转时
        # 40ms 防抖刷新尚未执行，误用上一次缓存的视频帧。
        current_idx = self._video_current_idx.get(side, -1)
        if self._ref_time() is not None:
            time_start, time_end = self._display_time_window()
            target_unix = float(self._ref_time()) + (time_start + time_end) / 2.0
            resolved_idx, _ = self._seek_video_frame(side, target_unix)
            if resolved_idx is not None:
                current_idx = resolved_idx
        if current_idx < 0:
            return
        total_frames = self.video_frame_count.get(side, 0)
        timeline = self.video_timelines.get(side)
        effective_fps = (timeline.effective_fps if timeline is not None
                         else self.video_fps.get(side, 30.0))
        self._position_video_capture(side, current_idx, effective_fps)
        # 读取当前帧以校准顺序解码位置，下一次 read() 将得到 current_idx + 1。
        seek_ok, _ = cap.read()
        if not seek_ok:
            return

        fps = effective_fps
        if not (1.0 <= fps <= 120.0):
            fps = 30.0
        self._preview_fps = fps
        self._preview_side = side
        self._preview_current_frame = current_idx
        self._preview_start_frame = current_idx
        self._preview_started_monotonic = time.perf_counter()
        self._preview_rendered_frames = 0
        # 向后 2 秒
        frame_span = max(1, int(round(fps * self._preview_duration_seconds)))
        stop_frame = current_idx + frame_span
        if total_frames > 0:
            stop_frame = min(stop_frame, total_frames)
        self._preview_stop_frame = stop_frame

        self.is_playing = True
        btn = getattr(self, f'btn_preview_{side}')
        if btn:
            btn.setText('⏹ 停止')
            btn.setStyleSheet('QPushButton { font-size: 12px; font-weight: bold; padding: 2px 10px; background-color: #c0392b; color: white; }')

        interval = max(16, int(1000.0 / fps))
        self.playback_timer.setInterval(interval)
        self.playback_timer.start()

        print(f'[CalibrateTool] 2s预览 ({side}): frame {current_idx} → {self._preview_stop_frame}, '
              f'fps={fps:.1f}, interval={interval}ms')

    def _stop_playback(self):
        """停止预览，恢复按钮状态，全量刷新图表"""
        wall_elapsed = (
            time.perf_counter() - self._preview_started_monotonic
            if self._preview_started_monotonic > 0 else 0.0
        )
        self.is_playing = False
        self.playback_timer.stop()
        self._preview_started_monotonic = 0.0

        # 恢复按钮样式
        for s in ('left', 'right'):
            btn = getattr(self, f'btn_preview_{s}', None)
            if btn:
                btn.setText('▶ 2s预览')
                btn.setStyleSheet('QPushButton { font-size: 12px; font-weight: bold; padding: 2px 10px; }')

        self._last_video_update = 0
        self._do_update_plots()
        print(f'[CalibrateTool] 预览停止: pos={self.current_pos}, '
              f'wall={wall_elapsed:.2f}s, rendered={self._preview_rendered_frames}')

    def _on_playback_tick(self):
        """预览定时器：逐帧顺序读取指定侧视频"""
        if not self.is_playing or self.h5_file is None:
            self._stop_playback()
            return

        side = self._preview_side
        if side is None:
            self._stop_playback()
            return

        cap = self.video_caps.get(side)
        if cap is None:
            self._stop_playback()
            return

        elapsed = time.perf_counter() - self._preview_started_monotonic
        if (elapsed >= self._preview_duration_seconds or
                self._preview_current_frame >= self._preview_stop_frame - 1):
            self._stop_playback()
            return

        # QTimer 在解码或绘制耗时超过间隔时不会自动补帧。根据真实经过时间
        # 计算目标帧，并用 grab() 跳过落后的帧，保证“2s预览”约 2 秒结束。
        target_frame = self._preview_start_frame + int(elapsed * self._preview_fps)
        target_frame = min(target_frame, self._preview_stop_frame - 1)
        frames_to_advance = target_frame - self._preview_current_frame
        if frames_to_advance <= 0:
            return

        for _ in range(frames_to_advance - 1):
            if not cap.grab():
                self._stop_playback()
                return

        ret, frame = cap.read()
        if not ret or frame is None:
            self._stop_playback()
            return

        self._preview_current_frame = target_frame
        self._preview_rendered_frames += 1
        new_idx = target_frame
        self._video_current_idx[side] = new_idx

        # BGR→RGB→QPixmap
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        h, w, ch = frame_rgb.shape
        qimage = QImage(frame_rgb.data, w, h, ch * w, QImage.Format_RGB888).copy()
        self._video_current_frame[side] = qimage

        # 更新该侧视频 QLabel
        lbl = getattr(self, f'lbl_video_{side}')
        lbl_time = getattr(self, f'lbl_video_{side}_time')
        lbl_size = lbl.size()
        scaled = qimage.scaled(lbl_size, Qt.KeepAspectRatio, Qt.FastTransformation)
        lbl.setPixmap(QPixmap.fromImage(scaled))
        timeline = self.video_timelines.get(side)
        if timeline is None:
            timeline = VideoTimeline.from_timing(
                self.video_frame_count.get(side, 0), self.video_fps.get(side, 30),
                self.video_first_frame_unix.get(side, 0),
                self.video_last_frame_unix.get(side) or None,
                self.video_duration.get(side, 0),
            )
        fps = timeline.effective_fps
        target_unix = timeline.frame_to_time(new_idx)
        frame_time_sec = max(0.0, target_unix - timeline.first_time)
        minutes = int(frame_time_sec // 60)
        seconds = int(frame_time_sec % 60)
        # EMG 相对时间（与 Prompt 时间戳对齐，含标定偏移）
        if self.emg_start_time is not None:
            calib = self.calib_offset.get(side, 0)
            emg_rel = target_unix - float(self._ref_time()) - calib
            if abs(calib) > 0.001:
                lbl_time.setText(f'Frame #{new_idx} | 视频 {minutes:02d}:{seconds:02d} | EMG {emg_rel:.2f}s | 标定{calib:+.3f}s')
            else:
                lbl_time.setText(f'Frame #{new_idx} | 视频 {minutes:02d}:{seconds:02d} | EMG {emg_rel:.2f}s')
        else:
            lbl_time.setText(f'Frame #{new_idx} | 视频 {minutes:02d}:{seconds:02d}')

    # ─────────── 2s 预览结束 ───────────

    # ═══════════════════════════════════════════
    #  完整播放控制（从头到尾播放 EMG/IMU + 视频）
    # ═══════════════════════════════════════════

    def toggle_full_playback(self):
        """切换完整播放：开始 / 停止"""
        if self.is_full_playing:
            self._stop_full_playback()
            return
        if self.is_playing:
            # 先停止 2s 预览
            self._stop_playback()
        if self.h5_file is None:
            return

        # 如果已在数据末尾，自动回到开头
        max_pos = self.slider.maximum()
        if self.current_pos >= max_pos:
            self.current_pos = 0
            self.slider.setValue(0)

        self._start_full_playback()

    def _start_full_playback(self):
        """开始完整播放（追钟模式：按真实时间计算位置，不受渲染速度影响）"""
        self.is_full_playing = True
        self._update_playback_buttons(playing=True)

        self._playback_sample_rate = self._active_emg_sample_rate()
        # 记录播放基准：起始位置 + 起始真实时间
        self._playback_start_pos = self.current_pos
        self._playback_start_time = time.time()
        # 33ms 定时器用于刷新画面（≈30fps，对齐视频帧率），位置始终由真实时间决定
        self.full_playback_timer.start(33)

        print(f'[CalibrateTool] ▶ 完整播放开始: pos={self.current_pos}, '
              f'sr={self._playback_sample_rate}Hz (实时追钟)')

    def pause_playback(self):
        """暂停完整播放"""
        if not self.is_full_playing:
            return
        self.is_full_playing = False
        self.full_playback_timer.stop()
        # 记录已播放时间，以便恢复时继续
        self._playback_elapsed = time.time() - self._playback_start_time
        self._update_playback_buttons(playing=False, paused=True)
        print(f'[CalibrateTool] ⏸ 播放已暂停: pos={self.current_pos}')

    def _stop_full_playback(self):
        """停止完整播放，恢复按钮状态"""
        self.is_full_playing = False
        self.full_playback_timer.stop()
        self._update_playback_buttons(playing=False)
        print(f'[CalibrateTool] ⏹ 播放已停止: pos={self.current_pos}')

    def _get_frame_step_samples(self):
        """计算1个视频帧对应的 EMG 样本数（基于视频实际帧率）"""
        sr = self._active_emg_sample_rate()
        fps = 30.0  # 默认名义帧率
        for side in ('left', 'right'):
            if side not in self.video_caps:
                continue
            timeline = self.video_timelines.get(side)
            if timeline is not None and timeline.frame_count > 1:
                efps = timeline.effective_fps
                if fps == 30.0 or efps < fps:
                    fps = efps
        return max(1, int(sr / fps))

    def _step_frames(self, delta_frames):
        """步进 N 个视频帧（精细观察 EMG/视频对齐）"""
        self._stop_full_playback()
        self._stop_playback()

        step_samples = self._get_frame_step_samples()
        delta = delta_frames * step_samples

        max_pos = self.slider.maximum()
        new_pos = max(0, min(self.current_pos + delta, max_pos))

        self.current_pos = new_pos
        self.slider.blockSignals(True)
        self.slider.setValue(new_pos)
        self.slider.blockSignals(False)
        self.lbl_pos.setText(f'位置: {new_pos}')

        # 立即刷新显示（绕过 debounce 和视频 throttle）
        self._last_video_update = 0
        self.update_timer.stop()
        self._show_position_line = True
        self._do_update_plots()
        self._show_position_line = False

        # 更新步进信息提示
        step_ms = (step_samples / self._active_emg_sample_rate()) * 1000
        self.lbl_step_info.setToolTip(
            f'1帧 ≈ {step_samples}样本 ({step_ms:.1f}ms) @ {self._active_emg_sample_rate()}Hz EMG')

    def reset_progress(self):
        """重置进度到数据起始位置"""
        if self.is_full_playing:
            self._stop_full_playback()
        if self.is_playing:
            self._stop_playback()
        self.current_pos = 0
        self.slider.setValue(0)
        # 确保立即刷新
        self._last_video_update = 0
        self.update_timer.stop()
        self._do_update_plots()
        print('[CalibrateTool] ⏮ 进度已重置到起始位置')

    def _on_full_playback_tick(self):
        """完整播放定时器回调：追钟模式，位置 = 起始位置 + 真实时间 * 采样率"""
        if not self.is_full_playing or self.h5_file is None:
            self._stop_full_playback()
            return

        max_pos = self.slider.maximum()

        # 计算应该播放到的位置（追钟）
        elapsed = time.time() - self._playback_start_time
        new_pos = self._playback_start_pos + int(elapsed * self._playback_sample_rate)

        if new_pos >= max_pos:
            # 播放到末尾，停在最后一帧
            self.current_pos = max_pos
            self.slider.blockSignals(True)
            self.slider.setValue(max_pos)
            self.slider.blockSignals(False)
            self.lbl_pos.setText(f'位置: {max_pos}')
            self.update_timer.stop()
            self.update_plots()
            self._stop_full_playback()
            print(f'[CalibrateTool] ⏹ 播放完成（已到数据末尾，实际耗时 {elapsed:.1f}s）')
            return

        self.current_pos = new_pos

        # 更新滑块
        self.slider.blockSignals(True)
        self.slider.setValue(new_pos)
        self.slider.blockSignals(False)
        self.lbl_pos.setText(f'位置: {new_pos}')

        # 直接更新图表和视频（绕过 debounce timer）
        self.update_timer.stop()
        self.update_plots()

    def _update_playback_buttons(self, playing=False, paused=False):
        """更新播放控制按钮状态"""
        btn_base = (
            'QPushButton { font-size: 18px; padding: 4px 6px; border-radius: 6px;'
            'border: none; color: #fff; }'
        )
        if playing:
            self.btn_play.setText('⏹')
            self.btn_play.setStyleSheet(
                btn_base + 'QPushButton { background-color: #c0392b; }'
                'QPushButton:hover { background-color: #e74c3c; }'
            )
            self.btn_pause.setEnabled(True)
            self.btn_pause.setStyleSheet(
                btn_base + 'QPushButton:enabled { background-color: #e67e22; }'
                'QPushButton:enabled:hover { background-color: #f39c12; }'
            )
        elif paused:
            self.btn_play.setText('▶')
            self.btn_play.setStyleSheet(
                btn_base + 'QPushButton { background-color: #27ae60; }'
                'QPushButton:hover { background-color: #2ecc71; }'
            )
            self.btn_pause.setEnabled(False)
            self.btn_pause.setStyleSheet(
                'QPushButton:disabled { font-size: 18px; padding: 4px 6px; border-radius: 6px;'
                'border: none; background-color: #bdc3c7; color: #95a5a6; }'
            )
        else:
            self.btn_play.setText('▶')
            self.btn_play.setStyleSheet(
                btn_base + 'QPushButton { background-color: #27ae60; }'
                'QPushButton:hover { background-color: #2ecc71; }'
            )
            self.btn_pause.setEnabled(False)
            self.btn_pause.setStyleSheet(
                'QPushButton:disabled { font-size: 18px; padding: 4px 6px; border-radius: 6px;'
                'border: none; background-color: #bdc3c7; color: #95a5a6; }'
            )

    # ═══════════════════════════════════════════

    def closeEvent(self, event):
        """关闭窗口时清理资源"""
        if self.is_playing:
            self._stop_playback()
        if self.is_full_playing:
            self._stop_full_playback()
        self._close_videos()
        if self.h5_file:
            self.h5_file.close()
        event.accept()


class CalibrateTool(QMainWindow):
    """H5数据可视化工具主窗口 — 独立运行（薄包装器）"""

    def __init__(self):
        super().__init__()
        self.setWindowTitle('H5数据可视化工具 - calibrate_tool')
        self.resize(1200, 800)
        self.setMinimumSize(900, 600)

        self._widget = CalibrateWidget()
        self.setCentralWidget(self._widget)

    def closeEvent(self, event):
        """关闭窗口时清理H5资源（委托给内部 widget）"""
        self._widget.closeEvent(event)
        super().closeEvent(event)

    def __getattr__(self, name):
        """将未定义属性访问代理到内部 CalibrateWidget"""
        widget = self.__dict__.get('_widget', None)
        if widget is not None:
            return getattr(widget, name)
        raise AttributeError(f"'{type(self).__name__}' object has no attribute '{name}'")


def main():
    """主函数"""
    app = QApplication(sys.argv)

    # 设置应用样式
    app.setStyle('Fusion')

    window = CalibrateTool()
    window.show()

    # 如果命令行传入了文件路径，直接打开
    if len(sys.argv) > 1:
        file_path = sys.argv[1]
        if os.path.exists(file_path):
            window.load_h5_file(file_path)

    sys.exit(app.exec_())


if __name__ == '__main__':
    main()
