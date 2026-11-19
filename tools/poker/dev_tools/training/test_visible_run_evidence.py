from copy import deepcopy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from PIL import Image

from export_reviewed_dataset import export_datasets
from lab_training_curriculum import stage_recipe
from prepare_named_collection_training import collection_rows, prepare_records, write_recipe
from visible_run_evidence import NEUTRAL, pixel_hash


def png(image):
    output = BytesIO()
    image.save(output, format='PNG')
    return output.getvalue()


class VisibleRunTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.directory = self.root / 'dataset'
        (self.directory / 'full_captures').mkdir(parents=True)
        (self.directory / 'references').mkdir()
        self.full = Image.new('RGB', (1920, 1080), NEUTRAL)
        self.full.paste((240, 240, 240), (32, 43, 35, 48))
        self.full.paste((240, 240, 240), (40, 43, 41, 48))
        self.raw = png(self.full)
        (self.directory / 'full_captures/frame.png').write_bytes(self.raw)
        (self.directory / 'references/baseline.png').write_bytes(self.raw)
        self.clean = self.full.copy()
        self.clean.paste((240, 240, 240), (40, 43, 43, 48))
        self.save_reference()
        self.label = '1'
        self.rect = dict(x=30, y=40, w=8, h=12)
        self.evidence = dict(policy='visible_runs_v1', recognition_target='1', source_label='12',
            parent_region_id='seats[0].bet', parent_rect=dict(x=30, y=40, w=12, h=12),
            run_rect=dict(x=0, y=0, width=8, height=12), coverage_rle=[[16, 96]],
            neutral_rgb=list(NEUTRAL), left_boundary='closed', right_boundary='open',
            extractor_sha256='c' * 64, current_capture_sha256=hashlib.sha256(self.raw).hexdigest(),
            oracle=dict(policy='controlled_renderer_glyph_visibility_v1',
                complete_target_ink_verified=True, foreign_ink_removed=True,
                baseline_capture_sha256=hashlib.sha256(self.raw).hexdigest(),
                baseline_reference_screenshot='references/baseline.png',
                baseline_reference_sha256=hashlib.sha256(self.raw).hexdigest(),
                baseline_match_policy='exact_parent_pixels_same_source_value', baseline_source_label='12',
                parent_raw_pixel_sha256=pixel_hash(self.full.crop((30, 40, 42, 52))),
                reference_screenshot='references/clean.png', reference_sha256=self.reference_hash,
                reference_parent_rect=dict(x=30, y=40, w=14, h=12),
                glyphs=[dict(source_index=0, character='1', retained=True, rect=dict(x=2, y=3, w=3, h=5)),
                        dict(source_index=1, character='2', retained=False, rect=dict(x=10, y=3, w=3, h=5))]))
        self.connection = sqlite3.connect(self.directory / 'data.db')
        self.addCleanup(self.connection.close)
        self.connection.executescript('''
            CREATE TABLE synthetic_regions(id INTEGER PRIMARY KEY,filename TEXT,label TEXT,region_id TEXT,
                source_id INTEGER,timestamp INTEGER,x INTEGER,y INTEGER,w INTEGER,h INTEGER);
            CREATE TABLE full_captures(id INTEGER PRIMARY KEY,filename TEXT,monitor TEXT,timestamp INTEGER,regions_hash TEXT);
            CREATE TABLE synthetic_ground_truth(filename TEXT PRIMARY KEY,region_id TEXT,label TEXT,
                image_sha256 TEXT,pixel_sha256 TEXT,capture_sha256 TEXT,renderer_sha256 TEXT,state_json TEXT);
            INSERT INTO full_captures VALUES(1,'frame.png','offline',1000,'regions');
        ''')
        self.export_count = 0
        self.sync()

    def save_reference(self):
        raw = png(self.clean)
        (self.directory / 'references/clean.png').write_bytes(raw)
        self.reference_hash = hashlib.sha256(raw).hexdigest()

    def sync(self):
        r = self.rect
        crop = self.full.crop((r['x'], r['y'], r['x'] + r['w'], r['y'] + r['h']))
        raw = png(crop)
        self.evidence['pixel_sha256'] = pixel_hash(crop)
        state = dict(schema_version=2, generator='poker-offline-renderer', renderer_sha256='b' * 64,
            labels={'seats[0].bet': self.label}, regions={'seats[0].bet': r},
            recognition_task='visible_run', visible_run=self.evidence)
        self.connection.execute('DELETE FROM synthetic_regions')
        self.connection.execute('DELETE FROM synthetic_ground_truth')
        self.connection.execute('INSERT INTO synthetic_regions VALUES(1,?,?,?,?,?,?,?,?,?)',
            ('run.png', self.label, 'seats[0].bet', 1, 1000, r['x'], r['y'], r['w'], r['h']))
        self.connection.execute('INSERT INTO synthetic_ground_truth VALUES(?,?,?,?,?,?,?,?)',
            ('run.png', 'seats[0].bet', self.label, hashlib.sha256(raw).hexdigest(), pixel_hash(crop),
             hashlib.sha256(self.raw).hexdigest(), 'b' * 64, json.dumps(state)))
        self.connection.commit()

    def export(self):
        self.export_count += 1
        output = self.root / f'export-{self.export_count}'
        summary = export_datasets([dict(id='a' * 32, name='Runs', directory=self.directory)], output)
        return json.loads((output / 'samples.jsonl').read_text()), summary, output

    def assert_rejected(self):
        row, summary, _ = self.export()
        self.assertFalse(row['synthetic_evidence_valid'])
        self.assertFalse(row['eligible_for_training'])
        self.assertEqual(summary['counts']['training_candidates'], 0)

    def test_visible_transcript_is_trainable_without_becoming_complete_amount(self):
        row, summary, output = self.export()
        self.assertEqual(summary['counts']['training_candidates'], 1)
        self.assertEqual(row['label'], '1')
        self.assertEqual(row['synthetic_ground_truth']['source_label'], '12')
        self.assertEqual(row['recognition_task'], 'visible_run')
        self.assertFalse(row['semantic_schema_valid'])
        self.assertFalse(row['automatic_schema_valid'])
        self.assertTrue(row['recognition_contract_valid'])
        selected, blocked, _ = collection_rows(output)
        prepared, quarantine, _, _ = prepare_records([], selected, blocked)
        self.assertEqual([(r['label'], r['split']) for r in prepared], [('1', 'train')])
        self.assertEqual(quarantine, [])

    def test_full_hidden_label_is_rejected_even_if_annotation_and_hashes_are_updated(self):
        self.label = self.evidence['recognition_target'] = '12'
        self.evidence['oracle']['glyphs'][1]['retained'] = True
        self.sync()
        self.assert_rejected()

    def test_clean_reference_must_include_hidden_extent_of_a_cut_glyph(self):
        self.label = self.evidence['recognition_target'] = '12'
        self.evidence['oracle']['glyphs'][1]['retained'] = True
        self.rect['w'] = self.evidence['run_rect']['width'] = 12
        self.evidence['coverage_rle'] = [[16, 144]]
        self.sync()
        self.assert_rejected()

    def test_remaining_unlabeled_partial_glyph_is_rejected(self):
        self.rect['w'] = self.evidence['run_rect']['width'] = 12
        self.evidence['coverage_rle'] = [[16, 144]]
        self.sync()
        self.assert_rejected()

    def test_different_hidden_completions_have_identical_inputs_and_targets(self):
        first, _, first_output = self.export()
        self.evidence['source_label'] = self.evidence['oracle']['baseline_source_label'] = '13'
        self.evidence['oracle']['glyphs'][1]['character'] = '3'
        self.clean.putpixel((42, 45), NEUTRAL)
        self.save_reference()
        self.evidence['oracle']['reference_sha256'] = self.reference_hash
        self.sync()
        second, _, second_output = self.export()
        self.assertTrue(first['eligible_for_training'] and second['eligible_for_training'])
        self.assertEqual(first['label'], second['label'])
        self.assertEqual((first_output / first['image']).read_bytes(), (second_output / second['image']).read_bytes())

    def test_hidden_target_never_becomes_blank_training_control(self):
        self.label = self.evidence['recognition_target'] = ''
        for glyph in self.evidence['oracle']['glyphs']:
            glyph['retained'] = False
        self.sync()
        self.assert_rejected()

    def test_reference_hash_and_parent_alias_pixels_are_verified(self):
        changed = self.full.copy()
        changed.putpixel((32, 43), NEUTRAL)
        raw = png(changed)
        (self.directory / 'references/baseline.png').write_bytes(raw)
        self.evidence['oracle']['baseline_capture_sha256'] = hashlib.sha256(raw).hexdigest()
        self.evidence['oracle']['baseline_reference_sha256'] = hashlib.sha256(raw).hexdigest()
        self.sync()
        self.assert_rejected()

    def test_malformed_coverage_never_reaches_training(self):
        self.evidence['coverage_rle'] = [[16, 95]]
        self.sync()
        self.assert_rejected()

    def inject_foreign_pixel(self, color):
        self.full.putpixel((36, 44), color)
        self.raw = png(self.full)
        (self.directory / 'full_captures/frame.png').write_bytes(self.raw)
        (self.directory / 'references/baseline.png').write_bytes(self.raw)
        sha = hashlib.sha256(self.raw).hexdigest()
        self.evidence['current_capture_sha256'] = sha
        self.evidence['oracle'].update(baseline_capture_sha256=sha, baseline_reference_sha256=sha,
            parent_raw_pixel_sha256=pixel_hash(self.full.crop((30, 40, 42, 52))))
        self.sync()

    def test_foreign_white_text_outside_source_glyphs_is_rejected(self):
        self.inject_foreign_pixel((240, 240, 240))
        self.assert_rejected()

    def test_currency_artwork_cannot_be_left_without_a_target(self):
        self.inject_foreign_pixel((250, 205, 0))
        self.assert_rejected()

    def test_both_tsv_writers_use_observed_target_and_reject_source_label_substitution(self):
        _, _, output = self.export()
        selected, blocked, _ = collection_rows(output)
        prepared, _, _, _ = prepare_records([], selected, blocked)
        prepared[0]['image_path'] = prepared[0]['source_image']
        records = [prepared[0], dict(prepared[0], split='val')]
        template = dict(Global={}, Optimizer={'lr': {}}, Metric={})
        template.update({key: {'dataset': {'transforms': []}, 'loader': {}} for key in ('Train', 'Eval')})
        path = self.root / 'template.yml'
        path.write_text(json.dumps(template))
        (self.root / 'weights').write_text('fixture')
        (self.root / 'dictionary').write_text('1\n2\n')
        recipe = self.root / 'recipe'
        write_recipe(recipe, records, path, self.root / 'weights', self.root / 'dictionary',
                     name_only=False, epochs=1, batch_size=2, seed=1)
        curriculum = self.root / 'curriculum'
        stage = dict(seed=1, epochs=1, learning_rate=1e-5)
        stage_recipe(self.root, curriculum, stage, records, path, self.root / 'weights', self.root / 'dictionary')
        for folder in (recipe, curriculum):
            self.assertEqual((folder / 'train.txt').read_text().split('\t')[1].strip(), '1')
        changed = deepcopy(records)
        changed[0]['label'] = '12'
        with self.assertRaisesRegex(ValueError, 'storage contract'):
            write_recipe(recipe, changed, path, self.root / 'weights', self.root / 'dictionary',
                         name_only=False, epochs=1, batch_size=2, seed=1)
        with self.assertRaisesRegex(ValueError, 'verified transcript'):
            stage_recipe(self.root, curriculum, stage, changed, path, self.root / 'weights', self.root / 'dictionary')
