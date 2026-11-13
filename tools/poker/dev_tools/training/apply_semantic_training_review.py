#!/usr/bin/env python3
"""Create a separate continuation bundle from hash-bound visual semantic review.

Literal OCR targets and source capture partitions are immutable. Semantic name
markers remain available in the manifest and test lists, but are removed from
both training and training-validation lists for every recipe containing names.
This command prepares data and configuration only; it never starts training.
"""
import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil

from PIL import Image
import yaml


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_rows(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def write_rows(path, rows):
    Path(path).write_text(''.join(json.dumps(row, sort_keys=True) + '\n' for row in rows))


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def inside(root, relative):
    path = (root / relative).resolve()
    require(path.is_relative_to(root), 'Image or evidence path escapes bundle')
    return path


def image_identity(path):
    with Image.open(path) as image:
        require(image.width * image.height <= 16_000_000, 'Image exceeds pixel bound')
        rgb = image.convert('RGB')
        return hashlib.sha256(f'{rgb.width}x{rgb.height}:RGB:'.encode() + rgb.tobytes()).hexdigest(), [rgb.width, rgb.height]


def list_entries(path, root):
    entries = []
    for line in path.read_text().splitlines():
        require('\t' in line, 'Invalid source label list')
        image, label = line.split('\t', 1)
        relative = Path(image).resolve().relative_to(root).as_posix()
        entries.append((relative, label))
    return entries


def build(source, review_path, output, *, expected_count=36,
          expected_split_counts=None):
    """Validate all inputs before creating an exclusive, disposable output tree."""
    source, review_path, output = map(lambda p: Path(p).resolve(), (source, review_path, output))
    require(not output.exists(), 'Output already exists; refusing to overwrite')
    require(not output.is_relative_to(source) and not source.is_relative_to(output),
            'Source and output must be separate bundles')
    expected_split_counts = expected_split_counts or {'train': 32, 'val': 2, 'test': 2}
    manifest = source / 'manifest.jsonl'
    source_sha, review_sha = sha(manifest), sha(review_path)
    rows, reviews = read_rows(manifest), read_rows(review_path)
    source_audit = json.loads((source / 'audit.json').read_text())
    require(source_audit.get('training_ready') is True, 'Source audit is not training ready')
    by_id = {r['sample_id']: r for r in rows}
    require(len(by_id) == len(rows), 'Duplicate source sample IDs')
    require(all(r['split'] in ('train', 'val', 'test') for r in rows), 'Unknown source partition')
    selected = {r['sample_id']: r for r in rows if r['category'] == 'name' and r['label'] == 'Winner'}
    require(len(selected) == expected_count, 'Unexpected exact Winner coverage')
    require(dict(Counter(r['split'] for r in selected.values())) == expected_split_counts,
            'Unexpected reviewed source split counts')
    require(len(reviews) == expected_count and len({r['sample_id'] for r in reviews}) == expected_count,
            'Duplicate or incomplete review coverage')
    require({r['sample_id'] for r in reviews} == set(selected), 'Review does not exactly cover source Winner rows')
    source_paths = [manifest, source / 'audit.json', source / 'dictionary.txt']
    evidence_pages = {}
    for review in reviews:
        row = selected[review['sample_id']]
        require(review.get('source_manifest') == str(manifest) and review.get('source_manifest_sha256') == source_sha,
                'Stale review source manifest identity')
        require(review.get('source_manifest_line') == rows.index(row) + 1, 'Review source line mismatch')
        for key in ('category', 'label', 'split', 'origin', 'region_id', 'pixel_sha256'):
            require(review.get(key) == row.get(key), f'Review {key} mismatch')
        require(review.get('source_file_sha256') == row['file_sha256'], 'Review file hash mismatch')
        require(review.get('source_image') == str(inside(source, row['image_path'])), 'Review source image mismatch')
        identity = review.get('pixel_identity') or {}
        require(identity.get('sha256') == row['pixel_sha256'] and identity.get('dimensions') == row['image_dimensions'],
                'Review pixel identity mismatch')
        require(review.get('label_preserved') is True and review.get('split_preserved') is True,
                'Review does not preserve label/partition')
        require(review.get('visually_reviewed') is True and review.get('reviewer') == 'assistant_visual',
                'Review lacks explicit assistant visual evidence')
        require(review.get('semantic_role') == 'transient_winner_status_marker' and
                review.get('decision') == 'exclude_from_name_optimization' and
                review.get('visual_transcription') == 'Winner' and review.get('text_complete') is True and
                review.get('literal_label_matches_visible_text') is True and
                review.get('clipped_or_ambiguous') is False, 'Review semantic decision is not unambiguous')
        page = inside(review_path.parent, review['evidence_page'])
        require(sha(page) == review.get('evidence_page_sha256'), 'Visual evidence page hash mismatch')
        evidence_pages[page] = sha(page)
    require(len({(r['evidence_page'], r['evidence_cell']) for r in reviews}) == expected_count,
            'Repeated visual evidence cells')

    # Verify every retained image, including controls and all held-out examples.
    image_hashes = {}
    for row in rows:
        path = inside(source, row['image_path'])
        require(path.is_file(), 'Missing source image')
        identity = (row['file_sha256'], row['pixel_sha256'], row['image_dimensions'])
        if path not in image_hashes:
            require(sha(path) == row['file_sha256'], 'Source image hash mismatch')
            pixels, shape = image_identity(path)
            require(pixels == row['pixel_sha256'] and shape == row['image_dimensions'], 'Source pixel identity mismatch')
            image_hashes[path] = identity
        require(image_hashes[path] == identity, 'Inconsistent shared image identity')
        require(isinstance(row['label'], str) and not any(c in row['label'] for c in '\t\r\n'), 'Unsafe label')
    characters = set((source / 'dictionary.txt').read_text().splitlines()) | {' '}
    require(all(set(r['label']) <= characters for r in rows), 'Label outside dictionary')

    configs, old_lists = {}, {}
    for role in ('general', 'names'):
        role_rows = [r for r in rows if role == 'general' or r['category'] == 'name']
        role_manifest = source / role / 'manifest.jsonl'
        require(read_rows(role_manifest) == role_rows, 'Source role manifest differs from full manifest')
        source_paths.append(role_manifest)
        config_path = source / role / 'train.yml'
        config = yaml.safe_load(config_path.read_text())
        checkpoint = Path(config['Global']['pretrained_model']).resolve()
        prior = source_audit[role]
        require(str(checkpoint) == prior['starting_checkpoint'] and sha(checkpoint) == prior['starting_checkpoint_sha256'],
                'Starting checkpoint differs from source audit')
        require(not config['Global'].get('checkpoints'), 'Source resume checkpoint must be empty')
        source_paths.extend((config_path, checkpoint))
        for split, stage in (('train', 'Train'), ('val', 'Eval')):
            require(config[stage]['dataset']['data_dir'] == str(source), 'Source image root mismatch')
            require(config[stage]['dataset']['label_file_list'] == [str(source / role / f'{split}.txt')],
                    'Source config label list mismatch')
            transforms = config[stage]['dataset']['transforms']
            require(all(next(iter(t)) in {'DecodeImage', 'CollectorCTCLabelEncode', 'RecResizeImg', 'KeepKeys'}
                        for t in transforms), 'Unreviewed source transform')
        for split in ('train', 'val', 'test'):
            path = source / role / f'{split}.txt'
            source_paths.append(path)
            entries = list_entries(path, source)
            expected = [(r['image_path'], r['label']) for r in role_rows if r['split'] == split and
                        (split == 'test' or r.get('optimize', True))]
            require(Counter(entries) == Counter(expected), 'Source list membership mismatch')
            old_lists[role, split] = entries
        configs[role] = config
    for name in ('quarantined.jsonl', 'superseded.jsonl'):
        require((source / name).is_file(), 'Missing source provenance artifact')
        source_paths.append(source / name)
    snapshots = {str(p): sha(p) for p in source_paths}
    snapshots[str(review_path)] = review_sha
    snapshots.update({str(p): h for p, h in evidence_pages.items()})

    result = deepcopy(rows)
    rationale = ('Green transient Winner status text occupies a name region. Preserve the literal OCR label and '
                 'source partition; exclude this semantic role from name-field optimization in every recipe.')
    for row in result:
        if row['sample_id'] in selected:
            row.update(semantic_role='transient_winner_marker', optimize=False,
                       semantic_exclusion_rationale=rationale, semantic_review_sha256=review_sha)
    allowed = {'semantic_role', 'optimize', 'semantic_exclusion_rationale', 'semantic_review_sha256'}
    for before, after in zip(rows, result):
        require(all(before.get(k) == after.get(k) for k in set(before) | set(after) if k not in allowed),
                'Non-semantic source field changed')
        if before['sample_id'] not in selected:
            require(before == after, 'Unreviewed row changed')
    # Copy rather than hardlink so accidental writes to a future candidate cannot
    # mutate frozen source pixels through shared inodes. Never copy checkpoints.
    output.mkdir(parents=True)
    try:
        for path, identity in image_hashes.items():
            target = output / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            require(sha(target) == identity[0], 'Copied image hash mismatch')
        shutil.copyfile(source / 'dictionary.txt', output / 'dictionary.txt')
        shutil.copyfile(source / 'audit.json', output / 'source-audit.json')
        shutil.copyfile(review_path, output / 'semantic-review.jsonl')
        for page in evidence_pages:
            target = output / 'review-evidence' / page.relative_to(review_path.parent)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(page, target)
        for name in ('quarantined.jsonl', 'superseded.jsonl'):
            shutil.copyfile(source / name, output / name)
        write_rows(output / 'manifest.jsonl', result)
        write_rows(output / 'semantic-exclusions.jsonl', [r for r in result if r['sample_id'] in selected])
        for split in ('train', 'val', 'test'):
            write_rows(output / f'{split}.jsonl', [r for r in result if r['split'] == split])
        audit = deepcopy(source_audit)
        audit.update(training_ready=False, training_run=False, source_root=str(source),
                     source_manifest_sha256=source_sha, source_audit_sha256=sha(source / 'audit.json'),
                     semantic_review_sha256=review_sha, source_artifacts_sha256=snapshots,
                     semantic_exclusion_count=len(selected),
                     semantic_exclusion_split_counts=dict(Counter(r['split'] for r in selected.values())),
                     semantic_exclusion_origin_split_counts=dict(Counter(f"{r['origin']}/{r['split']}" for r in selected.values())),
                     preexisting_exclusions=[r['sample_id'] for r in rows if not r.get('optimize', True)],
                     contact_sheets=[], image_copy_mode='independent_byte_copies',
                     counts=dict(Counter(r['split'] for r in result)),
                     optimized_counts=dict(Counter(r['split'] for r in result if r.get('optimize', True))))
        for role, config in configs.items():
            directory = output / role
            directory.mkdir()
            role_rows = [r for r in result if role == 'general' or r['category'] == 'name']
            write_rows(directory / 'manifest.jsonl', role_rows)
            eligible = {(r['image_path'], r['label']) for r in role_rows if r.get('optimize', True)}
            list_counts = {}
            for split in ('train', 'val', 'test'):
                entries = [item for item in old_lists[role, split] if split == 'test' or item in eligible]
                expected = [(r['image_path'], r['label']) for r in role_rows if r['split'] == split and
                            (split == 'test' or r.get('optimize', True))]
                require(Counter(entries) == Counter(expected), 'Output list membership mismatch')
                (directory / f'{split}.txt').write_text(''.join(f'{output / image}\t{label}\n' for image, label in entries))
                list_counts[split] = len(entries)
            config['Global'].update(save_model_dir=str(directory / 'checkpoints'),
                save_inference_dir=str(directory / 'export'), save_res_path=str(directory / 'predicts.txt'),
                character_dict_path=str(output / 'dictionary.txt'))
            for split, stage in (('train', 'Train'), ('val', 'Eval')):
                config[stage]['dataset'].update(data_dir=str(output), label_file_list=[str(directory / f'{split}.txt')])
            (directory / 'train.yml').write_text(yaml.safe_dump(config, sort_keys=False))
            audit[role].update(counts=dict(Counter(r['split'] for r in role_rows)),
                optimized_counts=dict(Counter(r['split'] for r in role_rows if r.get('optimize', True))),
                list_counts=list_counts, template_sha256=sha(source / role / 'train.yml'),
                config_sha256=sha(directory / 'train.yml'))
        require(all(sha(path) == h for path, h in snapshots.items()), 'Source changed during build')
        require(sha(manifest) == source_sha, 'Frozen manifest changed')
        audit['conservation'] = {'labels': True, 'sample_ids': True, 'aliases': True,
            'capture_groups': True, 'splits': True, 'all_test_membership': True,
            'blank_and_repetition_controls': True, 'preexisting_exclusions': True,
            'source_artifacts_unchanged': True, 'all_image_file_and_pixel_hashes_verified': True}
        audit['manifest_sha256'] = sha(output / 'manifest.jsonl')
        audit['training_ready'] = True
        (output / 'audit.json').write_text(json.dumps(audit, sort_keys=True, indent=2) + '\n')
    except Exception:
        shutil.rmtree(output)
        raise
    return audit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--review', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    audit = build(args.source, args.review, args.output)
    print(json.dumps({k: audit[k] for k in ('training_ready', 'counts', 'optimized_counts',
        'semantic_exclusion_count', 'semantic_exclusion_split_counts', 'conservation')}, indent=2))


if __name__ == '__main__':
    main()
