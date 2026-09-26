#!/usr/bin/env python3
"""Full GUI flow on COPIES: repair_250hz_timestamps_in_h5  ->  sync  ->  verify.

This is the order SyncWorker actually runs (hdf5_tool.py: repair before sync).
Checks that after the rewritten (monotonicity-only) repair the sync output is
  - one row per bin frame in the aligned range  (no phantom frame loss)
  - sd_frame_id unique & step 1                (no duplicate / no overlap)
  - time strictly increasing                   (no fold)
  - content identical to the bin, 58Hz band unchanged

For contract, each case also syncs a second copy WITHOUT the repair, so the
before/after effect of the repair on the final 2kHz output is visible.
"""
import os
os.environ.setdefault('HDF5_USE_FILE_LOCKING', 'FALSE')
import sys
import glob
import shutil
import numpy as np
import h5py

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'tools'))
sys.path.insert(0, os.path.dirname(__file__))
import bin_sync_tool as B
import hdf5_tool as H
from e2e_new_test import find_bin, bandfrac

ROOT = r"E:/1_Master/2_学业/my_project/1_华为横向"
WORK = os.path.join(os.path.dirname(__file__), 'e2e_flow')


def pick(pattern, root=ROOT):
    return [p for p in glob.glob(root + '/**/*.h5', recursive=True)
            if pattern in os.path.basename(p) and 'tmp' not in p.replace('\\', '/')]


CASES = []
CASES += pick('L001', ROOT + '/4_现场数据')
CASES += pick('session3_20260708_142319')
CASES += pick('session6_20260708_143435')
CASES += pick('session1_20260904_113633')


def col(hp, dev, name):
    with h5py.File(hp, 'r') as f:
        if name not in f:
            return None
        return np.asarray(f[name]['time'], np.float64)


def desc(t):
    if t is None or len(t) < 2:
        return "n/a"
    d = np.diff(t)
    return (f"back={int((d<0).sum())} rewound={-d[d<0].sum():.3f}s "
            f"span={t[-1]-t[0]:.3f}s")


def sync_and_verify(hp, bin_dir, stem, dev):
    emg = f"{bin_dir}/{stem}_emg.bin"
    imu = f"{bin_dir}/{stem}_imu.bin"
    res = B.sync_h5_one_to_one(
        h5_path=hp, emg_bin_path=emg,
        imu_bin_path=(imu if os.path.exists(imu) else None),
        device_id=dev, verify=True, set_synced=True)
    if res.get('status') != 'success':
        res = B.sync_h5_one_to_one_multibin_rescue(
            h5_path=hp, emg_bin_paths=[emg],
            imu_bin_paths=([imu] if os.path.exists(imu) else []),
            device_id=dev, verify=True, set_synced=True)
        tag = 'rescue'
    else:
        tag = 'one_to_one'
    if res.get('status') != 'success':
        return f"    {tag} status={res.get('status')} <跳过校验>"
    with h5py.File(hp, 'r') as f:
        d = f[f'emg{dev}_2khz_adc']
        sid = np.asarray(d['sd_frame_id'], np.int64)
        t = np.asarray(d['time'], np.float64)
        ch = d['channels'][:]
        cm, _ = B._resolve_channel_map(f, f'emg{dev}_250hz_adc', 'V2')
        bb = int(d.attrs.get('sync_bin_align_offset', 0))
    p = B.EMGBinParser(emg).parse()
    lo, hi = int(sid.min()) + bb, int(sid.max()) + bb
    have = sorted(k for k in p.frames if lo <= k <= hi)
    dsid, dt = np.diff(sid), np.diff(t)
    vals = np.asarray([B.map_physical_to_h5_order(p.frames[k], cm)[0] for k in have],
                      np.float64)
    out = [f"    {tag}: rows={len(sid)} bin_in_range={len(have)} diff={len(have)-len(sid)} | "
           f"sd unique={len(np.unique(sid))} step_min={dsid.min()} neg={int((dsid<0).sum())} | "
           f"time monotone={bool(np.all(dt>0))} back={int((dt<0).sum())} span={t[-1]-t[0]:.3f}s | "
           f"58Hz H5={bandfrac(ch[:,0],2000.,58):.5f} bin={bandfrac(vals,2000.,58):.5f}"]
    return "\n".join(out)


def main():
    os.makedirs(WORK, exist_ok=True)
    for src in CASES:
        name = os.path.basename(src)
        print(f"\n{'='*78}\n{name[:64]}\n{'='*78}")
        with h5py.File(src, 'r') as f:
            devs = [d for d in (1, 2)
                    if f'emg{d}_250hz_adc' in f and len(f[f'emg{d}_250hz_adc']) > 100]
        for dev in devs:
            with h5py.File(src, 'r') as f:
                stem = f.attrs.get(f'sd_bin_dev{dev}')
                stem = stem.decode() if isinstance(stem, bytes) else stem
            bin_dir = find_bin(stem)
            if bin_dir is None:
                print(f"  dev{dev}: 找不到 bin {stem}")
                continue
            print(f"  --- dev{dev} ({stem}) ---")
            for tag, do_repair in (('修复后同步', True), ('不修复同步', False)):
                dst = os.path.join(WORK, f"{'R' if do_repair else 'N'}{dev}_{name}")
                if os.path.exists(dst):
                    os.remove(dst)
                shutil.copy2(src, dst)
                if do_repair:
                    r = H.repair_250hz_timestamps_in_h5(dst, dev)
                    print(f"    repair: {desc(col(dst, dev, f'emg{dev}_250hz_adc'))} "
                          f"mode={(r or {}).get('mode')} push={(r or {}).get('max_push_s',0)*1000:.0f}ms")
                else:
                    print(f"    源 250Hz: {desc(col(dst, dev, f'emg{dev}_250hz_adc'))}")
                print(sync_and_verify(dst, bin_dir, stem, dev))


if __name__ == '__main__':
    main()
