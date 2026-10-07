"""
Independent MJPEG -> MP4 encoder worker.

The camera server closes raw .mjpeg files quickly and starts this worker in a
detached process. The worker scans storage/video for closed MJPEG files and
updates a JSON status file that the UI can display.
"""

import argparse
import json
import os
import sys
import time
import threading
import tempfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from camera_server import (
    ENCODING_THREADS,
    ENCODING_WORKERS,
    ENCODING_X264_CRF,
    ENCODING_X264_PRESET,
    FrameRecorder,
    find_ffmpeg,
)


STATUS_FILE = 'video_encoder_status.json'
LOCK_FILE = 'video_encoder_worker.lock'
META_SUFFIX = '.encode.json'
RECORDING_SUFFIX = '.recording'
COLLECTION_ACTIVE_FILE = 'video_collection_active.json'
IDLE_EXIT_SECONDS = 20
LOCK_STALE_SECONDS = 120
_ATOMIC_JSON_LOCK = threading.RLock()


def env_int(name, default, minimum=1):
    try:
        value = int(os.environ.get(name, str(default)))
    except Exception:
        value = default
    return max(minimum, value)


ACTIVE_RECORDING_THREADS = env_int('VIDEO_ENCODING_ACTIVE_THREADS', 1, 1)
IDLE_RECORDING_THREADS = env_int('VIDEO_ENCODING_IDLE_THREADS', ENCODING_THREADS, 1)
ACTIVE_RECORDING_WORKERS = env_int('VIDEO_ENCODING_ACTIVE_WORKERS', 1, 1)
IDLE_RECORDING_WORKERS = env_int('VIDEO_ENCODING_IDLE_WORKERS', max(2, ENCODING_WORKERS), 1)
COLLECTION_ACTIVE_STALE_SECONDS = env_int('VIDEO_ENCODING_COLLECTION_ACTIVE_STALE_SECONDS', 12 * 3600, 60)
ACTIVE_RECORDING_PRESET = os.environ.get('VIDEO_ENCODING_ACTIVE_PRESET', ENCODING_X264_PRESET).strip() or ENCODING_X264_PRESET
IDLE_RECORDING_PRESET = os.environ.get('VIDEO_ENCODING_IDLE_PRESET', ENCODING_X264_PRESET).strip() or ENCODING_X264_PRESET


def atomic_write_json(path, data):
    path = Path(path)
    with _ATOMIC_JSON_LOCK:
        fd, tmp_name = tempfile.mkstemp(
            prefix=f'.{path.name}.', suffix='.tmp', dir=str(path.parent))
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_name, path)
        finally:
            try:
                os.unlink(tmp_name)
            except FileNotFoundError:
                pass


def read_json(path, default=None):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def infer_side(path):
    name = path.name.lower()
    if '_l_' in name or 'left' in name or '左' in path.name:
        return 'left'
    if '_r_' in name or 'right' in name or '右' in path.name:
        return 'right'
    return 'unknown'


def load_meta(raw_path):
    meta = read_json(raw_path.with_suffix(raw_path.suffix + META_SUFFIX), {}) or {}
    return {
        'side': meta.get('side') or infer_side(raw_path),
        'frame_count': int(meta.get('frame_count') or 0),
        'first_frame_real_time': meta.get('first_frame_real_time'),
        'last_frame_real_time': meta.get('last_frame_real_time'),
        'recording_started_at': meta.get('recording_started_at'),
        'recording_stopped_at': meta.get('recording_stopped_at'),
        'queued_at': meta.get('queued_at') or raw_path.stat().st_mtime,
    }


def count_jpeg_frames(raw_path):
    count = 0
    tail = b''
    with open(raw_path, 'rb') as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            data = tail + chunk
            count += data.count(b'\xff\xd9')
            tail = data[-1:]
    return count


def is_closed_raw(raw_path):
    if raw_path.with_suffix(raw_path.suffix + RECORDING_SUFFIX).exists():
        return False
    try:
        size1 = raw_path.stat().st_size
        time.sleep(0.25)
        size2 = raw_path.stat().st_size
        return size1 > 0 and size1 == size2
    except Exception:
        return False


class WorkerLock:
    def __init__(self, path):
        self.path = path
        self.handle = None

    def acquire(self):
        try:
            self.handle = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(self.handle, str(os.getpid()).encode('ascii', errors='ignore'))
            return True
        except FileExistsError:
            stale = False
            try:
                age = time.time() - self.path.stat().st_mtime
                stale = age > LOCK_STALE_SECONDS
            except Exception:
                pass
            if stale:
                try:
                    self.path.unlink()
                except Exception:
                    pass
                return self.acquire()
            return False

    def release(self):
        try:
            if self.handle is not None:
                os.close(self.handle)
        except Exception:
            pass
        try:
            self.path.unlink()
        except Exception:
            pass


class VideoEncoderWorker:
    def __init__(self, video_dir):
        self.video_dir = Path(video_dir).resolve()
        self.video_dir.mkdir(parents=True, exist_ok=True)
        self.status_path = self.video_dir / STATUS_FILE
        self.lock = WorkerLock(self.video_dir / LOCK_FILE)
        self.ffmpeg_path = find_ffmpeg()
        self.jobs = {}
        self.futures = {}
        self.jobs_lock = threading.RLock()
        self.executor = ThreadPoolExecutor(
            max_workers=max(ACTIVE_RECORDING_WORKERS, IDLE_RECORDING_WORKERS),
            thread_name_prefix='video-encoder-worker'
        )
        self.last_work_at = time.time()

    def has_active_recording(self):
        return any(self.video_dir.glob(f'*.mjpeg{RECORDING_SUFFIX}'))

    def collection_active_reason(self):
        marker_path = self.video_dir / COLLECTION_ACTIVE_FILE
        if not marker_path.exists():
            return None

        try:
            marker = read_json(marker_path, {}) or {}
            active = marker.get('active') is True
            age = time.time() - marker_path.stat().st_mtime
            if active and age <= COLLECTION_ACTIVE_STALE_SECONDS:
                mode = marker.get('mode') or 'collection'
                session = marker.get('recordingSessionId') or marker.get('sessionId') or ''
                return f'{mode} marker present{f" ({session})" if session else ""}'
            if age > COLLECTION_ACTIVE_STALE_SECONDS:
                try:
                    marker_path.unlink()
                except Exception:
                    pass
        except Exception:
            return None
        return None

    def current_encoding_policy(self):
        active_reason = self.collection_active_reason()
        if active_reason:
            return {
                'mode': 'recording_friendly',
                'threads': ACTIVE_RECORDING_THREADS,
                'workers': ACTIVE_RECORDING_WORKERS,
                'preset': ACTIVE_RECORDING_PRESET,
                'reason': active_reason,
            }
        if self.has_active_recording():
            return {
                'mode': 'recording_friendly',
                'threads': ACTIVE_RECORDING_THREADS,
                'workers': ACTIVE_RECORDING_WORKERS,
                'preset': ACTIVE_RECORDING_PRESET,
                'reason': 'camera recording marker present',
            }
        return {
            'mode': 'full_speed',
            'threads': IDLE_RECORDING_THREADS,
            'workers': IDLE_RECORDING_WORKERS,
            'preset': IDLE_RECORDING_PRESET,
            'reason': 'no active camera recording marker',
        }

    def write_status(self):
        with self.jobs_lock:
            details = [dict(j) for j in self.jobs.values()]
            policy = self.current_encoding_policy()
            active = sum(1 for j in details if j.get('status') == 'encoding')
            queued = sum(1 for j in details if j.get('status') == 'queued')
            raw_bytes = sum(int(j.get('raw_size') or 0) for j in details if j.get('status') in ('queued', 'encoding'))
            # Keep the snapshot and its durable replacement under one lock so
            # an older snapshot cannot overwrite a newer state transition.
            atomic_write_json(self.status_path, {
                'success': True,
                'worker_pid': os.getpid(),
                'worker_running': True,
                'updated_at': time.time(),
                'encoding_jobs': len(details),
                'encoding_active_jobs': active,
                'encoding_queued_jobs': queued,
                'encoding_raw_bytes': raw_bytes,
                'encoding_mode': policy['mode'],
                'encoding_mode_reason': policy['reason'],
                'encoding_threads': policy['threads'],
                'encoding_workers': policy['workers'],
                'encoding_preset': policy['preset'],
                'encoding_crf': ENCODING_X264_CRF,
                'encoding_idle_grace_seconds': 0,
                'encoding_dispatch_due_at': None,
                'encoding_countdown_seconds': None,
                'encoding_details': details,
            })

    def discover_jobs(self):
        found = []
        for raw_path in sorted(self.video_dir.glob('*.mjpeg'), key=lambda p: p.stat().st_mtime):
            output_path = raw_path.with_suffix('.mp4')
            if not is_closed_raw(raw_path):
                continue
            key = str(output_path)
            meta = load_meta(raw_path)
            raw_size = raw_path.stat().st_size
            with self.jobs_lock:
                if key not in self.jobs or self.jobs[key].get('status') in ('done', 'failed'):
                    self.jobs[key] = {
                        'side': meta['side'],
                        'output_path': str(output_path),
                        'raw_path': str(raw_path),
                        'frame_count': meta['frame_count'],
                        'raw_size': raw_size,
                        'status': 'queued',
                        'progress_percent': 0.0,
                        'eta_seconds': None,
                        'speed': '',
                        'queued_at': meta['queued_at'],
                        'started_at': None,
                        'updated_at': time.time(),
                    }
            found.append((raw_path, output_path, meta))
        return found

    def cleanup_futures(self):
        with self.jobs_lock:
            done_keys = [key for key, fut in self.futures.items() if fut.done()]
            for key in done_keys:
                fut = self.futures.pop(key, None)
                if fut is None:
                    continue
                exc = fut.exception()
                if exc is not None and key in self.jobs:
                    self.jobs[key].update({
                        'status': 'failed',
                        'error': str(exc),
                        'updated_at': time.time(),
                    })
                    self.last_work_at = time.time()

    def active_count(self):
        with self.jobs_lock:
            return sum(1 for job in self.jobs.values() if job.get('status') == 'encoding')

    def queued_items(self):
        with self.jobs_lock:
            items = []
            for key, job in self.jobs.items():
                if job.get('status') != 'queued' or key in self.futures:
                    continue
                raw_path = Path(job['raw_path'])
                if not raw_path.exists():
                    continue
                output_path = Path(job['output_path'])
                meta = load_meta(raw_path)
                items.append((key, raw_path, output_path, meta))
            return items

    def dispatch_jobs(self):
        policy = self.current_encoding_policy()
        available_slots = max(0, int(policy['workers']) - self.active_count())
        if available_slots <= 0:
            return 0
        launched = 0
        for key, raw_path, output_path, meta in self.queued_items():
            if launched >= available_slots:
                break
            with self.jobs_lock:
                if key in self.futures or self.jobs.get(key, {}).get('status') != 'queued':
                    continue
                future = self.executor.submit(self.encode_one, raw_path, output_path, meta)
                self.futures[key] = future
                launched += 1
        return launched

    def encode_one(self, raw_path, output_path, meta):
        key = str(output_path)
        with self.jobs_lock:
            job = self.jobs[key]
        frame_count = meta.get('frame_count') or 0
        if frame_count <= 0:
            frame_count = count_jpeg_frames(raw_path)
            with self.jobs_lock:
                job['frame_count'] = frame_count

        recorder = FrameRecorder(meta['side'], self.ffmpeg_path, self.video_dir)
        policy = self.current_encoding_policy()
        recorder.raw_path = raw_path
        recorder.output_path = output_path
        recorder.recording = False
        recorder.frame_count = frame_count
        recorder.recording_started_at = meta.get('recording_started_at') or raw_path.stat().st_mtime
        recorder.recording_stopped_at = meta.get('recording_stopped_at') or time.time()
        recorder.first_frame_real_time = meta.get('first_frame_real_time')
        recorder.last_frame_real_time = meta.get('last_frame_real_time')
        recorder.encoding_threads = policy['threads']
        recorder.encoding_preset = policy['preset']

        with self.jobs_lock:
            job.update({
                'status': 'encoding',
                'progress_percent': 0.0,
                'eta_seconds': None,
                'speed': '',
                'encoding_mode': policy['mode'],
                'encoding_threads': policy['threads'],
                'encoding_preset': policy['preset'],
                'encoding_workers': policy['workers'],
                'started_at': time.time(),
                'updated_at': time.time(),
            })
        self.write_status()

        def on_progress(percent, eta_seconds, speed):
            with self.jobs_lock:
                job.update({
                    'progress_percent': round(float(percent), 1),
                    'eta_seconds': round(float(eta_seconds), 1) if eta_seconds is not None else None,
                    'speed': speed or job.get('speed', ''),
                    'updated_at': time.time(),
                })
            self.write_status()
            return True

        result = recorder.encode_stopped_recording(on_progress)
        if result and result.get('success'):
            with self.jobs_lock:
                job.update({
                    'status': 'done',
                    'progress_percent': 100.0,
                    'eta_seconds': 0.0,
                    'file_size': result.get('size', 0),
                    'updated_at': time.time(),
                })
            try:
                raw_path.with_suffix(raw_path.suffix + META_SUFFIX).unlink()
            except Exception:
                pass
        else:
            with self.jobs_lock:
                job.update({
                    'status': 'failed',
                    'error': (result or {}).get('error', 'unknown encode error'),
                    'updated_at': time.time(),
                })
        self.last_work_at = time.time()
        self.write_status()
        self.dispatch_jobs()

    def run(self):
        if not self.ffmpeg_path:
            self.jobs['ffmpeg'] = {
                'status': 'failed',
                'error': 'ffmpeg not found',
                'updated_at': time.time(),
            }
            self.write_status()
            return 1
        if not self.lock.acquire():
            print('[VideoEncoderWorker] another worker is already running')
            status = read_json(self.status_path, {}) or {}
            status.update({
                'success': True,
                'worker_running': True,
                'worker_start_skipped': True,
                'worker_skip_reason': 'another worker lock is active',
                'updated_at': time.time(),
            })
            atomic_write_json(self.status_path, status)
            return 0
        try:
            print(f'[VideoEncoderWorker] watching {self.video_dir}')
            self.write_status()
            while True:
                self.cleanup_futures()
                self.discover_jobs()
                launched = self.dispatch_jobs()
                self.write_status()
                has_work = self.active_count() > 0 or bool(self.queued_items())
                if launched:
                    self.last_work_at = time.time()
                if not has_work and time.time() - self.last_work_at > IDLE_EXIT_SECONDS:
                    break
                time.sleep(2)
            self.write_status()
            return 0
        finally:
            try:
                self.executor.shutdown(wait=False, cancel_futures=False)
            except Exception:
                pass
            self.lock.release()
            status = read_json(self.status_path, {}) or {}
            status['worker_running'] = False
            status['updated_at'] = time.time()
            atomic_write_json(self.status_path, status)


def main():
    parser = argparse.ArgumentParser(description='Independent video encoder worker')
    parser.add_argument('--video-dir', default=str(Path('storage') / 'video'))
    args = parser.parse_args()
    return VideoEncoderWorker(args.video_dir).run()


if __name__ == '__main__':
    sys.exit(main())
