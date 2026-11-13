"""Synthetic JSON fixture tests only; never opens fresh private predictions."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from score_fresh_holdout import pixel_overlap, score_records, sha256, verify_seal


def fixture():
    captures = [{'source_id': 's0', 'sha256': 'source0', 'captured_at_monotonic': 10.},
                {'source_id': 's1', 'sha256': 'source1', 'captured_at_monotonic': 10.5}]
    expected = {('s0', 'r'): {'category': 'name', 'pixel_sha256': 'pixels0', 'input_fingerprint': 'view0', 'training_pixel_sha256': 'train0'},
                ('s1', 'r'): {'category': 'name', 'pixel_sha256': 'pixels1', 'input_fingerprint': 'view1', 'training_pixel_sha256': 'train1'}}
    items = [{'id': 'i0', 'category': 'name', 'pixel_sha256': 'pixels0', 'occurrences': [{'source_id': 's0', 'region_id': 'r'}]},
             {'id': 'i1', 'category': 'name', 'pixel_sha256': 'pixels1', 'occurrences': [{'source_id': 's1', 'region_id': 'r'}]}]
    reviews = [{'id': 'i0', 'label': 'Old', 'state': 'text', 'pixel_sha256': 'pixels0', 'visually_reviewed': True, 'reviewer': 'assistant_visual'},
               {'id': 'i1', 'label': 'New', 'state': 'text', 'pixel_sha256': 'pixels1', 'visually_reviewed': True, 'reviewer': 'assistant_visual'}]
    frame_reviews = [{'source_id': 's0', 'source_sha256': 'source0', 'frame_admission': 'admit', 'active_seats': list(range(9)), 'visually_reviewed': True, 'reviewer': 'assistant_visual'},
                     {'source_id': 's1', 'source_sha256': 'source1', 'frame_admission': 'admit', 'active_seats': list(range(9)), 'visually_reviewed': True, 'reviewer': 'assistant_visual'}]
    # JSON round trip documents the actual fixture interface and prevents relying
    # on Python-only values in captured/publication/truth records.
    captures, items, reviews, frame_reviews = json.loads(json.dumps([captures, items, reviews, frame_reviews]))
    return captures, items, reviews, expected, frame_reviews


def poll(text='Old', *, processed='s0', current=None, observed=10.2, fingerprint='view0', state='text', reason='confirmed', views=None):
    index = int(processed[1:])
    current = current or processed
    value = {'frame_id': processed, 'captured_at': 10. + index * .5, 'accepted_frame': True,
             'regions': {'r': {'category': 'name', 'input_fingerprint': fingerprint,
                               'decision': {'state': state, 'text': text, 'reason': reason},
                               'views': views if views is not None else [{'raw_prediction': text}]}}}
    if current != processed:
        value['validated_against_capture_id'] = current
    return json.loads(json.dumps({'polled_at_monotonic': observed,
                'result': {'state': 'available', 'reason': 'processed', 'captured_at': value['captured_at'],
                           'frame_id': f'{index + 1:020d}', 'submitted_frame_id': f'{int(current[1:]) + 1:020d}',
                           'dropped_count': 0, 'value': value}}))


def score(polls, mutate=None, partial=False):
    captures, items, reviews, expected, frame_reviews = fixture()
    if mutate:
        mutate(captures, items, reviews, expected, frame_reviews)
    return score_records(captures, items, reviews, polls, expected, frame_reviews, partial=partial)


class ScorerTest(unittest.TestCase):
    def test_exact_raw_and_accepted_and_original_latency(self):
        report = score([poll(), poll(observed=10.3)])
        category = report['observation_weighted_categories']['name']
        self.assertEqual(category['accepted_exact'], 2)
        self.assertEqual(category['raw_center_exact'], 2)
        self.assertEqual(report['distinct_publication_versions'], 1)
        self.assertEqual(report['distinct_region_versions'], 1)
        self.assertAlmostEqual(report['observed_capture_start_to_publication_latency']['p50_ms'], 200.)
        self.assertEqual(report['capture_coverage']['sources_without_observed_processed_publication'], ['s1'])
        self.assertFalse(report['production_qualified'])

    def test_current_truth_is_used_instead_of_processed_truth(self):
        report = score([poll(current='s1', observed=10.7, fingerprint='view1')])
        category = report['observation_weighted_categories']['name']
        self.assertEqual(category['accepted_wrong'], 1)
        self.assertEqual(category['raw_center_wrong'], 1)
        self.assertEqual(report['field_observations'][0]['truth_id'], 'i1')
        self.assertAlmostEqual(report['observed_capture_start_to_publication_latency']['max_ms'], 700.)
        self.assertAlmostEqual(report['observed_current_capture_start_to_publication_latency']['max_ms'], 200.)

    def test_unknown_changed_current_is_abstention_never_blank(self):
        observation = poll(None, current='s1', observed=10.7, fingerprint=None, state='unknown', reason='newer_capture_changed_region', views=[])
        report = score([observation])
        category = report['observation_weighted_categories']['name']
        self.assertEqual(category['abstentions'], 1)
        self.assertEqual(category['changed_current_abstentions'], 1)
        self.assertNotIn('decision_blank', category)
        self.assertEqual(report['identity_guard_failures'], [])

    def test_blank_and_ambiguous_are_distinct_from_unknown(self):
        def blank_truth(c, i, r, e, f):
            r[0].update(label='', state='blank')
            r[1].update(label=None, state='ambiguous')
        report = score([poll('', state='blank'), poll('wrong', processed='s1', observed=10.7, fingerprint='view1')], blank_truth)
        category = report['observation_weighted_categories']['name']
        self.assertEqual(category['accepted_exact'], 1)
        self.assertEqual(category['ambiguous_truth'], 1)
        self.assertEqual(category['accepted_on_ambiguous_truth'], 1)
        self.assertEqual(category['scorable_truth_observations'], 1)

    def test_region_missing_is_explicit_and_not_an_automatic_blank(self):
        observation = poll()
        observation['result']['value']['regions'] = {}
        report = score([observation])
        self.assertEqual(report['observation_weighted_categories']['name']['absent_regions'], 1)
        self.assertNotIn('accepted_exact', report['observation_weighted_categories']['name'])

    def test_raw_decoder_wrong_is_reported_when_decision_correct(self):
        report = score([poll(views=[{'raw_prediction': '0ld'}, {'raw_prediction': 'Old'}, {'error': 'runtime'}])])
        category = report['observation_weighted_categories']['name']
        self.assertEqual(category['accepted_exact'], 1)
        self.assertEqual(category['raw_center_wrong'], 1)
        self.assertEqual(category['raw_view_exact'], 1)
        self.assertEqual(category['raw_view_errors'], 1)

    def test_current_pixel_fingerprint_failure_cannot_count_correct(self):
        report = score([poll(fingerprint='different')])
        category = report['observation_weighted_categories']['name']
        self.assertEqual(category['identity_guard_failures'], 1)
        self.assertEqual(category['accepted_wrong'], 1)
        self.assertNotIn('accepted_exact', category)

    def test_timestamp_and_worker_identity_guards(self):
        for mutation, reason in [
                (lambda p: p['result']['value'].update(captured_at=10.1), 'original_capture_timestamp_mismatch'),
                (lambda p: p.update(polled_at_monotonic=11.2), 'stale_or_future_publication'),
                (lambda p: p['result'].update(submitted_frame_id='00000000000000000002'), 'publication_not_bound_to_current_submitted_capture'),
                (lambda p: p['result'].update(frame_id='00000000000000000002'), 'processed_worker_sequence_mismatch')]:
            with self.subTest(reason=reason):
                observation = poll()
                mutation(observation)
                report = score([observation])
                self.assertIn(reason, report['identity_guard_failures'][0]['reasons'])
                self.assertEqual(report['capture_coverage']['observed_processed_sources'], 0)

    def test_capture_start_during_grim_is_not_a_submission(self):
        # s1 started capture at 10.5 but the worker still has only submitted s0.
        report = score([poll(observed=10.55)])
        self.assertEqual(report['identity_guard_failures'], [])

    def test_duplicate_missing_unreviewed_or_wrong_pixel_truth_rejected(self):
        cases = [lambda c, i, r, e, f: r.append(copy.deepcopy(r[0])),
                 lambda c, i, r, e, f: r.pop(),
                 lambda c, i, r, e, f: r[0].update(visually_reviewed=False),
                 lambda c, i, r, e, f: r[0].update(pixel_sha256='different'),
                 lambda c, i, r, e, f: i[0].update(pixel_sha256='different'),
                 lambda c, i, r, e, f: i[0]['occurrences'].append(copy.deepcopy(i[0]['occurrences'][0])),
                 lambda c, i, r, e, f: f.pop(),
                 lambda c, i, r, e, f: f[0].update(source_sha256='different')]
        for mutate in cases:
            with self.subTest(mutation=cases.index(mutate)), self.assertRaises(ValueError):
                score([], mutate)

    def test_partial_missing_truth_is_named(self):
        report = score([poll(processed='s1', observed=10.7, fingerprint='view1')], lambda c, i, r, e, f: r.pop(), partial=True)
        self.assertEqual(report['incompleteness']['missing_item_ids'], ['i1'])
        self.assertEqual(report['observation_weighted_categories']['name']['missing_truth'], 1)

    def test_unknown_drop_and_error_reasons_are_preserved(self):
        records = [{'polled_at_monotonic': 10.2, 'result': {'state': 'unknown', 'reason': 'processing_error', 'dropped_count': 2}},
                   {'polled_at_monotonic': 10.3, 'result': {'state': 'unknown', 'reason': 'expired_after_processing', 'dropped_count': 3}}]
        report = score(records)
        self.assertEqual(report['polling_reasons'], {'processing_error': 1, 'expired_after_processing': 1})
        self.assertEqual(report['maximum_reported_dropped_count'], 3)

    def test_pixel_overlap_uses_pixels_and_prior_splits(self):
        _, items, _, expected, _ = fixture()
        rows = [{'pixel_sha256': 'train0', 'split': 'val', 'label': 'Different text', 'aliases': [{'split': 'train'}]},
                {'pixel_sha256': 'train1', 'split': 'test'}]
        report = pixel_overlap(items, expected, rows)
        self.assertEqual(report['unique_review_groups'], {'seen_train': 1, 'prior_val_test_only': 1})
        report = pixel_overlap(items, expected, [])
        self.assertEqual(report['unique_review_groups'], {'entirely_new_pixels': 2})

    def test_ineligible_visible_card_remains_text_truth_and_false_blank(self):
        captures, items, reviews, expected, frames = fixture()
        for item in items:
            item['category'] = 'card'
            item['occurrences'][0]['region_id'] = 'seats[1].cards[0]'
        expected = {(sid, 'seats[1].cards[0]'): dict(value, category='card') for (sid, _), value in expected.items()}
        for frame in frames:
            frame['active_seats'] = [0, 2]
        observation = poll('', state='blank')
        value = observation['result']['value']
        value['active_seats'] = [0, 1]
        value['regions']['seats[1].cards[0]'] = value['regions'].pop('r')
        value['regions']['seats[1].cards[0]']['category'] = 'card'
        report = score_records(captures, items, reviews, [observation], expected, frames)
        category = report['distinct_region_version_categories']['card']
        self.assertEqual(category['accepted_false_blank'], 1)
        self.assertEqual(category['accepted_wrong_on_ineligible_region'], 1)
        self.assertEqual(report['field_observations'][0]['truth_state'], 'text')
        self.assertFalse(report['field_observations'][0]['reviewed_policy_eligible'])
        self.assertEqual(report['seat_eligibility_comparisons_distinct_source_versions'][0]['falsely_admitted_seats'], [1])
        self.assertEqual(report['seat_eligibility_comparisons_distinct_source_versions'][0]['missed_eligible_seats'], [2])

    def test_winner_literal_ocr_does_not_establish_player_identity(self):
        report = score([poll('Winner')], lambda c, i, r, e, f: r[0].update(label='Winner', semantic_role='transient_winner_marker'))
        self.assertEqual(report['distinct_region_version_categories']['name']['accepted_exact'], 1)
        self.assertEqual(report['semantic_name_identity']['published_literal_winner_marker_distinct_region_versions'], 1)
        self.assertEqual(report['field_observations'][0]['semantic_role'], 'transient_winner_marker')

    def test_distinct_metrics_remove_repeated_polls_and_stratify_pixels(self):
        captures, items, reviews, expected, frames = fixture()
        report = score_records(captures, items, reviews, [poll(), poll(observed=10.3)], expected, frames,
                               pixel_groups={'i0': 'seen_train', 'i1': 'entirely_new_pixels'})
        self.assertEqual(report['observation_weighted_overall']['counts']['accepted_exact'], 2)
        self.assertEqual(report['distinct_region_version_overall']['counts']['accepted_exact'], 1)
        self.assertEqual(report['distinct_region_version_by_pixel_group']['seen_train']['counts']['accepted_exact'], 1)
        self.assertEqual(report['source_region_coverage_by_category']['name']['captured_source_regions'], 2)
        self.assertEqual(report['source_region_coverage_by_category']['name']['without_observed_published_source_region'], 1)

    def test_unknown_stale_completion_is_not_an_available_publication(self):
        record = {'polled_at_monotonic': 11.2, 'result': {'state': 'unknown', 'reason': 'stale',
                  'frame_id': '00000000000000000001', 'captured_at': 10., 'dropped_count': 0}}
        report = score([record])
        self.assertEqual(report['capture_coverage']['sources_with_observed_worker_completion'], 1)
        self.assertEqual(report['capture_coverage']['observed_processed_sources'], 0)

    def test_public_capture_timestamps_must_be_in_seal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = root / 'captures.jsonl'
            capture.write_text('{' + '"captured_at_monotonic":10' + '}\n')
            seal_path = root / 'seal.json'
            seal = {'sealed_at_utc': '2026-11-09T00:00:00Z', 'scope': 'assistant visual single session',
                    'public_sha256': {'captures.jsonl': sha256(capture.read_bytes())}}
            seal_path.write_text(json.dumps(seal))
            verify_seal(root, seal_path, [capture])
            capture.write_text('{' + '"captured_at_monotonic":11' + '}\n')
            with self.assertRaisesRegex(ValueError, 'modified'):
                verify_seal(root, seal_path, [capture])

    def test_seal_hashes_are_checked_before_predictions_can_be_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = [root / name for name in ('manifest.json', 'truth.jsonl', 'frame-truth.jsonl')]
            for path in paths:
                path.write_text('{}\n')
            seal = {'sealed_at_utc': '2026-11-09T00:00:00Z', 'scope': 'assistant visual single session',
                    'manifest_sha256': sha256(paths[0].read_bytes()), 'truth_sha256': sha256(paths[1].read_bytes()),
                    'frame_truth_sha256': sha256(paths[2].read_bytes())}
            seal_path = root / 'seal.json'
            seal_path.write_text(json.dumps(seal))
            self.assertEqual(verify_seal(root, seal_path, paths), seal)
            paths[1].write_text('{"modified":true}\n')
            with self.assertRaisesRegex(ValueError, 'modified'):
                verify_seal(root, seal_path, paths)


if __name__ == '__main__':
    unittest.main()
