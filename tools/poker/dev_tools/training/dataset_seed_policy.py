"""Keep dataset RNG seeding separate from PaddleOCR's augmentation epoch."""
from functools import wraps
import importlib


def install_dataset_rng_seed(module=None):
    if module is None:
        module = importlib.import_module('ppocr.data.simple_dataset')
    dataset = module.SimpleDataSet
    original_init = dataset.__init__
    if getattr(original_init, '_collector_dataset_seed', False):
        return False

    @wraps(original_init)
    def initialize(self, config, mode, logger, seed=None):
        configured = config['Global'].get('seed', 1024)
        if isinstance(configured, bool) or not isinstance(configured, int) or not 0 <= configured < 2**32:
            raise ValueError('Global.seed must be an unsigned 32-bit integer')
        self._collector_rng_seed = configured if mode.lower() == 'train' else None
        return original_init(self, config, mode, logger, seed=seed)

    def seeded_method(original):
        @wraps(original)
        def call(self, *args, **kwargs):
            configured = getattr(self, '_collector_rng_seed', None)
            if self.seed is not None or configured is None:
                return original(self, *args, **kwargs)
            self.seed = configured
            try:
                return original(self, *args, **kwargs)
            finally:
                self.seed = None
        return call

    for name in ('get_image_info_list', 'shuffle_data_random'):
        setattr(dataset, name, seeded_method(getattr(dataset, name)))
    original_index_map = dataset._generate_index_map

    @wraps(original_index_map)
    def index_map(self, seed):
        configured = getattr(self, '_collector_rng_seed', None)
        return original_index_map(self, configured if seed is None and configured is not None else seed)

    initialize._collector_dataset_seed = True
    dataset.__init__ = initialize
    dataset._generate_index_map = index_map
    return True
