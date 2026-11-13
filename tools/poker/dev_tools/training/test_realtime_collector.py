"""Live publication must revoke data when newer evidence invalidates it."""
import threading
import unittest

from realtime_collector import RealtimeCollector
from test_latest_frame_worker import wait_for
from test_production_reader import ReaderTests


class RealtimeTests(ReaderTests):
    def setUp(self):
        super().setUp()
        self.now = [10.0]
        self.entered, self.release = threading.Event(), threading.Event()
        self.real_read = self.reader.read_frame
        def blocking_read(*args):
            if args[3] == 'blocked':
                self.entered.set()
                self.release.wait(2)
            return self.real_read(*args)
        self.reader.read_frame = blocking_read
        self.collector = RealtimeCollector(None, self.regions, self.colors, reader=self.reader,
                                           clock=lambda: self.now[0], max_age_seconds=10)

    def tearDown(self):
        self.release.set()
        self.assertTrue(self.collector.close())

    def ready(self):
        for i in range(2):
            self.collector.submit_frame(self.image, str(i), i + 1)
            wait_for(lambda: self.collector.get_latest()['frame_id'] == f'{i+1:020d}')
        self.assertEqual(self.collector.get_latest()['value']['regions']['seats[0].bank']['decision']['text'], 'G 1 BB')

    def block_new(self):
        self.collector.submit_frame(self.image, 'blocked', 4)
        self.assertTrue(self.entered.wait(1))

    def test_pending_changed_region_revokes_old_value_and_copies_output(self):
        self.ready()
        value = self.collector.get_latest()['value']
        value['regions']['seats[0].bank']['decision']['text'] = 'corrupted'
        self.assertEqual(self.collector.get_latest()['value']['regions']['seats[0].bank']['decision']['text'], 'G 1 BB')
        self.image[90:120,120:180] = (90, 0, 0)
        self.block_new()
        result = self.collector.get_latest()
        self.assertEqual(result['state'], 'available')
        self.assertEqual(result['value']['regions']['seats[0].bank']['decision']['state'], 'unknown')
        self.assertEqual(self.collector.get_latest(require_newest=True)['reason'], 'newer_capture_pending')

    def test_pending_changed_game_and_configuration_invalidate(self):
        self.ready()
        self.image[10:40,10:100] = (0, 0, 0)
        self.block_new()
        self.assertEqual(self.collector.get_latest()['reason'], 'newer_capture_changed_game_id')
        self.collector.colors['nameplate'] = '#000000'
        self.assertEqual(self.collector.get_latest()['reason'], 'configuration_changed')

    def test_source_identity_cannot_recur_after_intervening_capture(self):
        self.collector.submit_frame(self.image, 'A', 1)
        self.collector.submit_frame(self.image, 'B', 2)
        with self.assertRaisesRegex(ValueError, 'Reused source'):
            self.collector.submit_frame(self.image, 'A', 3)

    def test_first_result_is_private_and_second_publishes(self):
        self.collector.submit_frame(self.image, 'first', 1)
        wait_for(lambda: self.collector.get_latest()['frame_id'] == '00000000000000000001')
        first = self.collector.get_latest()
        self.assertEqual(first['state'], 'unknown')
        self.assertFalse(first['value']['accepted_frame'])
        self.assertEqual(first['value']['regions'], {})
        self.assertEqual(first['value']['active_seats'], [])
        self.assertNotIn('currency_context', first['value'])
        self.collector.submit_frame(self.image, 'second', 2)
        wait_for(lambda: self.collector.get_latest()['frame_id'] == '00000000000000000002')
        second = self.collector.get_latest()
        self.assertEqual(second['state'], 'available')
        self.assertEqual(second['value']['regions']['seats[0].bank']['decision']['text'], 'G 1 BB')
