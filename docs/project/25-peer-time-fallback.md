# 单手 BLE 不可信时的对侧时间锚回填（2026-11-11）

## 背景

现场（A050-01，2026-11-09 session1）出现一份 H5：

- 右手 `emg2` 与 `A05001_R_...110506` 的 ADC 校验 **corr=1.000、逐样本命中率 1.000**；
- 左手 `emg1` 与 `A05001_L_...110505` 只有 **corr≈0.71**，达不到 0.90 阈值；
- 同一天 session2–6 的左手全部 **corr=1.000**。

即左手 BLE 250Hz 数据在采集时不可信，但左手 SD 卡 bin（2000Hz、322338 帧、161 秒）是完整的。
工具原先整文件回滚，导致这一轮数据无法收尾。

## 新机制

当一只手与自己的 bin 校验失败、而**另一只手已通过校验**时：

1. 取对侧已铆定的时间轴：`emg<peer>_2khz_adc` 的 `time` 曲线 + 两侧 bin 头时间差
   （`A05001_L_110505` vs `A05001_R_110506` → 1 秒，头时间精度 1s）；
2. 直接把**本手自己的 bin** 按这条时间轴切出来，写入 `emg<self>_2khz_adc` 与 IMU 100Hz；
3. 本手原有的 BLE 250Hz 行**保持不动**，作为原始证据；
4. 元数据标记 `sync_time_source_dev<N>=peer_time_fallback`、
   `sync_validation_dev<N>=True`，H5 顶层 `sync_device_results` 里可追溯。

前提条件（不满足则不回填、仍按原逻辑回滚）：

- 对侧设备的 2kHz 输出存在且能通过 `_sync_output_is_valid`；
- 对侧的时间轴来自它自己的 BLE 锚（`ble_anchor_interpolation_nominal_extrapolation`），
  不是二次借用；
- 两侧 bin 头属于同一受试者、且为左右不同侧。

## 实现位置

- `tools/bin_sync_tool.py`：`sync_h5_from_peer_time_reference(..., allow_unreliable_target=True)`
  允许目标 BLE 非空（原逻辑要求为空）；
- `tools/hdf5_tool.py`：`_apply_peer_time_fallback()`，在处理完所有设备后对失败设备做回填，
  两处同步 worker 都接入了；
- `tests/test_peer_time_fallback.py`：回归测试（借用成功 / 无可用对侧 / 对侧未通过校验）。

## 实测（session1 副本）

```
dev2 正常同步: success（corr 1.000）
dev1 借用 dev2 时间锚: success
emg1_2khz rows=322338  time 单调递增  span=161.26s
dev2 2kHz: 321397 行，span=160.79s，起始相差 1.0s（与 bin 头时间差一致）
sync_time_source_dev1 = peer_time_fallback
sync_device_status_dev1 = synced / validation = True
emg1_250hz rows 保持 39402
```

日志中会出现：

```
D1: 与自己 bin 的 ADC 校验未通过，改用 D2 已铆定的时间轴，直接从 D1 的 bin 填充 2kHz
D1: success
```

## 事务嵌套问题（2026-11-11 补充）

GUI 是在一个外层 `h5_transaction` 里逐设备调用同步的。旧逻辑中，被装饰的
`sync_h5_one_to_one` 一旦返回 `validation_failed`，`__offline_h5_entrypoint`
会抛出回滚标记，`file_access` 便把整个文件记为失败——即使随后对侧时间锚回填
成功，外层提交仍会以“嵌套离线事务失败，已取消整个文件的提交”回滚。

修复：

- `file_access.transaction_active(path)`：判断当前路径是否已在事务中；
- `bin_sync_tool._offline_h5_entrypoint`：**嵌套调用**遇到 `validation_failed`
  时只返回结果、不抛回滚标记，由外层聚合逻辑决定是否回填/提交；顶层调用行为不变；
- 真正的异常仍然会标记失败并阻止提交。

## 批量处理结果（A050-01，2026-11-11）

7 个未同步文件（session1 + C1原文件 6 份）全部同步成功：

| 文件 | 结果 |
|---|---|
| C1 session1（`A050-01_...110506.h5`） | D2 正常；D1 借用 D2 时间锚，2kHz 322338 行 |
| C1原文件 session1–6 | D1/D2 均 `corr=1.000` 正常同步 |

同步前原件已备份到 `现场问题派擦和\_sync_before_20261111\`。
最终 30 个 H5 全部 `sync_status=synced`，无 pending。
