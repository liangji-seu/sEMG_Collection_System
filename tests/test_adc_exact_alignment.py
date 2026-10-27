"""Tests for strict, independently verified ADC alignment decisions."""
import unittest
from unittest.mock import patch
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
import bin_sync_tool as sync


class FakeParser:
    def __init__(self, frames, fid0):
        self.frames = frames
        self.fid0 = fid0


def make_signals(total_rows=1600, seed=17, kind='random', period=256):
    rng = np.random.default_rng(seed)
    fid0 = 1000
    frame_count = total_rows * 8 + 1024
    if kind == 'random':
        raw = rng.integers(-200000, 200000, size=(frame_count, 16), dtype=np.int32)
    elif kind == 'walk':
        steps = rng.integers(-4000, 4001, size=(frame_count, 16), dtype=np.int32)
        raw = np.cumsum(steps, axis=0, dtype=np.int64).astype(np.int32)
    elif kind == 'periodic':
        motif = rng.integers(-200000, 200000, size=(period, 16), dtype=np.int32)
        raw = np.resize(motif, (frame_count, 16))
    elif kind == 'constant':
        raw = np.full((frame_count, 16), 1234, dtype=np.int32)
    else:
        raise ValueError(kind)
    frames = {fid0 + i: row for i, row in enumerate(raw)}
    parser = FakeParser(frames, fid0)
    anchors = np.arange(total_rows, dtype=np.int64) * 8
    boxcar = raw[:total_rows * 8].reshape(total_rows, 8, 16).mean(axis=1)
    pick = raw[anchors]
    return parser, anchors, boxcar, pick


class ExactAlignmentDecisionTests(unittest.TestCase):
    def search(self, parser, anchors, channels, **kwargs):
        config = {
            'align_search_sample_count': 256,
            'align_search_range': 512,
            'align_search_coarse_step': 8,
            'align_corr_threshold': 0.90,
            'align_corr_min_prominence': 0.30,
            'align_exact_frac': 0.99,
            'align_highpass_hz': 20.0,
        }
        with patch.dict(sync.VALIDATION_CONFIG, config):
            return sync._search_bin_offset_by_correlation(
                parser, channels, anchors, None, anchor_position=0, **kwargs)

    def test_boxcar_exact_passes_when_prominence_is_low(self):
        parser, anchors, boxcar, _ = make_signals(kind='walk')
        actual_model_fit = sync._model_fit

        def force_low_prominence(series, present, h5_win, fs, highpass_hz):
            corr, exact, checked = actual_model_fit(series, present, h5_win, fs, highpass_hz)
            if exact >= .99:
                return 1.0, exact, checked
            return .75, exact, checked

        with patch.object(sync, '_model_fit', side_effect=force_low_prominence):
            result = self.search(parser, anchors, boxcar)
        self.assertTrue(result['passed'], result['report_lines'])
        self.assertEqual(result['model'], 'boxcar')
        self.assertEqual(result['bin_base'], parser.fid0)
        self.assertGreaterEqual(result['exact_frac'], .99)
        self.assertLess(result['prominence'], .30)
        validation = result['independent_exact_validation']
        self.assertTrue(validation['passed'])
        self.assertGreaterEqual(validation['coverage'], .95)
        self.assertGreaterEqual(validation['row_match_rate'], .99)

    def test_short_boxcar_keeps_legacy_pass_without_independent_probes(self):
        parser, anchors, boxcar, _ = make_signals(total_rows=256, kind='random')
        result = self.search(parser, anchors, boxcar, sample_count=800)
        self.assertTrue(result['passed'], result['report_lines'])
        self.assertEqual(result['independent_exact_validation']['selected'], 0)
        self.assertTrue(any('legacy corr/prominence' in line for line in result['report_lines']))

    def test_other_bin_and_high_correlation_without_exact_rows_do_not_use_exact_pass(self):
        source, anchors, _, _ = make_signals(seed=19, kind='walk')
        _, _, other_boxcar, _ = make_signals(seed=23, kind='walk')
        result = self.search(source, anchors, other_boxcar)
        self.assertFalse(result['passed'])
        self.assertIsNone(result['independent_exact_validation'])
        self.assertLess(result['exact_frac'], .99)

        # Even an unrelated recording with a high correlation plateau cannot
        # pass on correlation alone when exact identity and prominence fail.
        with patch.object(sync, '_pearson_columns',
                          return_value=np.full(16, .95, dtype=np.float64)):
            result = self.search(source, anchors, other_boxcar)
        self.assertFalse(result['passed'])
        self.assertGreaterEqual(result['best_corr'], .90)
        self.assertLess(result['prominence'], .30)
        self.assertLess(result['exact_frac'], .99)

    def test_constant_signal_cannot_be_certified_by_exact_match(self):
        parser, anchors, boxcar, _ = make_signals(kind='constant')
        result = self.search(parser, anchors, boxcar)
        self.assertFalse(result['passed'])
        self.assertTrue(result['ambiguous_candidates'])

    def test_periodic_repeated_exact_offsets_are_rejected_as_ambiguous(self):
        parser, anchors, boxcar, _ = make_signals(kind='periodic', period=256)
        result = self.search(parser, anchors, boxcar)
        self.assertFalse(result['passed'])
        self.assertTrue(result['ambiguous_candidates'])
        self.assertTrue(any('歧义' in line for line in result['report_lines']))

    def test_legacy_pick_and_prominence_path_remain_available(self):
        parser, anchors, _, pick = make_signals(kind='random')
        result = self.search(parser, anchors, pick)
        self.assertTrue(result['passed'], result['report_lines'])
        self.assertEqual(result['model'], 'pick')

        # Preserve the old corr + prominence path for a correlated value-scale
        # variant that does not satisfy the exact row predicate.
        approximate = pick.astype(np.float64) + 100.0

        def approximate_fit(series, present, h5_win, fs, highpass_hz):
            checked = int(np.count_nonzero(present))
            if checked and np.all(np.abs((series[present] - h5_win[present]) + 100.0) <= 1.0):
                return 1.0, 0.0, checked
            return .40, 0.0, checked

        with patch.object(sync, '_model_fit', side_effect=approximate_fit):
            result = self.search(parser, anchors, approximate)
        self.assertTrue(result['passed'], result['report_lines'])
        self.assertEqual(result['tier'], 'corr')
        self.assertGreaterEqual(result['prominence'], .30)


if __name__ == '__main__':
    unittest.main()
