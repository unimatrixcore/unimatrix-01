#!/usr/bin/env python3
"""Restore real-name weighting after learning high-resolution repetition cues."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random

import yaml

p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--epochs',type=int,default=6);a=p.parse_args();root=a.root.resolve()
base=root/'name-specialist-v12';out=root/'name-specialist-v13';out.mkdir(exist_ok=True)
audit=json.loads((base/'audit.json').read_text());lines=(base/'train.txt').read_text().splitlines(keepends=True)
real=lines[:audit['real_train_variants']]
raw=lines[audit['real_train_variants']:audit['real_train_variants']+audit['raw']]
blanks=lines[-audit['constructed_blank_train']:]
assert len(real)==11910 and len(raw)==4000 and len(blanks)==600
random.Random(202611073).shuffle(raw);selected=real+raw[:500]+blanks
random.Random(202611073).shuffle(selected)
(out/'train.txt').write_text(''.join(selected));(out/'val.txt').write_text((base/'val.txt').read_text())
cfg=yaml.safe_load((base/'train.yml').read_text());cfg['Global'].update(epoch_num=a.epochs,seed=202611073,pretrained_model=str(base/'checkpoints/best_accuracy.pdparams'),save_model_dir=str(out/'checkpoints'),save_inference_dir=str(out/'export'),eval_batch_step=[0,math.ceil(len(selected)/32)])
cfg['Optimizer']['lr']['learning_rate']=1e-5
cfg['Train']['dataset']['label_file_list']=[str(out/'train.txt')];cfg['Eval']['dataset']['label_file_list']=[str(out/'val.txt')]
(out/'train.yml').write_text(yaml.safe_dump(cfg,sort_keys=False));report={**audit,'raw':500,'reviewed_gray':0,'train_total':len(selected),'starting_checkpoint_sha256':hashlib.sha256((base/'checkpoints/best_accuracy.pdparams').read_bytes()).hexdigest(),
 'phase':'Real-name retention: all11910 real variants, deterministic500 raw repetition renders,600 same constructed training blanks. No heldout/challenge strings added.',
 'validation_unchanged_sha256':hashlib.sha256((out/'val.txt').read_bytes()).hexdigest(),'seed':202611073}
(out/'audit.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
