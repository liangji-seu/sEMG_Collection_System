"""
sEMG 数据统计查看器

树状浏览采集数据，bin/视频文件挂在对应 H5 下，
显示每个文件的同步状态（已同步/待同步/失败）。

目录结构要求：
  数据根目录/          ← 如 D:\0710\
    ├── 手环数据/
    │   └── L001/      ← 受试者目录 (大小写不敏感)
    │       ├── L001_L_260709_090604_emg.bin
    │       └── ...
    └── 电脑数据/
        └── L001/
            ├── L001-C1/
            │   ├── video/   ← 视频
            │   └── 离散手势采集/.../  ← H5
            └── ...
"""

import sys, os, re, json
from datetime import datetime
from pathlib import Path
from collections import defaultdict
from typing import List, Dict, Optional, Tuple, Any

# h5py is optional — for reading H5 sync status
try:
    import h5py
    HAS_H5PY = True
except ImportError:
    HAS_H5PY = False

from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QTreeWidget, QTreeWidgetItem, QSplitter, QLabel, QPushButton,
    QFileDialog, QHeaderView, QMessageBox, QLineEdit, QStatusBar,
    QMenu, QFrame, QTextEdit,
)
from PyQt5.QtCore import Qt, QThread, pyqtSignal, QSettings
from PyQt5.QtGui import QColor

# ── Constants ──────────────────────────────────────────────────────────────

VIDEO_EXTS = {'.mp4', '.avi', '.mov', '.mkv', '.wmv'}
H5_EXTS    = {'.h5', '.hdf5'}
BIN_EXTS   = {'.bin'}

EXPECTED_H5_PER_CONFIG = 6

# Status color legend
STATUS_SYNCED   = 'synced'      # 🟢 green
STATUS_PENDING  = 'pending'     # 🟡 amber
STATUS_FAILED   = 'sync_failed' # 🔴 red
STATUS_UNVERIFIED = 'unverified' # ⚪ legacy or incomplete aggregate metadata
STATUS_NONE     = 'none'        # ⚪ grey (no H5 metadata / unknown)

LEGEND_HTML = """
<style>
  .legend { font-size:12px; border-spacing:4px; }
  .legend td { padding:2px 8px; white-space:nowrap; }
</style>
<table class="legend">
<tr><td><span style="color:#16a34a;font-size:16px;">●</span> 已同步</td>
    <td><span style="color:#f97316;font-size:16px;">●</span> 待同步</td>
    <td><span style="color:#ef4444;font-size:16px;">●</span> 同步失败</td>
    <td><span style="color:#9ca3af;font-size:16px;">●</span> 未知</td></tr>
<tr><td><span style="color:#3b82f6;font-size:16px;">●</span> 异常中断</td>
    <td><span style="color:#8b5cf6;font-size:16px;">●</span> 已压缩(离线)</td>
    <td colspan="2"></td></tr>
</table>
"""

# ── H5 Metadata Reader ─────────────────────────────────────────────────────

def read_h5_status(h5_path: str) -> dict:
    """Read sync/collection/compression status from an H5 file."""
    result = {
        'sync_status':       STATUS_NONE,
        'collection_status': '',
        'is_resumed':        False,
        'segment_index':     None,
        'template_name':     '',
        'compressed':        False,
        'compression_info':  '',
        'bin_refs':          [],
        'video_refs':        [],
        'video_compressed':  False,
        'sync_aggregate_status': '',
        'sync_required_devices': [],
        'sync_device_results': [],
        'sync_traceability': False,
    }
    if not HAS_H5PY or not os.path.isfile(h5_path):
        return result

    try:
        with h5py.File(h5_path, 'r') as f:
            attrs = dict(f.attrs)

            sync = attrs.get('sync_status', '')
            if isinstance(sync, bytes):
                sync = sync.decode('utf-8', errors='replace')
            result['sync_status'] = sync if sync else STATUS_NONE

            col = attrs.get('collection_status', '')
            if isinstance(col, bytes):
                col = col.decode('utf-8', errors='replace')
            result['collection_status'] = col

            result['is_resumed'] = bool(attrs.get('is_resumed', False))
            result['segment_index'] = attrs.get('segment_index', None)

            tmpl = attrs.get('template_name', '')
            if isinstance(tmpl, bytes):
                tmpl = tmpl.decode('utf-8', errors='replace')
            result['template_name'] = tmpl

            result['bin_refs'] = _extract_bin_refs_from_attrs(attrs)
            result['video_refs'] = _extract_video_refs_from_attrs(attrs)
            video_compression = _attr_to_str(attrs.get('video_compression', '')).lower()
            result['video_compressed'] = (
                video_compression in ('h264_mp4', 'mp4', 'h264')
                or any(ref.lower().endswith('.mp4') for ref in result['video_refs'])
            )

            aggregate = _attr_to_str(attrs.get('sync_aggregate_status', '')).lower()
            result['sync_aggregate_status'] = aggregate
            required_raw = _attr_to_str(attrs.get('sync_required_devices', ''))
            details_raw = _attr_to_str(attrs.get('sync_device_results', ''))
            try:
                result['sync_required_devices'] = [int(v) for v in json.loads(required_raw)] if required_raw else []
            except (TypeError, ValueError, json.JSONDecodeError):
                result['sync_required_devices'] = []
            try:
                result['sync_device_results'] = json.loads(details_raw) if details_raw else []
            except (TypeError, ValueError, json.JSONDecodeError):
                result['sync_device_results'] = []

            try:
                from .bin_sync_tool import sync_status_summary
            except ImportError:
                from bin_sync_tool import sync_status_summary
            summary = sync_status_summary(f)
            result['sync_required_devices'] = summary['required_devices']
            result['sync_traceability'] = summary['verified']
            result['sync_status'] = summary['status']

            # Detect compression: check if datasets use compression filters
            compressed_count = 0
            total_datasets = 0
            compression_types = set()

            def _check_ds(name, obj):
                nonlocal compressed_count, total_datasets
                if isinstance(obj, h5py.Dataset):
                    total_datasets += 1
                    if obj.compression:
                        compressed_count += 1
                        compression_types.add(obj.compression)

            f.visititems(_check_ds)

            if total_datasets > 0 and compressed_count > 0:
                # Consider "compressed" if >= 50% datasets are compressed
                if compressed_count >= total_datasets * 0.5:
                    result['compressed'] = True
                    result['compression_info'] = ','.join(sorted(compression_types))

            # Also check if external compressed file exists alongside
            for ext in ['.gz', '.bz2', '.xz', '.zip']:
                if os.path.isfile(h5_path + ext):
                    result['compressed'] = True
                    result['compression_info'] = ext

    except Exception:
        pass

    return result


def _attr_to_str(value: Any) -> str:
    if value is None:
        return ''
    if isinstance(value, bytes):
        return value.decode('utf-8', errors='replace')
    return str(value)


def _clean_file_ref(value: Any) -> str:
    ref = _attr_to_str(value).strip()
    if not ref or ref.lower() in ('none', 'null', '-'):
        return ''
    return os.path.basename(ref.replace('\\', '/'))


def _unique_names(items: List[str]) -> List[str]:
    seen = set()
    result = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def _bin_names_from_ref(ref: str) -> List[str]:
    """H5 stores sd_bin_dev* as either a prefix or an EMG/IMU filename."""
    if not ref:
        return []
    lower = ref.lower()
    if lower.endswith('_emg.bin'):
        return [ref, re.sub(r'_emg\.bin$', '_imu.bin', ref, flags=re.IGNORECASE)]
    if lower.endswith('_imu.bin'):
        return [re.sub(r'_imu\.bin$', '_emg.bin', ref, flags=re.IGNORECASE), ref]
    if lower.endswith('.bin'):
        return [ref]
    return [f'{ref}_emg.bin', f'{ref}_imu.bin']


def _extract_bin_refs_from_attrs(attrs: dict) -> List[str]:
    refs = []
    for key in ('sd_bin_dev1', 'sd_bin_dev2', 'sd_imu_bin_dev1', 'sd_imu_bin_dev2'):
        ref = _clean_file_ref(attrs.get(key))
        refs.extend(_bin_names_from_ref(ref))
    return _unique_names(refs)


def _extract_video_refs_from_attrs(attrs: dict) -> List[str]:
    refs = []
    for key in ('video_left', 'video_right'):
        ref = _clean_file_ref(attrs.get(key))
        if ref:
            refs.append(ref)
    return _unique_names(refs)


def status_color(status: str) -> QColor:
    """Map status string to QColor."""
    return {
        STATUS_SYNCED:  QColor('#16a34a'),  # green
        'partial': QColor('#f97316'),
        STATUS_UNVERIFIED: QColor('#9ca3af'),  # gray
        STATUS_PENDING: QColor('#f97316'),  # amber
        STATUS_FAILED:  QColor('#ef4444'),  # red
        'abnormal_interrupted': QColor('#3b82f6'),  # blue
        'compressed':   QColor('#8b5cf6'),  # purple
    }.get(status, QColor('#9ca3af'))  # grey default


def status_icon(status: str) -> str:
    """Map status string to icon character."""
    m = {
        STATUS_SYNCED:  '🟢',
        'partial': '🟠',
        STATUS_UNVERIFIED: '⚪',
        STATUS_PENDING: '🟠',
        STATUS_FAILED:  '🔴',
        'abnormal_interrupted': '🔵',
        'compressed':   '🟣',
    }
    return m.get(status, '⚪')


def status_text(status: str) -> str:
    """Map status string to Chinese label."""
    return {
        STATUS_SYNCED:  '已同步',
        'partial': '部分设备完成',
        STATUS_UNVERIFIED: '待核验',
        STATUS_PENDING: '待同步',
        STATUS_FAILED:  '同步失败',
        'abnormal_interrupted': '异常中断',
        'compressed':   '已压缩',
        STATUS_NONE:    '未知',
    }.get(status, status)


# ── Timestamp Helpers ──────────────────────────────────────────────────────

def extract_timestamp_h5(filename: str) -> Optional[str]:
    """Extract YYYYMMDD_HHMMSS from H5 filename."""
    m = re.search(r'(\d{8})_(\d{6})', filename)
    return f"{m.group(1)}_{m.group(2)}" if m else None


def extract_timestamp_bin_video(filename: str) -> Optional[str]:
    """Extract YYMMDD_HHMMSS from bin/video filename. Convert to YYYYMMDD."""
    # Pattern: _YYMMDD_HHMMSS_ or .YYMMDD_HHMMSS.
    m = re.search(r'(\d{6})_(\d{6})', filename)
    if m:
        yymmdd = m.group(1)
        hhmmss = m.group(2)
        # Convert YYMMDD to YYYYMMDD (assume 20xx)
        return f"20{yymmdd}_{hhmmss}"
    return None


def extract_session_number(filename: str) -> Optional[int]:
    """Extract session number from H5 filename."""
    m = re.search(r'_session(\d+)_', filename)
    return int(m.group(1)) if m else None


def _parse_timestamp_dt(ts: str) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.strptime(ts, '%Y%m%d_%H%M%S')
    except Exception:
        return None


def _index_files_by_name(files: List[dict]) -> Dict[str, dict]:
    return {f.get('name', ''): f for f in files if f.get('name')}


def _match_refs_to_files(refs: List[str], files_by_name: Dict[str, dict]) -> List[dict]:
    matched = []
    seen = set()
    for ref in refs or []:
        item = files_by_name.get(ref)
        if item and item.get('name') not in seen:
            matched.append(item)
            seen.add(item.get('name'))
    return matched


def _nearest_timestamp_group(target_ts: str, files: List[dict], max_seconds: int = 600) -> List[dict]:
    """Fallback for old H5 files without attrs: choose one closest timestamp group."""
    target_dt = _parse_timestamp_dt(target_ts)
    if not target_dt:
        return []

    groups = defaultdict(list)
    for item in files:
        ts = item.get('timestamp', '')
        if ts:
            groups[ts].append(item)
    if not groups:
        return []

    best_ts = None
    best_delta = None
    for ts in groups:
        dt = _parse_timestamp_dt(ts)
        if not dt:
            continue
        delta = abs((dt - target_dt).total_seconds())
        if best_delta is None or delta < best_delta:
            best_ts = ts
            best_delta = delta

    if best_ts is None or best_delta is None or best_delta > max_seconds:
        return []
    return sorted(groups[best_ts], key=lambda x: (x.get('hand', ''), x.get('ftype', ''), x.get('name', '')))


# ── Scanner ────────────────────────────────────────────────────────────────

class DataScanner:

    def __init__(self, root_dir: str):
        self.root_dir = root_dir
        self.band_dir = os.path.join(root_dir, '手环数据')
        self.pc_dir   = os.path.join(root_dir, '电脑数据')

    def scan(self) -> dict:
        subjects: Dict[str, dict] = {}
        if os.path.isdir(self.band_dir):
            self._scan_band(subjects)
        if os.path.isdir(self.pc_dir):
            self._scan_pc(subjects)
        # Post-scan: match bin/video to H5 sessions
        for s in subjects.values():
            self._match_files_to_h5(s)
        return subjects

    # ── 手环数据 ──────────────────────────────────────────────────────

    def _scan_band(self, subjects: dict):
        for entry in os.listdir(self.band_dir):
            entry_path = os.path.join(self.band_dir, entry)
            if not os.path.isdir(entry_path):
                continue
            sid = _extract_subject_id(entry)
            if sid is None:
                continue

            node = _ensure_subject(subjects, sid)
            node['band_dir_name'] = entry
            node['band_dir_path'] = entry_path

            # Collect all bin files with full paths
            bins = []  # [(filename, fullpath, timestamp, hand, type), ...]
            for f in Path(entry_path).rglob('*.bin'):
                if f.is_file():
                    ts = extract_timestamp_bin_video(f.name)
                    hand_type = _parse_bin_hand_type(f.name)
                    bins.append({
                        'name': f.name,
                        'path': str(f),
                        'timestamp': ts or '',
                        'hand': hand_type[0],
                        'ftype': hand_type[1],
                    })

            node['band_total_bins'] = len(bins)
            node['band_all_bins'] = bins

    # ── 电脑数据 ──────────────────────────────────────────────────────

    def _scan_pc(self, subjects: dict):
        for entry in os.listdir(self.pc_dir):
            entry_path = os.path.join(self.pc_dir, entry)
            if not os.path.isdir(entry_path):
                continue
            sid = _extract_subject_id(entry)
            if sid is None:
                continue

            node = _ensure_subject(subjects, sid)
            node['pc_dir_name'] = entry
            configs = {}

            for sub_entry in os.listdir(entry_path):
                sub_path = os.path.join(entry_path, sub_entry)
                if not os.path.isdir(sub_path):
                    continue

                config_info = _parse_config_dir(sub_entry, sid)
                if config_info:
                    cfg_name = config_info['config_name']
                    configs[cfg_name] = self._scan_pc_config(sub_path, config_info)
                elif sub_entry.lower() == 'video':
                    node['subject_video'] = self._collect_video_files(sub_path)
                elif '离散' in sub_entry or '连续' in sub_entry:
                    # H5 directly under subject (e.g. L007/离散手势采集/...)
                    for f in Path(sub_path).rglob('*.h5'):
                        if f.is_file() and not f.name.endswith('.bak'):
                            h5_info = {
                                'name': f.name, 'path': str(f),
                                'timestamp': extract_timestamp_h5(f.name) or '',
                                'session': extract_session_number(f.name),
                                'status': STATUS_NONE,
                                'collection_status': '',
                                'video_compressed': False,
                                'bin_refs': [],
                                'video_refs': [],
                            }
                            if HAS_H5PY:
                                meta = read_h5_status(str(f))
                                h5_info['collection_status'] = meta['collection_status']
                                h5_info['bin_refs'] = meta.get('bin_refs', [])
                                h5_info['video_refs'] = meta.get('video_refs', [])
                                h5_info['video_compressed'] = meta.get('video_compressed', False)
                                if meta['sync_status'] == STATUS_FAILED:
                                    h5_info['status'] = STATUS_FAILED
                                elif meta['sync_status'] == STATUS_SYNCED:
                                    h5_info['status'] = STATUS_SYNCED
                                elif meta['collection_status'] == 'abnormal_interrupted':
                                    h5_info['status'] = 'abnormal_interrupted'
                                elif meta['is_resumed']:
                                    h5_info['status'] = 'resumed'
                                else:
                                    h5_info['status'] = meta['sync_status'] if meta['sync_status'] != STATUS_NONE else STATUS_PENDING
                            node.setdefault('direct_h5', []).append(h5_info)

            node['pc_configs'] = configs

    def _scan_pc_config(self, config_path: str, info: dict) -> dict:
        """Scan a config dir. Collect H5 + video files separately."""
        cfg = {
            'config_name': info['config_name'],
            'config_type': info.get('config_type', '?'),
            'path': config_path,
            'h5_list': [],    # [{name, path, timestamp, session, status}]
            'video_list': [], # [{name, path, timestamp, hand}]
        }

        for root, dirs, files in os.walk(config_path):
            for f in files:
                fpath = os.path.join(root, f)
                ext = os.path.splitext(f)[1].lower()

                if ext in H5_EXTS and not f.endswith('.bak'):
                    sess = extract_session_number(f)
                    h5_info = {
                        'name': f, 'path': fpath,
                        'timestamp': extract_timestamp_h5(f) or '',
                        'session': sess,
                        'status': STATUS_NONE,
                        'collection_status': '',
                        'bin_refs': [],
                        'video_refs': [],
                        'video_compressed': False,
                    }
                    # Read H5 metadata (sync status)
                    if HAS_H5PY:
                        meta = read_h5_status(fpath)
                        h5_info['collection_status'] = meta['collection_status']
                        h5_info['compressed'] = meta['compressed']
                        h5_info['compression_info'] = meta['compression_info']
                        h5_info['bin_refs'] = meta.get('bin_refs', [])
                        h5_info['video_refs'] = meta.get('video_refs', [])
                        h5_info['video_compressed'] = meta.get('video_compressed', False)
                        # Priority: sync_failed > synced > pending > abnormal
                        if meta['sync_status'] == STATUS_FAILED:
                            h5_info['status'] = STATUS_FAILED
                        elif meta['sync_status'] == STATUS_SYNCED:
                            h5_info['status'] = STATUS_SYNCED
                        elif meta['collection_status'] == 'abnormal_interrupted':
                            h5_info['status'] = 'abnormal_interrupted'
                        elif meta['is_resumed']:
                            h5_info['status'] = 'resumed'
                        else:
                            h5_info['status'] = meta['sync_status'] if meta['sync_status'] != STATUS_NONE else STATUS_PENDING
                    cfg['h5_list'].append(h5_info)

                elif ext in VIDEO_EXTS:
                    hand = 'L' if '_L_' in f else ('R' if '_R_' in f else '?')
                    cfg['video_list'].append({
                        'name': f, 'path': fpath,
                        'timestamp': extract_timestamp_bin_video(f) or '',
                        'hand': hand,
                    })

        # Sort both lists by timestamp
        cfg['h5_list'].sort(key=lambda x: x['session'] or 999)
        cfg['video_list'].sort(key=lambda x: x['timestamp'])

        return cfg

    def _collect_video_files(self, video_path: str) -> list:
        """Collect video files from a directory (for subject-level video)."""
        result = []
        if not os.path.isdir(video_path):
            return result
        for f in os.listdir(video_path):
            fpath = os.path.join(video_path, f)
            if not os.path.isfile(fpath):
                continue
            if os.path.splitext(f)[1].lower() in VIDEO_EXTS:
                result.append({
                    'name': f, 'path': fpath,
                    'timestamp': extract_timestamp_bin_video(f) or '',
                    'hand': 'L' if '_L_' in f else ('R' if '_R_' in f else '?'),
                })
        return result

    # ── Matching ───────────────────────────────────────────────────────

    def _match_files_to_h5(self, node: dict):
        """Match bin/video files to H5 sessions by H5 attrs, with a timestamp fallback."""
        all_bins = node.get('band_all_bins', [])
        sorted_bins = sorted(all_bins, key=lambda b: b['timestamp'])
        bin_by_name = _index_files_by_name(sorted_bins)
        matched_bin_names = set()

        subject_videos = sorted(node.get('subject_video', []), key=lambda v: v.get('timestamp', ''))
        subject_video_by_name = _index_files_by_name(subject_videos)
        matched_subject_video_names = set()

        def _match_bins_for_h5(h5: dict) -> List[dict]:
            matched = _match_refs_to_files(h5.get('bin_refs', []), bin_by_name)
            if not matched:
                matched = _nearest_timestamp_group(h5.get('timestamp', ''), sorted_bins)
            return matched

        def _match_videos_for_h5(h5: dict, cfg_videos: List[dict], cfg_video_by_name: Dict[str, dict]) -> List[dict]:
            video_by_name = dict(subject_video_by_name)
            video_by_name.update(cfg_video_by_name)
            matched = _match_refs_to_files(h5.get('video_refs', []), video_by_name)
            if not matched:
                matched = _nearest_timestamp_group(h5.get('timestamp', ''), cfg_videos)
            if not matched:
                matched = _nearest_timestamp_group(h5.get('timestamp', ''), subject_videos)
            return matched

        for cfg_name, cfg in node.get('pc_configs', {}).items():
            h5_list = cfg.get('h5_list', [])
            vid_list = sorted(cfg.get('video_list', []), key=lambda v: v.get('timestamp', ''))
            cfg_video_by_name = _index_files_by_name(vid_list)
            matched_cfg_video_names = set()

            for h5 in h5_list:
                matched_bins = _match_bins_for_h5(h5)
                h5['matched_bins'] = matched_bins
                matched_bin_names.update(b.get('name') for b in matched_bins if b.get('name'))

                matched_videos = _match_videos_for_h5(h5, vid_list, cfg_video_by_name)
                h5['matched_videos'] = matched_videos
                for v in matched_videos:
                    name = v.get('name')
                    if name in cfg_video_by_name:
                        matched_cfg_video_names.add(name)
                    if name in subject_video_by_name:
                        matched_subject_video_names.add(name)

            cfg['matched_video_names'] = matched_cfg_video_names
            cfg['unmatched_videos'] = [v for v in vid_list if v.get('name') not in matched_cfg_video_names]

        for h5 in node.get('direct_h5', []):
            matched_bins = _match_bins_for_h5(h5)
            h5['matched_bins'] = matched_bins
            matched_bin_names.update(b.get('name') for b in matched_bins if b.get('name'))

            matched_videos = _match_videos_for_h5(h5, subject_videos, subject_video_by_name)
            h5['matched_videos'] = matched_videos
            matched_subject_video_names.update(v.get('name') for v in matched_videos if v.get('name'))

        node['matched_bin_names'] = matched_bin_names
        node['unmatched_bins'] = [b for b in sorted_bins if b.get('name') not in matched_bin_names]
        node['matched_subject_video_names'] = matched_subject_video_names
        node['unmatched_subject_video'] = [
            v for v in subject_videos if v.get('name') not in matched_subject_video_names
        ]

        # Detect video compression: mp4 = compressed from avi
        def _check_video_compression(h5_list):
            for h5 in h5_list:
                vids = h5.get('matched_videos', [])
                if h5.get('video_compressed') or (vids and all(v.get('name', '').lower().endswith('.mp4') for v in vids)):
                    h5['video_compressed'] = True
                    if h5.get('status') in (STATUS_NONE, STATUS_PENDING):
                        h5['status'] = 'compressed'
                else:
                    h5['video_compressed'] = False

        for cfg in node.get('pc_configs', {}).values():
            _check_video_compression(cfg.get('h5_list', []))
        _check_video_compression(node.get('direct_h5', []))


# ── Helpers ────────────────────────────────────────────────────────────────

def _extract_subject_id(dirname: str) -> Optional[str]:
    m = re.search(r'(\d{2,4})', dirname)
    return m.group(1) if m else None


def _ensure_subject(subjects: dict, sid: str) -> dict:
    if sid not in subjects:
        subjects[sid] = {
            'subject_id': sid,
            'band_total_bins': 0,
            'band_all_bins': [],
            'band_dir_name': '',
            'band_dir_path': '',
            'pc_configs': {},
            'pc_dir_name': '',
        }
    return subjects[sid]


def _parse_config_dir(dirname: str, subject_id: str) -> Optional[dict]:
    m = re.match(r'^[Ll](\d+)-C(\d+(?:-\d+)?)(.*)$', dirname)
    if m:
        return {
            'config_name': dirname,
            'config_type': f'C{m.group(2)}',
            'subject_id': m.group(1),
            'suffix': m.group(3),
        }
    m2 = re.match(r'^[Ll](\d+).*$', dirname)
    if m2:
        return {
            'config_name': dirname,
            'config_type': '?',
            'subject_id': m2.group(1),
            'suffix': '',
        }
    return None


def _parse_bin_hand_type(filename: str) -> Tuple[str, str]:
    """Parse L/R hand and emg/imu type from bin filename."""
    m = re.search(r'_([LR])_(\d{6})_(\d{6})_(emg|imu)\.bin', filename, re.IGNORECASE)
    if m:
        return (m.group(1).upper(), m.group(4).lower())
    return ('?', '?')


# ── Scan Worker ────────────────────────────────────────────────────────────

class ScanWorker(QThread):
    progress  = pyqtSignal(str)
    finished  = pyqtSignal(dict)
    error     = pyqtSignal(str)

    def __init__(self, root_dir: str):
        super().__init__()
        self.root_dir = root_dir

    def run(self):
        try:
            self.progress.emit("正在扫描目录结构...")
            scanner = DataScanner(self.root_dir)
            subjects = scanner.scan()
            if HAS_H5PY:
                self.progress.emit("正在读取H5同步状态...")
            self.progress.emit(f"扫描完成: {len(subjects)} 个受试者")
            self.finished.emit(subjects)
        except Exception as e:
            import traceback
            self.error.emit(f"扫描出错: {e}\n{traceback.format_exc()}")


# ── Tree Builder ──────────────────────────────────────────────────────────

class TreeBuilder:

    @staticmethod
    def build(tree: QTreeWidget, subjects: dict, root_label: str = ""):
        tree.clear()

        total_subjects = len(subjects)
        total_configs  = sum(len(s.get('pc_configs', {})) for s in subjects.values())
        total_h5       = sum(
            len(c.get('h5_list', [])) for s in subjects.values()
            for c in s.get('pc_configs', {}).values()
        )

        label = root_label or "数据统计"
        if total_subjects:
            label += f" ({total_subjects}受试者, {total_configs}配置, {total_h5}H5)"

        root = QTreeWidgetItem(tree, [f"💿 {label}"])
        root.setData(0, Qt.UserRole, {'type': 'root'})
        root.setExpanded(True)

        for sid in sorted(subjects.keys(), key=lambda x: int(x) if x.isdigit() else 9999):
            TreeBuilder._add_subject(root, sid, subjects[sid])

        # Summary
        TreeBuilder._add_summary(root, subjects)

    @staticmethod
    def _add_subject(root: QTreeWidgetItem, sid: str, subj: dict):
        configs  = subj.get('pc_configs', {})
        all_bins = subj.get('band_all_bins', [])

        # Overall status
        h5_statuses = []
        for c in configs.values():
            for h5 in c.get('h5_list', []):
                h5_statuses.append(h5.get('status', STATUS_NONE))
        synced = sum(1 for s in h5_statuses if s == STATUS_SYNCED)
        total  = len(h5_statuses)

        if total and synced == total:
            icon = '✅'
        elif total:
            icon = '⚠️'
        else:
            icon = '📁'

        label = f"{icon} {sid}"
        if total:
            label += f"  H5:{synced}/{total}已同步"
        if all_bins:
            label += f"  Bin:{len(all_bins)}"
        cfg_count = len(configs)
        if cfg_count:
            label += f"  配置:{cfg_count}"

        item = QTreeWidgetItem(root, [label])
        item.setData(0, Qt.UserRole, {'type': 'subject', 'subject_id': sid})

        # ── 电脑数据: 每个配置 → H5 → bin/video ──
        if configs:
            pc_item = QTreeWidgetItem(item, [f"💿 电脑数据 ({cfg_count}配置)"])
            for cfg_name in sorted(configs.keys()):
                TreeBuilder._add_config(pc_item, cfg_name, configs[cfg_name])

        # ── Direct H5 (no config dir) ──
        for h5 in subj.get('direct_h5', []):
            TreeBuilder._add_h5_node(item, h5, show_session=False)

        # Subject-level files that are not referenced by any H5.
        unmatched_sv = subj.get('unmatched_subject_video', [])
        if unmatched_sv:
            sv_node = QTreeWidgetItem(item, [f"🎬 未关联视频 ({len(unmatched_sv)}个)"])
            for v in unmatched_sv:
                QTreeWidgetItem(sv_node, [f"  {v['name']}"])

        unmatched_bins = subj.get('unmatched_bins', [])
        if unmatched_bins:
            bin_node = QTreeWidgetItem(item, [f"💾 未关联手环Bin ({len(unmatched_bins)}个)"])
            for b in unmatched_bins[:80]:
                QTreeWidgetItem(bin_node, [f"  {b['name']}"])
            if len(unmatched_bins) > 80:
                QTreeWidgetItem(bin_node, [f"  ... 还有 {len(unmatched_bins) - 80} 个"])

    @staticmethod
    def _add_config(parent: QTreeWidgetItem, cfg_name: str, cfg: dict):
        h5_list  = cfg.get('h5_list', [])
        vid_list = cfg.get('video_list', [])

        synced   = sum(1 for h5 in h5_list if h5.get('status') == STATUS_SYNCED)
        icon = '✅' if h5_list and synced == len(h5_list) else ('⚠️' if h5_list else '❌')

        unmatched_videos = cfg.get('unmatched_videos', [])

        label = f"{icon} {cfg_name}  H5:{len(h5_list)}({synced}已同步)  视频:{len(vid_list)}"
        cfg_item = QTreeWidgetItem(parent, [label])
        cfg_item.setData(0, Qt.UserRole, {'type': 'config', 'config_name': cfg_name})

        for i, h5 in enumerate(h5_list):
            TreeBuilder._add_h5_node(cfg_item, h5, show_session=True)

        # Unmatched videos
        if unmatched_videos:
            uv_node = QTreeWidgetItem(cfg_item, [f"  ⚪ 未关联视频 ({len(unmatched_videos)}个)"])
            for v in unmatched_videos:
                QTreeWidgetItem(uv_node, [f"    {v['name']}"])

    @staticmethod
    def _add_h5_node(parent: QTreeWidgetItem, h5: dict, show_session: bool = False):
        status = h5.get('status', STATUS_NONE)
        si = status_icon(status)
        st = status_text(status)
        name = h5.get('name', '?')
        session = h5.get('session')

        label = f"{si} {name}  [{st}]"
        if show_session and session:
            label = f"{si} Session{session}  [{st}]"
            label += f"  📄{name}"

        h5_item = QTreeWidgetItem(parent, [label])
        color = status_color(status)
        h5_item.setForeground(0, color)
        h5_item.setData(0, Qt.UserRole, {
            'type': 'h5_file',
            'name': name,
            'path': h5.get('path', ''),
            'status': status,
        })

        # Matched bin files
        matched_bins = h5.get('matched_bins', [])
        if matched_bins:
            bin_node = QTreeWidgetItem(h5_item, [f"  💾 Bin文件 ({len(matched_bins)}个)"])
            for b in matched_bins:
                hand_icon = '👈' if b.get('hand') == 'L' else ('👉' if b.get('hand') == 'R' else '  ')
                ftype = b.get('ftype', '')
                QTreeWidgetItem(bin_node, [f"    {hand_icon} {b['name']} ({ftype})"])

        # Matched video files
        matched_videos = h5.get('matched_videos', [])
        if matched_videos:
            vid_node = QTreeWidgetItem(h5_item, [f"  🎬 视频 ({len(matched_videos)}个)"])
            for v in matched_videos:
                hand_icon = '👈' if v.get('hand') == 'L' else ('👉' if v.get('hand') == 'R' else '  ')
                QTreeWidgetItem(vid_node, [f"    {hand_icon} {v['name']}"])

    @staticmethod
    def _add_summary(root: QTreeWidgetItem, subjects: dict):
        total = len(subjects)
        total_cfgs = sum(len(s.get('pc_configs', {})) for s in subjects.values())
        total_h5  = sum(
            len(c.get('h5_list', [])) for s in subjects.values()
            for c in s.get('pc_configs', {}).values()
        )
        total_bin = sum(s.get('band_total_bins', 0) for s in subjects.values())
        total_vid = sum(
            len(c.get('video_list', [])) for s in subjects.values()
            for c in s.get('pc_configs', {}).values()
        )
        synced = sum(
            1 for s in subjects.values()
            for c in s.get('pc_configs', {}).values()
            for h5 in c.get('h5_list', [])
            if h5.get('status') == STATUS_SYNCED
        )

        summary = QTreeWidgetItem(root, ["📋 摘要"])
        QTreeWidgetItem(summary, [f"  受试者: {total}  |  配置: {total_cfgs}  |  H5: {total_h5}  |  Bin: {total_bin}  |  视频: {total_vid}"])
        QTreeWidgetItem(summary, [f"  🟢 已同步: {synced}  |  🟠 待同步: {total_h5 - synced}"])


# ── Detail Panel ───────────────────────────────────────────────────────────

class DetailPanel(QWidget):

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)

        # Legend (always visible at top)
        self.legend_label = QLabel(LEGEND_HTML)
        self.legend_label.setWordWrap(True)
        self.legend_label.setFrameShape(QFrame.StyledPanel)
        self.legend_label.setStyleSheet(
            "background:#f9fafb; border:1px solid #e5e7eb; border-radius:4px; padding:6px;"
        )
        layout.addWidget(self.legend_label)

        # Detail text
        self.label = QLabel("选择一个节点查看详情")
        self.label.setWordWrap(True)
        self.label.setStyleSheet("font-size: 13px; padding: 8px;")
        self.label.setFrameShape(QFrame.StyledPanel)
        layout.addWidget(self.label)

        layout.addStretch()

    def show_h5_detail(self, h5: dict):
        status = h5.get('status', STATUS_NONE)
        name   = h5.get('name', '?')
        path   = h5.get('path', '')
        col_st = h5.get('collection_status', '')

        lines = [
            f"📊 H5 文件详情",
            f"",
            f"文件名: {name}",
            f"路径: {path}",
            f"同步状态: {status_icon(status)} {status_text(status)}",
        ]
        if col_st:
            lines.append(f"采集状态: {col_st}")
        if h5.get('video_compressed'):
            lines.append(f"视频压缩: 🟣 已压缩 (AVI→MP4)")

        matched_bins = h5.get('matched_bins', [])
        if matched_bins:
            lines.append(f"")
            lines.append(f"── 关联 Bin 文件 ({len(matched_bins)}个) ──")
            for b in matched_bins:
                h = b.get('hand', '?')
                t = b.get('ftype', '?')
                lines.append(f"  [{h}手] {b['name']} ({t})")

        matched_vids = h5.get('matched_videos', [])
        if matched_vids:
            lines.append(f"")
            lines.append(f"── 关联视频 ({len(matched_vids)}个) ──")
            for v in matched_vids:
                lines.append(f"  [{v.get('hand','?')}手] {v['name']}")

        self.label.setText('\n'.join(lines))

    def show_subject_detail(self, sid: str, subj: dict):
        configs  = subj.get('pc_configs', {})
        all_bins = subj.get('band_all_bins', [])

        lines = [f"👤 受试者: {sid}", f""]

        for cn, cfg in sorted(configs.items()):
            h5_list = cfg.get('h5_list', [])
            synced = sum(1 for h in h5_list if h.get('status') == STATUS_SYNCED)
            lines.append(f"── {cn} ──")
            lines.append(f"  H5: {len(h5_list)} ({synced}已同步)")
            lines.append(f"  视频: {len(cfg.get('video_list', []))}")
            for h5 in h5_list:
                si = status_icon(h5.get('status', STATUS_NONE))
                sn = h5.get('session', '?')
                lines.append(f"    {si} Session{sn}: {h5['name']}")
            lines.append(f"")

        if all_bins:
            lines.append(f"手环数据: {len(all_bins)} bin 文件")

        self.label.setText('\n'.join(lines))

    def show_summary(self, subjects: dict):
        total = len(subjects)
        total_h5 = sum(
            len(c.get('h5_list', [])) for s in subjects.values()
            for c in s.get('pc_configs', {}).values()
        )
        synced = sum(
            1 for s in subjects.values()
            for c in s.get('pc_configs', {}).values()
            for h5 in c.get('h5_list', [])
            if h5.get('status') == STATUS_SYNCED
        )
        pending = total_h5 - synced
        failed = sum(
            1 for s in subjects.values()
            for c in s.get('pc_configs', {}).values()
            for h5 in c.get('h5_list', [])
            if h5.get('status') == STATUS_FAILED
        )

        lines = [
            f"📋 数据扫描总览",
            f"",
            f"受试者: {total}",
            f"H5 文件: {total_h5}",
            f"🟢 已同步: {synced}",
            f"🟠 待同步: {pending}",
            f"🔴 同步失败: {failed}",
        ]
        self.label.setText('\n'.join(lines))

    def clear(self):
        self.label.setText("选择一个节点查看详情")


# ── Main Window ────────────────────────────────────────────────────────────

class StatsViewer(QMainWindow):

    def __init__(self):
        super().__init__()
        self.setWindowTitle("sEMG 数据统计查看器")
        self.setMinimumSize(1100, 750)

        self._subjects: dict = {}
        self._settings = QSettings('sEMG_Collection', 'StatsViewer')

        self._setup_ui()
        self._load_settings()
        self._apply_style()

    def _setup_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        main = QVBoxLayout(central)
        main.setContentsMargins(6, 4, 6, 4)
        main.setSpacing(4)

        # ── Toolbar ──
        bar = QHBoxLayout()
        bar.addWidget(QLabel("数据目录:"))
        self.dir_edit = QLineEdit()
        self.dir_edit.setPlaceholderText("选择日期数据根目录...")
        self.dir_edit.setMaximumWidth(280)
        self.dir_edit.returnPressed.connect(self._on_scan)
        bar.addWidget(self.dir_edit)

        browse_btn = QPushButton("浏览")
        browse_btn.clicked.connect(self._browse_dir)
        bar.addWidget(browse_btn)

        self.scan_btn = QPushButton("🔍 扫描")
        self.scan_btn.clicked.connect(self._on_scan)
        bar.addWidget(self.scan_btn)

        bar.addSpacing(16)
        bar.addWidget(QLabel("搜索:"))
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("受试者/配置/文件名...")
        self.search_edit.setMaximumWidth(220)
        self.search_edit.textChanged.connect(self._on_search)
        bar.addWidget(self.search_edit)
        bar.addStretch()

        self.expand_btn = QPushButton("展开")
        self.expand_btn.clicked.connect(lambda: self.tree.expandAll())
        bar.addWidget(self.expand_btn)
        self.collapse_btn = QPushButton("折叠")
        self.collapse_btn.clicked.connect(lambda: self.tree.collapseAll())
        bar.addWidget(self.collapse_btn)
        main.addLayout(bar)

        # ── Splitter ──
        splitter = QSplitter(Qt.Horizontal)
        splitter.setChildrenCollapsible(False)

        tree_frame = QFrame()
        tree_frame.setFrameShape(QFrame.StyledPanel)
        tree_layout = QVBoxLayout(tree_frame)
        tree_layout.setContentsMargins(2, 2, 2, 2)
        self.tree = QTreeWidget()
        self.tree.setHeaderLabel("数据结构")
        self.tree.setContextMenuPolicy(Qt.CustomContextMenu)
        self.tree.customContextMenuRequested.connect(self._on_context_menu)
        self.tree.itemClicked.connect(self._on_item_clicked)
        tree_layout.addWidget(self.tree)
        splitter.addWidget(tree_frame)

        detail_frame = QFrame()
        detail_frame.setFrameShape(QFrame.StyledPanel)
        detail_layout = QVBoxLayout(detail_frame)
        detail_layout.setContentsMargins(2, 2, 2, 2)
        detail_layout.addWidget(QLabel("📋 详细信息"))
        self.detail_panel = DetailPanel()
        detail_layout.addWidget(self.detail_panel)
        splitter.addWidget(detail_frame)

        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        main.addWidget(splitter, 1)

        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)
        self.status_bar.showMessage("就绪 - 选择数据目录后点击「扫描」")

    # ── Actions ──

    def _browse_dir(self):
        start = self.dir_edit.text().strip() or os.path.expanduser("~")
        d = QFileDialog.getExistingDirectory(self, "选择数据根目录", start)
        if d:
            self.dir_edit.setText(d)
            self._settings.setValue('data_root_dir', d)

    def _on_scan(self):
        root = self.dir_edit.text().strip()
        if not root:
            QMessageBox.warning(self, "提示", "请先选择数据目录。")
            return
        if not os.path.isdir(root):
            QMessageBox.warning(self, "提示", f"目录不存在:\n{root}")
            return

        self._settings.setValue('data_root_dir', root)
        self.scan_btn.setEnabled(False)
        self.status_bar.showMessage("正在扫描...")

        self._worker = ScanWorker(root)
        self._worker.progress.connect(self._on_progress)
        self._worker.finished.connect(self._on_scan_done)
        self._worker.error.connect(self._on_scan_error)
        self._worker.start()

    def _on_progress(self, msg: str):
        self.status_bar.showMessage(msg)

    def _on_scan_done(self, subjects: dict):
        self._subjects = subjects
        self.scan_btn.setEnabled(True)

        total_h5 = sum(
            len(c.get('h5_list', [])) for s in subjects.values()
            for c in s.get('pc_configs', {}).values()
        )
        total_bin = sum(s.get('band_total_bins', 0) for s in subjects.values())

        root_label = os.path.basename(self.dir_edit.text().strip()) or "数据统计"
        TreeBuilder.build(self.tree, subjects, root_label)
        self.detail_panel.clear()

        self.status_bar.showMessage(
            f"✅ 扫描完成: {len(subjects)}受试者, {total_h5}H5, {total_bin}bin"
        )

    def _on_scan_error(self, err: str):
        self.scan_btn.setEnabled(True)
        self.status_bar.showMessage("扫描出错")
        QMessageBox.critical(self, "扫描错误", err)

    def _on_item_clicked(self, item: QTreeWidgetItem, col: int):
        data = item.data(0, Qt.UserRole)
        if not data:
            return
        typ = data.get('type', '')
        sid = data.get('subject_id', '')

        if typ == 'h5_file':
            # Find the h5 info in subjects
            name = data.get('name', '')
            path = data.get('path', '')
            h5_info = self._find_h5_info(name, path)
            if h5_info:
                self.detail_panel.show_h5_detail(h5_info)
            else:
                self.detail_panel.label.setText(f"H5文件:\n{name}\n{path}")
        elif typ == 'subject' and sid and sid in self._subjects:
            self.detail_panel.show_subject_detail(sid, self._subjects[sid])
        elif typ == 'root':
            self.detail_panel.show_summary(self._subjects)
        else:
            self.detail_panel.clear()

    def _find_h5_info(self, name: str, path: str) -> Optional[dict]:
        for subj in self._subjects.values():
            for cfg in subj.get('pc_configs', {}).values():
                for h5 in cfg.get('h5_list', []):
                    if h5.get('name') == name or h5.get('path') == path:
                        return h5
            for h5 in subj.get('direct_h5', []):
                if h5.get('name') == name or h5.get('path') == path:
                    return h5
        return None

    def _on_search(self, text: str):
        root = self.tree.invisibleRootItem()
        if not text.strip():
            self._show_all(root)
            return
        self._filter_items(root, text.lower())

    def _filter_items(self, parent: QTreeWidgetItem, text: str):
        for i in range(parent.childCount()):
            child = parent.child(i)
            matches = text in child.text(0).lower()
            if child.childCount() > 0:
                self._filter_items(child, text)
                any_vis = any(not child.child(j).isHidden() for j in range(child.childCount()))
                child.setHidden(not (matches or any_vis))
            else:
                child.setHidden(not matches)

    def _show_all(self, parent: QTreeWidgetItem):
        for i in range(parent.childCount()):
            child = parent.child(i)
            child.setHidden(False)
            if child.childCount() > 0:
                self._show_all(child)

    def _on_context_menu(self, pos):
        item = self.tree.itemAt(pos)
        if not item:
            return
        data = item.data(0, Qt.UserRole)
        if not data:
            return
        menu = QMenu()
        copy_action = menu.addAction("📋 复制文本")
        copy_action.triggered.connect(lambda: QApplication.clipboard().setText(item.text(0)))

        # Open file if it's an H5
        fpath = data.get('path', '')
        if fpath and os.path.isfile(fpath):
            open_action = menu.addAction("🔍 打开文件")
            open_action.triggered.connect(lambda: os.startfile(fpath))
            open_dir_action = menu.addAction("📂 打开所在文件夹")
            open_dir_action.triggered.connect(lambda: os.startfile(os.path.dirname(fpath)))

        menu.exec_(self.tree.viewport().mapToGlobal(pos))

    def _load_settings(self):
        d = self._settings.value('data_root_dir', '')
        if d:
            self.dir_edit.setText(d)

    def _apply_style(self):
        self.setStyleSheet("""
            QMainWindow { background-color: #f8f9fa; }
            QFrame[frameShape="4"] {
                background-color: #fff;
                border: 1px solid #dee2e6; border-radius: 4px;
            }
            QTreeWidget { font-size: 12px; }
            QTreeWidget::item:hover { background-color: #e8f0fe; }
            QHeaderView::section {
                background-color: #f1f3f5; padding: 6px;
                border: 1px solid #dee2e6; font-weight: bold;
            }
            QPushButton {
                padding: 6px 12px; border: 1px solid #ced4da;
                border-radius: 3px; background-color: #fff;
            }
            QPushButton:hover { background-color: #e9ecef; }
            QLineEdit {
                padding: 6px; border: 1px solid #ced4da; border-radius: 3px;
            }
            QStatusBar {
                border-top: 1px solid #dee2e6; background-color: #f8f9fa;
            }
        """)


# ── Entry Point ────────────────────────────────────────────────────────────

def main():
    app = QApplication(sys.argv)
    app.setApplicationName("sEMG Stats Viewer")
    app.setOrganizationName("sEMG_Collection")
    window = StatsViewer()
    window.show()
    sys.exit(app.exec_())


if __name__ == '__main__':
    main()
