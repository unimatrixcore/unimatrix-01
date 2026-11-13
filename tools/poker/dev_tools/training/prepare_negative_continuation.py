#!/usr/bin/env python3
"""Continue on actual positive/negative crops, without repetition augmentation."""
import argparse,json,math,shutil
from pathlib import Path
import yaml
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--epochs',type=int,default=16);a=p.parse_args();root=a.root.resolve();base=root/'negative-ocr-v6';out=root/'negative-ocr-v7';out.mkdir(exist_ok=True)
cfg=yaml.safe_load((base/'train.yml').read_text());lines=[l for l in (base/'train.txt').read_text().splitlines() if '/reviewed-augmentation/' not in l];assert len(lines)==7491
(out/'train.txt').write_text('\n'.join(lines)+'\n');cfg['Train']['dataset']['label_file_list']=[str(out/'train.txt')];cfg['Global'].update(pretrained_model=str(base/'checkpoints/best_accuracy.pdparams'),save_model_dir=str(out/'checkpoints'),save_inference_dir=str(out/'export'),epoch_num=a.epochs,eval_batch_step=[0,math.ceil(len(lines)/32)]);cfg['Optimizer']['lr']['learning_rate']=.00001
(out/'train.yml').write_text(yaml.safe_dump(cfg,sort_keys=False));audit=json.loads((base/'data-audit.json').read_text());audit.update(synthetic_repetition_training=0,continuation_from=str(base/'checkpoints/best_accuracy.pdparams'));(out/'data-audit.json').write_text(json.dumps(audit,indent=2))
for name in ['manifest.jsonl','verified-negative-review.json','native-negative-loader-audit.json']:
    if (base/name).exists():shutil.copy2(base/name,out/name)
