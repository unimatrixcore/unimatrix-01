import copy
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import shutil
import tempfile
import unittest
from unittest import mock

from PIL import Image

import export_reviewed_dataset as exporter
from export_reviewed_dataset import _decode_png, deduplicate_training_rows, export_dataset, export_datasets
from prepare_named_collection_training import collection_rows, prepare_records, write_recipe


def png(image):
    output = io.BytesIO()
    image.save(output, format='PNG')
    return output.getvalue()


class SyntheticRendererExportTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.dataset = self.root / 'dataset'
        (self.dataset / 'images').mkdir(parents=True)
        (self.dataset / 'full_captures').mkdir()
        self.dataset_id = 'a' * 32
        self.rect = {'x': 2, 'y': 3, 'w': 12, 'h': 7}
        image = Image.new('RGB', (30, 20), 'black')
        image.paste(Image.new('RGB', (12, 7), 'white'), (2, 3))
        screenshot = png(image)
        crop = png(image.crop((2, 3, 14, 10)))
        (self.dataset / 'full_captures/frame.png').write_bytes(screenshot)
        (self.dataset / 'images/name.png').write_bytes(crop)
        self.state = {'schema_version': 1, 'generator': 'poker-offline-renderer',
                      'renderer_sha256': 'b' * 64, 'labels': {'seats[0].name': 'Il1OO0'},
                      'regions': {'seats[0].name': self.rect}}
        self.connection = sqlite3.connect(self.dataset / 'data.db')
        self.addCleanup(self.connection.close)
        self.connection.executescript('''
            CREATE TABLE images(id INTEGER PRIMARY KEY,filename TEXT,label TEXT,region_id TEXT,
              source_id INTEGER,timestamp INTEGER,x INTEGER,y INTEGER,w INTEGER,h INTEGER);
            CREATE TABLE full_captures(id INTEGER PRIMARY KEY,filename TEXT,monitor TEXT,timestamp INTEGER,regions_hash TEXT);
            CREATE TABLE synthetic_ground_truth(filename TEXT PRIMARY KEY,region_id TEXT,label TEXT,
              image_sha256 TEXT,pixel_sha256 TEXT,capture_sha256 TEXT,renderer_sha256 TEXT,state_json TEXT);
            INSERT INTO full_captures VALUES(1,'frame.png','offline',1000,'regions');
            INSERT INTO images VALUES(1,'name.png','Il1OO0','seats[0].name',1,1000,2,3,12,7);
        ''')
        image_hash, pixel_hash, _ = _decode_png(crop)
        self.connection.execute('INSERT INTO synthetic_ground_truth VALUES(?,?,?,?,?,?,?,?)',
                                ('name.png', 'seats[0].name', 'Il1OO0', image_hash, pixel_hash,
                                 hashlib.sha256(screenshot).hexdigest(), 'b' * 64, json.dumps(self.state)))
        self.connection.commit()

    def export(self):
        output = self.root / 'export'
        summary = export_datasets([{'id': self.dataset_id, 'name': 'Renderer', 'directory': self.dataset}], output)
        row = json.loads((output / 'samples.jsonl').read_text())
        return row, summary

    def assert_rejected(self):
        self.connection.commit()
        row, summary = self.export()
        self.assertFalse(row['eligible_for_training'])
        self.assertFalse(row['synthetic_evidence_valid'])
        self.assertEqual(summary['counts']['training_candidates'], 0)
        self.assertIn('invalid_synthetic_renderer_evidence', row['training_eligibility_limitations'])

    def cash(self, label='S 125.25', region='seats[0].bank', currency='SC'):
        self.state['labels'] = {region: label}
        self.state['regions'] = {region: self.rect}
        self.state['state'] = {'currency': currency, 'displayInBB': False}
        self.connection.execute('UPDATE images SET region_id=?,label=?', (region, label))
        self.connection.execute('UPDATE synthetic_ground_truth SET region_id=?,label=?,state_json=?',
                                (region, label, json.dumps(self.state)))
        self.connection.commit()

    def full_frame_only(self):
        screenshot = Image.new('RGB', (1920, 1080), 'black')
        screenshot.paste(Image.new('RGB', (12, 7), 'white'), (2, 3))
        raw = png(screenshot)
        (self.dataset / 'full_captures/frame.png').write_bytes(raw)
        self.connection.execute('ALTER TABLE images RENAME TO synthetic_regions')
        self.connection.execute('UPDATE synthetic_ground_truth SET capture_sha256=?',
                                (hashlib.sha256(raw).hexdigest(),))
        self.connection.commit()
        (self.dataset / 'images/name.png').unlink()
        (self.dataset / 'images').rmdir()

    def test_candidate_dictionary_reopens_only_verified_dictionary_exclusions(self):
        self.cash('S 1,234.5')
        region = 'seats[0].bank'
        self.state['eligible'] = {region: False}
        self.state['exclusions'] = {region: 'outside_current_model_dictionary'}
        self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?', (json.dumps(self.state),))
        self.connection.commit()
        before = (self.dataset / 'data.db').read_bytes()
        dataset = {'id': self.dataset_id, 'directory': self.dataset}
        legacy, _, _ = export_dataset(dataset, self.root / 'legacy', materialize_images=False)
        modern, _, _ = export_dataset(dataset, self.root / 'modern', materialize_images=False,
                                      candidate_profile='punctuation73')
        self.assertFalse(legacy[0]['eligible_for_training'])
        row = modern[0]
        self.assertTrue(row['eligible_for_training'])
        self.assertTrue(row['synthetic_evidence_valid'])
        proof = row['synthetic_ground_truth']
        self.assertFalse(proof['eligible'])
        self.assertFalse(proof['source_eligible'])
        self.assertEqual(proof['exclusion_reason'], 'outside_current_model_dictionary')
        self.assertTrue(proof['candidate_eligible'])
        self.assertTrue(proof['dictionary_only_reassessment'])
        self.assertEqual(proof['candidate_dictionary']['class_count'], 73)
        self.assertEqual(row['label'], 'S 1,234.5')
        self.assertEqual(row['pixel_sha256'], legacy[0]['pixel_sha256'])
        self.assertEqual(before, (self.dataset / 'data.db').read_bytes())

    def test_candidate_dictionary_preserves_other_exclusions_and_failed_proofs(self):
        for reason, corrupt, label in [('clipped_or_ellipsized', False, 'S 1,234.5'),
                                       ('outside_current_model_dictionary', True, 'S 1,234.5'),
                                       ('outside_current_model_dictionary', False, 'S 1@234.5')]:
            with self.subTest(reason=reason, corrupt=corrupt, label=label):
                self.cash(label)
                region = 'seats[0].bank'
                self.state['eligible'] = {region: False}
                self.state['exclusions'] = {region: reason}
                self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?,capture_sha256=?',
                    (json.dumps(self.state), '0'*64 if corrupt else hashlib.sha256(
                        (self.dataset / 'full_captures/frame.png').read_bytes()).hexdigest()))
                self.connection.commit()
                rows, _, _ = export_dataset({'id': self.dataset_id, 'directory': self.dataset},
                    self.root / 'rejected', materialize_images=False, candidate_profile='punctuation73')
                self.assertFalse(rows[0]['eligible_for_training'])
                self.assertEqual(rows[0]['synthetic_evidence_valid'], not corrupt)

    def test_candidate_dictionary_keeps_multi_panel_layout_excluded(self):
        self.cash('S 1,234.5 S 6,789.0', 'pot.split')
        self.state['eligible'] = {'pot.split': False}
        self.state['exclusions'] = {'pot.split': 'outside_current_model_dictionary'}
        self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?', (json.dumps(self.state),))
        self.connection.commit()
        output = self.root / 'candidate'
        summary = export_datasets([{'id': self.dataset_id, 'directory': self.dataset}], output,
                                  candidate_profile='punctuation73')
        row = json.loads((output / 'samples.jsonl').read_text())
        self.assertTrue(row['synthetic_ground_truth']['candidate_eligible'])
        self.assertFalse(row['eligible_for_training'])
        self.assertIn('multi_panel_layout_only', row['training_eligibility_limitations'])
        self.assertEqual(summary['counts']['training_candidates'], 0)

    def test_full_screenshot_annotations_are_cropped_only_in_export(self):
        self.full_frame_only()
        before = (self.dataset / 'data.db').read_bytes()
        row, summary = self.export()
        self.assertEqual(summary['counts']['training_candidates'], 1)
        self.assertEqual(summary['datasets'][0]['saved_image_rows'], 0)
        self.assertEqual(summary['datasets'][0]['synthetic_region_rows'], 1)
        self.assertTrue((self.root / 'export' / row['image']).is_file())
        with Image.open(self.root / 'export' / row['image']) as crop:
            self.assertEqual(crop.size, (12, 7))
            self.assertEqual(crop.convert('RGB').getpixel((0, 0)), (255, 255, 255))
        self.assertFalse((self.dataset / 'images').exists())
        self.assertEqual((self.dataset / 'data.db').read_bytes(), before)

    def test_full_screenshot_cash_annotations_keep_context_in_preparation(self):
        self.cash()
        self.full_frame_only()
        row, summary = self.export()
        self.assertEqual(summary['counts']['training_candidates'], 1)
        self.assertEqual(row['currency_format'], '{0}')
        rows, blocked, _ = collection_rows(self.root / 'export')
        prepared, _, _, _ = prepare_records([], rows, blocked)
        self.assertEqual(prepared[0]['split'], 'train')
        self.assertEqual(prepared[0]['currency_format'], '{0}')

    def test_full_screenshot_requires_declared_1920x1080_geometry(self):
        self.connection.execute('ALTER TABLE images RENAME TO synthetic_regions')
        self.connection.commit()
        self.assert_rejected()

    def test_full_screenshot_invalid_crop_rectangle_is_rejected(self):
        self.full_frame_only()
        self.connection.execute('UPDATE synthetic_regions SET x=1919')
        self.assert_rejected()

    def test_full_screenshot_cannot_share_saved_crop_filename(self):
        self.connection.execute('CREATE TABLE synthetic_regions AS SELECT * FROM images')
        self.connection.commit()
        with self.assertRaisesRegex(ValueError, 'cannot share a filename identity'):
            self.export()

    def test_bound_cash_currency_reaches_training_recipe(self):
        self.cash()
        row, summary = self.export()
        self.assertEqual(summary['counts']['training_candidates'], 1)
        self.assertEqual(row['currency_format'], '{0}')
        self.assertFalse(row['needs_contract_review'])
        rows, blocked, _ = collection_rows(self.root / 'export')
        prepared, _, _, _ = prepare_records([], rows, blocked)
        self.assertEqual(prepared[0]['currency_format'], '{0}')
        template = {'Global': {}, 'Optimizer': {'lr': {}}, 'Metric': {}}
        template.update({key: {'dataset': {'transforms': []}, 'loader': {}} for key in ('Train', 'Eval')})
        (self.root / 'template.yml').write_text(json.dumps(template))
        (self.root / 'weights').write_text('fixture')
        (self.root / 'dictionary').write_text('\n'.join(sorted(set('S125.'))))
        records = [prepared[0], dict(prepared[0], split='val')]
        write_recipe(self.root / 'recipe', records, self.root / 'template.yml', self.root / 'weights',
                     self.root / 'dictionary', name_only=False, epochs=1, batch_size=2, seed=1, materialize=False)
        records = [dict(record, currency_format=None) for record in records]
        with self.assertRaisesRegex(ValueError, 'outside the current storage contract'):
            write_recipe(self.root / 'recipe', records, self.root / 'template.yml', self.root / 'weights',
                         self.root / 'dictionary', name_only=False, epochs=1, batch_size=2, seed=1, materialize=False)

    def test_gc_cash_split_pots_use_contextual_format(self):
        self.cash(label='G 1,250 G 0.25', region='split_pot', currency='GC')
        row, summary = self.export()
        self.assertEqual(summary['counts']['training_candidates'], 0)
        self.assertTrue(row['completed_schema_valid'])
        self.assertIn('multi_panel_layout_only', row['training_eligibility_limitations'])

    def test_multi_panel_split_labels_are_layout_inventory_not_recognizer_lines(self):
        for currency, label, bb in [('SC','S 1 BB S 1 BB',True),
                                    ('GC','G 12 BB\nG 40 BB',True),
                                    ('SC','S 1.25 S 40',False),
                                    ('GC','G 1,250\nG 0.25',False)]:
            with self.subTest(label=label):
                shutil.rmtree(self.root / 'export', ignore_errors=True)
                self.cash(label=label, region='pot.split', currency=currency)
                self.state['state']['displayInBB'] = bb
                self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?',(json.dumps(self.state),))
                self.connection.commit()
                row, summary = self.export()
                self.assertTrue(row['synthetic_evidence_valid'])
                self.assertTrue(row['reviewed'])
                self.assertEqual(row['label'],label)
                self.assertEqual(row['recognition_layout']['component_count'],2)
                self.assertFalse(row['eligible_for_training'])
                self.assertEqual(summary['counts']['samples'],1)
                self.assertEqual(summary['counts']['training_candidates'],0)
                self.assertEqual(row['provenance']['split'],'train')
                self.assertTrue(row['provenance']['capture_group'])

    def test_single_and_blank_split_targets_keep_their_existing_admission(self):
        for label, bb in [('S 12 BB',True),('S 12.25',False),('',False)]:
            with self.subTest(label=label):
                shutil.rmtree(self.root / 'export', ignore_errors=True)
                self.cash(label=label,region='split_pot')
                self.state['state']['displayInBB']=bb
                self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?',(json.dumps(self.state),))
                self.connection.commit()
                row,summary=self.export()
                self.assertTrue(row['eligible_for_training'])
                self.assertNotIn('multi_panel_layout_only',row['training_eligibility_limitations'])
                self.assertEqual(summary['counts']['training_candidates'],1)

    def test_layout_only_group_keeps_capture_edges_and_individual_amounts(self):
        self.cash(label='S 1 BB S 2 BB',region='split_pot')
        self.state['state']['displayInBB']=True
        self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?',(json.dumps(self.state),))
        self.connection.commit()
        self.full_frame_only()
        proof=self.connection.execute('SELECT * FROM synthetic_ground_truth').fetchone()
        state=dict(self.state,labels={'pot.0':'S 1 BB'},regions={'pot.0':self.rect})
        self.connection.execute('INSERT INTO synthetic_regions SELECT 2,\'single.png\',\'S 1 BB\',\'pot.0\',source_id,timestamp,x,y,w,h FROM synthetic_regions')
        self.connection.execute('INSERT INTO synthetic_ground_truth VALUES(?,?,?,?,?,?,?,?)',('single.png','pot.0','S 1 BB',*proof[3:7],json.dumps(state)))
        self.connection.commit()
        output=self.root/'export'
        summary=export_datasets([{'id':self.dataset_id,'name':'Renderer','directory':self.dataset}],output)
        rows=[json.loads(line) for line in (output/'samples.jsonl').read_text().splitlines()]
        self.assertEqual(summary['counts']['training_candidates'],1)
        self.assertEqual(len(rows),2)
        self.assertEqual(len({row['provenance']['split_group'] for row in rows}),1)
        self.assertEqual(next(row for row in rows if row['category']=='amount')['eligible_for_training'],True)
        self.assertEqual(next(row for row in rows if row['category']=='split_pot')['eligible_for_training'],False)
        rows[0]['provenance']['split']='test'
        candidates,_,_=deduplicate_training_rows(rows)
        self.assertEqual(candidates,[])
        self.assertTrue(any(row['provenance']['duplicate_capture_groups'] for row in rows))

    def test_full_frame_export_keeps_encoded_crops_bounded_and_queries_proofs_lazily(self):
        self.full_frame_only()
        proof=self.connection.execute('SELECT * FROM synthetic_ground_truth').fetchone()
        for i in range(2,202):
            name=f'generated-{i}.png'
            self.connection.execute('INSERT INTO synthetic_regions SELECT ?,?,label,region_id,source_id,timestamp,x,y,w,h FROM synthetic_regions WHERE id=1',(i,name))
            self.connection.execute('INSERT INTO synthetic_ground_truth VALUES(?,?,?,?,?,?,?,?)',(name,*proof[1:]))
        self.connection.commit()
        live=peak=0
        class TrackedPng(bytes):
            def __new__(cls, raw):
                nonlocal live,peak
                value=super().__new__(cls,raw);live+=1;peak=max(peak,live);return value
            def __del__(self):
                nonlocal live
                live-=1
        original=exporter._synthetic_region_png
        def crop(*args,**kwargs):return TrackedPng(original(*args,**kwargs))
        original_rows=exporter._rows
        def metadata(connection,table):
            self.assertNotEqual(table,'synthetic_ground_truth')
            return original_rows(connection,table)
        with mock.patch.object(exporter,'_synthetic_region_png',side_effect=crop),mock.patch.object(exporter,'_rows',side_effect=metadata):
            rows,_,summary=export_dataset({'id':self.dataset_id,'name':'Renderer','directory':self.dataset},self.root/'export',materialize_images=False)
        self.assertEqual(len(rows),201)
        self.assertTrue(all(row['synthetic_evidence_valid'] for row in rows))
        self.assertEqual(summary['exported_png_files'],0)
        self.assertLessEqual(peak,2)
        self.assertEqual(live,0)

    def test_lazy_synthetic_proofs_keep_the_original_wal_read_snapshot(self):
        self.connection.execute('PRAGMA journal_mode=WAL')
        self.connection.execute('CREATE TABLE snapshot_probe(value INTEGER)')
        self.connection.commit()
        changed=False
        def progress(stage,**values):
            nonlocal changed
            if stage=='validating' and not changed:
                with sqlite3.connect(self.dataset/'data.db') as writer:
                    writer.execute("UPDATE synthetic_ground_truth SET state_json='[]'")
                changed=True
        rows,_,_=export_dataset({'id':self.dataset_id,'name':'Renderer','directory':self.dataset},self.root/'export',progress,False)
        self.assertTrue(changed)
        self.assertTrue(rows[0]['synthetic_evidence_valid'])
        self.assertEqual(self.connection.execute('SELECT state_json FROM synthetic_ground_truth').fetchone()[0],'[]')

    def test_unavailable_saved_png_keeps_its_source_issue_and_invalid_identity(self):
        (self.dataset/'images/name.png').unlink()
        row,summary=self.export()
        self.assertFalse(row['image_integrity_valid'])
        self.assertEqual(summary['datasets'][0]['image_integrity_failures'],1)
        self.assertEqual([issue['filename'] for issue in summary['datasets'][0]['source_read_issues']],['name.png'])

    def test_bb_labels_keep_default_contract(self):
        self.cash(label='S 125.25 BB')
        self.state['state']['displayInBB'] = True
        self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?', (json.dumps(self.state),))
        self.connection.commit()
        row, summary = self.export()
        self.assertEqual(summary['counts']['training_candidates'], 1)
        self.assertNotIn('currency_format', row)

    def test_cash_label_without_bound_rendered_state_is_ineligible(self):
        self.cash()
        self.state.pop('state')
        self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?', (json.dumps(self.state),))
        self.connection.commit()
        row, summary = self.export()
        self.assertEqual(summary['counts']['training_candidates'], 0)
        self.assertTrue(row['needs_contract_review'])

    def test_cash_prefix_must_match_bound_currency(self):
        self.cash(currency='GC')
        self.assert_rejected()

    def test_table_name_currency_letters_are_not_money_prefixes(self):
        self.cash(label='G Table, NLHE - S 0.5/1', region='table.info', currency='SC')
        row, summary = self.export()
        self.assertTrue(row['synthetic_evidence_valid'])
        self.assertEqual(summary['counts']['training_candidates'], 1)

    def test_gc_table_name_currency_letters_are_not_money_prefixes(self):
        self.cash(label='S Table, NLHE - G 5/10', region='table.info', currency='GC')
        row, summary = self.export()
        self.assertTrue(row['synthetic_evidence_valid'])
        self.assertEqual(summary['counts']['training_candidates'], 1)

    def test_table_blinds_currency_must_match_renderer(self):
        self.cash(label='S Table, NLHE - G 0.5/1', region='table.info', currency='SC')
        self.assert_rejected()

    def test_renderer_truth_is_eligible_without_invented_human_review(self):
        before = (self.dataset / 'data.db').read_bytes()
        row, summary = self.export()
        self.assertEqual(summary['counts']['training_candidates'], 1)
        self.assertEqual(row['label_evidence'], 'synthetic_renderer_ground_truth')
        self.assertFalse(row['visually_verified'])
        self.assertIsNone(row['review_event'])
        self.assertTrue(row['synthetic_ground_truth']['crop_reconstruction_verified'])
        self.assertEqual(row['provenance']['split'], 'train')
        self.assertEqual(row['provenance']['split_eligibility'], 'synthetic_train_only')
        self.assertEqual((self.dataset / 'data.db').read_bytes(), before)

    def test_unbound_saved_label_remains_unreviewed(self):
        self.connection.execute('DELETE FROM synthetic_ground_truth')
        self.connection.commit()
        row, summary = self.export()
        self.assertFalse(row['reviewed'])
        self.assertEqual(summary['counts']['training_candidates'], 0)

    def test_renderer_rows_stay_train_only_through_preparation(self):
        self.export()
        rows, blocked, _ = collection_rows(self.root / 'export')
        self.assertEqual(rows[0]['known_splits'], ['train'])
        prepared, quarantine, _, audit = prepare_records([], rows, blocked)
        self.assertEqual([row['split'] for row in prepared], ['train'])
        self.assertEqual(quarantine, [])
        self.assertFalse(audit['fresh_session_holdouts_created'])
        self.assertEqual(audit['fresh_source_components'], 0)

    def test_stale_label_cannot_reuse_renderer_evidence(self):
        self.connection.execute("UPDATE images SET label='Different'")
        self.assert_rejected()

    def test_state_label_must_match(self):
        self.state['labels']['seats[0].name'] = 'Different'
        self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?', (json.dumps(self.state),))
        self.assert_rejected()

    def test_current_crop_coordinates_must_match_state(self):
        self.connection.execute('UPDATE images SET x=1')
        self.assert_rejected()

    def test_modified_source_screenshot_is_rejected(self):
        (self.dataset / 'full_captures/frame.png').write_bytes(png(Image.new('RGB', (30, 20), 'red')))
        self.assert_rejected()

    def test_modified_crop_and_updated_crop_hash_cannot_evade_reconstruction(self):
        raw = png(Image.new('RGB', (12, 7), 'red'))
        (self.dataset / 'images/name.png').write_bytes(raw)
        image_hash, pixel_hash, _ = _decode_png(raw)
        self.connection.execute('UPDATE synthetic_ground_truth SET image_sha256=?,pixel_sha256=?', (image_hash, pixel_hash))
        self.assert_rejected()

    def test_malformed_renderer_identity_is_rejected(self):
        self.connection.execute("UPDATE synthetic_ground_truth SET renderer_sha256='unknown'")
        self.assert_rejected()

    def test_malformed_state_is_rejected(self):
        self.connection.execute("UPDATE synthetic_ground_truth SET state_json='[]'")
        self.assert_rejected()

    def test_synthetic_blank_is_explicit_evidence_without_visual_review(self):
        self.state['labels']['seats[0].name'] = ''
        self.connection.execute("UPDATE images SET label=''")
        self.connection.execute("UPDATE synthetic_ground_truth SET label='',state_json=?", (json.dumps(self.state),))
        self.connection.commit()
        row, summary = self.export()
        self.assertEqual(summary['counts']['training_candidates'], 1)
        self.assertTrue(row['is_reviewed_negative'])
        self.assertFalse(row['visually_verified'])

    def test_full_frame_empty_target_reaches_train_only_preparation(self):
        self.state['labels']['seats[0].name'] = ''
        self.connection.execute("UPDATE images SET label=''")
        self.connection.execute("UPDATE synthetic_ground_truth SET label='',state_json=?", (json.dumps(self.state),))
        self.connection.commit()
        self.full_frame_only()
        row, summary = self.export()
        self.assertEqual(summary['counts']['training_candidates'], 1)
        self.assertTrue(row['is_reviewed_negative'])
        rows, blocked, _ = collection_rows(self.root / 'export')
        records, quarantine, _, _ = prepare_records([], rows, blocked)
        self.assertEqual([(record['label'], record['split']) for record in records], [('', 'train')])
        self.assertEqual(quarantine, [])
        self.assertFalse((self.dataset / 'images').exists())

    def test_clipped_annotation_is_retained_but_never_admitted(self):
        self.state['eligible'] = {'seats[0].name': False}
        self.state['exclusions'] = {'seats[0].name': 'rendered_text_clipped'}
        self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?', (json.dumps(self.state),))
        self.connection.commit()
        row, summary = self.export()
        self.assertFalse(row['reviewed'])
        self.assertFalse(row['eligible_for_training'])
        self.assertTrue(row['synthetic_evidence_valid'])
        self.assertEqual(row['label_evidence'], 'synthetic_renderer_excluded')
        self.assertIn('rendered_text_clipped', row['training_eligibility_limitations'])
        self.assertEqual(summary['counts']['samples'], 1)
        self.assertEqual(summary['counts']['training_candidates'], 0)

    def test_exclusion_without_reason_is_rejected(self):
        self.state['eligible'] = {'seats[0].name': False}
        self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?', (json.dumps(self.state),))
        self.assert_rejected()

    def test_malformed_admission_map_is_rejected(self):
        self.state['eligible'] = []
        self.connection.execute('UPDATE synthetic_ground_truth SET state_json=?', (json.dumps(self.state),))
        self.assert_rejected()


class CaptureComponentDeduplicationTest(unittest.TestCase):
    def rows(self):
        dataset = 'a' * 32
        values = [('shared-a', 'A', 'red', 'a', 1000),
                  ('shared-b', 'A', 'red', 'b', 2000),
                  ('only-a', 'B', 'green', 'a', 1000),
                  ('only-b', 'C', 'blue', 'b', 2000),
                  ('excluded-c', 'A', 'red', 'c', 1000)]
        rows = []
        for key, label, color, capture, stamp in values:
            raw = png(Image.new('RGB', (4, 4), color))
            image_hash, pixel_hash, shape = _decode_png(raw)
            admitted = key != 'excluded-c'
            rows.append({'dataset_id': dataset, 'sample_key': key,
                'sample_key_aliases': [key], 'category': 'name', 'region_id': 'seats[0].name',
                'label': label, 'label_evidence': 'synthetic_renderer_ground_truth' if admitted else 'synthetic_renderer_excluded',
                'reviewed': admitted, 'eligible_for_training': admitted, 'image_integrity_valid': True,
                'image_sha256': image_hash, 'pixel_sha256': pixel_hash, 'image_dimensions': shape,
                'image': f'images/{key}.png', 'observation_timestamp': stamp,
                'synthetic_evidence_valid': True, 'synthetic_ground_truth': {'eligible': admitted},
                'training_eligibility_limitations': [],
                'provenance': {'capture_group': f'{dataset}:capture:{capture}',
                    'source_capture_timestamp': stamp, 'split': 'train',
                    'split_eligibility': 'synthetic_train_only'}, '_raw': raw})
        return rows

    def candidate_capture_anchors(self, rows):
        return [row for row in rows if row['provenance']['duplicate_capture_groups']]

    def write_export(self, root, rows, candidates, conflicts):
        root.mkdir()
        for row in rows:
            raw = row.pop('_raw')
            path = root / row['image']
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(raw)
        for name, values in [('samples.jsonl', rows), ('training_candidates.jsonl', candidates),
                             ('exact_pixel_conflicts.jsonl', conflicts)]:
            with (root / name).open('w') as output:
                for value in values:
                    output.write(json.dumps(value) + '\n')

    def test_spooled_catalog_manifests_equal_eager_rows_across_graph_cases(self):
        class EagerSpool:
            def __init__(self, directory): pass
            def append(self, row): return row
            def hydrate(self, row): return row
            def close(self): pass

        for scenario in ('normal', 'heldout', 'flagged', 'conflict', 'blank_alias', 'visual', 'baseline'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                rows = self.rows()
                for row in rows:
                    row.pop('_raw')
                    row['is_reviewed_negative'] = False
                    row['provenance']['unused_source_details'] = {'renderer': 'preserve this full provenance'}
                    row['ai_review'] = {'successful_current_check': False, 'state': 'unchanged',
                                        'job_state': 'complete', 'result': {'opaque': ['raw evidence']}}
                    row['review_event'] = {'action': 'accepted', 'prior_label': row['label'],
                                           'created_at': 1, 'actor_details': {'opaque': 'preserved'}}
                if scenario == 'heldout': rows[0]['provenance']['split'] = 'test'
                if scenario == 'flagged': rows[0]['ai_review_blocked'] = True
                if scenario == 'conflict': rows[0]['label'] = 'different'
                if scenario == 'blank_alias':
                    for row in rows[:2]:
                        row['label'] = ''; row['is_reviewed_negative'] = True
                    rows[0]['provenance']['split'] = 'val'
                datasets = [{'id': 'a'*32, 'directory': Path(directory)/'source-a'},
                            {'id': 'b'*32, 'directory': Path(directory)/'source-b'}]
                for row in rows[2:]: row['dataset_id'] = 'b'*32
                def export(dataset, *args):
                    return ([copy.deepcopy(row) for row in rows if row['dataset_id'] == dataset['id']],
                            [], {'dataset_id': dataset['id']})
                options = {}
                if scenario == 'visual':
                    row = rows[0]
                    row.update(queue_id=7, schema_valid=True, completed_schema_valid=True,
                               dataset_archived=False, queue_discarded=False,
                               removed_unsaved_queue_observation=False, ai_review_blocked=True)
                    row['ai_review'].update(state='flagged', job_id='job')
                    options['visual_review_manifest'] = [{'dataset_id': row['dataset_id'],
                        'sample_key': row['sample_key'], 'pixel_sha256': row['pixel_sha256'],
                        'label': row['label'], 'source_job_id': 'job', 'queue_id': 7,
                        'visually_reviewed': True, 'reviewer': 'assistant_visual',
                        'decision': 'confirmed_current_label'}]
                if scenario == 'baseline':
                    datasets[0]['id'] = 'legacy'
                    for row in rows[:2]:
                        row.update(dataset_id='legacy', reviewed=False, dataset_archived=False,
                                   queue_discarded=False, removed_unsaved_queue_observation=False)
                    row = rows[0]
                    options['audited_baseline'] = {'manifest_sha256': 'f'*64, 'audit_sha256': 'e'*64,
                        'records': [{'dataset_id': 'legacy', 'category': row['category'],
                            'pixel_sha256': row['pixel_sha256'], 'file_sha256': row['image_sha256'],
                            'label': row['label'], 'split': 'val', 'sample_id': 'audited'}]}
                root = Path(directory)
                with mock.patch.object(exporter, 'export_dataset', side_effect=export):
                    compact = export_datasets(datasets, root/'compact', materialize_images=False, **options)
                    with mock.patch.object(exporter, '_ExportRowSpool', EagerSpool):
                        eager = export_datasets(datasets, root/'eager', materialize_images=False, **options)
                for name in compact['manifest_sha256']:
                    self.assertEqual((root/'compact'/name).read_bytes(), (root/'eager'/name).read_bytes(), name)
                for summary in (compact, eager):
                    summary.pop('snapshot_started_at_utc'); summary.pop('snapshot_finished_at_utc')
                self.assertEqual(compact, eager)
                self.assertFalse(any(path.name.startswith('tmp') for path in (root/'compact').iterdir()))

    def test_spool_projection_does_not_retain_rich_source_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            spool = exporter._ExportRowSpool(directory)
            self.addCleanup(spool.close)
            row = self.rows()[0]
            row.pop('_raw')
            row['synthetic_ground_truth'] = {'source_label': 'opaque' * 10000}
            row['provenance']['raw_state'] = ['source' * 10000]
            row['ai_review'] = {'state': 'unchanged', 'result': {'huge': 'response' * 10000}}
            projected = spool.append(row)
            self.assertNotIn('synthetic_ground_truth', projected)
            self.assertNotIn('raw_state', projected['provenance'])
            self.assertNotIn('result', projected['ai_review'])
            self.assertEqual(spool.hydrate(projected), row)
            self.assertLess(len(json.dumps(projected)), 2000)

    def test_known_component_capture_edges_are_stored_once(self):
        rows = self.rows()
        candidates, _, conflicts = deduplicate_training_rows(rows)
        self.assertEqual(len(candidates), 3)
        self.assertEqual(conflicts, [])
        anchors = self.candidate_capture_anchors(rows)
        self.assertEqual(len(anchors), 1)
        self.assertIn(anchors[0], candidates)
        self.assertEqual(set(anchors[0]['provenance']['duplicate_capture_groups']),
                         {f"{'a' * 32}:capture:{letter}" for letter in 'abc'})
        self.assertEqual(sum(len(row['provenance']['duplicate_capture_groups']) for row in rows), 3)
        self.assertEqual(len({row['provenance']['split_group'] for row in rows}), 1)
        self.assertTrue(all(row['provenance']['duplicate_known_splits'] == ['train'] for row in rows))

    def test_conflicting_pixel_group_cannot_own_training_capture_edges(self):
        rows = self.rows()
        first_group = min(rows, key=lambda row: hashlib.sha256(('name:' + row['pixel_sha256']).encode()).hexdigest())
        for row in rows:
            if row['pixel_sha256'] == first_group['pixel_sha256']:
                row['ai_review_blocked'] = True
        candidates, _, conflicts = deduplicate_training_rows(rows)
        self.assertEqual(len(conflicts), 1)
        self.assertGreater(len(candidates), 0)
        anchors = self.candidate_capture_anchors(rows)
        self.assertEqual(len(anchors), 1)
        self.assertIn(anchors[0], candidates)
        self.assertNotEqual(anchors[0]['pixel_sha256'], first_group['pixel_sha256'])
        self.assertTrue(all(row['eligible_for_training'] for row in candidates))

    def test_heldout_component_keeps_capture_audit_without_candidates(self):
        rows = self.rows()
        rows[0]['provenance']['split'] = 'test'
        candidates, _, _ = deduplicate_training_rows(rows)
        self.assertEqual(candidates, [])
        anchors = self.candidate_capture_anchors(rows)
        self.assertEqual(len(anchors), 1)
        self.assertEqual(len(anchors[0]['provenance']['duplicate_capture_groups']), 3)
        self.assertTrue(all(not row['eligible_for_training'] for row in rows))
        self.assertTrue(all(row['provenance']['duplicate_known_splits'] == ['test', 'train'] for row in rows))

    def test_unassigned_legacy_components_retain_existing_capture_lists(self):
        rows = self.rows()
        for row in rows:
            row['provenance'].pop('split')
            row['provenance'].pop('split_eligibility')
            row.pop('synthetic_evidence_valid')
            row.pop('synthetic_ground_truth')
        candidates, _, _ = deduplicate_training_rows(rows)
        self.assertEqual(len(candidates), 3)
        self.assertTrue(all(len(row['provenance']['duplicate_capture_groups']) == 3 for row in candidates))
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'export'
            self.write_export(output, rows, candidates, [])
            named, blocked, _ = collection_rows(output)
            prepared, quarantine, _, audit = prepare_records([], named, blocked)
            self.assertEqual(len(prepared), 3)
            self.assertEqual(quarantine, [])
            self.assertEqual(audit['fresh_source_components'], 1)

    def test_mixed_known_and_unassigned_rows_keep_train_component(self):
        rows = self.rows()
        for row in rows[1:]:
            row['provenance'].pop('split')
            row['provenance'].pop('split_eligibility')
        candidates, _, conflicts = deduplicate_training_rows(rows)
        self.assertEqual(len(self.candidate_capture_anchors(rows)), 1)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'export'
            self.write_export(output, rows, candidates, conflicts)
            named, blocked, _ = collection_rows(output)
            prepared, quarantine, _, audit = prepare_records([], named, blocked)
            self.assertEqual(len(prepared), 3)
            self.assertEqual(quarantine, [])
            self.assertEqual({row['split'] for row in prepared}, {'train'})
            self.assertEqual(audit['fresh_source_components'], 0)

    def test_anchor_retains_baseline_pin_on_excluded_capture_alias(self):
        rows = self.rows()
        candidates, _, conflicts = deduplicate_training_rows(rows)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'export'
            self.write_export(output, rows, candidates, conflicts)
            named, blocked, _ = collection_rows(output)
            baseline = {'sample_id': 'baseline', 'dataset_id': 'baseline', 'origin': 'baseline',
                'category': 'name', 'pixel_sha256': 'f' * 64, 'label': 'Heldout',
                'pinned_split': 'val', 'split': 'val', 'groups': [f"{'a' * 32}:capture:c"], 'optimize': True}
            prepared, quarantine, _, _ = prepare_records([baseline], named, blocked)
            self.assertEqual([row['sample_id'] for row in prepared], ['baseline'])
            self.assertEqual(len(quarantine), 3)
            self.assertTrue(all(row['reason'] == 'new_capture_component_bridges_pinned_roles' for row in quarantine))


if __name__ == '__main__':
    unittest.main()
