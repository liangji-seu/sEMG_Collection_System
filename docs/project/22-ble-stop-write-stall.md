# 切流卡 30 秒导致前端超时（2026-10-30）

## 现象

重启软件后进入连续手势，点"单轮采集"，立即提示切流失败（前端 12 秒超时），
但后台其实还在继续切流，界面与真实状态不一致。

## 日志证据

`log/server_20261030_111700.653_89700_000001.log`：

```
19:17:39.120  [switch] Phase 1: 停止活跃 stream...
19:18:09.138  [switch] Dev1 已发送 STOP        ← 间隔 30.018 秒
19:18:09.388  [switch] Dev2 已发送 STOP
19:18:09.388  [switch] Phase 2: 等待 3000ms
```

与此同时 Dev1 的预览数据在 19:17:39 就停了——说明 **STOP 命令早已到达设备**，
卡住的是"等待 ATT 写响应"这一段。

## 根因

`_do_stop_stream_for_device` 通过 `send_control_command` 用 **Write with Response**
发 STOP。5.3.0 固件收到 STOP 后会立刻去关闭 SD 卡上的 bin，ATT 响应迟迟不回；
`asyncio.wait_for(timeout=3s)` 的取消**无法中断底层 WinRT 写操作**，只能等到
系统级 30 秒超时，整个事件循环被这个协程占住。

前端 `sendAndWait('switch_preview_to_collection')` 默认 12 秒超时 → 先报失败，
而后台仍在继续切流（之后还会把设备切到 collection），状态就错位了。

## 修复

1. `send_control_command(..., expect_response=False)`：STOP / START 改为
   Write without Response —— 命令发出即返回，不再等设备 ATT 响应；
   SET_FILENAME / 采样率 / CONFIG 仍保留 with-response（这些需要设备确认参数）。
2. 切流本身仍有 `STOP → 等 3 秒 → START` 的固定等待，足以让 ESP32 关闭 bin。
3. 前端切流超时从 12 秒放宽到 60 秒，避免慢设备偶发超时后"前后端状态错位"。

## 验证

真机复现（两只 5.3.0 手环，先开 preview 再切 collection）：

```
preview: true [1,2]
切流: true 耗时=4972ms {...} missing=[]
collection_start: success
stage_start: success
collection_stop_and_wait: success
```

修复前同一路径会卡 30 秒以上并让前端报超时；现在 5 秒内完成。

回归：Node 112 项、Python 187 项全部通过（新增 STOP 写入模式用例）。

## 追加（19:33 / 20:09 两次现场卡顿）

现场连续两次在"一轮结束 → 切回 preview/返回"时卡 30 秒，期间左手停止发数据、
右手继续，看起来就是"左手断了"：

- `19:33:11 stop_any_stream` → `19:33:41` 才停完 Dev1：卡在 `client.stop_notify()`；
- `20:08:57 switch_collection_to_preview` Phase 1 → `20:09:27` 才打印"Dev1 已发送 STOP"：
  即使已经改成 without-response，WinRT 的 GATT 写调用本身仍可能被拥塞卡 30 秒。

对应修复：

1. **不再 await `stop_notify()`**：旧回调由 `notification_epoch` 保护，下一次
   `start_notify` 会覆盖回调，残留通知会被忽略；取消订阅对采流不是必需的。
2. `send_control_command` 统一改成"有界等待"：`asyncio.ensure_future(write)` +
   `wait_for(shield(task), min(timeout, 2s))`，超时后让写操作在后台继续并立即返回；
   `SET_FILENAME` 超时仍会补一次 without-response。这样任何一次 WinRT 写挂起都不会
   再堵住 asyncio 控制链路。

验证：新增 `hung_write_cannot_block_the_caller` 用例（永不完成的写调用，调用方
2 秒内返回）；真机全流程回归待手环上电后补跑。

