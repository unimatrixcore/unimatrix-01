import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from collections import defaultdict
from unittest.mock import patch

from PIL import Image
import yaml

from lab_training_data import analyze, discover, prepare, prepared_analysis, reserve_splits, DataProgress
from prepare_named_collection_training import digest, pixels, read_jsonl, write_jsonl


def png(color):
    stream = io.BytesIO()
    Image.new('RGB', (32, 16), color).save(stream, format='PNG')
    return stream.getvalue()



class PreparationTest(unittest.TestCase):
    def setUp(self):
        # These preparation fixtures isolate review/export/model provenance;
        # reservation allocation has its own integration cases below.
        self.reservation_policy = patch('lab_training_data._reserve_catalog',
                                        return_value=(defaultdict(set), {'collections': {}}))
        self.reservation_policy.start()
        self.addCleanup(self.reservation_policy.stop)
        curriculum = patch('lab_training_data.build_curriculum', return_value={'stages': [], 'audit': {}, 'roles': {}})
        curriculum.start()
        self.addCleanup(curriculum.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.training = self.root / 'training'
        baseline = self.training / 'named-continuation/final'
        (baseline / 'images').mkdir(parents=True)
        rows = []
        for key, label, split, color, control in [
            ('unused', 'Unused', 'train', 'red', False),
            ('validation', 'Hold', 'val', 'green', False),
            ('test', 'Test', 'test', 'blue', False),
            ('blanktrain', '', 'train', 'black', True),
            ('blankval', '', 'val', 'gray', True),
        ]:
            raw = png(color)
            pixel, shape = pixels(raw)
            image = 'images/' + digest(raw) + '.png'
            (baseline / image).write_bytes(raw)
            rows.append({'sample_id': key, 'label': label, 'category': 'name',
                         'dataset_id': 'baseline' if control else 'legacy',
                         'region_id': 'seats[0].name', 'split': split, 'image_path': image,
                         'file_sha256': digest(raw), 'pixel_sha256': pixel, 'image_dimensions': shape,
                         'groups': ['baseline:' + key], 'constructed_control': control,
                         'blank_construction': {'decoded_pixels_match_original_construction': True,
                                                'foreground_glyphs_rendered': False},
                         'optimize': True, 'label_evidence': 'synthetic_constructed_blank' if control else 'audited_baseline'})
        write_jsonl(baseline / 'manifest.jsonl', rows)
        (baseline / 'audit.json').write_text(json.dumps({'training_ready': True, 'blank_retention': {'enabled': True}}))
        (baseline / 'dictionary.txt').write_text('\n'.join('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.#:-()'))
        template = {
            'Global': {}, 'Optimizer': {'lr': {}}, 'Loss': {}, 'Metric': {},
            'Architecture': {'model_type': 'rec', 'Backbone': {'name': 'PPLCNetV4', 'model_size': 'small'}, 'Head': {'name': 'CTCHead'}},
            'Train': {'dataset': {'transforms': [{'DecodeImage': {}}]}, 'loader': {}},
            'Eval': {'dataset': {'transforms': [{'DecodeImage': {}}]}, 'loader': {}},
        }
        for role in ('general', 'names'):
            path = baseline / role
            (path / 'checkpoints').mkdir(parents=True)
            (path / 'checkpoints/best_accuracy.pdparams').write_bytes(role.encode())
            config = json.loads(json.dumps(template))
            config['Global']['collector_name_high_resolution'] = role == 'names'
            (path / 'train.yml').write_text(yaml.safe_dump(config))
            model = self.training / 'release-candidate/models' / role
            model.mkdir(parents=True)
            (model / 'model.onnx').write_bytes(role.encode())
            (model / 'characters.json').write_text('["blank"]')
        release = self.training / 'release-candidate'
        (release / 'runtime.json').write_text(json.dumps({'general_model': 'models/general', 'name_model': 'models/names'}))
        (release / 'freeze.json').write_text(json.dumps({
            'weights': {role: digest(role.encode()) for role in ('general', 'names')},
            'characters_sha256': {role: digest(b'["blank"]') for role in ('general', 'names')},
        }))
        self.original_fixture(baseline)
        for relative in ['desktop-train-gpu/bin/python', 'desktop-gpu/bin/python',
                         'desktop-training/paddle-training-source/tools/train.py']:
            path = self.training / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fixture')

    def original_fixture(self, baseline):
        from lab_training_data import _architecture_digest, _proof_digest
        source = self.training / 'benchmark-models/PP-OCRv6_small_rec'
        source.mkdir(parents=True)
        official = source / 'pretrained.pdparams'
        official.write_bytes(b'untouched official pretrained')
        output = self.training / 'production-clean-start'
        output.mkdir()
        checkpoint = output / 'initial.pdparams'
        checkpoint.write_bytes(b'mapped original pretrained')
        dictionary = baseline / 'dictionary.txt'
        classes = ['blank'] + dictionary.read_text().splitlines() + [' ']
        (source / 'inference.yml').write_text(yaml.safe_dump({'PostProcess': {'character_dict': classes[1:-1]}}))
        (source / 'PRETRAINED-SOURCE.json').write_text(json.dumps({'sha256': digest(official.read_bytes()),
            'bytes': official.stat().st_size,
            'url': 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_pretrained_model/PP-OCRv6_small_rec_pretrained.pdparams'}))
        (source / 'MODEL-SOURCE.json').write_text(json.dumps({'repository': 'PaddlePaddle/PP-OCRv6_small_rec',
            'sha256': {'inference.yml': digest((source / 'inference.yml').read_bytes())}}))
        artifacts = {'official_source_sha256': digest(official.read_bytes()), 'mapped_sha256': digest(checkpoint.read_bytes()),
            'source_dictionary_sha256': digest((source / 'inference.yml').read_bytes()),
            'training_dictionary_sha256': digest(dictionary.read_bytes()),
            'download_record_sha256': digest((source / 'PRETRAINED-SOURCE.json').read_bytes()),
            'source_model_record_sha256': digest((source / 'MODEL-SOURCE.json').read_bytes())}
        indices = list(range(70))
        proof = {'method': 'original_pretrained_tensor_mapping_v1', 'artifacts': artifacts,
            'policies': {role: {'architecture_sha256': _architecture_digest(baseline / role / 'train.yml'),
                'width_pool': 1, 'temporal_stride': 2 if role == 'names' else 4} for role in ('general', 'names')},
            'classes_sha256': _proof_digest(classes), 'class_indices_sha256': _proof_digest(indices),
            'mapped_tensors': 338, 'bitwise_equal_tensors': 338, 'mismatches': 0,
            'collector_tuned_tensors_used': 0, 'strict_architecture_shapes': True}
        (output / 'provenance.json').write_text(json.dumps({'official_source_sha256': artifacts['official_source_sha256'],
            'mapped_sha256': artifacts['mapped_sha256'], 'collector_tuned_weights_used': False,
            'classes': classes, 'class_indices': indices, 'mapped_tensors': 338,
            'verification': proof, 'verification_sha256': _proof_digest(proof)}))

    def collection(self, identity, items):
        directory = self.root / identity
        directory.mkdir()
        connection = sqlite3.connect(directory / 'data.db')
        connection.executescript('''
            CREATE TABLE queue_items(queue_id INTEGER PRIMARY KEY,sample_key TEXT,frame_id TEXT,source TEXT,game_id TEXT,payload TEXT,active INTEGER,region_id TEXT,created_at INTEGER,reviewed INTEGER,discarded INTEGER,label TEXT,prediction_id TEXT,pixel_sha256 TEXT,crop BLOB);
            CREATE TABLE review_samples(sample_key TEXT,region_id TEXT,pixel_sha256 TEXT,image_sha256 TEXT,filename TEXT,label TEXT,crop BLOB);
            CREATE TABLE label_review_events(id INTEGER PRIMARY KEY,sample_key TEXT,filename TEXT,prediction_id TEXT,prior_label TEXT,label TEXT,action TEXT,pixel_sha256 TEXT,dataset_id TEXT,created_at INTEGER);
            CREATE TABLE full_captures(id INTEGER PRIMARY KEY,filename TEXT,timestamp INTEGER,monitor TEXT,regions_hash TEXT);
        ''')
        for index, item in enumerate(items):
            label, raw, stamp = item[:3]
            reviewed = item[3] if len(item) > 3 else True
            region = item[4] if len(item) > 4 else 'seats[0].name'
            key, capture = f'sample{index}', f'capture{index}.png'
            pixel, _ = pixels(raw)
            connection.execute('INSERT INTO full_captures VALUES(?,?,?,?,?)', (index, capture, stamp, 'monitor', 'geometry'))
            connection.execute('INSERT INTO queue_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                               (index, key, capture, capture, None, '{}', 1, region, stamp,
                                int(reviewed), 0, label, None, pixel, raw))
            if reviewed:
                connection.execute('INSERT INTO review_samples VALUES(?,?,?,?,?,?,?)',
                                   (key, region, pixel, digest(raw), None, label, raw))
                connection.execute('INSERT INTO label_review_events VALUES(?,?,?,?,?,?,?,?,?,?)',
                                   (index + 1, key, None, None, '', label, 'manual', pixel, identity, stamp))
        connection.commit()
        connection.close()
        return {'id': identity, 'name': identity, 'directory': str(directory)}

    def request(self, collections):
        return {'collections': collections, 'epochs': 2, 'run_dir': str(self.root / 'run'),
                'training_root': str(self.training)}

    def legacy(self, items):
        collection = self.collection('legacy', [])
        directory = Path(collection['directory'])
        (directory / 'images').mkdir()
        with sqlite3.connect(directory / 'data.db') as connection:
            connection.execute('CREATE TABLE images(id INTEGER PRIMARY KEY,filename TEXT,label TEXT,region_id TEXT,timestamp INTEGER,source_id INTEGER)')
            for index, (label, raw) in enumerate(items):
                filename = f'{index}.png'
                (directory / 'images' / filename).write_bytes(raw)
                connection.execute('INSERT INTO images VALUES(?,?,?,?,?,NULL)',
                                   (index, filename, label, 'seats[0].name', 1790000000000))
        return collection

    def test_semantic_review_excludes_newer_alias_and_reports_its_reason(self):
        baseline = self.training / 'named-continuation/final'
        originals = read_jsonl(baseline / 'manifest.jsonl')
        originals[0]['label'] = 'Winner'
        write_jsonl(baseline / 'manifest.jsonl', originals)
        directory = baseline.parent / 'semantic-v2'
        (directory / 'review-evidence').mkdir(parents=True)
        (directory / 'review-evidence/contact.png').write_bytes(b'review evidence')
        review = {**originals[0], 'source_manifest_line': 1,
                  'source_manifest_sha256': digest((baseline / 'manifest.jsonl').read_bytes()),
                  'source_file_sha256': originals[0]['file_sha256'],
                  'decision': 'exclude_from_name_optimization',
                  'semantic_role': 'transient_winner_status_marker', 'visually_reviewed': True,
                  'label_preserved': True, 'split_preserved': True,
                  'literal_label_matches_visible_text': True, 'clipped_or_ambiguous': False,
                  'evidence_page': 'contact.png', 'evidence_page_sha256': digest(b'review evidence')}
        write_jsonl(directory / 'semantic-review.jsonl', [review])
        (directory / 'audit.json').write_text(json.dumps({
            'training_ready': True, 'semantic_exclusion_count': 1,
            'semantic_review_sha256': digest((directory / 'semantic-review.jsonl').read_bytes()),
            'source_manifest_sha256': review['source_manifest_sha256']}))
        collection = self.collection('a' * 32, [('Winner', png('red'), 1790000000000),
                                               ('Alpha', png('yellow'), 1790000001000)])
        request = self.request([collection])
        prepared = prepare(request)
        records = read_jsonl(Path(prepared['bundle']) / 'manifest.jsonl')
        winner = next(row for row in records if row['label'] == 'Winner')
        self.assertFalse(winner['optimize'])
        self.assertEqual(winner['split'], 'train')
        readiness = prepared_analysis(request, prepared)
        self.assertEqual(readiness['accepted'], 1)
        self.assertIn({'reason': 'audited_semantic_name_exclusion', 'count': 1}, readiness['exclusions'])

    def test_newest_capture_wins_and_unrelated_baseline_training_is_omitted(self):
        raw = png('yellow')
        old = self.collection('a' * 32, [('Alpha', raw, 1790000000000)])
        new = self.collection('b' * 32, [('Alpha', raw, 1790000001000)])
        result = prepare(self.request([old, new]))
        bundle = Path(result['bundle'])
        rows = read_jsonl(bundle / 'manifest.jsonl')
        selected = [row for row in rows if row['label'] == 'Alpha']
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]['dataset_id'], new['id'])
        self.assertNotIn('Unused', {row['label'] for row in rows})
        self.assertEqual(result['summary']['duplicates'], 1)
        self.assertEqual(result['summary']['selected_training'], 1)
        audit = json.loads((bundle / 'audit.json').read_text())
        self.assertEqual(audit['manifest_sha256'], digest((bundle / 'manifest.jsonl').read_bytes()))
        self.assertFalse(audit['unrelated_baseline_training_used'])
        config = yaml.safe_load((bundle / 'names/train.yml').read_text())
        self.assertEqual(config['Global']['pretrained_model'], str(bundle / 'starting/names.pdparams'))
        self.assertTrue(all(Path(line.split('\t')[0]).is_relative_to(bundle) for line in (bundle / 'names/train.txt').read_text().splitlines()))

        admission = subprocess.run([sys.executable, str(Path(__file__).with_name('run_named_training.py')),
                                   '--bundle', str(bundle), '--source', result['source'],
                                   '--role', 'names', '--dry-run'], capture_output=True, text=True)
        self.assertEqual(admission.returncode, 0, admission.stderr)
        self.assertEqual(json.loads(admission.stdout)['counts']['train'], 2)
        config['Global']['use_gpu'] = False
        (bundle / 'names/train.yml').write_text(yaml.safe_dump(config))
        rejected = subprocess.run([sys.executable, str(Path(__file__).with_name('run_named_training.py')),
                                  '--bundle', str(bundle), '--source', result['source'],
                                  '--role', 'names', '--dry-run'], capture_output=True, text=True)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn('CPU or distributed recipes are not accepted', rejected.stderr)

    def test_benchmark_count_includes_preserved_nonoptimizable_holdouts(self):
        baseline = self.training / 'named-continuation/final/manifest.jsonl'
        rows = read_jsonl(baseline)
        for row in rows:
            if row['split'] == 'test':
                row['optimize'] = False
        write_jsonl(baseline, rows)
        selected = self.collection('a' * 32, [('Alpha', png('yellow'), 1790000000000)])
        result = prepare(self.request([selected]))
        self.assertEqual(result['summary']['test'], len(read_jsonl(Path(result['bundle']) / 'test.jsonl')))
        self.assertEqual(result['summary']['test'], 1)

    def test_unreviewed_label_cannot_train(self):
        collection = self.collection('a' * 32, [('Alpha', png('yellow'), 1790000000000, False)])
        with self.assertRaisesRegex(ValueError, 'no verified training crops'):
            prepare(self.request([collection]))

    def test_holdout_pixels_remain_held_out_and_conflicts_are_quarantined(self):
        collection = self.collection('a' * 32, [
            ('Alpha', png('yellow'), 1790000000000),
            ('Hold', png('green'), 1790010000000),
            ('Wrong', png('blue'), 1790020000000),
        ])
        result = prepare(self.request([collection]))
        bundle = Path(result['bundle'])
        rows = read_jsonl(bundle / 'manifest.jsonl')
        train_pixels = {row['pixel_sha256'] for row in rows if row['split'] == 'train'}
        heldout_pixels = {row['pixel_sha256'] for row in rows if row['split'] != 'train'}
        self.assertFalse(train_pixels & heldout_pixels)
        self.assertTrue(all(row['split'] == 'val' for row in rows if row['label'] == 'Hold'))
        self.assertNotIn(pixels(png('blue'))[0], train_pixels)

    def test_missing_vetted_recipe_fails_before_export(self):
        (self.training / 'named-continuation/final/names/train.yml').unlink()
        collection = self.collection('a' * 32, [('Alpha', png('yellow'), 1790000000000)])
        with self.assertRaisesRegex(ValueError, 'Names training recipe is missing'):
            prepare(self.request([collection]))

    def test_virtualenv_interpreter_symlink_keeps_its_environment(self):
        interpreter = self.training / 'desktop-train-gpu/bin/python'
        interpreter.unlink()
        interpreter.symlink_to(self.training / 'desktop-gpu/bin/python')
        self.assertEqual(discover(self.training)['python'], interpreter)

    def test_every_role_starts_from_original_not_active_or_newer_fine_tuned_weights(self):
        candidate = self.training / 'named-continuation/name-retained-v15/names/checkpoints'
        candidate.mkdir(parents=True)
        (candidate / 'best_accuracy.pdparams').write_bytes(b'rejected newer checkpoint')
        config = discover(self.training)
        original = self.training / 'production-clean-start/initial.pdparams'
        self.assertEqual(config['general_checkpoint'], original)
        self.assertEqual(config['names_checkpoint'], original)
        self.assertEqual(config['starting_lineage']['names']['origin'], 'original_pretrained')
        self.assertEqual(config['starting_lineage']['names']['checkpoint_sha256'], digest(original.read_bytes()))
        self.assertEqual(config['starting_lineage']['general']['policy']['temporal_stride'], 4)
        self.assertEqual(config['starting_lineage']['names']['policy']['temporal_stride'], 2)

    def test_missing_original_initialization_never_falls_back_to_fine_tuned_candidates(self):
        (self.training / 'production-clean-start/initial.pdparams').unlink()
        with self.assertRaisesRegex(ValueError, 'Original pretrained initialization is missing'):
            discover(self.training)

    def test_original_source_and_derived_hash_changes_fail_closed(self):
        for path in [self.training / 'benchmark-models/PP-OCRv6_small_rec/pretrained.pdparams',
                     self.training / 'production-clean-start/initial.pdparams']:
            original = path.read_bytes()
            path.write_bytes(b'changed checkpoint')
            with self.assertRaisesRegex(ValueError, 'differs from its provenance'):
                discover(self.training)
            path.write_bytes(original)

    def test_original_proof_mapping_policy_and_tuned_ancestry_are_required(self):
        from lab_training_data import _proof_digest
        receipt = self.training / 'production-clean-start/provenance.json'
        original = json.loads(receipt.read_text())
        for mutation in ('proof_hash', 'missing_tensor', 'learned_tensor', 'class_mapping', 'role_policy'):
            record = json.loads(json.dumps(original)); proof = record['verification']
            if mutation == 'proof_hash': proof['bitwise_equal_tensors'] = 337
            elif mutation == 'missing_tensor': proof['mapped_tensors'] = 337
            elif mutation == 'learned_tensor': proof['collector_tuned_tensors_used'] = 1
            elif mutation == 'class_mapping': record['class_indices'][1] = 3
            elif mutation == 'role_policy': proof['policies']['names']['temporal_stride'] = 4
            if mutation != 'proof_hash': record['verification_sha256'] = _proof_digest(proof)
            receipt.write_text(json.dumps(record))
            with self.assertRaisesRegex(ValueError, 'tensor-mapping verification', msg=mutation):
                discover(self.training)

    def test_bank_only_collection_does_not_schedule_name_training(self):
        collection = self.collection('a' * 32, [('S 2 BB', png('yellow'), 1790000000000, True, 'seats[0].bank')])
        result = prepare(self.request([collection]))
        self.assertEqual(result['roles'], ['general'])
        audit = json.loads((Path(result['bundle']) / 'audit.json').read_text())
        self.assertEqual(audit['roles'], ['general'])

    def test_active_model_release_override_uses_runtime_layout_and_hashes(self):
        import shutil
        custom = self.root / 'custom-release'
        shutil.copytree(self.training / 'release-candidate', custom)
        (custom / 'models/names').rename(custom / 'specialist')
        (custom / 'runtime.json').write_text(json.dumps({'general_model': 'models/general', 'name_model': 'specialist'}))
        with patch.dict('os.environ', {'OCR_MODEL_RELEASE': str(custom)}):
            config = discover(self.training)
            self.assertEqual(config['baseline_names_model'], custom / 'specialist')
            (custom / 'specialist/model.onnx').write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'differs from its release freeze'):
                discover(self.training)

    def test_valid_reserved_label_outside_checkpoint_dictionary_is_quarantined(self):
        collection = self.collection('a' * 32, [
            ('Alpha', png('yellow'), 1790000000000),
            ('*RESERVED*', png('purple'), 1790000001000),
        ])
        result = prepare(self.request([collection]))
        bundle = Path(result['bundle'])
        self.assertNotIn('*RESERVED*', {row['label'] for row in read_jsonl(bundle / 'manifest.jsonl')})
        self.assertEqual(result['summary']['rejected'], 1)
        record = read_jsonl(bundle / 'quarantined.jsonl')[0]
        self.assertEqual(record['unsupported_characters'], ['*'])
        self.assertEqual(record['label'], '*RESERVED*')

    def test_analysis_verifies_data_once_without_gpu_or_processes(self):
        raw = png('yellow')
        old = self.collection('a' * 32, [('Alpha', raw, 1790000000000)])
        new = self.collection('b' * 32, [('Alpha', raw, 1790000001000)])
        with patch('subprocess.run', side_effect=AssertionError('Analysis must not run a process')):
            result = analyze(self.request([old, new]))
        self.assertTrue(result['ready'])
        self.assertEqual((result['accepted'], result['duplicates'], result['rejected']), (1, 1, 0))
        self.assertEqual(result['names'], 1)
        self.assertEqual(result['collections'][1]['eligible'], 1)
        self.assertEqual(result['blockers'], [])

    def test_analysis_never_materializes_training_variants_or_checkpoint_copies(self):
        selected = self.collection('a' * 32, [('Alpha', png('yellow'), 1790000000000)])
        request = self.request([selected])
        with patch('lab_training_data.build_curriculum', side_effect=AssertionError('No augmentation during checks')), \
                patch('lab_training_data.shutil.copyfile', side_effect=AssertionError('No checkpoint or dataset copies during checks')), \
                patch('pathlib.Path.write_bytes', side_effect=AssertionError('No crop image copies during checks')):
            result = analyze(request)
        self.assertTrue(result['ready'])
        bundle = Path(request['run_dir']) / 'bundle'
        self.assertFalse((bundle / 'images').exists())
        self.assertFalse((bundle / 'starting').exists())
        self.assertFalse((bundle / 'stages').exists())
        self.assertFalse(list(bundle.rglob('*.pdparams')))
        self.assertFalse(list(bundle.rglob('train.yml')))
        self.assertFalse(list(Path(request['run_dir']).rglob('*.png')))
        self.assertFalse(json.loads((bundle / 'audit.json').read_text())['training_bundle_materialized'])
        self.assertEqual(json.loads((Path(request['run_dir']) / 'data-progress.json').read_text()), {'stage': 'ready'})

    def test_metadata_only_check_snapshot_cannot_be_reused_for_training(self):
        from lab_training_data import _prepare
        from prepare_named_collection_training import collection_rows
        selected = self.collection('a' * 32, [('Alpha', png('yellow'), 1790000000000)])
        request = self.request([selected])
        self.assertTrue(analyze(request)['ready'])
        exported = Path(request['run_dir']) / 'collections'
        summary = json.loads((exported / 'summary.json').read_text())
        with self.assertRaisesRegex(ValueError, 'collection-check snapshot cannot train'):
            _prepare(request, summary)
        with (exported / 'training_candidates.jsonl').open('a') as output:
            output.write('\n')
        with self.assertRaisesRegex(ValueError, 'snapshot metadata changed'):
            collection_rows(exported)

    def test_check_progress_reports_actual_validated_crop_counts(self):
        selected = self.collection('a' * 32, [('Alpha', png('yellow'), 1790000000000)])
        events = []
        class RecordingProgress(DataProgress):
            def __call__(self, stage, **fields):
                events.append({'stage': stage, **fields})
                super().__call__(stage, **fields)
        with patch('lab_training_data.DataProgress', RecordingProgress):
            self.assertTrue(analyze(self.request([selected]))['ready'])
        self.assertEqual({row['stage'] for row in events}, {'reading', 'validating', 'deduplicating', 'reserving', 'ready'})
        counted = [row for row in events if 'completed' in row]
        self.assertEqual([(row['completed'], row['total']) for row in counted], [(0, 1), (1, 1)])
        self.assertTrue(all(row['collection_name'] == selected['name'] for row in counted))

    def test_analysis_keeps_collection_counts_when_baseline_is_missing(self):
        (self.training / 'named-continuation/final/names/train.yml').unlink()
        collection = self.collection('a' * 32, [('Alpha', png('yellow'), 1790000000000)])
        result = analyze(self.request([collection]))
        self.assertFalse(result['ready'])
        self.assertEqual(result['accepted'], 1)
        self.assertEqual(result['collections'][0]['reviewed'], 1)
        self.assertIn('Names training recipe is missing', result['blockers'][0])

    def test_analysis_counts_pending_crops_without_promoting_queue_review_flags(self):
        collection = self.collection('a' * 32, [
            ('Alpha', png('yellow'), 1790000000000, False),
            ('Beta', png('purple'), 1790000001000, False),
        ])
        with sqlite3.connect(Path(collection['directory']) / 'data.db') as connection:
            connection.execute('UPDATE queue_items SET reviewed=1 WHERE sample_key="sample1"')
        result = analyze(self.request([collection]))
        self.assertFalse(result['ready'])
        self.assertEqual((result['accepted'], result['rejected']), (0, 2))
        self.assertEqual(result['collections'][0]['pending'], 2)
        self.assertEqual(result['collections'][0]['total'], 2)
        self.assertEqual(result['collections'][0]['reviewed'], 0)

    def test_analysis_protected_holdout_failure_retains_verified_counts(self):
        collection = self.collection('a' * 32, [('Hold', png('green'), 1790000000000)])
        result = analyze(self.request([collection]))
        self.assertFalse(result['ready'])
        self.assertEqual(result['accepted'], 0)
        self.assertEqual(result['reserved'], 1)
        self.assertEqual(result['rejected'], 0)
        self.assertEqual(result['collections'][0]['reviewed'], 1)
        self.assertIn('protected holdout', result['blockers'][0])

    def test_analysis_reports_unencodable_labels_and_keeps_usable_crops(self):
        collection = self.collection('a' * 32, [
            ('Alpha', png('yellow'), 1790000000000),
            ('*RESERVED*', png('purple'), 1790000001000),
        ])
        result = analyze(self.request([collection]))
        self.assertTrue(result['ready'])
        self.assertEqual((result['accepted'], result['rejected']), (1, 1))
        self.assertIn({'reason': 'target_not_encodable_by_frozen_checkpoint', 'count': 1}, result['exclusions'])

    def test_training_readiness_reuses_frozen_preparation_and_matches_analysis(self):
        collection = self.collection('a' * 32, [
            ('Alpha', png('yellow'), 1790000000000),
            ('*RESERVED*', png('purple'), 1790000001000),
        ])
        request = self.request([collection])
        prepared = prepare(request)
        with patch('lab_training_data.export_datasets', side_effect=AssertionError('Must reuse export')), \
                patch('lab_training_data._prepare', side_effect=AssertionError('Must reuse preparation')), \
                patch('subprocess.run', side_effect=AssertionError('Must not run a process')):
            training_readiness = prepared_analysis(request, prepared)
        analysis_request = dict(request, run_dir=str(self.root / 'analysis'))
        self.assertEqual(training_readiness, analyze(analysis_request))
        self.assertIn({'reason': 'target_not_encodable_by_frozen_checkpoint', 'count': 1}, training_readiness['exclusions'])

    def test_legacy_reuses_exact_audited_pixels_and_preserves_holdouts(self):
        collection = self.legacy([('Unused', png('red')), ('Hold', png('green')), ('Test', png('blue')), ('New', png('yellow'))])
        request = self.request([collection])
        result = analyze(request)
        self.assertTrue(result['ready'])
        counts = result['collections'][0]
        self.assertEqual((counts['total'], counts['reviewed'], counts['eligible'], counts['pending']), (4, 3, 1, 1))
        self.assertEqual((result['accepted'], result['duplicates'], result['reserved'], result['rejected']), (1, 0, 2, 1))
        self.assertEqual(counts['reserved'], 2)
        self.assertIn({'reason': 'protected_holdout', 'count': 2}, result['exclusions'])
        rows = read_jsonl(Path(request['run_dir']) / 'collections/samples.jsonl')
        inherited = next(row for row in rows if row['label'] == 'Unused')
        self.assertEqual(inherited['label_evidence'], 'audited_baseline')
        self.assertFalse(inherited['visually_verified'])
        self.assertIsNone(inherited['review_event'])
        self.assertEqual(inherited['historical_review']['split'], 'train')
        records = read_jsonl(Path(request['run_dir']) / 'bundle/manifest.jsonl')
        self.assertFalse({'Hold', 'Test'} & {row['label'] for row in records if row['split'] == 'train'})

    def test_legacy_applies_recorded_corrections_without_changing_source(self):
        manifest = self.training / 'named-continuation/final/manifest.jsonl'
        rows = read_jsonl(manifest)
        rows[0].update(label='Corrected', original_label='Unused', label_corrected=True)
        write_jsonl(manifest, rows)
        collection = self.legacy([('Unused', png('red'))])
        request = self.request([collection])
        self.assertTrue(analyze(request)['ready'])
        exported = read_jsonl(Path(request['run_dir']) / 'collections/samples.jsonl')[0]
        self.assertEqual(exported['label'], 'Corrected')
        self.assertEqual(exported['source_label'], 'Unused')
        with sqlite3.connect(Path(collection['directory']) / 'data.db') as connection:
            self.assertEqual(connection.execute('SELECT label FROM images').fetchone()[0], 'Unused')

    def test_legacy_does_not_trust_changed_pixels_or_contradictory_current_label(self):
        collection = self.legacy([('Unused', png('yellow')), ('Different', png('red'))])
        result = analyze(self.request([collection]))
        self.assertFalse(result['ready'])
        self.assertEqual(result['collections'][0]['reviewed'], 0)
        self.assertEqual(result['collections'][0]['pending'], 2)
        self.assertIn({'reason': 'current_label_conflicts_with_audited_baseline', 'count': 1}, result['exclusions'])

    def test_current_legacy_review_takes_precedence_over_historical_label(self):
        collection = self.collection('legacy', [('Current', png('red'), 1790000000000)])
        request = self.request([collection])
        self.assertTrue(analyze(request)['ready'])
        rows = read_jsonl(Path(request['run_dir']) / 'collections/samples.jsonl')
        self.assertEqual(rows[0]['label'], 'Current')
        self.assertEqual(rows[0]['label_evidence'], 'durable_human_review_event')
        self.assertNotIn('historical_review', rows[0])

    def test_current_ai_block_cannot_be_overridden_by_legacy_audit(self):
        collection = self.legacy([('Unused', png('red'))])
        with patch('export_reviewed_dataset._current_ai_check', return_value={
            'successful_current_check': False, 'state': 'flagged', 'job_state': 'completed',
        }):
            result = analyze(self.request([collection]))
        self.assertFalse(result['ready'])
        self.assertEqual(result['collections'][0]['reviewed'], 0)
        self.assertEqual(result['collections'][0]['blocked'], 1)

    def test_legacy_keeps_audited_optimization_exclusion(self):
        manifest = self.training / 'named-continuation/final/manifest.jsonl'
        rows = read_jsonl(manifest)
        rows[0]['optimize'] = False
        write_jsonl(manifest, rows)
        collection = self.legacy([('Unused', png('red'))])
        result = analyze(self.request([collection]))
        self.assertFalse(result['ready'])
        self.assertEqual(result['collections'][0]['reviewed'], 1)
        self.assertEqual(result['collections'][0]['eligible'], 0)
        self.assertIn({'reason': 'audited_optimization_exclusion', 'count': 1}, result['exclusions'])

    def test_legacy_requires_exact_png_hash_as_well_as_decoded_pixels(self):
        encoded = io.BytesIO()
        Image.new('RGB', (32, 16), 'red').save(encoded, format='PNG', compress_level=0)
        alternative = encoded.getvalue()
        self.assertEqual(pixels(alternative), pixels(png('red')))
        self.assertNotEqual(digest(alternative), digest(png('red')))
        collection = self.legacy([('Unused', alternative)])
        result = analyze(self.request([collection]))
        self.assertFalse(result['ready'])
        self.assertEqual(result['collections'][0]['reviewed'], 0)

    def test_unreviewed_other_collection_cannot_inherit_legacy_audit(self):
        collection = self.collection('a' * 32, [('Unused', png('red'), 1790000000000, False)])
        result = analyze(self.request([collection]))
        self.assertFalse(result['ready'])
        self.assertEqual(result['collections'][0]['reviewed'], 0)

    def test_reserved_holdouts_do_not_double_count_duplicates_or_optimization_exclusions(self):
        manifest = self.training / 'named-continuation/final/manifest.jsonl'
        rows = read_jsonl(manifest)
        rows[1]['optimize'] = False
        write_jsonl(manifest, rows)
        collection = self.legacy([('Unused', png('red')), ('Hold', png('green')), ('Test', png('blue')), ('Test', png('blue'))])
        request = self.request([collection])
        result = analyze(request)
        self.assertTrue(result['ready'])
        self.assertEqual((result['accepted'], result['duplicates'], result['reserved'], result['rejected']), (1, 1, 2, 0))
        self.assertEqual(result['collections'][0]['reserved'], 2)
        self.assertEqual(result['collections'][0]['blocked'], 0)
        audit = json.loads((Path(request['run_dir']) / 'bundle/audit.json').read_text())
        self.assertEqual(audit['summary']['reserved'], 2)
        self.assertEqual(audit['summary']['rejected'], 0)


class ReservationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def row(self, key, dataset='collection', groups=None, pixel=None):
        return {'sample_id': f'named:{dataset}:{key}', 'sample_key': key,
                'category': 'name', 'label': 'Alpha', 'pixel_sha256': pixel or digest(key.encode()),
                'dataset_id': dataset, 'origin': 'named', 'groups': groups or [dataset + ':capture:' + key],
                'known_splits': [], 'reviewed': True, 'image_integrity_valid': True}

    def reserve(self, rows, baseline=(), inventory=None, ids=('collection',)):
        return reserve_splits(self.root, list(baseline), rows, inventory or rows,
                              [{'id': identity} for identity in ids])

    def test_whole_components_reserve_benchmark_validation_and_training(self):
        rows = [self.row(str(index)) for index in range(3)]
        _, report = self.reserve(rows)
        self.assertEqual(report['collections']['collection']['components'], {'train': 1, 'val': 1, 'test': 1})
        self.assertEqual(report['collections']['collection']['reserved'], 2)
        self.assertEqual(report['collections']['collection']['reasons'], [])

    def test_progress_throttles_intermediate_counts_but_keeps_real_completion(self):
        progress = DataProgress(self.root)
        with patch('lab_training_data.time.monotonic', side_effect=[1, 1.01, 1.02, 1.03]):
            progress('reading', collection_name='Example')
            progress('validating', completed=0, total=2, collection_name='Example')
            progress('validating', completed=1, total=2, collection_name='Example')
            self.assertEqual(json.loads((self.root / 'data-progress.json').read_text())['completed'], 0)
            progress('validating', completed=2, total=2, collection_name='Example')
        self.assertEqual(json.loads((self.root / 'data-progress.json').read_text())['completed'], 2)

    def test_newer_duplicate_and_new_capture_keep_prior_reservations(self):
        rows = [self.row(str(index)) for index in range(3)]
        self.reserve(rows)
        prior = {row['sample_key']: row['known_splits'] for row in rows}
        updated = [self.row(str(index)) for index in reversed(range(3))]
        updated += [self.row('newer', dataset='other', pixel=rows[0]['pixel_sha256']), self.row('fresh')]
        _, report = self.reserve(updated, ids=('collection', 'other'))
        for row in updated[:3]:
            self.assertEqual(row['known_splits'], prior[row['sample_key']])
        self.assertEqual(updated[3]['known_splits'], prior['0'])
        self.assertEqual(report['collections']['other']['components'], {prior['0'][0]: 1})

    def test_tiny_collection_reserves_its_only_component_and_explains_not_ready(self):
        rows = [self.row('only')]
        _, report = self.reserve(rows)
        self.assertEqual(rows[0]['known_splits'], ['test'])
        self.assertEqual(report['collections']['collection']['reserved'], 1)
        self.assertTrue(any('training' in reason for reason in report['collections']['collection']['reasons']))

    def test_incremental_collections_gain_training_then_validation_without_moving_test(self):
        rows = [self.row('one')]
        self.reserve(rows)
        rows.append(self.row('two'))
        self.reserve(rows)
        rows.append(self.row('three'))
        self.reserve(rows)
        self.assertEqual([row['known_splits'] for row in rows], [['test'], ['train'], ['val']])

    def test_test_selection_prefers_components_covering_both_model_roles(self):
        wide = [self.row('name', groups=['mixed']), dict(self.row('bank', groups=['mixed']), category='bank')]
        rows = wide + [self.row('narrow-a'), self.row('narrow-b')]
        _, report = self.reserve(rows)
        self.assertEqual([row['known_splits'] for row in wide], [['test'], ['test']])
        self.assertEqual(report['collections']['collection']['test_roles'], {'names': 1, 'general': 1})

    def test_shared_component_supplies_benchmark_to_every_collection(self):
        common = self.row('common')
        duplicate = self.row('duplicate', dataset='other', pixel=common['pixel_sha256'])
        rows = [common, duplicate, self.row('unique-a'), self.row('unique-b')]
        _, report = self.reserve(rows, ids=('collection', 'other'))
        self.assertEqual(common['known_splits'], ['test'])
        self.assertEqual(duplicate['known_splits'], ['test'])
        self.assertEqual(report['collections']['other']['test'], 1)

    def test_cross_process_updates_keep_both_collections(self):
        code = 'import json,sys;from lab_training_data import reserve_splits;r=json.load(sys.stdin);reserve_splits(r["root"],[],r["rows"],r["rows"],r["collections"])'
        processes = []
        for identity in ('a', 'b'):
            payload = {'root': str(self.root), 'rows': [self.row(identity, dataset=identity)], 'collections': [{'id': identity}]}
            process = subprocess.Popen([sys.executable, '-c', code], cwd=Path(__file__).parent,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            process.stdin.write(json.dumps(payload))
            process.stdin.close()
            processes.append(process)
        for process in processes:
            process.wait(timeout=30)
            self.assertEqual(process.returncode, 0, process.stderr.read())
            process.stdout.close()
            process.stderr.close()
        ledger = json.loads((self.root / 'split-reservations.json').read_text())
        self.assertEqual(set(ledger['collections']), {'a', 'b'})
        self.assertTrue(all(row['test'] == 1 for row in ledger['collections'].values()))

    def test_baseline_training_and_holdout_pins_are_never_moved(self):
        for role in ('train', 'val', 'test'):
            with self.subTest(role=role):
                row = self.row(role)
                baseline = dict(self.row('base-' + role, pixel=row['pixel_sha256']), origin='baseline', pinned_split=role)
                self.reserve([row], [baseline])
                self.assertEqual(row['known_splits'], [role])
        report = json.loads((self.root / 'split-reservations.json').read_text())
        self.assertEqual(report['collections']['collection']['test'], 1)

    def test_transitive_capture_bridge_keeps_conflicting_roles_for_quarantine(self):
        rows = [self.row(str(index)) for index in range(3)]
        self.reserve(rows)
        training = next(row for row in rows if row['known_splits'] == ['train'])
        heldout = next(row for row in rows if row['known_splits'] == ['test'])
        bridge = [self.row('bridge-a', pixel=training['pixel_sha256'], groups=['shared-capture']),
                  self.row('bridge-b', pixel=heldout['pixel_sha256'], groups=['shared-capture'])]
        self.reserve(bridge)
        self.assertEqual(bridge[0]['known_splits'], ['test', 'train'])
        self.assertEqual(bridge[1]['known_splits'], ['test', 'train'])

    def test_quarantined_empty_alias_cannot_supply_collection_coverage(self):
        old = dict(self.row('old', dataset='legacy'), origin='baseline', pinned_split='train')
        alias = dict(self.row('alias', pixel=old['pixel_sha256']), label='', quarantined_empty_partition_alias=True)
        _, report = self.reserve([], [old], inventory=[alias])
        self.assertEqual(report['collections']['collection']['components'], {})
        self.assertEqual(report['collections']['collection']['reserved'], 0)


class ReservationIntegrationTest(unittest.TestCase):
    collection = PreparationTest.collection
    request = PreparationTest.request
    original_fixture = PreparationTest.original_fixture

    def setUp(self):
        PreparationTest.setUp(self)
        self.reservation_policy.stop()

    def test_all_catalog_collections_registered_without_training_unselected(self):
        selected = self.collection('a' * 32, [('Alpha', png(color), 1790000000000 + index * 900_000)
                                            for index, color in enumerate(('yellow', 'purple', 'orange'))])
        other = self.collection('b' * 32, [('Beta', png('cyan'), 1790000000000)])
        other['archived'] = True
        request = self.request([selected])
        request['reservation_collections'] = [selected, other]
        result = analyze(request)
        self.assertTrue(result['ready'], result['blockers'])
        self.assertEqual(result['reserved'], 2)
        self.assertEqual(result['accepted'], 1)
        ledger = json.loads((self.training / 'split-reservations.json').read_text())
        self.assertEqual(ledger['collections'][other['id']]['test'], 1)
        records = read_jsonl(Path(request['run_dir']) / 'bundle/manifest.jsonl')
        self.assertFalse(any(row['dataset_id'] == other['id'] for row in records))

    def test_unselected_reviewed_conflict_cannot_leak_into_selected_training(self):
        selected = self.collection('a' * 32, [('Alpha', png(color), 1790000000000 + index * 900_000)
                                            for index, color in enumerate(('yellow', 'purple', 'orange'))])
        other = self.collection('b' * 32, [('Beta', png('yellow'), 1790000000000)])
        request = self.request([selected])
        request['reservation_collections'] = [selected, other]
        result = analyze(request)
        self.assertTrue(result['ready'], result['blockers'])
        records = read_jsonl(Path(request['run_dir']) / 'bundle/manifest.jsonl')
        self.assertFalse(any(row['pixel_sha256'] == pixels(png('yellow'))[0] for row in records))
        self.assertEqual(result['reservations']['global_blocked_pixel_groups'], 1)

    def test_tiny_analysis_counts_reserved_and_has_no_training_leak(self):
        selected = self.collection('a' * 32, [('Alpha', png('yellow'), 1790000000000)])
        request = self.request([selected])
        result = analyze(request)
        self.assertFalse(result['ready'])
        self.assertEqual((result['accepted'], result['reserved'], result['rejected']), (0, 1, 0))
        self.assertEqual(result['collections'][0]['reservations']['test'], 1)

    def test_inserting_older_session_does_not_renumber_existing_session_groups(self):
        from export_reviewed_dataset import export_datasets
        from prepare_named_collection_training import collection_rows
        selected = self.collection('a' * 32, [('Alpha', png(color), 1790000000000 + index * 900_000)
                                            for index, color in enumerate(('yellow', 'purple'))])
        output = self.root / 'export'
        export_datasets([selected], output)
        before, _, _ = collection_rows(output)
        inventory = read_jsonl(output / 'samples.jsonl')
        inventory.append({'dataset_id': selected['id'], 'provenance': {'capture_group': selected['id'] + ':older',
                          'source_capture_timestamp': 1780000000000}})
        write_jsonl(output / 'samples.jsonl', inventory)
        after, _, _ = collection_rows(output)
        self.assertEqual([row['fresh_session_groups'] for row in before], [row['fresh_session_groups'] for row in after])
        self.assertTrue(all(':inferred-session-start:' in group for row in after for group in row['fresh_session_groups']))

    def append_alias(self, selected, capture, label, raw):
        key = 'later-alias'
        pixel, _ = pixels(raw)
        with sqlite3.connect(Path(selected['directory']) / 'data.db') as connection:
            stamp = connection.execute('SELECT timestamp FROM full_captures WHERE filename=?', (capture,)).fetchone()[0]
            connection.execute('INSERT INTO queue_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                               (99, key, capture, capture, None, '{}', 1, 'seats[1].name', stamp, 1, 0, label, None, pixel, raw))
            connection.execute('INSERT INTO review_samples VALUES(?,?,?,?,?,?,?)',
                               (key, 'seats[1].name', pixel, digest(raw), None, label, raw))
            connection.execute('INSERT INTO label_review_events VALUES(?,?,?,?,?,?,?,?,?,?)',
                               (99, key, None, None, '', label, 'manual', pixel, selected['id'], stamp + 1))

    def bridge_case(self, label, raw):
        selected = self.collection('a' * 32, [('Alpha', png(color), 1790000000000 + index * 900_000)
                                            for index, color in enumerate(('yellow', 'purple', 'orange'))])
        first = self.request([selected])
        self.assertTrue(analyze(first)['ready'])
        records = read_jsonl(Path(first['run_dir']) / 'bundle/manifest.jsonl')
        heldout = next(row for row in records if row['origin'] == 'named' and row['split'] == 'test')
        index = int(heldout['sample_key'].removeprefix('sample'))
        self.append_alias(selected, f'capture{index}.png', label, raw)
        second = dict(first, run_dir=str(self.root / 'second-run'))
        result = analyze(second)
        return result, read_jsonl(Path(second['run_dir']) / 'bundle/manifest.jsonl'), heldout

    def test_reviewed_empty_alias_is_quarantined_without_poisoning_reserved_positive_session(self):
        result, records, heldout = self.bridge_case('', png('black'))
        self.assertTrue(result['ready'], result['blockers'])
        self.assertTrue(any(row['pixel_sha256'] == heldout['pixel_sha256'] and row['split'] == 'test' for row in records))
        self.assertFalse(any(row['sample_key'] == 'later-alias' for row in records))
        train = {row['pixel_sha256'] for row in records if row['split'] == 'train'}
        test = {row['pixel_sha256'] for row in records if row['split'] != 'train'}
        self.assertFalse(train & test)

    def test_first_registration_does_not_inherit_training_role_from_redundant_pinned_blank(self):
        selected = self.collection('a' * 32, [('Alpha', png(color), 1790000000000 + index * 900_000)
                                            for index, color in enumerate(('yellow', 'purple', 'orange'))])
        self.append_alias(selected, 'capture0.png', '', png('black'))
        request = self.request([selected])
        result = analyze(request)
        self.assertTrue(result['ready'], result['blockers'])
        self.assertEqual(result['collections'][0]['reservations']['test'], 1)
        samples = read_jsonl(Path(request['run_dir']) / 'collections/samples.jsonl')
        alias = next(row for row in samples if row['sample_key'] == 'later-alias')
        self.assertTrue(alias['quarantined_empty_partition_alias'])

    def test_nonempty_alias_still_quarantines_the_whole_conflicting_session(self):
        result, records, heldout = self.bridge_case('Unused', png('red'))
        self.assertTrue(result['ready'], result['blockers'])
        self.assertFalse(any(row['pixel_sha256'] == heldout['pixel_sha256'] for row in records))
        self.assertTrue(any(row['reason'] == 'new_capture_component_bridges_pinned_roles'
                            for row in read_jsonl(self.root / 'second-run/preparation-exclusions.jsonl')))


if __name__ == '__main__':
    unittest.main()
