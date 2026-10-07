#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mocap_server.py - 动捕数据服务器
================================
用于接收动捕数据并计算手势参数，通过WebSocket发送给realtimeEngine.js

数据源（两种模式）：
- SDK模式：连接 Nokov 动捕 SDK (服务器IP: 10.1.1.198)
- 模拟器模式：连接 mocap_simulator.py (ws://localhost:8768)

Marker点命名（每只手10个，共20个，按接收顺序）：
- 左手：IN1_L, IN2_L, IN3_L, HB1_L, HB2_L, HB3_L, TH1_L, TH2_L, TH3_L, TH4_L
- 右手：IN1_R, IN2_R, IN3_R, HB1_R, HB2_R, HB3_R, TH1_R, TH2_R, TH3_R, TH4_R
- 注意：IN1/IN2/IN3 对应食指，TH1/TH2/TH3/TH4 对应拇指，HB1/HB2/HB3 对应手背

数据通道（左右手各自独立计算）：
- finger_joint_angle_L/R: 食指关节角度 (0-90°) - 连续手势1 (食指上抬)
  计算方法：用 IN3 到 HB2 的连线方向，与 HB1, HB2, HB3 平面法向量的夹角
- thumb_index_distance_L/R: 拇指食指距离 (mm) - 连续手势2 (捏合)
  计算方法：用 TH1 和 IN1 的距离

WebSocket端口: 8767 (供 realtimeEngine.js 连接)

使用方法：
    # SDK模式（连接真实动捕设备）
    python mocap_server.py -s 10.1.1.198

    # 模拟器模式（本地调试）
    python mocap_server.py --simulator
"""

import asyncio
import websockets
import json
import time
import math
import sys
import io
import threading
from collections import deque

# 编码配置
try:
    sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
    sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)
except (AttributeError, ValueError):
    pass

try:
    import numpy as np
except ImportError:
    print("[MocapServer] 错误: 请安装 numpy: pip install numpy", file=sys.stderr)
    sys.exit(1)


# ==================== 配置 ====================

# Nokov SDK 服务器地址
NOKOV_SERVER_IP = "10.1.1.198"

# 模拟器地址
SIMULATOR_URL = "ws://localhost:8768"

# 本服务器端口
SERVER_HOST = "localhost"
SERVER_PORT = 8767

# 数据发送频率
SEND_RATE = 50  # Hz

# Marker 名称映射
# 顺序：IN1, IN2, IN3, HB1, HB2, HB3, TH1, TH2, TH3, TH4
# 注意：IN1/IN2/IN3 对应食指，TH1/TH2/TH3/TH4 对应拇指，HB1/HB2/HB3 对应手背
MARKER_BASE_NAMES = ['IN1', 'IN2', 'IN3', 'HB1', 'HB2', 'HB3', 'TH1', 'TH2', 'TH3', 'TH4']
MARKER_NAMES_LEFT = [f'{name}_L' for name in MARKER_BASE_NAMES]
MARKER_NAMES_RIGHT = [f'{name}_R' for name in MARKER_BASE_NAMES]
MARKER_NAMES = MARKER_NAMES_LEFT + MARKER_NAMES_RIGHT

# MarkerSet 名称识别规则（用于判断左右手）
# 左手: 名称包含 "L-" 或以 "-L" / "_L" 结尾
# 右手: 名称包含 "R-" 或以 "-R" / "_R" 结尾
def get_hand_suffix_from_markerset_name(set_name):
    """根据 MarkerSet 名称判断左右手后缀

    支持的命名格式示例：
    - "WH-L", "WH-R" (以 -L/-R 结尾)
    - "L-YC", "R-YC" (以 L-/R- 开头)
    - "hand_L", "hand_R" (以 _L/_R 结尾)
    """
    if not set_name:
        return None
    name_upper = set_name.upper()
    if 'L-' in name_upper or name_upper.endswith('_L') or name_upper.endswith('-L') or name_upper.startswith('L_'):
        return '_L'
    elif 'R-' in name_upper or name_upper.endswith('_R') or name_upper.endswith('-R') or name_upper.startswith('R_'):
        return '_R'
    return None


# ==================== 手势计算函数 ====================

def fit_line_direction(p1, p2, p3):
    """用三个点拟合直线，返回方向向量（单位向量）"""
    p1, p2, p3 = np.array(p1), np.array(p2), np.array(p3)
    direction = p3 - p1
    norm = np.linalg.norm(direction)
    if norm < 1e-6:
        return np.array([0, 0, 1])
    return direction / norm


def fit_plane_normal(p1, p2, p3):
    """用三个点拟合平面，返回法向量（单位向量）"""
    p1, p2, p3 = np.array(p1), np.array(p2), np.array(p3)
    v1 = p2 - p1
    v2 = p3 - p1
    normal = np.cross(v1, v2)
    norm = np.linalg.norm(normal)
    if norm < 1e-6:
        return np.array([0, 0, 1])
    return normal / norm


def calculate_finger_joint_angle(markers, hand='L'):
    """计算食指上抬角度（连续手势1）

    使用 IN3 到 HB2 的连线方向，与 HB1, HB2, HB3 平面法向量的夹角
    返回: 0° = 食指竖直（与手掌垂直）, 90° = 食指平放（与手掌平行）

    Args:
        markers: marker数据字典
        hand: 'L' 或 'R'，指定左手或右手
    """
    suffix = f'_{hand}'

    in3 = np.array(markers.get(f"IN3{suffix}", [0, 0, 0]))
    hb1 = np.array(markers.get(f"HB1{suffix}", [0, 0, 0]))
    hb2 = np.array(markers.get(f"HB2{suffix}", [0, 0, 0]))
    hb3 = np.array(markers.get(f"HB3{suffix}", [0, 0, 0]))

    # 检查坐标是否有效
    all_points = [in3, hb1, hb2, hb3]
    if any(any(abs(v) > 100000 for v in p) for p in all_points):
        return None  # 无效数据

    # 计算 IN3 到 HB2 的方向向量
    finger_dir = in3 - hb2
    norm = np.linalg.norm(finger_dir)
    if norm < 1e-6:
        return None  # 两点重合，无法计算
    finger_dir = finger_dir / norm

    # 计算手掌平面法向量
    palm_normal = fit_plane_normal(hb1, hb2, hb3)

    cos_angle = abs(np.dot(finger_dir, palm_normal))
    cos_angle = np.clip(cos_angle, -1, 1)
    angle_with_normal = math.degrees(math.acos(cos_angle))

    # 直接返回食指与法线的夹角
    # 食指平放时与法线夹角≈90°
    # 食指竖直时与法线夹角≈0°
    return angle_with_normal


def calculate_thumb_index_distance(markers, hand='L'):
    """计算拇指食指距离（连续手势2）

    使用 TH1 和 IN1 的距离

    Args:
        markers: marker数据字典
        hand: 'L' 或 'R'，指定左手或右手
    """
    suffix = f'_{hand}'

    th1 = np.array(markers.get(f"TH1{suffix}", [0, 0, 0]))
    in1 = np.array(markers.get(f"IN1{suffix}", [0, 0, 0]))

    # 检查坐标是否有效
    if any(abs(v) > 100000 for v in th1) or any(abs(v) > 100000 for v in in1):
        return None  # 无效数据

    distance = np.linalg.norm(th1 - in1)
    return distance


# 用于保存上一次有效的值（左右手分别保存）
_last_valid_values = {
    'finger_joint_angle_L': 45.0,
    'finger_joint_angle_R': 45.0,
    'thumb_index_distance_L': 50.0,
    'thumb_index_distance_R': 50.0,
}


# ==================== 数据接收器基类 ====================

class BaseMocapReceiver:
    """动捕数据接收器基类"""

    def __init__(self):
        self.connected = False
        self.latest_markers = {}
        self.latest_frame = 0
        self.latest_timestamp = 0
        self._frame_buffer = deque(maxlen=1000)
        self._dropped_frames = 0
        self._buffer_lock = threading.Lock()
        self._last_print_time = 0
        self._print_interval = 1.0

    def _print_frame_info(self, markers, frame_no):
        """打印一帧数据信息"""
        if not markers:
            return

        # 左手
        finger_angle_L = calculate_finger_joint_angle(markers, 'L')
        pinch_dist_L = calculate_thumb_index_distance(markers, 'L')

        # 右手
        finger_angle_R = calculate_finger_joint_angle(markers, 'R')
        pinch_dist_R = calculate_thumb_index_distance(markers, 'R')

        # 格式化输出（None显示为 --）
        fa_L = f"{finger_angle_L:>5.1f}" if finger_angle_L is not None else "   --"
        pd_L = f"{pinch_dist_L:>5.1f}" if pinch_dist_L is not None else "   --"
        fa_R = f"{finger_angle_R:>5.1f}" if finger_angle_R is not None else "   --"
        pd_R = f"{pinch_dist_R:>5.1f}" if pinch_dist_R is not None else "   --"

        print(f"[Mocap] Frame:{frame_no:>5} | "
              f"L: 食指:{fa_L}° 捏合:{pd_L}mm | "
              f"R: 食指:{fa_R}° 捏合:{pd_R}mm")

    def get_markers(self):
        """获取最新的 marker 数据"""
        return self.latest_markers

    def get_buffered_frames(self):
        """获取并清空缓冲区中的所有帧"""
        with self._buffer_lock:
            frames = list(self._frame_buffer)
            self._frame_buffer.clear()
            return frames

    def _append_frame(self, frame):
        with self._buffer_lock:
            if len(self._frame_buffer) >= self._frame_buffer.maxlen:
                self._dropped_frames += 1
            self._frame_buffer.append(frame)

    def pop_dropped_frames(self):
        with self._buffer_lock:
            count = self._dropped_frames
            self._dropped_frames = 0
            return count

    def connect(self):
        """连接数据源（子类实现）"""
        raise NotImplementedError

    def disconnect(self):
        """断开连接（子类实现）"""
        raise NotImplementedError


# ==================== Nokov SDK 数据接收器 ====================

class NokovSDKReceiver(BaseMocapReceiver):
    """从 Nokov SDK 接收动捕数据"""

    def __init__(self, server_ip=NOKOV_SERVER_IP):
        super().__init__()
        self.server_ip = server_ip
        self.sdk_client = None

    def _data_callback(self, pFrameOfMocapData, pUserData):
        """SDK 数据回调函数"""
        if pFrameOfMocapData is None:
            return

        try:
            frameData = pFrameOfMocapData.contents
            frame_no = frameData.iFrame
            timestamp = frameData.iTimeStamp

            if frame_no == self.latest_frame:
                return

            self.latest_frame = frame_no
            self.latest_timestamp = timestamp

            markers = {}

            # 【修正】根据 MarkerSet 名称判断左右手，而不是按接收顺序
            for iMarkerSet in range(frameData.nMarkerSets):
                markerset = frameData.MocapData[iMarkerSet]

                # 获取 MarkerSet 名称（如 "R-YC" 或 "L-YC"）
                try:
                    set_name = markerset.szName.decode('utf-8')
                except:
                    set_name = str(markerset.szName)

                # 根据名称判断左右手
                suffix = get_hand_suffix_from_markerset_name(set_name)

                if suffix is None:
                    # 无法识别左右手，打印警告并跳过
                    print(f"[NokovSDK] 警告: 无法识别 MarkerSet '{set_name}' 的左右手，跳过")
                    continue

                # 为该 MarkerSet 的每个 marker 分配正确的名称
                for iMarker in range(markerset.nMarkers):
                    if iMarker < len(MARKER_BASE_NAMES):
                        marker_name = MARKER_BASE_NAMES[iMarker] + suffix
                        x = markerset.Markers[iMarker][0]
                        y = markerset.Markers[iMarker][1]
                        z = markerset.Markers[iMarker][2]
                        markers[marker_name] = [x, y, z]

            self.latest_markers = markers

            self._append_frame({
                    "markers": markers.copy(),
                    "frame": frame_no,
                    "time": timestamp,            # SDK 相对时间戳（动捕系统启动后的秒数）
                    "sys_time": time.time()       # 系统 Unix 时间戳（与 EMG 对齐）
                })

            current_time = time.time()
            if current_time - self._last_print_time >= self._print_interval:
                self._last_print_time = current_time
                self._print_frame_info(markers, frame_no)

        except Exception as e:
            print(f"[NokovSDK] 数据回调错误: {e}")

    def _msg_callback(self, iLogLevel, szLogMessage):
        """SDK 消息回调"""
        from ctypes import cast, c_char_p
        levels = {4: "Debug", 3: "Info", 2: "Warning", 1: "Error"}
        level = levels.get(iLogLevel, "None")
        if iLogLevel <= 2:
            msg = cast(szLogMessage, c_char_p).value
            print(f"[NokovSDK][{level}] {msg}")

    def connect(self):
        """连接到 Nokov SDK"""
        try:
            from nokov.nokovsdk import PySDKClient

            print(f"[NokovSDK] 正在连接到服务器 {self.server_ip}...")

            self.sdk_client = PySDKClient()
            ver = self.sdk_client.PyNokovVersion()
            print(f"[NokovSDK] SDK版本: {ver[0]}.{ver[1]}.{ver[2]}.{ver[3]}")

            ret = self.sdk_client.Initialize(bytes(self.server_ip, encoding="utf8"))

            if ret == 0:
                print("[NokovSDK] 连接成功!")
                self.connected = True
                self.sdk_client.PySetDataCallback(self._data_callback, None)
                self.sdk_client.PySetVerbosityLevel(0)
                self.sdk_client.PySetMessageCallback(self._msg_callback)
                return True
            else:
                print(f"[NokovSDK] 连接失败，错误码: {ret}")
                self.connected = False
                return False

        except ImportError:
            print("[NokovSDK] 错误: 未安装 nokov SDK")
            self.connected = False
            return False
        except Exception as e:
            print(f"[NokovSDK] 连接错误: {e}")
            self.connected = False
            return False

    def disconnect(self):
        """断开 SDK 连接"""
        try:
            if self.sdk_client:
                self.sdk_client = None
            self.connected = False
            self.latest_markers = {}
            self.latest_frame = 0
            print("[NokovSDK] 已断开连接")
            return True
        except Exception as e:
            print(f"[NokovSDK] 断开错误: {e}")
            return False


# ==================== 模拟器数据接收器 ====================

class SimulatorReceiver(BaseMocapReceiver):
    """从 mocap_simulator.py 接收动捕数据（WebSocket）"""

    def __init__(self, simulator_url=SIMULATOR_URL):
        super().__init__()
        self.simulator_url = simulator_url
        self.ws = None
        self._running = False
        self._connect_task = None

    async def _receive_loop(self):
        """WebSocket 接收循环"""
        while self._running:
            try:
                self.ws = await websockets.connect(self.simulator_url)
                self.connected = True
                print(f"[Simulator] 已连接到模拟器 {self.simulator_url}")

                async for message in self.ws:
                    if not self._running:
                        break
                    try:
                        data = json.loads(message)
                        msg_type = data.get("type", "")

                        if msg_type == "mocap_data":
                            markers = data.get("markers", {})
                            frame_no = data.get("frame", 0)
                            timestamp = data.get("time", 0)

                            if frame_no == self.latest_frame:
                                continue

                            self.latest_frame = frame_no
                            self.latest_timestamp = timestamp
                            self.latest_markers = markers

                            self._append_frame({
                                    "markers": markers.copy(),
                                    "frame": frame_no,
                                    "time": timestamp,            # 模拟器时间戳
                                    "sys_time": time.time()       # 系统 Unix 时间戳（与 EMG 对齐）
                                })

                            current_time = time.time()
                            if current_time - self._last_print_time >= self._print_interval:
                                self._last_print_time = current_time
                                self._print_frame_info(markers, frame_no)

                    except json.JSONDecodeError:
                        pass

            except websockets.exceptions.ConnectionClosed:
                pass
            except ConnectionRefusedError:
                pass
            except Exception as e:
                print(f"[Simulator] 连接错误: {e}")

            self.connected = False
            self.ws = None

            if self._running:
                await asyncio.sleep(2.0)

    def connect(self):
        """启动连接到模拟器"""
        self._running = True
        print(f"[Simulator] 准备连接到模拟器 {self.simulator_url}")
        # 连接会在 asyncio 事件循环中进行
        return True

    def disconnect(self):
        """断开模拟器连接"""
        self._running = False
        if self.ws:
            asyncio.create_task(self.ws.close())
        self.connected = False
        self.latest_markers = {}
        self.latest_frame = 0
        print("[Simulator] 已断开连接")
        return True

    async def start_receive_loop(self):
        """启动接收循环（需要在 asyncio 中调用）"""
        if self._running:
            await self._receive_loop()


# ==================== 动捕服务器 ====================

class MocapServer:
    """动捕数据WebSocket服务器"""

    def __init__(self, host=SERVER_HOST, port=SERVER_PORT, use_simulator=False):
        self.host = host
        self.port = port
        self.clients = set()
        self.use_simulator = use_simulator

        # 根据模式选择数据接收器
        if use_simulator:
            self.receiver = SimulatorReceiver()
            print("[MocapServer] 使用模拟器模式")
        else:
            self.receiver = NokovSDKReceiver()
            print("[MocapServer] 使用SDK模式")

        self.sdk_connected = False
        self.collecting = False
        self.active_gesture = None

        # 通道配置（左右手各自独立）
        self.channels = {
            # 左手通道
            'finger_joint_angle_L': {
                'value': 0.0, 'min': 0.0, 'max': 90.0,
                'unit': '°', 'description': '左手食指关节角度'
            },
            'thumb_index_distance_L': {
                'value': 0.0, 'min': 0.0, 'max': 150.0,
                'unit': 'mm', 'description': '左手拇指食指距离'
            },
            # 右手通道
            'finger_joint_angle_R': {
                'value': 0.0, 'min': 0.0, 'max': 90.0,
                'unit': '°', 'description': '右手食指关节角度'
            },
            'thumb_index_distance_R': {
                'value': 0.0, 'min': 0.0, 'max': 150.0,
                'unit': 'mm', 'description': '右手拇指食指距离'
            }
        }

        # 当前激活的通道（连续手势1或2）
        self.active_channel = 'finger_joint_angle'  # 不带后缀，表示手势类型
        self.send_rate = SEND_RATE
        self._running = False

    def update_from_mocap(self):
        """从动捕数据更新通道值（左右手分别计算）"""
        global _last_valid_values
        markers = self.receiver.get_markers()
        if not markers:
            return

        # 左手
        finger_angle_L = calculate_finger_joint_angle(markers, 'L')
        pinch_dist_L = calculate_thumb_index_distance(markers, 'L')

        # 右手
        finger_angle_R = calculate_finger_joint_angle(markers, 'R')
        pinch_dist_R = calculate_thumb_index_distance(markers, 'R')

        # 更新通道值（使用上次有效值填充无效数据）
        if finger_angle_L is not None:
            self.channels['finger_joint_angle_L']['value'] = finger_angle_L
            _last_valid_values['finger_joint_angle_L'] = finger_angle_L
        else:
            self.channels['finger_joint_angle_L']['value'] = _last_valid_values['finger_joint_angle_L']

        if pinch_dist_L is not None:
            self.channels['thumb_index_distance_L']['value'] = pinch_dist_L
            _last_valid_values['thumb_index_distance_L'] = pinch_dist_L
        else:
            self.channels['thumb_index_distance_L']['value'] = _last_valid_values['thumb_index_distance_L']

        if finger_angle_R is not None:
            self.channels['finger_joint_angle_R']['value'] = finger_angle_R
            _last_valid_values['finger_joint_angle_R'] = finger_angle_R
        else:
            self.channels['finger_joint_angle_R']['value'] = _last_valid_values['finger_joint_angle_R']

        if pinch_dist_R is not None:
            self.channels['thumb_index_distance_R']['value'] = pinch_dist_R
            _last_valid_values['thumb_index_distance_R'] = pinch_dist_R
        else:
            self.channels['thumb_index_distance_R']['value'] = _last_valid_values['thumb_index_distance_R']

    async def register(self, websocket):
        self.clients.add(websocket)
        print(f"[MocapServer] 客户端连接 (总数: {len(self.clients)})")

    async def unregister(self, websocket):
        self.clients.discard(websocket)
        print(f"[MocapServer] 客户端断开 (剩余: {len(self.clients)})")

    async def handle_message(self, websocket, message):
        """处理来自客户端的消息"""
        try:
            data = json.loads(message)
            cmd = data.get('cmd')

            if cmd == 'start_collecting':
                gesture = data.get('gesture')
                self.collecting = True
                self.active_gesture = gesture

                # 根据手势类型设置激活的通道（不带后缀，左右手都会计算）
                if gesture == 'continual_gesture_1':
                    self.active_channel = 'finger_joint_angle'
                elif gesture == 'continual_gesture_2':
                    self.active_channel = 'thumb_index_distance'

                print(f"[MocapServer] 开始采集: {gesture} -> {self.active_channel} (L/R)")

                await websocket.send(json.dumps({
                    'type': 'response', 'cmd': 'start_collecting',
                    'status': 'ok', 'gesture': gesture, 'channel': self.active_channel
                }))

            elif cmd == 'stop_collecting':
                self.collecting = False
                self.active_gesture = None
                print("[MocapServer] 停止采集")
                await websocket.send(json.dumps({
                    'type': 'response', 'cmd': 'stop_collecting', 'status': 'ok'
                }))

            elif cmd == 'set_channel':
                channel = data.get('channel')
                if channel in self.channels:
                    self.active_channel = channel
                await websocket.send(json.dumps({
                    'type': 'response', 'cmd': 'set_channel',
                    'status': 'ok', 'channel': channel
                }))

            elif cmd == 'reset_channel':
                channel = data.get('channel')
                value = data.get('value', 0)
                if channel in self.channels:
                    self.channels[channel]['value'] = value
                await websocket.send(json.dumps({
                    'type': 'response', 'cmd': 'reset_channel', 'status': 'ok'
                }))

            elif cmd == 'get_status':
                await websocket.send(json.dumps({
                    'type': 'response', 'cmd': 'get_status', 'status': 'ok',
                    'data': {
                        'collecting': self.collecting,
                        'active_gesture': self.active_gesture,
                        'active_channel': self.active_channel,
                        'mocap_connected': self.receiver.connected,
                        'sdk_connected': self.sdk_connected,
                        'send_rate': self.send_rate,
                        'client_count': len(self.clients),
                        'mode': 'simulator' if self.use_simulator else 'sdk'
                    }
                }))

            elif cmd == 'sdk_connect':
                print("[MocapServer] 收到SDK连接请求")
                success = self.receiver.connect()
                self.sdk_connected = success if not self.use_simulator else True

                # 模拟器模式下启动接收循环
                if self.use_simulator and success:
                    asyncio.create_task(self.receiver.start_receive_loop())
                    self.sdk_connected = True

                await websocket.send(json.dumps({
                    'type': 'response', 'cmd': 'sdk_connect',
                    'status': 'ok' if self.sdk_connected else 'error',
                    'sdk_connected': self.sdk_connected,
                    'message': '连接成功' if self.sdk_connected else '连接失败'
                }))

            elif cmd == 'sdk_disconnect':
                print("[MocapServer] 收到SDK断开请求")
                self.receiver.disconnect()
                self.sdk_connected = False

                await websocket.send(json.dumps({
                    'type': 'response', 'cmd': 'sdk_disconnect',
                    'status': 'ok', 'sdk_connected': False, 'message': '已断开'
                }))

            elif cmd == 'sdk_get_status':
                await websocket.send(json.dumps({
                    'type': 'response', 'cmd': 'sdk_get_status',
                    'status': 'ok', 'sdk_connected': self.sdk_connected
                }))

        except json.JSONDecodeError:
            pass
        except Exception as e:
            print(f"[MocapServer] 错误: {e}")

    async def handler(self, websocket, path=None):
        await self.register(websocket)
        try:
            async for message in websocket:
                await self.handle_message(websocket, message)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            await self.unregister(websocket)

    async def broadcast_data(self):
        """广播动捕数据到所有客户端"""
        interval = 1.0 / self.send_rate

        while self._running:
            if self.sdk_connected:
                self.update_from_mocap()
                buffered_frames = self.receiver.get_buffered_frames()
                dropped_frames = self.receiver.pop_dropped_frames()

                data = {
                    'type': 'mocap',
                    'timestamp': time.time(),
                    'collecting': self.collecting,
                    'active_channel': self.active_channel,
                    'active_gesture': self.active_gesture,
                    'mocap_connected': self.receiver.connected,
                    'sdk_connected': self.sdk_connected,
                    'channels': {
                        name: {
                            'value': ch['value'], 'min': ch['min'],
                            'max': ch['max'], 'unit': ch['unit']
                        }
                        for name, ch in self.channels.items()
                    },
                    'frames': buffered_frames,
                    'frame_count': len(buffered_frames),
                    'dropped_frames': dropped_frames
                }
                message = json.dumps(data)

                disconnected = set()
                for client in list(self.clients):
                    try:
                        await asyncio.wait_for(client.send(message), timeout=1.0)
                    except Exception:
                        disconnected.add(client)

                for client in disconnected:
                    await self.unregister(client)
                if dropped_frames and self.clients:
                    fault = json.dumps({
                        'type': 'transport_fault', 'source': 'mocap',
                        'error': 'mocap frame buffer overflow', 'dropped': dropped_frames
                    })
                    for client in list(self.clients):
                        try:
                            await asyncio.wait_for(client.send(fault), timeout=1.0)
                        except Exception:
                            await self.unregister(client)

            await asyncio.sleep(interval)

    async def start(self):
        """启动服务器"""
        self._running = True

        server = await websockets.serve(self.handler, self.host, self.port)

        mode_str = "模拟器模式" if self.use_simulator else "SDK模式"
        print(f"[MocapServer] 已启动 ws://{self.host}:{self.port} ({mode_str})")
        print(f"[MocapServer] 等待前端发送连接命令...")

        broadcast_task = asyncio.create_task(self.broadcast_data())

        try:
            await broadcast_task
        except asyncio.CancelledError:
            pass
        finally:
            self._running = False
            if self.sdk_connected:
                self.receiver.disconnect()
            broadcast_task.cancel()
            try:
                await broadcast_task
            except asyncio.CancelledError:
                pass
            server.close()
            await server.wait_closed()
            print("[MocapServer] 服务器已停止")

    def run(self):
        try:
            asyncio.run(self.start())
        except KeyboardInterrupt:
            print("\n[MocapServer] 收到停止信号")


# ==================== 主程序 ====================

def main():
    import argparse

    parser = argparse.ArgumentParser(description='动捕数据服务器')
    parser.add_argument('--host', default=SERVER_HOST, help='监听地址')
    parser.add_argument('--port', type=int, default=SERVER_PORT, help='监听端口')
    parser.add_argument('--rate', type=int, default=SEND_RATE, help='数据发送频率(Hz)')
    parser.add_argument('--server', '-s', default=NOKOV_SERVER_IP, help='Nokov服务器IP地址')
    parser.add_argument('--simulator', action='store_true', help='使用模拟器模式（连接mocap_simulator.py）')
    parser.add_argument('--simulator-url', default=SIMULATOR_URL, help='模拟器WebSocket地址')

    args = parser.parse_args()

    server = MocapServer(
        host=args.host,
        port=args.port,
        use_simulator=args.simulator
    )
    server.send_rate = args.rate

    if args.simulator:
        server.receiver.simulator_url = args.simulator_url
    else:
        server.receiver.server_ip = args.server

    server.run()


if __name__ == '__main__':
    main()
