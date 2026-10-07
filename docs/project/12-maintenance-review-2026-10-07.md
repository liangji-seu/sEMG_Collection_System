# 项目维护复核与后续交接（2026-10-07）

> 这是第一阶段的历史记录。用户随后要求继续完整系统审查；当前实施与实际验收结果以 [系统审查](13-system-review.md) 为准，下述交接计划与测试数量不代表当前最终状态。

## 项目现状

- `origin/master=a818ec3`，版本标记为 `v2.0.1`。
- 启动命令：`npm start`（等价于 `node server.js`）。
- 目标 Python 环境：`E:\miniconda\envs\sEMG_Collection_System\python.exe`。

## 已完成的离线修复

1. `hdf5_tool.py` 的数据预览不再使用 `dataset[:]` 全量读入；现在只读取预览头部（前 `max(2000, preview_rows)` 行），保留原始 shape，并明确标注统计值仅基于预览行。数值、字符串和结构化 scalar 均可显示。
2. `HDF5Tool` 关闭窗口时，如果同步、压缩或清除线程仍在运行，会延后关闭并提示用户，避免 QThread 在运行中被销毁。
3. `ensure_h5_openable()` 遇到 HDF5 stale-write 类错误时不再自动修改 superblock，改为提示用户先停止采集并关闭占用程序。`repair_h5_stale_write_flag()` 保留为确认文件空闲后的显式维护函数，并继续创建备份。

近期提交修复了采集时间戳重叠（包计数器驱动时间轴、复位时帧号续接）、bin 驱动的 2kHz 输出与补救同步帧号标签、IMU 数量不足时无法采集、视频定位及 AVI 帧率头问题。本轮保持既有时间轴和同步语义。

## 验证

使用目标环境 `E:\miniconda\envs\sEMG_Collection_System\python.exe`：

```powershell
conda activate sEMG_Collection_System
$env:QT_QPA_PLATFORM='offscreen'
python -m unittest discover -s tests -p 'test_*.py' -v
node --test tests/collection_pipeline.test.js
python -m py_compile storage_server.py tools/hdf5_tool.py tools/calibrate_tool.py tools/bin_sync_tool.py
node --check realtimeEngine.js
node --check server.js
git diff --check
```

最终复核：Python 11 项、Node 10 项通过，语法与差异检查通过。离线部分占 Python 6 项，覆盖预览读取上限、统计范围、scalar 显示、后台线程关闭行为、stale-write 错误下源文件字节不变，以及健康 H5 打开。采集部分覆盖延迟发送、失败后成功仍拒绝正常结束、真实只读 H5 写入异常、请求失败后重建 socket、队列上限、开关文件竞态和异步命令错误反馈。

原有 `tmp/verify/test_counter_timeline.py`、`test_recorder_timeline.py`、`test_recorder_write.py` 按顺序运行也通过：模拟 600 包、5400 行 EMG，时间无回退、SD 帧号步长为 8，随后时间修复是空操作。生成的模拟文件已清理。实际安装的 ZeroMQ 模块已成功加载并核验超时属性；本轮没有启动真实采集，也没有完成真实跨进程录制长测。

## 尚待现场数据复核

- bin 驱动同步的帧映射、缺帧处理和时间单调化仍需用真实采集文件及对应 bin 做端到端复核，本次未改变其语义。
- 视频预览的旧 AVI 错误帧率头、真实 seek 对齐和压缩后路径仍需用真实视频文件复核，本次未修改视频解码逻辑。

## 采集侧

本轮完成并通过上述回归：

1. 数据发送串行化并携带序号；关闭 H5 前确认存储端已处理目标序号，避免独立控制通道越过积压数据。
2. 底层写入异常向上传递并保留首个错误，后续成功写入不能掩盖失败。关闭失败时保留文件打开状态，禁止自动创建新文件覆盖它，也不能把该轮标记为正常完成。
3. 停止会等待正在创建或关闭的文件；异步控制命令的异常进入现有错误响应路径，避免未处理的 Promise rejection。
4. 通信发送超时 5 秒、控制接收超时 10 秒；控制失败会重建 socket 并取消后排命令，发送失败后拒绝继续积压。数据和控制队列均设 1000 条上限，写入失败通知前端。
5. 后端退出共用同一个关闭 Promise；重复关闭不会提前退出，H5 未成功关闭时保留后端进程。摄像头正常退出后清理其强制停止计时器。

遇到写入故障时，保留文件与后端是保护行为，不代表该轮可继续正常采集；需要先处理存储故障，并对异常文件做独立恢复与核验。本轮尚未提供自动恢复失败文件的流程。采集端与存储端协议同时改动，应一同重启、使用同一版本。`npm start` 启动方式不变；代码尚未提交或推送。

## 后续优先级

1. `bin_sync_tool` normal/rescue/ADC 合成契约测试。
2. 单/双手环、2/3 IMU 的断连续采与长时间录制。
3. 视频时间对齐边界、大目录异步扫描、慢客户端背压、服务重启生命周期。

## 可复制交接提示词

```text
目标：复核并修复 sEMG_Collection_System 的离线同步、采集生命周期和视频对齐边界。
输入：项目目录 E:\1_Master\2_学业\my_project\1_华为横向\0_外采任务开发\sEMG_Collection_System；基线 origin/master=a818ec3、v2.0.1，当前工作区包含本轮未提交修复，必须保留；Python 环境 E:\miniconda\envs\sEMG_Collection_System\python.exe；npm start=node server.js。先读 docs/project 和本维护记录。
约束：只用临时合成数据或副本；不能修改真实采集文件；不能改变既有时间轴语义；不安装环境；不提交、不推送。
执行：按优先级逐项复现后再最小修复。先建立 bin_sync normal/rescue/ADC 合成矩阵，涵盖缺帧、计数器复位、不同 IMU 数量和非零对齐偏移；逐行核对输出内容与 sd_frame_id 加 sync_bin_align_offset 指向的 bin 帧一致、时间单调且保留真实间隙。再检查视频首尾帧、跳转、左右手映射和压缩后路径，以及大目录扫描、慢客户端和服务重启。硬件长测需设备可用时进行，记录时长、丢帧、内存与异常收尾结果。
验收：目标环境下现有 Python 11 项、Node 10 项及相关新增回归通过；原有时间轴/H5 写入模拟继续通过；不使用测试手工注入错误状态代替真实失败入口。报告修改位置、验证证据、未验证的硬件或长时风险。
本轮进度：离线预览限读、scalar 显示、QThread 关闭保护和 stale-write 安全策略已修复；采集侧写入确认、错误保留、开关文件竞态、通信超时及异常响应已修复并通过回归。完整同步矩阵、视频与硬件长测、目录扫描和客户端背压仍待执行。保留用户原有未跟踪 tools/hdf5_tool.spec。
```
