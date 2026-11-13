#!/usr/bin/env python3
"""Freeze the unchanged NAME corpus and run a separate scoped v13 continuation."""

import sys as _storage_sys
from pathlib import Path as _StoragePath
_storage_sys.path.insert(0, str(_StoragePath(__file__).resolve().parents[1]))
from lib.storage_paths import training_dir, data_dir

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import yaml

ROOT = Path(__file__).resolve().parents[2]
SOURCE_SHA = 'd86b59331dbb03151338caed316cbcd9ce9496562c8ac71810401f0d57deefe9'
CHECKPOINT_SHA = 'a53ec361f7b7d31a2d8026990314e628181fc1d7cc98d5d469191f348a449c30'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare(source, output, teacher_config, checkpoint, paddle_source):
    if sha(source/'manifest.jsonl') != SOURCE_SHA or sha(checkpoint) != CHECKPOINT_SHA:
        raise ValueError('Frozen source manifest or v13 initialization changed')
    source_audit = json.loads((source/'audit.json').read_text())
    if source_audit.get('training_ready') is not True or (source/'DO_NOT_TRAIN').exists():
        raise ValueError('Source corpus audit does not authorize training')
    output.mkdir(parents=True, exist_ok=False)
    (output/'images').mkdir()
    (output/'names').mkdir()
    for filename in ['manifest.jsonl', 'dictionary.txt', 'audit.json']:
        shutil.copyfile(source/filename, output/filename)
    # Images are immutable content-addressed inputs. Never overwrite either link.
    rows = [json.loads(line) for line in (source/'manifest.jsonl').read_text().splitlines()]
    for row in rows:
        image = Path(row['image_path'])
        if image.is_absolute() or image.parts[0] != 'images' or '..' in image.parts:
            raise ValueError('Expected safe relative content-addressed input paths')
        original, destination = source/image, output/image
        if sha(original) != row['file_sha256']:
            raise ValueError('Input image differs from its frozen manifest')
        if not destination.exists():
            os.link(original, destination)
    config = yaml.safe_load((source/'names/train.yml').read_text())
    config['Global'].update(save_model_dir=str(output/'names/checkpoints'),
                            save_inference_dir=str(output/'names/export'),
                            save_res_path=str(output/'names/predict.txt'),
                            character_dict_path=str(output/'dictionary.txt'),
                            pretrained_model=str(checkpoint), checkpoints=None,
                            epoch_num=6, print_batch_step=20)
    config['Optimizer']['lr']['learning_rate'] = 1e-5
    config['Loss']['name'] = 'CollectorRetentionCTCLoss'
    train_paths = set()
    for split, section in [('train', 'Train'), ('val', 'Eval')]:
        lines = []
        for line in (source/f'names/{split}.txt').read_text().splitlines():
            path, label = line.split('\t', 1)
            relative = Path(path).relative_to(source)
            lines.append(str(output/relative)+'\t'+label)
            if split == 'train':
                train_paths.add(relative.as_posix())
        (output/f'names/{split}.txt').write_text('\n'.join(lines)+'\n')
        dataset = config[section]['dataset']
        dataset.update(data_dir=str(output), label_file_list=[str(output/f'names/{split}.txt')])
        transforms = dataset['transforms']
        transforms.insert(1, {'CollectorRetentionMask': {
            'retention_eligible_manifest': str(output/'manifest.jsonl'), 'enabled': split == 'train'}})
        transforms[-1]['KeepKeys']['keep_keys'] = ['image', 'label', 'length', 'retention_mask']
        config[section]['loader'].update(batch_size_per_card=32, shuffle=split == 'train', drop_last=False)
    (output/'names/train.yml').write_text(yaml.safe_dump(config, sort_keys=False))
    eligible = [row for row in rows if row['image_path'] in train_paths and row.get('origin') == 'baseline'
                and row.get('split') == 'train' and row.get('optimize') is True and row.get('label')]
    command = [sys.executable, str(ROOT/'dev_tools/training/run_negative_ocr.py'),
               '--source', str(paddle_source), '--mode', 'train', '--name-high-resolution',
               '--retain-positive-checkpoint', str(checkpoint), '--retain-positive-config', str(teacher_config),
               '--retention-weight', '1', '--retention-eligible-manifest', str(output/'manifest.jsonl'),
               '--retention-report', str(output/'names/retention-report.json'), '-c', str(output/'names/train.yml')]
    plan = {'source_manifest_sha256': SOURCE_SHA, 'manifest_sha256': sha(output/'manifest.jsonl'),
            'teacher_and_student_checkpoint_sha256': CHECKPOINT_SHA,
            'teacher_config_sha256': sha(teacher_config), 'config_sha256': sha(output/'names/train.yml'),
            'dictionary_sha256': sha(output/'dictionary.txt'),
            'lists_sha256': {split: sha(output/f'names/{split}.txt') for split in ['train', 'val']},
            'counts': dict(Counter(row['split'] for row in rows if row.get('category') == 'name' and row.get('optimize'))),
            'eligible_baseline_train_positives': len(eligible), 'training_labels_and_splits_changed': False,
            'heldout_used_for_optimization': False, 'teacher_correct_filter': 'greedy_ctc_ids_equal_encoded_train_label',
            'teacher_only_eligible_rows': True, 'retention_weight': 1.0, 'epochs': 6, 'batch_size': 32,
            'learning_rate': 1e-5, 'runtime_model_replaced': False, 'command': command}
    (output/'plan.json').write_text(json.dumps(plan, indent=2)+'\n')
    return plan


def run(output):
    plan = json.loads((output/'plan.json').read_text())
    config = yaml.safe_load((output/'names/train.yml').read_text())
    checkpoint = Path(config['Global']['pretrained_model'])
    teacher_config = Path(plan['command'][plan['command'].index('--retain-positive-config')+1])
    for path, expected in [(output/'manifest.jsonl', SOURCE_SHA), (checkpoint, CHECKPOINT_SHA),
                           (output/'names/train.yml', plan['config_sha256']),
                           (teacher_config, plan['teacher_config_sha256']),
                           (output/'dictionary.txt', plan['dictionary_sha256'])]:
        if sha(path) != expected:
            raise ValueError(f'Preflight artifact changed: {path}')
    for split in ['train', 'val']:
        path = output/f'names/{split}.txt'
        if sha(path) != plan['lists_sha256'][split]:
            raise ValueError('Frozen labels changed')
        for line in path.read_text().splitlines():
            image, _ = line.split('\t', 1)
            path_image = Path(image).resolve()
            if not path_image.is_relative_to(output/'images') or sha(path_image) != path_image.stem:
                raise ValueError('Training pixels changed or escaped bundle')
    status = dict(plan, state='running', supervisor_pid=os.getpid(), started_at=time.time())
    status_path = output/'names/training-status.json'
    def save():
        temp = status_path.with_suffix('.tmp')
        temp.write_text(json.dumps(status, indent=2)+'\n')
        temp.replace(status_path)
    save()
    with (output/'names/training.log').open('a', buffering=1) as log:
        result = subprocess.run(plan['command'], stdout=log, stderr=subprocess.STDOUT)
    selected = output/'names/checkpoints/best_accuracy.pdparams'
    status.update(state='completed' if result.returncode == 0 and selected.is_file() else 'failed',
                  exit_code=result.returncode, finished_at=time.time(),
                  selected_checkpoint_sha256=sha(selected) if selected.exists() else None)
    save()
    print(json.dumps(status, indent=2), flush=True)
    if status['state'] != 'completed':
        raise SystemExit(result.returncode or 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-bundle', type=Path, default=training_dir() / 'named-continuation/final')
    parser.add_argument('--output', type=Path, default=training_dir() / 'named-continuation/name-retained-v15')
    parser.add_argument('--teacher-config', type=Path, default=training_dir() / 'desktop-training/name-specialist-v13/train.yml')
    parser.add_argument('--checkpoint', type=Path, default=training_dir() / 'desktop-training/name-specialist-v13/checkpoints/best_accuracy.pdparams')
    parser.add_argument('--paddle-source', type=Path, default=training_dir() / 'desktop-training/paddle-training-source')
    parser.add_argument('--run-existing', action='store_true')
    args = parser.parse_args()
    if args.run_existing:
        run(args.output.resolve())
    else:
        print(json.dumps(prepare(args.source_bundle.resolve(), args.output.resolve(), args.teacher_config.resolve(),
                                 args.checkpoint.resolve(), args.paddle_source.resolve()), indent=2))


if __name__ == '__main__':
    main()
