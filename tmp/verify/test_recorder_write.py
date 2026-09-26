"""Recorder simulation, part 2: replay the parsed stream through storage_server's real
H5 writer (the same calls realtimeEngine's payload triggers), then check the columns.

Run after tmp/test_recorder_timeline.py (it consumes tmp/recorder_sim.npz).
Imports storage_server only — it replaces sys.stdout, so it must not share a process
with ble_server.
"""
import os
os.environ.setdefault('HDF5_USE_FILE_LOCKING', 'FALSE')
import sys
import threading
import numpy as np
import h5py

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import storage_server as S
import hdf5_tool as H

z = np.load(os.path.join(HERE, 'recorder_sim.npz'))
raw, ts, fids, imu_t = z['raw'], z['t'], z['fids'], z['imu_t']
pkt_rows = z['pkt_rows']

H5 = os.path.join(HERE, 'recorder_sim.h5')
if os.path.exists(H5):
    os.remove(H5)
st = object.__new__(S.HDF5StorageServer)      # 绕过 __init__（它会绑定 ZMQ 端口）
st.f = h5py.File(H5, 'w')
st.lock = threading.Lock()
st.stats = {'emg1_frames': 0, 'imu1_all_frames': 0}
st.file_path = H5
st.f.create_dataset('emg1_250hz_adc', shape=(0,), maxshape=(None,),
                    dtype=S.EMG_250HZ_ADC_DTYPE)
st.f.create_dataset('imu1_all_ble', shape=(0,), maxshape=(None,),
                    dtype=S.IMU_ALL_BLE_DTYPE)

pos = 0
for nrow in pkt_rows:
    emg = raw[pos:pos + nrow].T.astype(np.int32)          # 16 x fpkt，与 realtimeEngine 一致
    st._append_emg('emg1', emg.tolist(), ts[pos:pos + nrow].tolist(),
                   fids[pos:pos + nrow].tolist())
    st._append_imu_all('imu1_all',
                       [{'index': i, 'acc': [0, 0, 0], 'gyr': [0, 0, 0]} for i in range(2)],
                       [float(ts[pos + nrow - 1])], int(fids[pos]), 'V1')
    pos += nrow

ds = st.f['emg1_250hz_adc']
h5_t = np.asarray(ds['time'], np.float64)
h5_sd = np.asarray(ds['sd_frame_id'], np.int64)
h5_fid = np.asarray(ds['frame_id'], np.int64)
imu_t_h5 = np.asarray(st.f['imu1_all_ble']['time'], np.float64)
st.f.close()


def report(name, t):
    d = np.diff(t)
    print(f"  {name:9s} n={len(t)} back={(d < 0).sum():4d} rewound={-d[d < 0].sum():7.3f}s "
          f"min_step={d.min()*1000:7.4f}ms max_step={d.max()*1000:8.3f}ms "
          f"span={t[-1]-t[0]:.4f}s")
    return int((d < 0).sum())


print(f"H5 250Hz rows={len(h5_t)}  与模拟帧数一致: {len(h5_t) == len(fids)}")
b_t = report('H5 time', h5_t)
d_sd = np.diff(h5_sd)
d_fid = np.diff(h5_fid)
print(f"H5 sd_frame_id back={(d_sd <= 0).sum()} step8={(d_sd == 8).sum()}/{len(d_sd)} "
      f"range=[{h5_sd[0]}..{h5_sd[-1]}]")
print(f"H5 frame_id    back={(d_fid <= 0).sum()} monotone={bool(np.all(d_fid > 0))}")
d_imu = np.diff(imu_t_h5)
print(f"  H5 imu     n={len(imu_t_h5)} back={(d_imu < 0).sum()} 同包内并列={int((d_imu == 0).sum())} "
      f"(每包 num_imus 行共享同一时刻，属正常) span={imu_t_h5[-1]-imu_t_h5[0]:.4f}s")
b_imu = int((d_imu < 0).sum())

r = H.repair_250hz_timestamps_in_h5(H5, 1, log_cb=None)
print(f"\nhdf5_tool 再跑时间修复: {r}")
if isinstance(r, dict):
    print(f"  应为无操作(backward=0): {r.get('backward') == 0}")

print()
ok = (b_t == 0 and b_imu == 0 and np.all(d_sd > 0) and np.all(d_fid > 0)
      and len(h5_t) == len(fids))
print(f"全部断言: {'PASS' if ok else 'FAIL'}")
