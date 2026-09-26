"""Recorder simulation, part 1: synthetic BLE packets -> ble_server parse/finalize.

Scenarios baked in: notification coalescing (two packets arriving 1ms apart), a
mid-stream firmware packet-counter reset, and a 200ms stall. This is the D1 root cause:
the old arrival-time back-extrapolation produced whole-packet overlaps (measured: 1713
backward steps in L001 dev1, rewound 54s).

Dumps the parsed stream to tmp/recorder_sim.npz for part 2 (H5 write).
"""
import os
os.environ.setdefault('HDF5_USE_FILE_LOCKING', 'FALSE')
import sys
import struct
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..'))
import ble_server as B

FPKT = 9
CFG = dict(B.DEFAULT_CONFIG)
PARAMS = B.get_packet_params(CFG)


def build_packet(counter, frame_base):
    """One V1 BLE packet: 4B counter LE + FPKT*16*3B big-endian ADC + 36B IMU."""
    buf = bytearray(struct.pack('<I', counter))
    for i in range(FPKT):
        for ch in range(16):
            val = (frame_base + i) * 7 + ch * 1000      # 可区分、单调的假数据
            buf += int(val).to_bytes(3, 'big', signed=True)
    buf += bytes(36)  # IMU 全 0
    assert len(buf) == PARAMS['total_len'], (len(buf), PARAMS['total_len'])
    return buf


def feed(n_packets=600, reset_at=300, stall_at=450):
    dev = B.DeviceState(device_id=1)
    dev.hw_version = 'V1'
    dev.config = CFG
    dev.num_imus = 2
    dev.is_streaming = True

    T0 = 1_700_000_000.0
    fi = 1.0 / B.BLE_SAMPLE_RATE
    counter = 0
    arr_ts, parsed_all = [], []
    for k in range(n_packets):
        # 到达时刻：每 2 包成簇（模拟 BLE 通知合并），450 包处卡 200ms
        t_arrive = T0 + (k // 2) * FPKT * 2 * fi + (k % 2) * 0.001
        if k >= stall_at:
            t_arrive += 0.200
        if k == reset_at:
            counter = 0          # 固件包计数器复位
        p = B.parse_packet(build_packet(counter, k * FPKT), dev)
        assert p is not None, f'packet {k} rejected'
        B.finalize_parsed_packet(dev, p, t_arrive)
        parsed_all.append(p)
        arr_ts.append(t_arrive)
        counter += 1
    return dev, parsed_all, arr_ts


def old_timestamps(arr_ts, fpkt=FPKT):
    """旧行为：t = 到达时刻 - (fpkt-1-i)/250（重叠的根因）"""
    out = []
    for ts in arr_ts:
        out += [ts - (fpkt - 1 - i) / B.BLE_SAMPLE_RATE for i in range(fpkt)]
    return np.array(out)


def report(name, t):
    d = np.diff(t)
    print(f"  {name:8s} n={len(t)} back={(d < 0).sum():4d} rewound={-d[d < 0].sum():7.3f}s "
          f"min_step={d.min()*1000:7.4f}ms max_step={d.max()*1000:8.3f}ms "
          f"span={t[-1]-t[0]:.4f}s")
    return int((d < 0).sum())


dev, parsed_all, arr_ts = feed()
print(f"模拟 {len(parsed_all)} 包 (第300包计数器复位, 第450包起卡顿200ms, 通知成簇到达)")

new_t = np.concatenate([np.array(p['emg_t']) for p in parsed_all])
fids = np.concatenate([np.array(p['frame_ids']) for p in parsed_all])
imu_t = np.concatenate([np.array(p['imu_t']) for p in parsed_all])
old_t = old_timestamps(arr_ts)

print("\n250Hz 时间轴:")
b_old = report('旧行为', old_t)
b_new = report('新行为', new_t)
d_fid = np.diff(fids)
print(f"\nframe_ids: monotone={bool(np.all(d_fid > 0))} back={(d_fid <= 0).sum()} "
      f"range=[{fids[0]}..{fids[-1]}] 帧数={len(fids)}")
d_imu = np.diff(imu_t)
print(f"imu_t:     back={(d_imu < 0).sum()} 同包内并列={int((d_imu == 0).sum())} rows={len(imu_t)} "
      f"(每包 num_imus 行共享同一时刻)")

raw = np.concatenate([np.array(p['raw'], np.int32) for p in parsed_all])   # N x 16
np.savez(os.path.join(HERE, 'recorder_sim.npz'),
         raw=raw, t=new_t, fids=fids, imu_t=imu_t,
         pkt_rows=np.array([len(p['raw']) for p in parsed_all], np.int64))
print(f"\n已写出 tmp/recorder_sim.npz (raw={raw.shape})")
print(f"旧行为回退 {b_old} 处 -> 新行为 {b_new} 处；"
      f"断言 {'PASS' if (b_new == 0 and b_old > 0 and np.all(d_fid > 0) and np.all(d_imu >= 0)) else 'FAIL'}")
