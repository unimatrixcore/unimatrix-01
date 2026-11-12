"""Admission must revoke current publication before blocked new inference ends."""
import threading
import unittest

from realtime_collector import RealtimeCollector
from test_collector_frame_policy import name_glyphs
from test_latest_frame_worker import wait_for
import test_production_reader as reader_fixture


class CurrentCaptureAdmissionTests(unittest.TestCase):
    def setUp(self):
        fixture = reader_fixture.ReaderTests()
        fixture.setUp()
        self.image, self.regions, self.colors = fixture.image, fixture.regions, fixture.colors
        self.regions['seats'][0]['name'] = {'x': 120, 'y': 72, 'w': 60, 'h': 15}
        self.regions['seats'][0]['cards'] = [{'x': 120, 'y': 48, 'w': 30, 'h': 12}]
        name_glyphs(self.image, self.regions['seats'][0]['name'])

        class Names(reader_fixture.FakeModel):
            def probabilities(self, image):
                self.calls += 1
                return self.emit('User1')

        self.reader = fixture.reader
        self.reader.name_model = Names()
        self.now = [10.]
        self.entered, self.release = threading.Event(), threading.Event()
        read_frame = self.reader.read_frame

        def blocked_read(*args):
            if args[3] == 'blocked':
                self.entered.set()
                if not self.release.wait(2):
                    raise RuntimeError('Test did not release blocked inference')
            return read_frame(*args)

        self.reader.read_frame = blocked_read
        self.collector = RealtimeCollector(None, self.regions, self.colors, reader=self.reader,
                                           clock=lambda: self.now[0], max_age_seconds=1.)

    def tearDown(self):
        self.release.set()
        self.assertTrue(self.collector.close())

    def ready(self):
        for index, captured_at in enumerate((9., 9.5)):
            self.collector.submit_frame(self.image, 'confirmed-' + str(index), captured_at)
            wait_for(lambda: self.collector.get_latest()['frame_id'] == f'{index+1:020d}')
        result = self.collector.get_latest()
        self.assertEqual(result['state'], 'available')
        self.assertEqual(result['value']['regions']['seats[0].name']['decision']['text'], 'User1')
        self.assertEqual(result['value']['regions']['seats[0].bank']['decision']['text'], 'G 1 BB')
        self.assertIn('seats[0].cards[0]', result['value']['regions'])

    def block_new(self):
        self.collector.submit_frame(self.image, 'blocked', 9.8)
        self.assertTrue(self.entered.wait(1))

    def test_green_marker_revokes_only_name_on_current_pixels(self):
        self.ready()
        self.image[72:87, 120:180] = (56, 44, 26)
        name_glyphs(self.image, self.regions['seats'][0]['name'], (0, 255, 0))
        self.block_new()
        result = self.collector.get_latest()
        self.assertEqual(result['state'], 'available')
        self.assertEqual(result['value']['validated_against_capture_id'], 'blocked')
        self.assertEqual(result['value']['active_seats'], [0])
        self.assertNotIn('seats[0].name', result['value']['regions'])
        self.assertEqual(result['value']['regions']['seats[0].bank']['decision']['text'], 'G 1 BB')
        self.assertIn('seats[0].cards[0]', result['value']['regions'])

    def test_zero_plate_new_capture_revokes_whole_old_publication(self):
        self.ready()
        self.image[65:150, 110:210] = (0, 0, 0)
        self.block_new()
        result = self.collector.get_latest()
        self.assertEqual(result['state'], 'unknown')
        self.assertEqual(result['reason'], 'newer_capture_unverified')
        self.assertIsNone(result['value'])

    def test_same_color_modal_rejects_old_body_despite_unchanged_header(self):
        self.ready()
        self.image[:] = (56, 44, 26)
        # Keep all five header views byte-identical: rejection must come from
        # current plate visibility, not a conveniently changed Game ID.
        self.image[8:42, 8:102] = (35, 30, 25)
        self.image[10:40, 10:100] = (20, 0, 0)
        self.block_new()
        result = self.collector.get_latest()
        self.assertEqual(result['state'], 'unknown')
        self.assertEqual(result['reason'], 'newer_capture_unverified')
        self.assertIsNone(result['value'])

    def test_admission_does_not_extend_original_capture_freshness(self):
        self.ready()
        self.block_new()
        self.now[0] = 10.6
        result = self.collector.get_latest()
        self.assertEqual(result['state'], 'unknown')
        self.assertEqual(result['reason'], 'stale')
        self.assertIsNone(result['value'])
        self.assertEqual(result['captured_at'], 9.5)


if __name__ == '__main__':
    unittest.main()
