"""Bounded, freshness-checked worker for capture packets."""
from dataclasses import dataclass
import copy
import math
import threading
import time


@dataclass(frozen=True)
class FramePacket:
    frame_id: str
    captured_at: float
    pixels: object


@dataclass(frozen=True)
class LatestFrame:
    state: str
    reason: str
    value: object
    frame_id: str | None
    captured_at: float | None
    submitted_frame_id: str | None
    dropped_count: int


class LatestFrameWorker:
    def __init__(self, process_frame, max_age_seconds, *, clock=time.monotonic, on_discontinuity=None):
        if not callable(process_frame) or not math.isfinite(max_age_seconds) or max_age_seconds <= 0:
            raise ValueError('A callable and positive finite max age are required')
        self._process, self._age, self._clock = process_frame, max_age_seconds, clock
        if on_discontinuity is not None and not callable(on_discontinuity):raise ValueError('Invalid discontinuity callback')
        self._discontinuity=on_discontinuity
        self._condition = threading.Condition()
        self._pending = self._latest = self._last = None
        self._submitted = None
        self._dropped = 0
        self._closed = False
        self._reason = 'unavailable'
        self._thread = threading.Thread(target=self._run, daemon=True, name='latest-frame-worker')
        self._thread.start()

    def _reset_reader(self,reason):
        if self._discontinuity:
            try:self._discontinuity(reason)
            except Exception:
                self._latest,self._pending,self._closed,self._reason=None,None,True,'discontinuity_reset_failed'

    def submit(self, packet):
        if not isinstance(packet, FramePacket) or not isinstance(packet.frame_id, str) or not packet.frame_id.strip() or isinstance(packet.captured_at, bool) or not isinstance(packet.captured_at, (int, float)) or not math.isfinite(packet.captured_at):
            raise ValueError('Valid frame provenance is required')
        # Deep copy isolates mutable pixel arrays and nested payloads from capture reuse.
        owned = FramePacket(packet.frame_id, packet.captured_at, copy.deepcopy(packet.pixels))
        with self._condition:
            if self._closed:
                raise RuntimeError('Worker is closed')
            if self._last and (packet.frame_id <= self._last[0] or packet.captured_at <= self._last[1]):
                raise ValueError('Frame ID and capture time must strictly increase')
            if packet.captured_at > self._clock():
                raise ValueError('Capture time cannot be in the future')
            self._last = (packet.frame_id, packet.captured_at)
            self._submitted = packet.frame_id
            if self._pending is not None:
                self._dropped += 1
            self._pending = owned
            self._condition.notify()

    def get_latest(self, *, require_newest=False):
        with self._condition:
            item = self._latest
            if item is None:
                return LatestFrame('unknown', self._reason, None, None, None, self._submitted, self._dropped)
            packet, value = item
            if self._clock() - packet.captured_at > self._age:
                return LatestFrame('unknown', 'stale', None, packet.frame_id, packet.captured_at, self._submitted, self._dropped)
            if require_newest and packet.frame_id!=self._submitted:
                return LatestFrame('unknown','newer_capture_pending',None,packet.frame_id,packet.captured_at,self._submitted,self._dropped)
            return LatestFrame('available', 'processed', copy.deepcopy(value), packet.frame_id, packet.captured_at, self._submitted, self._dropped)

    def _run(self):
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._closed or self._pending is not None)
                if self._closed:
                    return
                packet, self._pending = self._pending, None
                if self._clock() - packet.captured_at > self._age:
                    self._latest, self._reason = None, 'expired_before_processing'
                    self._reset_reader('expired_before_processing')
                    continue
            try:
                value = self._process(packet)
            except Exception:
                with self._condition:
                    self._latest, self._reason = None, 'processing_error'
                    self._reset_reader('processing_error')
                continue
            with self._condition:
                if self._closed:
                    return
                if self._clock() - packet.captured_at > self._age:
                    self._latest, self._reason = None, 'expired_after_processing'
                    self._reset_reader('expired_after_processing')
                else:
                    self._latest, self._reason = (packet, value), 'processed'

    def stop(self, timeout=1.0):
        if not math.isfinite(timeout) or timeout < 0:
            raise ValueError('Timeout must be finite and nonnegative')
        with self._condition:
            self._closed = True
            self._pending = self._latest = None
            self._reason = 'closed'
            self._condition.notify_all()
        self._thread.join(timeout)
        return not self._thread.is_alive()

    close = stop
