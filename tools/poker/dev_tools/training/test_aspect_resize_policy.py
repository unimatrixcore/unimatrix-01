from collections import Counter
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

import cv2
import numpy as np

from aspect_resize_policy import (CollectorAspectBatchSampler, CollectorAspectResize,
                                 epoch_steps, install_policy, tensor_width)
from portable_ocr import normalize_crop


class AspectResizeTests(unittest.TestCase):
    def test_training_pixels_equal_runtime_for_wide_narrow_and_blank_crops(self):
        rng = np.random.default_rng(31)
        for height, width in ((31, 410), (37, 176), (31, 1126)):
            for image in (rng.integers(0, 256, (height, width, 3), dtype=np.uint8),
                          np.zeros((height, width, 3), dtype=np.uint8)):
                result = CollectorAspectResize()({'image': image, 'label': 'unchanged'})
                np.testing.assert_array_equal(result['image'], normalize_crop(image)[0])
                self.assertEqual(result['label'], 'unchanged')
                self.assertEqual(result['image'].shape, (3, 48, tensor_width(width, height)))
        self.assertEqual(tensor_width(410, 31), 634)

    def test_extremely_wide_crops_fail_instead_of_squeezing(self):
        with self.assertRaisesRegex(ValueError, 'aspect-preserving inference bounds'):
            CollectorAspectResize()({'image': np.zeros((1, 100, 3), np.uint8)})


class AspectSamplerTests(unittest.TestCase):
    def fixture(self, root):
        paths = []
        for index, (width, height) in enumerate(((100, 31), (410, 31), (410, 31), (1126, 31))):
            path = root / f'{index}.png'
            cv2.imwrite(str(path), np.zeros((height, width, 3), np.uint8))
            paths.append(path)
        exposures = paths[:1] * 50 + paths[1:2] * 50 + paths[2:3] * 5 + paths[3:4] * 19
        lines = [(str(path) + '\t' + ('Pot: G 18 BB' if index % 2 else '') + '\n').encode()
                 for index, path in enumerate(exposures)]
        class Dataset:
            def __len__(self):
                return len(lines)
        dataset = Dataset()
        dataset.need_reset = False
        dataset.do_shuffle = False
        dataset.data_lines = lines
        dataset.data_idx_order_list = list(range(len(lines)))
        dataset.delimiter = '\t'
        dataset.data_dir = str(root)
        return dataset, exposures

    def test_complete_deterministic_width_groups_preserve_weighted_exposures(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            dataset, exposures = self.fixture(root)
            first = CollectorAspectBatchSampler(dataset, seed=76)
            second = CollectorAspectBatchSampler(dataset, seed=76)
            batches = list(first)
            self.assertEqual(batches, list(second))
            self.assertEqual(Counter(index for batch in batches for index in batch),
                             Counter(range(len(exposures))))
            self.assertEqual(len(batches), len(first))
            for batch in batches:
                widths = {tensor_width(*cv2.imread(str(exposures[index])).shape[1::-1]) for index in batch}
                self.assertEqual(len(widths), 1)
                self.assertLessEqual(len(batch), 32)
                self.assertLessEqual(len(batch) * next(iter(widths)), 10240)
            self.assertNotEqual(batches, list(first))
            labels = root / 'train.txt'
            labels.write_bytes(b''.join(dataset.data_lines))
            self.assertEqual(epoch_steps(labels), len(first))

    def test_mutable_dataset_indices_and_invalid_png_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            dataset, _ = self.fixture(Path(temporary))
            dataset.do_shuffle = True
            with self.assertRaisesRegex(ValueError, 'fixed dataset indices'):
                CollectorAspectBatchSampler(dataset)
            dataset.do_shuffle = False
            Path(dataset.data_lines[0].decode().split('\t')[0]).write_bytes(b'bad image')
            with self.assertRaisesRegex(ValueError, 'frozen PNG'):
                CollectorAspectBatchSampler(dataset)


class PolicyTests(unittest.TestCase):
    def test_legacy_delegates_unchanged_and_opt_in_loader_is_explicit(self):
        seen = []
        sentinel = object()
        class Loader:
            def __len__(self): return 17
        def original(config, mode, device, logger, seed=None):
            seen.append((config, mode, seed))
            return sentinel if not config['Global'].get('collector_aspect_preserving') else Loader()
        data = SimpleNamespace(build_dataloader=original)
        imaug = SimpleNamespace()
        self.assertTrue(install_policy(data, imaug))
        self.assertFalse(install_policy(data, imaug))
        legacy = {'Global': {}}
        self.assertIs(data.build_dataloader(legacy, 'Train', None, None), sentinel)
        self.assertIs(seen[-1][0], legacy)
        config = {'Global': {'collector_aspect_preserving': True, 'seed': 4},
                  'Train': {'dataset': {'name': 'SimpleDataSet', 'ratio_list': [1.0],
                            'label_file_list': ['train.txt'], 'transforms': [
                                {'DecodeImage': {}}, {'CollectorCTCLabelEncode': None},
                                {'CollectorAspectResize': None}, {'KeepKeys': {}}]},
                            'loader': {'shuffle': True, 'drop_last': False, 'batch_size_per_card': 32}}}
        data.build_dataloader(config, 'Train', None, None)
        self.assertTrue(config['Train']['loader']['shuffle'])
        self.assertFalse(seen[-1][0]['Train']['loader']['shuffle'])
        self.assertEqual(seen[-1][0]['Train']['sampler']['name'], 'CollectorAspectBatchSampler')
        self.assertEqual(config['Global']['eval_batch_step'], [0, 17])
        config['Train']['dataset']['transforms'][2] = {'RecResizeImg': {'image_shape': [3, 48, 320]}}
        with self.assertRaisesRegex(ValueError, 'explicit audited transform'):
            data.build_dataloader(config, 'Train', None, None)


if __name__ == '__main__':
    unittest.main()
