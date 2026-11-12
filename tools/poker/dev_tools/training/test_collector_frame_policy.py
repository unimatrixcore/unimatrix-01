"""Exercise traversal around realistic bounded plates without running OCR."""
import unittest
import numpy as np
from collector_frame_policy import plan_frame_regions

COLORS = {'nameplate': '#192a35', 'in_turn': '#8900f2', 'in_turn_urgent': '#e13e5e'}


def rounded_plate(frame, rect, color=(56, 44, 26), radius=8):
    """Render a bounded rounded field with neutral glyphs added separately."""
    x, y, w, h = (rect[k] for k in ('x', 'y', 'w', 'h'))
    yy, xx = np.ogrid[:h, :w]
    nearest_x = np.clip(xx, radius, w - radius - 1)
    nearest_y = np.clip(yy, radius, h - radius - 1)
    mask = (xx - nearest_x) ** 2 + (yy - nearest_y) ** 2 <= radius ** 2
    frame[y:y+h, x:x+w][mask] = color


def name_glyphs(frame, rect, color=(211, 186, 177)):
    x, y, w, h = (rect[k] for k in ('x', 'y', 'w', 'h'))
    margin = 3 if h < 20 else 5
    for offset in range(10, w - 10, 10):
        frame[y+margin:y+h-margin, x+offset:x+offset+4] = color


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.frame = np.full((200, 320, 3), (35, 30, 25), dtype=np.uint8)
        self.config = {'screen_width': 320, 'screen_height': 200,
                       'round_id': {'x': 10, 'y': 10, 'w': 90, 'h': 30},
                       'seats': [{'nameplate': {'x': 10, 'y': 60, 'w': 140, 'h': 90},
                                  'name': {'x': 20, 'y': 70, 'w': 120, 'h': 25},
                                  'bank': {'x': 20, 'y': 100, 'w': 120, 'h': 25},
                                  'cards': [{'x': 20, 'y': 45, 'w': 30, 'h': 12}],
                                  'bet': {'x': 20, 'y': 160, 'w': 70, 'h': 20}},
                                 {'nameplate': {'x': 170, 'y': 60, 'w': 140, 'h': 90},
                                  'name': {'x': 180, 'y': 70, 'w': 120, 'h': 25},
                                  'bank': {'x': 180, 'y': 100, 'w': 120, 'h': 25},
                                  'bet': {'x': 180, 'y': 160, 'w': 70, 'h': 20}}],
                       'community_cards': [[{'x': 110, 'y': 10, 'w': 30, 'h': 20}]],
                       'note': {'x': 10, 'y': 10, 'w': 20, 'h': 20},
                       'mystery': {'x': 10, 'y': 10, 'w': 20, 'h': 20}}
        self.decision = {'state': 'text', 'text': '#123456'}
        self.paint_seat(0)

    def paint_seat(self, index, color=(56, 44, 26), foreground=(211, 186, 177)):
        seat = self.config['seats'][index]
        rounded_plate(self.frame, seat['nameplate'], color)
        name_glyphs(self.frame, seat['name'], foreground)

    def run_policy(self):
        return plan_frame_regions(self.frame, self.config, COLORS, self.decision)

    def ids(self):
        return {row['region_id'] for row in self.run_policy()['regions']}

    def test_game_id_gate_preserves_schema_rejection(self):
        for decision in ({'state': 'blank', 'text': ''}, {'state': 'text', 'text': 'x#123456'},
                         {'state': 'text', 'text': '#12345'}):
            self.decision = decision
            result = self.run_policy()
            self.assertFalse(result['accepted_frame'])
            self.assertEqual(result['regions'], [])
            self.assertEqual(result['rejected'][0]['reason'], 'invalid_game_id')

    def test_dimensions_round_id_and_plate_geometry_retain_causes(self):
        self.config['screen_width'] = 321
        self.assertEqual(self.run_policy()['rejected'][0]['reason'], 'screen_dimensions_mismatch')
        self.config['screen_width'] = 320
        original = self.config['round_id']
        self.config['round_id'] = {'x': 319, 'y': 0, 'w': 2, 'h': 1}
        self.assertEqual(self.run_policy()['rejected'][0]['reason'], 'invalid_round_id_geometry')
        self.config['round_id'] = original
        self.config['seats'][0]['nameplate']['x'] = -1
        result = self.run_policy()
        self.assertEqual(result['regions'], [])
        self.assertEqual(result['rejected'], [{'region_id': 'seats[0].nameplate', 'reason': 'invalid_geometry'}])

    def test_palette_and_seat_validation_retain_causes(self):
        for invalid in ({}, {'nameplate': 'bad', 'in_turn': '#8900f2', 'in_turn_urgent': '#e13e5e'}):
            result = plan_frame_regions(self.frame, self.config, invalid, self.decision)
            self.assertEqual(result['rejected'][0]['reason'], 'invalid_colors')
        self.config['seats'] = 'invalid'
        self.assertEqual(self.run_policy()['rejected'][0]['reason'], 'invalid_seats')
        self.config['seats'] = ['invalid']
        self.assertEqual(self.run_policy()['rejected'][0]['reason'], 'invalid_seat')

    def test_rendered_normal_turn_and_urgent_fields_admit(self):
        for color in ((56, 44, 26), (255, 0, 144), (94, 62, 225)):
            with self.subTest(color=color):
                self.frame[:] = (35, 30, 25)
                self.paint_seat(0, color)
                result = self.run_policy()
                self.assertTrue(result['accepted_frame'])
                self.assertEqual(result['active_seats'], [0])
                self.assertEqual(result['name_eligible_seats'], [0])
                ids = {row['region_id'] for row in result['regions']}
                self.assertIn('seats[0].name', ids)
                self.assertIn('seats[0].bank', ids)
                self.assertIn('community_cards[0][0]', ids)
                self.assertNotIn('note', ids)
                self.assertNotIn('seats[0].nameplate', ids)
                self.assertIn({'region_id': 'mystery', 'reason': 'unknown_category'}, result['rejected'])

    def test_inactive_seat_keeps_only_bet_when_another_plate_is_proven(self):
        ids = self.ids()
        self.assertIn('seats[1].bet', ids)
        self.assertNotIn('seats[1].name', ids)
        self.assertNotIn('seats[1].bank', ids)

    def test_zero_active_frame_and_plate_colored_modal_fail_closed(self):
        for color in ((0, 0, 0), (56, 44, 26)):
            self.frame[:] = color
            result = self.run_policy()
            self.assertFalse(result['accepted_frame'])
            self.assertEqual(result['regions'], [])
            self.assertEqual(result['rejected'][0]['reason'], 'no_verified_active_seats')

    def test_result_marker_skips_only_name_of_active_seat(self):
        self.frame[:] = (35, 30, 25)
        self.paint_seat(0, foreground=(0, 255, 0))
        result = self.run_policy()
        self.assertEqual(result['active_seats'], [0])
        self.assertEqual(result['name_eligible_seats'], [])
        ids = self.ids()
        self.assertNotIn('seats[0].name', ids)
        self.assertIn('seats[0].bank', ids)
        self.assertIn('seats[0].cards[0]', ids)
        self.assertIn('seats[0].bet', ids)

    def test_unknown_name_foreground_is_not_assumed_to_be_a_name(self):
        self.frame[:] = (35, 30, 25)
        rounded_plate(self.frame, self.config['seats'][0]['nameplate'])
        result = self.run_policy()
        self.assertEqual(result['active_seats'], [0])
        self.assertNotIn('seats[0].name', self.ids())
        self.assertIn('seats[0].bank', self.ids())

    def test_body_geometry_is_validated_even_for_suppressed_name(self):
        self.config['seats'][0]['name']['w'] = 400
        result = self.run_policy()
        self.assertTrue(result['accepted_frame'])
        self.assertIn({'region_id': 'seats[0].name', 'reason': 'invalid_geometry'}, result['rejected'])


if __name__ == '__main__':
    unittest.main()
