"""Freeze selected collections into auditable candidate training inputs."""
import argparse
from collections import Counter, defaultdict
from contextlib import contextmanager
from copy import deepcopy
import json
import os
import re
from pathlib import Path
import shutil
import sys
import fcntl
import time

from export_reviewed_dataset import export_datasets, readonly_database
from prepare_named_collection_training import (
    collection_rows, digest, pixels, prepare_records, read_jsonl, source_bytes, Groups, exact_key,
    write_jsonl, write_recipe,
)
from lib.ocr_contract import CONTRACT, CONTRACT_SHA256, validate_text
from lab_training_curriculum import build_curriculum


class DataProgress:
    def __init__(self, run):
        self.path = Path(run) / 'data-progress.json'
        self.previous = None
        self.written = 0

    def __call__(self, stage, **fields):
        if 'collection_name' in fields:
            fields['collection_name'] = fields['collection_name'][:100]
        value = {'stage': stage, **fields}
        now = time.monotonic()
        if (self.previous and self.previous.get('stage') == stage
                and self.previous.get('collection_name') == value.get('collection_name')
                and fields.get('completed') != fields.get('total') and now - self.written < .25):
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(value) + '\n')
        temporary.replace(self.path)
        self.previous, self.written = value, now


def _reservation_tokens(row):
    return {'pixel:' + '|'.join(exact_key(row)), *('group:' + group for group in row.get('groups', [])
             if not re.search(r':inferred-session:\d+$', group))}


@contextmanager
def _reservation_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root / 'split-reservations.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def reserve_splits(root, baseline, named, inventory, collections, scope='all_registry_collections'):
    """Keep whole capture/session/pixel components in durable train/val/test roles."""
    root = Path(root)
    path = root / 'split-reservations.json'
    graph = Groups()
    members = defaultdict(list)
    for row in baseline + named:
        tokens = sorted(_reservation_tokens(row))
        for token in tokens:
            graph.join(row['sample_id'], token)
    for row in baseline + named:
        members[graph.root(row['sample_id'])].append(row)
    datasets_by_pixel = defaultdict(set)
    for row in inventory:
        if (row.get('reviewed') and row.get('image_integrity_valid') and not row.get('ai_review_blocked')
                and not row.get('quarantined_empty_partition_alias')):
            datasets_by_pixel[exact_key(row)].add(row['dataset_id'])
    collection_ids = {row['id'] for row in collections}
    with _reservation_lock(root):
        ledger = json.loads(path.read_text()) if path.is_file() else {'version': 1, 'tokens': {}, 'collections': {}}
        if ledger.get('version') != 1 or not isinstance(ledger.get('tokens'), dict):
            raise ValueError('The training split reservation ledger is invalid; restore its previous snapshot.')
        if any(value not in ('train', 'val', 'test') for value in ledger['tokens'].values()):
            raise ValueError('The training split reservation ledger contains an invalid partition.')
        ledger['tokens'] = {token: role for token, role in ledger['tokens'].items()
                            if not re.search(r':inferred-session:\d+$', token)}
        components = []
        for rows in members.values():
            selected = [row for row in rows if row['origin'] == 'named']
            datasets = set().union(*(datasets_by_pixel[exact_key(row)] for row in rows)) & collection_ids
            if not datasets:
                continue
            tokens = set().union(*(_reservation_tokens(row) for row in rows))
            roles = {row['pinned_split'] for row in rows if row['origin'] == 'baseline'}
            roles.update(role for row in selected for role in row.get('known_splits', []))
            roles.update(ledger['tokens'][token] for token in tokens if token in ledger['tokens'])
            components.append({'tokens': tokens, 'rows': selected, 'evidence': rows, 'roles': roles, 'datasets': datasets,
                               'key': digest('\n'.join(sorted(tokens)).encode())})
        def coverage(component, dataset):
            categories = {row['category'] for row in component['evidence']
                          if dataset in datasets_by_pixel[exact_key(row)]}
            return {'names' if category == 'name' else 'general' for category in categories}, categories
        # Cover benchmark first, validation second, retaining a training component
        # when at least two independent components exist. Existing roles never move.
        for dataset in sorted(collection_ids):
            relevant = [component for component in components if dataset in component['datasets']]
            roles = {next(iter(component['roles'])) for component in relevant if len(component['roles']) == 1}
            fresh = sorted([component for component in relevant if not component['roles']], key=lambda value: value['key'])
            if 'test' not in roles and fresh:
                chosen = min(fresh, key=lambda value: (-len(value['datasets']), -len(coverage(value, dataset)[0]), -len(coverage(value, dataset)[1]), value['key']))
                chosen['roles'].add('test')
                fresh.remove(chosen)
            available_roles = set().union(*(coverage(component, dataset)[0] for component in relevant))
            test_roles = set().union(*(coverage(component, dataset)[0] for component in relevant if component['roles'] == {'test'}))
            while available_roles - test_roles and fresh and ('train' in roles or len(fresh) > 1):
                chosen = min(fresh, key=lambda value: (-len(coverage(value, dataset)[0] - test_roles), value['key']))
                missing = coverage(chosen, dataset)[0] - test_roles
                if not missing:
                    break
                chosen['roles'].add('test')
                fresh.remove(chosen)
                test_roles.update(missing)
            if 'val' not in roles and (len(fresh) >= 2 or ('train' in roles and fresh)):
                fresh.pop(0)['roles'].add('val')
            if 'train' not in roles and fresh:
                fresh.pop(0)['roles'].add('train')
        for component in sorted(components, key=lambda value: value['key']):
            if not component['roles']:
                bucket = int(component['key'][:8], 16) % 10
                component['roles'].add('test' if bucket == 0 else 'val' if bucket == 1 else 'train')
            if len(component['roles']) == 1 and next(iter(component['roles'])) in ('train', 'val', 'test'):
                role = next(iter(component['roles']))
                for token in component['tokens']:
                    ledger['tokens'].setdefault(token, role)
            for row in component['rows']:
                row['known_splits'] = sorted(set(row.get('known_splits', [])) | component['roles'])
        report = {}
        for dataset in sorted(collection_ids):
            relevant = [component for component in components if dataset in component['datasets']]
            counts = Counter(next(iter(component['roles'])) for component in relevant if len(component['roles']) == 1)
            reasons = []
            if not relevant:
                reasons.append('No reviewed, valid labeled capture components are available.')
            elif not counts['test']:
                reasons.append('No independent benchmark component is available: existing partition pins or duplicate/session bridges protect these captures. Collect a new independent capture session.')
            if relevant and not counts['train']:
                reasons.append('All available independent components are reserved or conflict with existing partitions. Collect another independent capture session for training.')
            if relevant and not counts['val']:
                reasons.append('No independent validation component is available in this collection; inherited frozen validation is used when available.')
            pixel_roles = {exact_key(row): next(iter(component['roles'])) for component in relevant if len(component['roles']) == 1
                           for row in component['evidence']}
            row_roles = {row['sample_key']: pixel_roles[exact_key(row)] for row in inventory
                         if row['dataset_id'] == dataset and exact_key(row) in pixel_roles
                         and row.get('reviewed') and row.get('image_integrity_valid') and not row.get('ai_review_blocked')
                         and not row.get('quarantined_empty_partition_alias')}
            test_rows = [row for row in inventory if row['dataset_id'] == dataset and row_roles.get(row['sample_key']) == 'test']
            test_categories = Counter(row['category'] for row in test_rows)
            test_roles = Counter('names' if row['category'] == 'name' else 'general' for row in test_rows)
            available_roles = set().union(*(coverage(component, dataset)[0] for component in relevant))
            if available_roles - set(test_roles):
                reasons.append('Benchmark coverage is unavailable for: ' + ', '.join(sorted(available_roles - set(test_roles))) + '. Existing pins or too few independent components prevent reserving those roles.')
            report[dataset] = {'components': dict(counts), 'reserved': sum(role != 'train' for role in row_roles.values()),
                               'validation': sum(role == 'val' for role in row_roles.values()),
                               'test': sum(role == 'test' for role in row_roles.values()), 'reasons': reasons,
                               'test_categories': dict(test_categories), 'test_roles': dict(test_roles),
                               'test_blanks': sum(row['label'] == '' for row in test_rows)}
        ledger['collections'].update(report)
        ledger.update(scope=scope, policy='whole_capture_session_pixel_components_v1',
                      applies_to='future_preparations_only; existing version benchmark manifests are unchanged')
        temporary = path.with_suffix('.tmp')
        with temporary.open('w') as output:
            output.write(json.dumps(ledger, sort_keys=True, indent=2) + '\n')
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        reservation_hash = digest(path.read_bytes())
    return components, {'path': str(path), 'sha256': reservation_hash, 'scope': scope,
                        'collections': report, 'existing_versions_changed': False}


def _reserve_catalog(request, collections, exported, baseline, characters):
    catalog = request.get('reservation_collections', collections)
    scope = 'all_registry_collections' if 'reservation_collections' in request else 'selected_collections_legacy_request'
    if {row['id'] for row in catalog} == {row['id'] for row in collections} and not any(row.get('archived') for row in catalog):
        global_export = exported
    else:
        global_export = Path(request['run_dir']) / 'reservation-collections'
        # Archive visibility cannot erase a verified crop's partition obligation.
        # This export is only a graph input; selected training uses its own export.
        _export(request, [dict(row, archived=False) for row in catalog], global_export, baseline)
    named, blocked, _ = collection_rows(global_export)
    named = [row for row in named if set(row['label']) <= characters and not any(char in row['label'] for char in '\t\r\n')]
    components, report = reserve_splits(request['training_root'], baseline, named,
                                       read_jsonl(global_export / 'samples.jsonl'), catalog, scope)
    roles_by_token = defaultdict(set)
    for component in components:
        for token in component['tokens']:
            roles_by_token[token].update(component['roles'])
    for key in blocked:
        roles_by_token['pixel:' + '|'.join(key)].add('challenge')
    report['global_blocked_pixel_groups'] = len(blocked)
    (Path(request['run_dir']) / 'split-reservations.json').write_text(json.dumps(report, indent=2) + '\n')
    return roles_by_token, report


def _existing(candidates, description):
    for candidate in candidates:
        if candidate.is_file():
            return candidate.absolute()
    raise ValueError(f'{description} is missing. Restore the vetted OCR training resources under {candidates[0].parents[1]}.')


def _proof_digest(value):
    return digest(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())


def _architecture_digest(template):
    import yaml
    architecture = deepcopy(yaml.safe_load(Path(template).read_text())['Architecture'])
    architecture['Head']['out_channels'] = 70
    return _proof_digest(architecture)


def _original_initialization(root, dictionary, templates):
    import yaml
    directory = root / 'production-clean-start'
    checkpoint = _existing([directory / 'initial.pdparams'], 'Original pretrained initialization')
    record_path = directory / 'provenance.json'
    record = json.loads(record_path.read_text())
    proof = record.get('verification') or {}
    source = root / 'benchmark-models/PP-OCRv6_small_rec'
    official = _existing([source / 'pretrained.pdparams'], 'Untouched official pretrained checkpoint')
    download = json.loads((source / 'PRETRAINED-SOURCE.json').read_text())
    model_source = json.loads((source / 'MODEL-SOURCE.json').read_text())
    source_dictionary = source / 'inference.yml'
    artifacts = {
        'official_source_sha256': digest(official.read_bytes()),
        'mapped_sha256': digest(checkpoint.read_bytes()),
        'source_dictionary_sha256': digest(source_dictionary.read_bytes()),
        'training_dictionary_sha256': digest(dictionary.read_bytes()),
        'download_record_sha256': digest((source / 'PRETRAINED-SOURCE.json').read_bytes()),
        'source_model_record_sha256': digest((source / 'MODEL-SOURCE.json').read_bytes()),
    }
    if (record.get('collector_tuned_weights_used') is not False
            or artifacts['official_source_sha256'] != record.get('official_source_sha256')
            or artifacts['mapped_sha256'] != record.get('mapped_sha256')
            or download.get('sha256') != artifacts['official_source_sha256']
            or download.get('bytes') != official.stat().st_size
            or download.get('url') != 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_pretrained_model/PP-OCRv6_small_rec_pretrained.pdparams'
            or model_source.get('repository') != 'PaddlePaddle/PP-OCRv6_small_rec'
            or (model_source.get('sha256') or {}).get('inference.yml') != artifacts['source_dictionary_sha256']):
        raise ValueError('Original pretrained source or mapped initialization differs from its provenance')
    classes = ['blank'] + dictionary.read_text().splitlines() + [' ']
    original_classes = ['blank'] + yaml.safe_load(source_dictionary.read_text())['PostProcess']['character_dict'] + [' ']
    if len(classes) != 70 or len(set(classes)) != 70 or any(original_classes.count(char) != 1 for char in classes):
        raise ValueError('Original pretrained character mapping is incompatible with the training dictionary')
    indices = [original_classes.index(char) for char in classes]
    for role, template in templates.items():
        config = yaml.safe_load(Path(template).read_text())
        if bool(config['Global'].get('collector_name_high_resolution')) != (role == 'names'):
            raise ValueError('Original pretrained role geometry disagrees with its training recipe')
    policies = {role: {'architecture_sha256': _architecture_digest(template), 'width_pool': 1,
                       'temporal_stride': 2 if role == 'names' else 4}
                for role, template in templates.items()}
    if (record.get('classes') != classes or record.get('class_indices') != indices
            or record.get('mapped_tensors') != 338
            or record.get('verification_sha256') != _proof_digest(proof)
            or proof.get('method') != 'original_pretrained_tensor_mapping_v1'
            or proof.get('artifacts') != artifacts or proof.get('policies') != policies
            or proof.get('classes_sha256') != _proof_digest(classes)
            or proof.get('class_indices_sha256') != _proof_digest(indices)
            or proof.get('mapped_tensors') != 338 or proof.get('bitwise_equal_tensors') != 338
            or proof.get('mismatches') != 0 or proof.get('collector_tuned_tensors_used') != 0
            or proof.get('strict_architecture_shapes') is not True):
        raise ValueError('Original pretrained initialization lacks a valid complete tensor-mapping verification')
    lineage = {role: {'origin': 'original_pretrained', 'checkpoint': str(checkpoint),
                      'checkpoint_sha256': artifacts['mapped_sha256'],
                      'official_source_sha256': artifacts['official_source_sha256'],
                      'official_source_url': download['url'], 'policy': policy,
                      'verification': proof, 'verification_sha256': record['verification_sha256'],
                      'record': str(record_path), 'record_sha256': digest(record_path.read_bytes())}
               for role, policy in policies.items()}
    return checkpoint, lineage


def discover(root):
    root = Path(root).resolve()
    baseline = root / 'named-continuation' / 'final'
    release = Path(os.environ.get('OCR_MODEL_RELEASE', root / 'release-candidate')).resolve()
    runtime = json.loads((release / 'runtime.json').read_text())
    frozen = json.loads((release / 'freeze.json').read_text())
    model_paths = {}
    for role, key in [('general', 'general_model'), ('names', 'name_model')]:
        model = release / runtime[key]
        for name, expected in [('model.onnx', frozen['weights'][role]),
                               ('characters.json', frozen['characters_sha256'][role])]:
            if digest((model / name).read_bytes()) != expected:
                raise ValueError(f'The active {role} model {name} differs from its release freeze')
        model_paths['baseline_' + role + '_model'] = model
    templates = {role: _existing([baseline / role / 'train.yml'], role.capitalize() + ' training recipe')
                 for role in ('general', 'names')}
    dictionary = _existing([baseline / 'dictionary.txt'], 'Training character dictionary')
    initial, lineage = _original_initialization(root, dictionary, templates)
    return {
        'baseline': baseline,
        'general_template': templates['general'],
        'names_template': templates['names'],
        'general_checkpoint': initial,
        'names_checkpoint': initial,
        'starting_lineage': lineage,
        'dictionary': dictionary,
        'python': _existing([root / 'desktop-train-gpu/bin/python'], 'GPU training Python interpreter'),
        'inference_python': _existing([root / 'desktop-gpu/bin/python', root / 'runtime-venv/bin/python'], 'GPU benchmark Python interpreter'),
        **model_paths,
        'model_release': release,
        'source': _existing([root / 'desktop-training/paddle-training-source/tools/train.py'], 'PaddleOCR training source').parents[1],
    }


def _semantic_baseline(root, originals):
    directory = root.parent / 'semantic-v2'
    if not directory.exists():
        return originals
    audit = json.loads((directory / 'audit.json').read_text())
    review_path = directory / 'semantic-review.jsonl'
    review_hash = digest(review_path.read_bytes())
    source_hash = digest((root / 'manifest.jsonl').read_bytes())
    if (audit.get('training_ready') is not True
            or audit.get('provisional_ai_review_snapshot')
            or audit.get('semantic_review_sha256') != review_hash
            or audit.get('source_manifest_sha256') != source_hash):
        raise ValueError('Semantic training exclusions do not match the audited source manifest')
    reviews = read_jsonl(review_path)
    if len(reviews) != audit.get('semantic_exclusion_count'):
        raise ValueError('Semantic training exclusion coverage differs from its audit')
    seen, pages = set(), {}
    for review in reviews:
        line = review.get('source_manifest_line')
        if isinstance(line, bool) or not isinstance(line, int) or not 1 <= line <= len(originals):
            raise ValueError('Semantic review references an invalid source row')
        original = originals[line - 1]
        if (line in seen or review.get('sample_id') != original['sample_id']
                or review.get('source_manifest_sha256') != source_hash
                or any(review.get(key) != original.get(key) for key in ('label', 'category', 'pixel_sha256', 'split', 'region_id'))
                or review.get('source_file_sha256') != original['file_sha256']
                or review.get('decision') != 'exclude_from_name_optimization'
                or review.get('semantic_role') != 'transient_winner_status_marker'
                or review.get('visually_reviewed') is not True
                or review.get('label_preserved') is not True or review.get('split_preserved') is not True
                or review.get('literal_label_matches_visible_text') is not True
                or review.get('clipped_or_ambiguous') is not False):
            raise ValueError('Semantic exclusion lacks matching visual review evidence')
        page = (directory / 'review-evidence' / review['evidence_page']).resolve()
        if not page.is_relative_to((directory / 'review-evidence').resolve()):
            raise ValueError('Semantic review evidence escapes its artifact directory')
        if page not in pages:
            pages[page] = digest(page.read_bytes())
        if pages[page] != review.get('evidence_page_sha256'):
            raise ValueError('Semantic review source-pixel evidence changed')
        seen.add(line)
        original.update(optimize=False, semantic_role='transient_winner_marker',
                        semantic_review_sha256=review_hash,
                        semantic_exclusion_rationale='Visually reviewed transient status text; preserve literal label and split.')
    return originals


def _baseline(root):
    audit = json.loads((root / 'audit.json').read_text())
    if audit.get('training_ready') is not True or audit.get('provisional_ai_review_snapshot'):
        raise ValueError('The inherited OCR baseline is not approved for training. Restore its completed audit.')
    rows = []
    for original in _semantic_baseline(root, read_jsonl(root / 'manifest.jsonl')):
        if original.get('split') not in ('train', 'val', 'test'):
            raise ValueError('The inherited baseline has an unknown split')
        path, raw = source_bytes(root, original, 'image_path', 'file_sha256')
        pixel_hash, shape = pixels(raw)
        if pixel_hash != original.get('pixel_sha256') or shape != original.get('image_dimensions'):
            raise ValueError('The inherited baseline decoded pixels changed')
        if not validate_text(original.get('category'), original.get('label'), allow_blank=True):
            raise ValueError('The inherited baseline labels violate the current OCR contract')
        control = bool(original.get('constructed_control'))
        if control:
            construction = original.get('blank_construction') or {}
            if (original['label'] or construction.get('decoded_pixels_match_original_construction') is not True
                    or construction.get('foreground_glyphs_rendered') is not False
                    or audit.get('blank_retention', {}).get('enabled') is not True):
                raise ValueError('The inherited blank controls lack their construction audit')
        rows.append({**deepcopy(original), 'origin': 'baseline',
                     'sample_id': 'baseline:' + original['sample_id'],
                     'baseline_sample_id': original['sample_id'],
                     'dataset_id': original.get('dataset_id', 'baseline'),
                     'sample_key': original.get('sample_key', original['sample_id']),
                     'pinned_split': original['split'], 'source_image': str(path),
                     'inherited_control': control, 'groups': original.get('groups', []),
                     'validation_contract': {'version': CONTRACT['version'], 'sha256': CONTRACT_SHA256}})
    return rows


def _request(request):
    collections = request.get('collections')
    if not isinstance(collections, list) or not collections or len(collections) > 100:
        raise ValueError('Select at least one collection (maximum 100)')
    ids = [row['id'] for row in collections]
    if len(set(ids)) != len(ids):
        raise ValueError('A collection may only be selected once')
    epochs = request.get('epochs', 6)
    if isinstance(epochs, bool) or not isinstance(epochs, int) or not 1 <= epochs <= 100:
        raise ValueError('Epochs must be between 1 and 100')
    run = Path(request['run_dir']).resolve()
    return collections, ids, epochs, run


def _collection_counts(collections, samples, accepted_ids, reserved_ids=(), duplicate_ids=()):
    counts = []
    for collection in collections:
        rows = [row for row in samples if row['dataset_id'] == collection['id']]
        represented = {alias for row in rows for alias in row['sample_key_aliases']}
        missing_active = set()
        with readonly_database(Path(collection['directory']) / 'data.db') as connection:
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'queue_items' in tables:
                missing_active = {row['sample_key'] for row in connection.execute(
                    'SELECT sample_key FROM queue_items WHERE active=1 AND discarded=0')
                    if row['sample_key'] not in represented}
        eligible = [row for row in rows if 'named:' + row['dataset_id'] + ':' + row['sample_key'] in accepted_ids]
        reserved = [row for row in rows
                    if 'named:' + row['dataset_id'] + ':' + row['sample_key'] not in accepted_ids
                    and 'named:' + row['dataset_id'] + ':' + row['sample_key'] not in duplicate_ids
                    and (('named:' + row['dataset_id'] + ':' + row['sample_key'] in reserved_ids)
                         or ('exact_duplicate_component_contains_holdout' in row.get('training_eligibility_limitations', [])
                             and row['reviewed'] and row['image_integrity_valid'] and not row.get('ai_review_blocked')))]
        counts.append({
            'id': collection['id'], 'name': collection.get('name', collection['id']),
            'total': len(rows) + len(missing_active), 'reviewed': sum(bool(row['reviewed']) for row in rows),
            'eligible': len(eligible), 'names': sum(row['category'] == 'name' for row in eligible),
            'reserved': len(reserved),
            'blanks': sum(row['label'] == '' for row in eligible),
            'pending': len(missing_active) + sum(not row['reviewed'] and not row['queue_discarded'] for row in rows),
            'blocked': sum(bool(row.get('ai_review_blocked')) for row in rows),
        })
    return counts


def _export(request, collections, output, baseline=None):
    historical = None
    if baseline is None:
        try:
            baseline = _baseline(Path(request['training_root']) / 'named-continuation/final')
        except (ValueError, OSError, KeyError):
            baseline = None
    if any(row['id'] == 'legacy' for row in collections):
        root = Path(request['training_root']) / 'named-continuation/final'
        if baseline is None:
            try:
                baseline = _baseline(root)
            except (ValueError, OSError, KeyError):
                baseline = None
        if baseline is not None:
            historical = {'records': baseline, 'manifest_sha256': digest((root / 'manifest.jsonl').read_bytes()),
                          'audit_sha256': digest((root / 'audit.json').read_bytes())}
    ledger = Path(request['training_root']) / 'split-reservations.json'
    reservations = json.loads(ledger.read_text()) if ledger.is_file() else None
    return export_datasets(collections, output, audited_baseline=historical,
                           partition_baseline=baseline or (), split_reservations=reservations,
                           progress=DataProgress(request['run_dir']),
                           materialize_images=request.get('_materialize_training', True))


def _prepare(request, export=None, materialize_training=True):
    request = dict(request, _materialize_training=materialize_training)
    collections, ids, epochs, run = _request(request)
    progress = DataProgress(run)
    progress('validating')
    config = discover(request['training_root'])
    baseline = _baseline(config['baseline'])
    exported = run / 'collections'
    if export is None:
        export = _export(request, collections, exported, baseline)
    if materialize_training and export.get('images_materialized') is False:
        raise ValueError('A collection-check snapshot cannot train models; start training with a fresh image snapshot.')
    characters = set(config['dictionary'].read_text().splitlines()) | {' '}
    progress('reserving')
    reservation_roles, reservations = _reserve_catalog(request, collections, exported, baseline, characters)
    if export.get('ai_review_in_progress'):
        raise ValueError('A selected collection has a visual review in progress. Wait for it to finish before training.')
    named, blocked, _ = collection_rows(exported)
    if not named:
        raise ValueError('The selected collections contain no verified training crops. Complete their label review first.')
    unsupported = []
    supported = []
    for row in named:
        missing = sorted(set(row['label']) - characters)
        if missing or any(char in row['label'] for char in '\t\r\n'):
            unsupported.append({'sample_id': row['sample_id'], 'label': row['label'],
                                'reason': 'target_not_encodable_by_frozen_checkpoint',
                                'unsupported_characters': missing})
            blocked.add((row['category'], row['pixel_sha256']))
        else:
            supported.append(row)
    named = supported
    if not named:
        write_jsonl(run / 'quarantined-targets.jsonl', unsupported)
        raise ValueError('Verified labels cannot be encoded by the current model dictionary. See quarantined-targets.jsonl; a compatible starting model is required.')
    for row in named:
        reserved_roles = set().union(*(reservation_roles[token] for token in _reservation_tokens(row)))
        row['known_splits'] = sorted(set(row.get('known_splits', [])) | reserved_roles)
    records, quarantine, superseded, partition = prepare_records(baseline, named, blocked)
    partition['reservations'] = reservations
    selected_ids = {row['sample_id'] for row in named}
    semantic = {(row['category'], row['pixel_sha256'], row['label']): row for row in baseline
                if row.get('semantic_review_sha256')}
    for row in records:
        reviewed = semantic.get((row['category'], row['pixel_sha256'], row['label']))
        if reviewed:
            row.update(optimize=False, semantic_review_sha256=reviewed['semantic_review_sha256'],
                       semantic_role=reviewed['semantic_role'],
                       semantic_exclusion_rationale=reviewed['semantic_exclusion_rationale'])
            if row['split'] == 'train':
                quarantine.extend({'sample_id': alias['sample_id'], 'reason': 'audited_semantic_name_exclusion'}
                                  for alias in row['aliases'] if alias['sample_id'] in selected_ids)
    quarantine.extend(unsupported)
    records = [row for row in records if row['split'] != 'train' or row.get('inherited_control')
               or any(alias['sample_id'] in selected_ids for alias in row['aliases'])]
    selected_train = [row for row in records if row['split'] == 'train'
                      and any(alias['sample_id'] in selected_ids for alias in row['aliases'])
                      and row.get('optimize', True)]
    selected_records = [row for row in records if any(alias['sample_id'] in selected_ids for alias in row['aliases'])]
    counts = Counter(row['split'] for row in records if row.get('optimize', True))
    counts['test'] = sum(row['split'] == 'test' for row in records)
    selected_counts = {
        'accepted': len(selected_train), 'duplicates': export['counts']['superseded_exact_duplicates'],
        'names': sum(row['category'] == 'name' for row in selected_train),
        'blanks': sum(row['label'] == '' for row in selected_train),
        'train': counts['train'], 'validation': counts['val'], 'test': counts['test'],
        'selected_training': len(selected_train),
        'accepted_identities': [alias['sample_id'] for row in selected_train for alias in row['aliases']
                                if alias['sample_id'] in selected_ids],
    }
    reserved_ids = {alias['sample_id'] for row in selected_records if row['split'] != 'train'
                    for alias in row['aliases'] if alias['sample_id'] in selected_ids}
    duplicate_ids = {'named:' + row['sample'] for row in read_jsonl(exported / 'superseded_exact_duplicates.jsonl')}
    selected_counts['collections'] = _collection_counts(
        collections, read_jsonl(exported / 'samples.jsonl'), set(selected_counts['accepted_identities']), reserved_ids, duplicate_ids)
    total = sum(row['total'] for row in selected_counts['collections'])
    selected_counts['reserved'] = sum(row['reserved'] for row in selected_counts['collections'])
    selected_counts['rejected'] = total - selected_counts['accepted'] - selected_counts['duplicates'] - selected_counts['reserved']
    (run / 'preparation-counts.json').write_text(json.dumps(selected_counts, indent=2) + '\n')
    write_jsonl(run / 'preparation-exclusions.jsonl', quarantine)
    if not selected_train:
        raise ValueError('No selected verified crops remain for training after preserving protected holdout data and reserving independent benchmark/validation components. Collect another independent capture session. Existing fixed partitions were preserved.')
    roles = ['general', 'names'] if any(row['category'] == 'name' for row in selected_train) else ['general']
    bundle = run / 'bundle'
    if bundle.exists():
        raise ValueError('This training run already has a frozen bundle. Start a new run.')
    if not materialize_training:
        for role, batch in [('general', 4), ('names', 32)]:
            write_recipe(bundle / role, records, config[role + '_template'], config[role + '_checkpoint'],
                         config['dictionary'], name_only=role == 'names', epochs=epochs, batch_size=batch,
                         seed=20261109 if role == 'general' else 202611091, materialize=False)
        bundle.mkdir(parents=True)
        write_jsonl(bundle / 'manifest.jsonl', records)
        for split in ('train', 'val', 'test'):
            write_jsonl(bundle / (split + '.jsonl'), [row for row in records if row['split'] == split])
        summary = {key: selected_counts[key] for key in ('accepted', 'duplicates', 'rejected', 'reserved', 'train', 'validation', 'test', 'selected_training')}
        summary.update(inherited_holdouts=sum(row['split'] != 'train' and row['origin'] == 'baseline' for row in records),
                       inherited_blank_controls=sum(row['split'] == 'train' and row.get('inherited_control', False) for row in records))
        (bundle / 'audit.json').write_text(json.dumps({'training_ready': True, 'training_bundle_materialized': False,
            'validation_contract': {'version': CONTRACT['version'], 'sha256': CONTRACT_SHA256},
            'collection_ids': ids, 'source_manifest_sha256': export['manifest_sha256'],
            'baseline_manifest_sha256': digest((config['baseline'] / 'manifest.jsonl').read_bytes()),
            'dictionary_sha256': digest(config['dictionary'].read_bytes()),
            'manifest_sha256': digest((bundle / 'manifest.jsonl').read_bytes()),
            'unrelated_baseline_training_used': False,
            'partition': partition, 'summary': summary, 'roles': roles}, indent=2) + '\n')
        return {'bundle': str(bundle), 'dictionary': str(config['dictionary']), 'summary': summary, 'roles': roles}
    (bundle / 'images').mkdir(parents=True)
    (bundle / 'starting').mkdir()
    for row in records:
        raw = Path(row['source_image']).read_bytes()
        if digest(raw) != row['file_sha256']:
            raise ValueError('A crop changed during training preparation')
        relative = 'images/' + row['file_sha256'] + '.png'
        (bundle / relative).write_bytes(raw)
        row['image_path'] = relative
        row['source_image'] = str(bundle / relative)
    dictionary = bundle / 'dictionary.txt'
    shutil.copyfile(config['dictionary'], dictionary)
    audit = {
        'training_ready': True, 'training_run': False, 'runtime_model_replaced': False,
        'validation_contract': {'version': CONTRACT['version'], 'sha256': CONTRACT_SHA256},
        'collection_ids': ids, 'source_manifest_sha256': export['manifest_sha256'],
        'baseline_manifest_sha256': digest((config['baseline'] / 'manifest.jsonl').read_bytes()),
        'baseline_audit_sha256': digest((config['baseline'] / 'audit.json').read_bytes()),
        'dictionary_sha256': digest(dictionary.read_bytes()), 'partition': partition,
        'baseline_release': str(config['model_release']),
        'starting_lineage': config['starting_lineage'],
        'semantic_review_sha256': sorted({row['semantic_review_sha256'] for row in baseline if row.get('semantic_review_sha256')}),
        'semantic_exclusions': dict(Counter(row['split'] for row in records if row.get('semantic_review_sha256'))),
        'baseline_freeze_sha256': digest((config['model_release'] / 'freeze.json').read_bytes()),
        'inherited_holdout_count': sum(row['split'] != 'train' and row['origin'] == 'baseline' for row in records),
        'inherited_training_blank_controls': sum(row['split'] == 'train' and row.get('inherited_control', False) for row in records),
        'unrelated_baseline_training_used': False,
        'unsupported_training_targets': len(unsupported),
        'baseline_aliases_superseded': len(superseded),
        'roles': roles,
    }
    for role, batch in [('general', 4), ('names', 32)]:
        checkpoint = bundle / 'starting' / (role + '.pdparams')
        shutil.copyfile(config[role + '_checkpoint'], checkpoint)
        audit[role] = write_recipe(bundle / role, records, config[role + '_template'], checkpoint,
                                  dictionary, name_only=role == 'names', epochs=epochs,
                                  batch_size=batch, seed=20261109 if role == 'general' else 202611091)
    write_jsonl(bundle / 'manifest.jsonl', records)
    for split in ('train', 'val', 'test'):
        write_jsonl(bundle / (split + '.jsonl'), [row for row in records if row['split'] == split])
    write_jsonl(bundle / 'quarantined.jsonl', quarantine)
    write_jsonl(bundle / 'superseded.jsonl', superseded)
    curriculum = build_curriculum(bundle, records, {**config, 'training_root': Path(request['training_root']),
                                                   'roles': roles}, epochs)
    audit['curriculum'] = curriculum['audit']
    audit.update(curriculum['roles'])
    audit['manifest_sha256'] = digest((bundle / 'manifest.jsonl').read_bytes())
    summary = {
        'accepted': selected_counts['accepted'],
        'duplicates': selected_counts['duplicates'], 'rejected': selected_counts['rejected'],
        'reserved': selected_counts['reserved'],
        'train': counts['train'], 'validation': counts['val'], 'test': counts['test'],
        'inherited_holdouts': audit['inherited_holdout_count'],
        'inherited_blank_controls': audit['inherited_training_blank_controls'],
        'selected_training': len(selected_train),
    }
    audit['summary'] = summary
    (bundle / 'audit.json').write_text(json.dumps(audit, indent=2) + '\n')
    return {'bundle': str(bundle), 'source': str(config['source']), 'python': str(config['python']),
            'inference_python': str(config['inference_python']),
            'baseline_general_model': str(config['baseline_general_model']),
            'baseline_names_model': str(config['baseline_names_model']), 'roles': roles, 'summary': summary}


def prepare(request):
    return _prepare(request)


def analyze(request):
    collections, _, _, run = _request(request)
    exported = run / 'collections'
    blockers = []
    prepared = None
    try:
        prepared = _prepare(request, materialize_training=False)
    except (ValueError, OSError, KeyError) as error:
        blockers.append(str(error))
        if not (exported / 'summary.json').is_file():
            _export(dict(request, _materialize_training=False), collections, exported)
    result = prepared_analysis(request, prepared, blockers)
    DataProgress(run)('ready')
    return result


def prepared_analysis(request, prepared, blockers=None):
    collections, _, _, run = _request(request)
    exported = run / 'collections'
    export = json.loads((exported / 'summary.json').read_text())
    samples = read_jsonl(exported / 'samples.jsonl')
    candidates = read_jsonl(exported / 'training_candidates.jsonl')
    dictionary = (Path(prepared.get('dictionary', str(Path(prepared['bundle']) / 'dictionary.txt'))) if prepared else
                  Path(request['training_root']) / 'named-continuation/final/dictionary.txt')
    characters = set(dictionary.read_text().splitlines()) | {' '} if dictionary.is_file() else None
    supported = [row for row in candidates if not any(char in row['label'] for char in '\t\r\n')
                 and (characters is None or set(row['label']) <= characters)]
    accepted_ids = {'named:' + row['dataset_id'] + ':' + row['sample_key'] for row in supported}
    blockers = list(blockers or [])
    partial_path = run / 'preparation-counts.json'
    partial = json.loads(partial_path.read_text()) if partial_path.is_file() else {}
    if partial:
        accepted_ids = set(partial['accepted_identities'])
    if export.get('ai_review_in_progress') and not any('review in progress' in reason for reason in blockers):
        blockers.append('A selected collection has a visual review in progress. Wait for it to finish before training.')
    duplicate_ids = {'named:' + row['sample'] for row in read_jsonl(exported / 'superseded_exact_duplicates.jsonl')}
    collection_counts = partial.get('collections') or _collection_counts(collections, samples, accepted_ids, duplicate_ids=duplicate_ids)
    reasons = Counter()
    reasons['no_current_review_evidence'] = sum(row['pending'] for row in collection_counts)
    for row in samples:
        if not row.get('image_integrity_valid'):
            reasons['crop_integrity_failed'] += 1
        if row.get('needs_contract_review'):
            reasons['outside_current_contract'] += 1
        for reason in ('current_label_conflicts_with_audited_baseline', 'audited_optimization_exclusion'):
            if reason in row.get('training_eligibility_limitations', []):
                reasons[reason] += 1
    for conflict in read_jsonl(exported / 'exact_pixel_conflicts.jsonl'):
        reasons[conflict['reason']] += len(conflict['members'])
    reasons['target_not_encodable_by_frozen_checkpoint'] += len(candidates) - len(supported)
    exclusions = run / 'preparation-exclusions.jsonl'
    if exclusions.is_file():
        for row in read_jsonl(exclusions):
            if row['sample_id'].startswith('named:') and row['reason'] != 'target_not_encodable_by_frozen_checkpoint':
                reasons[row['reason']] += 1
    total = sum(row['total'] for row in collection_counts)
    accepted = partial.get('accepted', len(supported))
    duplicates = export['counts']['superseded_exact_duplicates']
    reserved = sum(row['reserved'] for row in collection_counts)
    reasons['protected_holdout'] = reserved
    result = {
        'ready': prepared is not None and not blockers, 'accepted': accepted, 'duplicates': duplicates,
        'reserved': reserved, 'rejected': max(0, total - accepted - duplicates - reserved),
        'names': sum(row['names'] for row in collection_counts),
        'blanks': sum(row['blanks'] for row in collection_counts),
        'train': partial.get('train', 0), 'validation': partial.get('validation', 0),
        'test': partial.get('test', 0), 'blockers': blockers, 'collections': collection_counts,
        'exclusions': [{'reason': reason, 'count': count} for reason, count in sorted(reasons.items()) if count],
    }
    reservation_path = run / 'split-reservations.json'
    if reservation_path.is_file():
        result['reservations'] = json.loads(reservation_path.read_text())
        for row in result['collections']:
            reservation = result['reservations']['collections'].get(row['id'], {})
            row['reservations'] = {key: reservation.get(key, [] if key == 'reasons' else 0)
                                   for key in ('reserved', 'validation', 'test', 'reasons')}
    if prepared:
        result['inherited_holdouts'] = prepared['summary']['inherited_holdouts']
        result['inherited_blank_controls'] = prepared['summary']['inherited_blank_controls']
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', type=Path)
    args = parser.parse_args()
    request = json.loads(args.request.read_text() if args.request else sys.stdin.read())
    print(json.dumps(analyze(request) if request.get('mode') == 'analyze' else prepare(request)), flush=True)


if __name__ == '__main__':
    main()
