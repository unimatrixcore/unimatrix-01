#!/usr/bin/env python3
"""Prepare the selected blank-aware continuation with positive-only retention."""
import argparse,hashlib,json,shutil
from pathlib import Path
import yaml
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--epochs',type=int,default=8);a=p.parse_args();root=a.root.resolve();base=root/'negative-ocr-v6';out=root/'negative-ocr-v8';out.mkdir(exist_ok=True)
cfg=yaml.safe_load((base/'train.yml').read_text());cfg['Global'].update(pretrained_model=str(base/'checkpoints/best_accuracy.pdparams'),save_model_dir=str(out/'checkpoints'),save_inference_dir=str(out/'export'),epoch_num=a.epochs);cfg['Loss']={'name':'CollectorRetentionCTCLoss'};cfg['Optimizer']['lr']['learning_rate']=.000005
(out/'train.yml').write_text(yaml.safe_dump(cfg,sort_keys=False));audit=json.loads((base/'data-audit.json').read_text());teacher=root/'compact-ocr-v5/checkpoints/best_accuracy.pdparams';audit.update(continuation_from=str(base/'checkpoints/best_accuracy.pdparams'),starting_checkpoint_sha256=hashlib.sha256((base/'checkpoints/best_accuracy.pdparams').read_bytes()).hexdigest(),teacher_positive_only=True,teacher_checkpoint_sha256=hashlib.sha256(teacher.read_bytes()).hexdigest(),retention_weight=1.,shared_frozen_backbone=True);(out/'data-audit.json').write_text(json.dumps(audit,indent=2))
for name in ['manifest.jsonl','verified-negative-review.json','native-negative-loader-audit.json']:
    if (base/name).exists():shutil.copy2(base/name,out/name)
