import unittest

from collect_fresh_holdout import png_geometry, region_index


class CaptureHelpersTest(unittest.TestCase):
    def test_png_geometry_and_invalid_header(self):
        png = b'\x89PNG\r\n\x1a\n' + (13).to_bytes(4, 'big') + b'IHDR' + (1920).to_bytes(4, 'big') + (1080).to_bytes(4, 'big')
        self.assertEqual(png_geometry(png), (1920, 1080))
        with self.assertRaises(ValueError):
            png_geometry(b'not png')

    def test_index_keeps_all_seats_without_model_selection(self):
        rect = {'x': 1, 'y': 2, 'w': 3, 'h': 4}
        self.assertEqual(list(region_index({'seats': [{'name': rect}, {'name': rect}]})), [
            {'region_id': 'seats[0].name', 'rect': rect},
            {'region_id': 'seats[1].name', 'rect': rect},
        ])


if __name__ == '__main__':
    unittest.main()
