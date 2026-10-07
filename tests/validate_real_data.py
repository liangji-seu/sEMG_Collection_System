"""Run explicitly selected local-data checks on prepared copies, never sources.

Usage: python tests/validate_real_data.py tmp/system-validation/manifest.json CASE
The manifest records source SHA256 before copying and paths to the working H5s.
"""
import argparse
import contextlib
import gc
import hashlib
import json
from pathlib import Path
import sys
import time
import traceback

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import bin_sync_tool as sync


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_sources(item):
    for source in [item['source']] + item['bins']:
        path = Path(source['path'])
        assert path.stat().st_mtime_ns == source['mtime_ns'], f'Source time changed: {path}'
        assert sha256(path) == source['sha256'], f'Source content changed: {path}'


def run(item):
    work = Path(item['copy']).resolve()
    assert work.is_relative_to(ROOT / 'tmp/system-validation'), 'Working copy outside test directory'
    assert work != Path(item['source']['path']).resolve()
    verify_sources(item)
    started = time.perf_counter()
    report = {'case': item['case'], 'devices': []}
    sync.clear_sync_outputs(str(work), backup=False)
    for device in (1, 2):
        emg, imu = [source['path'] for source in item['bins'][(device-1)*2:device*2]]
        result = sync.sync_h5_one_to_one(str(work), emg, imu, device_id=device,
                                         verify=True, set_synced=False)
        entry = {'device': device, 'result': result}
        report['devices'].append(entry)
        if result.get('status') not in ('synced', 'success'):
            raise RuntimeError(f'Device {device}: {result}')
        parser = sync.EMGBinParser(emg).parse()
        with h5py.File(work, 'r') as file:
            ds = file[f'emg{device}_2khz_adc']
            # Fixed mapping from source attributes, rather than the mapping chosen by the output.
            mapping, name = sync._resolve_channel_map(file, f'emg{device}_250hz_adc', 'V2')
            offset = int(ds.attrs['sync_bin_align_offset'])
            previous_time = previous_id = None
            checked = 0
            for start in range(0, len(ds), 20000):
                rows = ds[start:start+20000]
                ids = rows['sd_frame_id'].astype(np.int64) + offset
                expected = np.asarray([sync.map_physical_to_h5_order(parser.frames[int(fid)], mapping)
                                       for fid in ids], dtype=np.int32)
                np.testing.assert_array_equal(rows['channels'], expected)
                assert np.all(np.isfinite(rows['time']))
                assert np.all(np.diff(rows['time']) > 0), 'Non-monotone output time'
                assert np.all(np.diff(ids) > 0), 'Non-monotone source IDs'
                if len(rows):
                    if previous_time is not None:
                        assert rows['time'][0] > previous_time and ids[0] > previous_id
                    previous_time, previous_id = rows['time'][-1], ids[-1]
                checked += len(rows)
            entry.update(rows=checked, mapping=name, offset=offset,
                         imu_rows={key:len(file[key]) for key in file
                                   if key.startswith(f'imu{device}') and key.endswith('_100hz')})
        del parser
        gc.collect()
    verify_sources(item)
    report.update(seconds=round(time.perf_counter()-started, 3), source_unchanged=True, success=True)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest', type=Path)
    parser.add_argument('case')
    args = parser.parse_args()
    items = json.loads(args.manifest.read_text(encoding='utf-8'))
    item = next(value for value in items if value['case'] == args.case)
    log = args.manifest.parent / (args.case + '.log')
    report = {'case': args.case, 'success': False}
    with log.open('w', encoding='utf-8') as handle, contextlib.redirect_stdout(handle):
        try:
            report = run(item)
        except Exception:
            report['error'] = traceback.format_exc()
            print(report['error'])
    (args.manifest.parent / (args.case + '.result.json')).write_text(
        json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=True, default=str))
    sys.exit(0 if report.get('success') else 1)
