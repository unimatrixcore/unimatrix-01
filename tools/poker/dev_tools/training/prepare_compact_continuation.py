#!/usr/bin/env python3
"""Apply individually verified training annotations and prepare a continuation."""
import argparse,hashlib,json
from pathlib import Path
import cv2,yaml

p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--corrections',type=Path,required=True);p.add_argument('--epochs',type=int,default=12);a=p.parse_args();root=a.root.resolve();base=root/'compact-ocr-v4';out=root/'compact-ocr-v5';out.mkdir(exist_ok=True)
corrections={r['sample_id']:r for r in json.loads(a.corrections.read_text())}
rows=[json.loads(l) for l in (base/'all-reviewed-manifest.jsonl').read_text().splitlines()]
for row in rows:
    if row['sample_id'] not in corrections:continue
    fix=corrections[row['sample_id']]
    assert row['split']=='train' and row['label']==fix['old_label'] and fix['visually_reviewed']
    image=cv2.imread(str(root/'full-bundle'/row['image_path']))
    assert image is not None and hashlib.sha256(image.tobytes()).hexdigest()==fix['pixel_sha256']
    row.update(original_label=row['label'],label=fix['label'],correction_evidence='Individual pixel review; reviewed-label-corrections.json')
(out/'manifest.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
cfg=yaml.safe_load((base/'train.yml').read_text());cfg['Global'].update(save_model_dir=str(out/'checkpoints'),pretrained_model=str(base/'checkpoints/best_accuracy.pdparams'),epoch_num=a.epochs,eval_batch_step=[0,257],save_inference_dir=str(out/'export'));cfg['Optimizer']['lr']['learning_rate']=.00002
for split,key in [('train','Train'),('val','Eval')]:
    lines=[str(out/'inputs'/r['image_path'])+'\t'+r['label']+'\n' for r in rows if r['split']==split]
    if split=='train':
        for line in (base/'reviewed-augmentation/labels.txt').read_text().splitlines():
            image,label=line.split('\t');lines.append(str(base/'reviewed-augmentation'/image)+'\t'+label+'\n')
    path=out/(split+'.txt');path.write_text(''.join(lines));cfg[key]['dataset'].update(data_dir=str(root),label_file_list=[str(path)])
(out/'train.yml').write_text(yaml.safe_dump(cfg,sort_keys=False))
