#!/usr/bin/env python3
"""Score sealed assistant visual truth against observed fresh-capture publications.

This tool never runs inference or alters source/truth files. Repeated polls are
reported as correlated observations, never as independent accuracy samples.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
import re
from pathlib import Path


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def rows(value):
    if isinstance(value, list):
        return value
    for key in ('items', 'reviews', 'frames', 'records'):
        if key in value:
            return value[key]
    raise ValueError('Expected a list or items/reviews/frames/records object')


def unique_index(records, field, kind):
    result = {}
    for row in records:
        key = row[field]
        if key in result:
            raise ValueError(f'Duplicate {kind}: {key}')
        result[key] = row
    return result


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def latency_summary(values):
    return {'count': len(values), 'p50_ms': percentile(values, .50),
            'p95_ms': percentile(values, .95), 'max_ms': max(values) if values else None}



def metric_rates(counts):
    def ratio(numerator, denominator):
        return numerator / denominator if denominator else None
    accepted = counts.get('accepted_exact', 0) + counts.get('accepted_wrong', 0)
    return {'accepted_precision': ratio(counts.get('accepted_exact', 0), accepted),
            'accepted_coverage_of_scorable_published_fields': ratio(accepted, counts.get('scorable_truth_observations', 0)),
            'raw_center_exact_rate': ratio(counts.get('raw_center_exact', 0), counts.get('raw_center_total', 0)),
            'raw_all_views_exact_rate': ratio(counts.get('raw_view_exact', 0), counts.get('raw_view_total', 0)),
            'text_truth_accepted_exact_rate': ratio(counts.get('text_truth_accepted_exact', 0), counts.get('truth_text', 0)),
            'blank_truth_accepted_exact_rate': ratio(counts.get('blank_truth_accepted_exact', 0), counts.get('truth_blank', 0)),
            'raw_text_truth_center_exact_rate': ratio(counts.get('raw_text_truth_center_exact', 0), counts.get('raw_text_truth_center_total', 0))}


def aggregate_metrics(groups):
    total = Counter()
    for counts in groups.values():
        total.update(counts)
    return {'counts': dict(total), 'rates': metric_rates(total)}


def verify_truth(items, reviews, captures, expected, frame_reviews, partial=False):
    """Require exact one-time visual review and occurrence identity coverage."""
    sources = unique_index(captures, 'source_id', 'source')
    item_by_id = unique_index(items, 'id', 'item')
    review_by_id = unique_index(reviews, 'id', 'review')
    frames = unique_index(frame_reviews, 'source_id', 'frame review')
    if set(review_by_id) - set(item_by_id):
        raise ValueError('Review refers to an unknown item')
    missing_items = sorted(set(item_by_id) - set(review_by_id))
    if missing_items and not partial:
        raise ValueError(f'Missing visual reviews: {len(missing_items)}')
    if set(frames) - set(sources):
        raise ValueError('Frame review refers to an unknown source')
    missing_frames = sorted(set(sources) - set(frames))
    if missing_frames and not partial:
        raise ValueError(f'Missing independent frame admission reviews: {len(missing_frames)}')
    for row in frames.values():
        if row.get('visually_reviewed') is not True or row.get('reviewer') != 'assistant_visual':
            raise ValueError('Frame admission must be independently assistant visually reviewed')
        if row.get('frame_admission') not in ('admit', 'reject', 'ambiguous'):
            raise ValueError('Invalid frame admission state')
        if row.get('source_sha256') != sources[row['source_id']]['sha256']:
            raise ValueError('Frame admission source image mismatch')
        if row['frame_admission'] == 'admit' and (not isinstance(row.get('active_seats'), list) or
                any(type(v) is not int or not 0 <= v < 9 for v in row['active_seats']) or
                len(set(row['active_seats'])) != len(row['active_seats'])):
            raise ValueError('Active table admission requires explicit distinct seat indices')
    truth = {}
    exact_groups = set()
    for item in items:
        group = (item['category'], item['pixel_sha256'], item.get('width'), item.get('height'))
        if group in exact_groups:
            raise ValueError('Duplicate exact-pixel/category review group')
        exact_groups.add(group)
        review = review_by_id.get(item['id'])
        if review is not None:
            if review.get('visually_reviewed') is not True or review.get('reviewer') != 'assistant_visual':
                raise ValueError('Truth requires assistant_visual and visually_reviewed true')
            if review.get('state') not in ('text', 'blank', 'ambiguous'):
                raise ValueError('Invalid visual truth state')
            if review.get('pixel_sha256') != item['pixel_sha256']:
                raise ValueError('Review label is bound to different image pixels')
            if review['state'] != 'ambiguous' and not isinstance(review.get('label'), str):
                raise ValueError('Text/blank visual truth label must be a string')
            if review['state'] == 'text' and not review['label']:
                raise ValueError('Text truth requires nonempty exact text')
            if review['state'] == 'blank' and review['label'] != '':
                raise ValueError('Blank truth must have an explicit empty label')
            if review['state'] == 'ambiguous' and review['label'] not in ('', None):
                raise ValueError('Ambiguous truth must have an empty or null label')
        for occurrence in item['occurrences']:
            key = (occurrence['source_id'], occurrence['region_id'])
            if key in truth:
                raise ValueError(f'Duplicate occurrence: {key}')
            actual = expected.get(key)
            if actual is None:
                raise ValueError(f'Occurrence absent from full source region inventory: {key}')
            if item['category'] != actual['category'] or item['pixel_sha256'] != actual['pixel_sha256']:
                raise ValueError(f'Visual truth source crop identity mismatch: {key}')
            if occurrence.get('sha256', sources[key[0]]['sha256']) != sources[key[0]]['sha256']:
                raise ValueError('Occurrence original source image mismatch')
            if occurrence.get('production_five_view_bgr_sha256', actual['input_fingerprint']) != actual['input_fingerprint']:
                raise ValueError('Occurrence five-view fingerprint mismatch')
            truth[key] = {'id': item['id'], 'category': item['category'], 'review': review}
    missing_occurrences = sorted(set(expected) - set(truth))
    if missing_occurrences and not partial:
        raise ValueError(f'Missing source region truth occurrences: {len(missing_occurrences)}')
    return truth, {'missing_item_ids': missing_items, 'missing_frame_source_ids': missing_frames,
                   'missing_occurrences': [list(key) for key in missing_occurrences]}


def score_records(captures, items, reviews, polls, expected, frame_reviews, *, partial=False, max_age=1., pixel_groups=None):
    """Pure scorer; expected supplies independently reconstructed crop identities."""
    truth, incompleteness = verify_truth(items, reviews, captures, expected, frame_reviews, partial)
    sources = unique_index(captures, 'source_id', 'source')
    chronological = sorted(captures, key=lambda row: row['captured_at_monotonic'])
    if captures != chronological or any(not isinstance(row['captured_at_monotonic'], (int, float)) or isinstance(row['captured_at_monotonic'], bool) or not math.isfinite(row['captured_at_monotonic']) for row in captures):
        raise ValueError('Capture manifest must preserve finite original capture order')
    if any(a['captured_at_monotonic'] >= b['captured_at_monotonic'] for a, b in zip(chronological, chronological[1:])):
        raise ValueError('Capture times must be unique and increasing')
    categories = defaultdict(Counter)
    distinct_categories = defaultdict(Counter)
    distinct_pixel_groups = defaultdict(Counter)
    pixel_groups = pixel_groups or {}
    observed_keys = set()
    frame_comparisons = Counter()
    eligibility_comparisons = []
    eligibility_keys = set()
    reviewed_frames = {row['source_id']: row for row in frame_reviews}
    polling = Counter()
    reasons = Counter()
    per_source = {sid: Counter() for sid in sources}
    first_processed, first_current = {}, {}
    observed_completions = set()
    sequence_sources = {f'{index + 1:020d}': row['source_id'] for index, row in enumerate(captures)}
    publication_keys = set()
    distinct_fields = set()
    failures = []
    observation_fields = []
    previous_poll_time = -math.inf
    for poll_index, poll in enumerate(polls):
        observed = poll['polled_at_monotonic']
        if not isinstance(observed, (float, int)) or not math.isfinite(observed) or observed < previous_poll_time:
            raise ValueError('Invalid or out-of-order observation time')
        previous_poll_time = observed
        result = poll['result']
        polling[result.get('state', 'missing_state')] += 1
        reasons[result.get('reason', 'unspecified')] += 1
        completed_source = sequence_sources.get(result.get('frame_id'))
        if completed_source is not None:
            observed_completions.add(completed_source)
            per_source[completed_source]['worker_completion_observations'] += 1
        if result.get('state') != 'available':
            continue
        value = result.get('value')
        if not isinstance(value, dict):
            failures.append({'poll_index': poll_index, 'reason': 'available_without_value'})
            continue
        processed_id = value.get('frame_id')
        current_id = value.get('validated_against_capture_id') or processed_id
        guard_errors = []
        if processed_id not in sources or current_id not in sources:
            guard_errors.append('unknown_source_identity')
        else:
            capture_time = sources[processed_id]['captured_at_monotonic']
            if value.get('captured_at') != capture_time or result.get('captured_at') != capture_time:
                guard_errors.append('original_capture_timestamp_mismatch')
            if observed < capture_time or observed - capture_time > max_age:
                guard_errors.append('stale_or_future_publication')
            if sources[current_id]['captured_at_monotonic'] > observed:
                guard_errors.append('current_capture_in_future')
            # Collector assigns one increasing worker sequence per submission
            # attempt. Capture-start occurs before grim completes, so treating
            # the newest started capture as already submitted is incorrect.
            if sequence_sources.get(result.get('frame_id')) != processed_id:
                guard_errors.append('processed_worker_sequence_mismatch')
            if sequence_sources.get(result.get('submitted_frame_id')) != current_id:
                guard_errors.append('publication_not_bound_to_current_submitted_capture')
            if sources[current_id]['captured_at_monotonic'] < capture_time:
                guard_errors.append('current_capture_precedes_processed_capture')
        if not value.get('accepted_frame'):
            guard_errors.append('available_frame_not_admitted')
        if guard_errors:
            failures.append({'poll_index': poll_index, 'processed_source_id': processed_id,
                             'current_source_id': current_id, 'reasons': guard_errors})
            continue
        first_processed.setdefault(processed_id, observed)
        first_current.setdefault(current_id, observed)
        per_source[processed_id]['observed_processed_publications'] += 1
        per_source[current_id]['observed_current_publications'] += 1
        admission = reviewed_frames.get(current_id, {}).get('frame_admission', 'missing')
        frame_comparisons['accepted_on_' + admission + '_truth'] += 1
        reviewed = reviewed_frames.get(current_id, {})
        reviewed_active = set(reviewed.get('active_seats', []))
        runtime_active = set(value.get('active_seats', []))
        eligibility_key = (current_id, tuple(sorted(runtime_active)))
        if admission == 'admit' and eligibility_key not in eligibility_keys:
            eligibility_keys.add(eligibility_key)
            eligibility_comparisons.append({'source_id': current_id, 'first_observed_poll_index': poll_index,
                'reviewed_eligible_seats': sorted(reviewed_active), 'runtime_active_seats': sorted(runtime_active),
                'falsely_admitted_seats': sorted(runtime_active - reviewed_active),
                'missed_eligible_seats': sorted(reviewed_active - runtime_active)})
        regions = value.get('regions', {})
        publication_keys.add((processed_id, current_id, json.dumps(regions, sort_keys=True)))
        expected_keys = {key for key in expected if key[0] == current_id}
        for key in sorted(expected_keys | {(current_id, rid) for rid in regions}):
            _, rid = key
            entry = regions.get(rid)
            target = truth.get(key)
            category = expected.get(key, {}).get('category', entry.get('category', 'unknown') if entry else 'unknown')
            counts = categories[category]
            counts['expected_region_observations'] += 1
            seat_match = re.search(r'seats\[(\d+)\]', rid)
            eligible = admission == 'admit' and (seat_match is None or category == 'bet' or int(seat_match.group(1)) in reviewed_active)
            counts['reviewed_policy_eligible_observations' if eligible else 'reviewed_policy_ineligible_observations'] += 1
            if entry is None:
                counts['absent_regions'] += 1
                counts['eligible_region_absent' if eligible else 'ineligible_region_absent'] += 1
                continue
            observed_keys.add(key)
            before_counts = counts.copy()
            counts['published_region_observations'] += 1
            counts['published_on_eligible_region' if eligible else 'published_on_ineligible_region'] += 1
            decision = entry.get('decision', {})
            state, text = decision.get('state'), decision.get('text')
            counts['decision_' + str(state)] += 1
            if category == 'name' and state == 'text' and text == 'Winner':
                counts['published_literal_winner_marker'] += 1
            region_errors = []
            actual = expected.get(key)
            if actual is None or entry.get('category') != category:
                region_errors.append('unknown_region_or_category_mismatch')
            # Revoked changed-current regions deliberately have no fingerprint.
            # They remain unknown abstentions and must never become blank truth.
            revoked = state == 'unknown' and decision.get('reason') == 'newer_capture_changed_region'
            if actual and not revoked and entry.get('input_fingerprint') != actual['input_fingerprint']:
                region_errors.append('current_pixels_fingerprint_mismatch')
            if revoked:
                counts['changed_current_abstentions'] += 1
            if region_errors:
                counts['identity_guard_failures'] += 1
                failures.append({'poll_index': poll_index, 'source_id': current_id, 'region_id': rid, 'reasons': region_errors})
            review = target.get('review') if target else None
            if review is None:
                counts['missing_truth'] += 1
            elif review['state'] == 'ambiguous':
                counts['ambiguous_truth'] += 1
                if state in ('text', 'blank'):
                    counts['accepted_on_ambiguous_truth'] += 1
            else:
                counts['scorable_truth_observations'] += 1
                counts['truth_' + review['state']] += 1
                correct = state == review['state'] and (state == 'blank' or text == review['label'])
                if state in ('text', 'blank'):
                    counts['accepted_exact' if correct and not region_errors else 'accepted_wrong'] += 1
                    if not correct or region_errors:
                        counts['accepted_wrong_on_eligible_region' if eligible else 'accepted_wrong_on_ineligible_region'] += 1
                    counts[review['state'] + '_truth_accepted_exact' if correct and not region_errors else review['state'] + '_truth_accepted_wrong'] += 1
                    if not correct:
                        error_kind = 'accepted_false_blank' if state == 'blank' else ('accepted_false_text_on_blank' if review['state'] == 'blank' else 'accepted_wrong_text')
                        counts[error_kind] += 1
                else:
                    counts['abstentions'] += 1
                # Retain every view's uncorrected decoder text separately from
                # temporal/spatial acceptance; no schema repair or normalization.
                raw_views = entry.get('views', value.get('game_id_spatial', {}).get('views', []) if rid == 'round_id' else [])
                if region_errors:
                    counts['raw_views_unscorable_identity'] += len(raw_views)
                    raw_views = []
                for view_index, view in enumerate(raw_views):
                    if 'error' in view:
                        counts['raw_view_errors'] += 1
                    elif isinstance(view.get('raw_prediction'), str):
                        counts['raw_view_total'] += 1
                        counts['raw_view_exact' if view['raw_prediction'] == review['label'] else 'raw_view_wrong'] += 1
                        if view_index == 0:
                            if review['state'] == 'text':
                                counts['raw_text_truth_center_total'] += 1
                                counts['raw_text_truth_center_exact' if view['raw_prediction'] == review['label'] else 'raw_text_truth_center_wrong'] += 1
                            counts['raw_center_total'] += 1
                            counts['raw_center_exact' if view['raw_prediction'] == review['label'] else 'raw_center_wrong'] += 1
            unique_field = (processed_id, current_id, rid, json.dumps(entry, sort_keys=True))
            if unique_field not in distinct_fields:
                for count_key, count in counts.items():
                    delta = count - before_counts[count_key]
                    if delta:
                        distinct_categories[category][count_key] += delta
                        distinct_pixel_groups[pixel_groups.get(target['id'] if target else None, 'unclassified')][count_key] += delta
                distinct_fields.add(unique_field)
            observation_fields.append({'poll_index': poll_index, 'processed_source_id': processed_id,
                                       'current_source_id': current_id, 'region_id': rid,
                                       'region_version_id': sha256(json.dumps(unique_field).encode()),
                                       'truth_id': target['id'] if target else None,
                                       'pixel_group': pixel_groups.get(target['id'] if target else None, 'unclassified'),
                                       'truth_state': review['state'] if review else 'missing',
                                       'truth_label': review['label'] if review else None,
                                       'semantic_role': review.get('semantic_role') if review else None,
                                       'reviewed_policy_eligible': eligible,
                                       'decision_state': state, 'decision_text': text,
                                       'identity_guard_errors': region_errors})
    accepted_errors = {}
    for observation in observation_fields:
        if observation['truth_state'] in ('text', 'blank') and observation['decision_state'] in ('text', 'blank'):
            if observation['truth_state'] != observation['decision_state'] or (observation['truth_state'] == 'text' and observation['truth_label'] != observation['decision_text']) or observation['identity_guard_errors']:
                accepted_errors.setdefault(observation['region_version_id'], observation)
    processed_latency = [(first_processed[sid] - sources[sid]['captured_at_monotonic']) * 1000 for sid in first_processed]
    current_latency = [(first_current[sid] - sources[sid]['captured_at_monotonic']) * 1000 for sid in first_current]
    for sid, count in per_source.items():
        count['original_captured_at_monotonic'] = sources[sid]['captured_at_monotonic']
        if sid in first_processed:
            count['first_observed_processed_publication_monotonic'] = first_processed[sid]
            count['capture_start_to_first_observed_publication_ms'] = (first_processed[sid] - sources[sid]['captured_at_monotonic']) * 1000
        if sid in first_current:
            count['first_observed_current_publication_monotonic'] = first_current[sid]
            count['current_capture_start_to_first_observed_publication_ms'] = (first_current[sid] - sources[sid]['captured_at_monotonic']) * 1000
    inventory_counts = defaultdict(Counter)
    for key, target in expected.items():
        count = inventory_counts[target['category']]
        count['captured_source_regions'] += 1
        review = truth.get(key, {}).get('review')
        count['truth_' + (review['state'] if review else 'missing')] += 1
        count['observed_published_source_regions' if key in observed_keys else 'without_observed_published_source_region'] += 1
    return {
        'scope': 'fresh_assistant_visual_single_session_evaluation', 'production_qualified': False,
        'limitations': ['Assistant visual truth is not human-verified truth.',
                       'One correlated table/session does not establish production generalization.',
                       'Polling is at approximately 0.1 seconds; observed latency includes polling granularity.',
                       'No new CUDA placement proof is inferred from provider registration or a frozen manifest.',
                       'No observed publication does not prove a frame was never processed.',
                       'All observation-weighted counts include repeated correlated polls.'],
        'semantic_name_identity': {'published_literal_winner_marker_observations': categories['name']['published_literal_winner_marker'],
                                   'published_literal_winner_marker_distinct_region_versions': distinct_categories['name']['published_literal_winner_marker'],
                                   'interpretation': 'Winner can be literal OCR text on a transient winner marker; it does not establish player identity.'},
        'partial_non_production_mode': partial, 'incompleteness': incompleteness,
        'polling_nominal_period_seconds': .1,
        'observed_poll_interval_ms': latency_summary([(b['polled_at_monotonic'] - a['polled_at_monotonic']) * 1000 for a, b in zip(polls, polls[1:])]),
        'polling_states': dict(polling), 'polling_reasons': dict(reasons),
        'maximum_reported_dropped_count': max((p['result'].get('dropped_count', 0) for p in polls), default=0),
        'capture_coverage': {'captured_sources': len(sources),
                             'sources_with_observed_worker_completion': len(observed_completions),
                             'sources_without_observed_worker_completion': sorted(set(sources) - observed_completions), 'observed_processed_sources': len(first_processed),
                             'observed_current_sources': len(first_current),
                             'sources_without_observed_processed_publication': sorted(set(sources) - set(first_processed)),
                             'sources_without_observed_current_publication': sorted(set(sources) - set(first_current))},
        'observed_capture_start_to_publication_latency': latency_summary(processed_latency),
        'observed_current_capture_start_to_publication_latency': latency_summary(current_latency),
        'distinct_publication_versions': len(publication_keys), 'distinct_region_versions': len(distinct_fields),
        'observation_weighted_categories': {k: dict(v) for k, v in sorted(categories.items())},
        'observation_weighted_overall': aggregate_metrics(categories),
        'distinct_region_version_overall': aggregate_metrics(distinct_categories),
        'distinct_region_version_rates_by_category': {k: metric_rates(v) for k, v in sorted(distinct_categories.items())},
        'distinct_region_version_by_pixel_group': {k: {'counts': dict(v), 'rates': metric_rates(v)} for k, v in sorted(distinct_pixel_groups.items())},
        'distinct_region_version_categories': {k: dict(v) for k, v in sorted(distinct_categories.items())},
        'source_region_coverage_by_category': {k: dict(v) for k, v in sorted(inventory_counts.items())},
        'source_regions_without_observed_publication': [list(key) for key in sorted(set(expected) - observed_keys)],
        'frame_admission_comparisons_observation_weighted': dict(frame_comparisons),
        'seat_eligibility_comparisons_distinct_source_versions': eligibility_comparisons,
        'seat_eligibility_summary': {'compared_source_versions': len(eligibility_comparisons),
             'source_versions_with_falsely_admitted_seats': sum(bool(row['falsely_admitted_seats']) for row in eligibility_comparisons),
             'source_versions_with_missed_eligible_seats': sum(bool(row['missed_eligible_seats']) for row in eligibility_comparisons),
             'interpretation': 'Eligibility is independently reviewed; literal target pixels remain text/blank/ambiguous regardless of admission.'},
        'frame_admission_review_counts': dict(Counter(r['frame_admission'] for r in frame_reviews)),
        'reviewed_nine_active_seat_frames': sum(r['frame_admission'] == 'admit' and len(r.get('active_seats', [])) == 9 for r in frame_reviews),
        'per_source': {sid: dict(count) for sid, count in per_source.items()},
        'accepted_errors_distinct_region_versions': list(accepted_errors.values()),
        'identity_guard_failures': failures, 'field_observations': observation_fields,
    }


def resolve_under(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('Evidence path escapes capture root')
    return path


def reconstruct_expected(root, captures, crop_index):
    """Read original BGR pixels and reproduce the pinned five-view digest only."""
    import cv2
    import numpy as np
    from schemas import category_for_region
    result = {}
    offsets = ((0, 0), (-2, 0), (2, 0), (0, -2), (0, 2))
    for capture in captures:
        source_path = resolve_under(root, capture['file'])
        raw = source_path.read_bytes()
        if sha256(raw) != capture['sha256']:
            raise ValueError('Original source file hash mismatch')
        frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if frame is None or (frame.shape[1], frame.shape[0]) != (capture['width'], capture['height']):
            raise ValueError('Original source dimensions mismatch')
        for row in crop_index:
            category = category_for_region(row['region_id'])
            if category is None:
                continue
            rect = row['rect']
            x, y, w, h = (rect[k] for k in ('x', 'y', 'w', 'h'))
            if any(type(rect[k]) is not int for k in ('x', 'y', 'w', 'h')) or w <= 0 or h <= 0:
                raise ValueError('Invalid original source crop geometry')
            fingerprint = hashlib.sha256(category.encode())
            for dx, dy in offsets:
                if min(x + dx, y + dy) < 0 or x + dx + w > frame.shape[1] or y + dy + h > frame.shape[0]:
                    raise ValueError('Original source crop view out of bounds')
                crop = frame[y+dy:y+dy+h, x+dx:x+dx+w].copy()
                fingerprint.update(str(crop.shape).encode())
                fingerprint.update(crop.tobytes())
            crop = frame[y:y+h, x:x+w].copy()
            result[(capture['source_id'], row['region_id'])] = {
                'category': category, 'pixel_sha256': sha256(crop[:, :, ::-1].tobytes()),
                'training_pixel_sha256': sha256(f'{w}x{h}:RGB:'.encode() + crop[:, :, ::-1].tobytes()),
                'input_fingerprint': fingerprint.hexdigest(), 'shape': list(crop.shape)}
    return result


def verify_seal(root, seal_path, required_paths, partial=False, dedicated_paths=None):
    """Verify agreed public truth seal before any private prediction is opened."""
    seal = read_json(seal_path)
    dedicated_paths = dedicated_paths or {}
    names = {'truth.jsonl': 'truth_sha256', 'frame-truth.jsonl': 'frame_truth_sha256',
             'manifest.json': 'manifest_sha256'}
    if not isinstance(seal.get('sealed_at_utc'), str) or not seal.get('scope'):
        raise ValueError('A dated visual truth seal with explicit scope is required')
    if partial and seal.get('partial_non_production') is not True:
        raise ValueError('Partial mode requires an explicitly partial non-production seal')
    # The pack inventory itself is hashed and all occurrences/crops are then
    # reconstructed from original capture bytes. The label/frame hashes prevent
    # post-prediction review edits from silently changing the scoring truth.
    for path in required_paths:
        actual = sha256(path.read_bytes())
        if path.resolve() in dedicated_paths:
            sealed = seal.get(dedicated_paths[path.resolve()])
        elif path.name in names:
            sealed = seal.get(names[path.name])
        else:
            relative = str(path.resolve().relative_to(root.resolve()))
            sealed = seal.get('public_sha256', {}).get(relative)
        if sealed != actual:
            raise ValueError('Unsealed or modified public evidence: ' + str(path))
    return seal


def pixel_overlap(items, expected, training_rows):
    """Compare dimension-prefixed RGB hashes without ever using label overlap."""
    known = defaultdict(set)
    for row in training_rows:
        key = row.get('pixel_sha256')
        split = row.get('split')
        if key:
            known[key].add(split or 'unknown_split')
            for alias in row.get('aliases', []):
                if alias.get('split'):
                    known[key].add(alias['split'])
            known[key].update(row.get('known_splits', []))
    groups = Counter()
    occurrences = Counter()
    by_category = defaultdict(Counter)
    details = []
    for item in items:
        first = item['occurrences'][0]
        identity = expected[(first['source_id'], first['region_id'])]['training_pixel_sha256']
        splits = known.get(identity, set())
        if 'train' in splits:
            bucket = 'seen_train'
        elif splits & {'val', 'validation', 'test'}:
            bucket = 'prior_val_test_only'
        elif splits:
            bucket = 'seen_unknown_split'
        else:
            bucket = 'entirely_new_pixels'
        groups[bucket] += 1
        occurrences[bucket] += len(item['occurrences'])
        by_category[item['category']][bucket] += 1
        details.append({'id': item['id'], 'category': item['category'], 'pixel_group': bucket,
                        'normalized_pixel_sha256': identity, 'prior_splits': sorted(splits)})
    return {'hash_convention': 'SHA256(widthxheight:RGB: followed by decoded RGB bytes)',
            'unique_review_groups': dict(groups), 'source_crop_occurrences': dict(occurrences),
            'unique_groups_by_category': {key: dict(value) for key, value in by_category.items()},
            'items': details,
            'interpretation': 'Capture time alone does not establish pixel independence. These fresh captures remain held out and must never be optimization data.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--items', type=Path, required=True, help='Review pack directory or combined item JSON/JSONL')
    parser.add_argument('--reviews', type=Path, required=True)
    parser.add_argument('--frame-reviews', type=Path, required=True)
    parser.add_argument('--truth-seal', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--training-manifest', type=Path, required=True)
    parser.add_argument('--non-production-partial', action='store_true')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output already exists; preserve prior report and choose a versioned new filename')
    root = args.root.resolve()
    public = [root / n for n in ('manifest.json', 'captures.jsonl', 'crop-index.json', 'regions.json')]
    if args.items.is_dir():
        from schemas import CONTRACT
        item_paths = [args.items / (category + '.jsonl') for category in CONTRACT['categories']]
        item_paths = [path for path in item_paths if path.is_file()]
    else:
        item_paths = [args.items]
    public += item_paths + [args.reviews, args.frame_reviews]
    if args.items.is_dir():
        public.append(args.items / 'inventory.json')
    seal = verify_seal(root, args.truth_seal, public, args.non_production_partial,
                       {args.reviews.resolve(): 'truth_sha256', args.frame_reviews.resolve(): 'frame_truth_sha256',
                        (root / 'manifest.json').resolve(): 'manifest_sha256'})
    metadata = read_json(root / 'manifest.json')
    if metadata['regions_sha256'] != sha256((root / 'regions.json').read_bytes()):
        raise ValueError('Source region config differs from capture runtime manifest')
    captures = read_jsonl(root / 'captures.jsonl')
    if len(captures) != metadata['requested_frames'] and not args.non_production_partial:
        raise ValueError('Incomplete requested capture run requires explicit non-production partial mode')
    def load_records(path):
        return read_jsonl(path) if path.suffix == '.jsonl' else rows(read_json(path))
    items = [item for path in item_paths for item in load_records(path)]
    reviews = load_records(args.reviews)
    frame_reviews = load_records(args.frame_reviews)
    expected = reconstruct_expected(root, captures, read_json(root / 'crop-index.json'))
    # Check exact review image identity as well as occurrence-to-source identity.
    import cv2
    for item in items:
        image = cv2.imread(str(resolve_under(args.items if args.items.is_dir() else args.items.parent, item['image_path'])), cv2.IMREAD_COLOR)
        if image is None or image.shape[1] != item['width'] or image.shape[0] != item['height'] or sha256(image[:, :, ::-1].tobytes()) != item['pixel_sha256']:
            raise ValueError('Review item image identity mismatch: ' + item['id'])
    verify_truth(items, reviews, captures, expected, frame_reviews, args.non_production_partial)
    predictions_path = root / 'private/predictions.jsonl'
    polls = read_jsonl(predictions_path)
    max_age = metadata['freeze']['policy']['maximum_result_age_seconds']
    overlap = pixel_overlap(items, expected, read_jsonl(args.training_manifest))
    pixel_groups = {item['id']: item['pixel_group'] for item in overlap['items']}
    report = score_records(captures, items, reviews, polls, expected, frame_reviews,
                           partial=args.non_production_partial, max_age=max_age, pixel_groups=pixel_groups)
    report['pixel_overlap'] = overlap
    from schemas import CONTRACT_PATH, CONTRACT_IMPLEMENTATION_PATH, CONTRACT_SHA256
    if metadata['freeze']['validation_contract']['sha256'] != CONTRACT_SHA256:
        raise ValueError('Scoring schema differs from frozen runtime schema')
    report['evidence_binding'] = {'public_sha256': {str(p.resolve().relative_to(root)): sha256(p.read_bytes()) for p in public},
                                  'truth_seal_sha256': sha256(args.truth_seal.read_bytes()),
                                  'predictions_sha256': sha256(predictions_path.read_bytes()),
                                  'training_manifest_sha256': sha256(args.training_manifest.read_bytes()),
                                  'source_sha256': {row['source_id']: row['sha256'] for row in captures},
                                  'runtime_manifest': metadata,
                                  'scorer_sha256': sha256(Path(__file__).read_bytes()),
                                  'schema_sha256': sha256(CONTRACT_PATH.read_bytes()),
                                  'schema_implementation_sha256': sha256(CONTRACT_IMPLEMENTATION_PATH.read_bytes()),
                                  'schema_adapter_sha256': sha256(Path(__file__).with_name('schemas.py').read_bytes()),
                                  'sealed_truth': seal}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as output:
        output.write(json.dumps(report, indent=2, allow_nan=False) + '\n')
    print(json.dumps({key: report[key] for key in ('capture_coverage', 'observed_capture_start_to_publication_latency', 'identity_guard_failures')}, indent=2))


if __name__ == '__main__':
    main()
