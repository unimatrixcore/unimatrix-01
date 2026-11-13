#!/usr/bin/env python3
"""Export named OCR datasets read-only without losing durable in-progress reviews.

This produces candidate data and provenance, never a split or training approval.
No collector startup, database migration, model inference, or relabeling occurs.
"""
import argparse
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import sqlite3
import sys

from PIL import Image

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
from lib.datasets import DatasetRegistry, safe_filename
from lib.ocr_contract import CONTRACT, CONTRACT_SHA256, category_for_region, validate_text


def discover_datasets(tool_dir=TOOLS):
    """Read the existing registry; never call its mutating list/resolve methods."""
    registry = DatasetRegistry(Path(tool_dir))
    rows = json.loads(registry.path.read_text()) if registry.path.is_file() else [
        {'id': 'legacy', 'name': 'Legacy corpus', 'archived': False}]
    datasets = []
    for row in rows:
        dataset_id = row['id']
        if not re.fullmatch(r'legacy|[a-f0-9]{32}', dataset_id):
            raise ValueError('Registry contains an invalid dataset identity')
        directory = registry.legacy if dataset_id == 'legacy' else registry.root / dataset_id
        if (directory / 'data.db').is_file():
            datasets.append(dict(row, directory=directory.resolve()))
    return datasets


@contextmanager
def readonly_database(path):
    """Avoid even creating a legacy WAL/SHM sidecar when there is no WAL."""
    path = Path(path).resolve()
    wal = Path(str(path) + '-wal')
    immutable = not wal.exists()
    before = path.stat()
    connection = sqlite3.connect(path.as_uri() + '?mode=ro' + ('&immutable=1' if immutable else ''), uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    connection.execute('BEGIN')
    try:
        yield connection
    finally:
        connection.rollback()
        connection.close()
        after = path.stat()
        if immutable and ((before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or wal.exists()):
            raise RuntimeError(f'Source changed during its immutable read; retry export: {path}')


def _rows(connection, table):
    return [dict(row) for row in connection.execute(f'SELECT * FROM {table}')]


def _sample_key(item, source=''):
    return item.get('sample_key') or item.get('filename') or (
        f"{item.get('id')}:{item.get('phash', '')}:{item.get('source') or source or item.get('game_id', '')}")


def _session_index(session_rows, inbox_rows):
    """Pool and frame copies describe one identity, not extra labeled samples."""
    index = {}
    sessions = []
    for row in session_rows:
        value = json.loads(row['data'])
        if isinstance(value, dict):
            sessions.append(value)
    frames = [json.loads(row['payload']) for row in inbox_rows]
    frames += [frame for session in sessions for frame in session.get('frames', [])]
    for frame in frames:
        for item in frame.get('regions', []):
            key = _sample_key(item, frame.get('source', ''))
            index[key] = {'source_capture_filename': item.get('source') or frame.get('source'),
                          'game_id': item.get('game_id') or frame.get('game_id'),
                          'rect': item.get('rect'), 'session_id': item.get('session_id') or frame.get('session_id'),
                          'filename': item.get('filename'),
                          'split':item.get('split') or item.get('partition') or frame.get('split') or frame.get('partition')}
    for session in sessions:
        for item in session.get('pool', []):
            key = _sample_key(item)
            prior = index.get(key, {})
            index[key] = dict(prior, **{name: value for name, value in {
                'source_capture_filename': item.get('source'), 'game_id': item.get('game_id'),
                'rect': item.get('rect'), 'session_id': item.get('session_id'),
                'filename': item.get('filename'), 'split':item.get('split') or item.get('partition')}.items() if value is not None})
    return index


def _queue_provenance_index(rows):
    """Durable queue metadata survives bounded checkpoints and removed pages."""
    result = {}
    for row in rows:
        payload = json.loads(row.get('payload') or '{}')
        result[row['sample_key']] = {
            'source_capture_filename': row.get('source'), 'game_id': row.get('game_id'),
            'rect': payload.get('rect'), 'session_id': payload.get('session_id'),
            'filename': payload.get('filename'), 'queue_id': row.get('queue_id'),
            'frame_id': row.get('frame_id'), 'created_at': row.get('created_at'),
            'split': payload.get('split') or payload.get('partition'),
        }
    return result


def _decode_png(raw):
    if not isinstance(raw, bytes) or not raw.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('Crop is not a PNG')
    with Image.open(BytesIO(raw)) as image:
        if image.width * image.height > 16_000_000:
            raise ValueError('Crop exceeds pixel limit')
        image.load()
        rgb = image.convert('RGB')
        pixel_hash = hashlib.sha256(f'{rgb.width}x{rgb.height}:RGB:'.encode() + rgb.tobytes()).hexdigest()
        return hashlib.sha256(raw).hexdigest(), pixel_hash, [rgb.width, rgb.height]


def _event_provenance(event):
    return {key: event.get(key) for key in ('id', 'created_at', 'action', 'prior_label', 'label',
        'prediction_id', 'contract_version', 'contract_sha256', 'schema_valid', 'outside_contract')}


def _capture_provenance(image, key, session, captures, dataset_id):
    source_id = image.get('source_id') if image else None
    capture = captures.get(source_id, {})
    cached = session.get(key) or next((item for item in session.values() if item.get('filename') == key), {})
    filename = capture.get('filename') or cached.get('source_capture_filename')
    if filename and not capture:
        capture = next((item for item in captures.values() if item.get('filename') == filename), {})
        source_id = capture.get('id')
    rect = cached.get('rect')
    if image and all(image.get(field) is not None for field in ('x', 'y', 'w', 'h')):
        rect = {field: image[field] for field in ('x', 'y', 'w', 'h')}
    return {'source_id': source_id, 'source_capture_filename': filename,
            'source_capture_timestamp': capture.get('timestamp'), 'source_monitor': capture.get('monitor'),
            'source_regions_hash': capture.get('regions_hash'), 'crop_rect': rect,
            'game_id': cached.get('game_id'), 'session_id': cached.get('session_id'),
            'capture_group': f'{dataset_id}:capture:{filename}' if filename else None,
            'split': (image or {}).get('split') or (image or {}).get('partition') or capture.get('split') or capture.get('partition') or cached.get('split'),
            'split_eligibility': 'capture_group_known_session_unverified' if filename else 'unknown_source_train_only_candidate'}


def _timestamp(value):
    """Normalize recorded timestamps without inventing a date for unknown rows."""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return int(value * 1000 if value < 100_000_000_000 else value)
    return None


def _current_ai_check(row, ai_items, jobs, events_by_key):
    """Only a current-pixel, current-label result can establish AI evidence."""
    candidates = []
    aliases = set(row['sample_key_aliases'])
    for item in ai_items:
        if item['sample_key'] not in aliases or item['region_id'] != row['region_id']:
            continue
        if item['pixel_sha256'] != row.get('pixel_sha256'):
            continue
        job = jobs.get(item['job_id'])
        if not job or job.get('dataset_id') != row['dataset_id']:
            continue
        latest = max((event['id'] for event in events_by_key[item['sample_key']]), default=0)
        result = json.loads(item['result']) if item.get('result') else None
        expected_event = result.get('event_id') if result and item['state'] == 'corrected' else item['prior_event_id']
        expected_label = result.get('label') if result else item['prior_label']
        if expected_event != latest or expected_label != row['label']:
            continue
        if result and (result.get('sample_key') != item['sample_key'] or
                       result.get('pixel_sha256') != row.get('pixel_sha256')):
            continue
        candidates.append((job.get('created_at') or 0, job['id'], item, job, result))
    if not candidates:
        return None
    _, _, item, job, result = max(candidates, key=lambda part: part[:2])
    expected_event = result.get('event_id') if result and item['state'] == 'corrected' else item['prior_event_id']
    state = item['state']
    accepted = False
    if result and result.get('state') == state and state in ('unchanged', 'corrected'):
        first = result.get('first_reading') or {}
        clarity = 'blank' if row['label'] == '' else 'clear'
        accepted = first.get('text') == row['label'] and first.get('clarity') == clarity
        if state == 'corrected':
            second = result.get('verification') or {}
            accepted = accepted and second.get('text') == row['label'] and second.get('clarity') == clarity
    return {'job_id': job['id'], 'run_id': job['run_id'], 'job_state': job['state'],
            'job_created_at': job['created_at'], 'model': job['model'], 'state': state,
            'successful_current_check': bool(accepted), 'visually_verified': False,
            'result': result, 'source_event_id': expected_event if candidates else None}


def export_dataset(dataset, output):
    dataset_id = dataset['id']
    if not re.fullmatch(r'legacy|[a-f0-9]{32}', dataset_id):
        raise ValueError('Invalid dataset identity')
    directory = Path(dataset['directory']).resolve()
    with readonly_database(directory / 'data.db') as connection:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        images = _rows(connection, 'images') if 'images' in tables else []
        reviews = _rows(connection, 'review_samples') if 'review_samples' in tables else []
        events = _rows(connection, 'label_review_events') if 'label_review_events' in tables else []
        predictions = _rows(connection, 'model_predictions') if 'model_predictions' in tables else []
        captures = {row['id']: row for row in _rows(connection, 'full_captures')} if 'full_captures' in tables else {}
        session = _session_index(_rows(connection, 'session_progress') if 'session_progress' in tables else [],
                                 _rows(connection, 'watch_inbox') if 'watch_inbox' in tables else [])
        queue_columns = {row['name'] for row in connection.execute('PRAGMA table_info(queue_items)')} if 'queue_items' in tables else set()
        metadata_fields = ('queue_id','sample_key','frame_id','source','game_id','payload','active',
                           'region_id','created_at','reviewed','discarded','label','prediction_id','pixel_sha256')
        queue_rows = ([dict(row) for row in connection.execute('SELECT '+','.join(field for field in metadata_fields if field in queue_columns)+' FROM queue_items')]
                      if queue_columns else [])
        queued_crops = ({row['sample_key']: row['crop'] for row in connection.execute(
            'SELECT sample_key,crop FROM queue_items WHERE active=1 AND reviewed=1 AND discarded=0')}
            if {'crop','reviewed','discarded'} <= queue_columns else {})
        ai_items = _rows(connection, 'ai_review_items') if 'ai_review_items' in tables else []
        ai_jobs = {row['id']:row for row in _rows(connection, 'ai_review_jobs')} if 'ai_review_jobs' in tables else {}
        capture_index = dict(session)
        if queue_rows:
            # Normalized rows own queue membership; old snapshots are rollback
            # evidence, not permission to resurrect discarded queued records.
            capture_index.update(_queue_provenance_index(queue_rows))
            session = _queue_provenance_index([row for row in queue_rows if row.get('active')])
    events_by_key = defaultdict(list)
    for event in events:
        if event.get('dataset_id') == dataset_id:
            events_by_key[event['sample_key']].append(event)
    predictions_by_key = defaultdict(list)
    for row in predictions:
        if row.get('dataset_id') == dataset_id:
            predictions_by_key[row['sample_key']].append(row)
    images_by_filename = {row['filename']: row for row in images}
    queue_by_key = {row['sample_key']:row for row in queue_rows}
    decoded_images = {}
    issues = []
    for image in images:
        try:
            path = directory / 'images' / safe_filename(image['filename'])
            before = path.stat()
            raw = path.read_bytes()
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError('PNG changed while being read')
            decoded_images[image['filename']] = (raw, _decode_png(raw))
        except (OSError, ValueError) as exc:
            issues.append({'kind': 'saved_crop_unavailable', 'filename': image['filename'], 'error': str(exc)})
    reviewed = []
    excluded = []
    for review in reviews:
        matching = sorted((event for event in events_by_key[review['sample_key']]
                           if event.get('pixel_sha256') == review['pixel_sha256']
                           and event.get('action') in ('accepted', 'corrected', 'manual')),
                          key=lambda event: event['id'])
        if not matching:
            excluded.append({'dataset_id': dataset_id, 'sample_key': review['sample_key'],
                             'reason': 'no_durable_review_for_current_pixels', 'region_id': review['region_id']})
            continue
        event = matching[-1]
        if event['label'] != review['label']:
            excluded.append({'dataset_id': dataset_id, 'sample_key': review['sample_key'],
                             'reason': 'current_label_disagrees_with_latest_review', 'region_id': review['region_id'],
                             'event_id': event['id']})
            continue
        reviewed.append((review, event, matching))
    # Two sample keys can refer to the same saved image. Latest durable event wins,
    # while all alias keys/events remain in exported provenance.
    groups = defaultdict(list)
    for review, event, matching in reviewed:
        filename = review.get('filename')
        saved = decoded_images.get(filename)
        try:
            actual_image_hash, actual_pixel_hash, _ = _decode_png(review['crop'])
            review_pixels_intact = (actual_pixel_hash == review['pixel_sha256']
                                   and actual_image_hash == review['image_sha256'])
        except (OSError, ValueError):
            review_pixels_intact = False
        overlaps = (filename in images_by_filename and saved
                    and review_pixels_intact
                    and images_by_filename[filename]['region_id'] == review['region_id']
                    and saved[1][1] == review['pixel_sha256'])
        identity = ('saved', filename) if overlaps else ('review', review['sample_key'])
        groups[identity].append((review, event, matching))
    merged_filenames = {identity[1] for identity in groups if identity[0] == 'saved'}
    output_rows = []
    png_count = 0
    for identity, group in sorted(groups.items()):
        review, event, matching = max(group, key=lambda part: part[1]['id'])
        image = images_by_filename.get(review.get('filename')) if identity[0] == 'saved' else None
        aliases = sorted({part[0]['sample_key'] for part in group})
        history = sorted({item['id']: item for part in group for item in part[2]}.values(), key=lambda item: item['id'])
        row = {'dataset_id': dataset_id, 'dataset_name': dataset.get('name'),
               'sample_key': review['sample_key'], 'sample_key_aliases': aliases,
               'region_id': review['region_id'], 'label': event['label'],
               'label_evidence': 'durable_human_review_event', 'reviewed': True,
               'visually_verified': None, 'review_event': _event_provenance(event),
               'review_history': [_event_provenance(item) for item in history],
               'source_saved_image_id': image.get('id') if image else None,
               'source_saved_filename': image.get('filename') if image else review.get('filename'),
               'expected_pixel_sha256': review['pixel_sha256'], 'expected_image_sha256': review['image_sha256']}
        matching_predictions = sorted((prediction for alias in aliases for prediction in predictions_by_key[alias]
            if prediction['region_id'] == review['region_id'] and prediction['pixel_sha256'] == review['pixel_sha256']),
            key=lambda prediction: (prediction['created_at'], prediction['id']))
        row['predictions'] = [dict(json.loads(item['payload']), id=item['id'], created_at=item['created_at'],
                                   sample_key=item['sample_key']) for item in matching_predictions]
        row['review_prediction'] = next((item for item in row['predictions'] if item['id'] == event.get('prediction_id')), None)
        if (row['review_prediction'] or {}).get('review_provider') == 'openai':
            row['label_evidence'] = 'durable_ai_review_event'
            row['visually_verified'] = False
        if event.get('prediction_id') and row['review_prediction'] is None:
            row['prediction_provenance_warning'] = 'referenced_prediction_missing_or_not_current_pixels'
        row['provenance'] = _capture_provenance(image, review['sample_key'], capture_index, captures, dataset_id)
        row['observation_timestamp'] = next((stamp for value in (
            row['provenance']['source_capture_timestamp'], queue_by_key.get(review['sample_key'],{}).get('created_at'),
            image.get('timestamp') if image else None) if (stamp:=_timestamp(value)) is not None), None)
        raw = review['crop']
        output_rows.append((row, raw))
    for image in sorted(images, key=lambda item: item['id']):
        if image['filename'] in merged_filenames:
            continue
        row = {'dataset_id': dataset_id, 'dataset_name': dataset.get('name'),
               'sample_key': image['filename'], 'sample_key_aliases': [image['filename']],
               'region_id': image['region_id'], 'label': image['label'],
               'label_evidence': 'unverified_collector_label' if image['label'] else 'unverified_empty_or_missing_label',
               'reviewed': False, 'visually_verified': None, 'review_event': None, 'review_history': [],
               'source_saved_image_id': image['id'], 'source_saved_filename': image['filename'],
               'predictions': [], 'review_prediction': None,
               'provenance': _capture_provenance(image, image['filename'], capture_index, captures, dataset_id)}
        row['observation_timestamp'] = _timestamp(row['provenance']['source_capture_timestamp']) or _timestamp(image.get('timestamp'))
        output_rows.append((row, decoded_images.get(image['filename'], (None, None))[0]))
    represented = {alias for row,_ in output_rows for alias in row['sample_key_aliases']}
    for queued in queue_rows:
        key = queued['sample_key']
        if key in represented or key not in queued_crops:
            continue
        row = {'dataset_id':dataset_id,'dataset_name':dataset.get('name'),'sample_key':key,'sample_key_aliases':[key],
               'region_id':queued['region_id'],'label':queued['label'],'label_evidence':'unverified_collector_queue_label',
               'reviewed':False,'collector_reviewed_flag':bool(queued.get('reviewed')),'visually_verified':None,
               'review_event':None,'review_history':[],'source_saved_image_id':None,'source_saved_filename':None,
               'predictions':[],'review_prediction':None,'expected_pixel_sha256':queued.get('pixel_sha256'),
               'provenance':_capture_provenance(None,key,capture_index,captures,dataset_id)}
        row['observation_timestamp'] = _timestamp(row['provenance']['source_capture_timestamp']) or _timestamp(queued.get('created_at'))
        output_rows.append((row,queued_crops[key]))
    for row, raw in output_rows:
        row['dataset_archived'] = bool(dataset.get('archived'))
        queued = queue_by_key.get(row['sample_key'])
        row['queue_active'] = bool(queued.get('active')) if queued else None
        row['queue_id'] = queued.get('queue_id') if queued else None
        row['queue_discarded'] = bool(queued.get('discarded')) if queued else False
        row['removed_unsaved_queue_observation'] = bool(queued and not queued.get('active') and row.get('source_saved_image_id') is None)
        row['queue_prediction_id']=queued.get('prediction_id') if queued else None
        if queued and not row['predictions']:
            row['predictions']=[dict(json.loads(prediction['payload']),id=prediction['id'],created_at=prediction['created_at'],
                                    sample_key=prediction['sample_key']) for prediction in predictions_by_key[row['sample_key']]
                                if prediction['region_id']==row['region_id'] and prediction['pixel_sha256']==queued.get('pixel_sha256')]
        if queued and queued.get('active') and 'label' in queued and queued['label'] != row['label']:
            row['superseded_review_label'] = row['label']
            row['label'] = queued['label']; row['reviewed'] = False
            row['label_evidence'] = 'unverified_current_queue_label'
        if queued and queued.get('active') and queued.get('pixel_sha256') and row.get('expected_pixel_sha256') != queued['pixel_sha256']:
            row['reviewed']=False;row['label_evidence']='unverified_current_queue_pixels'
            row['expected_pixel_sha256']=queued['pixel_sha256'];row.pop('expected_image_sha256',None)
            raw=queued_crops.get(row['sample_key'],raw)
        if row['review_event'] and row['review_event']['action']=='accepted' and row.get('prediction_provenance_warning'):
            row['reviewed']=False;row['label_evidence']='unresolved_review_actor'
        row['category'] = category_for_region(row['region_id'])
        row['validation_contract'] = {'version': CONTRACT['version'], 'sha256': CONTRACT_SHA256}
        row['storage_schema_valid'] = validate_text(row['category'], row['label'], allow_blank=True)
        row['completed_schema_valid'] = validate_text(row['category'], row['label'])
        row['is_reviewed_negative'] = row['reviewed'] and row['label'] == '' and row['category'] is not None
        row['automatic_schema_valid'] = row['completed_schema_valid'] or row['is_reviewed_negative']
        row['schema_valid'] = row['automatic_schema_valid']
        # Missing/unreviewed text needs human review, not a novel-status decision.
        row['needs_contract_review'] = row['category'] is None or (
            row['label'] not in ('', None) and not row['completed_schema_valid'])
        row['image'] = None
        row['image_integrity_valid'] = False
        try:
            image_hash, pixel_hash, shape = _decode_png(raw)
            row.update(image_sha256=image_hash, pixel_sha256=pixel_hash, image_dimensions=shape)
            if row.get('expected_pixel_sha256') and row['expected_pixel_sha256'] != pixel_hash:
                raise ValueError('Decoded pixels do not match durable review identity')
            if row.get('expected_image_sha256') and row['expected_image_sha256'] != image_hash:
                raise ValueError('PNG bytes do not match durable review identity')
            relative = Path('images') / dataset_id / f'{image_hash}.png'
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_bytes(raw)
                png_count += 1
            row['image'] = relative.as_posix()
            row['image_integrity_valid'] = True
        except (ValueError, OSError) as exc:
            row['image_integrity_error'] = str(exc)
        row['ai_review'] = _current_ai_check(row,ai_items,ai_jobs,events_by_key)
        if row['ai_review'] and row['ai_review']['successful_current_check']:
            if not row['reviewed']:
                row['label_evidence'] = 'openai_visual_check'
            row['reviewed'] = True;row['visually_verified'] = False
            row['is_reviewed_negative'] = row['label'] == '' and row['category'] is not None
            row['automatic_schema_valid'] = row['completed_schema_valid'] or row['is_reviewed_negative']
            row['schema_valid'] = row['automatic_schema_valid']
        row['ai_review_blocked'] = bool(row['ai_review'] and not row['ai_review']['successful_current_check'])
        row['eligible_for_training'] = bool(row['reviewed'] and row['schema_valid'] and row['image_integrity_valid']
                                            and not row['dataset_archived'] and not row['queue_discarded']
                                            and not row['removed_unsaved_queue_observation']
                                            and not row['ai_review_blocked'])
        row['training_eligibility_limitations'] = ['no_split_assigned', 'not_production_acceptance_evidence']
        if not row['reviewed']:
            row['training_eligibility_limitations'].append('collector_label_requires_review')
        if not row['provenance']['capture_group']:
            row['training_eligibility_limitations'].append('unknown_capture_provenance')
        if row['needs_contract_review']:
            row['training_eligibility_limitations'].append('outside_current_automatic_contract')
        if row['dataset_archived']:
            row['training_eligibility_limitations'].append('archived_dataset')
        if row['ai_review_blocked']:
            row['training_eligibility_limitations'].append('latest_current_ai_review_'+row['ai_review']['state'])
        if row['removed_unsaved_queue_observation']:
            row['training_eligibility_limitations'].append('removed_unsaved_queue_observation')
    summary = {'dataset_id': dataset_id, 'dataset_name': dataset.get('name'),
        'source_database': str(directory / 'data.db'), 'archived': bool(dataset.get('archived')),
        'saved_image_rows': len(images), 'review_sample_rows': len(reviews),
        'durable_matching_review_sample_rows': len(reviewed),
        'saved_review_overlap_groups': len(merged_filenames),
        'merged_review_alias_count': sum(len(group) - 1 for group in groups.values()),
        'exported_samples': len(output_rows), 'exported_png_files': png_count,
        'reviewed_samples': sum(row['reviewed'] for row, _ in output_rows),
        'reviewed_negatives': sum(row['is_reviewed_negative'] for row, _ in output_rows),
        'unverified_empty_or_missing': sum(not row['reviewed'] and not row['label'] for row, _ in output_rows),
        'training_candidates': sum(row['eligible_for_training'] for row, _ in output_rows),
        'outside_contract_samples': sum(row['needs_contract_review'] for row, _ in output_rows),
        'image_integrity_failures': sum(not row['image_integrity_valid'] for row, _ in output_rows),
        'session_unique_samples': len(session),
        'normalized_queue_rows': len(queue_rows),
        'normalized_queue_active_rows': sum(bool(row.get('active')) for row in queue_rows),
        'session_without_durable_review': len(set(session) - {part[0]['sample_key'] for part in reviewed}),
        'excluded_review_samples': len(excluded), 'source_read_issues': issues,
        'categories': dict(Counter(row['category'] or 'unknown' for row, _ in output_rows)),
        'reviewed_status_labels': dict(Counter(row['label'] for row, _ in output_rows if row['reviewed'] and row['category'] == 'status'))}
    return [row for row, _ in output_rows], excluded, summary


def deduplicate_training_rows(rows):
    """Keep exact-pixel aliases together and pick one auditable representative.

    A similarity hash or a repeated label is never a deduplication identity.
    Conflicting reviewed truths are quarantined unless a recorded correction
    explicitly repairs the competing value. Current AI warnings/pending checks
    block the entire pixel group instead of falling back to older unchecked data.
    """
    def identity(row):
        return row['dataset_id']+':'+row['sample_key']

    def rank(row):
        ai = bool((row.get('ai_review') or {}).get('successful_current_check'))
        visual = row['label_evidence'] == 'assistant_visual_review'
        human = row['label_evidence'] == 'durable_human_review_event'
        return (2 if visual or ai else 1 if human else 0,row.get('observation_timestamp') or -1,
                _timestamp((row.get('review_event') or {}).get('created_at')) or -1,
                row['dataset_id'],row['sample_key'])

    groups = defaultdict(list)
    for row in rows:
        semantic = row.get('category') or re.sub(r'\[\d+\]','[*]',row['region_id'])
        token = semantic+':'+row['pixel_sha256'] if row.get('image_integrity_valid') else 'invalid:'+identity(row)
        row['exact_pixel_group'] = hashlib.sha256(token.encode()).hexdigest()
        groups[row['exact_pixel_group']].append(row)
    superseded,conflicts,candidates = [],[],[]
    parent = {}
    def root(value):
        parent.setdefault(value,value)
        while parent[value]!=value:
            parent[value]=parent[parent[value]];value=parent[value]
        return value
    def join(left,right):
        a,b=root(left),root(right)
        if a!=b:parent[max(a,b)]=min(a,b)

    for group_id, members in sorted(groups.items()):
        node='pixels:'+group_id
        for row in members:
            capture=row['provenance'].get('capture_group')
            if capture:join(node,'capture:'+capture)
            else:root(node)
    component_splits=defaultdict(set)
    component_captures=defaultdict(set)
    for group_id,members in groups.items():
        component=root('pixels:'+group_id)
        for row in members:
            split=row['provenance'].get('split')
            if split:component_splits[component].add(str(split))
            capture=row['provenance'].get('capture_group')
            if capture:component_captures[component].add(capture)

    for group_id,members in sorted(groups.items()):
        eligible=[row for row in members if row['eligible_for_training']]
        winner=max(eligible,key=rank) if eligible else None
        labels=sorted({row['label'] for row in members})
        authoritative=[row for row in members if row['reviewed'] and row.get('image_integrity_valid') and not row.get('dataset_archived')]
        blocked=[row for row in members if row.get('ai_review_blocked') and not row.get('dataset_archived')]
        reason=None
        resolution=None
        if blocked:
            reason='current_ai_review_pending_or_flagged'
        elif len(labels)>1:
            if winner:
                competing={row['label'] for row in authoritative if row['label']!=winner['label']}
                event=winner.get('review_event') or {}
                other_times=[_timestamp((row.get('review_event') or {}).get('created_at')) for row in authoritative if row['label']!=winner['label']]
                event_time=_timestamp(event.get('created_at'))
                explicit_repair=(event.get('action') in ('corrected','manual') or
                                 ((winner.get('ai_review') or {}).get('state')=='corrected' and
                                  (winner.get('ai_review') or {}).get('successful_current_check')))
                repaired=(not competing or (explicit_repair and competing=={event.get('prior_label')} and
                          event_time is not None and all(stamp is not None and event_time>stamp for stamp in other_times)))
                if repaired:
                    resolution='newest_authoritative_correction' if competing else 'reviewed_truth_over_unverified_labels'
                else:reason='conflicting_reviewed_labels'
            else:reason='conflicting_labels_without_eligible_truth'
        component=root('pixels:'+group_id)
        splits=sorted(component_splits[component])
        held_out=any(split.lower() in ('val','validation','test','holdout','heldout','challenge','sealed') for split in splits)
        for row in members:
            row['dedup_alias_count']=len(members)
            row['dedup_aliases']=[{'dataset_id':m['dataset_id'],'sample_key':m['sample_key'],
                'label':m['label'],'label_evidence':m['label_evidence'],
                'observation_timestamp':m.get('observation_timestamp')} for m in sorted(members,key=identity)] if row is winner else []
            row['provenance']['split_group']='captures:'+hashlib.sha256(component.encode()).hexdigest()
            row['provenance']['duplicate_capture_groups']=sorted(component_captures[component]) if row is winner else []
            row['provenance']['duplicate_known_splits']=splits
            row['dedup_canonical']=identity(winner) if winner and not reason else None
            row['dedup_resolution']=resolution
            if reason or held_out or (winner is not None and row is not winner):
                row['eligible_for_training']=False
                limitation=reason or ('exact_duplicate_component_contains_holdout' if held_out else 'superseded_exact_pixel_duplicate')
                row['training_eligibility_limitations'].append(limitation)
        if reason:
            conflicts.append({'exact_pixel_group':group_id,'reason':reason,'labels':labels,
                              'members':[identity(m) for m in sorted(members,key=identity)]})
        if winner and not reason:
            for row in members:
                if row is not winner:
                    superseded.append({'sample':identity(row),'canonical':identity(winner),'exact_pixel_group':group_id,
                        'reason':'newest_current_model_check' if (winner.get('ai_review') or {}).get('successful_current_check') else 'newest_reviewed_observation',
                        'label_conflict_resolved':bool(resolution),'prior_label':row['label'],'canonical_label':winner['label']})
            if winner['eligible_for_training']:candidates.append(winner)
    return candidates,superseded,conflicts


def apply_visual_review_manifest(rows, manifest):
    """Import explicit pixel-by-pixel assistant review without trusting stale IDs."""
    if manifest is None:
        return {'records':0,'applied':0,'unmatched_or_stale':0}
    values=[]
    for entry in manifest if isinstance(manifest,list) else [manifest]:
        if isinstance(entry,dict):values.append(entry)
        else:
            values.extend(json.loads(line) for line in Path(entry).read_text().splitlines() if line.strip())
    index=defaultdict(list)
    for row in rows:
        for key in row['sample_key_aliases']:index[(row['dataset_id'],key)].append(row)
    applied=0;seen=set();decisions=Counter()
    for record in values:
        if (not isinstance(record,dict) or record.get('visually_reviewed') is not True or
                record.get('reviewer')!='assistant_visual' or record.get('decision') not in ('confirmed_current_label','ambiguous')):
            raise ValueError('Visual manifest requires explicit assistant_visual pixel review records')
        identity=(record.get('dataset_id'),record.get('sample_key'))
        if identity in seen:raise ValueError('Visual manifest contains a duplicate sample identity')
        seen.add(identity)
        for row in index[(record.get('dataset_id'),record.get('sample_key'))]:
            ai=row.get('ai_review') or {}
            if (not row.get('image_integrity_valid') or record.get('pixel_sha256')!=row.get('pixel_sha256') or
                    record.get('label')!=row['label'] or record.get('source_job_id')!=ai.get('job_id') or
                    record.get('queue_id')!=row.get('queue_id') or
                    ai.get('state') not in (('flagged','conflict') if record['decision']=='confirmed_current_label'
                                           else ('flagged','conflict','unchanged','corrected'))):
                continue
            row['visual_review']=record
            if record['decision']=='confirmed_current_label':
                row['label_evidence']='assistant_visual_review';row['visually_verified']=True;row['reviewed']=True
                row['ai_review_blocked']=False
                row['is_reviewed_negative']=row['label']=='' and row['category'] is not None
                row['automatic_schema_valid']=row['completed_schema_valid'] or row['is_reviewed_negative']
                row['schema_valid']=row['automatic_schema_valid']
                row['training_eligibility_limitations']=[item for item in row['training_eligibility_limitations']
                    if not item.startswith('latest_current_ai_review_')]
                row['eligible_for_training']=bool(row['schema_valid'] and not row.get('dataset_archived') and
                    not row.get('queue_discarded') and not row.get('removed_unsaved_queue_observation'))
            else:
                row['visually_verified']=False;row['eligible_for_training']=False;row['ai_review_blocked']=True
                row['training_eligibility_limitations'].append('assistant_visual_review_ambiguous')
            applied+=1
            decisions[record['decision']]+=1
    return {'records':len(values),'applied':applied,'unmatched_or_stale':len(values)-applied,'decisions':dict(decisions)}


def export_datasets(datasets, output, visual_review_manifest=None):
    output = Path(output).resolve()
    for dataset in datasets:
        directory = Path(dataset['directory']).resolve()
        if output == directory or directory in output.parents or output in directory.parents:
            raise ValueError('Output and source dataset directories must not contain one another')
    if output.exists() and any(output.iterdir()):
        raise ValueError('Output directory must be empty; use a fresh snapshot directory')
    output.mkdir(parents=True, exist_ok=True)
    rows, excluded, summaries = [], [], []
    started = datetime.now(timezone.utc).isoformat()
    for dataset in datasets:
        samples, dropped, summary = export_dataset(dataset, output)
        rows.extend(samples); excluded.extend(dropped); summaries.append(summary)
    visual_summary=apply_visual_review_manifest(rows,visual_review_manifest)
    before_dedup_counts=Counter(row['dataset_id'] for row in rows if row['eligible_for_training'])
    candidates,superseded,conflicts=deduplicate_training_rows(rows)
    for dataset_summary in summaries:
        dataset_summary['training_candidates_before_cross_collection_dedup']=before_dedup_counts[dataset_summary['dataset_id']]
        dataset_summary['training_candidates']=sum(row['eligible_for_training'] for row in rows if row['dataset_id']==dataset_summary['dataset_id'])
        dataset_summary['reviewed_samples']=sum(row['reviewed'] for row in rows if row['dataset_id']==dataset_summary['dataset_id'])
        dataset_summary['reviewed_negatives']=sum(row['is_reviewed_negative'] for row in rows if row['dataset_id']==dataset_summary['dataset_id'])
    manifests = {'samples.jsonl': rows,
                 'reviewed.jsonl': [row for row in rows if row['reviewed']],
                 'training_candidates.jsonl': candidates,
                 'needs_review.jsonl': [row for row in rows if not row['eligible_for_training']],
                 'excluded_review_samples.jsonl': excluded,
                 'superseded_exact_duplicates.jsonl':superseded,
                 'exact_pixel_conflicts.jsonl':conflicts}
    for filename, values in manifests.items():
        (output / filename).write_text(''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n' for row in values))
    summary = {'snapshot_started_at_utc': started, 'snapshot_finished_at_utc': datetime.now(timezone.utc).isoformat(),
        'validation_contract': {'version': CONTRACT['version'], 'sha256': CONTRACT_SHA256},
        'source_access': 'SQLite mode=ro/query_only, consistent read transaction per dataset; no source migrations or SQL writes',
        'limitations': ['Not a split, training run, or production approval.',
                       'Human collector events and automated visual checks are separate evidence; neither is a prospective accuracy guarantee.',
                       'Prior external curation and visual-review manifests are not merged or changed; unverified collector label describes source-DB provenance, not proof that nobody reviewed those pixels.',
                       'Training candidates require current matching durable human/AI evidence and one canonical exact-pixel representative.',
                       'Unreviewed legacy empty labels remain unverified and are never promoted to negatives.',
                       'Capture identity is not a verified independent capture-session split.',
                       'PNG files live outside SQLite transactions; stable file reads and pixel identities are checked.',
                       'Live databases may advance after their snapshot; datasets are read sequentially.'],
        'counts': {name.removesuffix('.jsonl'): len(values) for name, values in manifests.items()},
        'dedup_policy':{'identity':'decoded RGB pixels including dimensions + semantic region category',
            'preference':'current successful model check or explicit current visual confirmation, then current human review; newest recorded observation within evidence class; deterministic identity tie-break',
            'source_rows_preserved':True,'near_duplicate_pruning':False,'heldout_aliases_trainable':False},
        'ai_review_states':dict(Counter((row.get('ai_review') or {}).get('state','not_checked') for row in rows)),
        'ai_review_in_progress':any((row.get('ai_review') or {}).get('job_state') in ('queued','running') for row in rows),
        'ai_review_blocked_samples':sum(bool(row.get('ai_review_blocked')) for row in rows),
        'quarantine_reasons':dict(Counter(item['reason'] for item in conflicts)),
        'assistant_visual_review':visual_summary,
        'datasets': summaries,
        'manifest_sha256': {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in manifests}}
    (output / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dataset', action='append', help='Registry identity; repeat to select datasets (default all existing)')
    parser.add_argument('--visual-review-manifest',type=Path,action='append',help='Hash-bound assistant visual-review JSONL; repeat to combine manifests')
    args = parser.parse_args()
    datasets = discover_datasets()
    if args.dataset:
        known = {row['id'] for row in datasets}
        missing = set(args.dataset) - known
        if missing:
            parser.error('Unknown/missing dataset identities: ' + ', '.join(sorted(missing)))
        datasets = [row for row in datasets if row['id'] in args.dataset]
    summary = export_datasets(datasets, args.output,visual_review_manifest=args.visual_review_manifest)
    print(json.dumps({'output': str(args.output.resolve()), 'counts': summary['counts'],
                      'datasets': summary['datasets']}, indent=2))


if __name__ == '__main__':
    main()
