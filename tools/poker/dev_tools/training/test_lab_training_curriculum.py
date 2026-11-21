import copy
from collections import Counter
import hashlib
import json
from pathlib import Path
import random
import string
import tempfile
import unittest
import weakref
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
                self.assertTrue(config['Global']['collector_aspect_preserving'])
                self.assertEqual(config['Eval']['loader']['batch_size_per_card'], 1)
                for section in ('Train', 'Eval'):
                    self.assertEqual([next(iter(op)) for op in config[section]['dataset']['transforms']],
                                     ['DecodeImage', 'CollectorCTCLabelEncode', 'CollectorAspectResize', 'KeepKeys'])
            self.assertEqual(stages[1]['checkpoint_source'], str(bundle / 'stages/base/checkpoints/best_accuracy.pdparams'))
            self.assertEqual(stages[2]['checkpoint_source'], stages[1]['checkpoint_source'])
            self.assertEqual(stages[3]['checkpoint_source'], str(bundle / 'stages/names-base/checkpoints/best_accuracy.pdparams'))
            final_rows = curriculum.read_rows(bundle / 'names/manifest.jsonl')
            self.assertFalse(any(row['sample_id'].startswith('curriculum:gray:') for row in final_rows))
            self.assertEqual(sum(row['sample_id'].startswith('curriculum:raw:') for row in final_rows), 2)
            self.assertEqual(sum(row.get('augmentation') is not None for row in final_rows), 6)
            self.assertEqual(result['roles']['general']['starting_checkpoint_sha256'], curriculum.digest(b'original-checkpoint'))
            self.assertTrue((bundle / 'curriculum.json').is_file())

    def renderer_rows(self, fixture):
        from ocr_dictionary import dictionary_text
        bundle, records, *_ = fixture
        (bundle / 'dictionary.txt').write_text(dictionary_text('punctuation73'))
        values = [('renderer-name', 'Renderer9', 'name'),
                  ('renderer-table', 'Table*Name, NLHE - S 1/2', 'table_info'),
                  ('renderer-visible', '5555', 'bet')]
        result = []
        for index, (identity, label, category) in enumerate(values):
            _, raw = self.image(90 + index, patterned=True)
            path, sha, pixels = curriculum.materialize(bundle, raw)
            row = dict(sample_id=identity, split='train', label=label, category=category,
                image_path=path, source_image=str(bundle / path), file_sha256=sha,
                pixel_sha256=pixels, image_dimensions=[20, 8], optimize=True, origin='named',
                aliases=[], groups=['source-capture'], provenance={'source_value': label, 'capture_sha256': 'f'*64},
                label_evidence='synthetic_renderer_ground_truth', synthetic_evidence_valid=True,
                synthetic_ground_truth={'generator': 'poker-offline-renderer',
                    'crop_reconstruction_verified': True, 'eligible': True})
            if category == 'bet':
                row.update(recognition_task='visible_run')
                row['synthetic_ground_truth'].update(visible_run_verified=True,
                    recognition_target=label, source_label='G 55555.1 BB')
            records.append(row); result.append(row)
        return result

    def test_renderer_inventory_is_preserved_while_effective_exposure_is_balanced(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(temporary)
            renderer = copy.deepcopy(self.renderer_rows(fixture))
            result = self.build(fixture)
            self.assertEqual(result['audit']['renderer_training_observations'], 3)
            self.assertEqual(result['audit']['renderer_name_training_observations'], 1)
            self.assertEqual(result['audit']['real_training_variants'], 12)
            for stage in result['stages']:
                rows = curriculum.read_rows(Path(stage['directory']) / 'manifest.jsonl')
                expected = renderer if stage['role'] == 'general' else renderer[:1]
                sampling = json.loads((Path(stage['directory']) / 'sampling.json').read_text())
                self.assertEqual(set(sampling['source_exposures']),
                                 {row['sample_id'] for row in rows
                                  if row['split'] == 'train' and row.get('optimize', True)})
                lines = (Path(stage['directory']) / 'train.txt').read_text().splitlines()
                portable = ''.join(str(Path(path).relative_to(fixture[0])) + '\t' + label + '\n'
                                   for path, label in (line.split('\t', 1) for line in lines))
                self.assertEqual(sampling['portable_train_sha256'], curriculum.digest(portable.encode()))
                self.assertEqual(len(lines), stage['train_count'])
                for source in expected:
                    matches = [row for row in rows if row['sample_id'] == source['sample_id']]
                    self.assertEqual(matches, [source])
                    self.assertEqual((fixture[0] / source['image_path']).read_bytes(),
                                     Path(source['source_image']).read_bytes())
                    target = str(fixture[0] / source['image_path']) + '\t' + source['label']
                    self.assertEqual((Path(stage['directory']) / 'train.txt').read_text().splitlines().count(target),
                                     sampling['source_exposures'][source['sample_id']])
                    self.assertEqual(sampling['source_exposures'][source['sample_id']], 4)
                    self.assertEqual(stage['inventory_train_count'],
                                     sum(row['split'] == 'train' and row.get('optimize', True) for row in rows))
                    self.assertEqual(stage['inventory_manifest_sha256'],
                                     curriculum.digest((Path(stage['directory']) / 'manifest.jsonl').read_bytes()))
                    self.assertEqual(stage['sampling_sha256'],
                                     curriculum.digest((Path(stage['directory']) / 'sampling.json').read_bytes()))
                self.assertFalse(any(row.get('parent_sample_id', '').startswith('renderer-') for row in rows))
                self.assertFalse(any(row.get('sample_id') in {'renderer-table', 'renderer-visible'}
                                     for row in rows if stage['role'] == 'names'))

    def sampling_row(self, identity, label, category='name', renderer=False, inherited=False):
        row = dict(sample_id=identity, split='train', label=label, category=category,
                   optimize=True, inherited_control=inherited)
        if renderer:
            row.update(synthetic_evidence_valid=True, synthetic_ground_truth={
                'generator': 'poker-offline-renderer', 'crop_reconstruction_verified': True})
        return row

    def test_balancing_limits_repeated_labels_and_equalizes_general_categories_and_name_lengths(self):
        real = [self.sampling_row(f'real:{index}', 'Natural...') for index in range(120)]
        controls = [self.sampling_row('blank', '', inherited=True)]
        renderer = [self.sampling_row(f'aa:{index}', 'Aa1', renderer=True) for index in range(1000)]
        renderer += [self.sampling_row(f'pair:{index}', 'B' + str(index), renderer=True) for index in range(100)]
        renderer += [self.sampling_row(f'long:{index}', 'NaturalName' + str(index), renderer=True) for index in range(10)]
        renderer += [self.sampling_row(f'status:{index}', ['Call', 'Check'][index % 2], 'status', renderer=True)
                     for index in range(10)]
        rows = real + controls + renderer
        original = copy.deepcopy(rows)
        chosen, proof = curriculum.balanced_training(rows, 123)
        self.assertEqual(rows, original)
        self.assertEqual(proof['source_counts'], dict(real=120, renderer=1120, controls=1))
        self.assertEqual(proof['exposure_counts'], dict(real=120, renderer=120, controls=1))
        self.assertEqual(len(chosen), 241)
        self.assertEqual(proof['renderer_exposure_shortfall'], 0)
        self.assertEqual({key: row['exposures'] for key, row in proof['renderer_buckets'].items()},
                         {'name:1-3': 40, 'name:9-12': 40, 'status': 40})
        self.assertLessEqual(sum(row['label'] == 'Aa1' for row in chosen), 1)
        self.assertTrue(all(proof['source_exposures'][row['sample_id']] == 1 for row in real + controls))
        self.assertTrue(all(proof['source_exposures'][row['sample_id']] <= 4 for row in renderer))
        self.assertGreater(proof['renderer_zero_exposure_sources'], 1000)
        self.assertEqual(curriculum.balanced_training(rows, 123), (chosen, proof))
        self.assertNotEqual(curriculum.balanced_training(rows, 124)[1]['source_exposures'], proof['source_exposures'])

    def test_sparse_renderer_buckets_are_capped_and_shortfalls_are_explicit(self):
        rows = [self.sampling_row(f'real:{index}', 'Natural...') for index in range(30)]
        rows += [self.sampling_row('renderer:short', 'Aa1', renderer=True),
                 self.sampling_row('renderer:long', 'LongNaturalName', renderer=True),
                 self.sampling_row('renderer:status', 'Winner', 'winner', renderer=True)]
        chosen, proof = curriculum.balanced_training(rows, 5)
        self.assertEqual(proof['target_renderer_exposures'], 30)
        self.assertEqual(proof['exposure_counts']['renderer'], 12)
        self.assertEqual(proof['renderer_exposure_shortfall'], 18)
        self.assertEqual(Counter(row['sample_id'] for row in chosen if curriculum.renderer_observation(row)),
                         {'renderer:short': 4, 'renderer:long': 4, 'renderer:status': 4})
        with self.assertRaisesRegex(ValueError, 'reviewed real full-string'):
            curriculum.balanced_training(rows[-3:], 5)

    def test_renderer_display_buckets_distinguish_abbreviated_names_and_blanks(self):
        values = [('', 'name:blank'), ('Aa', 'name:1-3'), ('Alice', 'name:4-8'),
                  ('NaturalName', 'name:9-12'), ('VeryLongNaturalName', 'name:13+'),
                  ('Natural...', 'name:abbreviated'), ('Natural…', 'name:abbreviated')]
        for label, expected in values:
            self.assertEqual(curriculum.renderer_bucket(self.sampling_row('renderer', label)), expected)

    def test_curriculum_source_decode_cache_is_bounded_and_renderer_is_not_cached(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(temporary)
            renderer = self.renderer_rows(fixture)
            original = curriculum.source_image
            references = []
            reads = Counter()
            peak = 0
            def tracked(bundle, row):
                nonlocal peak
                image = original(bundle, row)
                reads[row['sample_id']] += 1
                references.append(weakref.ref(image))
                peak = max(peak, sum(reference() is not None for reference in references))
                return image
            with patch.object(curriculum, 'source_image', side_effect=tracked):
                self.build(fixture)
            self.assertLessEqual(peak, 2)
            for row in renderer:
                self.assertEqual(reads[row['sample_id']], 1)
            self.assertEqual(reads['val'], 1)
            self.assertEqual(reads['blank:train:0'], 1)
            cache = curriculum._SourceImages(fixture[0], fixture[1])
            self.assertEqual(set(cache.parents), {'real', 'bank'})

    def test_every_renderer_source_identity_is_checked_before_stage_generation(self):
        for mutation in ('file', 'pixels', 'dimensions', 'transcript'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                fixture = self.fixture(temporary)
                renderer = self.renderer_rows(fixture)
                row = renderer[-1]
                if mutation == 'file': row['file_sha256'] = '0' * 64
                if mutation == 'pixels': row['pixel_sha256'] = '0' * 64
                if mutation == 'dimensions': row['image_dimensions'] = [21, 8]
                if mutation == 'transcript': row['label'] = '55555.1'
                with self.assertRaisesRegex(ValueError, 'Frozen source|verified transcript'):
                    self.build(fixture)

    def test_renderer_rows_never_establish_historical_glyph_parent_admission(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(temporary)
            row = fixture[1][0]
            row.update(label_evidence='synthetic_renderer_ground_truth', synthetic_evidence_valid=True,
                synthetic_ground_truth={'generator': 'poker-offline-renderer', 'crop_reconstruction_verified': True})
            self.assertFalse(curriculum.control(row))
            with self.assertRaisesRegex(ValueError, 'Historical glyph parent'):
                self.build(fixture)

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

    def test_fixed_controls_use_audited_parents_without_adding_unselected_real_rows(self):
        for names_requested in (False, True):
            with self.subTest(names_requested=names_requested), tempfile.TemporaryDirectory() as temporary:
                fixture = self.fixture(temporary)
                bundle, records, resources, *_ = fixture
                resources['control_parent_provenance'] = [dict(row, control_parent_roles=['train'])
                                                           for row in records]
                if names_requested:
                    row = records[0]
                    _, raw = self.image(70, patterned=True)
                    path, sha, pixels = curriculum.materialize(bundle, raw)
                    row.update(sample_id='fresh-name', label='Fresh', aliases=[], image_path=path,
                               source_image=str(bundle / path), file_sha256=sha, pixel_sha256=pixels)
                else:
                    records.remove(records[0])
                    resources['roles'] = ['general']
                result = self.build(fixture)
                general = curriculum.read_rows(bundle / 'general/manifest.jsonl')
                self.assertFalse(any(row.get('parent_sample_id') == 'real' for row in general))
                self.assertEqual(sum(row['sample_id'].startswith('curriculum:gray:') for row in general), 2)
                self.assertEqual(sum(row['sample_id'].startswith('curriculum:raw:') for row in general), 4)
                proof = result['audit']['asset_provenance']
                self.assertEqual(proof['parent_admission_scope'], 'audited_global_partition')
                self.assertEqual(proof['historical_glyph_parent_ids'], ['1'])
                self.assertEqual(proof['parent_admission'][0]['partition_roles'], ['train'])
                if names_requested:
                    final = curriculum.read_rows(bundle / 'names/manifest.jsonl')
                    self.assertEqual(sum(row['sample_id'].startswith('curriculum:raw:') for row in final), 2)

    def test_parent_admission_rejects_heldouts_blocks_exclusions_and_changed_pixels(self):
        for mutation in ('heldout', 'blocked', 'excluded', 'label', 'hash'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temporary:
                fixture = self.fixture(temporary)
                _, records, resources, *_ = fixture
                parents = [dict(row, control_parent_roles=[row['split']]) for row in records]
                resources['control_parent_provenance'] = parents
                parent = parents[0]
                if mutation == 'heldout': parent['control_parent_roles'] = ['train', 'test']
                elif mutation == 'blocked': parent['control_parent_roles'] = ['train', 'challenge']
                elif mutation == 'excluded': parent['optimize'] = False
                elif mutation == 'label': parent['label'] = 'Changed'
                elif mutation == 'hash': parent['file_sha256'] = '0' * 64
                with self.assertRaisesRegex(ValueError, 'glyph parent'):
                    self.build(fixture)


if __name__ == '__main__':
    unittest.main()
