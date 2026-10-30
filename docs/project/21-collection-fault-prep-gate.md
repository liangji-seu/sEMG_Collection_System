# 采集准备阶段被误判为存储故障（2026-10-30）

## 现象

连续手势任务点"开始采集"后约 2 秒，弹出采集故障并自动停机：

```
已收到手环数据，但H5文件未打开，当前轮次数据不会落盘；请紧急中断并重采本轮
```

离散手势任务正常（H5 立即创建），只有连续手势（`continual_gesture_1/2`）复现。

## 日志证据

`log/server_20261030_105933.447_117048_000001.log`：

```
19:11:37.709  coverage: collection_start（collection_state=starting）
19:11:37.721  first_emg，filtered_rows_by_reason: {"file_not_open": 6}
19:11:39.720  collection_fault source=storage code=storage_write_failed
              error="已收到手环数据，但H5文件未打开…"
```

从 `collection_start` 到故障正好 **2.0 秒**，期间没有出现过 `stage_start`，
也没有 `尝试打开Stage文件`。

## 根因

采集健康监护里有一条"数据已到但 H5 未打开"的判断：

```js
isCollecting && !stageFileOpen && h5OpenGraceExpired(2s) && 有数据
  → notifyH5StorageWarning(...) → requestCollectionFault(storage)
```

但 `collection_start` 与 `stage_start` 之间本来就有合法的空窗：
连续手势要先做标定/准备倒计时（默认 3 秒起），`stage_start` 之后才创建 H5。
这 2 秒不是存储故障，而是**还没到该建文件的时候**。

## 修复

- `realtimeEngine` 新增 `stageStartRequested`：只有收到 `stage_start` 之后，
  "H5 迟迟未打开"才升级为存储故障；
- 准备阶段的数据仍按 `file_not_open` 计入 `filtered_rows_by_reason`（可在健康日志里看到），
  只是不再触发停机；
- "没有已打开摄像头"从 `ERROR` 降为 `WARN`：本轮不录像、只采 EMG/IMU，属于正常模式。

## 验证

- 新增两个用例：`data before stage_start ... never treated as a storage fault`、
  `data after stage_start without an open H5 still raises a storage fault`；
- 全量回归：Node 112 项、Python 185 项全部通过。
