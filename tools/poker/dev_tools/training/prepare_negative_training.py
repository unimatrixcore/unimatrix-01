#!/usr/bin/env python3
"""Prepare capture-separated verified negatives without mutating source labels."""
import argparse,collections,hashlib,json,math,sqlite3
from pathlib import Path
import yaml
from partition_audit import verify_partition

p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--review',type=Path,required=True);p.add_argument('--epochs',type=int,default=12);a=p.parse_args();root=a.root.resolve();bundle=root/'stress-database';out=root/'negative-ocr-v6';out.mkdir(exist_ok=True)
rows=[json.loads(l) for l in (bundle/'manifest.jsonl').read_text().splitlines()];review=json.loads(a.review.read_text());assert review['complete_visual_audit']
decisions={r['sample_id']:r for r in review['decisions']};empty_ids={r['sample_id'] for r in rows if not r['original_label']};assert set(decisions)==empty_ids and len(decisions)==len(review['decisions'])
c=sqlite3.connect((bundle/'database-snapshot.db').as_uri()+'?mode=ro',uri=True);session=0;previous=None;source_sessions={}
for sid,timestamp in c.execute('select id,timestamp from full_captures order by timestamp'):
    if previous is None or timestamp-previous>600000:session+=1
    source_sessions[sid]=session;previous=timestamp
quarantined=[]
for row in rows:
    session=source_sessions.get(row['source_id']);split='val' if session==18 else 'test' if session==19 else 'train';row.update(split=split,capture_session=session)
    if row['sample_id'] in decisions:
        d=decisions[row['sample_id']];assert d['visually_reviewed']
        assert d.get('source_file_sha256')==row['file_sha256'],'Reviewed negative source pixels changed'
        if d['decision']=='negative':row.update(label='',label_kind='verified_negative',review_evidence=d)
        elif d['decision']=='text':
            assert d['transcription'];row.update(label=d['transcription'],label_kind='reviewed_positive',review_evidence=d)
        else:row.update(label_kind='ambiguous',review_evidence=d);quarantined.append(row['sample_id'])
    else:row['label_kind']='existing_positive'
    # Preserve previous exclusion from optimization, but benchmark its label.
    row['optimize']=row['label_kind']!='ambiguous' and row['sample_id']!='8137'
partition=verify_partition(rows,bundle,root/'compact-ocr-v4/reviewed-augmentation');(out/'partition-verification.json').write_text(json.dumps(partition,indent=2))
(out/'manifest.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows));cfg=yaml.safe_load((root/'compact-ocr-v5/train.yml').read_text());cfg['Global'].update(save_model_dir=str(out/'checkpoints'),pretrained_model=str(root/'compact-ocr-v5/checkpoints/best_accuracy.pdparams'),epoch_num=a.epochs,save_inference_dir=str(out/'export'));cfg['Optimizer']['lr']['learning_rate']=.00001
for split,key in [('train','Train'),('val','Eval')]:
    selected=[r for r in rows if r['split']==split and r['optimize']];lines=[str(out/'inputs'/r['image_path'])+'\t'+r['label']+'\n' for r in selected]
    if split=='train':
        for line in (root/'compact-ocr-v4/reviewed-augmentation/labels.txt').read_text().splitlines():
            image,label=line.split('\t');lines.append(str(root/'compact-ocr-v4/reviewed-augmentation'/image)+'\t'+label+'\n')
    path=out/(split+'.txt');path.write_text(''.join(lines));cfg[key]['dataset'].update(data_dir=str(root),label_file_list=[str(path)]);cfg[key]['dataset']['transforms'][1]={'CollectorCTCLabelEncode':None}
    if split=='train':cfg['Global']['eval_batch_step']=[0,math.ceil(len(lines)/32)]
cfg['Global']['print_batch_step']=100
cfg['Loss']={'name':'CollectorBlankCTCLoss'}
(out/'train.yml').write_text(yaml.safe_dump(cfg,sort_keys=False));counts={split:dict(collections.Counter(r['label_kind'] for r in rows if r['split']==split)) for split in ['train','val','test']}
audit={'counts':counts,'ambiguous_ids':quarantined,'source_snapshot_sha256':hashlib.sha256((bundle/'database-snapshot.db').read_bytes()).hexdigest(),'review_sha256':hashlib.sha256(a.review.read_bytes()).hexdigest(),'split':'Original capture sessions:18 validation,19 test; other and unknown training. No validation/test negatives used in optimization.','negative_target':'True empty string with label length0; no dummy whitespace target','synthetic_repetition_training':2000}
(out/'data-audit.json').write_text(json.dumps(audit,indent=2));print(json.dumps(audit,indent=2))
