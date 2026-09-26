"""Focused re-check of the rescue label fix on L001 (the only rescue case).

Copies the two L001 h5 to tmp/e2e_l001/, runs repair + one_to_one (falling back to the
rescue), then measures the TRUE residual: which constant offset o makes
    content[i] == real_bin_frame( sd_frame_id[i] + o )
for every sampled row, compared against the stored sync_bin_align_offset.
"""
import os
os.environ.setdefault('HDF5_USE_FILE_LOCKING', 'FALSE')
import sys
import glob
import shutil
import numpy as np
import h5py

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
sys.path.insert(0, HERE)
import bin_sync_tool as B
import hdf5_tool as H
from e2e_new_test import find_bin

ROOT = r"E:/1_Master/2_学业/my_project/1_华为横向"
WORK = os.path.join(HERE, 'e2e_l001')
SRC = [p for p in glob.glob(ROOT + '/4_现场数据/**/*L001*.h5', recursive=True)
       if 'tmp' not in p.replace('\\', '/')]

os.makedirs(WORK, exist_ok=True)
for src in sorted(SRC):
    name = os.path.basename(src)
    for dev in (1, 2):
        with h5py.File(src, 'r') as f:
            if f'emg{dev}_250hz_adc' not in f or len(f[f'emg{dev}_250hz_adc']) < 100:
                continue
            stem = f.attrs.get(f'sd_bin_dev{dev}')
            stem = stem.decode() if isinstance(stem, bytes) else stem
        bd = find_bin(stem)
        if bd is None:
            print(f"  dev{dev}: bin not found {stem}")
            continue
        dst = os.path.join(WORK, f"{dev}_{name}")
        if os.path.exists(dst):
            os.remove(dst)
        shutil.copy2(src, dst)
        H.repair_250hz_timestamps_in_h5(dst, dev)
        emg = f"{bd}/{stem}_emg.bin"
        imu = f"{bd}/{stem}_imu.bin"
        res = B.sync_h5_one_to_one(dst, emg_bin_path=emg,
                                   imu_bin_path=(imu if os.path.exists(imu) else None),
                                   device_id=dev, verify=True, set_synced=True)
        path = 'one_to_one'
        if res.get('status') != 'success':
            res = B.sync_h5_one_to_one_multibin_rescue(
                dst, emg_bin_paths=[emg],
                imu_bin_paths=([imu] if os.path.exists(imu) else []),
                device_id=dev, verify=True, set_synced=True)
            path = 'rescue'
        print(f"\n### dev{dev} {path} status={res.get('status')}")
        with h5py.File(dst, 'r') as f:
            d = f[f'emg{dev}_2khz_adc']
            sid = np.asarray(d['sd_frame_id'], np.int64)
            ch = d['channels'][:]
            t = np.asarray(d['time'], np.float64)
            bb = int(d.attrs.get('sync_bin_align_offset', 0))
            cm, _ = B._resolve_channel_map(f, f'emg{dev}_250hz_adc', 'V2')
        p = B.EMGBinParser(emg).parse()
        idx = np.arange(0, len(sid), max(1, len(sid) // 200))
        res = []
        for off in range(-200, 201):
            bad = sum(1 for i in idx
                      if not (int(sid[i]) + off in p.frames
                              and np.array_equal(ch[i], B.map_physical_to_h5_order(p.frames[int(sid[i]) + off], cm))))
            res.append((bad, off))
        res.sort()
        dt = np.diff(t)
        print(f"  rows={len(sid)} attr bb={bb:+d} | 内容零误差 offset -> "
              + "  ".join(f"{o:+d}(bad={b})" for b, o in res[:3]))
        print(f"  残差 = 最佳 off - attr = {res[0][1] - bb:+d} 帧 | "
              f"time monotone={bool(np.all(dt > 0))} min_dt={dt.min()*1000:.4f}ms | "
              f"t0={t[0]:.3f} tN={t[-1]:.3f} 时长={t[-1]-t[0]:.3f}s")
