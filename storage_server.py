"""
storage_server.py - HDF5数据存储服务 (v4.2)

新特性:
1. 多级目录结构存储（增加受试者编号层级）
2. 目录层级: task -> category1 -> category2 -> category4 -> user_id
3. 文件命名: [受试者编号]_session{N}_[stage]_[年月日]_[时分秒].h5
4. 存储完整的metadata（受试者信息、分类信息、stage信息、session信息）

目录结构示例:
storage/
├── discrete_gesture/              # 采集任务 (task)
│   ├── static/                    # 大类 (category1)
│   │   ├── sitting/               # 大场景 (category2)
│   │   │   ├── normal/            # 人群 (category4)
│   │   │   │   ├── S001/          # 受试者编号 (user_id)
│   │   │   │   │   ├── S001_session1_palm_up_20260105_143000.h5
│   │   │   │   │   ├── S001_session1_palm_inward_20260105_143500.h5
│   │   │   │   │   ├── S001_session2_palm_up_20260105_150000.h5
│   │   │   │   │   └── S001_session2_palm_inward_20260105_150500.h5
│   │   │   │   └── S002/
│   │   │   │       ├── S002_session1_palm_up_20260105_160000.h5
│   │   │   │       └── ...
│   │   │   └── exercise/
│   │   │       └── S001/
│   │   │           └── S001_session1_palm_up_20260105_170000.h5
│   │   └── lying/
│   │       └── ...
│   └── dynamic/
│       └── ...
├── continual_gesture_1/
│   └── ...
└── continual_gesture_2/
    └── ...
"""

import h5py
import zmq
import json
import os
import sys
import io
import argparse
from datetime import datetime
import numpy as np
from threading import Lock

# ================= 基础配置 =================
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)

# ===================== 数据类型定义 =====================

# 【新增】EMG 250Hz ADC数据集类型：每帧16通道 + BLE帧号 + SD卡帧号 + 时间戳
# 用于存储250Hz原始ADC数据，后续与SD卡bin文件同步补全为2kHz
# 注意：channels存储的是原始ADC值（int32），不是μV值，需要乘以LSB系数才能转换为μV
EMG_250HZ_ADC_DTYPE = np.dtype([
    ("channels", "<i4", (16,)),   # 16通道EMG原始ADC值（非μV）
    ("frame_id", "<u4"),          # BLE帧号
    ("sd_frame_id", "<u4"),       # 对应的SD卡帧号 (= BLE帧号 * 8，即该8样本组的组首)
    ("time", "<f8")               # 时间戳
])

# 【新增】EMG 2kHz ADC数据集类型：每帧16通道 + SD卡帧号 + 时间戳
# 用于存储同步后的2kHz原始ADC数据
EMG_2KHZ_ADC_DTYPE = np.dtype([
    ("channels", "<i4", (16,)),   # 16通道EMG原始ADC值（非μV）
    ("sd_frame_id", "<u4"),       # SD卡帧号
    ("time", "<f8")               # 时间戳
])

# 【新增】IMU BLE数据集类型：acc(3) + gyr(3) + mag(3) + BLE帧号 + SD卡帧号 + 时间戳
# 用于存储随BLE包接收的IMU数据（约27.8Hz，每个BLE包一帧），后续与SD卡bin文件同步补全为100Hz
IMU_BLE_DTYPE = np.dtype([
    ("acc", "<f4", (3,)),   # 加速度计 [ax, ay, az]
    ("gyr", "<f4", (3,)),   # 陀螺仪 [gx, gy, gz]
    ("mag", "<f4", (3,)),   # 磁力计 [mx, my, mz]
    ("frame_id", "<u4"),    # BLE帧号
    ("sd_frame_id", "<u4"), # 对应 2kHz SD 卡帧号 (= BLE帧号 * 8)，IMU bin 帧号 = 该值 // 20
    ("time", "<f8")         # 时间戳
])

# 【新增】IMU 100Hz数据集类型：acc(3) + gyr(3) + mag(3) + SD卡帧号 + 时间戳
# 用于存储同步后的100Hz数据（IMU实际采样率为100Hz，非2kHz）
IMU_100HZ_DTYPE = np.dtype([
    ("acc", "<f4", (3,)),   # 加速度计 [ax, ay, az]
    ("gyr", "<f4", (3,)),   # 陀螺仪 [gx, gy, gz]
    ("mag", "<f4", (3,)),   # 磁力计 [mx, my, mz]
    ("sd_frame_id", "<u4"), # IMU SD卡帧号
    ("time", "<f8")         # 时间戳
])

# 【新增】V1/V2 通用 IMU BLE 数据集类型: 支持可变数量 IMU、有/无磁力计
# V1: 固定 2 个 IMU, has_mag=true, mag 有效
# V2: 可变 0-3 个 IMU, has_mag=false, mag 填充 NaN
IMU_ALL_BLE_DTYPE = np.dtype([
    ("imu_index", "<u1"),    # IMU 索引 (0-based, 对应物理 I2C 地址)
    ("acc", "<f4", (3,)),    # 加速度计 [ax, ay, az]
    ("gyr", "<f4", (3,)),   # 陀螺仪 [gx, gy, gz]
    ("has_mag", "<u1"),      # 是否有磁力计数据 (V1=1, V2=0)
    ("mag", "<f4", (3,)),   # 磁力计 [mx, my, mz] (V2 填充 NaN)
    ("frame_id", "<u4"),    # BLE 帧号
    ("sd_frame_id", "<u4"), # 对应的 2kHz SD 卡帧号 (= BLE帧号 * 8)
    ("time", "<f8")         # 时间戳
])

# 【修改】MOCAP数据集类型：每只手12个marker点的3D坐标 + 帧号 + 时间戳
# 左手marker: IN1_L, IN2_L, IN3_L, HB1_L, HB2_L, HB3_L, TH1_L, TH2_L, TH3_L, TH4_L, MD1_L, MD2_L
# 右手marker: IN1_R, IN2_R, IN3_R, HB1_R, HB2_R, HB3_R, TH1_R, TH2_R, TH3_R, TH4_R, MD1_R, MD2_R
MOCAP_MARKER_NAMES_L = ["IN1_L", "IN2_L", "IN3_L", "HB1_L", "HB2_L", "HB3_L", "TH1_L", "TH2_L", "TH3_L", "TH4_L", "MD1_L", "MD2_L"]
MOCAP_MARKER_NAMES_R = ["IN1_R", "IN2_R", "IN3_R", "HB1_R", "HB2_R", "HB3_R", "TH1_R", "TH2_R", "TH3_R", "TH4_R", "MD1_R", "MD2_R"]

# 左手MOCAP数据类型
MOCAP_L_DTYPE = np.dtype([
    ("IN1_L", "<f4", (3,)),   # 食指指尖 [x, y, z]
    ("IN2_L", "<f4", (3,)),   # 食指第一关节
    ("IN3_L", "<f4", (3,)),   # 食指第二关节
    ("HB1_L", "<f4", (3,)),   # 手背点1
    ("HB2_L", "<f4", (3,)),   # 手背点2
    ("HB3_L", "<f4", (3,)),   # 手背点3
    ("TH1_L", "<f4", (3,)),   # 拇指指尖
    ("TH2_L", "<f4", (3,)),   # 拇指第一关节
    ("TH3_L", "<f4", (3,)),   # 拇指第二关节
    ("TH4_L", "<f4", (3,)),   # 拇指根部
    ("MD1_L", "<f4", (3,)),   # 中指点1
    ("MD2_L", "<f4", (3,)),   # 中指点2
    ("frame", "<i4"),         # 帧号
    ("time", "<f8")           # 时间戳
])

# 右手MOCAP数据类型
MOCAP_R_DTYPE = np.dtype([
    ("IN1_R", "<f4", (3,)),   # 食指指尖 [x, y, z]
    ("IN2_R", "<f4", (3,)),   # 食指第一关节
    ("IN3_R", "<f4", (3,)),   # 食指第二关节
    ("HB1_R", "<f4", (3,)),   # 手背点1
    ("HB2_R", "<f4", (3,)),   # 手背点2
    ("HB3_R", "<f4", (3,)),   # 手背点3
    ("TH1_R", "<f4", (3,)),   # 拇指指尖
    ("TH2_R", "<f4", (3,)),   # 拇指第一关节
    ("TH3_R", "<f4", (3,)),   # 拇指第二关节
    ("TH4_R", "<f4", (3,)),   # 拇指根部
    ("MD1_R", "<f4", (3,)),   # 中指点1
    ("MD2_R", "<f4", (3,)),   # 中指点2
    ("frame", "<i4"),         # 帧号
    ("time", "<f8")           # 时间戳
])

# 字符串存储配置
STR_VLEN_DTYPE = h5py.special_dtype(vlen=str)

def debug_log(message):
    print(f"[storage_server] {message}", file=sys.stderr, flush=True)


class HDF5StorageServer:
    def __init__(self, host="127.0.0.1", port=5555, storage_dir="./storage"):
        # ZeroMQ配置
        self.context = zmq.Context()

        # REP socket 用于控制命令（create/close/stats等）
        self.socket = self.context.socket(zmq.REP)
        self.socket.bind(f"tcp://{host}:{port}")
        debug_log(f"HDF5存储服务已启动，控制端口 {host}:{port}")

        # 【新增】PULL socket 用于数据接收（append命令，非阻塞）
        self.data_port = port + 1  # 5556
        self.data_socket = self.context.socket(zmq.PULL)
        self.data_socket.bind(f"tcp://{host}:{self.data_port}")
        debug_log(f"数据接收端口: {host}:{self.data_port} (PULL模式，非阻塞)")
        
        # 存储根目录
        self.storage_dir = os.path.abspath(storage_dir)
        debug_log(f"存储根目录设置为: {self.storage_dir}")
        
        # 确保存储目录存在
        if not os.path.exists(self.storage_dir):
            try:
                os.makedirs(self.storage_dir)
                debug_log(f"创建存储目录: {self.storage_dir}")
            except Exception as e:
                debug_log(f"❌ 创建存储目录失败: {e}")
        
        # HDF5文件相关
        self.file_path = None
        self.f = None
        self.lock = Lock()
        
        # 当前采集信息
        self.current_task_id = None
        self.current_user_id = None
        self.current_stage_name = None
        self.current_category1 = None
        self.current_category2 = None
        self.current_category4 = None
        self.current_recording_session_id = None  # Phase 5
        self.is_collecting = False
        
        # 【新增】Session信息
        self.current_session_index = 0    # session索引（从0开始）
        self.current_session_number = 1   # session编号（从1开始）
        self.session_count = 3            # session总数
        
        # 统计信息
        self.stats = {
            "emg1_frames": 0,
            "emg2_frames": 0,
            "imu1a_frames": 0,
            "imu1b_frames": 0,
            "imu2a_frames": 0,
            "imu2b_frames": 0,
            "imu1_all_frames": 0,   # 【新增】V1/V2 通用
            "imu2_all_frames": 0,   # 【新增】V1/V2 通用
            "mocap_L_frames": 0,  # 【修改】左手动捕帧数
            "mocap_R_frames": 0,  # 【修改】右手动捕帧数
            "prompts": 0
        }
    
    def _sanitize_name(self, name):
        """清理文件/目录名中的非法字符"""
        if not name:
            return "unknown"
        # 替换非法字符
        illegal_chars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|', ' ']
        result = str(name)
        for char in illegal_chars:
            result = result.replace(char, '_')
        return result
    
    def generate_directory_path(self, task_id, category1, category2, category4, user_id):
        """
        生成多级目录路径（包含受试者编号层级）:
        storage/
        └── {task_id}/           # 采集任务
            └── {category1}/     # 大类
                └── {category2}/ # 大场景
                    └── {category4}/ # 人群
                        └── {user_id}/   # 受试者编号 ← 新增
        """
        # 清理每一层的名称
        task_dir = self._sanitize_name(task_id)
        cat1_dir = self._sanitize_name(category1)
        cat2_dir = self._sanitize_name(category2)
        cat4_dir = self._sanitize_name(category4)
        user_dir = self._sanitize_name(user_id)
        
        # 构建完整路径（包含user_id层级）
        dir_path = os.path.join(
            self.storage_dir,
            task_dir,      # 采集任务
            cat1_dir,      # 大类
            cat2_dir,      # 大场景
            cat4_dir,      # 人群
            user_dir       # 受试者编号 ← 新增
        )
        
        # 确保目录存在
        if not os.path.exists(dir_path):
            os.makedirs(dir_path)
            debug_log(f"创建多级目录: {dir_path}")
        
        return dir_path
    
    def generate_filename(self, dir_path, user_id, stage_name, session_number, category2=None):
        """
        生成文件名: {user_id}_{category2}_{stage_name}_session{N}_{YYYYMMDD}_{HHMMSS}.h5
        例如: S001_站姿_测试2_session1_20260315_141100.h5

        【修改】把 session 放在 stage_name 后面
        """
        now = datetime.now()
        date_str = now.strftime("%Y%m%d")
        time_str = now.strftime("%H%M%S")

        # 清理用户ID、category2和stage名称
        safe_user_id = self._sanitize_name(user_id)
        safe_stage_name = self._sanitize_name(stage_name)

        # 文件名包含: 受试者编号_大场景_stage_session{N}_日期_时间
        if category2:
            safe_category2 = self._sanitize_name(category2)
            filename = f"{safe_user_id}_{safe_category2}_{safe_stage_name}_session{session_number}_{date_str}_{time_str}.h5"
        else:
            filename = f"{safe_user_id}_{safe_stage_name}_session{session_number}_{date_str}_{time_str}.h5"
        return os.path.join(dir_path, filename)
    
    def _maybe_update_parent_segment_link(self, new_file_path, params):
        """Phase 5: 补填父 segment H5 的 resumed_by_segment_index / resumed_by_file

        在当前（续采）segment 创建成功后调用。
        扫描同目录 .h5 找父 segment 并写入反向链路。
        """
        is_resumed = params.get("is_resumed", False)
        parent_seg = params.get("parent_segment_index")
        session_id = params.get("recording_session_id") or self.current_recording_session_id or ""

        if not is_resumed or not parent_seg or not session_id:
            return

        new_dir = os.path.dirname(new_file_path)
        new_rel = os.path.relpath(new_file_path, self.storage_dir)
        seg_idx = int(params.get("segment_index", 1))
        found = False

        try:
            for fname in os.listdir(new_dir):
                if not fname.endswith('.h5'):
                    continue
                parent_path = os.path.join(new_dir, fname)
                if parent_path == new_file_path:
                    continue

                try:
                    with h5py.File(parent_path, 'a') as pf:
                        p_sid = (pf.attrs.get('collection_session_id') or
                                 pf.attrs.get('recording_session_id'))
                        if isinstance(p_sid, bytes):
                            p_sid = p_sid.decode('utf-8')
                        p_seg = pf.attrs.get('segment_index', 1)
                        p_cs = pf.attrs.get('collection_status', '')
                        if isinstance(p_cs, bytes):
                            p_cs = p_cs.decode('utf-8')

                        if p_sid != session_id or int(p_seg) != int(parent_seg):
                            continue
                        if p_cs != 'abnormal_interrupted':
                            continue

                        pf.attrs['resumed_by_segment_index'] = int(seg_idx)
                        pf.attrs['resumed_by_file'] = str(new_rel)
                        debug_log(f"🔗 已补填父 segment 链路: {os.path.basename(parent_path)}")
                        debug_log(f"   resumed_by_segment_index={seg_idx}, resumed_by_file={new_rel}")
                        found = True
                        break
                except Exception:
                    continue

            if not found:
                debug_log(f"⚠️ 未找到父 segment: session={session_id}, parent_seg={parent_seg}")

        except Exception as e:
            debug_log(f"⚠️ 补填父 segment 链路失败: {e}")

    def create_file(self, params):
        """创建新的HDF5文件（使用多级目录结构，包含受试者层级）"""
        try:
            # 提取参数
            task_id = params.get("task_id", "discrete_gesture")
            user_id = params.get("user_id", "unknown_user")
            stage_name = params.get("stage_name", "unknown_stage")
            category1 = params.get("category1", "static")
            category2 = params.get("category2", "sitting")
            category4 = params.get("category4", "normal")
            subject_info = params.get("subject_info", {})
            template_name = params.get("template_name", "default")
            emg_gain = params.get("emg_gain")
            emg_gain_index = params.get("emg_gain_index")
            emg_lsb_uv_24bit = params.get("emg_lsb_uv_24bit")
            emg_gain_dev1 = params.get("emg_gain_dev1")
            emg_gain_index_dev1 = params.get("emg_gain_index_dev1")
            emg_lsb_uv_24bit_dev1 = params.get("emg_lsb_uv_24bit_dev1")
            emg_gain_dev2 = params.get("emg_gain_dev2")
            emg_gain_index_dev2 = params.get("emg_gain_index_dev2")
            emg_lsb_uv_24bit_dev2 = params.get("emg_lsb_uv_24bit_dev2")
            
            # 【新增】提取Session参数
            session_index = params.get("session_index", 0)
            session_number = params.get("session_number", 1)
            session_count = params.get("session_count", 3)

            # 【新增】提取SD卡bin文件名（用于数据溯源）
            sd_bin_dev1 = params.get("sd_bin_dev1")  # 例如 "S001_L_260312_143025"
            sd_bin_dev2 = params.get("sd_bin_dev2")  # 例如 "S001_R_260312_143025"

            # 【新增】提取BLE设备名称（用于追溯数据来源）
            ble_dev1 = params.get("ble_dev1")  # 例如 "WristBand_3A76"
            ble_dev2 = params.get("ble_dev2")  # 例如 "WristBand_5B12"
            
            # 保存当前信息
            self.current_task_id = task_id
            self.current_user_id = user_id
            self.current_stage_name = stage_name
            self.current_category1 = category1
            self.current_category2 = category2
            self.current_category4 = category4
            
            # 【新增】保存Session信息
            self.current_session_index = session_index
            self.current_session_number = session_number
            self.session_count = session_count
            
            debug_log(f"Session信息: session{session_number}/{session_count} (索引: {session_index})")
            
            # 如果有已打开的文件，先关闭
            if self.f:
                debug_log("关闭上一个文件...")
                self.close_file()
            
            # 生成多级目录路径（包含user_id层级）
            dir_path = self.generate_directory_path(task_id, category1, category2, category4, user_id)
            
            # 生成文件名（包含session_number、category2和stage_name）
            self.file_path = self.generate_filename(dir_path, user_id, stage_name, session_number, category2)
            
            # 如果文件已存在，添加序号
            base_path = self.file_path
            counter = 1
            while os.path.exists(self.file_path):
                name, ext = os.path.splitext(base_path)
                self.file_path = f"{name}_{counter}{ext}"
                counter += 1
            
            debug_log(f"准备创建文件: {self.file_path}")
            
            # 创建HDF5文件
            self.f = h5py.File(self.file_path, "a", libver='latest')
            
            # ===================== 创建根属性（Metadata） =====================
            self.f.attrs["task_id"] = task_id
            self.f.attrs["user_id"] = user_id
            self.f.attrs["stage_name"] = stage_name
            self.f.attrs["category1"] = category1
            self.f.attrs["category2"] = category2
            self.f.attrs["category4"] = category4
            self.f.attrs["template_name"] = template_name
            self.f.attrs["created_at"] = datetime.now().isoformat()
            if emg_gain is not None:
                self.f.attrs["emg_gain"] = int(emg_gain)
            if emg_gain_index is not None:
                self.f.attrs["emg_gain_index"] = int(emg_gain_index)
            if emg_lsb_uv_24bit is not None:
                self.f.attrs["emg_lsb_uv_24bit"] = float(emg_lsb_uv_24bit)
            per_device_emg_attrs = {
                "emg_gain_dev1": (emg_gain_dev1, int),
                "emg_gain_index_dev1": (emg_gain_index_dev1, int),
                "emg_lsb_uv_24bit_dev1": (emg_lsb_uv_24bit_dev1, float),
                "emg_gain_dev2": (emg_gain_dev2, int),
                "emg_gain_index_dev2": (emg_gain_index_dev2, int),
                "emg_lsb_uv_24bit_dev2": (emg_lsb_uv_24bit_dev2, float),
            }
            for attr_name, (attr_value, caster) in per_device_emg_attrs.items():
                if attr_value is not None:
                    self.f.attrs[attr_name] = caster(attr_value)

            # Phase 3: stage 开始时间（从 realtimeEngine 传入）
            start_time = params.get("start_time")
            if start_time:
                self.f.attrs["start_time"] = float(start_time)

            # 【新增】保存Session信息到HDF5属性
            self.f.attrs["session_index"] = session_index
            self.f.attrs["session_number"] = session_number
            self.f.attrs["session_count"] = session_count

            # Phase 3: stage_index
            stage_index = params.get("stage_index", 0)
            self.f.attrs["stage_index"] = int(stage_index)

            # 【新增】保存SD卡bin文件名到HDF5属性（用于数据溯源）
            # 格式: "S001_L_260312_143025" -> 对应SD卡文件 S001_L_260312_143025_emg.bin 和 S001_L_260312_143025_imu.bin
            if sd_bin_dev1:
                self.f.attrs["sd_bin_dev1"] = sd_bin_dev1
                debug_log(f"   SD卡源文件(设备1/左手): {sd_bin_dev1}_emg.bin, {sd_bin_dev1}_imu.bin")
            if sd_bin_dev2:
                self.f.attrs["sd_bin_dev2"] = sd_bin_dev2
                debug_log(f"   SD卡源文件(设备2/右手): {sd_bin_dev2}_emg.bin, {sd_bin_dev2}_imu.bin")

            # 【新增】stream 模式元数据（preview/collection 切流方案）
            stream_mode = params.get("stream_mode", "unknown")
            self.f.attrs["stream_mode"] = str(stream_mode)
            debug_log(f"   stream_mode: {stream_mode}")

            collection_stream_id = params.get("collection_stream_id")
            if collection_stream_id:
                self.f.attrs["collection_stream_id"] = str(collection_stream_id)
                debug_log(f"   collection_stream_id: {collection_stream_id}")

            stream_switch_delay_ms = params.get("stream_switch_delay_ms")
            if stream_switch_delay_ms is not None:
                self.f.attrs["stream_switch_delay_ms"] = int(stream_switch_delay_ms)

            timestamp_to_start_delay_ms = params.get("timestamp_to_start_delay_ms")
            if timestamp_to_start_delay_ms is not None:
                self.f.attrs["timestamp_to_start_delay_ms"] = int(timestamp_to_start_delay_ms)

            # bin_pair_source 标识 bin 来源
            bin_pair_source = params.get("bin_pair_source", "unknown")
            self.f.attrs["bin_pair_source"] = str(bin_pair_source)
            # 合法值: "collection_stream" | "preview_stream" | "legacy" | "unknown"

            # preview bin 仅作 debug 记录，不参与同步
            preview_bin_dev1 = params.get("preview_bin_dev1")
            if preview_bin_dev1:
                self.f.attrs["preview_bin_dev1"] = str(preview_bin_dev1)
            preview_bin_dev2 = params.get("preview_bin_dev2")
            if preview_bin_dev2:
                self.f.attrs["preview_bin_dev2"] = str(preview_bin_dev2)

            # sd_imu_bin attrs（兼容未来扩展）
            sd_imu_bin_dev1 = params.get("sd_imu_bin_dev1")
            if sd_imu_bin_dev1:
                self.f.attrs["sd_imu_bin_dev1"] = str(sd_imu_bin_dev1)
            sd_imu_bin_dev2 = params.get("sd_imu_bin_dev2")
            if sd_imu_bin_dev2:
                self.f.attrs["sd_imu_bin_dev2"] = str(sd_imu_bin_dev2)

            # stream_format_version: 2 = 新格式（一对一），1 = 旧格式（可能一对多）
            self.f.attrs["stream_format_version"] = 2
            debug_log(f"   stream_format_version: 2 (one-H5-one-bin)")


            # 【新增】保存BLE设备名称到HDF5属性（用于追溯数据来源）
            # 格式: "WristBand_3A76" -> 扫描时连接的BLE设备名称
            if ble_dev1:
                self.f.attrs["ble_device_dev1"] = ble_dev1
                debug_log(f"   BLE设备(设备1/左手): {ble_dev1}")
            if ble_dev2:
                self.f.attrs["ble_device_dev2"] = ble_dev2
                debug_log(f"   BLE设备(设备2/右手): {ble_dev2}")

            # 【新增】保存录像同步信息到HDF5属性
            # recording_session_id: 录像会话ID，格式 "rec_YYYYMMDD_HHMMSS_N"
            # is_multi_session: 是否为多轮次采集模式
            recording_session_id = params.get("recording_session_id")
            self.current_recording_session_id = recording_session_id  # Phase 5
            is_multi_session = params.get("is_multi_session", False)
            if recording_session_id:
                self.f.attrs["recording_session_id"] = recording_session_id
                self.f.attrs["is_multi_session"] = is_multi_session
                debug_log(f"   录像会话ID: {recording_session_id}")
                debug_log(f"   多轮次模式: {is_multi_session}")

            # 【Phase 2】续采模式元数据
            is_resumed = params.get("is_resumed", False)
            segment_index = params.get("segment_index", 1)
            resume_from_interrupted_at = params.get("resume_from_interrupted_at")
            resume_reason = params.get("resume_reason")
            resume_parent_recording_session_id = params.get("resume_parent_recording_session_id")

            self.f.attrs["is_resumed"] = bool(is_resumed)
            self.f.attrs["segment_index"] = int(segment_index)
            if is_resumed:
                debug_log(f"   续采模式: 是 (segment_index={segment_index})")
                if resume_from_interrupted_at:
                    self.f.attrs["resume_from_interrupted_at"] = str(resume_from_interrupted_at)
                    debug_log(f"   续采自中断时间: {resume_from_interrupted_at}")
                if resume_reason:
                    self.f.attrs["resume_reason"] = str(resume_reason)
                    debug_log(f"   中断原因: {resume_reason}")
                if resume_parent_recording_session_id:
                    self.f.attrs["resume_parent_recording_session_id"] = str(resume_parent_recording_session_id)
                    debug_log(f"   父录像会话ID: {resume_parent_recording_session_id}")
                # Phase 3: 父 segment 序号
                parent_segment_index = params.get("parent_segment_index")
                if parent_segment_index is not None:
                    self.f.attrs["parent_segment_index"] = int(parent_segment_index)
                    debug_log(f"   父segment序号: {parent_segment_index}")

            # ---- Phase 3: segment 身份标识 ----
            # collection_session_id: 同 recording_session_id，用于跨 segment 关联
            if recording_session_id:
                self.f.attrs["collection_session_id"] = str(recording_session_id)
            # 初始 collection_status（close 时覆盖）
            self.f.attrs["collection_status"] = "running"
            # 中断链占位字段
            rec_id = recording_session_id or "unknown"
            seg_idx = int(segment_index)
            interruption_id = f"int_{rec_id}_seg{seg_idx}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
            self.f.attrs["interruption_id"] = interruption_id
            self.f.attrs["resumed_by_segment_index"] = -1
            self.f.attrs["resumed_by_file"] = ""

            # ===================== 创建受试者信息组 =====================
            if subject_info:
                subject_grp = self.f.create_group("subject")
                for key, value in subject_info.items():
                    if value is not None:
                        try:
                            subject_grp.attrs[str(key)] = str(value) if not isinstance(value, (int, float)) else value
                        except Exception as e:
                            debug_log(f"保存subject属性失败 {key}: {e}")

            # ===================== 创建EMG 250Hz ADC数据集（采集时写入） =====================
            # 这些数据集存储BLE传输的250Hz原始ADC数据，包含帧号用于后续与SD卡bin文件同步
            emg1_250hz_ds = self.f.create_dataset(
                "emg1_250hz_adc", shape=(0,), dtype=EMG_250HZ_ADC_DTYPE,
                chunks=(1000,), maxshape=(None,), compression="gzip"
            )
            emg1_250hz_ds.attrs["device"] = "device_1"
            emg1_250hz_ds.attrs["channels"] = 16
            emg1_250hz_ds.attrs["sample_rate"] = 250
            emg1_250hz_ds.attrs["data_type"] = "raw_adc"  # 原始ADC值，非μV
            emg1_250hz_ds.attrs["description"] = "250Hz EMG raw ADC data from BLE (not uV, multiply by LSB to convert)"

            emg2_250hz_ds = self.f.create_dataset(
                "emg2_250hz_adc", shape=(0,), dtype=EMG_250HZ_ADC_DTYPE,
                chunks=(1000,), maxshape=(None,), compression="gzip"
            )
            emg2_250hz_ds.attrs["device"] = "device_2"
            emg2_250hz_ds.attrs["channels"] = 16
            emg2_250hz_ds.attrs["sample_rate"] = 250
            emg2_250hz_ds.attrs["data_type"] = "raw_adc"  # 原始ADC值，非μV
            emg2_250hz_ds.attrs["description"] = "250Hz EMG raw ADC data from BLE (not uV, multiply by LSB to convert)"

            # ===================== 创建EMG 2kHz ADC数据集（同步后写入，初始为空） =====================
            emg1_2khz_ds = self.f.create_dataset(
                "emg1_2khz_adc", shape=(0,), dtype=EMG_2KHZ_ADC_DTYPE,
                chunks=(1000,), maxshape=(None,), compression="gzip"
            )
            emg1_2khz_ds.attrs["device"] = "device_1"
            emg1_2khz_ds.attrs["channels"] = 16
            emg1_2khz_ds.attrs["sample_rate"] = 2000
            emg1_2khz_ds.attrs["data_type"] = "raw_adc"  # 原始ADC值，非μV
            emg1_2khz_ds.attrs["description"] = "2kHz EMG raw ADC data (synced from SD card bin, empty until sync)"

            emg2_2khz_ds = self.f.create_dataset(
                "emg2_2khz_adc", shape=(0,), dtype=EMG_2KHZ_ADC_DTYPE,
                chunks=(1000,), maxshape=(None,), compression="gzip"
            )
            emg2_2khz_ds.attrs["device"] = "device_2"
            emg2_2khz_ds.attrs["channels"] = 16
            emg2_2khz_ds.attrs["sample_rate"] = 2000
            emg2_2khz_ds.attrs["data_type"] = "raw_adc"  # 原始ADC值，非μV
            emg2_2khz_ds.attrs["description"] = "2kHz EMG raw ADC data (synced from SD card bin, empty until sync)"

            # ===================== 创建IMU BLE数据集（采集时写入，随BLE包接收，约27.8Hz） =====================
            # 每个设备有2个IMU传感器（a=AD0_LOW/0x68, b=AD0_HIGH/0x69）
            # 设备1的两个IMU
            imu1a_ble_ds = self.f.create_dataset(
                "imu1a_ble", shape=(0,), dtype=IMU_BLE_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu1a_ble_ds.attrs["device"] = "device_1"
            imu1a_ble_ds.attrs["sensor"] = "IMU_A (AD0_LOW, 0x68)"
            imu1a_ble_ds.attrs["sample_rate"] = "~27.8Hz (one per BLE packet)"
            imu1a_ble_ds.attrs["description"] = "IMU-A data from device 1 BLE packets"

            imu1b_ble_ds = self.f.create_dataset(
                "imu1b_ble", shape=(0,), dtype=IMU_BLE_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu1b_ble_ds.attrs["device"] = "device_1"
            imu1b_ble_ds.attrs["sensor"] = "IMU_B (AD0_HIGH, 0x69)"
            imu1b_ble_ds.attrs["sample_rate"] = "~27.8Hz (one per BLE packet)"
            imu1b_ble_ds.attrs["description"] = "IMU-B data from device 1 BLE packets"

            # 设备2的两个IMU
            imu2a_ble_ds = self.f.create_dataset(
                "imu2a_ble", shape=(0,), dtype=IMU_BLE_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu2a_ble_ds.attrs["device"] = "device_2"
            imu2a_ble_ds.attrs["sensor"] = "IMU_A (AD0_LOW, 0x68)"
            imu2a_ble_ds.attrs["sample_rate"] = "~27.8Hz (one per BLE packet)"
            imu2a_ble_ds.attrs["description"] = "IMU-A data from device 2 BLE packets"

            imu2b_ble_ds = self.f.create_dataset(
                "imu2b_ble", shape=(0,), dtype=IMU_BLE_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu2b_ble_ds.attrs["device"] = "device_2"
            imu2b_ble_ds.attrs["sensor"] = "IMU_B (AD0_HIGH, 0x69)"
            imu2b_ble_ds.attrs["sample_rate"] = "~27.8Hz (one per BLE packet)"
            imu2b_ble_ds.attrs["description"] = "IMU-B data from device 2 BLE packets"

            # 【新增】V1/V2 通用 IMU 数据集 (支持可变数量、有/无磁力计)
            imu1_all_ble_ds = self.f.create_dataset(
                "imu1_all_ble", shape=(0,), dtype=IMU_ALL_BLE_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu1_all_ble_ds.attrs["device"] = "device_1"
            imu1_all_ble_ds.attrs["supports_variable_imus"] = True
            imu1_all_ble_ds.attrs["v2_no_magnetometer"] = True
            imu1_all_ble_ds.attrs["description"] = "Device 1 all IMU data (V1/V2 unified, variable count)"

            imu2_all_ble_ds = self.f.create_dataset(
                "imu2_all_ble", shape=(0,), dtype=IMU_ALL_BLE_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu2_all_ble_ds.attrs["device"] = "device_2"
            imu2_all_ble_ds.attrs["supports_variable_imus"] = True
            imu2_all_ble_ds.attrs["v2_no_magnetometer"] = True
            imu2_all_ble_ds.attrs["description"] = "Device 2 all IMU data (V1/V2 unified, variable count)"

            # ===================== 创建IMU 100Hz数据集（同步后写入，初始为空） =====================
            # 设备1的两个IMU
            imu1a_100hz_ds = self.f.create_dataset(
                "imu1a_100hz", shape=(0,), dtype=IMU_100HZ_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu1a_100hz_ds.attrs["device"] = "device_1"
            imu1a_100hz_ds.attrs["sensor"] = "IMU_A (AD0_LOW, 0x68)"
            imu1a_100hz_ds.attrs["sample_rate"] = 100
            imu1a_100hz_ds.attrs["description"] = "100Hz IMU-A data (synced from SD card bin)"

            imu1b_100hz_ds = self.f.create_dataset(
                "imu1b_100hz", shape=(0,), dtype=IMU_100HZ_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu1b_100hz_ds.attrs["device"] = "device_1"
            imu1b_100hz_ds.attrs["sensor"] = "IMU_B (AD0_HIGH, 0x69)"
            imu1b_100hz_ds.attrs["sample_rate"] = 100
            imu1b_100hz_ds.attrs["description"] = "100Hz IMU-B data (synced from SD card bin)"

            # 设备2的两个IMU
            imu2a_100hz_ds = self.f.create_dataset(
                "imu2a_100hz", shape=(0,), dtype=IMU_100HZ_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu2a_100hz_ds.attrs["device"] = "device_2"
            imu2a_100hz_ds.attrs["sensor"] = "IMU_A (AD0_LOW, 0x68)"
            imu2a_100hz_ds.attrs["sample_rate"] = 100
            imu2a_100hz_ds.attrs["description"] = "100Hz IMU-A data (synced from SD card bin)"

            imu2b_100hz_ds = self.f.create_dataset(
                "imu2b_100hz", shape=(0,), dtype=IMU_100HZ_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu2b_100hz_ds.attrs["device"] = "device_2"
            imu2b_100hz_ds.attrs["sensor"] = "IMU_B (AD0_HIGH, 0x69)"
            imu2b_100hz_ds.attrs["sample_rate"] = 100
            imu2b_100hz_ds.attrs["description"] = "100Hz IMU-B data (synced from SD card bin)"

            # 设备1/2的第3个IMU（仅 3-IMU 硬件有数据，由 sync 填充，BLE 不传）
            imu1c_100hz_ds = self.f.create_dataset(
                "imu1c_100hz", shape=(0,), dtype=IMU_100HZ_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu1c_100hz_ds.attrs["device"] = "device_1"
            imu1c_100hz_ds.attrs["sensor"] = "IMU_C (AD1)"
            imu1c_100hz_ds.attrs["sample_rate"] = 100
            imu1c_100hz_ds.attrs["description"] = "100Hz IMU-C data (synced from SD card bin, no BLE)"

            imu2c_100hz_ds = self.f.create_dataset(
                "imu2c_100hz", shape=(0,), dtype=IMU_100HZ_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            imu2c_100hz_ds.attrs["device"] = "device_2"
            imu2c_100hz_ds.attrs["sensor"] = "IMU_C (AD1)"
            imu2c_100hz_ds.attrs["sample_rate"] = 100
            imu2c_100hz_ds.attrs["description"] = "100Hz IMU-C data (synced from SD card bin, no BLE)"

            # ===================== 同步状态标记 =====================
            # pending: 待同步（250Hz数据，需要与SD卡bin同步补全为2kHz）
            # synced: 已同步（已补全为2kHz数据）
            self.f.attrs["sync_status"] = "pending"
            self.f.attrs["ble_sample_rate"] = 250  # BLE传输采样率
            self.f.attrs["target_sample_rate"] = 2000  # 目标采样率（SD卡存储）

            # ===================== 【修改】创建MOCAP数据集（左右手分开） =====================
            # 左手MOCAP数据集
            mocap_L_ds = self.f.create_dataset(
                "mocap_L", shape=(0,), dtype=MOCAP_L_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            mocap_L_ds.attrs["description"] = "Left hand motion capture marker data (12 markers x 3D coordinates)"
            mocap_L_ds.attrs["markers"] = str(MOCAP_MARKER_NAMES_L)
            mocap_L_ds.attrs["coordinate_unit"] = "mm"

            # 右手MOCAP数据集
            mocap_R_ds = self.f.create_dataset(
                "mocap_R", shape=(0,), dtype=MOCAP_R_DTYPE,
                chunks=(500,), maxshape=(None,), compression="gzip"
            )
            mocap_R_ds.attrs["description"] = "Right hand motion capture marker data (12 markers x 3D coordinates)"
            mocap_R_ds.attrs["markers"] = str(MOCAP_MARKER_NAMES_R)
            mocap_R_ds.attrs["coordinate_unit"] = "mm"

            # ===================== 创建Prompts组 =====================
            prompts = self.f.create_group("prompts")

            prompts.create_dataset(
                "names", shape=(0,), dtype=STR_VLEN_DTYPE,
                chunks=(1000,), maxshape=(None,)
            )

            prompts.create_dataset(
                "times", shape=(0,), dtype=np.float64,
                chunks=(1000,), maxshape=(None,)
            )

            # 重置统计
            self.stats = {
                "emg1_frames": 0,
                "emg2_frames": 0,
                "imu1a_frames": 0,
                "imu1b_frames": 0,
                "imu2a_frames": 0,
                "imu2b_frames": 0,
                "imu1_all_frames": 0,   # 【新增】
                "imu2_all_frames": 0,   # 【新增】
                "mocap_L_frames": 0,  # 【修改】
                "mocap_R_frames": 0,  # 【修改】
                "prompts": 0
            }
            self.is_collecting = True
            
            # 显示相对路径
            rel_path = os.path.relpath(self.file_path, self.storage_dir)
            debug_log(f"✅ 文件创建成功: {rel_path}")
            debug_log(f"   任务: {task_id}, 用户: {user_id}, Stage: {stage_name}")
            debug_log(f"   分类: {category1}/{category2}/{category4}")

            # Phase 5: 补填父 segment 的 resumed_by 链路
            self._maybe_update_parent_segment_link(self.file_path, params)

            return {
                "status": "success",
                "msg": f"创建Stage文件成功",
                "file_path": self.file_path,
                "stage_name": stage_name
            }
            
        except Exception as e:
            debug_log(f"❌ 创建文件失败: {e}")
            import traceback
            traceback.print_exc()
            return {"status": "error", "msg": f"创建文件失败：{str(e)}"}
    
    def append_data(self, params):
        """追加数据"""
        if not self.f:
            return {"status": "error", "msg": "文件未打开，请先调用create"}

        try:
            data = params.get("data", {})

            with self.lock:
                # 追加EMG1到250Hz数据集
                if data.get("emg1") and data.get("emg1_t"):
                    frame_ids = data.get("emg1_frame_ids")
                    self._append_emg("emg1", data["emg1"], data["emg1_t"], frame_ids)

                # 追加EMG2到250Hz数据集
                if data.get("emg2") and data.get("emg2_t"):
                    frame_ids = data.get("emg2_frame_ids")
                    self._append_emg("emg2", data["emg2"], data["emg2_t"], frame_ids)

                # 追加IMU1到BLE数据集（设备1的两个IMU：imu1a和imu1b）
                if data.get("imu1a") and data.get("imu1_t"):
                    frame_id = data.get("emg1_frame_ids", [0])[0] if data.get("emg1_frame_ids") else None
                    self._append_imu("imu1a", data["imu1a"], data["imu1_t"], frame_id)
                if data.get("imu1b") and data.get("imu1_t"):
                    frame_id = data.get("emg1_frame_ids", [0])[0] if data.get("emg1_frame_ids") else None
                    self._append_imu("imu1b", data["imu1b"], data["imu1_t"], frame_id)

                # 追加IMU2到BLE数据集（设备2的两个IMU：imu2a和imu2b）
                if data.get("imu2a") and data.get("imu2_t"):
                    frame_id = data.get("emg2_frame_ids", [0])[0] if data.get("emg2_frame_ids") else None
                    self._append_imu("imu2a", data["imu2a"], data["imu2_t"], frame_id)
                if data.get("imu2b") and data.get("imu2_t"):
                    frame_id = data.get("emg2_frame_ids", [0])[0] if data.get("emg2_frame_ids") else None
                    self._append_imu("imu2b", data["imu2b"], data["imu2_t"], frame_id)

                # 【新增】V1/V2 通用 IMU 数据写入
                if data.get("imu1_all") and data.get("imu1_t"):
                    frame_id = data.get("emg1_frame_ids", [0])[0] if data.get("emg1_frame_ids") else None
                    hw_version = data.get("imu1_hw_version", "V1")
                    self._append_imu_all("imu1_all", data["imu1_all"], data["imu1_t"], frame_id, hw_version)
                if data.get("imu2_all") and data.get("imu2_t"):
                    frame_id = data.get("emg2_frame_ids", [0])[0] if data.get("emg2_frame_ids") else None
                    hw_version = data.get("imu2_hw_version", "V1")
                    self._append_imu_all("imu2_all", data["imu2_all"], data["imu2_t"], frame_id, hw_version)

                # 【新增】存储 V1/V2 元数据到 HDF5 attrs
                if data.get("imu1_hw_version"):
                    self.f.attrs["imu1_hw_version"] = data["imu1_hw_version"]
                if data.get("imu2_hw_version"):
                    self.f.attrs["imu2_hw_version"] = data["imu2_hw_version"]
                if data.get("imu1_num_imus") is not None:
                    self.f.attrs["imu1_num_imus"] = data["imu1_num_imus"]
                if data.get("imu2_num_imus") is not None:
                    self.f.attrs["imu2_num_imus"] = data["imu2_num_imus"]

                # 【修改】批量追加MOCAP（左右手分开）
                if data.get("mocap_frames"):
                    self._append_mocap_batch(data["mocap_frames"])

                # 追加Prompt
                if data.get("prompt_name"):
                    self._append_prompt(
                        data["prompt_name"],
                        data.get("prompt_time", 0)
                    )

            return {"status": "success", "msg": "数据已追加"}

        except Exception as e:
            debug_log(f"❌ 追加数据失败: {e}")
            return {"status": "error", "msg": f"追加数据失败：{str(e)}"}
    
    def _append_emg(self, dataset_name, emg_data, timestamps, frame_ids=None):
        """追加EMG数据到250Hz ADC数据集

        采集时只保存到250Hz ADC数据集（emg1_250hz_adc/emg2_250hz_adc），
        emg1_2khz_adc/emg2_2khz_adc数据集在同步后由bin_sync_tool填充2kHz数据。

        Args:
            dataset_name: 数据集名称 (emg1 或 emg2)
            emg_data: EMG数据 (16通道 x N帧)
            timestamps: 时间戳列表
            frame_ids: BLE帧号列表（用于与SD卡bin文件同步）
        """
        try:
            if not emg_data or len(emg_data) != 16:
                return 0

            num_frames = len(emg_data[0])
            if len(timestamps) != num_frames:
                if len(timestamps) < num_frames:
                    timestamps = list(timestamps) + [timestamps[-1]] * (num_frames - len(timestamps))
                else:
                    timestamps = timestamps[:num_frames]

            # 确保frame_ids存在且长度匹配
            if frame_ids is None:
                frame_ids = list(range(num_frames))  # 默认从0开始
            elif len(frame_ids) != num_frames:
                if len(frame_ids) < num_frames:
                    last_id = frame_ids[-1] if frame_ids else 0
                    frame_ids = list(frame_ids) + [last_id + j + 1 for j in range(num_frames - len(frame_ids))]
                else:
                    frame_ids = frame_ids[:num_frames]

            # 保存到250Hz ADC数据集
            ds_250hz_name = f"{dataset_name}_250hz_adc"
            if ds_250hz_name in self.f:
                ds_250hz = self.f[ds_250hz_name]

                # 构造250Hz结构化数组
                data_250hz = np.empty(num_frames, dtype=EMG_250HZ_ADC_DTYPE)
                for i in range(num_frames):
                    channels = [emg_data[ch][i] for ch in range(16)]
                    ble_frame_id = frame_ids[i]
                    # H5 250Hz row matches the first 2kHz SD sample in each 8-sample group.
                    sd_frame_id = ble_frame_id * 8

                    data_250hz[i]["channels"] = np.array(channels, dtype=np.int32)
                    data_250hz[i]["frame_id"] = ble_frame_id
                    data_250hz[i]["sd_frame_id"] = sd_frame_id
                    data_250hz[i]["time"] = timestamps[i]

                # 追加到250Hz数据集
                current_len = ds_250hz.shape[0]
                new_len = current_len + num_frames
                ds_250hz.resize(new_len, axis=0)
                ds_250hz[current_len:new_len] = data_250hz

            # 更新统计
            self.stats[f"{dataset_name}_frames"] += num_frames

            return num_frames

        except Exception as e:
            debug_log(f"❌ 追加{dataset_name}失败: {e}")
            return 0

    def _append_imu(self, dataset_name, imu_data, timestamps, frame_id=None):
        """追加IMU数据到BLE数据集

        采集时只保存到BLE数据集（imu1a_ble/imu1b_ble/imu2a_ble/imu2b_ble），
        100Hz数据集在同步后由bin_sync_tool填充。

        Args:
            dataset_name: 数据集名称 (imu1a, imu1b, imu2a, imu2b)
            imu_data: IMU数据 {acc, gyr, mag}
            timestamps: 时间戳列表
            frame_id: BLE帧号（用于与SD卡bin文件同步）
        """
        try:
            if not imu_data or "acc" not in imu_data:
                return 0

            # 保存到BLE数据集
            ds_ble_name = f"{dataset_name}_ble"
            if ds_ble_name in self.f:
                ds_ble = self.f[ds_ble_name]

                # 计算BLE帧号和SD卡帧号
                ble_frame_id = frame_id if frame_id is not None else 0
                # H5 BLE IMU row is anchored to the first 2kHz SD sample in the group.
                sd_frame_id = ble_frame_id * 8

                # 构造BLE数据结构化数组（每次一帧）
                data_ble = np.empty(1, dtype=IMU_BLE_DTYPE)
                data_ble[0]["acc"] = np.array(imu_data.get("acc", [0, 0, 0])[:3], dtype=np.float32)
                data_ble[0]["gyr"] = np.array(imu_data.get("gyr", [0, 0, 0])[:3], dtype=np.float32)
                mag_raw = imu_data.get("mag")
                if mag_raw is None:
                    mag_raw = [0, 0, 0]
                data_ble[0]["mag"] = np.array(mag_raw[:3], dtype=np.float32)
                data_ble[0]["frame_id"] = ble_frame_id
                data_ble[0]["sd_frame_id"] = sd_frame_id
                data_ble[0]["time"] = timestamps[0] if timestamps else 0

                # 追加到BLE数据集
                current_len = ds_ble.shape[0]
                ds_ble.resize(current_len + 1, axis=0)
                ds_ble[current_len] = data_ble[0]

            # 更新统计
            self.stats[f"{dataset_name}_frames"] += 1

            return 1

        except Exception as e:
            debug_log(f"❌ 追加{dataset_name}失败: {e}")
            return 0

    def _append_imu_all(self, dataset_name, imu_list, timestamps, frame_id=None, hw_version="V1"):
        """追加 V1/V2 通用 IMU 数据到 imu*_all_ble 数据集

        支持可变数量 IMU (V1 固定 2, V2 可变 0-3)，
        V1 有磁力计 (has_mag=true)，V2 没有 (has_mag=false, mag 填 NaN)。

        Args:
            dataset_name: "imu1_all" 或 "imu2_all"
            imu_list: [ {index, acc, gyr, mag}, ... ]
            timestamps: 时间戳列表
            frame_id: BLE 帧号
            hw_version: "V1" 或 "V2"
        """
        try:
            if not imu_list or len(imu_list) == 0:
                return 0

            ds_name = f"{dataset_name}_ble"
            if ds_name not in self.f:
                return 0

            ds = self.f[ds_name]
            ble_frame_id = frame_id if frame_id is not None else 0
            sd_frame_id = ble_frame_id * 8
            timestamp = timestamps[0] if timestamps else 0.0
            num_imus = len(imu_list)

            data_ble = np.empty(num_imus, dtype=IMU_ALL_BLE_DTYPE)
            for i, imu in enumerate(imu_list):
                idx = imu.get("index", i)
                acc = np.array(imu.get("acc", [0, 0, 0])[:3], dtype=np.float32)
                gyr = np.array(imu.get("gyr", [0, 0, 0])[:3], dtype=np.float32)
                mag_val = imu.get("mag")
                has_mag = 1 if (hw_version == "V1" and mag_val is not None) else 0
                if has_mag:
                    mag = np.array(mag_val[:3] if mag_val else [0, 0, 0], dtype=np.float32)
                else:
                    mag = np.array([np.nan, np.nan, np.nan], dtype=np.float32)

                data_ble[i]["imu_index"] = idx
                data_ble[i]["acc"] = acc
                data_ble[i]["gyr"] = gyr
                data_ble[i]["has_mag"] = has_mag
                data_ble[i]["mag"] = mag
                data_ble[i]["frame_id"] = ble_frame_id
                data_ble[i]["sd_frame_id"] = sd_frame_id
                data_ble[i]["time"] = timestamp

            current_len = ds.shape[0]
            ds.resize(current_len + num_imus, axis=0)
            ds[current_len:current_len + num_imus] = data_ble

            self.stats[f"{dataset_name}_frames"] += num_imus
            return num_imus

        except Exception as e:
            debug_log(f"❌ 追加{dataset_name}失败: {e}")
            return 0

    def _append_mocap_batch(self, frames_data):
        """【修改】批量追加MOCAP数据（左右手分开存储）"""
        try:
            ds_L = self.f["mocap_L"]
            ds_R = self.f["mocap_R"]

            if not frames_data or len(frames_data) == 0:
                return 0

            num_frames = len(frames_data)

            # 构造结构化数组（批量）
            data_L = np.empty(num_frames, dtype=MOCAP_L_DTYPE)
            data_R = np.empty(num_frames, dtype=MOCAP_R_DTYPE)

            for i, frame_data in enumerate(frames_data):
                markers_data = frame_data.get("markers", {})
                frame_num = frame_data.get("frame", 0)
                # 优先使用系统时间戳 sys_time，与蓝牙数据、prompt保持一致
                timestamp = frame_data.get("sys_time", frame_data.get("time", 0))

                # 填充左手10个marker点的坐标
                for marker_name in MOCAP_MARKER_NAMES_L:
                    coords = markers_data.get(marker_name, [0, 0, 0])
                    data_L[i][marker_name] = np.array(coords[:3], dtype=np.float32)

                data_L[i]["frame"] = int(frame_num) if frame_num else 0
                data_L[i]["time"] = float(timestamp) if timestamp else 0

                # 填充右手10个marker点的坐标
                for marker_name in MOCAP_MARKER_NAMES_R:
                    coords = markers_data.get(marker_name, [0, 0, 0])
                    data_R[i][marker_name] = np.array(coords[:3], dtype=np.float32)

                data_R[i]["frame"] = int(frame_num) if frame_num else 0
                data_R[i]["time"] = float(timestamp) if timestamp else 0

            # 批量追加到左手数据集
            current_len_L = ds_L.shape[0]
            new_len_L = current_len_L + num_frames
            ds_L.resize(new_len_L, axis=0)
            ds_L[current_len_L:new_len_L] = data_L

            # 批量追加到右手数据集
            current_len_R = ds_R.shape[0]
            new_len_R = current_len_R + num_frames
            ds_R.resize(new_len_R, axis=0)
            ds_R[current_len_R:new_len_R] = data_R

            # 更新统计
            self.stats["mocap_L_frames"] += num_frames
            self.stats["mocap_R_frames"] += num_frames

            return num_frames

        except Exception as e:
            debug_log(f"❌ 批量追加mocap失败: {e}")
            return 0

    def _append_prompt(self, name, time):
        """追加Prompt数据"""
        try:
            if not name:
                return 0
            
            prompts = self.f["prompts"]
            
            # 追加name
            names_ds = prompts["names"]
            names_ds.resize(names_ds.shape[0] + 1, axis=0)
            names_ds[-1] = str(name)
            
            # 追加time
            times_ds = prompts["times"]
            times_ds.resize(times_ds.shape[0] + 1, axis=0)
            times_ds[-1] = float(time)
            
            self.stats["prompts"] += 1
            
            return 1
            
        except Exception as e:
            debug_log(f"❌ 追加prompt失败: {e}")
            return 0
    
    def flush(self):
        """刷盘"""
        if self.f:
            self.f.flush()
    
    def close_file(self, params=None):
        """关闭文件

        Args:
            params: 可选扩展参数 dict:
                - collection_status: "completed" | "manual_stopped" | "abnormal_interrupted" | "resumed" | "abandoned"
                - interrupted_at: ISO 时间字符串（仅 abnormal_interrupted 时写入）
                - interrupt_reason: 中断原因（仅 abnormal_interrupted 时写入）
                - resume_progress: JSON 序列化的进度快照（仅 abnormal_interrupted 时写入）
                - segment_index: segment 序号，默认 1
        """
        if params is None:
            params = {}
        try:
            self.flush()

            if self.f:
                # 写入最终统计信息
                self.f.attrs["closed_at"] = datetime.now().isoformat()
                self.f.attrs["total_emg1_frames"] = self.stats["emg1_frames"]
                self.f.attrs["total_emg2_frames"] = self.stats["emg2_frames"]
                # 4个IMU数据集的统计（每设备2个IMU传感器）
                self.f.attrs["total_imu1a_frames"] = self.stats["imu1a_frames"]
                self.f.attrs["total_imu1b_frames"] = self.stats["imu1b_frames"]
                self.f.attrs["total_imu2a_frames"] = self.stats["imu2a_frames"]
                self.f.attrs["total_imu2b_frames"] = self.stats["imu2b_frames"]
                self.f.attrs["total_imu1_all_frames"] = self.stats["imu1_all_frames"]
                self.f.attrs["total_imu2_all_frames"] = self.stats["imu2_all_frames"]
                self.f.attrs["total_prompts"] = self.stats["prompts"]

                # ==================== 采集状态标记（断点续采支持） ====================
                # collection_status: 采集完成状态
                collection_status = params.get("collection_status", "completed")
                self.f.attrs["collection_status"] = str(collection_status)
                debug_log(f"   collection_status: {collection_status}")

                # segment_index: 仅当 close 显式传了 segment_index 时才写
                # 否则保留 create_file 已写入的值（续采模式下为 2+）
                if "segment_index" in params:
                    self.f.attrs["segment_index"] = int(params["segment_index"])
                    debug_log(f"   segment_index (close覆盖): {params['segment_index']}")

                # 异常中断相关属性（仅当 collection_status 为 abnormal_interrupted 时写入）
                if collection_status == "abnormal_interrupted":
                    interrupted_at = params.get("interrupted_at")
                    if interrupted_at:
                        self.f.attrs["interrupted_at"] = str(interrupted_at)
                        debug_log(f"   interrupted_at: {interrupted_at}")

                    interrupt_reason = params.get("interrupt_reason")
                    if interrupt_reason:
                        self.f.attrs["interrupt_reason"] = str(interrupt_reason)
                        debug_log(f"   interrupt_reason: {interrupt_reason}")

                    resume_progress = params.get("resume_progress")
                    if resume_progress:
                        self.f.attrs["resume_progress"] = str(resume_progress)
                        debug_log(f"   resume_progress: {resume_progress[:80]}...")

                    # Phase 6 fix: 完整可恢复 breakpoint state（优先于 resume_progress）
                    breakpoint_state = params.get("breakpoint_state")
                    if breakpoint_state:
                        self.f.attrs["breakpoint_state"] = str(breakpoint_state)
                        debug_log(f"   breakpoint_state: 已写入完整可恢复状态")

                    # Phase 3: interruption_id — 从已有 attrs 复用（create 时已生成）
                    # 如果 create 时已有，不覆盖；否则在此生成
                    if "interruption_id" not in self.f.attrs:
                        rec_id = self.f.attrs.get("recording_session_id", "unknown")
                        seg_idx = self.f.attrs.get("segment_index", 1)
                        self.f.attrs["interruption_id"] = (
                            f"int_{rec_id}_seg{seg_idx}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
                        )

                # 注意：sync_status 保持 pending，不受 collection_status 影响
                # 只有 bin_sync_tool 才能将 sync_status 改为 synced 或 sync_failed

                # ---- stream 关闭元数据 ----
                stream_mode = self.f.attrs.get("stream_mode", "unknown")
                if isinstance(stream_mode, bytes):
                    stream_mode = stream_mode.decode("utf-8")
                if stream_mode == "collection":
                    self.f.attrs["collection_stream_stopped_at"] = datetime.now().isoformat()
                    self.f.attrs["collection_bin_finalized"] = "true"
                    debug_log(f"   collection_stream_stopped_at: {self.f.attrs['collection_stream_stopped_at']}")
                elif stream_mode == "preview":
                    self.f.attrs["preview_bin_finalized"] = "true"
                    debug_log(f"   preview_bin_finalized: true")

                # ==================== 视频时间戳（MP4帧与H5数据的时间对应） ====================
                # 结构与 prompts 一致：每一行对应一个摄像头
                video_timing = params.get("video_timing", {}) or {}
                sides, firsts, lasts, durs = [], [], [], []
                for side in ["left", "right"]:
                    timing = video_timing.get(side)
                    if timing and isinstance(timing, dict):
                        sides.append(side)
                        firsts.append(float(timing.get("first_frame_unix", 0)))
                        lasts.append(float(timing.get("last_frame_unix", 0)))
                        durs.append(float(timing.get("duration", 0)))
                        debug_log(f"   video_timing/{side}: first_frame={timing.get('first_frame_unix')}, "
                                  f"last_frame={timing.get('last_frame_unix')}, duration={timing.get('duration')}")

                if sides:
                    video_grp = self.f.create_group("video_timing")
                    dt_str = h5py.string_dtype()
                    video_grp.create_dataset("sides", data=np.array(sides, dtype=dt_str))
                    video_grp.create_dataset("first_frame_unix", data=np.array(firsts, dtype=np.float64))
                    video_grp.create_dataset("last_frame_unix", data=np.array(lasts, dtype=np.float64))
                    video_grp.create_dataset("duration", data=np.array(durs, dtype=np.float64))

                # ==================== 视频文件名（AVI 与 H5 的对应该关系） ====================
                for side_key, attr_key in [("left", "video_left"), ("right", "video_right")]:
                    video_path = params.get(attr_key)
                    if video_path:
                        # 只存储文件名（不含路径），因为 AVI 文件始终在 storage/video/ 下
                        video_name = os.path.basename(str(video_path))
                        self.f.attrs[attr_key] = video_name
                        debug_log(f"   {attr_key}: {video_name}")

                # ==================== Phase 3: frame/time range 与 segment/bin 元数据 ====================
                self._write_segment_metadata(params)

                self.f.close()
                self.f = None
            
            self.is_collecting = False

            rel_path = os.path.relpath(self.file_path, self.storage_dir) if self.file_path else "N/A"
            debug_log(f"✅ 文件已关闭: {rel_path}")
            debug_log(f"📊 统计: EMG1={self.stats['emg1_frames']}, EMG2={self.stats['emg2_frames']}, "
                     f"IMU1A={self.stats['imu1a_frames']}, IMU1B={self.stats['imu1b_frames']}, "
                     f"IMU1_ALL={self.stats['imu1_all_frames']}, "
                     f"IMU2A={self.stats['imu2a_frames']}, IMU2B={self.stats['imu2b_frames']}, "
                     f"IMU2_ALL={self.stats['imu2_all_frames']}, "
                     f"MOCAP_L={self.stats['mocap_L_frames']}, MOCAP_R={self.stats['mocap_R_frames']}, "
                     f"Prompts={self.stats['prompts']}")
            
            return {
                "status": "success",
                "msg": f"文件已保存并关闭",
                "file_path": self.file_path,
                "stats": self.stats.copy()
            }
            
        except Exception as e:
            debug_log(f"❌ 关闭文件失败: {e}")
            return {"status": "error", "msg": f"关闭文件失败：{str(e)}"}
    
    def _write_segment_metadata(self, params):
        """Phase 3: 写入 frame/time range 和 segment/bin 元数据到 H5 attrs"""
        try:
            # ---- 1. end_time ----
            end_time_val = params.get("end_time")
            if end_time_val:
                self.f.attrs["end_time"] = float(end_time_val)

            # ---- 2. 从 H5 dataset 计算 frame_id range ----
            seg_meta = {"devices": {}}

            for dev_label, ds_250hz_name in [("dev1", "emg1_250hz_adc"), ("dev2", "emg2_250hz_adc")]:
                if ds_250hz_name not in self.f:
                    self.f.attrs[f"emg{dev_label[-1]}_frame_id_min"] = -1
                    self.f.attrs[f"emg{dev_label[-1]}_frame_id_max"] = -1
                    self.f.attrs[f"emg{dev_label[-1]}_frame_count"] = 0
                    self.f.attrs[f"emg{dev_label[-1]}_time_min"] = -1.0
                    self.f.attrs[f"emg{dev_label[-1]}_time_max"] = -1.0
                    continue

                ds = self.f[ds_250hz_name]
                n = ds.shape[0]
                self.f.attrs[f"emg{dev_label[-1]}_frame_count"] = n

                if n > 0:
                    data = ds[:]
                    frame_ids = data["frame_id"]
                    times = data["time"]

                    fid_min = int(np.min(frame_ids))
                    fid_max = int(np.max(frame_ids))
                    t_min = float(np.min(times))
                    t_max = float(np.max(times))

                    self.f.attrs[f"emg{dev_label[-1]}_frame_id_min"] = fid_min
                    self.f.attrs[f"emg{dev_label[-1]}_frame_id_max"] = fid_max
                    self.f.attrs[f"emg{dev_label[-1]}_time_min"] = t_min
                    self.f.attrs[f"emg{dev_label[-1]}_time_max"] = t_max

                    seg_meta["devices"][dev_label] = {
                        "frame_id_min": fid_min,
                        "frame_id_max": fid_max,
                        "frame_count": int(n),
                        "time_min": t_min,
                        "time_max": t_max,
                    }
                    debug_log(f"   {dev_label}: {n} frames, frame_id [{fid_min}, {fid_max}], "
                             f"time [{t_min:.3f}, {t_max:.3f}]")
                else:
                    self.f.attrs[f"emg{dev_label[-1]}_frame_id_min"] = -1
                    self.f.attrs[f"emg{dev_label[-1]}_frame_id_max"] = -1
                    self.f.attrs[f"emg{dev_label[-1]}_time_min"] = -1.0
                    self.f.attrs[f"emg{dev_label[-1]}_time_max"] = -1.0

            # ---- 3. segment_bin_summary JSON ----
            for dev_label, dev_key in [("dev1", "sd_bin_dev1"), ("dev2", "sd_bin_dev2")]:
                ble_key = f"ble_device_{dev_label}"
                bin_prefix = self.f.attrs.get(dev_key, None)
                ble_name = self.f.attrs.get(ble_key, None)

                if isinstance(bin_prefix, bytes):
                    bin_prefix = bin_prefix.decode("utf-8")
                if isinstance(ble_name, bytes):
                    ble_name = ble_name.decode("utf-8")

                has_bin = bool(bin_prefix)
                self.f.attrs[f"segment_has_{dev_label}_bin"] = has_bin

                if dev_label in seg_meta.get("devices", {}):
                    seg_meta["devices"][dev_label]["sd_bin"] = bin_prefix or None
                    seg_meta["devices"][dev_label]["ble_device"] = ble_name or None

            dev_count = sum(1 for d in seg_meta.get("devices", {}).values() if d.get("frame_count", 0) > 0)
            seg_meta["device_count"] = dev_count
            self.f.attrs["segment_device_count"] = dev_count
            self.f.attrs["segment_bin_summary"] = json.dumps(seg_meta, ensure_ascii=False)
            debug_log(f"   segment_bin_summary: {dev_count} devices")

        except Exception as e:
            debug_log(f"⚠️ 写入 segment metadata 失败: {e}")

    def get_stats(self):
        """获取统计信息"""
        return {
            "file_path": self.file_path,
            "task_id": self.current_task_id,
            "user_id": self.current_user_id,
            "stage_name": self.current_stage_name,
            "category1": self.current_category1,
            "category2": self.current_category2,
            "category4": self.current_category4,
            "is_collecting": self.is_collecting,
            # 【新增】Session信息
            "session_index": self.current_session_index,
            "session_number": self.current_session_number,
            "session_count": self.session_count,
            **self.stats
        }

    def record_video_info(self, params):
        """
        记录视频文件信息到H5文件属性

        参数:
            params (dict): 包含视频文件信息
                - video_left: 左手视频文件名
                - video_right: 右手视频文件名
                - video_start_timestamp: 视频开始时间戳（对应space按下时刻）
                - h5_file_name: 关联的H5文件名（可选，用于验证）
        """
        try:
            if not self.f:
                debug_log("❌ 记录视频信息失败: H5文件未打开")
                return {"status": "error", "msg": "H5文件未打开"}

            video_left = params.get("video_left")
            video_right = params.get("video_right")
            video_start_timestamp = params.get("video_start_timestamp")
            h5_file_name = params.get("h5_file_name")

            debug_log(f"📹 记录视频文件信息:")

            # 写入视频文件名到H5属性
            if video_left:
                self.f.attrs["video_left"] = video_left
                debug_log(f"   video_left: {video_left}")

            if video_right:
                self.f.attrs["video_right"] = video_right
                debug_log(f"   video_right: {video_right}")

            if video_start_timestamp is not None:
                self.f.attrs["video_start_timestamp"] = float(video_start_timestamp)
                debug_log(f"   video_start_timestamp: {video_start_timestamp}")

            if h5_file_name:
                debug_log(f"   关联H5文件: {h5_file_name}")

            # 强制刷盘
            self.f.flush()
            debug_log("✅ 视频信息已写入H5文件")

            return {
                "status": "success",
                "msg": "视频信息已记录",
                "video_left": video_left,
                "video_right": video_right
            }

        except Exception as e:
            debug_log(f"❌ 记录视频信息失败: {e}")
            return {"status": "error", "msg": f"记录视频信息失败：{str(e)}"}

    def get_directory_tree(self):
        """获取存储目录树结构（用于统计页面）"""
        tree = {}
        
        for root, dirs, files in os.walk(self.storage_dir):
            rel_root = os.path.relpath(root, self.storage_dir)
            
            # 计算深度
            if rel_root == '.':
                depth = 0
                current = tree
            else:
                parts = rel_root.split(os.sep)
                depth = len(parts)
                current = tree
                for part in parts:
                    if part not in current:
                        current[part] = {"_files": [], "_subdirs": {}}
                    current = current[part]["_subdirs"]
            
            # 只统计h5文件
            h5_files = [f for f in files if f.endswith('.h5')]
            if h5_files and rel_root != '.':
                parts = rel_root.split(os.sep)
                current = tree
                for part in parts[:-1]:
                    current = current[part]["_subdirs"]
                if parts[-1] not in current:
                    current[parts[-1]] = {"_files": [], "_subdirs": {}}
                current[parts[-1]]["_files"] = h5_files
        
        return tree
    
    def run(self):
        """启动服务，循环处理客户端请求"""
        debug_log("🚀 存储服务开始运行 (v4.3 - PUSH/PULL优化版)...")
        debug_log(f"   控制端口: 5555 (REP模式，用于create/close/stats)")
        debug_log(f"   数据端口: 5556 (PULL模式，用于append数据)")
        debug_log(f"   目录结构: task/category1/category2/category4/user_id/")
        debug_log(f"   文件命名: [user_id]_session{{N}}_[stage]_[date]_[time].h5")

        # 使用 poller 同时监听两个 socket
        poller = zmq.Poller()
        poller.register(self.socket, zmq.POLLIN)        # REP socket (控制命令)
        poller.register(self.data_socket, zmq.POLLIN)   # PULL socket (数据)

        try:
            while True:
                # 等待事件，超时100ms
                socks = dict(poller.poll(100))

                # 处理控制命令 (REP socket)
                if self.socket in socks:
                    request = self.socket.recv_json()

                    cmd = request.get("cmd")
                    params = request.get("params", {})

                    # 处理命令
                    if cmd == "create":
                        response = self.create_file(params)
                    elif cmd == "append":
                        # 兼容旧版：REP socket 也支持 append
                        response = self.append_data(params)
                    elif cmd == "close":
                        response = self.close_file(params)
                    elif cmd == "stats":
                        response = {"status": "success", "data": self.get_stats()}
                    elif cmd == "flush":
                        self.flush()
                        response = {"status": "success", "msg": "数据已刷盘"}
                    elif cmd == "tree":
                        response = {"status": "success", "data": self.get_directory_tree()}
                    elif cmd == "video_recording_started":
                        # 【新增】处理视频录制信息
                        response = self.record_video_info(params)
                    else:
                        response = {
                            "status": "error",
                            "msg": f"未知指令：{cmd}，支持的指令：create/append/close/stats/flush/tree/video_recording_started"
                        }

                    # 发送响应
                    self.socket.send_json(response)

                # 处理数据 (PULL socket) - 非阻塞，不需要响应
                if self.data_socket in socks:
                    try:
                        request = self.data_socket.recv_json(zmq.NOBLOCK)
                        cmd = request.get("cmd")
                        if cmd == "append":
                            params = request.get("params", {})
                            self.append_data(params)
                            # PULL 模式不需要响应
                    except zmq.Again:
                        pass  # 没有数据，继续

        except KeyboardInterrupt:
            debug_log("\n⚠️ 服务正在关闭...")
        finally:
            self.close_file()
            self.socket.close()
            self.data_socket.close()
            self.context.term()
            debug_log("✅ 服务已关闭")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='HDF5 Storage Server v4.2 (包含Session信息)')
    parser.add_argument('--storage_dir', type=str, default='./storage',
                        help='HDF5文件存储目录')
    parser.add_argument('--port', type=int, default=5555,
                        help='ZeroMQ监听端口')
    
    args = parser.parse_args()
    
    server = HDF5StorageServer(port=args.port, storage_dir=args.storage_dir)
    server.run()
