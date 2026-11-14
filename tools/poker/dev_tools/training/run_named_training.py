#!/usr/bin/env python3
"""Run one audited continuation as a durable job, without promoting its weights."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import yaml


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--role', choices=['general', 'names'], required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    root = args.bundle.resolve()
    audit_path, config_path = root/'audit.json', root/args.role/'train.yml'
    audit = json.loads(audit_path.read_text())
    config = yaml.safe_load(config_path.read_text())
    if audit.get('training_ready') is not True or (root/'DO_NOT_TRAIN').exists():
        raise ValueError('The dataset audit does not authorize training')
    if config['Global'].get('use_gpu') is not True or config['Global'].get('distributed') is not False:
        raise ValueError('Training requires a single GPU per model job; CPU or distributed recipes are not accepted')
    checkpoint = Path(config['Global']['pretrained_model'])
    if sha(checkpoint) != audit[args.role]['starting_checkpoint_sha256']:
        raise ValueError('Starting checkpoint differs from the audited model')
    if config['Train']['loader']['shuffle'] is not True or config['Eval']['loader']['shuffle'] is not False:
        raise ValueError('Training must shuffle; validation must keep its fixed order')
    if config['Loss']['name'] != 'CollectorBlankCTCLoss' or config['Metric'].get('ignore_space') is not False:
        raise ValueError('Blank-aware loss and strict space-sensitive validation are required')
    if bool(config['Global'].get('collector_name_high_resolution')) != (args.role == 'names'):
        raise ValueError('Model role and temporal resolution disagree')
    destination = Path(config['Global']['save_model_dir']).resolve()
    if destination != root/args.role/'checkpoints':
        raise ValueError('Continuation must save to its own candidate checkpoint directory')
    lists, counts, blank_counts = {}, {}, {}
    for split, section in [('train', 'Train'), ('val', 'Eval')]:
        paths = config[section]['dataset']['label_file_list']
        if len(paths) != 1:
            raise ValueError('Expected one audited list per split')
        path = Path(paths[0])
        lines = path.read_text().splitlines()
        if len(lines) != audit[args.role]['optimized_counts'][split]:
            raise ValueError('Training list count differs from its audit')
        blanks = 0
        for line in lines:
            image, label = line.split('\t', 1)
            image_path = Path(image).resolve()
            if not image_path.is_relative_to(root/'images') or not image_path.is_file():
                raise ValueError('Training image must belong to the frozen bundle')
            if sha(image_path) != image_path.stem:
                raise ValueError('Training image hash changed')
            blanks += label == ''
        lists[split], counts[split], blank_counts[split] = sha(path), len(lines), blanks
    if args.role == 'names' and not blank_counts['train']:
        raise ValueError('Name continuation must retain audited blank training targets')
    resume = None
    if args.resume:
        from checkpoint_resume import select_checkpoint
        prior_path = root/args.role/'training-status.json'
        prior = json.loads(prior_path.read_text()) if prior_path.is_file() else None
        if prior and (prior.get('audit_sha256') != sha(audit_path)
                      or prior.get('config_sha256') != sha(config_path)
                      or prior.get('lists_sha256') != lists):
            raise ValueError('Audited recipes or label lists changed since the previous attempt')
        resume = select_checkpoint(root, args.role, config['Global']['epoch_num'])
    command = [sys.executable, str(Path(__file__).with_name('run_negative_ocr.py')),
               '--source', str(args.source.resolve()), '--mode', 'train']
    if args.role == 'names':
        command.append('--name-high-resolution')
    command += ['-c', str(config_path)]
    if resume:
        command += ['--resume-state', resume['prefix'] + '.states', '-o', 'Global.checkpoints=' + resume['prefix']]
    status = {'role': args.role, 'audit_sha256': sha(audit_path), 'config_sha256': sha(config_path),
              'checkpoint_sha256': sha(checkpoint), 'lists_sha256': lists, 'counts': counts,
              'blank_counts': blank_counts, 'command': command, 'runtime_model_replaced': False,
              'resume': resume}
    if args.dry_run:
        print(json.dumps(status, indent=2)); return
    path = root/args.role/'training-status.json'
    if path.is_file():
        history = root/args.role/'attempts'
        history.mkdir(exist_ok=True)
        (history/(str(time.time_ns())+'.json')).write_bytes(path.read_bytes())
    def save():
        temp = path.with_suffix('.tmp'); temp.write_text(json.dumps(status, indent=2)); temp.replace(path)
    status.update(state='running', started_at=time.time(), supervisor_pid=os.getpid()); save()
    with (root/args.role/'training.log').open('a', buffering=1) as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    selected = destination/'best_accuracy.pdparams'
    status.update(state='completed' if result.returncode == 0 and selected.is_file() else 'failed',
                  finished_at=time.time(), exit_code=result.returncode,
                  selected_checkpoint_sha256=sha(selected) if selected.is_file() else None)
    save()
    print(json.dumps(status, indent=2))
    if status['state'] != 'completed':
        raise SystemExit(result.returncode or 1)


if __name__ == '__main__':
    main()
