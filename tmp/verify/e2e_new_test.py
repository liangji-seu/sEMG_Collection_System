#!/usr/bin/env python3
"""End-to-end check of the bin-driven 2kHz write, on COPIES only.

For each case: copy the H5 into tmp/e2e_new/, run sync_h5_one_to_one with the new
writer, then verify
  * rows == number of bin frames in the aligned range (no frame dropped)
  * sd_frame_id strictly increasing and unique (no duplicate / no overlap)
  * time strictly increasing (no fold)
  * contents still equal the bin frames
  * 58Hz band power unchanged vs the bin's own contiguous stream
"""
import os
os.environ.setdefault('HDF5_USE_FILE_LOCKING', 'FALSE')
import sys
import glob
import shutil
import numpy as np
import h5py

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'tools'))
import bin_sync_tool as B

ROOT = r"E:/1_Master/2_学业/my_project/1_华为横向"
WORK = os.path.join(os.path.dirname(__file__), 'e2e_new')


def find_bin(stem):
    """Locate {stem}_emg.bin anywhere under the project root."""
    hits = glob.glob(ROOT + '/**/' + stem + '_emg.bin', recursive=True)
    return os.path.dirname(hits[0]) if hits else None


CASES = []
for frag in ('session1_20260904_113633', 'session6_20260904_115148'):
    for p in glob.glob(ROOT + '/6_新手环同步/**/*.h5', recursive=True):
        if frag in os.path.basename(p):
            CASES.append((p, (1, 2)))
for p in glob.glob(ROOT + '/4_现场数据/**/*.h5', recursive=True):
    if 'L001' in os.path.basename(p) and 'session4_20260709_091509' in os.path.basename(p):
        CASES.append((p, (1, 2)))


def bandfrac(x, fs, h):
    x = np.asarray(x, np.float64) - np.mean(x)
    X = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    fr = np.fft.rfftfreq(len(x), 1.0 / fs)
    tot = X[(fr > 1) & (fr < 900)].sum()
    m = (fr > h - 1.5) & (fr < h + 1.5)
    return X[m].sum() / tot if tot else 0.0


def main():
    if not CASES:
        print("no cases found")
        return
    os.makedirs(WORK, exist_ok=True)
    for src, devs in CASES:
        name = os.path.basename(src)
        dst = os.path.join(WORK, name)
        if os.path.exists(dst):
            os.remove(dst)
        shutil.copy2(src, dst)
        print(f"\n{'='*78}\n{name[:60]}\n{'='*78}")
        for dev in devs:
            with h5py.File(dst, 'r') as f:
                if f'emg{dev}_250hz_adc' not in f or len(f[f'emg{dev}_250hz_adc']) < 100:
                    print(f"  dev{dev}: 无 250Hz 数据，跳过")
                    continue
                stem = f.attrs.get(f'sd_bin_dev{dev}')
                stem = stem.decode() if isinstance(stem, bytes) else stem
            bin_dir = find_bin(stem)
            if bin_dir is None:
                print(f"  dev{dev}: 找不到 bin {stem}")
                continue
            emg = f"{bin_dir}/{stem}_emg.bin"
            imu = f"{bin_dir}/{stem}_imu.bin"
            res = B.sync_h5_one_to_one(
                h5_path=dst, emg_bin_path=emg,
                imu_bin_path=(imu if os.path.exists(imu) else None),
                device_id=dev, verify=True, set_synced=True)
            print(f"  dev{dev}: status={res.get('status')} "
                  f"filled={res.get('filled_frames')} missing={res.get('missing_frames')} "
                  f"frames_2khz={res.get('frames_2khz')} imu={res.get('imu_status')}")
            verify(dst, emg, dev, stem)


def verify(hp, emg, dev, stem):
    with h5py.File(hp, 'r') as f:
        d = f[f'emg{dev}_2khz_adc']
        sid = np.asarray(d['sd_frame_id'], np.int64)
        t = np.asarray(d['time'], np.float64)
        ch = d['channels'][:]
        a = {k: d.attrs[k] for k in d.attrs if k.startswith('sync_2khz') or k.startswith('sync_time_model')}
        cm, _ = B._resolve_channel_map(f, f'emg{dev}_250hz_adc', 'V2')
        bb = int(d.attrs.get('sync_bin_align_offset', 0))
    p = B.EMGBinParser(emg).parse()
    lo, hi = int(sid.min()) + bb, int(sid.max()) + bb
    have = sorted(k for k in p.frames if lo <= k <= hi)
    dsid = np.diff(sid)
    dt = np.diff(t)
    print(f"     2kHz rows={len(sid)}  bin frames in range={len(have)}  "
          f"diff={len(have)-len(sid)}")
    print(f"     sd: unique={len(np.unique(sid))} min_step={dsid.min()} "
          f"zero_steps={int((dsid==0).sum())} neg_steps={int((dsid<0).sum())}")
    print(f"     time: monotone={bool(np.all(dt>0))} back_steps={int((dt<0).sum())} "
          f"span={t[-1]-t[0]:.3f}s")
    n = len(sid)
    bad = 0
    for i in range(0, n, max(1, n // 400)):
        row = p.frames.get(int(sid[i]) + bb)
        if row is not None and not np.array_equal(
                ch[i], B.map_physical_to_h5_order(row, cm)):
            bad += 1
    print(f"     content spot-check: {bad} mismatches in {len(range(0, n, max(1, n//400)))} samples")
    print(f"     attrs: {a}")
    # 58Hz band power: H5 output vs the bin's own contiguous stream
    vals = [B.map_physical_to_h5_order(p.frames[k], cm)[0] for k in have]
    print(f"     58Hz: H5={bandfrac(ch[:, 0], 2000.0, 58):.5f}  "
          f"bin(contiguous)={bandfrac(np.asarray(vals, np.float64), 2000.0, 58):.5f}")


if __name__ == '__main__':
    main()
