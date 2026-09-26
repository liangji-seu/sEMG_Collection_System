# 验收复现脚本（全部只在副本上跑，不动原始数据）

环境（必须用项目 conda 环境，且关掉 HDF5 文件锁）：

```bash
P=/e/miniconda/envs/SEMG_Collection_System/python.exe
export HDF5_USE_FILE_LOCKING=FALSE PYTHONIOENCODING=utf-8
```

## 后处理工具侧（tools/hdf5_tool.py + tools/bin_sync_tool.py）

| 脚本 | 作用 | 耗时 |
| --- | --- | --- |
| `e2e_invariant_test.py` | **契约校验**：对 4 个源 H5（L001 / d001 s3 / d001 s6 / L380，各 2 个设备）复制到 `e2e_inv/`，跑「时间修复 → one_to_one（失败则补救同步）」，然后逐行验证 `content[i] == bin帧( sd_frame_id[i] + sync_bin_align_offset )`，并用 250Hz 侧 BLE↔bin 逐采样精确匹配做物理对照 | ~4 min |
| `e2e_fullflow_test.py` | **全流程矩阵**：GUI 的顺序（先修复后同步，另做一份不修复的对照），输出行数 vs bin 帧数、sd_frame_id 唯一性/步长、time 单调性/回退、58Hz 带内能量 H5 vs bin | ~18 min |
| `probe_verify_l001.py` | 只针对 L001（唯一的补救同步用例）：打印 rescue 推导出的 `base/tbb/label_offset`，并把 `sync_bin_align_offset` 与「使内容零误差的 offset」对齐比较（残差应为 0） | ~1 min |

结果快照：`../e2e_inv.log`、`../e2e_flow.log`。

## 采集端侧（ble_server.py + storage_server.py）

| 脚本 | 作用 | 耗时 |
| --- | --- | --- |
| `test_counter_timeline.py` | `_counter_timeline()` 的单元测试：稳定流 / 通知成簇 / BLE 丢包 / 主机时钟前跳 2s / 计数器复位后帧号续接，五种场景都必须单调、包内步长恰好 4ms | 秒级 |
| `test_recorder_timeline.py` | 造 600 个假 BLE 包（含第 300 包计数器复位、第 450 包起卡顿 200ms、通知成簇到达）走 `parse_packet` + `finalize_parsed_packet`，对比新旧时间戳的单调性，结果落 `recorder_sim.npz` | 秒级 |
| `test_recorder_write.py` | 接上一步，走 storage_server **真实的** H5 写入路径落盘，检查 `time` 单调、`sd_frame_id` 步长恒为 8，并确认 hdf5_tool 的时间修复对该文件是空操作 | 秒级 |

注意：`test_recorder_write.py` 只 import storage_server（它会替换 sys.stdout），不能与
`test_recorder_timeline.py`（只 import ble_server）放在同一个进程里跑。

结果快照：`out_*.log`（本目录）。
