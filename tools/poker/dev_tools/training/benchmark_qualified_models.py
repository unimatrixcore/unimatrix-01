#!/usr/bin/env python3
"""Fresh full-corpus neural benchmark; spatial acceptance is a separate measure.

The primary pass executes each real/constructed crop once per named condition.
The supplemental anonymous-name pass reads the same single crop with the pinned
general model. It is a diagnostic candidate, not the production five-view gate.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import time

import numpy as np

from benchmark_named_models import (CONDITIONS, load_crop, run_benchmark, summarize,
                                    transform)
from ocr_output import canonicalize_output
from portable_ocr import PortableModel, decode_ctc
from schemas import validate_text


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def distance(left, right):
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1,
                               previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def text_metrics(rows):
    total_characters = sum(len(r['label']) for r in rows)
    raw_edits = sum(distance(r['label'], r.get('raw_prediction') or '') for r in rows)
    selected_edits = sum(distance(r['label'], r.get('prediction') or '') for r in rows)
    return {'reference_characters': total_characters,
            'raw_character_edits': raw_edits,
            'canonical_character_edits': selected_edits,
            'raw_cer': raw_edits / total_characters if total_characters else None,
            'canonical_cer': selected_edits / total_characters if total_characters else None}


def timings(values):
    if not values:
        return {'samples': 0}
    return {'samples': len(values), 'p50_ms': float(np.percentile(values, 50)),
            'p95_ms': float(np.percentile(values, 95)),
            'p99_ms': float(np.percentile(values, 99)), 'max_ms': max(values),
            'total_ms': sum(values),
            'neural_only_crops_per_second': len(values) * 1000 / sum(values)}


def strata(rows):
    groups = defaultdict(list)
    groups['all'] = rows
    groups['real_observations'] = [r for r in rows if r['scope'] == 'real_observation']
    groups['synthetic_controls'] = [r for r in rows if r['scope'] == 'synthetic_control']
    groups['real_optimized'] = [r for r in groups['real_observations'] if r.get('optimize', True)]
    groups['real_optimization_excluded'] = [r for r in groups['real_observations'] if not r.get('optimize', True)]
    for field in ('split', 'category', 'origin'):
        for row in rows:
            groups[field + ':' + str(row.get(field))].append(row)
    for row in groups['real_observations']:
        groups['real_split:' + row['split']].append(row)
        groups['real_category:' + row['category']].append(row)
    return {key: text_metrics(value) for key, value in groups.items()}


def paired(before, after):
    old = {r['sample_id']: r for r in before}
    assert len(old) == len(before) == len(after)
    assert {r['sample_id'] for r in after} == set(old)
    pairs = []
    for row in after:
        previous = old[row['sample_id']]
        for field in ('label', 'category', 'split', 'file_sha256', 'scope'):
            assert previous[field] == row[field], (row['sample_id'], field)
        pairs.append((previous, row))
    def count(values):
        return {'samples': len(values),
                'canonical_improvements': sum(not a['exact'] and b['exact'] for a, b in values),
                'canonical_regressions': sum(a['exact'] and not b['exact'] for a, b in values),
                'both_correct': sum(a['exact'] and b['exact'] for a, b in values),
                'both_wrong': sum(not a['exact'] and not b['exact'] for a, b in values)}
    return {'all': count(pairs),
            'real_observations': count([p for p in pairs if p[1]['scope'] == 'real_observation']),
            'synthetic_controls': count([p for p in pairs if p[1]['scope'] == 'synthetic_control']),
            'real_by_split': {s: count([p for p in pairs if p[1]['scope'] == 'real_observation' and p[1]['split'] == s])
                              for s in ('train', 'val', 'test')}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--baseline', type=Path, required=True)
    args = parser.parse_args()
    bundle, release, output = args.bundle.resolve(), args.release.resolve(), args.output.resolve()
    assert not output.exists(), 'Choose a new output directory; prior results are immutable'
    manifest = bundle / 'manifest.jsonl'
    records = [json.loads(line) for line in manifest.read_text().splitlines() if line.strip()]
    assert len(records) == 13315
    by_id = {r['sample_id']: r for r in records}
    assert len(by_id) == len(records)
    frozen = json.loads((release / 'freeze.json').read_text())
    models = {}
    startup = {}
    def factory(path, device):
        role = 'names' if Path(path).name == 'names' else 'general'
        assert sha(Path(path) / 'model.onnx') == frozen['weights'][role]
        assert sha(Path(path) / 'characters.json') == frozen['characters_sha256'][role]
        start = time.perf_counter()
        result = PortableModel(path, device=device)
        startup[role] = {'milliseconds': (time.perf_counter() - start) * 1000,
                         'cuda_placement_proof': result.cuda_placement_proof,
                         'fallback_enabled': result.session._enable_fallback}
        assert result.session._enable_fallback is False
        models[role] = result
        return result
    started = time.monotonic()
    primary = run_benchmark(bundle, manifest, release / 'models/general',
                            release / 'models/names', output,
                            conditions=CONDITIONS, device='gpu:0', model_factory=factory)
    full = {}
    all_conditions = {}
    for condition in CONDITIONS:
        folder = output / condition
        rows = [json.loads(line) for line in (folder / 'predictions.jsonl').read_text().splitlines()]
        assert len(rows) == len(records)
        selected, extra_times = [], []
        for original in rows:
            result = dict(original)
            result.update(primary_raw_prediction=original.get('raw_prediction'),
                          primary_prediction=original.get('prediction'),
                          primary_confidence=original.get('confidence'),
                          anonymous_single_crop_crosscheck=False,
                          selected_reading_state='single_crop_reading')
            text = result.get('prediction')
            if (not result.get('error') and result['category'] == 'name'
                    and isinstance(text, str) and re.fullmatch(r'Player[1-9]', text)):
                result['anonymous_single_crop_crosscheck'] = True
                image = transform(load_crop(bundle, by_id[result['sample_id']]), condition)
                start = time.perf_counter()
                try:
                    general_text, general_confidence = decode_ctc(models['general'].probabilities(image), models['general'].characters)
                    extra = (time.perf_counter() - start) * 1000
                    assert math.isfinite(general_confidence)
                    extra_times.append(extra)
                    result.update(secondary_general_raw_prediction=general_text,
                                  secondary_general_confidence=general_confidence,
                                  secondary_inference_ms=extra)
                    matched = (re.fullmatch(r'Player ?[1-9]', general_text) is not None
                               and general_text.replace(' ', '') == text
                               and validate_text('name', general_text))
                    result.update(raw_prediction=general_text if matched else None,
                                  prediction=general_text if matched else None,
                                  confidence=general_confidence,
                                  schema_valid=bool(matched), model_role='general',
                                  selected_reading_state='single_crop_crosscheck_candidate' if matched else 'abstained')
                except Exception as exc:
                    result.update(error=f'{type(exc).__name__}: {exc}', raw_prediction=None,
                                  prediction=None, confidence=None, schema_valid=False,
                                  selected_reading_state='abstained')
                result.update(raw_exact=result.get('raw_prediction') == result['label'] and not result.get('error'),
                              exact=result.get('prediction') == result['label'] and not result.get('error'))
            selected.append(result)
        with (folder / 'single-crop-crosschecked-predictions.jsonl').open('w') as stream:
            for row in selected:
                stream.write(json.dumps(row, sort_keys=True) + '\n')
        neural = [r['inference_ms'] for r in rows if not r.get('error') and not r['uniform_input']]
        uniform = [r['inference_ms'] for r in rows if not r.get('error') and r['uniform_input']]
        total = [r['inference_ms'] for r in rows if not r.get('error')]
        full[condition] = {'primary': primary[condition], 'primary_cer': strata(rows),
                           'single_crop_crosscheck': summarize(selected),
                           'single_crop_crosscheck_cer': strata(selected),
                           'single_crop_crosscheck_counts': dict(Counter(r['selected_reading_state'] for r in selected)),
                           'primary_neural_latency': timings(neural), 'uniform_guard_latency': timings(uniform),
                           'all_primary_latency': timings(total), 'secondary_general_latency': timings(extra_times),
                           'primary_latency_by_role': {role: timings([r['inference_ms'] for r in rows if not r.get('error') and not r['uniform_input'] and r['model_role'] == role]) for role in ('general', 'names')},
                           'paired_primary_to_single_crop_crosscheck': paired(rows, selected)}
        all_conditions[condition] = (rows, selected)
        (folder / 'extended-metrics.json').write_text(json.dumps(full[condition], indent=2))
    baseline = args.baseline.resolve()
    prior = [json.loads(line) for line in (baseline / 'identity/predictions.jsonl').read_text().splitlines()]
    comparison = {'scope': 'Identity-only historical comparison, paired identical IDs/labels/files; new semantic optimization exclusions are reported separately.',
                  'baseline_protocol_sha256': sha(baseline / 'protocol.json'),
                  'baseline_predictions_sha256': sha(baseline / 'identity/predictions.jsonl'),
                  'new_primary': paired(prior, all_conditions['identity'][0]),
                  'single_crop_crosscheck_candidate': paired(prior, all_conditions['identity'][1])}
    report = {'manifest_sha256': sha(manifest), 'freeze_sha256': sha(release / 'freeze.json'),
              'benchmark_script_sha256': sha(__file__), 'samples_per_condition': len(records),
              'conditions': full, 'startup': startup, 'paired_historical_identity': comparison,
              'total_wall_seconds': time.monotonic() - started,
              'fresh_inference': True, 'primary_prediction_rows': len(records) * len(CONDITIONS),
              'production_acceptance_claim': False,
              'scope': 'Fresh GPU batch1 neural reading benchmark over the entire frozen corpus, including reused TRAIN/VAL/TEST and controls. No model fitting or cached predictions.',
              'single_crop_crosscheck_limitation': 'Supplemental same-single-crop general reading only; it is not the required genuine five-view production acceptance policy. Never treat these candidate readings as accepted live results.',
              'stress_limitation': 'Crop brightness/JPEG/scale transforms do not simulate shifting a full frame and recropping or changes in collector admission.',
              'latency_scope': 'Synchronous per-crop normalization+model+CTC decode wall time. Uniform-input guard and extra general calls reported separately. No end-to-end frame-latency claim.'}
    (output / 'full-summary.json').write_text(json.dumps(report, indent=2))
    mistakes = [r for r in all_conditions['identity'][1] if not r['exact']]
    (output / 'identity-mistakes.json').write_text(json.dumps(mistakes, indent=2))
    assert all(full[c]['primary']['all']['samples'] == 13315 for c in CONDITIONS)
    assert all(full[c]['primary']['all']['processing_errors'] == 0 for c in CONDITIONS)
    (output / 'assertions.json').write_text(json.dumps({'passed': True, 'all_samples_all_conditions': True,
                'primary_prediction_rows': 53260, 'processing_errors': 0,
                'paired_ID_label_pixel_contract_verified': True,
                'actual_heavy_CUDA_verified_both_roles': True, 'fallback_disabled_both_roles': True}, indent=2))
    print(json.dumps({'complete': True, 'output': str(output), 'samples_per_condition': len(records),
                      'primary_prediction_rows': 53260, 'wall_seconds': report['total_wall_seconds'],
                      'identity_primary': primary['identity']['real_observations'],
                      'identity_crosscheck_candidate': full['identity']['single_crop_crosscheck']['real_observations']}), flush=True)


if __name__ == '__main__':
    main()
