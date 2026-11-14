import hashlib
import json
from pathlib import Path
import random
import string
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import yaml

import lab_training_curriculum as curriculum


class CurriculumTests(unittest.TestCase):
    def image(self, value, *, patterned=False):
        import cv2
        image = np.full((8, 20, 3), value, np.uint8)
        if patterned:
            image[2:6, 4:16] = 200
        return image, cv2.imencode('.png', image)[1].tobytes()

    def fixture(self, temporary):
        import cv2
        root = Path(temporary) / 'assets'
        bundle = Path(temporary) / 'bundle'
        bundle.mkdir()
        records = []
        def record(identity, split, label, category='name', optimize=True, inherited=False, value=1):
            _, raw = self.image(value, patterned=bool(label))
            relative, sha, pixels = curriculum.materialize(bundle, raw)
            row = {'sample_id': identity, 'split': split, 'label': label, 'category': category,
                   'image_path': relative, 'source_image': str(bundle / relative), 'file_sha256': sha,
                   'pixel_sha256': pixels, 'optimize': optimize, 'inherited_control': inherited,
                   'aliases': [{'baseline_sample_id': 'baseline:1', 'split': split, 'label': label}] if identity == 'real' else []}
            records.append(row)
            return row
        source = record('real', 'train', 'ilIO', value=1)
        record('bank', 'train', 'S 3 BB', 'bank', value=2)
        record('masked', 'train', 'Winner', optimize=False, value=3)
        record('val', 'val', 'Held', value=4)
        record('val-bank', 'val', 'G 2 BB', 'bank', value=5)
        record('val-masked', 'val', 'Winner', optimize=False, value=6)
        record('test', 'test', 'Test', value=7)
        record('test-masked', 'test', 'Winner', optimize=False, value=8)
        for split, count, value in [('train', 600, 20), ('val', 128, 30)]:
            for index in range(count):
                record(f'blank:{split}:{index}', split, '', inherited=True, value=value)
        (bundle / 'starting').mkdir()
        (bundle / 'starting/general.pdparams').write_bytes(b'original-checkpoint')
        (bundle / 'dictionary.txt').write_text('\n'.join(string.ascii_letters + string.digits + '.:') + '\n')
        raw_root = root / 'raw-repetition-data'
        gray_root = root / 'desktop-training/compact-ocr-v4/reviewed-augmentation'
        raw_root.mkdir(parents=True)
        gray_root.mkdir(parents=True)
        raw_rows, gray_rows = [], []
        for index, label in enumerate(['iii', 'lll', 'III', 'OOO']):
            image, data = self.image(40 + index, patterned=True)
            relative = f'images/{2000000 + index}.png'
            (raw_root / 'images').mkdir(exist_ok=True)
            (raw_root / relative).write_bytes(data)
            raw_rows.append({'sample_id': str(2000000 + index), 'category': 'name', 'split': 'train',
                             'label': label, 'image_path': relative, 'file_sha256': curriculum.digest(data), 'glyph_sources': ['1']})
        for index, label in enumerate(['ii', 'll']):
            image, data = self.image(50 + index, patterned=True)
            relative = f'images/{index:06}.png'
            (gray_root / 'images').mkdir(exist_ok=True)
            (gray_root / relative).write_bytes(data)
            gray_rows.append({'image': relative, 'label': label, 'glyphs': [{'sample_id': '1', 'x': [1, 2]}]})
        (raw_root / 'manifest.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in raw_rows))
        (raw_root / 'review.json').write_text(json.dumps({'reviewed_glyphs': 12, 'conflicting_exact_pixel_groups': [], 'reviewed_first_render_ids': ['2000000']}))
        (raw_root / 'audit.json').write_text(json.dumps({'samples': 4}))
        (gray_root / 'audit.json').write_text(json.dumps({'samples': gray_rows}))
        (gray_root / 'labels.txt').write_text(''.join(row['image'] + '\t' + row['label'] + '\n' for row in gray_rows))
        chosen = list(raw_rows)
        random.Random(202611073).shuffle(chosen)
        selected = root / 'desktop-training/name-specialist-v13/train.txt'
        selected.parent.mkdir(parents=True)
        selected.write_text(''.join(str(raw_root / row['image_path']) + '\t' + row['label'] + '\n' for row in chosen[:2]))
        stress = root / 'stress-database'
        (stress / 'images').mkdir(parents=True)
        raw = (bundle / source['image_path']).read_bytes()
        (stress / 'images/1.png').write_bytes(raw)
        (stress / 'manifest.jsonl').write_text(json.dumps({'sample_id': '1', 'split': 'train', 'category': 'name',
                                                        'label': source['label'], 'image_path': 'images/1.png', 'file_sha256': curriculum.digest(raw)}) + '\n')
        challenge = root / 'novel-name-challenge'
        challenge.mkdir()
        (challenge / 'manifest.jsonl').write_text(json.dumps({'label': 'NeverTrain'}) + '\n')
        historical = root / 'production-data'
        (historical / 'images').mkdir(parents=True)
        image = curriculum.encoded_image(raw)
        original_relative = 'images/1-original.png'
        (historical / original_relative).write_bytes(raw)
        context = cv2.copyMakeBorder(image, 2, 1, 3, 1, cv2.BORDER_CONSTANT, value=(99, 99, 99))
        context_raw = cv2.imencode('.png', context)[1].tobytes()
        (historical / 'images/1-context0.png').write_bytes(context_raw)
        manifest = [{'parent_sample_id': '1', 'split': 'train', 'augmentation': 'original',
                     'image_path': original_relative, 'file_sha256': curriculum.digest(raw)},
                    {'parent_sample_id': '1', 'split': 'train', 'augmentation': 'context0',
                     'image_path': 'images/1-context0.png', 'file_sha256': curriculum.digest(context_raw),
                     'margins_lrtb': [3, 1, 2, 1], 'full_capture': True}]
        (historical / 'manifest.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in manifest))
        template = {'Global': {}, 'Architecture': {'Head': {}}, 'Optimizer': {'lr': {}}, 'Metric': {},
                    'Train': {'dataset': {'transforms': [{'DecodeImage': {}}, {'CollectorCTCLabelEncode': None}, {'RecResizeImg': {}}, {'KeepKeys': {}}]}, 'loader': {}},
                    'Eval': {'dataset': {'transforms': [{'DecodeImage': {}}, {'CollectorCTCLabelEncode': None}, {'RecResizeImg': {}}, {'KeepKeys': {}}]}, 'loader': {}}}
        for role in ('general', 'names'):
            config = {**template, 'Global': {'collector_name_high_resolution': role == 'names'}}
            (root / (role + '.yml')).write_text(yaml.safe_dump(config))
        resources = {'training_root': root, 'general_template': root / 'general.yml', 'names_template': root / 'names.yml'}
        pins = {relative: curriculum.digest((root / relative).read_bytes()) for relative in curriculum.ASSET_PINS}
        gray_hashes = [{'image': row['image'], 'sha256': curriculum.digest((gray_root / row['image']).read_bytes())}
                       for row in sorted(gray_rows, key=lambda row: row['image'])]
        aggregate = curriculum.digest(json.dumps(gray_hashes, sort_keys=True, separators=(',', ':')).encode())
        return bundle, records, resources, pins, aggregate

    def build(self, fixture, epochs=6):
        bundle, records, resources, pins, aggregate = fixture
        with patch.object(curriculum, 'ASSET_PINS', pins), patch.object(curriculum, 'GRAY_IMAGES_SHA256', aggregate), \
                patch.object(curriculum, 'RAW_COUNT', 4), patch.object(curriculum, 'GRAY_COUNT', 2), patch.object(curriculum, 'FINAL_RAW_COUNT', 2):
            return curriculum.build_curriculum(bundle, records, resources, epochs)

    def test_four_stage_curriculum_recovers_weighting_controls_and_config_chain(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(temporary)
            bundle, records, resources, _, _ = fixture
            result = self.build(fixture, epochs=7)
            stages = result['stages']
            self.assertEqual([stage['id'] for stage in stages], ['base', 'general', 'names-base', 'names'])
            self.assertEqual([stage['epochs'] for stage in stages], [8, 4, 4, 7])
            self.assertEqual([stage['seed'] for stage in stages], [20261107, 20261107, 202611072, 202611073])
            self.assertEqual([stage['train_count'] for stage in stages], [14, 18, 612, 608])
            self.assertEqual([stage['validation_count'] for stage in stages], [2, 2, 129, 129])
            self.assertEqual([stage['learning_rate'] for stage in stages], [2e-5, 2e-5, 2e-5, 1e-5])
            for stage in stages:
                config = yaml.safe_load(Path(stage['config']).read_text())
                self.assertEqual(config['Global']['pretrained_model'], stage['checkpoint_source'])
                self.assertEqual(config['Global']['seed'], stage['seed'])
                self.assertEqual(config['Global']['save_model_dir'], str(Path(stage['directory']) / 'checkpoints'))
                self.assertEqual(config['Train']['loader']['batch_size_per_card'], 32)
                self.assertIsNone(config['Global']['checkpoints'])
                self.assertTrue(config['Train']['loader']['shuffle'])
                self.assertFalse(config['Eval']['loader']['shuffle'])
            self.assertEqual(stages[1]['checkpoint_source'], str(bundle / 'stages/base/checkpoints/best_accuracy.pdparams'))
            self.assertEqual(stages[2]['checkpoint_source'], stages[1]['checkpoint_source'])
            self.assertEqual(stages[3]['checkpoint_source'], str(bundle / 'stages/names-base/checkpoints/best_accuracy.pdparams'))
            final_rows = curriculum.read_rows(bundle / 'names/manifest.jsonl')
            self.assertFalse(any(row['sample_id'].startswith('curriculum:gray:') for row in final_rows))
            self.assertEqual(sum(row['sample_id'].startswith('curriculum:raw:') for row in final_rows), 2)
            self.assertEqual(sum(row.get('augmentation') is not None for row in final_rows), 6)
            self.assertEqual(result['roles']['general']['starting_checkpoint_sha256'], curriculum.digest(b'original-checkpoint'))
            self.assertTrue((bundle / 'curriculum.json').is_file())

    def test_verified_context_preserves_full_source_and_fallback_never_crops(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(temporary)
            bundle, records, *_ = fixture
            self.build(fixture)
            rows = curriculum.read_rows(bundle / 'general/manifest.jsonl')
            original = curriculum.encoded_image((bundle / records[0]['image_path']).read_bytes())
            for variant in ('context0', 'context1'):
                row = next(row for row in rows if row['sample_id'] == 'real:curriculum:' + variant)
                image = curriculum.encoded_image((bundle / row['image_path']).read_bytes())
                left, _, top, _ = row['margins_lrtb']
                self.assertTrue(np.array_equal(image[top:top+original.shape[0], left:left+original.shape[1]], original))
                self.assertEqual(row['pixel_sha256'], curriculum.pixel_hash(image))
                self.assertEqual(row['curriculum_parent_pixel_sha256'], curriculum.pixel_hash(original))
                self.assertEqual(row['full_capture'], variant == 'context0')
            self.assertEqual((bundle / 'names/test.txt').read_text().count('\n'), 2)
            self.assertFalse(any('curriculum:' in row['sample_id'] for row in rows if row['split'] != 'train'))
            self.assertFalse(any(row['label'] == 'Winner' for row in rows if row['split'] == 'train'))

    def test_unselected_or_changed_glyph_parent_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(temporary)
            fixture[1][0]['aliases'] = []
            with self.assertRaisesRegex(ValueError, 'selected optimized training pixels'):
                self.build(fixture)
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(temporary)
            fixture[1][0]['label'] = 'Different'
            with self.assertRaisesRegex(ValueError, 'selected optimized training pixels'):
                self.build(fixture)

    def test_changed_retention_images_or_heldout_targets_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(temporary)
            (fixture[2]['training_root'] / 'raw-repetition-data/images/2000000.png').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'raw repetition image changed'):
                self.build(fixture)
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(temporary)
            fixture[1][3]['label'] = 'iii'
            with self.assertRaisesRegex(ValueError, 'heldout/challenge target'):
                self.build(fixture)

    def test_negative_context_never_reads_neighboring_capture_and_variant_weight_is_kept(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(temporary)
            bundle, records, *_ = fixture
            row = records[1]
            image, raw = self.image(0)
            path, sha, pixels = curriculum.materialize(bundle, raw)
            row.update(label='', image_path=path, file_sha256=sha, pixel_sha256=pixels,
                       dataset_id='legacy', source_id=1, x=3, y=2, w=20, h=8)
            with patch.object(curriculum.sqlite3, 'connect', side_effect=AssertionError('Negative must not import context')):
                expanded, proof = curriculum.context_image(fixture[2]['training_root'], row, image, (3, 1, 2, 1))
            self.assertEqual(proof['reason'], 'negative_padding_only')
            self.assertTrue(np.array_equal(expanded[2:10, 3:23], image))
            self.build(fixture)
            variants = [item for item in curriculum.read_rows(bundle / 'general/manifest.jsonl')
                        if item.get('parent_sample_id') == row['sample_id']]
            self.assertEqual(len(variants), 6)
            self.assertLess(len({item['image_path'] for item in variants}), 6)

    def test_general_only_curriculum_does_not_create_names_job(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(temporary)
            fixture[2]['roles'] = ['general']
            result = self.build(fixture)
            self.assertEqual([stage['id'] for stage in result['stages']], ['base', 'general'])
            self.assertEqual(set(result['roles']), {'general'})


if __name__ == '__main__':
    unittest.main()
