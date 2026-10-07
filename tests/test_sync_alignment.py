"""Synthetic on-disk regression tests; all temporary files stay in the workspace."""
import contextlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import h5py
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import bin_sync_tool as sync
import repair_timestamps as repair


class AlignmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sync-test-', dir=ROOT)
        self.directory = Path(self.temp.name)
        self.log_patch = patch.object(sync, 'log', lambda *_: None)
        self.log_patch.start()

    def tearDown(self):
        self.log_patch.stop()
        self.assertEqual(self.directory.resolve().parent, ROOT.resolve())
        self.temp.cleanup()

    def header(self, magic, rate, version=1, bits=24):
        if version == 1:
            content = struct.pack('<IHBBB32s', magic, rate, 0, bits, 1, b'synthetic')
        else:
            content = struct.pack('<IBHBBB32s', magic, 2, rate, 0, bits, 1, b'synthetic')
        return content.ljust(sync.HEADER_SIZE, b'\0')

    def emg_bin(self, name='emg.bin', ids=range(600), version=1, salt=0, footer=False, bits=24):
        path = self.directory / name
        rows = {}
        with path.open('wb') as handle:
            handle.write(self.header(sync.EMG_MAGIC, 2000, version, bits))
            for fid in ids:
                # Distinct signed 16-channel rows, including distinct source segments.
                row = [((int(fid) * 17 + c * 101 + salt) % 24001) - 12000 for c in range(16)]
                rows[int(fid)] = row
                handle.write(struct.pack('<I', int(fid)))
                handle.write(b''.join(v.to_bytes(3 if bits == 24 else 2, 'big', signed=True) for v in row))
            if footer:
                handle.write(struct.pack('>I', sync.EMG_MAGIC) + bytes(32))
        return path, rows

    def imu_bin(self, count, version=1, ids=range(30), footer=True):
        path = self.directory / f'imu-{count}-{version}.bin'
        with path.open('wb') as handle:
            handle.write(self.header(sync.IMU_MAGIC, 100, version))
            for fid in ids:
                handle.write(struct.pack('<I', int(fid)))
                for k in range(count):
                    value = fid % 1000
                    values = (100 + value + k, 200 + value, 1000 + value,
                              50 + value, 60 + value, 70 + value, 1, 2, 3)
                    handle.write(struct.pack('<9h', *values))
            if footer:
                handle.write(struct.pack('>I', sync.IMU_MAGIC) + bytes(32))
        return path

    def h5(self, rows, source_anchors, offset=0, map_name='physical', name='test.h5', prompt=None, end=None):
        path = self.directory / name
        dtype = np.dtype([('channels', '<i4', (16,)), ('sd_frame_id', '<u4'), ('time', '<f8')])
        data = np.zeros(len(source_anchors), dtype=dtype)
        cm = sync.CHANNEL_MAPS_BY_NAME[map_name]
        for i, fid in enumerate(source_anchors):
            data[i]['channels'] = sync.map_physical_to_h5_order(rows[fid], cm)
            data[i]['sd_frame_id'] = fid - offset
            data[i]['time'] = 1000.0 + (fid - offset) / 2000.0
        with h5py.File(path, 'w') as handle:
            ds = handle.create_dataset('emg1_250hz_adc', data=data)
            ds.attrs['channel_map_name'] = map_name
            if prompt is not None:
                handle.create_group('prompts').create_dataset('times', data=[prompt])
            if end is not None:
                handle.attrs['end_time'] = end
        return path

    def assert_source(self, path, rows, expected_ids, map_name='physical'):
        with h5py.File(path, 'r') as handle:
            ds = handle['emg1_2khz_adc']
            data = ds[:]
            offset = int(ds.attrs['sync_bin_align_offset'])
            source_ids = data['sd_frame_id'].astype(np.int64) + offset
            np.testing.assert_array_equal(source_ids, expected_ids)
            cm = sync.CHANNEL_MAPS_BY_NAME[map_name]
            for sample, source_id in zip(data, source_ids):
                np.testing.assert_array_equal(sample['channels'], sync.map_physical_to_h5_order(rows[int(source_id)], cm))
            self.assertTrue(np.all(np.diff(data['time']) > 0))
            np.testing.assert_allclose(np.diff(data['time']), np.diff(source_ids) / 2000., atol=1e-10)
            return dict(ds.attrs)

    def test_normal_matrix_nonzero_base_gaps_versions_maps_imus(self):
        for version, imu_count, base, map_name in [(1, 1, 0, 'V1'), (2, 2, 1000, 'V2'), (2, 3, 2000, 'physical')]:
            with self.subTest(version=version, imu_count=imu_count):
                ids = [base + i for i in range(480) if i not in (12, 100)]
                bp, rows = self.emg_bin(f'emg-{version}-{imu_count}.bin', ids, version, footer=True)
                anchors = [base + i for i in range(7, 480, 8) if i != 15]
                hp = self.h5(rows, anchors, offset=base, map_name=map_name, name=f'normal-{imu_count}.h5')
                ip = self.imu_bin(imu_count, version)
                result = sync.sync_h5_one_to_one(str(hp), str(bp), str(ip), manual_num_imus=imu_count)
                self.assertEqual(result['status'], 'success')
                attrs = self.assert_source(hp, rows, ids, map_name)
                self.assertEqual(attrs['missing_frames'], 2)
                self.assertEqual(attrs['sync_2khz_grid_omitted_frames'], 7)
                with h5py.File(hp, 'r') as handle:
                    for label in 'abc'[:imu_count]:
                        ds = handle[f'imu1{label}_100hz']
                        self.assertEqual(len(ds), 24)
                        np.testing.assert_array_equal(ds['sd_frame_id'], np.arange(24))
                repeat = sync.sync_h5_one_to_one(str(hp), str(bp), str(ip), manual_num_imus=imu_count)
                self.assertEqual(repeat['status'], 'skipped')

    def test_adc_row_scan_preserves_phase_and_ble_gaps(self):
        bp, rows = self.emg_bin(ids=[i for i in range(1000, 2000) if i not in (1115, 1151)])
        anchors = [i for i in range(1110, 1510, 8) if i != 1118]
        hp = self.h5(rows, anchors, offset=1103)
        result = sync.sync_h5_one_to_many_adc_search(str(hp), str(bp), channel_map_name='physical')
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['offset'], 1103)
        attrs = self.assert_source(hp, rows, [i for i in range(1103, 1503) if i not in (1115, 1151)])
        self.assertEqual(attrs['missing_frames'], 2)

    def test_adc_anchor_votes_has_same_group_start_contract(self):
        bp, rows = self.emg_bin(ids=range(1000))
        hp = self.h5(rows, list(range(110, 510, 8)), offset=103)
        # Force the existing anchor-vote tier while retaining its real search.
        with patch.object(sync, '_scan_bin_for_h5_rows', return_value={'found': False, 'matched_rows': 0, 'match_rate': 0.0}):
            result = sync.sync_h5_one_to_many_adc_search(str(hp), str(bp), channel_map_name='physical')
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['offset'], 103)
        self.assert_source(hp, rows, list(range(103, 503)))

    def test_adc_exact_sized_bin_allows_zero_offset(self):
        bp, rows = self.emg_bin(ids=range(160))
        hp = self.h5(rows, list(range(7, 160, 8)))
        result = sync.sync_h5_one_to_many_adc_search(str(hp), str(bp), channel_map_name='physical')
        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['offset'], 0)
        self.assert_source(hp, rows, list(range(160)))

    def test_rescue_single_preserves_real_matches_and_gap(self):
        bp, rows = self.emg_bin(ids=[i for i in range(1000, 1480) if i != 1012])
        hp = self.h5(rows, [i for i in range(1007, 1480, 8) if i != 1015], offset=1000)
        result = sync.sync_h5_one_to_one_multibin_rescue(str(hp), [str(bp)], channel_map_name='physical')
        self.assertEqual(result['status'], 'success')
        self.assert_source(hp, rows, [i for i in range(1000, 1480) if i != 1012])

    def test_multibin_rescue_provenance_roundtrip(self):
        p1, rows1 = self.emg_bin('first.bin', [i for i in range(480) if i != 12])
        p2, rows2 = self.emg_bin('second.bin', range(480), salt=11000)
        combined = dict(rows1)
        combined.update({480 + fid: row for fid, row in rows2.items()})
        hp = self.h5(combined, [i for i in range(7, 960, 8) if i != 15])
        result = sync.sync_h5_one_to_one_multibin_rescue(str(hp), [str(p1), str(p2)], channel_map_name='physical')
        self.assertEqual(result['status'], 'success')
        sources = {'first.bin': rows1, 'second.bin': rows2}
        with h5py.File(hp, 'r') as handle:
            ds = handle['emg1_2khz_adc']
            self.assertNotIn('sync_bin_align_offset', ds.attrs)
            self.assertEqual(ds.attrs['sync_bin_align_offset_scope'], 'per_segment')
            meta = json.loads(ds.attrs['sync_source_segments'])
            data = ds[:]
            self.assertEqual(len(data), 959)
            self.assertEqual(ds.attrs['missing_frames'], 1)
            np.testing.assert_allclose(np.diff(data['time']), np.diff(data['sd_frame_id']) / 2000., atol=1e-10)
            for sample in data:
                matches = [m for m in meta if m['output_start_sd'] <= sample['sd_frame_id'] <= m['output_end_sd']]
                self.assertEqual(len(matches), 1)
                source = matches[0]
                raw_id = int(sample['sd_frame_id']) + source['source_offset']
                np.testing.assert_array_equal(sample['channels'], sources[source['bin']][raw_id])

    def test_prompt_extension_is_bounded_and_never_fills_absent_frames(self):
        for mode in ('normal', 'adc', 'rescue'):
            with self.subTest(mode=mode):
                bp, rows = self.emg_bin(ids=[i for i in range(3000) if i not in (510, 520)])
                hp = self.h5(rows, list(range(7, 480, 8)), name=f'extend-{mode}.h5', prompt=1000.28, end=1000.275)
                if mode == 'normal':
                    result = sync.sync_h5_one_to_one(str(hp), str(bp))
                elif mode == 'adc':
                    result = sync.sync_h5_one_to_many_adc_search(str(hp), str(bp), channel_map_name='physical')
                else:
                    result = sync.sync_h5_one_to_one_multibin_rescue(str(hp), [str(bp)], channel_map_name='physical')
                self.assertEqual(result['status'], 'success')
                expected_ids = ([i for i in range(3000) if i not in (510, 520)]
                                if mode in ('normal', 'rescue')
                                else [i for i in range(551) if i not in (510, 520)])
                attrs = self.assert_source(hp, rows, expected_ids)
                self.assertEqual(attrs['missing_frames'], 2)

    def test_enumerator_handles_huge_sparse_span_without_dense_allocation(self):
        parser = types.SimpleNamespace(frames={0: [1]*16, 1000000000: [2]*16}, fid0=0)
        data, diag = sync._enumerate_2khz_from_bin(parser, None, np.array([7, 1000000000]), 0, .0005, 0., 7)
        self.assertEqual(len(data), 2)
        self.assertEqual(diag['bin_gap_frames'], 999999999)

    def test_bin_parsers_fail_closed_on_duplicate_reset_and_wrap(self):
        for ids, kind in [([1, 1], 'duplicate'), ([200000, 0], 'reset_or_reorder'), ([2**32-1, 0], 'wrap')]:
            with self.subTest(kind=kind):
                bp, _ = self.emg_bin(ids=ids)
                with self.assertRaisesRegex(ValueError, kind + '.*row 1, byte'):
                    sync.EMGBinParser(str(bp)).parse()
                ip = self.imu_bin(1, ids=ids)
                with self.assertRaisesRegex(ValueError, kind + '.*row 1, byte'):
                    sync.IMUBinParser(str(ip), 1).parse()

    def test_bin_truncation_and_16bit_footer(self):
        bp, rows = self.emg_bin(ids=range(10), bits=16, footer=True)
        self.assertEqual(sync.EMGBinParser(str(bp)).parse().frames, rows)
        with bp.open('ab') as handle:
            handle.write(b'broken')
        with self.assertRaisesRegex(ValueError, 'truncated'):
            sync.EMGBinParser(str(bp)).parse()

    def test_timestamp_wrap_and_ambiguous_counters(self):
        result, _ = repair.repair_with_frame_counter(np.array([1000., 1000., 1000.]), np.array([2**32-2, 2**32-1, 0], dtype=np.uint32), 2000.)
        np.testing.assert_allclose(np.diff(result), [.0005, .0005], atol=1e-10)
        for ids in ([0, 0, 1], [200000, 0, 1], [1, 3, 2]):
            with self.assertRaises(ValueError):
                repair.repair_with_frame_counter(np.arange(3, dtype=float), np.array(ids, dtype=np.uint32), 2000.)

    def test_repair_file_rejects_duplicate_without_writing(self):
        _, rows = self.emg_bin()
        hp = self.h5(rows, [7, 15, 23])
        with h5py.File(hp, 'r+') as handle:
            original = handle['emg1_250hz_adc'][:]
            original['sd_frame_id'][1] = original['sd_frame_id'][0]
            handle['emg1_250hz_adc'][:] = original
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(repair.repair_file(str(hp)))
        with h5py.File(hp, 'r') as handle:
            np.testing.assert_array_equal(handle['emg1_250hz_adc'][:], original)


if __name__ == '__main__':
    unittest.main()
