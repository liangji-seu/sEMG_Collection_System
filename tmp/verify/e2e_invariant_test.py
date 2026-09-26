#!/usr/bin/env python3
"""Verify the CONTRACT, not just self-consistency: for every 2kHz row,
    content[i] == bin frame ( sd_frame_id[i] + sync_bin_align_offset )
and the alignment matches the BLE stream itself (old firmware: the BLE value of the
250Hz row with sd_frame_id = s equals bin frame s + align_offset exactly).

Runs the full GUI order (repair -> one_to_one, falling back to the rescue) on copies.
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
from e2e_new_test import find_bin

ROOT = r"E:/1_Master/2_学业/my_project/1_华为横向"
WORK = os.path.join(os.path.dirname(__file__), 'e2e_inv')


def pick(pattern, root=ROOT):
    return [p for p in glob.glob(root + '/**/*.h5', recursive=True)
            if pattern in os.path.basename(p) and 'tmp' not in p.replace('\\', '/')]


CASES = []
CASES += pick('L001', ROOT + '/4_现场数据')
CASES += pick('session3_20260708_142319')
CASES += pick('session6_20260708_143435')
CASES += pick('session1_20260904_113633')


def check(hp, bin_dir, stem, dev, tag):
    emg = f"{bin_dir}/{stem}_emg.bin"
    imu = f"{bin_dir}/{stem}_imu.bin"
    res = B.sync_h5_one_to_one(hp, emg_bin_path=emg,
                               imu_bin_path=(imu if os.path.exists(imu) else None),
                               device_id=dev, verify=True, set_synced=True)
    path = 'one_to_one'
    if res.get('status') != 'success':
        res = B.sync_h5_one_to_one_multibin_rescue(
            hp, emg_bin_paths=[emg],
            imu_bin_paths=([imu] if os.path.exists(imu) else []),
            device_id=dev, verify=True, set_synced=True)
        path = 'rescue'
    if res.get('status') != 'success':
        print(f"    {tag} {path} status={res.get('status')} <跳过>")
        return
    with h5py.File(hp, 'r') as f:
        d = f[f'emg{dev}_2khz_adc']
        sid = np.asarray(d['sd_frame_id'], np.int64)
        ch = d['channels'][:]
        bb = int(d.attrs.get('sync_bin_align_offset', 0))
        fid0 = int(d.attrs.get('sync_bin_fid0', 0))
        cm, _ = B._resolve_channel_map(f, f'emg{dev}_250hz_adc', 'V2')
        # 250Hz 侧：BLE 值 vs bin（旧固件应当逐采样精确相等）
        ds250 = f[f'emg{dev}_250hz_adc']
        s250 = np.asarray(ds250['sd_frame_id'], np.int64)
        v250 = ds250['channels'][:]
    p = B.EMGBinParser(emg).parse()
    n = len(sid)
    idx = np.arange(0, n, max(1, n // 500))
    absent = bad = 0
    for i in idx:
        row = p.frames.get(int(sid[i]) + bb)
        if row is None:
            absent += 1
        elif not np.array_equal(ch[i], B.map_physical_to_h5_order(row, cm)):
            bad += 1
    # 250Hz 侧物理对齐
    j = np.arange(0, len(s250), max(1, len(s250) // 500))
    hit250 = sum(1 for i in j
                 if int(s250[i]) + bb in p.frames
                 and np.array_equal(v250[i], B.map_physical_to_h5_order(p.frames[int(s250[i]) + bb], cm)))
    print(f"    {tag} {path}: rows={n} 缺帧={absent} 内容不符={bad} / {len(idx)} 抽样 | "
          f"250Hz BLE↔bin 精确命中 {hit250}/{len(j)} @offset {bb:+d} | "
          f"sd=[{sid[0]}..{sid[-1]}] fid0={fid0}")


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
            bd = find_bin(stem)
            if bd is None:
                print(f"  dev{dev}: 找不到 bin {stem}")
                continue
            dst = os.path.join(WORK, f"{dev}_{name}")
            if os.path.exists(dst):
                os.remove(dst)
            shutil.copy2(src, dst)
            H.repair_250hz_timestamps_in_h5(dst, dev)
            check(dst, bd, stem, dev, f"dev{dev}")


if __name__ == '__main__':
    main()
