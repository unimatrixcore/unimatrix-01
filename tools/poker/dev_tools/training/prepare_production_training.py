#!/usr/bin/env python3
"""Prepare raw-input adaptation, preserving blank targets and repetition data."""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path

import yaml

from partition_audit import verify_partition


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--run', default='production-ocr-v9')
    p.add_argument('--epochs', type=int, default=6)
    p.add_argument('--starting-checkpoint', type=Path)
    p.add_argument('--raw-repetition',type=Path)
    a = p.parse_args(); root = a.root.resolve(); out = root/a.run
    out.mkdir(exist_ok=True)
    original = [json.loads(line) for line in (root/'negative-ocr-v8/manifest.jsonl').read_text().splitlines()]
    augmentation = root/'compact-ocr-v4/reviewed-augmentation'
    partition = verify_partition(original, root/'stress-database', augmentation)
    rows = [json.loads(line) for line in (root/'production-data/manifest.jsonl').read_text().splitlines()]
    parents = {r['sample_id']:r for r in original}
    for row in rows:
        parent = parents[row['parent_sample_id']]
        assert parent['optimize'] and row['split'] == parent['split'] and row['label'] == parent['label']
        assert row['split'] == 'train' or row['augmentation'] == 'original'
        assert hashlib.sha256((root/'production-data'/row['image_path']).read_bytes()).hexdigest() == row['file_sha256']
    cfg = yaml.safe_load((root/'negative-ocr-v8/train.yml').read_text())
    initial = a.starting_checkpoint.resolve() if a.starting_checkpoint else root/'negative-ocr-v8/checkpoints/best_accuracy.pdparams'
    cfg['Global'].update(epoch_num=a.epochs, pretrained_model=str(initial),
                         save_model_dir=str(out/'checkpoints'), save_inference_dir=str(out/'export'), checkpoints=None, seed=20261107)
    cfg['Optimizer']['lr']['learning_rate'] = 0.00002
    cfg['Loss'] = {'name':'CollectorBlankCTCLoss'}
    cfg['Global']['print_batch_step'] = 100
    for split,key in [('train','Train'),('val','Eval')]:
        selected = [r for r in rows if r['split']==split]
        lines = [str(root/'production-data'/r['image_path'])+'\t'+r['label']+'\n' for r in selected]
        if split == 'train':
            for line in (augmentation/'labels.txt').read_text().splitlines():
                image,label=line.split('\t'); lines.append(str(augmentation/image)+'\t'+label+'\n')
            if a.raw_repetition:
                repetition=a.raw_repetition.resolve()
                extra=[json.loads(line) for line in (repetition/'manifest.jsonl').read_text().splitlines()]
                heldout={r['label'] for r in original if r['split']!='train'}
                heldout.update(r['label'] for r in map(json.loads,(root/'novel-name-challenge/manifest.jsonl').read_text().splitlines()))
                train_ids={r['sample_id'] for r in original if r['split']=='train' and r['label'] and r.get('optimize',True)}
                review=json.loads((repetition/'review.json').read_text());assert review['reviewed_glyphs']==12 and not review['conflicting_exact_pixel_groups']
                for row in extra:
                    assert row['split']=='train' and row['label'] not in heldout and row['glyph_sources'] and set(row['glyph_sources'])<=train_ids
                    assert hashlib.sha256((repetition/row['image_path']).read_bytes()).hexdigest()==row['file_sha256']
                    lines.append(str(repetition/row['image_path'])+'\t'+row['label']+'\n')
        path = out/(split+'.txt'); path.write_text(''.join(lines))
        cfg[key]['dataset'].update(data_dir=str(root),label_file_list=[str(path)])
        cfg[key]['loader']['shuffle'] = split == 'train'
        if split == 'train': cfg['Global']['eval_batch_step'] = [0,math.ceil(len(lines)/32)]
    (out/'train.yml').write_text(yaml.safe_dump(cfg,sort_keys=False))
    audit = {'raw_input':True,'starting_model':str(initial),'starting_sha256':hashlib.sha256(initial.read_bytes()).hexdigest(),
             'counts':dict(collections.Counter(r['split'] for r in rows)), 'train_repetition':partition['augmentation_rows'],
             'partition':partition,'global_shuffle':True,'seed':20261107,'selection':'Native strict development validation exact-match; test and sealed captures excluded.',
             'training_after_prior_stress':True,'prior_stress_role':'Development failures motivate recipe; not independent acceptance evidence.'}
    if a.raw_repetition:audit['raw_repetition_training']=len(extra)
    (out/'data-audit.json').write_text(json.dumps(audit,indent=2))
    (out/'manifest.jsonl').write_text((root/'negative-ocr-v8/manifest.jsonl').read_text())
    print(json.dumps(audit,indent=2))


if __name__ == '__main__':main()
