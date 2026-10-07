# 07 - H5 数据格式与协议

## 2026-10-07 格式与状态补充

当前维护契约详见 [系统审查](13-system-review.md)。采集批次携带文件token和严格序号；正常关闭要求写入序号到达收尾栅栏。现代采集缺失计数器或批次形状不一致会明确失败，不填造时间或SD锚点。

同步状态按物理设备与验证证据汇总：`partial` 表示仅部分设备完成，`unverified` 表示结果缺完整验证证据。源文件指纹与单设备记录用于防止误跳过或复用过期结果；历史数据集存在本身不等于已验证。

IMU同步输出包含 `valid` / `missing`，保留物理传感器数量。大缺帧清单存于 `sync_quality/devN/imu_missing_frame_ids`，由 `missing_frame_ids_path` 属性引用，避免属性尺寸上限。多bin使用逐段来源与偏移记录，不将单一偏移伪装为全文件规则。

## 1. H5 文件结构

### 1.1 数据集概览

```
<session>.h5
├── 📊 emg1_250hz_adc       # BLE 250Hz EMG (手环1, 16ch, 原始ADC)
├── 📊 emg2_250hz_adc       # BLE 250Hz EMG (手环2)
├── 📊 emg1_2khz_adc        # 同步后 2kHz EMG (手环1) [离线补全]
├── 📊 emg2_2khz_adc        # 同步后 2kHz EMG (手环2) [离线补全]
├── 📊 imu1_all_ble         # V1/V2 通用 IMU BLE 数据 (手环1)
├── 📊 imu2_all_ble         # V1/V2 通用 IMU BLE 数据 (手环2)
├── 📊 imu1a_100hz          # 同步后 IMU 通道a [离线补全]
├── 📊 imu1b_100hz          # 同步后 IMU 通道b [离线补全]
├── 📊 imu1c_100hz          # 同步后 IMU 通道c [离线补全]
├── 📊 imu2a_100hz          # ... (手环2 同理)
├── 📊 imu2b_100hz
├── 📊 imu2c_100hz
├── 📊 mocap_l              # 左手动捕 marker 3D 坐标
├── 📊 mocap_r              # 右手动捕 marker 3D 坐标
├── 📊 prompts              # 手势 prompt 事件
└── 📋 attrs                # 元数据属性 (~50 个)
```

### 1.2 数据集 DType 定义

#### EMG BLE 250Hz
| 字段 | 类型 | 说明 |
|------|------|------|
| `channels` | `i4 × 16` | 16通道原始ADC值 |
| `frame_id` | `u4` | BLE帧号 |
| `sd_frame_id` | `u4` | 对应SD卡帧号 (`= BLE帧号 × 8 + 7`) |
| `time` | `f8` | Python `time.time()` 时间戳 |

#### EMG 2kHz (同步后)
| 字段 | 类型 | 说明 |
|------|------|------|
| `channels` | `i4 × 16` | 16通道原始ADC值 |
| `sd_frame_id` | `u4` | SD卡帧号 |
| `time` | `f8` | 时间戳 |

#### IMU all_ble (V1/V2通用)
| 字段 | 类型 | 说明 |
|------|------|------|
| `imu_index` | `u1` | IMU索引 (0-based, 对应I2C地址) |
| `acc` | `f4 × 3` | 加速度 [g] |
| `gyr` | `f4 × 3` | 陀螺仪 [°/s] |
| `has_mag` | `u1` | 磁力计标志 (V1=1, V2=0) |
| `mag` | `f4 × 3` | 磁力计 (V2填NaN) |
| `frame_id` | `u4` | BLE帧号 |
| `sd_frame_id` | `u4` | SD卡帧号 |
| `time` | `f8` | 时间戳 |

#### IMU 100Hz (同步后)
| 字段 | 类型 | 说明 |
|------|------|------|
| `acc` | `f4 × 3` | 加速度 [g] |
| `gyr` | `f4 × 3` | 陀螺仪 [°/s] |
| `mag` | `f4 × 3` | 磁力计 |
| `sd_frame_id` | `u4` | IMU SD卡帧号 |
| `time` | `f8` | 时间戳 |

#### Mocap (每只手12点)
| 字段 | 类型 | 说明 |
|------|------|------|
| `IN1_L/IN2_L/IN3_L` | `f4 × 3` | 食指 marker 3D坐标 |
| `TH1_L/TH2_L/TH3_L/TH4_L` | `f4 × 3` | 拇指 marker |
| `HB1_L/HB2_L/HB3_L` | `f4 × 3` | 手背 marker |
| `MD1_L/MD2_L` | `f4 × 3` | 中指 marker |
| `frame` | `i4` | 帧号 |
| `time` | `f8` | 时间戳 |

#### Prompt
| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `S64` | prompt 名称 (如 "thumb_up_start") |
| `time` | `f8` | 时间戳 |
| `stage` | `S64` | 所属 stage |

### 1.3 H5 属性分类

| 类别 | 属性 | 写入时机 |
|------|------|---------|
| **文件标识** | `user_id`, `task_id`, `stage_name`, `session_index/number/count` | create |
| **采集配置** | `template_name`, `category1/2/4`, `start_time`, `end_time` | create/close |
| **硬件信息** | `sd_bin_dev1/2`, `ble_dev1/2`, `hw_version`, `num_imus` | create |
| **IMU** | `imu{dev}_num_imus`, `imu{dev}_hw_version` | append |
| **流信息** | `stream_mode`, `collection_stream_id`, `bin_pair_source` | create |
| **视频** | `video_left`, `video_right`, `video_start_timestamp` | create/video_recording_started |
| **录像** | `recording_session_id`, `is_multi_session` | create |
| **续采** | `is_resumed`, `segment_index`, `resume_reason`, `resumed_by_segment_index`, `resumed_by_file` | create/close |
| **断点** | `breakpoint_state`, `resume_progress`, `interrupted_at`, `interrupt_reason` | close (abnormal) |
| **状态** | `collection_status`, `sync_status`, `sync_mode`, `sync_timestamp` | close/sync |
| **统计** | `total_emg1_frames`, `total_imu1_all_frames`, `total_prompts` | close |

---

## 2. Bin 文件格式

### 2.1 EMG Bin

```
[Header: 126 bytes (magic + 固件信息)]
[Frame 0: 4B frame_id + 48B data (16ch × 3B)]
[Frame 1: ...]
...
每帧 52 字节 @ 2000Hz → ~104 KB/s (单设备)
```

### 2.2 IMU Bin

```
[Header: 126 bytes (magic + 固件信息)]
[Frame 0: 4B frame_id + num_imus × 18B data]
[Frame 1: ...]
...
num_imus = 1: 每帧 22B @ 100Hz
num_imus = 2: 每帧 40B @ 100Hz
num_imus = 3: 每帧 58B @ 100Hz

每 IMU chip: acc(6B) + gyro(6B) + reserved(6B) = 18B
```

### 2.3 帧映射关系

```
SD卡采样率: EMG 2000Hz, IMU 100Hz
BLE传输率:  EMG 250Hz (1/8), IMU ~27.8Hz (1/36)

帧号关系:
  sd_frame_id(EMG) = ble_frame_id × 8 + 7
  sd_frame_id(IMU) = sd_frame_id(EMG) // 20
```

---

## 3. 通信协议汇总

### 3.1 内部协议

| 协议 | 端点 | 编码 | 说明 |
|------|------|------|------|
| HTTP REST | :3000/api/* | JSON | 文件列表/配置 CRUD/状态查询 |
| WebSocket | :8080 | JSON | 实时数据 + 控制命令 (双向) |
| WebSocket | :8764 | JSON | BLE 控制命令 (前端 → ble_server) |
| WebSocket | :8766 | JSON | BLE 数据流 (ble_server → realtimeEngine) |
| WebSocket | :8767 | JSON | Mocap 数据 (mocap_server → realtimeEngine) |
| WebSocket | :8768 | JSON + Binary(base64) | 摄像头命令 + MJPEG 帧 |
| ZMQ REP | :5555 | JSON | Storage 控制命令 (请求-响应) |
| ZMQ PUSH | :5556 | JSON | Storage 数据追加 (单向非阻塞) |

### 3.2 WebSocket 消息格式

```json
{
  "type": "control_command | realtime_data_batch | mocap_data | event | ...",
  "action": "collection_start | prompt | stage_start | ...",
  "data": { ... }
}
```
