"""Keep training tensors identical to per-crop portable inference tensors."""
from collections import Counter, defaultdict
from copy import deepcopy
from functools import wraps
import math
from pathlib import Path
import random
import struct

from portable_ocr import normalize_crop


def tensor_width(width, height):
    if not 0 < width <= 16384 or not 0 < height <= 4096:
        raise ValueError(f'Training crop {width}x{height} exceeds the aspect-preserving inference bounds: '
                         'source width must be 1..16384 and height 1..4096')
    if 48 * width / height > 3200:
        raise ValueError(f'Training crop {width}x{height} exceeds the aspect-preserving inference bounds: '
                         f'uncapped 48px tensor width {48 * width / height:.6f} exceeds 3200')
    return min(3200, int(48 * max(320 / 48, width / height)))


class CollectorAspectResize:
    def __init__(self, **kwargs):
        pass

    def __call__(self, data):
        image = data['image']
        height, width = image.shape[:2]
        tensor_width(width, height)
        data['image'] = normalize_crop(image)[0]
        data['valid_ratio'] = min(1.0, math.ceil(48 * width / height) / data['image'].shape[-1])
        return data


def png_width(path):
    with Path(path).open('rb') as stream:
        header = stream.read(24)
    if len(header) != 24 or header[:8] != b'\x89PNG\r\n\x1a\n' or header[12:16] != b'IHDR':
        raise ValueError('Aspect-preserving training requires frozen PNG crops')
    try:
        return tensor_width(*struct.unpack('>II', header[16:24]))
    except ValueError as error:
        raise ValueError(f'{path}: {error}') from error


def epoch_steps(label_file, batch_size=32, width_budget=10240):
    widths = {}
    counts = Counter()
    for index, line in enumerate(Path(label_file).read_text().splitlines()):
        filename, _ = line.split('\t', 1)
        path = Path(filename)
        if not path.is_absolute():
            raise ValueError('Frozen aspect training paths must be absolute')
        if path not in widths:
            try:
                widths[path] = png_width(path)
            except ValueError as error:
                raise ValueError(f'{label_file}:{index + 1}: {error}') from error
        counts[widths[path]] += 1
    return sum(math.ceil(count / min(batch_size, max(1, width_budget // width)))
               for width, count in counts.items())


class CollectorAspectBatchSampler:
    def __init__(self, dataset, batch_size=32, seed=0, width_budget=10240):
        if type(batch_size) is not int or not 1 <= batch_size <= 32:
            raise ValueError('Aspect batch size must be between 1 and 32')
        if type(seed) is not int or not 0 <= seed < 2**32:
            raise ValueError('Aspect sampler seed must be an unsigned 32-bit integer')
        if type(width_budget) is not int or width_budget < 3200:
            raise ValueError('Aspect batch width budget must accommodate every supported crop')
        if dataset.need_reset or dataset.do_shuffle:
            raise ValueError('Aspect sampler requires fixed dataset indices')
        self.seed = seed
        self.epoch = 0
        self.groups = defaultdict(list)
        self.batch_sizes = {}
        widths = {}
        for index, source_index in enumerate(dataset.data_idx_order_list):
            line = dataset.data_lines[source_index]
            if isinstance(line, bytes):
                line = line.decode('utf-8')
            filename = line.rstrip('\r\n').split(dataset.delimiter, 1)[0]
            path = Path(dataset.data_dir) / filename
            if path not in widths:
                widths[path] = png_width(path)
            width = widths[path]
            self.groups[width].append(index)
            self.batch_sizes[width] = min(batch_size, max(1, width_budget // width))
        if sum(map(len, self.groups.values())) != len(dataset):
            raise ValueError('Aspect sampler must cover every frozen exposure')

    def __len__(self):
        return sum(math.ceil(len(indices) / self.batch_sizes[width])
                   for width, indices in self.groups.items())

    def __iter__(self):
        rng = random.Random(self.seed + self.epoch)
        self.epoch += 1
        batches = []
        for width, indices in sorted(self.groups.items()):
            indices = list(indices)
            rng.shuffle(indices)
            size = self.batch_sizes[width]
            batches.extend(indices[offset:offset + size] for offset in range(0, len(indices), size))
        rng.shuffle(batches)
        yield from batches


def install_policy(data_module=None, imaug_module=None):
    if data_module is None:
        import ppocr.data as data_module
    if imaug_module is None:
        import ppocr.data.imaug as imaug_module
    imaug_module.CollectorAspectResize = CollectorAspectResize
    data_module.CollectorAspectBatchSampler = CollectorAspectBatchSampler
    original = data_module.build_dataloader
    if getattr(original, '_collector_aspect_policy', False):
        return False

    @wraps(original)
    def build(config, mode, device, logger, seed=None):
        if config['Global'].get('collector_aspect_preserving') is not True:
            return original(config, mode, device, logger, seed)
        selected = config[mode]
        dataset = selected['dataset']
        if (dataset['name'] != 'SimpleDataSet' or dataset.get('ratio_list') != [1.0]
                or len(dataset['label_file_list']) != 1 or selected['loader'].get('drop_last') is not False):
            raise ValueError('Aspect training requires one complete frozen SimpleDataSet list')
        transforms = [next(iter(value)) for value in dataset['transforms']]
        if transforms != ['DecodeImage', 'CollectorCTCLabelEncode', 'CollectorAspectResize', 'KeepKeys']:
            raise ValueError('Aspect training requires its explicit audited transform chain')
        if mode not in ('Train', 'Eval') or 'sampler' in selected:
            raise ValueError('Unsupported aspect-preserving loader mode or sampler')
        configured = deepcopy(config)
        configured[mode]['loader']['shuffle'] = False
        if mode == 'Train':
            configured[mode]['sampler'] = {
                'name': 'CollectorAspectBatchSampler',
                'batch_size': selected['loader']['batch_size_per_card'],
                'seed': config['Global']['seed'],
            }
        else:
            epoch_steps(dataset['label_file_list'][0], batch_size=1)
            configured[mode]['loader']['batch_size_per_card'] = 1
        loader = original(configured, mode, device, logger, seed)
        if mode == 'Train':
            config['Global']['eval_batch_step'] = [0, len(loader)]
        return loader

    build._collector_aspect_policy = True
    data_module.build_dataloader = build
    return True
