# 现场同步验收边界与 partial epoch 规则（2026-10-11）

## Windows 深路径事务

文件事务对 Windows 原生 I/O 使用 extended path：普通盘符路径映射为 `\\?\`，UNC 路径映射为 `\\?\UNC\`，已经是 extended path 的输入保持不变。锁文件仍使用原有的 `.offline.lock` 名称；逻辑路径、来源记录和审计日志保留用户可读的普通路径。事务中的暂存、复制、统计、刷新、替换和清理均使用同一套有效 I/O 路径，避免深目录下 H5 已存在却无法创建锁或暂存文件。

## 多 epoch H5 的 partial 恢复

partial 恢复只用于一对一、严格计数器 bin，并且必须满足以下条件：

- `frame_id` 与 `sd_frame_id` 中，选择最早的严格回退且回退后接近零的边界；
- 首 epoch 至少 40 行，全部行通过 16 通道 ADC 精确匹配，且至少有 40 个不同的 ADC 向量；
- 匹配到的源帧号严格递增，时间有限且严格递增；
- 实际 bin 源覆盖率至少 80%，首尾未锚定部分各不超过 4000 个实际 2 kHz 样本（约 2 秒）；
- IMU BLE 时钟锚点仅使用首 epoch 时间窗，边界容差为一个 100 Hz 周期（±0.01 秒）。

这些条件只影响新的首 epoch partial 分支。普通 ADC 同步仍保持原有 95% 匹配阈值；offset 搜索的 `passed` 也必须通过全量 anchor 严格递增（无回退）检查，否则回到逐行扫描或 partial 路径；相关性、弱匹配、重复静息向量、非严格计数器和无法确认边界的记录不会进入该恢复路径。

输出以配对 BIN 的实际物理记录为主体，完整写入 BIN 中可读出的 EMG/IMU 样本。H5 后续没有对应 BIN 的 BLE epoch 保持原始 250 Hz 数据，并通过 `sync_ble_uncovered_rows/count`、`sync_ble_coverage_note`、首段 coverage 和 whole-H5 coverage 写入审计警告。`synced` 表示所提供配对 BIN 的实际样本已导入并具备同步记录，不表示后续 H5 epoch 已有对应 BIN，也不表示能够恢复原 BIN 中不存在的真实帧或修复 BIN 结构损坏。

## 当前验证范围

指定 L057 `145353.h5` 的新副本验证已成功；D1/D2 分别完整导入 7983/8971 个 EMG BIN 实际样本，首 epoch ADC 匹配率均为 1.0，后续 H5 覆盖缺口分别记录为 1098/1224 行。诊断副本位于 `tmp/field-validation-20261011/partial-epoch-check2`。

## 全量现场验收摘要

157 个 H5 已完成验收：153 个成功项的配套 BIN 实际逐帧、逐字段核验通过；3 个源 BIN 错误，1 个源 H5 BLE 压缩块错误；回归测试 120 项通过。两项 L057 partial 覆盖警告对应 `145353` 与 `151812`，分别保留后续未配对 BLE 段覆盖信息。原件 157 H5 与 648 BIN 共 805 份的 size/SHA256 核对一致。

永久报告：

- [现场同步验收说明](field-validation-20261011/现场同步验收.md)
- [现场同步验收明细 CSV](field-validation-20261011/现场同步验收.csv)
- [原始 BIN 异常清单 CSV](field-validation-20261011/原始BIN异常.csv)
- [机器汇总 JSON](field-validation-20261011/final-report.json)
- [BIN 审计结论](field-validation-20261011/bin-findings.json)
- [L380 C3 H5 压缩块诊断](field-validation-20261011/l380-c3-filter-diagnosis.json)
- [原件完整性核对](field-validation-20261011/source-integrity.json)
