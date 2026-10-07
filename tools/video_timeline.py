"""Small, shared video time-axis helpers for offline previews."""

from dataclasses import dataclass
import bisect
import math


@dataclass(frozen=True)
class VideoTimeline:
    """Map video frame indices to a real endpoint-aware time axis.

    ``first_time``/``last_time`` are preferred when they come from H5
    ``video_timing``.  The endpoints are frame timestamps, so N frames span
    N-1 intervals.  This also handles N=1 and N=2 without divide-by-zero or
    endpoint drift.
    """

    frame_count: int
    fps: float = 30.0
    first_time: float = 0.0
    last_time: float | None = None
    frame_times: object = None

    def __post_init__(self):
        count = max(0, int(self.frame_count))
        object.__setattr__(self, 'frame_count', count)
        fps = float(self.fps) if self.fps and math.isfinite(float(self.fps)) else 30.0
        object.__setattr__(self, 'fps', fps if fps > 0 else 30.0)
        first = float(self.first_time) if math.isfinite(float(self.first_time)) else 0.0
        object.__setattr__(self, 'first_time', first)
        frame_times = self.frame_times
        if frame_times is not None:
            try:
                frame_times = tuple(float(value) for value in frame_times)
            except (TypeError, ValueError):
                frame_times = None
            if frame_times is not None and len(frame_times) != count:
                frame_times = None
            if frame_times is not None and any(
                    not math.isfinite(value) for value in frame_times):
                frame_times = None
            if frame_times is not None and any(
                    frame_times[i] > frame_times[i + 1]
                    for i in range(len(frame_times) - 1)):
                frame_times = None
        object.__setattr__(self, 'frame_times', frame_times)
        if frame_times is not None:
            first = frame_times[0] if frame_times else first
            object.__setattr__(self, 'first_time', first)
        last = self.last_time
        if last is not None:
            try:
                last = float(last)
            except (TypeError, ValueError):
                last = None
        if count <= 0:
            last = first
        elif count == 1:
            # A single frame has no interval even if stale metadata reports a
            # different last timestamp.
            last = first
        elif frame_times is not None:
            last = frame_times[-1]
        elif last is None or not math.isfinite(last) or last < first:
            last = first + (count - 1) / self.fps
        object.__setattr__(self, 'last_time', last)

    @property
    def duration(self):
        return max(0.0, float(self.last_time) - self.first_time)

    @property
    def effective_fps(self):
        if self.frame_count > 1 and self.duration > 0:
            return (self.frame_count - 1) / self.duration
        return self.fps

    def frame_to_time(self, frame_idx):
        if self.frame_count <= 0:
            return None
        idx = max(0, min(int(frame_idx), self.frame_count - 1))
        if self.frame_times is not None:
            return self.frame_times[idx]
        if self.frame_count <= 1:
            return self.first_time
        return self.first_time + self.duration * idx / (self.frame_count - 1)

    def time_to_frame(self, timestamp):
        if self.frame_count <= 0:
            return None
        if self.frame_times is not None:
            idx = int(bisect.bisect_left(self.frame_times, float(timestamp)))
            if idx <= 0:
                return 0
            if idx >= self.frame_count:
                return self.frame_count - 1
            before = self.frame_times[idx - 1]
            after = self.frame_times[idx]
            return idx if float(timestamp) - before >= after - float(timestamp) else idx - 1
        if self.frame_count <= 1 or self.duration <= 0:
            return 0
        ratio = (float(timestamp) - self.first_time) / self.duration
        return max(0, min(self.frame_count - 1,
                          int(round(ratio * (self.frame_count - 1)))))

    @classmethod
    def from_timing(cls, frame_count, reported_fps=30.0,
                    first_time=None, last_time=None, duration=None,
                    frame_times=None):
        """Build a timeline while tolerating legacy 600 fps headers."""
        first = 0.0 if first_time is None else float(first_time)
        last = last_time
        if last is None and duration is not None and float(duration) >= 0:
            last = first + float(duration)
        return cls(frame_count, reported_fps, first, last, frame_times)
