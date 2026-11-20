from copy import deepcopy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw

from export_reviewed_dataset import _synthetic_evidence
from name_display_evidence import verify_name_display


class NameDisplayEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.image = Image.new('RGB', (40, 20), (15, 33, 46))
        draw = ImageDraw.Draw(self.image)
        glyphs = [dict(x=4 + i * 6, y=4, w=5, h=12) for i in range(4)]
        for glyph in glyphs:
            draw.rectangle((glyph['x'], 4, glyph['x'] + 4, 15), fill='white')
        self.raw = self.png(self.image)
        self.source_sha = hashlib.sha256(self.raw).hexdigest()
        (self.root / 'reference.png').write_bytes(self.raw)
        blank = self.png(Image.new('RGB', (40, 20), (15, 33, 46)))
        (self.root / 'blank.png').write_bytes(blank)
        self.rect = dict(x=2, y=2, w=36, h=16)
        self.pixel_sha = hashlib.sha256(b'36x16:RGB:' + self.image.crop((2, 2, 38, 18)).tobytes()).hexdigest()
        self.proof = dict(schema_version=1, policy='css_ellipsis_literal_reference_v1',
                          source_username='Aa1B2', visible_prefix='Aa1', rendered_text='Aa1…',
                          recognition_target='Aa1...', normalization='unicode_ellipsis_to_three_periods',
                          source_capture_sha256=self.source_sha, reference_screenshot='reference.png',
                          reference_capture_sha256=self.source_sha, crop_rect=self.rect,
                          blank_reference_screenshot='blank.png', blank_reference_capture_sha256=hashlib.sha256(blank).hexdigest(),
                          crop_rgb_sha256=self.pixel_sha,
                          literal_reference=dict(text='Aa1…', text_overflow='clip', overflow_x='visible',
                              white_space='nowrap', direction='ltr', text_align='left', fully_visible=True,
                              physical_clipping_excluded=True, overlays_excluded=True,
                              ink_fully_visible=True, ancestor_clipping_disabled=True,
                              element_rect=dict(x=3, y=3, w=34, h=14),
                              content_rect=dict(x=4, y=4, w=32, h=12), glyph_rects=glyphs))

    @staticmethod
    def png(image):
        stream = BytesIO()
        image.save(stream, format='PNG')
        return stream.getvalue()

    def verify(self, proof=None, label='Aa1...'):
        return verify_name_display(self.image, self.rect, proof or self.proof, label,
                                   self.root, self.source_sha, 'Aa1B2')

    def test_accepts_exact_unclipped_literal_and_preserves_hidden_source_as_provenance(self):
        result = self.verify()
        self.assertTrue(result['name_display_verified'])
        self.assertEqual(result['recognition_target'], 'Aa1...')
        self.assertEqual(result['source_username'], 'Aa1B2')
        with self.assertRaisesRegex(ValueError, 'visible target'):
            self.verify(label='Aa1B2')

    def test_rejects_clipped_reference_even_when_its_pixels_match(self):
        proof = deepcopy(self.proof)
        proof['literal_reference']['text_overflow'] = 'ellipsis'
        with self.assertRaisesRegex(ValueError, 'unclipped literal'):
            self.verify(proof)
        proof = deepcopy(self.proof)
        proof['literal_reference']['glyph_rects'][-1]['x'] = 39
        with self.assertRaisesRegex(ValueError, 'glyph is clipped'):
            self.verify(proof)

    def test_font_metrics_may_exceed_content_but_actual_ink_must_fit(self):
        proof = deepcopy(self.proof)
        proof['literal_reference']['glyph_rects'][0].update(y=3, h=13)
        self.assertTrue(self.verify(proof)['name_display_verified'])
        proof['literal_reference']['content_rect']['y'] = 5
        proof['literal_reference']['content_rect']['h'] = 11
        with self.assertRaisesRegex(ValueError, 'literal ink is clipped'):
            self.verify(proof)

    def test_rejects_changed_reference_pixels_even_with_updated_file_hash(self):
        changed = self.image.copy()
        changed.putpixel((5, 5), (0, 0, 0))
        raw = self.png(changed)
        (self.root / 'reference.png').write_bytes(raw)
        self.proof['reference_capture_sha256'] = hashlib.sha256(raw).hexdigest()
        with self.assertRaisesRegex(ValueError, 'pixels differ'):
            self.verify()

    def test_rejects_reference_ink_below_crop_even_when_crop_pixels_match(self):
        changed = self.image.copy()
        changed.putpixel((5, 18), (255, 255, 255))
        raw = self.png(changed)
        (self.root / 'reference.png').write_bytes(raw)
        self.proof['reference_capture_sha256'] = hashlib.sha256(raw).hexdigest()
        with self.assertRaisesRegex(ValueError, 'outside the crop'):
            self.verify()

    def test_target_blank_preserves_other_name_ink_outside_its_crop(self):
        self.image.putpixel((5, 18), (255, 255, 255))
        raw = self.png(self.image)
        (self.root / 'reference.png').write_bytes(raw)
        self.source_sha = hashlib.sha256(raw).hexdigest()
        self.proof.update(source_capture_sha256=self.source_sha, reference_capture_sha256=self.source_sha)
        with self.assertRaisesRegex(ValueError, 'outside the crop'):
            self.verify()
        blank = Image.new('RGB', self.image.size, (15, 33, 46))
        blank.putpixel((5, 18), (255, 255, 255))
        raw = self.png(blank)
        (self.root / 'blank.png').write_bytes(raw)
        self.proof['blank_reference_capture_sha256'] = hashlib.sha256(raw).hexdigest()
        self.assertTrue(self.verify()['name_display_verified'])

    def test_rejects_wrong_prefix_and_reference_path_escape(self):
        proof = deepcopy(self.proof)
        proof['visible_prefix'] = 'Aa2'
        with self.assertRaisesRegex(ValueError, 'visible target'):
            self.verify(proof)
        proof = deepcopy(self.proof)
        proof['reference_screenshot'] = '../reference.png'
        with self.assertRaisesRegex(ValueError, 'escapes'):
            self.verify(proof)

    def test_exporter_binds_display_proof_to_the_source_seat(self):
        (self.root / 'full_captures').mkdir()
        (self.root / 'full_captures/frame.png').write_bytes(self.raw)
        state = dict(schema_version=1, generator='poker-offline-renderer', renderer_sha256='a' * 64,
                     labels={'seats[0].name': 'Aa1...'}, regions={'seats[0].name': self.rect},
                     state=dict(seats=[dict(name='Aa1B2')]), display_truncations={'seats[0].name': self.proof})
        row = dict(source_saved_filename='name.png', region_id='seats[0].name', category='name', label='Aa1...',
                   image_sha256='b' * 64, pixel_sha256=self.pixel_sha,
                   provenance=dict(crop_rect=self.rect, source_capture_filename='frame.png'))
        evidence = dict(filename='name.png', region_id=row['region_id'], label=row['label'],
                        image_sha256=row['image_sha256'], pixel_sha256=self.pixel_sha,
                        capture_sha256=self.source_sha, renderer_sha256='a' * 64, state_json=json.dumps(state))
        self.assertTrue(_synthetic_evidence(row, evidence, self.root, {})['name_display_verified'])
        state['state']['seats'][0]['name'] = 'Different'
        evidence['state_json'] = json.dumps(state)
        with self.assertRaisesRegex(ValueError, 'source or visible target'):
            _synthetic_evidence(row, evidence, self.root, {})


if __name__ == '__main__':
    unittest.main()
