#!/usr/bin/env python3
"""
repair_timestamps.py — 修复 H5 文件中 EMG 时间戳回退问题

根因：ble_server.py 使用 time.time() 捕获 BLE 通知时间，Windows time.time()
分辨率约 15.6ms，而 BLE 通知每 4ms 到达一次，导致连续 3~5 个包共享同一时间戳，
反推帧时间戳完全重叠 → 存储时出现大量回退（-32ms @250Hz, -35.5ms @2kHz）。

修复方法：检测帧间间隔中位数作为实际采样率，单调化时间戳序列，消除回退的同时
保持采样间距准确。

用法：
    python tools/repair_timestamps.py <input.h5> [output.h5] [--dry-run]

    - 不指定 output：原地修复（直接修改 input 文件）
    - --dry-run：只检测不修复，打印回退统计
    - 支持批量：python tools/repair_timestamps.py data/*.h5 --outdir repaired/
"""

import argparse
import h5py
import numpy as np
import os
import shutil
import sys
import tempfile
from contextlib import ExitStack
from pathlib import Path
try:
    from .alignment import unwrap_u32_strict
except ImportError:
    from alignment import unwrap_u32_strict
try:
    from .file_access import h5_transaction, logical_h5_path, exclusive_file, FileBusyError
except ImportError:
    from file_access import h5_transaction, logical_h5_path, exclusive_file, FileBusyError

# 需要修复的数据集（EMG + IMU 时间戳字段）
DATASET_CONFIG = {
    # EMG: sd_frame_id 是 ESP32 SD 卡 2kHz 计数器
    # - emg_2khz_adc: 步长 1，直接用 2000Hz
    # - emg_250hz_adc: 步长 8（每 8 个 2kHz 计数 = 1 个 250Hz 帧），公式仍用 2000Hz
    'emg1_2khz_adc':  {'time_field': 'time', 'expected_rate': 2000, 'sd_id_rate': 2000, 'mono_mode': 'strict'},
    'emg2_2khz_adc':  {'time_field': 'time', 'expected_rate': 2000, 'sd_id_rate': 2000, 'mono_mode': 'strict'},
    'emg1_250hz_adc': {'time_field': 'time', 'expected_rate': 250,  'sd_id_rate': 2000, 'mono_mode': 'strict'},
    'emg2_250hz_adc': {'time_field': 'time', 'expected_rate': 250,  'sd_id_rate': 2000, 'mono_mode': 'strict'},
    # IMU 100Hz: sd_frame_id 以自身 100Hz 速率计数
    'imu1a_100hz':    {'time_field': 'time', 'expected_rate': 100,  'sd_id_rate': 100,  'mono_mode': 'strict'},
    'imu1b_100hz':    {'time_field': 'time', 'expected_rate': 100,  'sd_id_rate': 100,  'mono_mode': 'strict'},
    'imu1c_100hz':    {'time_field': 'time', 'expected_rate': 100,  'sd_id_rate': 100,  'mono_mode': 'strict'},
    'imu2a_100hz':    {'time_field': 'time', 'expected_rate': 100,  'sd_id_rate': 100,  'mono_mode': 'strict'},
    'imu2b_100hz':    {'time_field': 'time', 'expected_rate': 100,  'sd_id_rate': 100,  'mono_mode': 'strict'},
    'imu2c_100hz':    {'time_field': 'time', 'expected_rate': 100,  'sd_id_rate': 100,  'mono_mode': 'strict'},
    # IMU BLE 原始数据：一包内多帧共享同一个 ts，只需修正回退（不强制等间隔）
    'imu1_all_ble':   {'time_field': 'time', 'expected_rate': None, 'sd_id_rate': None, 'mono_mode': 'gentle'},
    'imu2_all_ble':   {'time_field': 'time', 'expected_rate': None, 'sd_id_rate': None, 'mono_mode': 'gentle'},
}


def repair_with_frame_counter(times, frame_ids, sample_rate):
    """使用 sd_frame_id 精确修复时间戳

    原理：sd_frame_id 是 ESP32 SD 卡记录的帧计数器，
    用它重新计算时间戳可以完全消除 time.time() 精度不足导致的回退。

    公式：corrected_time[i] = time_base + (frame_ids[i] - frame_ids[0]) / sample_rate
    其中 time_base = times[0]（第一帧原始时间，作为绝对时间锚点）

    自动处理 ESP32 计数器溢出复位（sd_frame_id 跳变回零）。
    """
    n = len(times)
    if n < 2:
        return times.copy(), {'backward': 0, 'adjusted': 0}

    frame_interval = 1.0 / sample_rate

    if len(frame_ids) != n or not np.all(np.isfinite(times)):
        raise ValueError('times and frame_ids must have equal lengths and finite timestamps')
    if not np.isfinite(sample_rate) or sample_rate <= 0:
        raise ValueError('sample_rate must be positive and finite')
    adjusted_ids = unwrap_u32_strict(frame_ids)

    # 用修正后的 ID 计算精确时间戳
    time_base = times[0]
    frame_base = adjusted_ids[0]
    corrected = time_base + (adjusted_ids.astype(np.float64) - frame_base) * frame_interval
    if np.any(np.diff(corrected) <= 0):
        raise ValueError('counter-derived timestamps are not strictly increasing')

    # 统计回退
    diffs_orig = np.diff(times)
    n_backward = int(np.sum(diffs_orig < 0))

    # 统计需要调整的帧数
    n_adjusted = int(np.sum(np.abs(corrected - times) > frame_interval * 0.01))

    return corrected, {
        'backward': n_backward,
        'adjusted': n_adjusted,
        'frame_interval_us': frame_interval * 1e6,
        'total_shift_us': float(np.sum(np.abs(corrected - times)) * 1e6),
    }


def detect_frame_interval(times):
    """从实际数据中检测帧间隔（使用正差值的 P50）"""
    if len(times) < 2:
        return None
    diffs = np.diff(times)
    positive = diffs[diffs > 0]
    if len(positive) == 0:
        return None
    return float(np.percentile(positive, 50))


def monotonize_timestamps(times, frame_interval=None, mode='strict'):
    """单调化时间戳序列（回退方案：当 sd_frame_id 不可用时使用）

    mode='strict': 强制等间隔，回退帧推到正确位置
    mode='gentle': 仅修正回退，允许同一 ts 连续出现
    """
    n = len(times)
    if n < 2:
        return times.copy(), {'backward': 0, 'adjusted': 0, 'frame_interval_us': 0, 'total_shift_us': 0}

    if frame_interval is None:
        frame_interval = detect_frame_interval(times)
    if frame_interval is None:
        frame_interval = 0.001

    corrected = times.copy()
    n_backward = 0
    n_adjusted = 0
    total_shift_us = 0.0

    if mode == 'strict':
        for i in range(1, n):
            min_expected = corrected[i - 1] + frame_interval * 0.5
            if corrected[i] < corrected[i - 1]:
                n_backward += 1
            if corrected[i] < min_expected:
                shift = min_expected - corrected[i]
                corrected[i] = min_expected
                n_adjusted += 1
                total_shift_us += shift * 1e6
    else:
        for i in range(1, n):
            if corrected[i] < corrected[i - 1]:
                n_backward += 1
                corrected[i] = corrected[i - 1] + frame_interval
                n_adjusted += 1

    return corrected, {
        'backward': n_backward,
        'adjusted': n_adjusted,
        'frame_interval_us': frame_interval * 1e6,
        'total_shift_us': total_shift_us,
    }


def _write_time_field(h5f, ds_name, corrected_times):
    """用完整数据集替换的方式写回时间戳

    h5py 对 compound dtype 的字段级写入 (ds['time'][:] = x) 不生效，
    必须：读全量 → 改 time → del 旧数据集 → create_dataset 重建
    """
    old_ds = h5f[ds_name]
    # 读全量数据
    data = old_ds[:]
    # 修改 time 字段
    data['time'] = corrected_times
    # 保存元数据
    parent = old_ds.parent
    name = old_ds.name.split('/')[-1]
    dtype = old_ds.dtype
    attrs = dict(old_ds.attrs)
    maxshape = old_ds.maxshape if hasattr(old_ds, 'maxshape') else (None,)
    chunks = old_ds.chunks
    compression = old_ds.compression
    compression_opts = old_ds.compression_opts
    # 删除旧数据集并重建
    del h5f[old_ds.name]
    new_ds = parent.create_dataset(
        name, data=data, dtype=dtype,
        maxshape=maxshape, chunks=chunks,
        compression=compression, compression_opts=compression_opts,
    )
    for k, v in attrs.items():
        new_ds.attrs[k] = v


def _repair_file_impl(input_path, output_path=None, dry_run=False):
    """修复单个 H5 文件的时间戳"""
    print(f'\n{"=" * 70}')
    print(f'文件: {input_path}')
    print(f'{"=" * 70}')

    if output_path and not dry_run:
        # 复制文件到输出路径
        os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
        shutil.copy2(input_path, output_path)
        target = output_path
    else:
        target = input_path

    all_stats = {}

    if dry_run:
        f = h5py.File(input_path, 'r')
    else:
        f = h5py.File(target, 'r+')

    try:
        for ds_name, cfg in DATASET_CONFIG.items():
            if ds_name not in f:
                continue

            ds = f[ds_name]
            if ds.shape[0] < 2:
                print(f'  {ds_name:<20s} EMPTY (跳过)')
                continue

            time_field = cfg['time_field']
            times = ds[time_field][:]

            # 尝试使用 sd_frame_id 做精确修复
            has_frame_id = 'sd_frame_id' in ds.dtype.names
            if has_frame_id and cfg.get('mono_mode') == 'strict':
                frame_ids = ds['sd_frame_id'][:]
                id_diffs = np.diff(frame_ids.astype(np.int64))
                n_bad = int(np.sum(id_diffs <= 0))
                # A reset/duplicate needs explicit segment evidence; silently
                # falling back to synthetic spacing would conceal data loss.
                sd_sample_rate = cfg.get('sd_id_rate', cfg.get('expected_rate', 2000))
                corrected, stats = repair_with_frame_counter(times, frame_ids, sd_sample_rate)
                tag = '精确' if n_bad == 0 else '精确(u32回绕)'
                method = f'sd_frame_id@{sd_sample_rate}Hz ({tag})'
            else:
                # 无 sd_frame_id，使用单调化
                expected_rate = cfg.get('expected_rate')
                if expected_rate:
                    frame_interval = 1.0 / expected_rate
                else:
                    frame_interval = detect_frame_interval(times)
                    if frame_interval is None:
                        frame_interval = 0.001
                corrected, stats = monotonize_timestamps(times, frame_interval, mode=cfg.get('mono_mode', 'strict'))
                method = f'monotonize ({cfg.get("mono_mode", "strict")})'

            # 验证修正结果
            diffs_fixed = np.diff(corrected)
            n_backward_fixed = int(np.sum(diffs_fixed < 0))
            if not np.all(np.isfinite(corrected)) or (cfg.get('mono_mode') == 'strict' and np.any(diffs_fixed <= 0)):
                raise ValueError(f'{ds_name}: repaired timestamps are not finite and strictly increasing')
            dur_orig = times[-1] - times[0]
            dur_fixed = corrected[-1] - corrected[0]

            expected_rate_str = f'{cfg.get("expected_rate", "?")}Hz' if cfg.get('expected_rate') else 'var'
            print(f'  {ds_name:<20s} {len(times):>8,}帧 @{expected_rate_str:<6s}  '
                  f'回退:{stats["backward"]:>5} | 调整:{stats["adjusted"]:>6,}帧 | '
                  f'原时长:{dur_orig:>7.2f}s → 修复:{dur_fixed:>7.2f}s | '
                  f'方法:{method} | 修复后回退:{n_backward_fixed}')

            all_stats[ds_name] = {
                'backward': stats['backward'],
                'adjusted': stats['adjusted'],
                'duration_orig': dur_orig,
                'duration_fixed': dur_fixed,
            }

            if not dry_run:
                # 写回修正后的时间戳
                # 注意：h5py compound dtype 的字段级写入不生效，
                # 必须用完整数据集替换方式（del + create_dataset）
                _write_time_field(f, ds_name, corrected)

        f.close()

        if not dry_run and output_path is None:
            print(f'\n  [OK] 已原地修复: {target}')
        elif not dry_run:
            print(f'\n  [OK] 已保存修复副本: {target}')

    except Exception as e:
        f.close()
        print(f'\n  [FAIL] 处理失败: {e}')
        import traceback
        traceback.print_exc()
        return False

    return True


class _RepairRollback(Exception):
    pass


def _file_stamp(path):
    """Stable source identity used by distinct-output copy-on-write."""
    stat = os.stat(path)
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)


def _validate_saved_h5(path):
    """Open and traverse a repaired copy before it replaces its destination."""
    with h5py.File(path, 'r') as handle:
        handle.visititems(lambda _name, _obj: None)


def repair_file(input_path, output_path=None, dry_run=False):
    """Repair timestamps with copy-on-write semantics.

    In-place edits use the shared H5 transaction.  A distinct output is first
    repaired in a same-directory temporary copy, validated, fsynced, and then
    atomically replaced.  ``dry_run`` remains strictly read-only.
    """
    if dry_run:
        return _repair_file_impl(input_path, None, dry_run=True)

    input_key = os.path.normcase(os.path.realpath(os.fspath(input_path)))
    output_key = (os.path.normcase(os.path.realpath(os.fspath(output_path)))
                  if output_path else None)
    if output_key is None or output_key == input_key:
        try:
            with h5_transaction(input_path) as staged:
                ok = _repair_file_impl(staged, None, dry_run=False)
                if not ok:
                    raise _RepairRollback()
                return True
        except _RepairRollback:
            return False

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f'.{output.stem}.repair-',
                                      suffix=output.suffix or '.h5',
                                      dir=output.parent)
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        # Hold both logical source and destination locks for the entire
        # copy/repair/validate/replace sequence.  Lock order is stable so
        # two simultaneous cross-output repairs cannot deadlock.
        source_key = os.path.normcase(os.path.realpath(os.fspath(input_path)))
        dest_key = os.path.normcase(os.path.realpath(os.fspath(output)))
        lock_order = [(source_key, input_path), (dest_key, output)]
        lock_order.sort(key=lambda item: item[0])
        with ExitStack() as locks:
            for _, lock_path in lock_order:
                locks.enter_context(exclusive_file(lock_path))
            source_stamp = _file_stamp(input_path)
            with h5py.File(input_path, 'r'):
                shutil.copy2(input_path, temp_path)
            ok = _repair_file_impl(str(temp_path), None, dry_run=False)
            if not ok:
                raise _RepairRollback()
            _validate_saved_h5(temp_path)
            # A cooperating writer must not replace a source that changed
            # after the copy, even though the sidecar lock normally prevents
            # that race.  This also protects against non-cooperating writers.
            if _file_stamp(input_path) != source_stamp:
                raise FileBusyError(
                    f'源文件在另名修复期间发生变化，未替换输出：{input_path}')
            with open(temp_path, 'r+b') as handle:
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, output)
            return True
    except _RepairRollback:
        return False
    finally:
        temp_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(
        description='修复 H5 文件中 EMG/IMU 时间戳回退问题')
    parser.add_argument('files', nargs='+', help='H5 文件路径（支持 glob）')
    parser.add_argument('--outdir', '-o', default=None,
                        help='输出目录（不指定则原地修复）')
    parser.add_argument('--dry-run', '-n', action='store_true',
                        help='只检测不修复')
    args = parser.parse_args()

    all_ok = True
    for fpath in args.files:
        if not os.path.exists(fpath):
            print(f'文件不存在: {fpath}')
            all_ok = False
            continue

        if args.outdir:
            output = os.path.join(args.outdir, os.path.basename(fpath))
        else:
            output = None

        try:
            ok = repair_file(fpath, output, dry_run=args.dry_run)
            if not ok:
                all_ok = False
        except Exception as e:
            print(f'处理失败: {fpath}: {e}')
            all_ok = False

    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
