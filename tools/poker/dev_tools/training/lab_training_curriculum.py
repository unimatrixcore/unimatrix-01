"""Freeze the recovered training curriculum without changing source datasets."""
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import random
import re
import sqlite3

import numpy as np
import yaml


RAW_COUNT = 4000
GRAY_COUNT = 2000
FINAL_RAW_COUNT = 500
ASSET_PINS = {
    'raw-repetition-data/manifest.jsonl': '361c77616dad1476f5e5077002d23e7250cb9b33508d393e57a456c7f7959c51',
    'raw-repetition-data/audit.json': 'c84e82d6a30a5b238dc4d48005b47346cfa9dfeec6ecc7cfcc0700fd5f50a113',
    'raw-repetition-data/review.json': '240e8b0e532049fb1bfae64c7ea616eebba5ad736a7f4169a7995ed78a9fff68',
    'desktop-training/compact-ocr-v4/reviewed-augmentation/audit.json': '4acd1532e7ebf7f10660bbb10ac2569b9a6adb43c4f6ffd50403911ccc0e37e5',
    'desktop-training/compact-ocr-v4/reviewed-augmentation/labels.txt': '279632f208d780a168d10f7d401cdb4fa1f75b9fa00da94f34ed8469eafc67df',
    'desktop-training/name-specialist-v13/train.txt': 'be117b8eaa67b0808cf427b75cf2849df1622f5aee2ecb27dcc48390c420f413',
    'stress-database/manifest.jsonl': '74c0eae9d149715ee82babc3ec1ffbd6fcbff4a658544d293717c0b10553945c',
    'novel-name-challenge/manifest.jsonl': '7df2eef294114c955152f16ce0f47c67bff240708c4f68fc011d7363d90404b1',
    'production-data/manifest.jsonl': '695b391043f66eaf04944821f6ea21d6fcafebcaf5e2517adb94e3467bc72b8d',
}
GRAY_IMAGES_SHA256 = 'cf50f130ee742503e6eb7b2f3e77b1c0b2402cda67db072f8c26b2dc284006b0'
VARIANTS = ('original', 'jpeg88_dark', 'jpeg94_light', 'scale90', 'context0', 'context1')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read_rows(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def encoded_image(raw):
    import cv2
    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if image is None or not image.size or image.shape[0] > 4096 or image.shape[1] > 16384:
        raise ValueError('Curriculum crop is missing, undecodable or oversized')
    return image


def pixel_hash(image):
    import cv2
    h, w = image.shape[:2]
    return digest(f'{w}x{h}:RGB:'.encode() + cv2.cvtColor(image, cv2.COLOR_BGR2RGB).tobytes())


def materialize(bundle, raw):
    sha = digest(raw)
    path = bundle / 'images' / (sha + '.png')
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() != raw:
        raise ValueError('Content-addressed curriculum image changed')
    if not path.exists():
        path.write_bytes(raw)
    return 'images/' + path.name, sha, pixel_hash(encoded_image(raw))


def control(row):
    return bool(row.get('inherited_control') or row.get('origin') in
                {'retention', 'blank_retention', 'constructed_blank', 'synthetic', 'synthetic_blank'}
                or row.get('label_evidence') == 'existing_reviewed_training_glyph_render'
                or str(row.get('label_evidence', '')).startswith('synthetic_'))


def baseline_ids(row):
    values = [row.get('baseline_sample_id')]
    values += [alias.get('baseline_sample_id') for alias in row.get('aliases', [])
               if alias.get('label') == row['label'] and alias.get('split') == row['split']]
    result = set()
    for value in values:
        if isinstance(value, (str, int)) and (match := re.fullmatch(r'(?:baseline:)*(\d+)', str(value))):
            result.add(match[1])
    return result


def frozen_controls(root, records, images):
    for relative, expected in ASSET_PINS.items():
        path = root / relative
        if not path.is_file() or digest(path.read_bytes()) != expected:
            raise ValueError(f'Restore the vetted historical curriculum asset: {relative}')
    raw_root = root / 'raw-repetition-data'
    gray_root = root / 'desktop-training/compact-ocr-v4/reviewed-augmentation'
    raw = read_rows(raw_root / 'manifest.jsonl')
    review = json.loads((raw_root / 'review.json').read_text())
    raw_audit = json.loads((raw_root / 'audit.json').read_text())
    gray = json.loads((gray_root / 'audit.json').read_text())['samples']
    labels = dict(line.split('\t', 1) for line in (gray_root / 'labels.txt').read_text().splitlines())
    if (len(raw) != RAW_COUNT or raw_audit.get('samples') != RAW_COUNT or len(gray) != GRAY_COUNT
            or len(labels) != GRAY_COUNT or review.get('reviewed_glyphs') != 12
            or review.get('conflicting_exact_pixel_groups')):
        raise ValueError('Historical glyph-control audit is incomplete')
    gray_hashes = [{'image': row['image'], 'sha256': digest((gray_root / row['image']).read_bytes())}
                   for row in sorted(gray, key=lambda row: row['image'])]
    if digest(json.dumps(gray_hashes, sort_keys=True, separators=(',', ':')).encode()) != GRAY_IMAGES_SHA256:
        raise ValueError('Vetted historical grayscale control images changed')
    source = {str(row['sample_id']): row for row in read_rows(root / 'stress-database/manifest.jsonl')}
    selected = defaultdict(list)
    for row in records:
        if row['split'] == 'train' and row.get('optimize', True) and not control(row):
            for identity in baseline_ids(row):
                selected[identity].append(row)
    used_sources = {str(identity) for row in raw for identity in row.get('glyph_sources', [])}
    used_sources |= {str(glyph['sample_id']) for row in gray for glyph in row.get('glyphs', [])}
    for identity in used_sources:
        parent = source.get(identity)
        if not parent or parent['split'] != 'train' or parent['category'] != 'name' or not parent.get('optimize', True):
            raise ValueError('Historical glyph parent is not an approved training name')
        original = (root / 'stress-database' / parent['image_path']).read_bytes()
        if digest(original) != parent['file_sha256']:
            raise ValueError('Historical glyph parent pixels changed')
        pixels = pixel_hash(encoded_image(original))
        if not any(row['label'] == parent['label'] and pixel_hash(images[row['sample_id']]) == pixels
                   for row in selected[identity]):
            raise ValueError(f'Historical glyph parent {identity} is not among the selected optimized training pixels')
    heldout = {row['label'] for row in records if row['split'] != 'train'}
    heldout |= {row['label'] for row in read_rows(root / 'novel-name-challenge/manifest.jsonl')}
    controls = {'raw': [], 'gray': []}
    for kind, rows, directory in [('raw', raw, raw_root), ('gray', gray, gray_root)]:
        for row in rows:
            sources = row.get('glyph_sources') if kind == 'raw' else [glyph['sample_id'] for glyph in row.get('glyphs', [])]
            if not sources or row['label'] in heldout or (kind == 'raw' and row.get('split') != 'train'):
                raise ValueError('Historical glyph control lacks train-only provenance or overlaps a heldout/challenge target')
            relative = row['image_path'] if kind == 'raw' else row['image']
            path = (directory / relative).resolve()
            if not path.is_relative_to(directory.resolve()):
                raise ValueError('Historical glyph control escapes its vetted asset directory')
            data = path.read_bytes()
            if kind == 'raw' and digest(data) != row['file_sha256']:
                raise ValueError('Historical raw repetition image changed')
            if kind == 'gray' and labels.get(relative) != row['label']:
                raise ValueError('Historical grayscale labels disagree with their audit')
            controls[kind].append({'sample_id': f'curriculum:{kind}:{Path(relative).stem}', 'category': 'name',
                                  'split': 'train', 'label': row['label'], 'optimize': True,
                                  'origin': 'retention', 'label_evidence': 'existing_reviewed_training_glyph_render',
                                  'glyph_sources': list(map(str, sources)), '_raw': data})
    chosen = list(controls['raw'])
    random.Random(202611073).shuffle(chosen)
    chosen = chosen[:FINAL_RAW_COUNT]
    selected_list = root / 'desktop-training/name-specialist-v13/train.txt'
    historical_subset = {Path(path).stem: label for path, label in
                         (line.split('\t', 1) for line in selected_list.read_text().splitlines())
                         if '/raw-repetition-data/' in path}
    if {row['sample_id'].rsplit(':', 1)[1]: row['label'] for row in chosen} != historical_subset:
        raise ValueError('Final repetition subset differs from the retained v13 curriculum')
    controls['raw_final'] = chosen
    return controls, {'asset_sha256': dict(ASSET_PINS), 'gray_images_sha256': GRAY_IMAGES_SHA256,
                      'reviewed_glyphs': 12, 'reviewed_full_render_examples': len(review.get('reviewed_first_render_ids', [])),
                      'historical_glyph_parent_ids': sorted(used_sources), 'raw_count': len(raw),
                      'gray_count': len(gray), 'final_raw_count': len(chosen)}


def original_variants(root):
    index = defaultdict(dict)
    for row in read_rows(root / 'production-data/manifest.jsonl'):
        if row['split'] == 'train':
            index[str(row['parent_sample_id'])][row['augmentation']] = row
    return index


def context_image(root, row, image, margins):
    from build_production_dataset import padded
    if not row['label']:
        return padded(image, margins), {'full_capture': False, 'reason': 'negative_padding_only'}
    dataset = row.get('dataset_id')
    if not isinstance(dataset, str) or not re.fullmatch(r'legacy|[a-f0-9]{32}', dataset):
        return padded(image, margins), {'full_capture': False, 'reason': 'capture_provenance_unavailable'}
    if not isinstance(row.get('source_id'), int) or not all(isinstance(row.get(key), int) for key in ('x', 'y', 'w', 'h')):
        return padded(image, margins), {'full_capture': False, 'reason': 'capture_geometry_unavailable'}
    collection = root.parent / 'collector_datasets' / dataset
    database = collection / 'data.db'
    if not database.is_file():
        return padded(image, margins), {'full_capture': False, 'reason': 'capture_snapshot_unavailable'}
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as connection:
        found = connection.execute('SELECT filename FROM full_captures WHERE id=?', [row['source_id']]).fetchone()
    if not found or not isinstance(found[0], str) or Path(found[0]).name != found[0]:
        return padded(image, margins), {'full_capture': False, 'reason': 'capture_file_unavailable'}
    path = collection / 'full_captures' / found[0]
    if not path.is_file():
        return padded(image, margins), {'full_capture': False, 'reason': 'capture_file_unavailable'}
    raw = path.read_bytes()
    full = encoded_image(raw)
    x, y, w, h = (row[key] for key in ('x', 'y', 'w', 'h'))
    left, right, top, bottom = margins
    if (x < left or y < top or x + w + right > full.shape[1] or y + h + bottom > full.shape[0]
            or not np.array_equal(full[y:y+h, x:x+w], image)):
        return padded(image, margins), {'full_capture': False, 'reason': 'capture_pixels_or_bounds_disagree'}
    result = full[y-top:y+h+bottom, x-left:x+w+right].copy()
    return result, {'full_capture': True, 'source_filename': found[0], 'capture_sha256': digest(raw)}


def augment_real(bundle, root, records, images):
    import cv2
    from build_production_dataset import photometric
    historical = original_variants(root)
    result = []
    for row in records:
        if row['split'] != 'train' or not row.get('optimize', True) or control(row):
            continue
        image = images[row['sample_id']]
        h, w = image.shape[:2]
        compatible = next((historical[identity] for identity in sorted(baseline_ids(row))
                           if 'original' in historical[identity]
                           and np.array_equal(encoded_image((root / 'production-data' / historical[identity]['original']['image_path']).read_bytes()), image)), {})
        for variant in VARIANTS:
            extra = {'curriculum_parent_file_sha256': row['file_sha256'],
                     'curriculum_parent_pixel_sha256': pixel_hash(image), 'augmentation': variant}
            if variant in compatible:
                original = compatible[variant]
                data = (root / 'production-data' / original['image_path']).read_bytes()
                if digest(data) != original['file_sha256']:
                    raise ValueError('Verified historical training variation changed')
                generated = encoded_image(data)
                extra.update(historical_variant=True, original_asset_sha256=original['file_sha256'])
                if variant.startswith('context'):
                    left, right, top, bottom = original['margins_lrtb']
                    if not np.array_equal(generated[top:top+h, left:left+w], image):
                        raise ValueError('Historical context variation does not preserve all original pixels')
                    extra.update(full_capture=original.get('full_capture', False), margins_lrtb=[left, right, top, bottom])
            else:
                extra['historical_variant'] = False
                if variant == 'original':
                    generated = image
                elif variant == 'jpeg88_dark':
                    generated = photometric(image, 88, -8)
                elif variant == 'jpeg94_light':
                    generated = photometric(image, 94, 7)
                elif variant == 'scale90':
                    generated = cv2.resize(image, (max(4, round(w * .9)), max(4, round(h * .9))), interpolation=cv2.INTER_AREA)
                else:
                    margins = (3, 1, 2, 1) if variant == 'context0' else (1, 3, 1, 3)
                    generated, proof = context_image(root, row, image, margins)
                    extra.update(proof, margins_lrtb=list(margins))
                ok, encoded = cv2.imencode('.png', generated)
                if not ok:
                    raise ValueError('Cannot encode training variation')
                data = encoded.tobytes()
            path, sha, pixels = materialize(bundle, data)
            result.append({**row, **extra, 'sample_id': row['sample_id'] + ':curriculum:' + variant,
                           'parent_sample_id': row['sample_id'], 'image_path': path, 'source_image': str(bundle / path),
                           'file_sha256': sha, 'pixel_sha256': pixels})
    return result


def stage_recipe(bundle, directory, stage, records, template, checkpoint, dictionary):
    directory.mkdir(parents=True, exist_ok=True)
    config = deepcopy(yaml.safe_load(Path(template).read_text()))
    characters = set(Path(dictionary).read_text().splitlines()) | {' '}
    for row in records:
        if not isinstance(row['label'], str) or any(char in row['label'] for char in '\t\r\n') or not set(row['label']) <= characters:
            raise ValueError('Curriculum label cannot be encoded by the frozen dictionary')
    split_rows = {split: [row for row in records if row['split'] == split and (split == 'test' or row.get('optimize', True))]
                  for split in ('train', 'val', 'test')}
    if not split_rows['train'] or not split_rows['val']:
        raise ValueError('Curriculum stage requires nonempty training and validation inputs')
    random.Random(stage['seed']).shuffle(split_rows['train'])
    for split, rows in split_rows.items():
        (directory / (split + '.txt')).write_text(''.join(str(bundle / row['image_path']) + '\t' + row['label'] + '\n' for row in rows))
    config['Global'].update(epoch_num=stage['epochs'], pretrained_model=str(checkpoint), checkpoints=None,
        seed=stage['seed'], use_gpu=True, distributed=False,
        save_model_dir=str(directory / 'checkpoints'), save_inference_dir=str(directory / 'export'),
        character_dict_path=str(dictionary), eval_batch_step=[0, max(1, math.ceil(len(split_rows['train']) / 32))])
    config['Optimizer']['lr']['learning_rate'] = stage['learning_rate']
    config['Loss'] = {'name': 'CollectorBlankCTCLoss'}
    config['Metric'].update(ignore_space=False, is_filter=False)
    for split, key in [('train', 'Train'), ('val', 'Eval')]:
        transforms = config[key]['dataset']['transforms']
        if any(next(iter(transform)) not in {'DecodeImage', 'CollectorCTCLabelEncode', 'RecResizeImg', 'KeepKeys'} for transform in transforms):
            raise ValueError('Curriculum template includes an unreviewed transform')
        config[key]['dataset'].update(data_dir=str(bundle), label_file_list=[str(directory / (split + '.txt'))], ratio_list=[1.0])
        config[key]['loader'].update(shuffle=split == 'train', batch_size_per_card=32, drop_last=False)
    config_path = directory / 'train.yml'
    config_path.write_text(yaml.safe_dump(config, sort_keys=False))
    (directory / 'manifest.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in records))
    return {**stage, 'directory': str(directory), 'config': str(config_path), 'checkpoint_source': str(checkpoint),
            'batch_size': 32, 'train_count': len(split_rows['train']), 'validation_count': len(split_rows['val'])}


def build_curriculum(bundle, records, resources, epochs):
    bundle = Path(bundle).resolve()
    root = Path(resources['training_root']).resolve()
    if not isinstance(epochs, int) or not 1 <= epochs <= 100:
        raise ValueError('Final curriculum epochs must be between 1 and 100')
    images = {}
    for row in records:
        path = (bundle / row['image_path']).resolve()
        if not path.is_relative_to(bundle) or digest(path.read_bytes()) != row['file_sha256']:
            raise ValueError('Frozen source image changed or escaped its bundle')
        image = encoded_image(path.read_bytes())
        if row.get('pixel_sha256') and pixel_hash(image) != row['pixel_sha256']:
            raise ValueError('Frozen source pixels changed')
        images[row['sample_id']] = image
    controls, asset_audit = frozen_controls(root, records, images)
    for family in ('raw', 'gray'):
        for row in controls[family]:
            raw = row.pop('_raw')
            path, sha, pixels = materialize(bundle, raw)
            row.update(image_path=path, source_image=str(bundle / path), file_sha256=sha, pixel_sha256=pixels)
    real = augment_real(bundle, root, records, images)
    real_holdouts = [row for row in records if row['split'] != 'train' and not control(row)]
    name_holdouts = [row for row in real_holdouts if row['category'] == 'name']
    blanks = [row for row in records if row['category'] == 'name' and row['label'] == ''
              and row.get('inherited_control') and row.get('optimize', True)]
    names_requested = 'names' in resources.get('roles', ['general', 'names'])
    if names_requested and Counter(row['split'] for row in blanks) != Counter(train=600, val=128):
        raise ValueError('Names curriculum requires the preserved 600 training and 128 validation blank controls')
    initial = bundle / 'starting/general.pdparams'
    if not initial.is_file():
        raise ValueError('The original mapped pretrained checkpoint is missing from the bundle')
    base = bundle / 'stages/base'
    names_base = bundle / 'stages/names-base'
    recipes = [
        ({'id': 'base', 'role': 'general', 'seed': 20261107, 'epochs': 8, 'learning_rate': 2e-5, 'depends_on': None},
         base, real + controls['gray'] + real_holdouts, initial),
        ({'id': 'general', 'role': 'general', 'seed': 20261107, 'epochs': 4, 'learning_rate': 2e-5, 'depends_on': 'base'},
         bundle / 'general', real + controls['gray'] + controls['raw'] + real_holdouts, base / 'checkpoints/best_accuracy.pdparams'),
        ({'id': 'names-base', 'role': 'names', 'seed': 202611072, 'epochs': 4, 'learning_rate': 2e-5, 'depends_on': 'base'},
         names_base, [row for row in real if row['category'] == 'name'] + controls['raw'] + controls['gray'] + blanks + name_holdouts,
         base / 'checkpoints/best_accuracy.pdparams'),
        ({'id': 'names', 'role': 'names', 'seed': 202611073, 'epochs': epochs, 'learning_rate': 1e-5, 'depends_on': 'names-base'},
         bundle / 'names', [row for row in real if row['category'] == 'name'] + controls['raw_final'] + blanks + name_holdouts,
         names_base / 'checkpoints/best_accuracy.pdparams'),
    ]
    if not names_requested:
        recipes = recipes[:2]
    stages = [stage_recipe(bundle, directory, stage, rows, resources[stage['role'] + '_template'], checkpoint,
                           bundle / 'dictionary.txt') for stage, directory, rows, checkpoint in recipes]
    audit = {'schema_version': 1, 'real_training_parents': len(real) // 6, 'real_training_variants': len(real),
             'real_variant_counts': dict(Counter(row['augmentation'] for row in real)),
             'historical_variant_count': sum(row['historical_variant'] for row in real),
             'context_full_capture_count': sum(row.get('full_capture', False) for row in real),
             'asset_provenance': asset_audit, 'holdouts_augmented': False,
             'train_multiplicity_preserved': True, 'semantic_exclusions_preserved': True,
             'general_validation_policy': 'Unaugmented optimized real observations; synthetic name blank controls only in names stages.',
             'stages': [{key: stage[key] for key in ('id', 'role', 'epochs', 'learning_rate', 'train_count', 'validation_count')} for stage in stages]}
    roles = {role: {'starting_checkpoint': str(initial), 'starting_checkpoint_sha256': digest(initial.read_bytes()),
                    'batch_size': 32, 'global_shuffle': True, 'name_high_resolution': role == 'names',
                    'counts': dict(Counter(row['split'] for row in rows)),
                    'optimized_counts': dict(Counter(row['split'] for row in rows if row.get('optimize', True))),
                    'final_stage': stage['id']}
             for stage, _, rows, _ in recipes for role in [stage['role']] if stage['id'] in ('general', 'names')}
    payload = {'schema_version': 1, 'stages': stages, 'audit': audit}
    (bundle / 'curriculum.json').write_text(json.dumps(payload, indent=2) + '\n')
    return {'stages': stages, 'audit': audit, 'roles': roles}
