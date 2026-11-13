"""Synthetic negative controls for the experimental pixel-only policy."""
import unittest
import numpy as np
from seat_admission_candidate import assess_seats


COLORS = {'nameplate': '#192a35', 'in_turn': '#8900f2', 'in_turn_urgent': '#e13e5e'}


class SeatAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.frame = np.full((120, 240, 3), [35, 30, 25], dtype=np.uint8)
        self.config = {'screen_width': 240, 'screen_height': 120, 'seats': [
            {'nameplate': {'x': 10, 'y': 10, 'w': 216, 'h': 96},
             'name': {'x': 14, 'y': 15, 'w': 204, 'h': 32}}]}

    def assess(self):
        return assess_seats(self.frame, self.config, COLORS)

    def plate(self, color=(56, 44, 26)):
        self.frame[10:106, 10:226] = color

    def name(self, color=(211, 186, 177)):
        # Separate bars emulate glyph holes without relying on any OCR engine.
        for x in range(55, 170, 9):
            self.frame[21:38, x:x+4] = color

    def test_rendered_normal_and_brightness_shifted_turn(self):
        for color in [(56, 44, 26), (255, 0, 144), (94, 62, 225)]:
            self.plate(color)
            self.name()
            result = self.assess()
            self.assertEqual(result['active_seats'], [0])
            self.assertEqual(result['name_eligible_seats'], [0])
            self.assertTrue(result['frame_eligible'])

    def test_countdown_split_joins_normal_and_turn_fields(self):
        for end in (25, 100, 210):
            self.plate()
            self.frame[10:106, 10:end] = [255, 0, 144]
            self.name()
            self.assertEqual(self.assess()['active_seats'], [0])

    def test_active_colored_card_fragment_cannot_admit_dimmed_plate(self):
        self.frame[20:45, 30:110] = [53, 42, 25]
        self.assertEqual(self.assess()['active_seats'], [])
        self.assertFalse(self.assess()['frame_eligible'])

    def test_timer_strip_cannot_admit_dimmed_plate(self):
        self.frame[10:20, 10:226] = [255, 0, 144]
        self.assertEqual(self.assess()['active_seats'], [])

    def test_broad_but_disconnected_text_cannot_admit_plate(self):
        for y in range(10, 106, 8):
            for x in range(10, 226, 8):
                self.frame[y:y+4, x:x+4] = [56, 44, 26]
        self.assertEqual(self.assess()['active_seats'], [])

    def test_dimmed_palette_cannot_be_arbitrarily_rescaled(self):
        self.plate((39, 31, 18))
        self.name((105, 93, 88))
        self.assertEqual(self.assess()['active_seats'], [])

    def test_green_result_marker_only_blocks_name(self):
        self.plate()
        self.name((0, 255, 0))
        result = self.assess()
        self.assertEqual(result['active_seats'], [0])
        self.assertEqual(result['name_eligible_seats'], [])
        self.assertEqual(result['seats'][0]['name_reason'], 'colored_result_marker')
        # The algorithm never sees the characters: any normal gray glyphs pass.
        self.plate()
        self.name()
        self.assertEqual(self.assess()['name_eligible_seats'], [0])

    def test_single_narrow_name_glyph_is_eligible(self):
        for width in (2, 3, 5):
            self.plate()
            self.frame[22:33, 115:115+width] = [211, 186, 177]
            self.assertEqual(self.assess()['name_eligible_seats'], [0])

    def test_isolated_neutral_speck_is_unknown(self):
        self.plate()
        self.frame[25:28, 115:119] = [211, 186, 177]
        self.assertEqual(self.assess()['name_eligible_seats'], [])

    def test_same_color_modal_panel_does_not_masquerade_as_plate(self):
        self.frame[:] = [56, 44, 26]
        self.name()
        result = self.assess()
        self.assertEqual(result['active_seats'], [])
        self.assertEqual(result['seats'][0]['reason'], 'oversized_palette_field')

    def test_empty_name_has_no_proven_foreground(self):
        self.plate()
        self.assertEqual(self.assess()['active_seats'], [0])
        self.assertEqual(self.assess()['name_eligible_seats'], [])

    def test_wrong_channel_order_and_empty_image_fail_closed(self):
        self.plate((26, 44, 56))
        self.assertEqual(self.assess()['active_seats'], [])
        self.assertFalse(assess_seats(np.zeros((0, 0, 3), dtype=np.uint8), self.config, COLORS)['valid_input'])

    def test_invalid_geometry_and_colors_fail_closed(self):
        self.plate()
        self.config['seats'][0]['nameplate']['x'] = -1
        self.assertEqual(self.assess()['active_seats'], [])
        self.assertFalse(assess_seats(self.frame, self.config, {},)['valid_input'])
        self.config['screen_width'] = 239
        self.assertFalse(self.assess()['valid_input'])

    def test_name_outside_plate_cannot_borrow_card_foreground(self):
        self.plate()
        self.config['seats'][0]['name']['y'] = 1
        self.assertEqual(self.assess()['active_seats'], [0])
        self.assertEqual(self.assess()['name_eligible_seats'], [])


if __name__ == '__main__':
    unittest.main()
