import hashlib
import json
from pathlib import Path
import pickle
import tempfile
import types
import sys
import unittest
from unittest.mock import patch

from checkpoint_resume import completed_role, select_checkpoint, validate_bundle, publish_checkpoint, install_checkpoint_receipts
import lab_training_job as job


class CheckpointResumeTests(unittest.TestCase):
    def test_selects_complete_latest_with_optimizer_and_epoch_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary)
            directory = bundle / 'general/checkpoints'
            directory.mkdir(parents=True)
            for name in ('latest', 'iter_epoch_2'):
                (directory / (name + '.pdparams')).write_bytes(b'weights')
                (directory / (name + '.pdopt')).write_bytes(b'optimizer')
                (directory / (name + '.states')).write_bytes(pickle.dumps({'epoch': 3 if name == 'latest' else 2, 'global_step': 8130}))
                publish_checkpoint(directory / name, {'epoch': 3 if name == 'latest' else 2, 'global_step': 8130})
            result = select_checkpoint(bundle, 'general', 6)
            self.assertEqual(result['epoch'], 3)
            self.assertEqual(result['global_step'], 8130)
            self.assertTrue(result['prefix'].endswith('latest'))
            self.assertEqual(set(result['sha256']), {'.pdparams', '.pdopt', '.states'})

    def test_interrupted_save_invalidates_receipt_and_falls_back_to_verified_older_save(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary)
            directory = bundle / 'general/checkpoints'
            directory.mkdir(parents=True)
            interrupted = False
            def save_model(model, optimizer, model_path, logger, config, is_best=False, prefix='ppocr', **kwargs):
                target = Path(model_path) / prefix
                Path(str(target) + '.pdparams').write_bytes(str(kwargs['epoch']).encode())
                if interrupted:
                    raise InterruptedError('save interrupted after weights')
                Path(str(target) + '.pdopt').write_bytes(b'optimizer')
                Path(str(target) + '.states').write_bytes(pickle.dumps(kwargs))
            loader = types.SimpleNamespace(save_model=save_model)
            install_checkpoint_receipts(loader)
            for prefix in ('latest', 'iter_epoch_2'):
                loader.save_model(None, None, directory, None, {}, prefix=prefix, epoch=2, global_step=200)
            interrupted = True
            with self.assertRaises(InterruptedError):
                loader.save_model(None, None, directory, None, {}, prefix='latest', epoch=3, global_step=300)
            self.assertFalse((directory / 'latest.resume.json').exists())
            result = select_checkpoint(bundle, 'general', 6)
            self.assertTrue(result['prefix'].endswith('iter_epoch_2'))
            self.assertEqual(result['rejected_candidates'][0]['checkpoint'], 'latest')

    def test_unreceipted_legacy_and_tampered_triplets_are_never_blessed(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary)
            directory = bundle / 'general/checkpoints'
            directory.mkdir(parents=True)
            for suffix in ('.pdparams', '.pdopt', '.states'):
                (directory / ('latest' + suffix)).write_bytes(b'legacy')
            with self.assertRaisesRegex(ValueError, 'legacy checkpoints'):
                select_checkpoint(bundle, 'general', 6)
            publish_checkpoint(directory / 'latest', {'epoch': 2, 'global_step': 200})
            (directory / 'latest.pdopt').write_bytes(b'different optimizer generation')
            with self.assertRaisesRegex(ValueError, 'completed-save receipt'):
                select_checkpoint(bundle, 'general', 6)

    def test_damaged_latest_and_invalid_counters_do_not_prevent_valid_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary)
            directory = bundle / 'general/checkpoints'
            directory.mkdir(parents=True)
            for prefix in ('latest', 'iter_epoch_2', 'iter_epoch_1'):
                for suffix in ('.pdparams', '.pdopt', '.states'):
                    (directory / (prefix + suffix)).write_bytes(b'complete')
                publish_checkpoint(directory / prefix, {'epoch': 2, 'global_step': 200})
            (directory / 'latest.states').write_bytes(b'truncated pickle')
            path = directory / 'iter_epoch_1.resume.json'
            value = json.loads(path.read_text())
            value['epoch'] = True
            path.write_text(json.dumps(value))
            result = select_checkpoint(bundle, 'general', 6)
            self.assertTrue(result['prefix'].endswith('iter_epoch_2'))
            self.assertEqual(len(result['rejected_candidates']), 2)

    def test_save_adapter_is_installed_before_upstream_program_imports_writer(self):
        script = (Path(__file__).parent / 'run_negative_ocr.py').read_text()
        self.assertLess(script.index('install_checkpoint_receipts()'), script.index('runpy.run_path'))

    def test_refuses_incomplete_checkpoint_and_changed_completed_weights(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary)
            directory = bundle / 'names/checkpoints'
            directory.mkdir(parents=True)
            (directory / 'latest.states').write_bytes(pickle.dumps({'epoch': 3, 'global_step': 10}))
            with self.assertRaisesRegex(ValueError, 'No complete'):
                select_checkpoint(bundle, 'names', 6)
            (directory / 'best_accuracy.pdparams').write_bytes(b'changed')
            (directory.parent / 'training-status.json').write_text(json.dumps({'state': 'completed', 'selected_checkpoint_sha256': 'bad'}))
            with self.assertRaisesRegex(ValueError, 'checkpoint changed'):
                completed_role(bundle, 'names')

    def test_frozen_manifest_cannot_change_during_recovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary)
            (bundle / 'audit.json').write_text(json.dumps({'manifest_sha256': hashlib.sha256(b'original').hexdigest()}))
            (bundle / 'manifest.jsonl').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'manifest.jsonl changed'):
                validate_bundle(bundle)

    def test_reuses_completed_names_and_only_runs_unfinished_general(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            bundle = run / 'bundle'
            bundle.mkdir()
            (run / 'hosts.json').write_text('{}')
            (run / 'run.json').write_text(json.dumps({'workers': [{'role': 'names', 'state': 'completed', 'epoch': 6}]}))
            prepared = {'bundle': str(bundle), 'roles': ['general', 'names']}
            done = {'general': False, 'names': True}
            def train(value, remote, directory, update):
                self.assertIsNone(remote)
                self.assertEqual(value['roles'], ['general'])
                self.assertEqual(value['completed_roles'], ['names'])
                self.assertTrue(value['resuming'])
                done['general'] = True
            with patch('checkpoint_resume.validate_bundle'), patch('checkpoint_resume.completed_role', side_effect=lambda bundle, role: done[role]), \
                    patch.object(job, 'train_pair', side_effect=train) as trainer, patch.object(job, 'command') as command:
                job.resume_training(run, prepared, lambda **fields: None)
            trainer.assert_called_once()
            command.assert_not_called()
            self.assertEqual(prepared['roles'], ['general', 'names'])

    def test_resume_finalization_writes_run_status_not_archived_report_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tools = root / 'source/dev_tools/training'
            tools.mkdir(parents=True)
            run = root / 'run'
            run.mkdir()
            bundle = run / 'bundle'
            (bundle / 'general/export').mkdir(parents=True)
            (bundle / 'names').mkdir()
            (bundle / 'names/export-parity.json').write_text('{"original_report":true}')
            (run / 'run.json').write_text('{"id":"version","status":"queued"}')
            (run / 'version.json').write_text('{"original_version":true}')
            prepared = {'bundle': str(bundle)}
            for role in ('general', 'names'):
                directory = run / 'baseline' / role
                directory.mkdir(parents=True)
                for name in ('model.onnx', 'characters.json'):
                    (directory / name).write_bytes(b'pinned')
                prepared['baseline_' + role + '_model'] = str(directory)
            prepared['python'] = sys.executable
            prepared['baseline_pins'] = {role: {name: job.file_sha(run / 'baseline' / role / name)
                                               for name in ('model.onnx', 'characters.json')}
                                         for role in ('general', 'names')}
            (run / 'prepared.json').write_text(json.dumps(prepared))
            module = types.SimpleNamespace(analyze=None, discover=None, prepare=None, prepared_analysis=None)
            def finalize(prepared, run, update, pins, frozen_tools, request):
                update(status='completed', stage='Benchmark complete')
            with patch.object(job, 'TOOLS', tools), patch.dict(sys.modules, {'lab_training_data': module}), \
                    patch.object(job.signal, 'signal'), patch.object(job, 'command', side_effect=lambda args, path, **kwargs: path.write_text('{"gpu":"test"}')), \
                    patch.object(job, 'resume_training'), patch.object(job, 'finalize_version', side_effect=finalize):
                job.supervise({'id': 'version', 'mode': 'resume', 'attempt_id': 'a' * 32, 'run_dir': str(run)})
            self.assertEqual(json.loads((run / 'run.json').read_text())['status'], 'completed')
            self.assertFalse((bundle / 'names/export-parity.json').exists())
            archived = run / 'attempts' / ('a' * 32) / 'previous-finalization/bundle/names/export-parity.json'
            self.assertTrue(json.loads(archived.read_text())['original_report'])
            previous_version = run / 'attempts' / ('a' * 32) / 'previous-finalization/version.json'
            self.assertTrue(json.loads(previous_version.read_text())['original_version'])

    def test_changed_or_legacy_baseline_is_rejected_before_training_or_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            prepared = {}
            for role in ('general', 'names'):
                directory = run / 'baseline' / role
                directory.mkdir(parents=True)
                for name in ('model.onnx', 'characters.json'):
                    (directory / name).write_bytes(b'original baseline')
                prepared['baseline_' + role + '_model'] = str(directory)
            with self.assertRaisesRegex(ValueError, 'legacy run'):
                job.validated_baseline_pins(prepared, run)
            prepared['baseline_pins'] = {role: {name: job.file_sha(run / 'baseline' / role / name)
                                               for name in ('model.onnx', 'characters.json')}
                                         for role in ('general', 'names')}
            expected = json.loads(json.dumps(prepared['baseline_pins']))
            self.assertEqual(job.validated_baseline_pins(prepared, run), expected)
            (run / 'baseline/names/model.onnx').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'frozen baseline changed'):
                job.validated_baseline_pins(prepared, run)
            self.assertEqual(prepared['baseline_pins'], expected)

    def test_supervisor_rejects_changed_baseline_before_gpu_probe_or_training(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tools = root / 'source/dev_tools/training'
            tools.mkdir(parents=True)
            run = root / 'run'
            run.mkdir()
            (run / 'run.json').write_text('{"id":"version","status":"queued"}')
            (run / 'prepared.json').write_text(json.dumps({'baseline_pins': None}))
            module = types.SimpleNamespace(analyze=None, discover=None, prepare=None, prepared_analysis=None)
            with patch.object(job, 'TOOLS', tools), patch.dict(sys.modules, {'lab_training_data': module}), \
                    patch.object(job.signal, 'signal'), patch.object(job, 'command') as command, \
                    patch.object(job, 'resume_training') as resume:
                with self.assertRaisesRegex(ValueError, 'Original baseline pins'):
                    job.supervise({'id': 'version', 'mode': 'resume', 'attempt_id': 'a' * 32, 'run_dir': str(run)})
            command.assert_not_called()
            resume.assert_not_called()
            self.assertIn('Original baseline pins', json.loads((run / 'run.json').read_text())['error'])

    def test_local_names_recovery_never_fetches_or_overwrites_remote_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            bundle = run / 'bundle'
            checkpoint = bundle / 'names/checkpoints/latest.pdparams'
            checkpoint.parent.mkdir(parents=True)
            checkpoint.write_bytes(b'newer local weights')
            (run / 'hosts.json').write_text(json.dumps({'root': '/remote'}))
            (run / 'run.json').write_text('{"workers":[]}')
            (run / 'workers.json').write_text(json.dumps([{'role': 'names', 'stage_id': 'names', 'host': 'local', 'state': 'failed'}]))
            (run / 'stage-owners.json').write_text(json.dumps({'names-base': {'host': 'unimatrix-01'}, 'names': {'host': 'local'}}))
            stages = [{'id': 'names-base', 'role': 'names'}, {'id': 'names', 'role': 'names'}]
            prepared = {'bundle': str(bundle)}
            with patch('checkpoint_resume.validate_bundle'), patch.object(job, 'validate_curriculum', return_value={'stages': stages}), \
                    patch.object(job, 'completed_stage', side_effect=lambda bundle, stage: stage['id'] == 'names-base'), \
                    patch.object(job, '_fetch_remote_stages') as fetch, patch.object(job, 'train_curriculum') as train:
                job.resume_curriculum(prepared, run, lambda **fields: None)
            fetch.assert_not_called()
            train.assert_called_once()
            self.assertEqual(checkpoint.read_bytes(), b'newer local weights')

    def test_remote_recovery_fetches_only_pending_stage_and_unknown_owner_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            bundle = run / 'bundle'
            bundle.mkdir()
            (run / 'hosts.json').write_text(json.dumps({'root': '/remote'}))
            (run / 'run.json').write_text('{"workers":[]}')
            owner = run / 'stage-owners.json'
            owner.write_text(json.dumps({'names': {'host': 'unimatrix-01'}}))
            stages = [{'id': 'names-base', 'role': 'names'}, {'id': 'names', 'role': 'names'}]
            with patch('checkpoint_resume.validate_bundle'), patch.object(job, 'validate_curriculum', return_value={'stages': stages}), \
                    patch.object(job, 'completed_stage', side_effect=lambda bundle, stage: stage['id'] == 'names-base'), \
                    patch.object(job, '_fetch_remote_stages') as fetch, patch.object(job, 'train_curriculum'):
                job.resume_curriculum({'bundle': str(bundle)}, run, lambda **fields: None)
                self.assertEqual(fetch.call_args.args[2], [stages[1]])
                owner.unlink()
                with self.assertRaisesRegex(ValueError, 'host is unknown'):
                    job.resume_curriculum({'bundle': str(bundle)}, run, lambda **fields: None)

    def test_unstarted_names_can_continue_without_a_remote_checkpoint_fetch(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            bundle = run / 'bundle'
            bundle.mkdir()
            (run / 'hosts.json').write_text(json.dumps({'root': '/remote'}))
            (run / 'run.json').write_text('{"workers":[]}')
            (run / 'stage-owners.json').write_text('{}')
            stages = [{'id': 'names-base', 'role': 'names', 'directory': str(bundle / 'stages/names-base')}]
            with patch('checkpoint_resume.validate_bundle'), patch.object(job, 'validate_curriculum', return_value={'stages': stages}), \
                    patch.object(job, 'completed_stage', return_value=False), patch.object(job, '_fetch_remote_stages') as fetch, \
                    patch.object(job, 'train_curriculum') as train:
                job.resume_curriculum({'bundle': str(bundle)}, run, lambda **fields: None)
            fetch.assert_not_called()
            train.assert_called_once()


if __name__ == '__main__':
    unittest.main()
