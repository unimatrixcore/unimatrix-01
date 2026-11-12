#!/usr/bin/env python3
"""Benchmark frozen general/name OCR models on namespaced collection manifests.

Real observations and synthetic retention/blank controls are reported separately.
These are development labels, including API-teacher labels, not prospective proof.
"""
import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import time

import cv2
import numpy as np

from ocr_output import canonicalize_output
from portable_ocr import PortableModel, decode_ctc
from schemas import CONTRACT, CONTRACT_SHA256, validate_text


CONDITIONS = ('identity', 'brightness_minus30', 'jpeg80', 'scale60')
CONTROL_ORIGINS = {'retention', 'blank_retention', 'constructed_blank', 'synthetic_blank', 'synthetic'}
CONTROL_EVIDENCE = {'existing_reviewed_training_glyph_render', 'synthetic_constructed_blank'}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def sample_seed(identity):
    """Stable for arbitrary identities; never interpret a collection ID as an int."""
    return int.from_bytes(hashlib.sha256(identity.encode()).digest()[:4], 'big')


def transform(image, condition):
    if condition == 'identity':
        return image
    if condition == 'brightness_minus30':
        return np.clip(image.astype(np.int16) - 30, 0, 255).astype(np.uint8)
    if condition == 'jpeg80':
        ok, encoded = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            raise ValueError('JPEG encoding failed')
        result = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if result is None:
            raise ValueError('JPEG decoding failed')
        return result
    if condition == 'scale60':
        height, width = image.shape[:2]
        return cv2.resize(image, (max(4, round(width * .6)), max(4, round(height * .6))), interpolation=cv2.INTER_AREA)
    raise ValueError('Unsupported condition')


def is_control(row):
    return (row.get('origin') in CONTROL_ORIGINS or row.get('label_evidence') in CONTROL_EVIDENCE
            or row.get('label_evidence', '').startswith('synthetic_'))


def metrics(rows):
    count = len(rows)
    failures = sum(bool(row.get('error')) for row in rows)
    raw_exact = sum(not row.get('error') and row['raw_prediction'] == row['label'] for row in rows)
    exact = sum(not row.get('error') and row['prediction'] == row['label'] for row in rows)
    positives = [row for row in rows if row['label']]
    negatives = [row for row in rows if not row['label']]
    success = [row for row in rows if not row.get('error')]
    return {
        'samples': count, 'processing_errors': failures,
        'raw_exact': raw_exact, 'raw_accuracy': raw_exact / count if count else None,
        'canonical_exact': exact, 'canonical_accuracy': exact / count if count else None,
        'positive_samples': len(positives),
        'positive_raw_exact': sum(not r.get('error') and r['raw_prediction'] == r['label'] for r in positives),
        'positive_canonical_exact': sum(not r.get('error') and r['prediction'] == r['label'] for r in positives),
        'negative_samples': len(negatives),
        'negative_processing_errors': sum(bool(r.get('error')) for r in negatives),
        'negative_raw_false_outputs': sum(bool(r.get('raw_prediction')) for r in negatives if not r.get('error')),
        'negative_canonical_false_outputs': sum(bool(r.get('prediction')) for r in negatives if not r.get('error')),
        'negative_schema_valid_false_outputs': sum(bool(r.get('prediction')) and r.get('schema_valid', False) for r in negatives if not r.get('error')),
        'schema_valid_wrong_outputs': sum(r['prediction'] != r['label'] and r.get('schema_valid', False) for r in success),
        'optimization_excluded_samples': sum(not row.get('optimize', True) for row in rows),
        'errors_count_as_mismatches': True,
    }


def grouped(rows, field):
    groups = defaultdict(list)
    for row in rows:
        groups[str(row.get(field, 'unknown'))].append(row)
    return {key: metrics(value) for key, value in sorted(groups.items())}


def summarize(rows):
    real = [row for row in rows if row['scope'] == 'real_observation']
    controls = [row for row in rows if row['scope'] == 'synthetic_control']
    return {
        'all': metrics(rows), 'real_observations': metrics(real), 'synthetic_controls': metrics(controls),
        'real_optimized': metrics([row for row in real if row.get('optimize', True)]),
        'real_optimization_excluded': metrics([row for row in real if not row.get('optimize', True)]),
        'by_split': grouped(rows, 'split'), 'real_by_split': grouped(real, 'split'),
        'by_category': grouped(rows, 'category'), 'real_by_category': grouped(real, 'category'),
        'by_origin': grouped(rows, 'origin'), 'by_label_evidence': grouped(rows, 'label_evidence'),
        'by_evidence_source': grouped(rows, 'evidence_source'),
    }


def evidence_source(row):
    if is_control(row):
        return 'synthetic_control'
    evidence = row.get('label_evidence', '')
    if evidence == 'assistant_visual_review':
        return 'assistant_visual_review'
    if evidence == 'durable_ai_review_event':
        return 'openai_teacher_review'
    if (row.get('ai_review') or {}).get('successful_current_check'):
        return 'collector_label_with_openai_check'
    if evidence == 'durable_human_review_event':
        return 'collector_review_event'
    return evidence or 'unspecified'


def model_record(path, model):
    path = Path(path).resolve()
    files = {name: digest((path / name).read_bytes()) for name in ('model.onnx', 'characters.json')}
    session = model.session
    proof = getattr(model, 'cuda_placement_proof', None)
    return {'directory': str(path), 'sha256': files, 'execution_providers': session.get_providers(),
            'provider_options': session.get_provider_options(), 'cuda_placement_proof': proof}


def load_crop(bundle, row):
    path = (bundle / row['image_path']).resolve()
    if not path.is_relative_to(bundle):
        raise ValueError('Image escapes its input bundle')
    raw = path.read_bytes()
    if digest(raw) != row['file_sha256']:
        raise ValueError('Source file SHA256 mismatch')
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None or not image.size:
        raise ValueError('Missing or undecodable crop')
    height, width = image.shape[:2]
    if height > 4096 or width > 16384:
        raise ValueError('Crop exceeds supported bounds')
    if row.get('pixel_sha256'):
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        pixels = digest(f'{width}x{height}:RGB:'.encode() + rgb.tobytes())
        if pixels != row['pixel_sha256']:
            raise ValueError('Decoded pixel SHA256 mismatch')
    return image


def validate_row(row):
    required = ('sample_id', 'image_path', 'file_sha256', 'label', 'category', 'region_id', 'split')
    if any(not isinstance(row.get(key), str) for key in required):
        raise ValueError('Manifest row has missing or non-string required fields')
    if row['split'] not in ('train', 'val', 'test'):
        raise ValueError('Unsupported sample split')
    if row['category'] not in CONTRACT['categories'] or not validate_text(row['category'], row['label'], allow_blank=True):
        raise ValueError('Ground truth violates the current validation contract')
    expected = {'version': CONTRACT['version'], 'sha256': CONTRACT_SHA256}
    if row.get('validation_contract') != expected and not (is_control(row) and row.get('validation_contract') is None):
        raise ValueError('Manifest validation contract differs from the current implementation')


def compare_benchmarks(output, baseline):
    """Pair exact identities/labels from the same frozen manifest, not totals."""
    output, baseline = Path(output), Path(baseline)
    protocol = json.loads((output / 'protocol.json').read_text())
    prior = json.loads((baseline / 'protocol.json').read_text())
    if protocol['manifest_sha256'] != prior['manifest_sha256'] or protocol['conditions'] != prior['conditions']:
        raise ValueError('Paired benchmarks require the same frozen manifest and conditions')
    report = {'manifest_sha256': protocol['manifest_sha256'], 'baseline_models': prior['models'],
              'candidate_models': protocol['models'], 'conditions': {}}
    for condition in protocol['conditions']:
        before = [json.loads(line) for line in (baseline / condition / 'predictions.jsonl').read_text().splitlines()]
        after = [json.loads(line) for line in (output / condition / 'predictions.jsonl').read_text().splitlines()]
        old = {row['sample_id']: row for row in before}
        if len(old) != len(before) or {row['sample_id'] for row in after} != set(old) or len(after) != len(old):
            raise ValueError('Paired benchmark sample identities differ')
        pairs = []
        for row in after:
            previous = old[row['sample_id']]
            if any(previous.get(field) != row.get(field) for field in ('label', 'category', 'split', 'scope', 'file_sha256')):
                raise ValueError('Paired benchmark labels, provenance or pixels differ')
            pairs.append((previous, row))

        def paired_metrics(values):
            result = {'samples': len(values)}
            for kind, field in (('raw', 'raw_exact'), ('canonical', 'exact')):
                result[kind + '_improvements'] = sum(not old_row[field] and new_row[field] for old_row, new_row in values)
                result[kind + '_regressions'] = sum(old_row[field] and not new_row[field] for old_row, new_row in values)
                result[kind + '_both_correct'] = sum(old_row[field] and new_row[field] for old_row, new_row in values)
                result[kind + '_both_wrong'] = sum(not old_row[field] and not new_row[field] for old_row, new_row in values)
            return result

        real = [pair for pair in pairs if pair[1]['scope'] == 'real_observation']
        controls = [pair for pair in pairs if pair[1]['scope'] == 'synthetic_control']
        report['conditions'][condition] = {'all': paired_metrics(pairs), 'real_observations': paired_metrics(real),
            'synthetic_controls': paired_metrics(controls),
            'real_by_split': {split: paired_metrics([pair for pair in real if pair[1]['split'] == split]) for split in ('train', 'val', 'test')},
            'real_by_category': {category: paired_metrics([pair for pair in real if pair[1]['category'] == category]) for category in sorted({pair[1]['category'] for pair in real})}}
    (output / 'paired.json').write_text(json.dumps(report, indent=2))
    return report


def run_benchmark(bundle, manifest, general_model_dir, name_model_dir, output, *, device='gpu:0',
                  conditions=('identity',), model_factory=None):
    bundle, manifest, output = Path(bundle).resolve(), Path(manifest).resolve(), Path(output).resolve()
    if not conditions or len(set(conditions)) != len(conditions) or any(c not in CONDITIONS for c in conditions):
        raise ValueError('Expected unique supported benchmark conditions')
    source = manifest.read_bytes()
    rows = [json.loads(line) for line in source.splitlines() if line.strip()]
    identities = [row.get('sample_id') for row in rows]
    if not rows or any(not isinstance(key, str) or not key for key in identities) or len(set(identities)) != len(rows):
        raise ValueError('Manifest must contain unique nonempty sample identities')
    output.mkdir(parents=True, exist_ok=True)
    factory = model_factory or PortableModel
    general = factory(general_model_dir, device=device)
    names = factory(name_model_dir, device=device)
    models = {'general': model_record(general_model_dir, general), 'names': model_record(name_model_dir, names)}
    if device in ('gpu:0', 'cuda') and any(not record['cuda_placement_proof'] or record['cuda_placement_proof'].get('cpu_heavy_nodes') != 0 for record in models.values()):
        raise RuntimeError('Verified CUDA operator placement is required for both models')
    protocol = {
        'manifest': str(manifest), 'manifest_sha256': digest(source), 'samples': len(rows), 'device': device,
        'models': models, 'conditions': list(conditions),
        'validation_contract': {'version': CONTRACT['version'], 'sha256': CONTRACT_SHA256},
        'implementation_sha256': {Path(__file__).name: digest(Path(__file__).read_bytes()),
                                  'portable_ocr.py': digest(Path(__file__).with_name('portable_ocr.py').read_bytes()),
                                  'ocr_output.py': digest(Path(__file__).with_name('ocr_output.py').read_bytes())},
        'input_policy': 'Original decoded BGR crops; only the explicitly named stress transform precedes PortableModel normalization.',
        'negative_policy': 'Empty labels are existing manifest targets; no schema rejection or OCR guess creates negative ground truth.',
        'uniform_guard': 'PortableModel treats exactly uniform original BGR inputs as deterministic blank; other inputs use the neural recognizer.',
        'selection': 'Frozen models; no fitting, threshold calibration, label repairs or training.',
        'limitations': 'Reused development data and mixed collector/assistant/API-teacher labels. This is not independent prospective accuracy or end-to-end frame latency proof.',
        'opencv_version': cv2.__version__, 'numpy_version': np.__version__,
    }
    (output / 'protocol.json').write_text(json.dumps(protocol, indent=2))
    summaries = {}
    for condition in conditions:
        start = time.monotonic()
        folder = output / condition
        folder.mkdir(exist_ok=True)
        results = []
        with (folder / 'predictions.jsonl').open('w') as stream:
            for index, row in enumerate(rows):
                result = {key: row.get(key) for key in ('sample_id', 'category', 'region_id', 'split', 'label', 'label_evidence', 'origin', 'file_sha256', 'pixel_sha256')}
                result.update(optimize=row.get('optimize', True), scope='synthetic_control' if is_control(row) else 'real_observation',
                              evidence_source=evidence_source(row), condition=condition, sample_seed=sample_seed(row['sample_id']),
                              model_role='names' if row.get('category') == 'name' else 'general')
                try:
                    validate_row(row)
                    image = transform(load_crop(bundle, row), condition)
                    result['uniform_input'] = bool(np.all(image == image[0, 0]))
                    model = names if row['category'] == 'name' else general
                    before = time.perf_counter()
                    raw_prediction, confidence = decode_ctc(model.probabilities(image), model.characters)
                    result['inference_ms'] = (time.perf_counter() - before) * 1000
                    if not math.isfinite(confidence):
                        raise ValueError('Nonfinite recognizer confidence')
                    prediction = canonicalize_output(raw_prediction, row['category'])
                    result.update(raw_prediction=raw_prediction, prediction=prediction, confidence=confidence,
                                  raw_exact=raw_prediction == row['label'], exact=prediction == row['label'],
                                  schema_valid=validate_text(row['category'], prediction, allow_blank=True))
                except Exception as error:
                    result.update(error=f'{type(error).__name__}: {error}', raw_exact=False, exact=False,
                                  raw_prediction=None, prediction=None, confidence=None, schema_valid=False)
                results.append(result)
                stream.write(json.dumps(result, sort_keys=True) + '\n')
                if (index + 1) % 500 == 0:
                    print(json.dumps({'condition': condition, 'processed': index + 1, 'total': len(rows)}), flush=True)
        summary = summarize(results)
        summary['elapsed_seconds'] = time.monotonic() - start
        summaries[condition] = summary
        (folder / 'metrics.json').write_text(json.dumps(summary, indent=2))
        print(json.dumps({'condition': condition, 'metrics': summary['all']}), flush=True)
    if manifest.read_bytes() != source:
        raise RuntimeError('Manifest changed during evaluation; discard this benchmark')
    if models != {'general': model_record(general_model_dir, general), 'names': model_record(name_model_dir, names)}:
        raise RuntimeError('Model artifacts changed during evaluation; discard this benchmark')
    (output / 'summary.json').write_text(json.dumps(summaries, indent=2))
    return summaries


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--general-model-dir', type=Path, required=True)
    parser.add_argument('--name-model-dir', type=Path, required=True)
    parser.add_argument('--device', default='gpu:0', choices=('gpu:0', 'cuda', 'cpu'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--conditions', nargs='+', choices=CONDITIONS, default=['identity'])
    parser.add_argument('--compare-to', type=Path, help='Prior benchmark output with the same frozen manifest/conditions')
    args = parser.parse_args(argv)
    result = run_benchmark(args.bundle, args.manifest or args.bundle / 'manifest.jsonl', args.general_model_dir,
                           args.name_model_dir, args.output, device=args.device, conditions=args.conditions)
    if args.compare_to:
        compare_benchmarks(args.output, args.compare_to)
    return result


if __name__ == '__main__':
    main()
