"""Unit-test the new recorder timeline (_counter_timeline in ble_server.py).

Loads only that one function out of ble_server.py (no module import: the module starts
threads and needs ble hardware) and exercises the four scenarios that matter:
steady stream / bursty arrival / BLE packet loss / host clock jump.
"""
import ast
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', '..', 'ble_server.py')
text = io.open(SRC, encoding='utf-8').read()
tree = ast.parse(text)
node = next(n for n in tree.body
            if isinstance(n, ast.FunctionDef) and n.name == '_counter_timeline')
class _Stub:
    pass


ns = {'BLE_SAMPLE_RATE': 250, 'DeviceState': _Stub}
exec(compile(ast.Module(body=[node], type_ignores=[]), SRC, 'exec'), ns)
_counter_timeline = ns['_counter_timeline']


class Dev:
    def __init__(self):
        self.sample_clock_ref = None
        self.last_emit_time = None


FPKT = 9
FI = 1.0 / 250


def run(name, arrivals, counters, expect_span_s=None):
    dev = Dev()
    out = []
    for ts, pkt in zip(arrivals, counters):
        start = pkt * FPKT
        out += _counter_timeline(dev, start, FPKT, ts)
    d = [b - a for a, b in zip(out, out[1:])]
    back = [x for x in d if x <= 0]
    ok_mono = not back
    print(f"[{name}] n={len(out)} monotone={ok_mono} min_step={min(d)*1000:.4f}ms "
          f"max_step={max(d)*1000:.4f}ms back={len(back)} span={out[-1]-out[0]:.4f}s")
    if expect_span_s is not None:
        print(f"    期望时长≈{expect_span_s:.4f}s 实际={out[-1]-out[0]:.4f}s "
              f"偏差={(out[-1]-out[0])-expect_span_s:+.4f}s")
    return out, ok_mono


print("=== A 稳定流（每包 36ms 到达）===")
T0 = 1000.0
n_pkt = 500
a, ok1 = run('steady', [T0 + i * FPKT * FI for i in range(n_pkt)], range(n_pkt),
             expect_span_s=(n_pkt - 1) * FPKT * FI)

print("\n=== B 突发到达（每 2 包几乎同时到达：模拟 BLE 通知成簇）===")
arr = []
for i in range(n_pkt):
    arr.append(T0 + (i // 2) * FPKT * 2 * FI + (i % 2) * 0.001)
b, ok2 = run('burst', arr, range(n_pkt), expect_span_s=(n_pkt - 1) * FPKT * FI)

print("\n=== C BLE 丢包（每 10 包丢 3 包）===")
arr, cnt = [], []
for i in range(n_pkt):
    pkt = i + (i // 10) * 3
    arr.append(T0 + pkt * FPKT * FI)
    cnt.append(pkt)
c, ok3 = run('loss', arr, cnt, expect_span_s=(cnt[-1]) * FPKT * FI)

print("\n=== D 主机时钟前跳 2s（_precise_time 重校准）===")
arr = [T0 + i * FPKT * FI + (2.0 if i >= 100 else 0.0) for i in range(n_pkt)]
d, ok4 = run('clockjump', arr, range(n_pkt), expect_span_s=(n_pkt - 1) * FPKT * FI + 2.0)

print("\n=== E 计数器复位后继续（parse_packet 已把帧号续接，这里直接给跳变后的帧号）===")
arr = [T0 + i * FPKT * FI for i in range(n_pkt)]
cnt = [i if i < 100 else i + 7 for i in range(n_pkt)]   # 复位丢掉 6 包后帧号续接
e, ok5 = run('reset', arr, cnt, expect_span_s=(cnt[-1]) * FPKT * FI)

print()
print("全部单调:", all([ok1, ok2, ok3, ok4, ok5]))
print("B 突发场景：旧行为会产生", sum(1 for i in range(1, n_pkt) if arr[i] - arr[i-1] < FPKT * FI * 0.5),
      "处整包重叠；新行为 back=", sum(1 for x in [b[i+1]-b[i] for i in range(len(b)-1)] if x <= 0))
