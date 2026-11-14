import random
from types import SimpleNamespace
import unittest

from dataset_seed_policy import install_dataset_rng_seed


def loader_module():
    class SimpleDataSet:
        def __init__(self, config, mode, logger, seed=None):
            self.seed = seed
            self.mode = mode.lower()
            self.seen = []
            self.data_lines = self.get_image_info_list()
            self.shuffle_data_random()
            self.initial_epoch = seed if seed is not None else 0

        def get_image_info_list(self):
            self.seen.append(('sample', self.seed))
            random.seed(self.seed)
            return random.sample(list(range(100)), 100)

        def shuffle_data_random(self):
            self.seen.append(('shuffle', self.seed))
            random.seed(self.seed)
            random.shuffle(self.data_lines)

        def _generate_index_map(self, seed):
            self.seen.append(('index_map', seed))
            generator = random.Random(seed)
            return generator.sample(list(range(100)), 100)

    return SimpleNamespace(SimpleDataSet=SimpleDataSet)


class DatasetSeedPolicyTest(unittest.TestCase):
    def test_actual_dataset_methods_receive_configured_seed_and_orders_repeat(self):
        module = loader_module()
        install_dataset_rng_seed(module)
        config = {'Global': {'seed': 202611091}}
        first = module.SimpleDataSet(config, 'Train', None)
        random.seed(123)
        second = module.SimpleDataSet(config, 'Train', None)
        self.assertEqual(first.data_lines, second.data_lines)
        self.assertEqual(first.seen, [('sample', 202611091), ('shuffle', 202611091)])
        self.assertEqual(first.initial_epoch, 0)
        self.assertIsNone(first.seed)
        self.assertFalse(install_dataset_rng_seed(module))

    def test_explicit_epoch_seed_and_eval_behavior_are_preserved(self):
        module = loader_module()
        install_dataset_rng_seed(module)
        config = {'Global': {'seed': 202611091}}
        dataset = module.SimpleDataSet(config, 'Train', None, seed=3)
        self.assertEqual(dataset.seen, [('sample', 3), ('shuffle', 3)])
        self.assertEqual(dataset.initial_epoch, 3)
        evaluation = module.SimpleDataSet(config, 'Eval', None)
        self.assertEqual(evaluation.seen, [('sample', None), ('shuffle', None)])

    def test_initial_ratio_index_sampling_uses_global_seed_but_later_epoch_is_explicit(self):
        module = loader_module()
        install_dataset_rng_seed(module)
        dataset = module.SimpleDataSet({'Global': {'seed': 77}}, 'Train', None)
        first = dataset._generate_index_map(None)
        self.assertEqual(first, dataset._generate_index_map(None))
        self.assertEqual(dataset.seen[-1], ('index_map', 77))
        self.assertNotEqual(first, dataset._generate_index_map(4))
        self.assertEqual(dataset.seen[-1], ('index_map', 4))

    def test_seed_is_restored_when_upstream_method_raises(self):
        module = loader_module()
        def fail(self):
            raise RuntimeError('loader failure')
        module.SimpleDataSet.shuffle_data_random = fail
        install_dataset_rng_seed(module)
        dataset = module.SimpleDataSet.__new__(module.SimpleDataSet)
        dataset.seed, dataset._collector_rng_seed = None, 77
        with self.assertRaisesRegex(RuntimeError, 'loader failure'):
            dataset.shuffle_data_random()
        self.assertIsNone(dataset.seed)


if __name__ == '__main__':
    unittest.main()
