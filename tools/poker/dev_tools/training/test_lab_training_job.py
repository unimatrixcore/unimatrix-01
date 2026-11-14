import io
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

import lab_training_job as job


class TrainingJobTests(unittest.TestCase):
    def test_phase_change_drops_previous_phase_metrics_but_retains_gpu_identity(self):
        previous = {'role': 'names', 'host': 'unimatrix-01', 'gpu': 'fixture GPU',
                    'stage_id': 'names-base', 'state': 'training', 'epoch': 4, 'epochs': 4,
                    'step': 600, 'global_step': 600, 'loss': .01, 'eta_seconds': 0,
                    'elapsed_seconds': 50, 'steps_per_epoch': 150,
                    'waiting_reason': 'Old transfer operation'}
        incoming = {'role': 'names', 'host': 'unimatrix-01', 'stage_id': 'names',
                    'state': 'initializing', 'epochs': 6, 'steps_per_epoch': 200,
                    'waiting_reason': 'Initializing model and data loader'}
        merged = job.merge_worker_progress(previous, incoming)
        self.assertEqual(merged, {**incoming, 'gpu': 'fixture GPU'})
        measured = job.merge_worker_progress(merged, {
            'stage_id': 'names', 'state': 'training', 'epoch': 1, 'step': 10, 'loss': .2})
        self.assertNotIn('waiting_reason', measured)
        self.assertEqual(measured['epochs'], 6)
        self.assertEqual(measured['epoch'], 1)

    def test_stage_chain_reset_reaches_published_workers_before_first_epoch(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            log = run / 'names.log'
            workers = [{'role': 'general', 'state': 'completed'}, {
                'role': 'names', 'host': 'unimatrix-01', 'gpu': 'remote fixture',
                'stage_id': 'names-base', 'state': 'completed', 'epoch': 4, 'epochs': 4,
                'step': 600, 'loss': .01, 'eta_seconds': 0}]
            incoming = {'role': 'names', 'host': 'unimatrix-01', 'stage_id': 'names',
                        'state': 'initializing', 'epochs': 6,
                        'waiting_reason': 'Initializing model and data loader'}
            def launch(*args, **kwargs):
                log.write_text(job.PROGRESS_PREFIX + json.dumps(incoming) + '\n')
                return types.SimpleNamespace(stdin=None, poll=lambda: 0)
            updates = []
            with patch.object(job.subprocess, 'Popen', side_effect=launch):
                job._run_stage_workers([{'args': [], 'role': 'names', 'stages': ['names-base', 'names'],
                                         'remote': True, 'log': log}], workers, run,
                                       lambda **fields: updates.append(fields))
            published = json.loads((run / 'workers.json').read_text())[1]
            self.assertEqual(published, {**incoming, 'gpu': 'remote fixture'})
            self.assertEqual(updates[0]['workers'][1], published)

    def test_relocation_changes_image_paths_and_preserves_labels(self):
        import yaml
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary)
            for role in ('general', 'names'):
                directory = bundle / role
                directory.mkdir()
                (directory / 'train.yml').write_text(yaml.safe_dump({'Global': {'pretrained_model': '/old/bundle/starting/model'},
                    'Train': {'dataset': {'label_file_list': ['/old/bundle/' + role + '/train.txt']}}}))
                for split in ('train', 'val', 'test'):
                    (directory / (split + '.txt')).write_text('/old/bundle/images/one.png\tName With Space\n')
            job.relocate_bundle(bundle, '/old/bundle')
            config = yaml.safe_load((bundle / 'names/train.yml').read_text())
            self.assertEqual(config['Global']['pretrained_model'], str(bundle / 'starting/model'))
            self.assertEqual((bundle / 'names/train.txt').read_text(), str(bundle / 'images/one.png') + '\tName With Space\n')

    def benchmark_fixture(self, root, prior, candidate):
        conditions = ['identity', 'brightness_minus30', 'jpeg80', 'scale60']
        for side, rows in [('baseline', prior), ('candidate', candidate)]:
            directory = root / side
            directory.mkdir()
            protocol = {'manifest_sha256': 'f' * 64, 'conditions': conditions, 'samples': len(rows),
                        'validation_contract': {'version': 1, 'sha256': 'e' * 64}}
            (directory / 'protocol.json').write_text(json.dumps(protocol))
            for condition in conditions:
                folder = directory / condition
                folder.mkdir()
                values = [{**row, 'category': 'name', 'model_role': 'names', 'split': 'test',
                           'scope': 'real_observation', 'condition': condition,
                           'file_sha256': hashlib.sha256(row['sample_id'].encode()).hexdigest(),
                           'pixel_sha256': hashlib.sha256((row['sample_id'] + ':pixels').encode()).hexdigest()}
                          for row in rows]
                (folder / 'predictions.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in values))
        return root / 'candidate', root / 'baseline'

    def mutate_benchmark_row(self, root, side, folder_condition, **changes):
        path = root / side / folder_condition / 'predictions.jsonl'
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        rows[0].update(changes)
        path.write_text(''.join(json.dumps(row) + '\n' for row in rows))

    def test_benchmark_counts_regressions_errors_and_character_distance(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            prior = [{'sample_id': 'a', 'label': 'abc', 'raw_prediction': 'abc', 'raw_exact': True, 'inference_ms': 2},
                     {'sample_id': 'b', 'label': '', 'raw_prediction': 'x', 'raw_exact': False, 'inference_ms': 4}]
            candidate = [{**prior[0], 'raw_prediction': 'ac', 'raw_exact': False},
                         {**prior[1], 'raw_prediction': '', 'raw_exact': True}]
            new, baseline = self.benchmark_fixture(root, prior, candidate)
            result = job.benchmark_summary(new, baseline)
            self.assertEqual(result['exact_match'], .5)
            self.assertEqual(result['cer'], 1 / 3)
            self.assertEqual(result['regressions'], 1)
            self.assertEqual(result['improved'], 1)
            self.mutate_benchmark_row(root, 'candidate', 'identity', error='bad image')
            with self.assertRaisesRegex(ValueError, 'processing errors'):
                job.benchmark_summary(new, baseline)

    def test_benchmark_rejects_changed_labels_pixels_roles_and_condition_metadata(self):
        base = {'sample_id': 'a', 'label': 'abc', 'raw_prediction': 'abc', 'raw_exact': True, 'inference_ms': 2}
        cases = [{'label': 'ABC', 'raw_prediction': 'ABC'}, {'category': 'bank', 'model_role': 'general'},
                 {'file_sha256': '0' * 64}, {'pixel_sha256': '0' * 64}, {'scope': 'synthetic_control'},
                 {'split': 'train'}, {'model_role': 'general'}, {'condition': 'jpeg80'}]
        for changes in cases:
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                new, baseline = self.benchmark_fixture(root, [base], [base])
                self.mutate_benchmark_row(root, 'candidate', 'identity', **changes)
                with self.assertRaises(ValueError):
                    job.benchmark_summary(new, baseline)

    def test_benchmark_rejects_duplicate_ids_and_changed_stress_sample_universe(self):
        base = {'sample_id': 'a', 'label': 'abc', 'raw_prediction': 'abc', 'raw_exact': True, 'inference_ms': 2}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            new, baseline = self.benchmark_fixture(root, [base, base], [base, base])
            with self.assertRaisesRegex(ValueError, 'unique nonempty'):
                job.benchmark_summary(new, baseline)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            new, baseline = self.benchmark_fixture(root, [base], [base])
            for side in ('candidate', 'baseline'):
                self.mutate_benchmark_row(root, side, 'scale60', sample_id='different')
            with self.assertRaisesRegex(ValueError, 'sample identities differ'):
                job.benchmark_details(new, baseline)

    def test_benchmark_rejects_stale_raw_exact_flags_and_mismatched_protocol(self):
        base = {'sample_id': 'a', 'label': 'Abc', 'raw_prediction': 'Abc', 'raw_exact': True, 'inference_ms': 2}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            new, baseline = self.benchmark_fixture(root, [base], [base])
            self.mutate_benchmark_row(root, 'candidate', 'identity', raw_prediction='abc')
            with self.assertRaisesRegex(ValueError, 'case-sensitive prediction truth'):
                job.benchmark_summary(new, baseline)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            new, baseline = self.benchmark_fixture(root, [base], [base])
            path = baseline / 'protocol.json'
            protocol = json.loads(path.read_text())
            protocol['manifest_sha256'] = '0' * 64
            path.write_text(json.dumps(protocol))
            with self.assertRaisesRegex(ValueError, 'same frozen manifest'):
                job.benchmark_summary(new, baseline)

    def test_benchmark_fails_on_baseline_or_candidate_stress_processing_error(self):
        base = {'sample_id': 'a', 'label': 'abc', 'raw_prediction': 'abc', 'raw_exact': True, 'inference_ms': 2}
        for side in ('baseline', 'candidate'):
            with self.subTest(side=side), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                new, baseline = self.benchmark_fixture(root, [base], [base])
                self.mutate_benchmark_row(root, side, 'jpeg80', error='GPU inference failed', raw_prediction=None, raw_exact=False)
                for compare in (job.benchmark_summary, job.benchmark_details):
                    with self.assertRaisesRegex(ValueError, side + ' jpeg80 benchmark has processing errors'):
                        compare(new, baseline)

    def test_benchmark_pairs_reordered_outputs_by_identity(self):
        rows = [{'sample_id': key, 'label': label, 'raw_prediction': label, 'raw_exact': True, 'inference_ms': 2}
                for key, label in [('a', 'First'), ('b', 'Second')]]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            new, baseline = self.benchmark_fixture(root, rows, list(reversed(rows)))
            result = job.benchmark_summary(new, baseline)
            self.assertEqual((result['exact_match'], result['regressions'], result['improved']), (1, 0, 0))
            self.assertTrue(all(row['samples'] == 2 for row in job.benchmark_details(new, baseline)))

    def test_remote_connection_loss_terminates_training_process(self):
        reader, writer = os.pipe()
        disconnect = threading.Timer(.3, lambda: os.close(writer))
        disconnect.start()
        with tempfile.TemporaryDirectory() as temporary:
            tools = Path(temporary)
            (tools / 'names').mkdir()
            (tools / 'run_named_training.py').write_text('import time; time.sleep(60)\n')
            processes = []
            original = subprocess.Popen
            def spawn(*args, **kwargs):
                process = original(*args, **kwargs)
                processes.append(process)
                return process
            with patch.object(job, 'TOOLS', tools), patch.object(sys, 'stdin', types.SimpleNamespace(fileno=lambda: reader)), \
                    patch.object(job.signal, 'signal'), patch.object(job.subprocess, 'Popen', side_effect=spawn):
                with self.assertRaisesRegex(InterruptedError, 'SSH connection closed'):
                    job.role_job('names', tools, tools, remote=True)
            self.assertIsNotNone(processes[0].returncode)
        disconnect.join()
        os.close(reader)

    def test_cleanup_kills_descendants_after_group_leader_exits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / 'descendant'
            child = 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'
            script = 'import subprocess,sys,time; p=subprocess.Popen([sys.executable,"-c",sys.argv[2]]); open(sys.argv[1],"w").write(str(p.pid)); time.sleep(60)'
            process = subprocess.Popen([sys.executable, '-c', script, str(marker), child], start_new_session=True)
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                descendant = int(marker.read_text())
                time.sleep(.2)
                job.terminate_group(process)
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    stat = Path(f'/proc/{descendant}/stat')
                    if not stat.exists() or stat.read_text().split(') ', 1)[1].startswith('Z'):
                        break
                    time.sleep(.02)
                else:
                    self.fail('Training descendant survived process-group cleanup')
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, 9)
                    process.wait()

    def test_remote_success_exits_while_ssh_stdin_remains_open(self):
        with tempfile.TemporaryDirectory() as temporary:
            tools = Path(temporary)
            (tools / 'names').mkdir()
            (tools / 'run_named_training.py').write_text('print("training completed")\n')
            code = ('import sys; from pathlib import Path; '
                    'sys.path.insert(0,sys.argv[1]); import lab_training_job as job; '
                    'job.TOOLS=Path(sys.argv[2]); '
                    'job.role_job("names",job.TOOLS,job.TOOLS,remote=True)')
            process = subprocess.Popen([sys.executable, '-c', code, str(job.TOOLS), str(tools)],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertEqual(process.wait(timeout=5), 0, process.stderr.read().decode())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                for stream in (process.stdin, process.stdout, process.stderr):
                    stream.close()

    def test_supervisor_pins_models_and_preserves_active_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tools = root / 'source/dev_tools/training'
            tools.mkdir(parents=True)
            (tools / 'tool.py').write_text('frozen implementation\n')
            run = root / 'run'
            run.mkdir()
            baseline = root / 'active'
            for role in ('general', 'names'):
                (baseline / role).mkdir(parents=True)
                (baseline / role / 'model.onnx').write_bytes(b'active weights')
                (baseline / role / 'characters.json').write_text('["blank"]')
            request = {'id': 'version', 'run_dir': str(run), 'training_root': str(root), 'epochs': 6}
            (run / 'run.json').write_text(json.dumps({'id': 'version', 'created_at': 1, 'status': 'queued', 'collections': ['chosen'], 'epochs': 6}))
            def prepare(value):
                bundle = run / 'bundle'
                bundle.mkdir()
                for name in ('manifest.jsonl', 'test.jsonl'):
                    (bundle / name).write_text('{}\n')
                (bundle / 'audit.json').write_text(json.dumps({'starting_lineage': {
                    'names': {'origin': 'original_pretrained', 'checkpoint_sha256': 'a' * 64}}}))
                return {'bundle': str(bundle), 'python': sys.executable, 'roles': ['general', 'names'],
                        'baseline_general_model': str(baseline / 'general'), 'baseline_names_model': str(baseline / 'names'),
                        'summary': {'accepted': 2, 'duplicates': 1, 'rejected': 0}}
            def export(prepared, directory):
                for role in ('general', 'names'):
                    target = Path(prepared['bundle']) / role
                    (target / 'portable').mkdir(parents=True)
                    (target / 'checkpoints').mkdir()
                    (target / 'portable/model.onnx').write_bytes(b'candidate weights')
                    (target / 'portable/characters.json').write_text('["blank"]')
                    (target / 'checkpoints/best_accuracy.pdparams').write_bytes(b'checkpoint')
            module = types.SimpleNamespace(discover=lambda value: {
                'python': sys.executable, 'baseline_general_model': baseline / 'general',
                'baseline_names_model': baseline / 'names'}, prepare=prepare, analyze=lambda value: {}, prepared_analysis=lambda request, prepared: {"ready": True})
            with patch.object(job, 'TOOLS', tools), patch.dict(sys.modules, {'lab_training_data': module}), \
                    patch.object(job.signal, 'signal'), patch.object(job, 'command', side_effect=lambda args, log, **kwargs: log.write_text('{"gpu":"Test GPU"}\n')), \
                    patch.object(job, 'probe_remote', return_value={}), patch.object(job, 'train_pair'), \
                    patch.object(job, 'export_models', side_effect=export), \
                    patch.object(job, 'benchmark', return_value={'exact_match': .9, 'cer': .1, 'p95_ms': 3}):
                job.supervise(request)
            state = json.loads((run / 'run.json').read_text())
            self.assertEqual(state['status'], 'completed')
            self.assertEqual(state['pid'], os.getpid())
            version = json.loads((run / 'version.json').read_text())
            self.assertFalse(version['runtime_model_replaced'])
            self.assertEqual(version['starting_lineage']['names']['origin'], 'original_pretrained')
            self.assertEqual(version['audit_sha256'], hashlib.sha256((run / 'bundle/audit.json').read_bytes()).hexdigest())
            self.assertIn('portable/model.onnx', version['artifacts']['names'])
            self.assertEqual((baseline / 'names/model.onnx').read_bytes(), b'active weights')
            self.assertEqual((run / 'baseline/names/model.onnx').read_bytes(), b'active weights')
            frozen = json.loads((run / 'prepared.json').read_text())
            self.assertEqual(frozen['baseline_pins']['names']['model.onnx'], job.file_sha(run / 'baseline/names/model.onnx'))

    def test_gpu_failure_is_persisted_without_preparing_or_training(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tools = root / 'source/dev_tools/training'
            tools.mkdir(parents=True)
            run = root / 'run'
            run.mkdir()
            (run / 'run.json').write_text(json.dumps({'id': 'version', 'status': 'queued'}))
            prepare = unittest.mock.Mock()
            module = types.SimpleNamespace(discover=lambda value: {'python': sys.executable}, prepare=prepare, analyze=lambda value: {}, prepared_analysis=lambda request, prepared: {"ready": True})
            with patch.object(job, 'TOOLS', tools), patch.dict(sys.modules, {'lab_training_data': module}), \
                    patch.object(job.signal, 'signal'), patch.object(job, 'command', side_effect=RuntimeError('CUDA unavailable')):
                with self.assertRaisesRegex(RuntimeError, 'CUDA unavailable'):
                    job.supervise({'run_dir': str(run), 'training_root': str(root)})
            self.assertEqual(json.loads((run / 'run.json').read_text())['status'], 'failed')
            prepare.assert_not_called()

    def test_analysis_never_probes_gpus_or_trains(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tools = root / 'source/dev_tools/training'
            tools.mkdir(parents=True)
            run = root / 'run'
            run.mkdir()
            (run / 'run.json').write_text(json.dumps({'id': 'analysis', 'status': 'queued'}))
            readiness = {'ready': False, 'accepted': 0, 'blockers': ['No verified name crops']}
            (run / 'bundle/starting').mkdir(parents=True)
            (run / 'bundle/starting/general.pdparams').write_bytes(b'temporary copied checkpoint')
            (run / 'bundle/audit.json').write_text('{}')
            module = types.SimpleNamespace(discover=unittest.mock.Mock(), prepare=unittest.mock.Mock(),
                                           analyze=lambda value: readiness, prepared_analysis=unittest.mock.Mock())
            with patch.object(job, 'TOOLS', tools), patch.dict(sys.modules, {'lab_training_data': module}), \
                    patch.object(job.signal, 'signal'), patch.object(job, 'command') as command:
                job.supervise({'mode': 'analyze', 'run_dir': str(run)})
            module.discover.assert_not_called()
            module.prepare.assert_not_called()
            command.assert_not_called()
            state = json.loads((run / 'run.json').read_text())
            self.assertEqual(state['status'], 'completed')
            self.assertEqual(state['analysis'], readiness)
            self.assertEqual(json.loads((run / 'readiness.json').read_text()), readiness)
            self.assertFalse((run / 'bundle/starting').exists())
            self.assertTrue((run / 'bundle/audit.json').exists())

    def test_live_progress_uses_logged_measurements_only(self):
        empty = job.training_progress('Loading model', 'general', 'local', time.time())
        self.assertEqual(empty['state'], 'initializing')
        self.assertNotIn('epoch', empty)
        log = 'epoch: [2/6], global_step: 42, lr: 0.00001, loss: 0.023000, eta: 0:02:30'
        progress = job.training_progress(log, 'names', 'unimatrix-01', time.time() - 5)
        self.assertEqual(progress['epoch'], 2)
        self.assertEqual(progress['epochs'], 6)
        self.assertEqual(progress['loss'], .023)
        self.assertEqual(progress['step'], 42)
        self.assertEqual(progress['eta_seconds'], 150)

class CurriculumJobTests(unittest.TestCase):
    def setUp(self):
        import yaml
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / 'bundle'
        (self.bundle / 'images').mkdir(parents=True)
        (self.bundle / 'starting').mkdir()
        (self.bundle / 'dictionary.txt').write_text('A\nB\n')
        initial = self.bundle / 'starting/general.pdparams'
        initial.write_bytes(b'original pretrained initialization')
        image = self.bundle / 'images' / (hashlib.sha256(b'fixture crop').hexdigest() + '.png')
        image.write_bytes(b'fixture crop')
        self.stages = []
        for identity, role, parent, epochs in [('base', 'general', None, 8), ('general', 'general', 'base', 4),
                                               ('names-base', 'names', 'base', 4), ('names', 'names', 'names-base', 6)]:
            directory = self.bundle / ('stages/' + identity if identity in ('base', 'names-base') else identity)
            directory.mkdir(parents=True)
            previous = next((stage for stage in self.stages if stage['id'] == parent), None)
            source = Path(previous['directory']) / 'checkpoints/best_accuracy.pdparams' if previous else initial
            stage = {'id': identity, 'role': role, 'directory': str(directory), 'config': str(directory / 'train.yml'),
                     'depends_on': parent, 'checkpoint_source': str(source), 'epochs': epochs,
                     'learning_rate': 1e-5 if identity == 'names' else 2e-5, 'batch_size': 32,
                     'train_count': 2, 'validation_count': 2}
            config = {'Global': {'use_gpu': True, 'distributed': False, 'epoch_num': epochs,
                      'pretrained_model': str(source), 'save_model_dir': str(directory / 'checkpoints'),
                      'collector_name_high_resolution': role == 'names', 'character_dict_path': str(self.bundle / 'dictionary.txt')},
                      'Architecture': {'Head': {'name': 'CTCHead'}, 'Neck': {'name': 'SequenceEncoder'}}, 'Optimizer': {'lr': {'learning_rate': stage['learning_rate']}},
                      'Loss': {'name': 'CollectorBlankCTCLoss'}, 'Metric': {'ignore_space': False, 'main_indicator': 'acc'}}
            for split, section in [('train', 'Train'), ('val', 'Eval')]:
                labels = directory / (split + '.txt')
                labels.write_text(str(image) + '\tA\n' + str(image) + '\t\n')
                config[section] = {'dataset': {'label_file_list': [str(labels)], 'transforms': [{'RecResizeImg': {'image_shape': [3, 48, 320]}}]},
                                   'loader': {'shuffle': split == 'train', 'batch_size_per_card': 32}}
            (directory / 'train.yml').write_text(yaml.safe_dump(config))
            self.stages.append(stage)
        job.atomic_json(self.bundle / 'curriculum.json', {'schema_version': 1, 'stages': self.stages})
        job.atomic_json(self.bundle / 'audit.json', {'training_ready': True,
                        'general': {'starting_checkpoint_sha256': job.file_sha(initial)}})
        self.tools = self.root / 'tools'
        self.tools.mkdir()
        (self.tools / 'run_negative_ocr.py').write_text("""import argparse
from pathlib import Path
import yaml,pickle
p=argparse.ArgumentParser();p.add_argument('--source');p.add_argument('--mode');p.add_argument('--name-high-resolution',action='store_true');p.add_argument('-c');a=p.parse_args()
c=yaml.safe_load(Path(a.c).read_text());target=Path(c['Global']['save_model_dir']);target.mkdir(parents=True,exist_ok=True)
(target/'best_accuracy.pdparams').write_bytes(('trained '+Path(a.c).parent.name).encode())
(target/'best_accuracy.states').write_bytes(pickle.dumps({'epoch':1,'global_step':1,'best_model_dict':{'acc':.9,'best_epoch':1,'is_float16':False}}))
print('epoch: [1/1], global_step: 1, loss: 0.1')
print('best metric, acc: 0.9, is_float16: False, best_epoch: 1')
""")
        self.tools_patch = patch.object(job, 'TOOLS', self.tools)
        self.tools_patch.start()
        self.addCleanup(self.tools_patch.stop)
        job.seal_curriculum(self.bundle)

    def stage(self, identity):
        return next(stage for stage in job.validate_curriculum(self.bundle)['stages'] if stage['id'] == identity)

    def test_curriculum_executes_original_base_then_correct_sibling_dependencies(self):
        with self.assertRaisesRegex(ValueError, 'dependency has not completed'):
            job.execute_stage(self.bundle, 'names-base', self.root)
        for identity in ('base', 'general', 'names-base', 'names'):
            job.execute_stage(self.bundle, identity, self.root)
            self.assertTrue(job.completed_stage(self.bundle, self.stage(identity)))
        base = Path(self.stage('base')['directory']) / 'checkpoints/best_accuracy.pdparams'
        general = Path(self.stage('general')['directory']) / 'checkpoints/best_accuracy.pdparams'
        status = json.loads((Path(self.stage('names-base')['directory']) / 'training-status.json').read_text())
        self.assertEqual(status['checkpoint_sha256'], job.file_sha(base))
        self.assertNotEqual(status['checkpoint_sha256'], job.file_sha(general))
        before = (self.bundle / 'names/training-status.json').read_bytes()
        job.execute_stage(self.bundle, 'names', self.root, resume=True)
        self.assertEqual(before, (self.bundle / 'names/training-status.json').read_bytes())

    def test_curriculum_and_completed_receipts_survive_only_path_relocation(self):
        import shutil
        job.execute_stage(self.bundle, 'base', self.root)
        copied = self.root / 'remote-bundle'
        shutil.copytree(self.bundle, copied)
        job.relocate_bundle(copied, str(self.bundle))
        stages = job.validate_curriculum(copied)['stages']
        base = next(stage for stage in stages if stage['id'] == 'base')
        self.assertTrue(job.completed_stage(copied, base))
        self.assertEqual(Path(base['directory']), copied / 'stages/base')
        (copied / 'names/val.txt').write_text('tampered labels\n')
        with self.assertRaisesRegex(ValueError, 'recipe or labels changed'):
            job.validate_curriculum(copied)

    def test_stage_worker_cli_reports_the_real_stage_and_recipe_budget(self):
        import shutil
        script = self.tools / 'lab_training_job.py'
        shutil.copyfile(job.__file__, script)
        result = subprocess.run([sys.executable, str(script), '--role', 'general', '--stage', 'base',
                                 '--bundle', str(self.bundle), '--source', str(self.root)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        messages = [json.loads(line[len(job.PROGRESS_PREFIX):]) for line in result.stdout.splitlines()
                    if line.startswith(job.PROGRESS_PREFIX)]
        self.assertEqual(messages[-1]['stage_id'], 'base')
        self.assertEqual(messages[-1]['epochs'], 8)
        self.assertEqual(messages[-1]['state'], 'completed')
        self.assertEqual(messages[0]['state'], 'initializing')
        self.assertEqual(messages[0]['epochs'], 8)
        self.assertEqual(messages[0]['waiting_reason'], 'Initializing model and data loader')
        self.assertNotIn('epoch', messages[0])
        self.assertNotIn('loss', messages[0])
        self.assertTrue(job.completed_stage(self.bundle, self.stage('base')))

    def test_stage_resume_rejects_changed_dependency_and_frozen_source(self):
        job.execute_stage(self.bundle, 'base', self.root)
        job.execute_stage(self.bundle, 'names-base', self.root)
        base = Path(self.stage('base')['directory']) / 'checkpoints/best_accuracy.pdparams'
        base.write_bytes(b'changed learned dependency')
        with self.assertRaisesRegex(ValueError, 'completed curriculum stage'):
            job.execute_stage(self.bundle, 'names', self.root, resume=True)

    def test_scheduler_runs_base_before_forking_both_gpu_branches(self):
        run = self.root / 'run'
        run.mkdir()
        prepared = {'bundle': str(self.bundle), 'python': sys.executable, 'source': str(self.root),
                    'local_gpu': {'gpu': 'local fixture'}}
        remote = {'root': '/remote', 'python': '/python', 'source': '/source', 'gpu': {'gpu': 'remote fixture'}}
        batches = []
        def execute(jobs, workers, directory, update):
            batches.append([item['stages'] for item in jobs])
            for worker in jobs:
                for identity in worker['stages']:
                    job.execute_stage(self.bundle, identity, self.root)
        with patch.object(job, '_run_stage_workers', side_effect=execute), patch.object(job, 'command'), \
                patch.object(job, 'sync_to_remote'), patch.object(job, '_fetch_remote_stages'):
            job.train_curriculum(prepared, remote, run, lambda **fields: None)
        self.assertEqual(batches, [[['base']], [['general'], ['names-base', 'names']]])

    def test_scheduler_publishes_phase_targets_and_transfer_operations_before_blocking(self):
        run = self.root / 'run'
        run.mkdir()
        prepared = {'bundle': str(self.bundle), 'python': sys.executable, 'source': str(self.root),
                    'local_gpu': {'gpu': 'local fixture'}}
        remote = {'root': '/remote', 'python': '/python', 'source': '/source', 'gpu': {'gpu': 'remote fixture'}}
        updates = []
        transfers = []
        def update(**fields):
            updates.append(json.loads(json.dumps(fields)))
        def execute(jobs, workers, directory, publish):
            if jobs[0]['stages'] == ['base']:
                self.assertEqual(workers[0]['epochs'], 8)
                self.assertNotIn('epoch', workers[0])
                self.assertEqual(workers[1]['waiting_reason'], 'Waiting for shared base model')
                workers[0].update(epoch=8, loss=.005, step=15000, eta_seconds=0)
            else:
                self.assertEqual(workers[0]['stage_id'], 'general')
                self.assertEqual(workers[0]['epochs'], 4)
                self.assertEqual(workers[0]['state'], 'initializing')
                self.assertEqual(workers[1]['epochs'], 4)
                for worker in workers:
                    self.assertNotIn('epoch', worker)
                    self.assertNotIn('loss', worker)
                    self.assertNotIn('step', worker)
            for worker in jobs:
                for identity in worker['stages']:
                    job.execute_stage(self.bundle, identity, self.root)
        def transfer(*args, **kwargs):
            latest = updates[-1]
            self.assertIn('Transferring', latest['stage'])
            self.assertEqual(latest['workers'][0]['state'], 'waiting')
            self.assertEqual(latest['workers'][0]['stage_id'], 'general')
            self.assertNotIn('loss', latest['workers'][0])
            self.assertEqual(latest['workers'][1]['state'], 'waiting')
            transfers.append(latest['workers'][1]['waiting_reason'])
        with patch.object(job, '_run_stage_workers', side_effect=execute), \
                patch.object(job, 'command', side_effect=transfer), \
                patch.object(job, 'sync_to_remote', side_effect=transfer), \
                patch.object(job, '_fetch_remote_stages'):
            job.train_curriculum(prepared, remote, run, update)
        self.assertTrue(any('shared checkpoint' in reason for reason in transfers))
        self.assertTrue(any('training tools' in reason for reason in transfers))

    def test_final_version_binds_all_stage_receipts_and_actual_checkpoint_edges(self):
        for identity in ('base', 'general', 'names-base', 'names'):
            job.execute_stage(self.bundle, identity, self.root)
        for name in ('manifest.jsonl', 'test.jsonl'):
            (self.bundle / name).write_text('{}\n')
        for role in ('general', 'names'):
            directory = self.bundle / role / 'portable'
            directory.mkdir()
            (directory / 'model.onnx').write_bytes(b'fixture candidate')
            (directory / 'characters.json').write_text('["blank"]')
        run = self.root / 'run'
        run.mkdir()
        with patch.object(job, 'export_models'), patch.object(job, 'benchmark', return_value={'exact_match': 1.}):
            job.finalize_version({'bundle': str(self.bundle)}, run, lambda **fields: None, {}, self.tools, {'id': 'fixture'})
        version = json.loads((run / 'version.json').read_text())
        self.assertEqual(version['curriculum']['manifest_sha256'], job.file_sha(self.bundle / 'curriculum.json'))
        stages = {stage['id']: stage for stage in version['curriculum']['stages']}
        self.assertEqual(stages['names-base']['starting_checkpoint_sha256'], stages['base']['selected_checkpoint_sha256'])
        self.assertNotEqual(stages['names-base']['starting_checkpoint_sha256'], stages['general']['selected_checkpoint_sha256'])
        self.assertEqual(stages['names']['starting_checkpoint_sha256'], stages['names-base']['selected_checkpoint_sha256'])
        for identity, stage in stages.items():
            path = Path(self.stage(identity)['directory']) / 'training-status.json'
            self.assertEqual(stage['receipt_sha256'], job.file_sha(path))

    def test_resume_moves_only_pending_final_names_to_idle_local_gpu(self):
        for identity in ('base', 'general', 'names-base'):
            job.execute_stage(self.bundle, identity, self.root)
        job.atomic_json(self.bundle / 'general/progress.json', {
            'role': 'general', 'stage_id': 'general', 'state': 'completed',
            'epoch': 4, 'epochs': 4, 'loss': .02, 'elapsed_seconds': 200})
        frozen_manifest = (self.bundle / 'curriculum.json').read_bytes()
        frozen_recipe = (self.bundle / 'names/train.yml').read_bytes()
        completed = {identity: (Path(self.stage(identity)['directory']) / 'training-status.json').read_bytes()
                     for identity in ('base', 'general', 'names-base')}
        run = self.root / 'run'
        run.mkdir()
        prepared = {'bundle': str(self.bundle), 'python': sys.executable, 'source': str(self.root),
                    'resuming': True, 'local_gpu': {'gpu': 'idle local GPU'}}
        remote = {'root': '/remote', 'python': '/python', 'source': '/source', 'gpu': {'gpu': 'hot remote GPU'}}
        def execute(jobs, workers, directory, update):
            self.assertEqual(len(jobs), 1)
            self.assertEqual(jobs[0]['stages'], ['names'])
            self.assertEqual(jobs[0]['role'], 'names')
            self.assertFalse(jobs[0]['remote'])
            self.assertIn('--resume', jobs[0]['args'])
            self.assertEqual(workers[0]['epoch'], 4)
            self.assertEqual(workers[0]['loss'], .02)
            self.assertEqual(workers[1]['host'], 'local')
            self.assertEqual(workers[1]['gpu'], 'idle local GPU')
            job.execute_stage(self.bundle, 'names', self.root)
        with patch.object(job, '_run_stage_workers', side_effect=execute) as scheduled, \
                patch.object(job, 'command') as command, patch.object(job, 'sync_to_remote') as transfer:
            job.train_curriculum(prepared, remote, run, lambda **fields: None)
        self.assertEqual(scheduled.call_count, 1)
        command.assert_not_called()
        transfer.assert_not_called()
        self.assertEqual((self.bundle / 'curriculum.json').read_bytes(), frozen_manifest)
        self.assertEqual((self.bundle / 'names/train.yml').read_bytes(), frozen_recipe)
        for identity, receipt in completed.items():
            self.assertEqual((Path(self.stage(identity)['directory']) / 'training-status.json').read_bytes(), receipt)
        self.assertTrue(job.completed_stage(self.bundle, self.stage('names')))

    def set_validation_accuracy(self, phase, accuracy):
        import pickle
        directory = Path(self.stage(phase)['directory'])
        (directory / 'checkpoints/best_accuracy.states').write_bytes(pickle.dumps({
            'epoch': 1, 'global_step': 1, 'best_model_dict': {'acc': accuracy, 'best_epoch': 1, 'is_float16': False}}))
        (directory / 'training.log').write_text(f'best metric, acc: {accuracy}, is_float16: False, best_epoch: 1\n')

    def test_validation_selection_keeps_better_incoming_phase_and_later_tie(self):
        for phase in ('base', 'general', 'names-base', 'names'):
            job.execute_stage(self.bundle, phase, self.root)
        original = {phase: (Path(self.stage(phase)['directory']) / 'checkpoints/best_accuracy.pdparams').read_bytes()
                    for phase in ('base', 'general', 'names-base', 'names')}
        self.set_validation_accuracy('names-base', .99)
        self.set_validation_accuracy('names', .98)
        selected = job.select_models(self.bundle)
        self.assertEqual(selected['names']['selected_phase'], 'names-base')
        self.assertEqual(selected['general']['selected_phase'], 'general')
        self.assertEqual((self.bundle / 'names/selected.pdparams').read_bytes(), original['names-base'])
        self.assertEqual(job.export_checkpoint(self.bundle, 'names'), self.bundle / 'names/selected.pdparams')
        self.set_validation_accuracy('names', 1.)
        self.assertEqual(job.select_models(self.bundle)['names']['selected_phase'], 'names')
        for phase, raw in original.items():
            self.assertEqual((Path(self.stage(phase)['directory']) / 'checkpoints/best_accuracy.pdparams').read_bytes(), raw)

    def test_validation_selection_rejects_incomparable_eval_policy(self):
        import yaml
        for phase in ('base', 'general', 'names-base', 'names'):
            job.execute_stage(self.bundle, phase, self.root)
        directory = self.bundle / 'names'
        candidate = job.selection_candidate(self.bundle, self.stage('names-base'))
        config = yaml.safe_load((directory / 'train.yml').read_text())
        config['Eval']['dataset']['transforms'] = [{'RecResizeImg': {'image_shape': [3, 48, 640]}}]
        (directory / 'train.yml').write_text(yaml.safe_dump(config))
        with self.assertRaisesRegex(ValueError, 'recipe or labels changed'):
            job.select_models(self.bundle)
        candidate['evaluation_policy_sha256'] = 'incompatible'
        with patch.object(job, 'validate_curriculum', return_value={'stages': self.stages}), \
                patch.object(job, 'selection_candidate', side_effect=lambda bundle, stage: {
                    **candidate, 'phase': stage['id'], 'evaluation_policy_sha256': stage['id']}):
            with self.assertRaisesRegex(ValueError, 'validation lists, normalization'):
                job.select_models(self.bundle)

    def test_selection_rejects_metric_log_or_export_weight_tampering(self):
        for phase in ('base', 'general', 'names-base', 'names'):
            job.execute_stage(self.bundle, phase, self.root)
        selected = job.select_models(self.bundle)
        self.assertEqual(selected['names']['selected_phase'], 'names')
        (self.bundle / 'names/selected.pdparams').write_bytes(b'tampered selected copy')
        with self.assertRaisesRegex(ValueError, 'validation selection receipt'):
            job.export_checkpoint(self.bundle, 'names')
        job.select_models(self.bundle)
        (self.bundle / 'names/training.log').write_text('best metric, acc: 0.2, best_epoch: 1\n')
        with self.assertRaisesRegex(ValueError, 'disagrees with its completed training log'):
            job.select_models(self.bundle)


if __name__ == '__main__':
    unittest.main()
