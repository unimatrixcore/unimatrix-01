#!/usr/bin/env python3
"""Benchmark every labeled real crop using genuine full-source context.

Preparation is read-only for source data. It extracts an unaltered two-pixel
context margin, whose five-view fingerprint is checked again before inference.
The remote inference stage does not reconstruct or fabricate a full frame.
Full-frame admission was measured locally on the original source image.
Two synthetic replay opportunities exercise the actual temporal policy; they
are not independent physical observations or an end-to-end frame benchmark.
"""

import sys as _storage_sys
from pathlib import Path as _StoragePath
_storage_sys.path.insert(0, str(_StoragePath(__file__).resolve().parents[1]))
from lib.storage_paths import training_dir, data_dir

import argparse
import collections
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time

import cv2
import numpy as np

from collector_frame_policy import plan_frame_regions
from production_decision import TemporalAgreement
from production_reader import CollectorReader, region_inputs
from realtime_collector import verify_frozen_runtime


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pixel_sha(image):
    h, w = image.shape[:2]
    return hashlib.sha256(f'{w}x{h}:RGB:'.encode() + cv2.cvtColor(image, cv2.COLOR_BGR2RGB).tobytes()).hexdigest()


def resolve(config, region_id):
    node = config
    for key, index in re.findall(r'([a-zA-Z_]+)|\[(\d+)\]', region_id):
        node = node[int(index)] if index else node[key]
    if not isinstance(node, dict) or set(('x', 'y', 'w', 'h')) - set(node):
        raise ValueError('Region has no configured rectangle')
    return {key: node[key] for key in ('x', 'y', 'w', 'h')}


def context_tile(frame, rect, category):
    """Keep exactly the source pixels needed by all five shifted views."""
    _, original = region_inputs(frame, rect, category)
    x, y, w, h = (rect[k] for k in ('x', 'y', 'w', 'h'))
    tile = frame[y - 2:y + h + 2, x - 2:x + w + 2].copy()
    local_rect = {'x': 2, 'y': 2, 'w': w, 'h': h}
    _, derived = region_inputs(tile, local_rect, category)
    if original != derived:
        raise ValueError('Extracted context changed the actual five views')
    return tile, local_rect, original


def save_tile(folder, fingerprint, tile):
    """Concurrent aliases share one lossless file without overlapping writers."""
    ok, encoded = cv2.imencode('.png', tile)
    if not ok:
        raise ValueError('Context PNG encoding failed')
    try:
        with (folder / (fingerprint + '.png')).open('xb') as stream:
            stream.write(encoded.tobytes())
    except FileExistsError:
        pass


def original_source(row, repo):
    if row['origin'] == 'baseline':
        names = [g.split('legacy:capture:', 1)[1] for g in row.get('groups', []) if g.startswith('legacy:capture:')]
        if not names:
            return None
        return data_dir() / 'collector_datasets/legacy/full_captures' / names[0]
    name = row.get('provenance', {}).get('source_capture_filename')
    if not name or Path(name).name != name:
        return None
    return data_dir() / 'collector_datasets' / row['dataset_id'] / 'full_captures' / name


def prepare(args):
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    payload = root / 'payload'
    payload.mkdir()
    (payload / 'contexts').mkdir()
    repo = Path(__file__).resolve().parents[2]
    manifest = args.manifest.resolve()
    rows = [json.loads(line) for line in manifest.read_text().splitlines()]
    assert len({r['sample_id'] for r in rows}) == len(rows)
    stage = args.release.resolve()
    regions = json.loads((stage / 'regions.json').read_text())
    colors = json.loads((stage / 'colors.json').read_text())
    code = payload / 'code/training'
    code.mkdir(parents=True)
    frozen = json.loads((stage / 'freeze.json').read_text())
    for name, expected in frozen['implementation_sha256'].items():
        source = repo / 'dev_tools/training' / name
        assert sha(source) == expected, name
        shutil.copyfile(source, code / name)
    shutil.copyfile(__file__, code / Path(__file__).name)
    lib = payload / 'code/lib'
    lib.mkdir()
    for name in ('database.py', 'ocr_contract.py'):
        shutil.copyfile(repo / 'dev_tools/lib' / name, lib / name)
    shutil.copyfile(repo / 'dev_tools/ocr_contract.json', payload / 'code/ocr_contract.json')
    shutil.copytree(stage / 'models', payload / 'release/models')
    for name in ('runtime.json', 'regions.json', 'colors.json', 'freeze.json'):
        shutil.copyfile(stage / name, payload / 'release' / name)
    grouped = collections.defaultdict(list)
    outcomes = []
    for index, row in enumerate(rows):
        small = {k: row.get(k) for k in ('sample_id', 'category', 'label', 'origin', 'split', 'optimize', 'semantic_role', 'label_evidence')}
        small.update(index=index, state='pending')
        if row['origin'] not in ('baseline', 'named'):
            small.update(state='synthetic_no_genuine_context', reason='Synthetic controls belong to the raw recognizer benchmark, not physical five-view context.')
            outcomes.append(small)
            continue
        source = original_source(row, repo)
        small['source_path'] = str(source) if source else None
        if source is None or not source.is_file():
            small.update(state='missing_source_context', reason='No registered original full frame is available.')
            outcomes.append(small)
            continue
        original = Path(row['source_image'])
        rect = row.get('provenance', {}).get('crop_rect') or {k: row.get(k) for k in ('x', 'y', 'w', 'h')}
        small.update(original_crop_path=str(original), expected_file_sha256=row.get('file_sha256', row.get('image_sha256')), expected_pixel_sha256=row.get('pixel_sha256'), original_rect=rect, region_id=row['region_id'])
        grouped[str(source)].append((row, small))
    started = time.perf_counter()

    def frame_job(pair):
        filename, members = pair
        raw = Path(filename).read_bytes()
        frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        source_sha = hashlib.sha256(raw).hexdigest()
        info = {'source_path': filename, 'source_sha256': source_sha, 'rows': len(members)}
        result = []
        if frame is None:
            return info, [dict(item, state='invalid_source_image') for _, item in members]
        info['dimensions'] = list(frame.shape[1::-1])
        # This is a candidate geometry/color plan only. Inference must prove
        # the actual source Game ID before any target is called admitted.
        plan = plan_frame_regions(frame, regions, colors, {'state': 'text', 'text': '#12345678'})
        info.update(candidate_frame_admitted=plan['accepted_frame'], active_seats=plan['active_seats'], name_eligible_seats=plan['name_eligible_seats'], admitted_region_ids=[r['region_id'] for r in plan['regions']], rejections=plan['rejected'])
        try:
            tile, local_rect, fingerprint = context_tile(frame, regions['round_id'], 'round_id')
            save_tile(payload / 'contexts', fingerprint, tile)
            info['header_context'] = {'fingerprint': fingerprint, 'rect': local_rect, 'category': 'round_id'}
        except (ValueError, KeyError, TypeError) as exc:
            info['header_context_error'] = str(exc)
        for _, item in members:
            try:
                original_path = Path(item['original_crop_path'])
                original_bytes = original_path.read_bytes()
                if hashlib.sha256(original_bytes).hexdigest() != item['expected_file_sha256']:
                    raise ValueError('Original crop file hash differs from frozen manifest')
                image = cv2.imdecode(np.frombuffer(original_bytes, np.uint8), cv2.IMREAD_COLOR)
                if image is None:
                    raise ValueError('Original crop decoding failed')
                if pixel_sha(image) != item['expected_pixel_sha256']:
                    raise ValueError('Original crop RGB identity differs from frozen manifest')
                rect = item['original_rect']
                x, y, w, h = (rect[k] for k in ('x', 'y', 'w', 'h'))
                actual = frame[y:y + h, x:x + w]
                if actual.shape != image.shape or not np.array_equal(actual, image):
                    item.update(state='source_crop_mismatch', source_crop_matches=False)
                    result.append(item)
                    continue
                current = resolve(regions, item['region_id'])
                cx, cy, cw, ch = (current[k] for k in ('x', 'y', 'w', 'h'))
                current_pixels = frame[cy:cy + ch, cx:cx + cw]
                tile, local_rect, fingerprint = context_tile(frame, rect, item['category'])
                save_tile(payload / 'contexts', fingerprint, tile)
                item.update(state='context_ready', source_crop_matches=True, source_sha256=source_sha, current_rect=current, current_rect_exact=(rect == current), current_center_rgb_exact=(current_pixels.shape == image.shape and np.array_equal(current_pixels, image)), context={'fingerprint': fingerprint, 'rect': local_rect, 'category': item['category']})
            except (ValueError, TypeError, KeyError, OSError) as exc:
                item.update(state='context_integrity_or_geometry_failure', reason=str(exc))
            result.append(item)
        return info, result

    frames = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for index, (frame, result) in enumerate(pool.map(frame_job, sorted(grouped.items()))):
            frames.append(frame)
            outcomes.extend(result)
            if index % 200 == 0:
                print(json.dumps({'preparation_sources': index + 1, 'total_sources': len(grouped), 'elapsed_seconds': time.perf_counter() - started}), flush=True)
    outcomes.sort(key=lambda r: r['index'])
    assert len(outcomes) == len(rows)
    data = {'manifest_sha256': sha(manifest), 'freeze_sha256': sha(stage / 'freeze.json'), 'rows': outcomes, 'frames': frames, 'scope': 'Original source context extraction; actual header inference is still required. No padding or isolated-crop fake shifted views.', 'script_sha256': sha(__file__)}
    (payload / 'inputs.json').write_text(json.dumps(data, separators=(',', ':')) + '\n')
    counts = dict(collections.Counter(r['state'] for r in outcomes))
    (root / 'preparation-summary.json').write_text(json.dumps({'rows': len(rows), 'sources': len(frames), 'counts': counts, 'current_geometry_and_pixels_exact': sum(r.get('current_rect_exact') and r.get('current_center_rgb_exact') for r in outcomes if r['state'] == 'context_ready'), 'unique_context_tiles': len(list((payload / 'contexts').glob('*.png'))), 'seconds': time.perf_counter() - started, 'inputs_sha256': sha(payload / 'inputs.json')}, indent=2) + '\n')
    print(json.dumps(counts), flush=True)


def infer(args):
    root = args.root.resolve()
    data = json.loads((root / 'inputs.json').read_text())
    release = root / 'release'
    config = json.loads((release / 'runtime.json').read_text())
    regions = json.loads((release / 'regions.json').read_text())
    colors = json.loads((release / 'colors.json').read_text())
    models = {role: release / config[key] for role, key in [('general', 'general_model'), ('names', 'name_model')]}
    verify_frozen_runtime(release / 'freeze.json', models['general'], models['names'], regions, colors, args.device, 1.)
    reader = CollectorReader(models['general'], name_model_dir=models['names'], device=args.device, view_policy='five', max_cache_entries=20000)
    frames = {f['source_path']: f for f in data['frames']}
    # A persistent result ledger deduplicates exact five-view neural inputs.
    # Every alias is still accounted in row-level denominators and splits.
    decisions = {}
    neural_calls = 0
    lookup_hits = 0
    timings = []
    started = time.perf_counter()

    def read(context):
        nonlocal neural_calls, lookup_hits
        fingerprint = context['fingerprint']
        if fingerprint in decisions:
            lookup_hits += 1
            return decisions[fingerprint]
        frame = cv2.imread(str(root / 'contexts' / (fingerprint + '.png')))
        before = time.perf_counter()
        decision, views, calls, actual = reader._read_region(frame, context['rect'], context['category'])
        elapsed = (time.perf_counter() - before) * 1000
        assert actual == fingerprint, 'Remote extraction changed five-view identity'
        neural_calls += calls
        timings.append(elapsed)
        decisions[fingerprint] = {'decision': decision.__dict__, 'views': views, 'inference_crops': calls, 'uncached_ms': elapsed, 'input_fingerprint': actual}
        return decisions[fingerprint]

    results = []
    for index, original in enumerate(data['rows']):
        item = dict(original)
        if item['state'] != 'context_ready':
            results.append(item)
            continue
        frame = frames[item['source_path']]
        if 'header_context' not in frame:
            item.update(state='header_context_unavailable')
            results.append(item)
            continue
        header = read(frame['header_context'])
        spatial = read(item['context'])
        item['header_spatial'] = header['decision']
        item['spatial_fingerprint'] = spatial['input_fingerprint']
        item['spatial_decision'] = spatial['decision']
        from production_decision import Decision
        header_decision = Decision(**header['decision'])
        header_temporal = TemporalAgreement()
        if header_decision.state == 'text':
            header_temporal.update('round_id', header_decision.text, f'archive-{index}-observation1', 100.0, header_decision)
            confirmed_header = header_temporal.update('round_id', header_decision.text, f'archive-{index}-observation2', 100.5, header_decision)
        else:
            confirmed_header = header_decision
        item['header_temporal'] = confirmed_header.__dict__
        admitted = frame['candidate_frame_admitted'] and confirmed_header.state == 'text' and item['region_id'] in frame['admitted_region_ids']
        item['frame_admitted'] = frame['candidate_frame_admitted'] and confirmed_header.state == 'text'
        item['target_admitted'] = admitted
        item['current_deployment_exact'] = bool(item['current_rect_exact'] and item['current_center_rgb_exact'])
        if not admitted:
            item.update(state='not_admitted', decision=None, reason=('game_id_unverified' if header['decision']['state'] != 'text' else 'pixel_frame_or_region_admission_rejected'))
        else:
            temporal = TemporalAgreement()
            d = Decision(**spatial['decision'])
            table = header['decision']['text']
            temporal.update(item['region_id'], table, f'archive-{index}-observation1', 100.0, d)
            final = temporal.update(item['region_id'], table, f'archive-{index}-observation2', 100.5, d)
            item['decision'] = final.__dict__
            if final.state == 'unknown':
                item['state'] = 'abstained'
            elif final.text == item['label']:
                item['state'] = 'accepted_exact'
            else:
                item['state'] = 'accepted_label_mismatch'
        results.append(item)
        if index % 500 == 0:
            print(json.dumps({'rows_processed': index + 1, 'total_rows': len(data['rows']), 'unique_view_groups': len(decisions), 'neural_crops': neural_calls, 'seconds': time.perf_counter() - started}), flush=True)
    out = root / 'results'
    out.mkdir(exist_ok=True)
    (out / 'rows.jsonl').write_text(''.join(json.dumps(r, separators=(',', ':')) + '\n' for r in results))
    (out / 'view-decisions.jsonl').write_text(''.join(json.dumps(v, separators=(',', ':')) + '\n' for v in decisions.values()))
    def aggregate(subset):
        counts = collections.Counter(r['state'] for r in subset)
        correct = counts['accepted_exact']
        wrong = counts['accepted_label_mismatch']
        admitted = correct + wrong + counts['abstained']
        return {'rows': len(subset), 'states': dict(counts), 'accepted': correct + wrong, 'accepted_exact': correct, 'accepted_label_mismatch': wrong, 'accepted_precision_against_stored_labels': correct / (correct + wrong) if correct + wrong else None, 'accepted_coverage_of_admitted': (correct + wrong) / admitted if admitted else None, 'false_blank_acceptances': sum(r['state'] == 'accepted_label_mismatch' and r.get('decision', {}).get('state') == 'blank' and bool(r['label']) for r in subset), 'negative_false_acceptances': sum(r['state'] == 'accepted_label_mismatch' and bool(r.get('decision', {}).get('text')) and not r['label'] for r in subset)}
    measured = [r for r in results if r['origin'] in ('baseline', 'named')]
    current = [r for r in measured if r.get('current_deployment_exact')]
    import platform, onnxruntime
    summary = {'scope': 'Five-view + actual header + full-source admission + two-observation target replay. Original archived pixels repeat under synthetic opportunity IDs; not independent physical evidence, not full end-to-end frame/currency-state replay.', 'full_frame_currency_consistency_replayed': False, 'temporal_scope': 'Actual TemporalAgreement is independently reset per target case; header and field each receive two synthetic opportunities. Cross-source transition/invalidation paths are not replayed here.', 'manifest_sha256': data['manifest_sha256'], 'freeze_sha256': data['freeze_sha256'], 'device': args.device, 'execution_environment': {'hostname': platform.node(), 'python': platform.python_version(), 'opencv': cv2.__version__, 'numpy': np.__version__, 'onnxruntime': onnxruntime.__version__, 'onnxruntime_module': onnxruntime.__file__}, 'all_rows': aggregate(results), 'real_original_geometry': aggregate(measured), 'current_deployment_exact_geometry': aggregate(current), 'by_category': {k: aggregate([r for r in measured if r['category'] == k]) for k in sorted({r['category'] for r in measured})}, 'current_by_category': {k: aggregate([r for r in current if r['category'] == k]) for k in sorted({r['category'] for r in current})}, 'by_split': {k: aggregate([r for r in measured if r['split'] == k]) for k in sorted({r['split'] for r in measured})}, 'current_by_split': {k: aggregate([r for r in current if r['split'] == k]) for k in sorted({r['split'] for r in current})}, 'optimization_excluded': aggregate([r for r in measured if r.get('optimize') is False]), 'timing': {'seconds': time.perf_counter() - started, 'unique_five_view_groups': len(decisions), 'cache_alias_hits': lookup_hits, 'neural_crop_calls': neural_calls, 'uncached_group_ms': {'p50': float(np.percentile(timings, 50)), 'p95': float(np.percentile(timings, 95)), 'maximum': max(timings)}}, 'cuda_placement': {'general': reader.model.cuda_placement_proof, 'names': reader.name_model.cuda_placement_proof}, 'source_inputs_sha256': sha(root / 'inputs.json'), 'script_sha256': sha(__file__), 'known_limitations': ['Stored corpus labels include historical annotation errors and mixed provenance; mismatches require visual audit and are not silently corrected.', 'Original-crop geometry is separated from exact current deployed ROI geometry.', 'Synthetic rows have no genuine full-source context and are N/A for this policy benchmark.', 'Five views and two synthetic replay opportunities do not establish independent physical accuracy.', 'Cross-region currency-state consistency and capture/IPC/GUI latency are not replayed here.']}
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    (out / 'label-mismatches.json').write_text(json.dumps([r for r in results if r['state'] == 'accepted_label_mismatch'], indent=2) + '\n')
    print(json.dumps(summary), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('prepare', 'infer'))
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--release', type=Path)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--workers', type=int, default=8)
    parser.add_argument('--device', default='gpu:0')
    arguments = parser.parse_args()
    if arguments.mode == 'prepare':
        if not arguments.release or not arguments.manifest:
            parser.error('prepare needs --release and --manifest')
        prepare(arguments)
    else:
        infer(arguments)
