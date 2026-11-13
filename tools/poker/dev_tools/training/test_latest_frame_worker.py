import threading
import time
import unittest

from latest_frame_worker import FramePacket, LatestFrameWorker


def wait_for(predicate):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if predicate():
            return
        threading.Event().wait(.001)
    raise AssertionError('condition timed out')


class WorkerTests(unittest.TestCase):
    def test_replacement_copy_and_shutdown(self):
        entered, release = threading.Event(), threading.Event()
        seen = []
        def process(packet):
            seen.append((packet.frame_id, packet.pixels))
            if packet.frame_id == '01':
                entered.set(); release.wait(2)
            return packet.pixels
        w = LatestFrameWorker(process, 10)
        now = time.monotonic() - 1
        try:
            w.submit(FramePacket('01', now, b'a')); self.assertTrue(entered.wait(1))
            w.submit(FramePacket('02', now + .01, b'b'))
            pixels = bytearray(b'c')
            w.submit(FramePacket('03', now + .02, pixels)); pixels[0] = 100
            release.set(); wait_for(lambda: w.get_latest().frame_id == '03')
            self.assertEqual(seen, [('01', b'a'), ('03', bytearray(b'c'))])
            self.assertEqual(w.get_latest().dropped_count, 1)
        finally:
            release.set(); self.assertTrue(w.stop(1))
        self.assertEqual(w.get_latest().reason, 'closed')

    def test_freshness_error_and_order(self):
        now = [10.0]
        entered, release = threading.Event(), threading.Event()
        def process(p):
            if p.frame_id == '02':
                entered.set(); release.wait(2)
            if p.frame_id == '03': raise RuntimeError('failure')
            return p.frame_id
        w = LatestFrameWorker(process, 2, clock=lambda: now[0])
        try:
            w.submit(FramePacket('01', 9, b'')); wait_for(lambda: w.get_latest().state == 'available')
            for p in (FramePacket('01', 9.5, b''), FramePacket('00', 9.5, b''), FramePacket('02', 9, b'')):
                with self.assertRaises(ValueError): w.submit(p)
            w.submit(FramePacket('02', 9.5, b'')); self.assertTrue(entered.wait(1))
            now[0] = 12; release.set(); wait_for(lambda: w.get_latest().reason == 'expired_after_processing')
            w.submit(FramePacket('03', 12, b'')); wait_for(lambda: w.get_latest().reason == 'processing_error')
            w.submit(FramePacket('04', 9.9, b'')) if False else None
            w.submit(FramePacket('04', 12, b'')) if False else None
            now[0] = 15
            w.submit(FramePacket('04', 12.1, b'')); wait_for(lambda: w.get_latest().reason == 'expired_before_processing')
            now[0] = 16; w.submit(FramePacket('05', 16, b'')); wait_for(lambda: w.get_latest().frame_id == '05')
            now[0] = 19; self.assertEqual(w.get_latest().reason, 'stale')
        finally:
            release.set(); self.assertTrue(w.stop(1))


if __name__ == '__main__': unittest.main()

class DiscontinuityTests(unittest.TestCase):
    def test_error_and_expiry_reset_temporal_state(self):
        now = [10.0]
        resets = []
        def process(packet):
            if packet.frame_id == '02':
                raise RuntimeError('failed')
            return {'nested': {'value': packet.frame_id}}
        worker = LatestFrameWorker(process, 1, clock=lambda: now[0], on_discontinuity=resets.append)
        try:
            worker.submit(FramePacket('01', 10, b''))
            wait_for(lambda: worker.get_latest().state == 'available')
            result = worker.get_latest()
            result.value['nested']['value'] = 'changed'
            self.assertEqual(worker.get_latest().value['nested']['value'], '01')
            now[0] = 11
            worker.submit(FramePacket('02', 11, b''))
            wait_for(lambda: worker.get_latest().reason == 'processing_error')
            now[0] = 14
            worker.submit(FramePacket('03', 12, b''))
            wait_for(lambda: worker.get_latest().reason == 'expired_before_processing')
            self.assertEqual(resets, ['processing_error', 'expired_before_processing'])
        finally:
            self.assertTrue(worker.stop())
