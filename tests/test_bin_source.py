import os
import struct
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
import bin_sync_tool as bst


def _make_emg_bin(path, bit_depth=24, ids=(7, 8), proto=None, footer_endian='>'):
    header = bytearray(bst.HEADER_SIZE)
    if proto is None:
        struct.pack_into('<I H B B B 32s', header, 0,
                         bst.EMG_MAGIC, 2000, 4, bit_depth, 0, b'v1')
    else:
        struct.pack_into('<I B H B B B 32s', header, 0,
                         bst.EMG_MAGIC, proto, 2000, 4, bit_depth, 0, b'v2')
    payload = bytearray()
    samples = [-8388608, -1, 0, 1, 8388607] if bit_depth == 24 else [-32768, -1, 0, 1, 32767]
    for row, frame_id in enumerate(ids):
        payload.extend(struct.pack('<I', int(frame_id)))
        value = samples[row % len(samples)]
        for channel in range(16):
            if bit_depth == 24:
                raw = value & 0xFFFFFF
                payload.extend(raw.to_bytes(3, 'big'))
            else:
                payload.extend(struct.pack('>h', value))
    footer = struct.pack(f'{footer_endian}I', bst.EMG_MAGIC) + b'footer'.ljust(bst.FOOTER_SIZE - 4, b'\x00')
    with open(path, 'wb') as stream:
        stream.write(header)
        stream.write(payload)
        stream.write(footer)


class BinSourceTests(unittest.TestCase):
    def test_million_frame_scalar_lookup_has_bounded_temporary_memory(self):
        import tracemalloc
        ids = np.arange(1_000_000, dtype=np.uint32)
        frames = bst._CompactFrameMapping(ids, np.zeros((len(ids), 16), dtype=np.int32))
        tracemalloc.start()
        try:
            for key in range(10):
                self.assertIn(key, frames)
                self.assertEqual(frames[key].shape, (16,))
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 256 * 1024, 'A scalar lookup must not copy the entire ID array')
        self.assertNotIn(-1, frames)
        self.assertNotIn(2 ** 65, frames)
        wide = bst._CompactFrameMapping(np.array([2**32 + 7], dtype=np.int64), np.zeros((1,16), dtype=np.int32))
        self.assertIn(2**32 + 7, wide)
        self.assertEqual(wide.ids_array.dtype, np.dtype('uint64'))

    def test_compact_mapping_24bit_extremes_footer_versions_and_sparse_ids(self):
        path = os.path.join(os.path.dirname(__file__), '._bin_source_24.bin')
        try:
            _make_emg_bin(path, ids=(7, 1_000_000_007, 1_000_000_008), proto=2)
            parser = bst.EMGBinParser(path).parse()
            self.assertEqual(parser.frames.ids_array.dtype, np.dtype('uint32'))
            self.assertEqual(parser.frames.channels_array.dtype, np.dtype('int32'))
            self.assertEqual(parser.frames[7][0], -8388608)
            self.assertEqual(parser.frames[1_000_000_007][0], -1)
            self.assertEqual(parser.frames[1_000_000_008][0], 0)
            self.assertNotIn(1_000_000_006, parser.frames)
            self.assertEqual(list(parser.frames.keys()), [7, 1_000_000_007, 1_000_000_008])
            self.assertEqual(len(list(parser.frames.items())), 3)
            self.assertEqual(len(list(parser.frames.values())), 3)
            self.assertEqual(len(parser.frames), 3)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    def test_16bit_big_endian_sign_extension_and_little_footer(self):
        path = os.path.join(os.path.dirname(__file__), '._bin_source_16.bin')
        try:
            _make_emg_bin(path, bit_depth=16, ids=(0, 1, 2, 3, 4), footer_endian='<')
            parser = bst.EMGBinParser(path).parse()
            values = [int(parser.frames[idx][0]) for idx in range(5)]
            self.assertEqual(values, [-32768, -1, 0, 1, 32767])
        finally:
            try:
                os.remove(path)
            except OSError:
                pass

    def test_duplicate_reset_and_wrap_are_explicitly_rejected(self):
        for ids, expected in [((1, 1), 'duplicate'), ((9, 2), 'reset_or_reorder'),
                              ((2**32 - 2, 1), 'wrap')]:
            path = os.path.join(os.path.dirname(__file__), '._bin_source_bad.bin')
            try:
                _make_emg_bin(path, ids=ids)
                with self.assertRaisesRegex(ValueError, expected):
                    bst.EMGBinParser(path).parse()
            finally:
                try:
                    os.remove(path)
                except OSError:
                    pass


if __name__ == '__main__':
    unittest.main()
