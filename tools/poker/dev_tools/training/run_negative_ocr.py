#!/usr/bin/env python3
"""Run native train/export with recorded geometry and blank-aware encoding."""
import argparse
import atexit
import json
import runpy
import sys
from pathlib import Path

import yaml

from tensor_scalar_compatibility import install_tensor_float_compatibility
from restore_training_state import install_resume_state
from dataset_seed_policy import install_dataset_rng_seed

p=argparse.ArgumentParser()
p.add_argument('--source',type=Path,required=True)
p.add_argument('--mode',choices=['train','export','eval'],required=True)
p.add_argument('--retain-positive-checkpoint',type=Path)
p.add_argument('--retain-positive-config',type=Path)
p.add_argument('--retention-weight',type=float,default=1.0)
p.add_argument('--retention-eligible-manifest',type=Path)
p.add_argument('--retention-report',type=Path)
p.add_argument('--name-high-resolution',action='store_true')
p.add_argument('--resume-state',type=Path)
args,rest=p.parse_known_args()
config=None
if '-c' in rest:
    config=yaml.safe_load(Path(rest[rest.index('-c')+1]).read_text())
    declared=bool(config['Global'].get('collector_name_high_resolution',False))
    if declared!=args.name_high_resolution:
        raise ValueError('Name resolution flag must match the recorded training/export configuration')
source=args.source.resolve();sys.path.insert(0,str(source))
if args.mode == 'train':
    from checkpoint_resume import install_checkpoint_receipts
    install_checkpoint_receipts()
if install_tensor_float_compatibility():
    print('PADDLE SCALAR COMPATIBILITY: single-element float uses Tensor.item(); AMP loss scaling unchanged',flush=True)
if args.resume_state:
    if args.mode != 'train':
        raise ValueError('Checkpoint resume metadata is only supported for training')
    install_resume_state(args.resume_state)
from compact_ocr_policy import install_policy
from negative_ctc_policy import install_negative_encoder
install_policy(1);install_negative_encoder()
if install_dataset_rng_seed():
    print('DATA ORDER: Global.seed controls initial dataset shuffling; augmentation epoch unchanged',flush=True)
if args.name_high_resolution:
    from name_resolution_policy import install_name_resolution
    install_name_resolution()
if args.retain_positive_checkpoint:
    if not args.retain_positive_config or config is None:
        raise ValueError('Retention needs teacher and student configurations')
    from positive_retention_loss import install_positive_retention
    retention=install_positive_retention(args.retain_positive_checkpoint,args.retain_positive_config,args.retention_weight,
                                         student_config=config,eligible_manifest=args.retention_eligible_manifest)
    if args.retention_report:
        def save_retention_report():
            args.retention_report.parent.mkdir(parents=True,exist_ok=True)
            args.retention_report.write_text(json.dumps({key:value for key,value in retention.items()
                                                        if key not in ('student','features')},indent=2)+'\n')
        atexit.register(save_retention_report)
elif args.retention_eligible_manifest:
    raise ValueError('Retention eligibility requires a teacher checkpoint')
script=source/'tools'/('export_model.py' if args.mode=='export' else args.mode+'.py')
sys.argv=[str(script),*rest];runpy.run_path(str(script),run_name='__main__')
