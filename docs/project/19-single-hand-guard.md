# 单手/缺侧采集防护（2026-10-30）

## 背景

现场出现过"A016-01 session6 右手 EMG 0 行、H5 正常关闭、同步仍显示 synced"的情况。
根因不是 H5 丢帧，而是链路每一层都把"参与的设备"当成了"全部设备"：

1. `ble_server.switch_preview_to_collection` 逐设备启动，失败就 `continue`，只要有一只成功
   就返回 `success: True`，`collection_bins` 只含一侧，且没有 `errors` 字段；
2. 前端只打印 `collection_bins`，不校验 `started` 数量；
3. 引擎按 `collection_bins` 建 H5，缺侧不报错；
4. 落盘侧单手 H5 返回 `status: success`，只在 `capture_warnings` 里带 `emg_dev2_empty`；
5. 同步工具用"非空 250Hz 数据集"推断必需设备，0 行的那一侧根本不算必需，于是判 `synced`。

## 本次修复

### 1. 切流"全有或全无"（`ble_server.py`）

- `switch_preview_to_collection(ws, expected_devices=None)` 新增期望设备入参；
- 期望集合由前端 `BleControl.getExpectedDeviceIds()` 维护：**连接即记账，只有显式断开才移除**，
  所以采集中意外掉线的那只手仍留在期望集合里；
- 启动后逐一比对 `started` 与期望：缺任何一台就**回滚已启动的流**，返回
  `success: False`、`missing_devices`、`device_status` 和可直接展示的中文错误；
- 成功时返回中也带上 `expected_devices` / `missing_devices: []`，便于上游审计。

### 2. 期望设备落盘（`collection-controller.js` → `realtimeEngine.js` → `storage_server.py`）

切流成功后 `expected_devices` 随 `collection_start` 传入引擎，写入 H5 根属性：

| 属性 | 含义 |
|---|---|
| `physical_device_ids` | 本任务期望参与的手，如 `[1, 2]`（JSON 字符串） |
| `physical_device_ids_source` | 固定为 `collection_switch_expected`，标明来源 |

单手文件仍然可以关闭（不改变现场"先保住数据"的策略），但 H5 里留下了"应到未到"的证据。

### 3. 同步以期望设备为必需（`tools/bin_sync_tool.py`）

`derive_required_sync_devices()` 优先读 `physical_device_ids`，并与"非空 250Hz 数据集"取并集。
缺侧时 `emg_complete=False`，`sync_status_summary()` 返回 `partial` 而不是 `synced`；
历史文件没有该属性时仍按旧规则推断，行为不变。

### 4. 单手关闭改为阻塞提示（`realtimeEngine.js`）

`_reportCaptureWarnings()` 现在以 `level: 'error', blocking: true` 广播，前端 `waveform.js`
原有的分支会走阻塞式 `alert`，要求操作员当场确认重采，而不是几秒后消失的 toast。

### 5. 发送队列溢出改为丢最旧（`ble_server.py`）

`add_to_queue()` 在 `PRIORITY_LOW` 队列达到 `queue_low_limit` 时，丢弃**最旧的一条数据**并
继续接收新样本（控制消息不受影响），同时照旧上报 `transport_fault`。
此前的行为是整批丢弃刚到达的新数据，会在时间轴上留下当前时刻的空洞。

## 行为变化（现场需要知道）

- 两只手都连接过、但切流时有一只没起来：**本轮不会开始**，会提示具体是哪只手，需重连后重试。
- 只用一只手做任务：先在界面上显式断开另一只，再开始采集（否则会按"期望双手"拦截）。
- 单手完成的 H5 仍会保存，但同步状态为 `partial`，不会再被标成 `synced`。

## 验证

- Node：110 项全部通过（新增"期望设备写入 H5 create 参数"用例，并把单手关闭断言改为阻塞）。
- Python：177 项全部通过（新增切流回滚、队列丢最旧、`physical_device_ids` 落盘、
  "缺侧仍 partial" 四组用例）。
