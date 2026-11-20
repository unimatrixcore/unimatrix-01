#!/usr/bin/env python3
"""Map and verify untouched official CTC tensors for an ordered vocabulary."""
import argparse
import hashlib
import json
from pathlib import Path

from copy import deepcopy
import os
import shutil
import sys

from ocr_dictionary import (DEFAULT_PROFILE, LEGACY_PROFILE, PROFILES, characters_for_profile,
                            clean_start_directory, dictionary_text, profile_metadata, read_dictionary)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def proof_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def mapped_key(name):
    if name.startswith('backbone.'):
        return name
    if name.startswith('head.ctc_encoder.'):
        return 'neck.' + name[len('head.ctc_encoder.'):]
    if name.startswith('head.ctc_head.'):
        return 'head.' + name[len('head.ctc_head.'):]
    return None


def source_indices(official_characters, characters):
    if any(official_characters.count(char) != 1 for char in characters):
        raise ValueError('Official dictionary does not uniquely contain the target vocabulary')
    return [official_characters.index(char) for char in characters]


def map_tensors(state, indices, select):
    mapped = {}
    for name,tensor in state.items():
        key = mapped_key(name)
        if key is None:
            continue
        if key in mapped:
            raise ValueError('Official tensor names collide after mapping')
        if key=='head.fc.weight':tensor=select(tensor,indices,axis=1)
        elif key=='head.fc.bias':tensor=select(tensor,indices,axis=0)
        mapped[key]=tensor
    if 'head.fc.weight' not in mapped or 'head.fc.bias' not in mapped:
        raise ValueError('Official checkpoint lacks its CTC classifier')
    return mapped


def build(root, profile=DEFAULT_PROFILE, output=None, dictionary=None, templates=None):
    import numpy as np
    import paddle
    import yaml

    root = Path(root).resolve()
    output = Path(output).resolve() if output else clean_start_directory(root, profile)
    if output.exists():
        raise ValueError('Clean initialization output must be a new directory')
    characters = characters_for_profile(profile)
    if dictionary and read_dictionary(dictionary, profile) != characters:
        raise ValueError('Training dictionary differs from selected profile')
    templates = templates or {role: root / 'named-continuation/final' / role / 'train.yml'
                              for role in ('general', 'names')}
    source = root / 'benchmark-models/PP-OCRv6_small_rec'
    official_path = source / 'pretrained.pdparams'
    source_dictionary = source / 'inference.yml'
    download_path = source / 'PRETRAINED-SOURCE.json'
    model_source_path = source / 'MODEL-SOURCE.json'
    download = json.loads(download_path.read_text())
    model_source = json.loads(model_source_path.read_text())
    source_hash = digest(official_path)
    if (download.get('sha256') != source_hash or download.get('bytes') != official_path.stat().st_size
            or download.get('url') != 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_pretrained_model/PP-OCRv6_small_rec_pretrained.pdparams'
            or model_source.get('repository') != 'PaddlePaddle/PP-OCRv6_small_rec'
            or (model_source.get('sha256') or {}).get('inference.yml') != digest(source_dictionary)):
        raise ValueError('Untouched official model source differs from its provenance')
    official_characters = ['blank', *yaml.safe_load(source_dictionary.read_text())['PostProcess']['character_dict'], ' ']
    indices = source_indices(official_characters, characters)
    paddle.set_device('cpu')
    official = paddle.load(str(official_path))
    mapped = map_tensors(official, paddle.to_tensor(indices), paddle.index_select)
    if len(mapped) != 338:
        raise ValueError('Official CTC mapping does not have the expected tensor set')
    policies = {}
    initial_checks = []
    sys.path.insert(0, str(root / 'desktop-training/paddle-training-source'))
    from compact_ocr_policy import install_policy
    install_policy(1)
    for role in ('general', 'names'):
        config = yaml.safe_load(Path(templates[role]).read_text())
        if bool(config['Global'].get('collector_name_high_resolution')) != (role == 'names'):
            raise ValueError('Role recipe geometry differs from its declared role')
        architecture = deepcopy(config['Architecture'])
        architecture['Head']['out_channels'] = len(characters)
        policies[role] = {'architecture_sha256': proof_digest(architecture), 'width_pool': 1,
                          'temporal_stride': 2 if role == 'names' else 4}
        if role == 'names':
            from name_resolution_policy import install_name_resolution
            install_name_resolution()
        from ppocr.modeling.architectures import build_model
        model = build_model(architecture)
        expected = model.state_dict()
        if set(mapped) != set(expected) or any(list(tensor.shape) != list(expected[key].shape)
                                              for key, tensor in mapped.items()):
            raise ValueError('Mapped checkpoint does not match strict role architecture shapes')
        missing, unexpected = model.set_state_dict(mapped)
        if missing or unexpected:
            raise ValueError('Mapped checkpoint did not load completely')
        model.eval()
        for width in (320, 384, 640):
            inputs = np.random.default_rng(width).uniform(-1, 1, (1, 3, 48, width)).astype('float32')
            with paddle.no_grad():
                probabilities = model(paddle.to_tensor(inputs)).numpy()
            if probabilities.shape != (1, width // policies[role]['temporal_stride'], len(characters)):
                raise ValueError('Mapped role output geometry is invalid')
            error = float(np.max(np.abs(probabilities.sum(-1) - 1)))
            if not np.isfinite(probabilities).all() or error > .001:
                raise ValueError('Mapped role output is not finite CTC probabilities')
            initial_checks.append({'role': role, 'width': width, 'output_shape': list(probabilities.shape),
                                   'maximum_probability_sum_error': error})
        del model, expected
    legacy = None
    if profile != LEGACY_PROFILE:
        legacy_path = clean_start_directory(root, LEGACY_PROFILE) / 'initial.pdparams'
        legacy_record = json.loads((legacy_path.parent / 'provenance.json').read_text())
        if legacy_record['classes'] != characters_for_profile(LEGACY_PROFILE) or legacy_record['mapped_sha256'] != digest(legacy_path):
            raise ValueError('Legacy clean initialization identity is invalid')
        previous = paddle.load(str(legacy_path))
        target_indices = [characters.index(char) for char in legacy_record['classes']]
        restored = {key: (paddle.index_select(value, paddle.to_tensor(target_indices), axis=1 if key.endswith('weight') else 0)
                          if key in ('head.fc.weight', 'head.fc.bias') else value)
                    for key, value in mapped.items()}
        equal = sum(np.array_equal(previous[key].numpy(), value.numpy()) for key, value in restored.items())
        if set(previous) != set(restored) or equal != 338:
            raise ValueError('New mapping does not preserve every legacy tensor and classifier column')
        features = np.random.default_rng(73).uniform(-1, 1, (2, 5, 120)).astype('float32')
        before = features @ previous['head.fc.weight'].numpy() + previous['head.fc.bias'].numpy()
        after = features @ mapped['head.fc.weight'].numpy() + mapped['head.fc.bias'].numpy()
        error = float(np.max(np.abs(before - after[..., target_indices])))
        if error > .00001:
            raise ValueError('Legacy class logits changed beyond the mapping tolerance')
        legacy = {'mapped_sha256': digest(legacy_path), 'preserved_classes': len(target_indices),
                  'bitwise_equal_tensors': equal, 'maximum_old_class_logit_error': error}
        del previous, restored
    temporary = output.with_name(output.name + f'.building-{os.getpid()}')
    temporary.mkdir(parents=True)
    try:
        (temporary / 'dictionary.txt').write_text(dictionary_text(profile))
        paddle.save(mapped, str(temporary / 'initial.pdparams'))
        saved = paddle.load(str(temporary / 'initial.pdparams'))
        expected_mapping = map_tensors(official, paddle.to_tensor(indices), paddle.index_select)
        equal = sum(np.array_equal(saved[key].numpy(), value.numpy()) for key, value in expected_mapping.items())
        if set(saved) != set(expected_mapping) or equal != 338:
            raise ValueError('Saved initialization differs from its official tensor mapping')
        artifacts = {'official_source_sha256': source_hash, 'mapped_sha256': digest(temporary / 'initial.pdparams'),
                     'source_dictionary_sha256': digest(source_dictionary),
                     'training_dictionary_sha256': digest(temporary / 'dictionary.txt'),
                     'download_record_sha256': digest(download_path), 'source_model_record_sha256': digest(model_source_path)}
        proof = {'method': 'original_pretrained_tensor_mapping_v1', 'artifacts': artifacts, 'policies': policies,
                 'classes_sha256': proof_digest(characters), 'class_indices_sha256': proof_digest(indices),
                 'mapped_tensors': 338, 'bitwise_equal_tensors': equal, 'mismatches': 0,
                 'collector_tuned_tensors_used': 0, 'strict_architecture_shapes': True,
                 'initial_model_checks': initial_checks, 'legacy_compatibility': legacy,
                 'verifier_sha256': digest(__file__)}
        report = {'official_source_sha256': source_hash, 'mapped_sha256': artifacts['mapped_sha256'],
                  'collector_tuned_weights_used': False, 'classes': characters, 'class_indices': indices,
                  'mapped_tensors': 338, 'dictionary_profile': profile_metadata(profile),
                  'verification': proof, 'verification_sha256': proof_digest(proof)}
        (temporary / 'provenance.json').write_text(json.dumps(report, indent=2) + '\n')
        temporary.rename(output)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--profile', choices=PROFILES, default=DEFAULT_PROFILE)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--dictionary', type=Path)
    parser.add_argument('--template-general', type=Path)
    parser.add_argument('--template-names', type=Path)
    args = parser.parse_args()
    templates = None
    if args.template_general or args.template_names:
        if not args.template_general or not args.template_names:
            parser.error('Both role templates are required together')
        templates = {'general': args.template_general, 'names': args.template_names}
    report = build(args.root, args.profile, args.output, args.dictionary, templates)
    print(json.dumps(report), flush=True)


if __name__=='__main__':main()
