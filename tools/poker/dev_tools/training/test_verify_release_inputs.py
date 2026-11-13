import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from verify_release_candidate import release_inputs


class ReleaseInputTests(unittest.TestCase):
    def test_candidate_roles_and_geometry_come_from_requested_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            external = root / 'external-names'
            runtime = {'general_model': 'models/new-general', 'name_model': str(external),
                       'regions': 'candidate-regions.json', 'colors': 'candidate-colors.json'}
            (root / 'runtime.json').write_text(json.dumps(runtime))
            (root / 'candidate-regions.json').write_text('{"screen_width": 1234}')
            (root / 'candidate-colors.json').write_text('{"candidate": "#abcdef"}')
            paths, regions, colors, digest = release_inputs(root)
            self.assertEqual(paths['general_model'], root / 'models/new-general')
            self.assertEqual(paths['name_model'], external)
            self.assertEqual(regions, {'screen_width': 1234})
            self.assertEqual(colors, {'candidate': '#abcdef'})
            self.assertEqual(digest, hashlib.sha256((root / 'runtime.json').read_bytes()).hexdigest())

    def test_missing_candidate_config_never_falls_back_to_repository_defaults(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'runtime.json').write_text(json.dumps({
                'general_model': 'models/general', 'name_model': 'models/names',
                'regions': 'absent.json', 'colors': 'colors.json'}))
            with self.assertRaises(FileNotFoundError):
                release_inputs(root)


if __name__ == '__main__':
    unittest.main()
