#!/usr/bin/env python3
"""Prepare exact-deduplicated named-collection continuation without training.

Baseline validation/test roles are pinned. New collection sessions are grouped
before splitting, and a session bridging conflicting pinned roles is quarantined
rather than moving historical holdout pixels into training. Sources are read-only.
"""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
import random
import sqlite3
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
import yaml

TOOLS = Path(__file__).resolve().parents[1]
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
from lib.ocr_contract import CONTRACT, CONTRACT_SHA256, category_for_region, validate_text


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def pixels(raw):
    with Image.open(BytesIO(raw)) as image:
        if image.width * image.height > 16_000_000:
            raise ValueError('Image exceeds pixel bound')
        rgb = image.convert('RGB')
        return digest(f'{rgb.width}x{rgb.height}:RGB:'.encode() + rgb.tobytes()), [rgb.width, rgb.height]


def exact_key(row):
    return row['category'], row['pixel_sha256']


class Groups:
    def __init__(self):
        self.parent = {}

    def root(self, value):
        self.parent.setdefault(value, value)
        if self.parent[value] != value:
            self.parent[value] = self.root(self.parent[value])
        return self.parent[value]

    def join(self, left, right):
        a, b = self.root(left), self.root(right)
        if a != b:
            self.parent[max(a, b)] = min(a, b)


def source_bytes(root, row, field, hash_field):
    path = (Path(root) / row[field]).resolve()
    if not path.is_relative_to(Path(root).resolve()):
        raise ValueError('Image escapes its input bundle')
    raw = path.read_bytes()
    if digest(raw) != row[hash_field]:
        raise ValueError(f'Image hash mismatch: {path}')
    return path, raw


def baseline_rows(manifest, root, negative_review=None):
    rows = []
    negative_by_id = {}
    if negative_review:
        review = json.loads(Path(negative_review).read_text())
        if not review.get('complete_visual_audit'):
            raise ValueError('Baseline negative visual audit is incomplete')
        negative_by_id = {str(r['sample_id']): r for r in review['decisions']}
    names = {}
    snapshot = Path(root) / 'database-snapshot.db'
    if snapshot.is_file():
        with sqlite3.connect(snapshot.resolve().as_uri() + '?mode=ro&immutable=1', uri=True) as db:
            names = dict(db.execute('SELECT id,filename FROM full_captures'))
    for original in read_jsonl(manifest):
        if original['split'] not in ('train', 'val', 'test'):
            raise ValueError('Unknown baseline split')
        path, raw = source_bytes(root, original, 'image_path', 'file_sha256')
        pixel_hash, shape = pixels(raw)
        category = category_for_region(original['region_id'])
        if category != original['category']:
            raise ValueError('Baseline region/category mismatch')
        evidence = original.get('review_evidence') or {}
        if not original['label'] and original.get('optimize', True):
            if evidence.get('source_file_sha256') != digest(raw):
                evidence = negative_by_id.get(str(original['sample_id']), {})
            if not evidence.get('visually_reviewed') or evidence.get('source_file_sha256') != digest(raw):
                raise ValueError('Baseline blank lacks hash-bound visual review')
            if evidence.get('decision') != 'negative':
                raise ValueError('Baseline blank disagrees with its current visual audit')
        groups = []
        if original.get('source_id') is not None:
            filename = names.get(original['source_id'])
            groups.append('legacy:capture:' + (filename or str(original['source_id'])))
        session = original.get('capture_session')
        if session is not None:
            groups.append('legacy:session:' + str(session))
        rows.append({**deepcopy(original), 'sample_id': 'baseline:' + str(original['sample_id']),
                     'baseline_sample_id': str(original['sample_id']), 'dataset_id': 'legacy',
                     'sample_key': original.get('filename', str(original['sample_id'])),
                     'origin': 'baseline', 'source_image': str(path), 'file_sha256': digest(raw),
                     'pixel_sha256': pixel_hash, 'image_dimensions': shape, 'groups': groups,
                     'observation_timestamp': original.get('timestamp'), 'pinned_split': original['split'],
                     'optimize': original.get('optimize', True), 'label_evidence': 'audited_baseline',
                     'review_evidence': evidence,
                     'validation_contract': {'version': CONTRACT['version'], 'sha256': CONTRACT_SHA256}})
    return rows


def collection_rows(export):
    export = Path(export)
    summary = json.loads((export / 'summary.json').read_text()) if (export / 'summary.json').exists() else {}
    metadata_only = summary.get('images_materialized') is False
    if metadata_only:
        for name in ('samples.jsonl', 'training_candidates.jsonl', 'exact_pixel_conflicts.jsonl'):
            if digest((export / name).read_bytes()) != summary.get('manifest_sha256', {}).get(name):
                raise ValueError('Verified audit snapshot metadata changed')
    candidates = read_jsonl(export / 'training_candidates.jsonl')
    inventory = read_jsonl(export / 'samples.jsonl')
    conflicts = read_jsonl(export / 'exact_pixel_conflicts.jsonl')
    blocked_groups = {row['exact_pixel_group'] for row in conflicts}
    blocked = {exact_key(row) for row in inventory if row.get('pixel_sha256') and (
        row.get('ai_review_blocked') or row.get('exact_pixel_group') in blocked_groups)}
    # Capture times, not label/review timestamps, define sessions. All inventory
    # observations participate, including excluded crops between eligible rows.
    captures = defaultdict(dict)
    for row in inventory:
        p = row.get('provenance') or {}
        stamp = p.get('source_capture_timestamp')
        if p.get('capture_group') and isinstance(stamp, (int, float)) and not isinstance(stamp, bool):
            captures[row['dataset_id']][p['capture_group']] = stamp
    inferred = {}
    for dataset, capture_times in captures.items():
        previous = None; session = None
        for capture, stamp in sorted(capture_times.items(), key=lambda pair: (pair[1], pair[0])):
            if previous is None or stamp - previous > 600_000:
                session = digest(capture.encode())[:24]
            inferred[capture] = f'{dataset}:inferred-session-start:{session}'
            previous = stamp
    rows = []
    for original in candidates:
        if not original.get('eligible_for_training'):
            raise ValueError('Candidate manifest contains an ineligible row')
        if metadata_only:
            path = (export / original['image']).resolve()
            if not path.is_relative_to(export.resolve()) or not original.get('image_integrity_valid'):
                raise ValueError('Audit crop identity is invalid')
            pixel_hash, shape = original['pixel_sha256'], original['image_dimensions']
            file_hash = original['image_sha256']
        else:
            path, raw = source_bytes(export, original, 'image', 'image_sha256')
            pixel_hash, shape = pixels(raw)
            file_hash = digest(raw)
        if pixel_hash != original['pixel_sha256'] or shape != original['image_dimensions']:
            raise ValueError('Candidate decoded-pixel identity changed')
        p = original.get('provenance') or {}
        groups = list(p.get('duplicate_capture_groups') or [])
        if p.get('capture_group'):
            groups.append(p['capture_group'])
        if p.get('split_group'):
            groups.append('export:' + p['split_group'])
        session_groups = {inferred[g] for g in groups if g in inferred}
        if p.get('session_id') is not None:
            session_groups.add(f"{original['dataset_id']}:session:{p['session_id']}")
        groups.extend(sorted(session_groups))
        known = set(p.get('duplicate_known_splits') or [])
        if p.get('split'):
            known.add(p['split'])
        if known - {'train', 'val', 'test', 'holdout', 'challenge'}:
            raise ValueError('Unrecognized named-data split annotation')
        rows.append({**deepcopy(original), 'sample_id': 'named:' + original['dataset_id'] + ':' + original['sample_key'],
                     'origin': 'named', 'source_image': str(path), 'file_sha256': file_hash,
                     'groups': sorted(set(groups)), 'known_splits': sorted(known),
                     'fresh_session_groups': sorted(session_groups), 'optimize': True})
    return rows, blocked, {'inventory_rows': len(inventory), 'export_conflict_groups': len(conflicts),
                           'export_summary': json.loads((export / 'summary.json').read_text()) if (export / 'summary.json').exists() else None}


def prepare_records(baseline, named, blocked):
    """Resolve labels, preserve holdout roles, and reject incompatible session edges."""
    quarantine = []; superseded = []; by_pixel = defaultdict(list)
    for row in baseline + named:
        by_pixel[exact_key(row)].append(row)
    pinned_by_pixel = defaultdict(set); pinned_by_group = defaultdict(set)
    for row in baseline:
        pinned_by_pixel[exact_key(row)].add(row['pinned_split'])
        for group in row['groups']:
            pinned_by_group[group].add(row['pinned_split'])
    if any(len(v) > 1 for v in pinned_by_pixel.values()) or any(len(v) > 1 for v in pinned_by_group.values()):
        raise ValueError('Audited baseline itself crosses fixed partitions')
    # A new session that copies both training and holdout pixels cannot be added
    # without moving a pinned role. Quarantine that new session, keep old roles.
    graph = Groups()
    for row in named:
        for group in row['groups']:
            graph.join(row['sample_id'], 'group:' + group)
        graph.join(row['sample_id'], 'pixel:' + '|'.join(exact_key(row)))
    members = defaultdict(list)
    for row in named:
        members[graph.root(row['sample_id'])].append(row)
    assignments = {}; fresh_components = []
    for component, rows in members.items():
        roles = set()
        for row in rows:
            roles.update(pinned_by_pixel[exact_key(row)])
            for group in row['groups']:
                roles.update(pinned_by_group[group])
            roles.update(row['known_splits'])
        if roles & {'holdout', 'challenge'} or len(roles) > 1:
            for row in rows:
                quarantine.append({'sample_id': row['sample_id'], 'reason': 'new_capture_component_bridges_pinned_roles', 'roles': sorted(roles)})
            continue
        if roles:
            assignments[component] = next(iter(roles))
        elif all(row['fresh_session_groups'] and (row.get('provenance') or {}).get('capture_group') for row in rows):
            fresh_components.append(component)
        else:
            assignments[component] = 'train'
    # At least three independent source sessions are needed before withholding
    # fresh sessions. Otherwise retain historical heldouts and report this limit.
    fresh_components.sort(key=lambda c: (max((r.get('observation_timestamp') or 0) for r in members[c]), c))
    for component in fresh_components:
        assignments[component] = 'train'
    if len(fresh_components) >= 3:
        assignments[fresh_components[-1]] = 'test'
        assignments[fresh_components[-2]] = 'val'
    eligible_named = []
    for row in named:
        component = graph.root(row['sample_id'])
        if component in assignments:
            row = dict(row, split=assignments[component], fresh_component=component)
            eligible_named.append(row)
    named_by_id = {row['sample_id']: row for row in eligible_named}
    named_ids = set(named_by_id)
    output = []
    for key, group in sorted(by_pixel.items()):
        valid = [row for row in group if row['origin'] == 'baseline' or row['sample_id'] in named_ids]
        valid = [named_by_id.get(row['sample_id'], row) for row in valid]
        if not valid:
            continue
        if key in blocked:
            for row in valid:
                quarantine.append({'sample_id': row['sample_id'], 'reason': 'current_ai_or_export_conflict_blocks_exact_pixels'})
            continue
        baseline_group = [r for r in valid if r['origin'] == 'baseline']
        new = [r for r in valid if r['origin'] == 'named']
        # Existing false optimization flags (including clipped baseline examples)
        # are never overridden by a newer alias.
        forbidden = any(not r.get('optimize', True) for r in baseline_group)
        labels = {r['label'] for r in valid}
        timestamp = lambda r: r.get('observation_timestamp') if isinstance(r.get('observation_timestamp'), (int, float)) else -1
        authoritative = [r for r in new if r.get('reviewed') and (
            (r.get('ai_review') or {}).get('successful_current_check') or r.get('label_evidence') in ('durable_human_review_event', 'assistant_visual_review'))]
        latest = max(authoritative, key=lambda r: (timestamp(r), r['sample_id'])) if authoritative else None
        if len(labels) > 1 and not (latest and timestamp(latest) > max((timestamp(r) for r in baseline_group), default=-1)):
            for row in valid:
                quarantine.append({'sample_id': row['sample_id'], 'reason': 'unresolved_cross_export_label_conflict', 'labels': sorted(labels)})
            continue
        def priority(row):
            return (int(bool((row.get('ai_review') or {}).get('successful_current_check'))), timestamp(row), int(row['origin'] == 'named'), row['sample_id'])
        winner = latest if len(labels) > 1 else max(valid, key=priority)
        if len(labels) > 1 and any(r['label'] != winner['label'] and r['origin'] == 'named' and timestamp(r) >= timestamp(winner) for r in valid):
            for row in valid:
                quarantine.append({'sample_id': row['sample_id'], 'reason': 'conflicting_newer_named_label'})
            continue
        roles = {r.get('split', r.get('pinned_split')) for r in valid}
        if len(roles) != 1:
            raise ValueError('Exact-pixel canonicalization would cross partitions')
        row = deepcopy(winner); row['split'] = next(iter(roles)); row['optimize'] = not forbidden
        row['aliases'] = [{'sample_id': r['sample_id'], 'dataset_id': r['dataset_id'], 'label': r['label'],
                           'origin': r['origin'], 'split': r.get('split', r.get('pinned_split')),
                           'baseline_sample_id': r.get('baseline_sample_id')} for r in valid]
        row['groups'] = sorted({g for r in valid for g in r['groups']})
        row['label_conflict_resolved'] = len(labels) > 1
        for old in valid:
            if old['sample_id'] != winner['sample_id']:
                superseded.append({'sample_id': old['sample_id'], 'canonical': winner['sample_id'], 'prior_label': old['label'], 'label': winner['label'], 'split': row['split']})
        output.append(row)
    # Final graph verifies transitive capture/session AND exact-pixel separation.
    final = Groups()
    for row in output:
        for group in row['groups']:
            final.join(row['sample_id'], 'group:' + group)
        final.join(row['sample_id'], 'pixel:' + '|'.join(exact_key(row)))
    roles = defaultdict(set)
    for row in output:
        roles[final.root(row['sample_id'])].add(row['split'])
    if any(len(v) > 1 for v in roles.values()):
        raise ValueError('Capture/session aliases cross partitions after canonicalization')
    for row in output:
        row['group_id'] = 'component:' + digest(final.root(row['sample_id']).encode())
    return output, quarantine, superseded, {'fresh_source_components': len(fresh_components),
        'fresh_session_holdouts_created': len(fresh_components) >= 3,
        'fresh_labels_independently_human_verified': False}


def add_retention(rows, manifest, review, selected_list, heldout_labels):
    """Reuse only previously selected, hash-checked, training-source glyph renders."""
    if manifest is None:
        return [], {'enabled': False, 'reason': 'No validated existing repetition manifest supplied'}
    root = Path(manifest).parent
    audit = json.loads(Path(review).read_text())
    if audit.get('reviewed_glyphs') != 12 or audit.get('conflicting_exact_pixel_groups'):
        raise ValueError('Existing repetition glyph audit is incomplete')
    source_train = {a['baseline_sample_id'] for r in rows if r['split'] == 'train' and r.get('optimize', True)
                    for a in r['aliases'] if a.get('baseline_sample_id') and a['label'] == r['label']}
    by_path = {str((root / r['image_path']).resolve()): r for r in read_jsonl(manifest)}
    selected = {}
    for line in Path(selected_list).read_text().splitlines():
        path, label = line.split('\t', 1)
        if path in by_path:
            if by_path[path]['label'] != label:
                raise ValueError('Existing retention list disagrees with its manifest')
            selected[path] = by_path[path]
    kept = []; rejected = Counter(); existing_pixels = {r['pixel_sha256'] for r in rows}
    for path, original in sorted(selected.items()):
        if original['split'] != 'train' or not original.get('glyph_sources') or not set(original['glyph_sources']) <= source_train:
            rejected['glyph_source_not_current_training'] += 1; continue
        if original['label'] in heldout_labels:
            rejected['heldout_or_challenge_label'] += 1; continue
        _, raw = source_bytes(root, original, 'image_path', 'file_sha256')
        key, shape = pixels(raw)
        if key in existing_pixels:
            rejected['exact_pixel_duplicate'] += 1; continue
        existing_pixels.add(key)
        kept.append({**original, 'sample_id': 'retention:' + str(original['sample_id']), 'parent_sample_id': None,
                     'origin': 'retention', 'source_image': path, 'pixel_sha256': key, 'image_dimensions': shape,
                     'group_id': 'retention:' + str(original['sample_id']), 'split': 'train', 'optimize': True,
                     'label_evidence': 'existing_reviewed_training_glyph_render', 'aliases': [], 'groups': []})
    return kept, {'enabled': True, 'selected_existing_renders': len(selected), 'kept': len(kept), 'rejected': dict(rejected),
                  'manifest_sha256': digest(Path(manifest).read_bytes()), 'review_sha256': digest(Path(review).read_bytes()),
                  'selected_list_sha256': digest(Path(selected_list).read_bytes()), 'constructed_blanks_added': 0}


def constructed_blank_arrays(palette_bgr, split, count):
    """Replay the old no-foreground construction in memory solely to verify it."""
    seeds={'train':202611072,'val':202611073}
    if split not in seeds:
        raise ValueError('Constructed blank controls retain train/val roles only')
    colors=np.asarray(palette_bgr,dtype=np.int16)
    if colors.shape!=(3,3) or np.any(colors<0) or np.any(colors>255):
        raise ValueError('Invalid audited blank palette')
    rng=np.random.default_rng(seeds[split])
    for index in range(count):
        width=int(rng.integers(150,221));height=32
        boundary=int(rng.integers(0,width+1));choice=rng.integers(0,3,size=2)
        image=np.empty((height,width,3),dtype=np.int16)
        image[:,:boundary]=colors[choice[0]];image[:,boundary:]=colors[choice[1]]
        image=np.clip(image+rng.integers(-2,3,image.shape),0,255).astype('uint8')
        yield index,image[:,:,::-1].copy()


def add_blank_controls(rows, source_root, train_list, val_list):
    """Retain existing audited blank PNGs, never synthesize replacement images.

    The historical audit did not contain individual PNG hashes. Exact replay of
    its seeded palette/boundary/noise-only algorithm establishes construction
    identity; source PNG and decoded-pixel hashes bind the retained snapshot.
    These controls are not real collector negatives or human capture evidence.
    """
    root=Path(source_root).resolve();blank_dir=root/'blank-plates'
    audit_path=root/'audit.json';review_path=root/'blank-review.json';parents_path=root/'parent-name-manifest.json'
    audit=json.loads(audit_path.read_text());review=json.loads(review_path.read_text());parents=json.loads(parents_path.read_text())
    if not (review.get('palette_verified') and review.get('blank_contact_visually_reviewed')):
        raise ValueError('Existing blank construction/palette review is incomplete')
    if review.get('configured_colors_sha256')!=audit.get('palette_source_sha256'):
        raise ValueError('Blank palette audit hashes disagree')
    counts={split:audit.get('constructed_blank_'+split) for split in ('train','val')}
    if any(isinstance(n,bool) or not isinstance(n,int) or not 1<=n<=10_000 for n in counts.values()):
        raise ValueError('Invalid audited blank control counts')
    if not all(isinstance(parents.get(split),list) for split in ('train','val','test')):
        raise ValueError('Existing name parent manifest is incomplete')
    if len(parents['val'])!=audit.get('real_val'):
        raise ValueError('Historical real-name validation provenance changed')
    source_audit_sha=digest(audit_path.read_bytes())
    source_review_sha=digest(review_path.read_bytes())
    parent_manifest_sha=digest(parents_path.read_bytes())
    occupied={r['pixel_sha256']:r['split'] for r in rows}
    kept=[];source_records=[]
    for split,list_path in [('train',Path(train_list)),('val',Path(val_list))]:
        selected_list_sha=digest(list_path.read_bytes())
        expected_paths={str(blank_dir/f'{split}-{index:04}.png') for index in range(counts[split])}
        selected={};real_val=[]
        for line in list_path.read_text().splitlines():
            path,label=line.split('\t',1);path=Path(path).resolve()
            if not label:
                if str(path) not in expected_paths:
                    raise ValueError('Blank control path is outside its audited role whitelist')
                if str(path) in selected:
                    raise ValueError('Duplicate blank entry in original selected list')
                selected[str(path)]=label
            elif split=='val':
                real_val.append((digest(path.read_bytes()),label))
        if set(selected)!=expected_paths:
            raise ValueError('Original selected list does not contain every audited blank control')
        if split=='val':
            parent_val=[(r['file_sha256'],r['label']) for r in parents['val']]
            if sorted(real_val)!=sorted(parent_val):
                raise ValueError('Validation list differs from the reviewed real-name parent manifest')
        for index,expected_rgb in constructed_blank_arrays(audit['blank_palette_bgr'],split,counts[split]):
            path=blank_dir/f'{split}-{index:04}.png';raw=path.read_bytes()
            with Image.open(BytesIO(raw)) as image:
                actual=np.asarray(image.convert('RGB'))
            if not np.array_equal(actual,expected_rgb):
                raise ValueError(f'Existing blank pixels no longer match their no-text construction: {path}')
            pixel_hash,shape=pixels(raw)
            if pixel_hash in occupied:
                raise ValueError('Constructed blank control duplicates existing train/holdout pixels')
            occupied[pixel_hash]=split
            provenance={'kind':'synthetic_constructed_blank','source_audit_sha256':source_audit_sha,
                        'source_review_sha256':source_review_sha,'parent_manifest_sha256':parent_manifest_sha,
                        'palette_source_sha256':audit['palette_source_sha256'],'selected_list_sha256':selected_list_sha,
                        'seed':202611072 if split=='train' else 202611073,'index':index,
                        'decoded_pixels_match_original_construction':True,'foreground_glyphs_rendered':False,
                        'real_capture_evidence':False}
            record={'sample_id':f'blank-retention:{split}:{index:04}','category':'name','region_id':'synthetic.name',
                    'label':'','split':split,'origin':'blank_retention','source_image':str(path),
                    'file_sha256':digest(raw),'pixel_sha256':pixel_hash,'image_dimensions':shape,
                    'group_id':'constructed-control:'+pixel_hash,'optimize':True,'aliases':[],'groups':[],
                    'label_evidence':'synthetic_constructed_blank','constructed_control':True,'visually_verified':False,
                    'blank_construction':provenance}
            kept.append(record);source_records.append({k:record[k] for k in ('sample_id','source_image','file_sha256','pixel_sha256','split')})
    return kept,{'enabled':True,'counts':counts,'source_root':str(root),'source_files':source_records,
                 'new_images_generated':False,'source_audit_sha256':source_audit_sha,
                 'source_review_sha256':source_review_sha,'parent_manifest_sha256':parent_manifest_sha,
                 'verification':'Exact decoded RGB replay of original palette/boundary/noise-only construction; original PNG byte hashes retained',
                 'real_capture_evidence':False,'cross_split_pixel_duplicates':0}


def write_jsonl(path, rows):
    Path(path).write_text(''.join(json.dumps(row, sort_keys=True) + '\n' for row in rows))


def write_contact_sheet(output, rows, name):
    """Inspection aid only; drawing a sheet never promotes visual evidence."""
    examples = []
    seen = defaultdict(set)
    for row in sorted(rows, key=lambda r: (r['origin'] != 'named', r['category'], r['sample_id'])):
        key = (row['origin'], row['category'], bool(row['label']))
        if len(seen[key]) < 2 and row['label'] not in seen[key]:
            examples.append(row); seen[key].add(row['label'])
    examples = examples[:40]
    columns, width, height = 4, 340, 170
    image = Image.new('RGB', (columns*width, max(1,math.ceil(len(examples)/columns))*height), '#151719')
    draw = ImageDraw.Draw(image)
    font_path = '/usr/share/fonts/TTF/DejaVuSansMono.ttf'
    try: font = ImageFont.truetype(font_path, 14)
    except OSError: font = ImageFont.load_default()
    for index, row in enumerate(examples):
        x, y = index%columns*width, index//columns*height
        draw.rectangle((x,y,x+width-1,y+height-1),outline='#455054')
        draw.text((x+8,y+7), (row['origin']+' / '+row['category'])[:38],font=font,fill='#b8c4c6')
        with Image.open(output/row['image_path']) as source:
            crop = source.convert('RGB');scale=min((width-16)/crop.width,95/crop.height,2)
            crop=crop.resize((max(1,round(crop.width*scale)),max(1,round(crop.height*scale))),Image.Resampling.NEAREST)
            image.paste(crop,(x+(width-crop.width)//2,y+27+(95-crop.height)//2))
        draw.text((x+8,y+128),(row['label'] or '(empty target)')[:38],font=font,fill='#e2ecee')
        draw.text((x+8,y+149),row['split']+(' / excluded' if not row['optimize'] else ''),font=font,fill='#b8c4c6')
    path=output/name;image.save(path)
    return {'path':name,'examples':len(examples),'scope':'Sampled inspection aid; not full visual verification'}


def write_recipe(output, rows, template, checkpoint, dictionary, *, name_only, epochs, batch_size, seed, materialize=True):
    if materialize:
        output.mkdir(parents=True, exist_ok=True)
    config = yaml.safe_load(Path(template).read_text())
    checkpoint = Path(checkpoint).resolve()
    if not checkpoint.is_file() or not Path(dictionary).is_file():
        raise ValueError('Recipe requires an existing starting checkpoint and dictionary')
    characters = set(Path(dictionary).read_text().splitlines()) | {' '}
    selected = [r for r in rows if not name_only or r['category'] == 'name']
    if name_only and not any(r['split']=='train' and r['label']=='' for r in selected):
        raise ValueError('Name continuation requires retained blank training controls')
    for row in selected:
        if not isinstance(row['label'], str) or '\n' in row['label'] or '\r' in row['label'] or '\t' in row['label']:
            raise ValueError('Unsafe Paddle label encoding')
        if not set(row['label']) <= characters:
            raise ValueError('Label contains characters outside checkpoint dictionary')
        if not validate_text(row['category'], row['label'], allow_blank=True):
            raise ValueError('Prepared label is outside the current storage contract')
    config['Global'].update(epoch_num=epochs, pretrained_model=str(checkpoint), checkpoints=None, seed=seed,
        use_gpu=True, distributed=False,
        save_model_dir=str(output / 'checkpoints'), save_inference_dir=str(output / 'export'),
        character_dict_path=str(Path(dictionary).resolve()), eval_batch_step=[0, max(1, math.ceil(sum(r['split']=='train' and r['optimize'] for r in selected)/batch_size))])
    config['Optimizer']['lr']['learning_rate'] = 1e-5
    config['Loss'] = {'name': 'CollectorBlankCTCLoss'}
    config['Metric'].update(ignore_space=False, is_filter=False)
    for split, key in [('train', 'Train'), ('val', 'Eval')]:
        part = [r for r in selected if r['split'] == split and r['optimize']]
        if not part:
            raise ValueError(f'Recipe has no optimized {split} examples')
        if split == 'train':
            random.Random(seed).shuffle(part)
        label_file = output / (split + '.txt')
        if materialize:
            label_file.write_text(''.join(str(output.parent / r['image_path']) + '\t' + r['label'] + '\n' for r in part))
        config[key]['dataset'].update(data_dir=str(output.parent), label_file_list=[str(label_file)], ratio_list=[1.0])
        transforms = config[key]['dataset']['transforms']
        if any(next(iter(t)) not in {'DecodeImage','CollectorCTCLabelEncode','RecResizeImg','KeepKeys'} for t in transforms):
            raise ValueError('Template contains an unreviewed augmentation or label transform')
        config[key]['loader'].update(shuffle=split == 'train', batch_size_per_card=batch_size, drop_last=False)
    if materialize:
        (output / 'test.txt').write_text(''.join(str(output.parent / r['image_path']) + '\t' + r['label'] + '\n' for r in selected if r['split'] == 'test'))
        (output / 'train.yml').write_text(yaml.safe_dump(config, sort_keys=False))
        write_jsonl(output / 'manifest.jsonl', selected)
    return {'counts': dict(Counter(r['split'] for r in selected)), 'optimized_counts': dict(Counter(r['split'] for r in selected if r['optimize'])),
            'starting_checkpoint': str(checkpoint), 'starting_checkpoint_sha256': digest(checkpoint.read_bytes()),
            'template_sha256': digest(Path(template).read_bytes()), 'global_shuffle': True,
            'name_high_resolution': bool(config['Global'].get('collector_name_high_resolution')), 'batch_size': batch_size}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline-manifest', type=Path, required=True)
    parser.add_argument('--baseline-root', type=Path, required=True)
    parser.add_argument('--negative-review', type=Path, default=TOOLS/'training/verified-negative-review.json')
    parser.add_argument('--export', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--general-template', type=Path, required=True)
    parser.add_argument('--general-checkpoint', type=Path, required=True)
    parser.add_argument('--name-template', type=Path, required=True)
    parser.add_argument('--name-checkpoint', type=Path, required=True)
    parser.add_argument('--dictionary', type=Path, required=True)
    parser.add_argument('--retention-manifest', type=Path)
    parser.add_argument('--retention-review', type=Path)
    parser.add_argument('--retention-selected-list', type=Path)
    parser.add_argument('--blank-source-root', type=Path)
    parser.add_argument('--blank-retention-list', type=Path)
    parser.add_argument('--blank-retention-val-list', type=Path)
    parser.add_argument('--challenge-manifest', type=Path)
    parser.add_argument('--epochs', type=int, default=6)
    parser.add_argument('--general-batch-size', type=int, default=4)
    parser.add_argument('--name-batch-size', type=int, default=32)
    parser.add_argument('--allow-provisional', action='store_true', help='Prepare an explicitly non-trainable snapshot while AI review is still running')
    args = parser.parse_args(argv)
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    old = baseline_rows(args.baseline_manifest, args.baseline_root, args.negative_review)
    new, blocked, export_audit = collection_rows(args.export)
    provisional = bool((export_audit.get('export_summary') or {}).get('ai_review_in_progress'))
    if provisional and not args.allow_provisional:
        raise ValueError('AI review is still running; wait for a final export, or explicitly prepare --allow-provisional for inspection only')
    rows, quarantined, superseded, partition_audit = prepare_records(old, new, blocked)
    heldout_labels = {r['label'] for r in rows if r['split'] != 'train'}
    if args.challenge_manifest:
        heldout_labels.update(r['label'] for r in read_jsonl(args.challenge_manifest))
    if args.retention_manifest and not all((args.retention_review, args.retention_selected_list)):
        raise ValueError('Retention requires its glyph audit and prior selected training list')
    retention, retention_audit = add_retention(rows, args.retention_manifest, args.retention_review,
                                               args.retention_selected_list, heldout_labels)
    rows += retention
    if any((args.blank_source_root,args.blank_retention_list,args.blank_retention_val_list)):
        if not all((args.blank_source_root,args.blank_retention_list,args.blank_retention_val_list)):
            raise ValueError('Blank controls require source audit root plus original train and validation lists')
        controls,blank_audit=add_blank_controls(rows,args.blank_source_root,args.blank_retention_list,args.blank_retention_val_list)
        rows+=controls
    else:
        blank_audit={'enabled':False,'counts':{'train':0,'val':0}}
    for row in rows:
        raw = Path(row['source_image']).read_bytes()
        if digest(raw) != row['file_sha256']:
            raise ValueError('Source PNG changed during preparation')
        target = output / 'images' / (row['file_sha256'] + '.png')
        target.parent.mkdir(exist_ok=True)
        if not target.exists(): target.write_bytes(raw)
        row['image_path'] = target.relative_to(output).as_posix()
        row['parent_sample_id'] = row['sample_id']
    audit = {'baseline_rows': len(old), 'named_candidates': len(new), 'canonical_rows': len(rows),
             'superseded_rows': len(superseded), 'quarantined_rows': len(quarantined), 'blocked_exact_groups': len(blocked),
             'counts': dict(Counter(r['split'] for r in rows)), 'category_counts': dict(Counter(r['category'] for r in rows)),
             'retention': retention_audit, 'partition': partition_audit, 'export': export_audit,
             'blank_retention':blank_audit,
             'baseline_manifest_sha256': digest(args.baseline_manifest.read_bytes()),
             'candidate_manifest_sha256': digest((args.export/'training_candidates.jsonl').read_bytes()),
             'validation_contract': {'version': CONTRACT['version'], 'sha256': CONTRACT_SHA256},
             'raw_pixels': True, 'synthetic_labels_created': False, 'training_run': False,
             'independent_production_acceptance': False, 'training_ready': not provisional,
             'provisional_ai_review_snapshot': provisional,
             'baseline_original_split_counts': dict(Counter(r['split'] for r in old)),
             'baseline_preserved_alias_split_counts': dict(Counter(a['split'] for r in rows for a in r.get('aliases',[]) if a['origin']=='baseline')),
             'baseline_quarantined_holdout_ids': [r['sample_id'] for r in old if r['split']!='train' and any(q['sample_id']==r['sample_id'] for q in quarantined)]}
    dictionary = output / 'dictionary.txt'; dictionary.write_bytes(args.dictionary.read_bytes())
    audit['general'] = write_recipe(output/'general', rows, args.general_template, args.general_checkpoint, dictionary,
                                     name_only=False, epochs=args.epochs, batch_size=args.general_batch_size, seed=20261109)
    audit['names'] = write_recipe(output/'names', rows, args.name_template, args.name_checkpoint, dictionary,
                                   name_only=True, epochs=args.epochs, batch_size=args.name_batch_size, seed=202611091)
    audit['contact_sheets'] = [write_contact_sheet(output,rows,'contact-general.png'),
                              write_contact_sheet(output,[r for r in rows if r['category']=='name'],'contact-names.png')]
    write_jsonl(output/'manifest.jsonl', rows); write_jsonl(output/'quarantined.jsonl', quarantined)
    write_jsonl(output/'superseded.jsonl', superseded)
    for split in ('train','val','test'):
        write_jsonl(output/(split+'.jsonl'), [r for r in rows if r['split']==split])
    (output/'audit.json').write_text(json.dumps(audit, indent=2, sort_keys=True))
    if provisional:
        (output/'DO_NOT_TRAIN.md').write_text('This is a provisional inspection snapshot. AI review was running during export. Re-export and rebuild after completion before training.\n')
    print(json.dumps({k:v for k,v in audit.items() if k!='export'}, indent=2))
    return audit


if __name__ == '__main__':
    main()
