import hashlib
import json
from pathlib import Path
import pickle
import tempfile
import types
import sys
import unittest
from unittest.mock import patch

from checkpoint_resume import completed_role, select_checkpoint, validate_bundle
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
            result = select_checkpoint(bundle, 'general', 6)
            self.assertEqual(result['epoch'], 3)
            self.assertEqual(result['global_step'], 8130)
            self.assertTrue(result['prefix'].endswith('latest'))
            self.assertEqual(set(result['sha256']), {'.pdparams', '.pdopt', '.states'})

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


if __name__ == '__main__':
    unittest.main()
