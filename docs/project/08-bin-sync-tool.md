# 08 - Bin 同步工具

## 2026-10-07 同步算法基线

实现与真实数据证据见 [系统审查](13-system-review.md)。normal / rescue / ADC 共用锚点偏移规则：单bin中每条输出满足 `channels == bin[sd_frame_id + sync_bin_align_offset]`；多bin保存逐段来源和偏移。

解析使用紧凑ID索引与16通道int32矩阵，仅输出真实存在的帧。BLE或bin缺口不前值填充，不按计数器跨度分配巨型矩阵。重复、回退、截断和跨u32 epoch的bin明确拒绝并提供位置；时间戳修复仅接受证据明确的u32回绕。

IMU的±3帧锚点匹配仍属启发式，保存歧义与置信度，并标记 `imu_verified=False`。不能把启发式成功等同于全文件已验证。所有入口共用离线事务，失败不发布半成品。

## 1. 概述

**文件**: `tools/bin_sync_tool.py` (2900+ 行)

bin_sync_tool 是 H5 离线同步的核心工具，负责将 BLE 传输的 250Hz 压缩数据与 SD 卡 bin 文件中的完整 2kHz (EMG) / 100Hz (IMU) 数据对齐，补全写入 H5。

### 1.1 三种同步模式

| 模式 | 函数 | 适用场景 |
|------|------|---------|
| **One-to-One** | `sync_h5_one_to_one()` | H5 和 bin 帧号完美对齐 (正常采集) |
| **ADC Search** | `sync_h5_one_to_many_adc_search()` | H5 丢失帧号，通过 ADC 匹配寻找 offset |
| **GUI** | `run_gui()` | 批量操作，自动选择最佳模式 |

---

## 2. 核心数据结构

### 2.1 EMGBinParser (line 456)

```python
class EMGBinParser:
    def __init__(self, bin_path):
        self.frame_size = EMG_FRAME_SIZE  # 52 bytes
        self.num_frames = total_data_size // 52
        
    def get_frame(self, frame_index):
        """读取一帧: (frame_id, channel_data[16])"""
        
    def get_frame_range(self, start, end):
        """批量读取 [start, end) 帧"""
```

### 2.2 IMUBinParser (line 544)

```python
class IMUBinParser:
    def __init__(self, bin_path, num_imus=None):
        # 支持自动检测 num_imus (1/2/3)
        # 帧大小: 4 + num_imus × 18 bytes
        
    def get_imu_frame(self, frame_index, num_imus=None):
        """读取一帧 IMU: (frame_id, [(acc, gyr), ...])"""
```

---

## 3. IMU 数量推断 (核心决策)

### 3.1 多源融合架构

```
            ┌─────────────┐
            │  BLE 实测    │  imu_all_ble imu_index (物理传感器数)
            │  BLE 握手    │  imu{dev}_num_imus attrs
            │  Bin 检测    │  _detect_num_imus_from_bin()
            └──────┬──────┘
                   │
                   ▼
          ┌────────────────────┐
          │ _resolve_num_imus  │
          │   手动值? → 直接返回 │
          │   一致?  → 直接采用  │
          │   冲突?  → 帧ID验证  │
          └────────┬───────────┘
                   │
                   ▼
          _verify_imu_count_fits_bin()
          │ 读取前200帧，验证帧ID递增序列
          │ 得分 ≥ 90% + 连续 ≥ 5帧 → passed
          └──────┬──────┘
                 │
                 ▼
          num_imus (1~3) + active_indices
```

### 3.2 关键函数

| 函数 | 说明 |
|------|------|
| `_detect_num_imus_from_bin()` | 整除检测 (data_size / frame_size) + 帧ID验证 |
| `_verify_imu_frame_ids()` | 读前N帧，检查帧ID递增序列完整度 |
| `_verify_imu_count_fits_bin()` | 封装帧ID验证 → 返回 `{score, longest_run, passed}` |
| `_resolve_num_imus()` | **融合决策**: 三源输入 → 冲突时帧ID验证裁判 |
| `_validate_imu_sensor_data()` | 质量校验: 非零率/Acc范围/方差/NaN → 标记 active/inactive |

---

## 4. 同步流程

### 4.1 One-to-One 模式

```
sync_h5_one_to_one(h5, emg_bin, imu_bin, device_id)
  │
  ├─ 1. _resolve_num_imus()           # IMU数量融合推断
  ├─ 2. 读取 H5 250Hz anchor 帧号
  ├─ 3. 在 bin 中定位 offset (帧号匹配)
  ├─ 4. _build_and_write_2khz()        # 从 bin 提取 2kHz 数据 → 写入 H5
  │      ├─ 逐帧读取 bin
  │      ├─ sd_frame_id 对齐
  │      └─ 写入 emg{dev}_2khz_adc
  ├─ 5. _sync_imu_100hz()              # 从 IMU bin 同步 100Hz 数据
  │      ├─ IMU帧号 = EMG帧号 // 20
  │      ├─ 时间窗口对齐
  │      └─ 写入 imu{dev}{a,b,c}_100hz
  └─ 6. 写入 sync_status = "synced"
```

### 4.2 ADC Search 模式

当帧号不可靠时（如断点续采后 bin 位置偏移），通过 ADC 值匹配寻找 offset：

```
sync_h5_one_to_many_adc_search()
  │
  ├─ 1. 从 H5 250Hz 数据构建 ADC 特征集
  ├─ 2. 在 bin 中扫描匹配 (滑动窗口)
  ├─ 3. 找到最佳 offset → 调用 _build_and_write_2khz()
  └─ 4. 写入 sync_status
```

### 4.3 GUI 模式

```
run_gui()
  ├─ 扫描 storage/*.h5
  ├─ 按 recording_session_id 分组
  ├─ 匹配 bin 文件 (sd_bin_dev1/2 attrs)
  ├─ 自动选择 One-to-One → 失败回退 ADC Search
  ├─ 并行处理多个 H5
  └─ manual_num_imus = None (交由多源融合自动裁决)
```

---

## 5. 验证与诊断

| 函数 | 说明 |
|------|------|
| `validate_frame_ids()` | 检查帧ID递增序列质量 |
| `validate_sd_coverage()` | 检查 SD 卡帧覆盖完整性 |
| `run_adc_verification()` | 比对 H5 250Hz 与 bin 对应帧的 ADC 值差异 |
| `diagnose_frame_ids()` | 诊断 H5 文件的帧ID健康状态 |
| `clear_sync_outputs()` | 清除 H5 中的同步结果 (支持备份) |

---

## 6. Bin 格式常量

```python
EMG_MAGIC = 0xAABBCCDD       # EMG bin magic word
IMU_MAGIC = 0xBBCCDDEE       # IMU bin magic word
HEADER_SIZE = 126            # 文件头大小 (magic + 固件信息)
EMG_FRAME_SIZE = 52          # 4B frame_id + 16ch × 3B
BYTES_PER_IMU_CHIP = 18      # acc 6B + gyro 6B + reserved 6B
DOWNSAMPLE_RATIO = 8         # EMG: 2000Hz/250Hz
IMU_RATIO = 20               # EMG:IMU = 2000Hz/100Hz
```

---

## 7. H5 属性变更

同步完成后写入/更新的属性:

| 属性 | 值 | 说明 |
|------|-----|------|
| `sync_status` | `"synced"` / `"sync_failed"` | 同步结果 |
| `sync_mode` | `"one_to_one"` / `"adc_search"` | 使用的模式 |
| `sync_timestamp` | ISO 时间 | 同步完成时间 |
| `emu_offset` | int | ADC search 找到的 offset |
| `imu{dev}_active_count` | 1-3 | 活跃 IMU 数量 |
| `imu{dev}_active_indices` | `[0,1]` | 活跃 IMU 索引 |
| `imu{dev}_inactive_indices` | `[2]` | 损坏 IMU 索引 |
| `total_emg{dev}_2khz_frames` | int | 同步后帧数统计 |
| `total_imu{dev}{ch}_100hz_frames` | int | IMU 帧数统计 |
