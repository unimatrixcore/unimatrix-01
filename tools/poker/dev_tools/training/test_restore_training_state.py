from pathlib import Path
import pickle
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from restore_training_state import install_resume_state


class RestoreTrainingStateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'latest.states'
        self.state = {'best_model_dict': {'acc': .99488, 'norm_edit_dis': .998,
                                         'best_epoch': 2, 'global_step': 7000},
                      'epoch': 3, 'global_step': 8130}
        self.write_state()

    def write_state(self):
        self.path.write_bytes(pickle.dumps(self.state))

    def test_original_loader_restores_parameters_and_optimizer_then_metadata_is_repaired(self):
        model, optimizer, ema = SimpleNamespace(), SimpleNamespace(), object()

        def original(config, received_model, optimizer=None, model_type=None, ema=None):
            received_model.parameters_loaded = True
            optimizer.state_loaded = True
            return {'acc': 0.0, 'start_epoch': 4, 'is_float16': False}

        loader = SimpleNamespace(load_model=Mock(side_effect=original))
        upstream = loader.load_model
        install_resume_state(self.path, loader)
        config = {'Global': {'checkpoints': str(self.path.with_suffix(''))}}
        restored = loader.load_model(config, model, optimizer=optimizer, model_type='rec', ema=ema)
        upstream.assert_called_once_with(config, model, optimizer=optimizer, model_type='rec', ema=ema)
        self.assertTrue(model.parameters_loaded)
        self.assertTrue(optimizer.state_loaded)
        self.assertEqual(restored['global_step'], 8130)
        self.assertEqual(restored['acc'], .99488)
        self.assertEqual(restored['norm_edit_dis'], .998)
        self.assertEqual(restored['best_epoch'], 2)
        self.assertEqual(restored['start_epoch'], 4)
        self.assertFalse(restored['is_float16'])
        self.assertEqual(self.state['best_model_dict']['global_step'], 7000)

    def test_mismatching_weight_prefix_is_rejected_before_loading(self):
        loader = SimpleNamespace(load_model=Mock(return_value={}))
        original = loader.load_model
        install_resume_state(self.path, loader)
        with self.assertRaisesRegex(ValueError, 'do not match'):
            loader.load_model({'Global': {'checkpoints': str(self.path.parent / 'other')}}, object())
        original.assert_not_called()

    def test_fresh_training_is_left_unchanged(self):
        expected = {'is_float16': False}
        loader = SimpleNamespace(load_model=Mock(return_value=expected))
        original = loader.load_model
        install_resume_state(self.path, loader)
        config, model = {'Global': {'checkpoints': None}}, object()
        self.assertIs(loader.load_model(config, model), expected)
        original.assert_called_once_with(config, model)

    def test_pdparams_suffix_and_repeat_install_do_not_duplicate_model_loading(self):
        loader = SimpleNamespace(load_model=Mock(return_value={'acc': 0.0}))
        original = loader.load_model
        install_resume_state(self.path, loader)
        install_resume_state(self.path, loader)
        restored = loader.load_model({'Global': {'checkpoints': str(self.path.with_suffix('.pdparams'))}}, object())
        self.assertEqual(restored['global_step'], 8130)
        original.assert_called_once()

    def test_missing_or_invalid_counters_fail_before_installation(self):
        for name, value in [('global_step', None), ('global_step', -1), ('epoch', True)]:
            self.state[name] = value
            self.write_state()
            loader = SimpleNamespace(load_model=Mock())
            original = loader.load_model
            with self.assertRaisesRegex(ValueError, name):
                install_resume_state(self.path, loader)
            self.assertIs(loader.load_model, original)
            self.state = {'best_model_dict': {'acc': .99488}, 'epoch': 3, 'global_step': 8130}


if __name__ == '__main__':
    unittest.main()
