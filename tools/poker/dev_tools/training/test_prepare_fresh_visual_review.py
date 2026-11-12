"""Provenance/deduplication controls for the blind fresh-source review pack."""
import ast
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

from prepare_fresh_visual_review import (OFFSETS, build, crop_identity,
    production_input_fingerprint, rectangle_index, verified_inputs)


class FreshVisualReviewTest(unittest.TestCase):
    def test_exact_identity_requires_category_dimensions_and_every_rgb_byte(self):
        first = Image.new('RGB', (4, 3), (10, 20, 30))
        self.assertEqual(crop_identity(first, 'card'), crop_identity(first.copy(), 'card'))
        self.assertNotEqual(crop_identity(first, 'card'), crop_identity(first, 'name'))
        # Same byte sequence reshaped is still a different OCR input.
        reshaped = Image.frombytes('RGB', (3, 4), first.tobytes())
        self.assertNotEqual(crop_identity(first, 'card'), crop_identity(reshaped, 'card'))
        altered = first.copy()
        altered.putpixel((3, 2), (10, 20, 31))
        self.assertNotEqual(crop_identity(first, 'card'), crop_identity(altered, 'card'))

    def test_five_view_key_matches_real_function_without_importing_model_code(self):
        # Execute only the pure upstream function; importing production_reader
        # would unnecessarily import model dependencies into this blind check.
        tree = ast.parse(Path(__file__).with_name('production_reader.py').read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'region_inputs')
        namespace = {'np': np, 'hashlib': hashlib, 'OFFSETS': OFFSETS}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<region_inputs only>', 'exec'), namespace)
        rgb = np.arange(16 * 18 * 3, dtype=np.uint8).reshape(16, 18, 3)
        frame = Image.fromarray(rgb)
        rect = {'x': 4, 'y': 4, 'w': 7, 'h': 5}
        upstream = namespace['region_inputs'](rgb[:, :, ::-1].copy(), rect, 'name')[1]
        self.assertEqual(production_input_fingerprint(frame, rect, 'name'), upstream)
        # A changed shifted-view border must not share the context fingerprint,
        # even when the central crop used for visual deduplication is unchanged.
        shifted = frame.copy()
        shifted.putpixel((2, 4), (1, 2, 3))
        self.assertEqual(frame.crop((4, 4, 11, 9)).tobytes(), shifted.crop((4, 4, 11, 9)).tobytes())
        self.assertNotEqual(production_input_fingerprint(frame, rect, 'name'),
                            production_input_fingerprint(shifted, rect, 'name'))

    def make_session(self, root):
        rect = {'x': 4, 'y': 4, 'w': 4, 'h': 3}
        regions = {'screen_width': 20, 'screen_height': 16, 'round_id': rect,
                   'community_cards': [rect] * 5, 'pot': rect, 'split_pot': rect,
                   'seats': [dict(name=rect, nameplate=rect, bank=rect, bet=rect,
                                  cards=[rect, rect], status=rect, dealer=rect) for _ in range(9)]}
        raw = json.dumps(regions).encode()
        (root / 'regions.json').write_bytes(raw)
        (root / 'crop-index.json').write_text(json.dumps(list(rectangle_index(regions))))
        (root / 'manifest.json').write_text(json.dumps({'session_id': 'unit-test', 'requested_frames': 2,
                                                        'regions_sha256': hashlib.sha256(raw).hexdigest()}))
        (root / 'frames').mkdir()
        captures = []
        for index in range(2):
            filename = f'frames/{index:06d}.png'
            Image.new('RGB', (20, 16), (20, 30, 40)).save(root / filename)
            captures.append({'file': filename, 'sha256': hashlib.sha256((root / filename).read_bytes()).hexdigest(),
                             'source_id': f'source-{index}', 'width': 20, 'height': 16,
                             'captured_at_monotonic': index + 1})
        (root / 'captures.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in captures))
        return captures

    def test_pack_retains_every_occurrence_without_assigning_truth_or_modifying_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            captures = self.make_session(root)
            original = [(root / row['file']).read_bytes() for row in captures]
            inventory = build(root, 2)
            self.assertEqual(inventory['total_occurrences'], 142)
            self.assertEqual(inventory['unique_crops'], 9)
            ids = set()
            occurrence_ids = set()
            for path in (root / 'visual-review').glob('*.jsonl'):
                if path.name == 'frames.jsonl':
                    continue
                for row in map(json.loads, path.read_text().splitlines()):
                    self.assertNotIn(row['id'], ids)
                    ids.add(row['id'])
                    self.assertEqual((row['label'], row['state'], row['visually_reviewed']), ('', '', False))
                    for occurrence in row['occurrences']:
                        self.assertNotIn(occurrence['occurrence_id'], occurrence_ids)
                        occurrence_ids.add(occurrence['occurrence_id'])
                        self.assertEqual(occurrence['admission'], '')
            self.assertEqual(len(occurrence_ids), 142)
            self.assertEqual(original, [(root / row['file']).read_bytes() for row in captures])
            with self.assertRaises(FileExistsError):
                build(root, 2)

    def test_incomplete_or_tampered_source_fails_before_output_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            captures = self.make_session(root)
            with self.assertRaisesRegex(ValueError, 'Expected 120'):
                build(root, 120)
            self.assertFalse((root / 'visual-review').exists())
            Image.new('RGB', (20, 16), (1, 2, 3)).save(root / captures[0]['file'])
            with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                verified_inputs(root, 2)


if __name__ == '__main__':
    unittest.main()
