#!/usr/bin/env python3
"""Reconstruct actual failed inputs and verify their recorded pixel hashes."""
import argparse,hashlib,json
from pathlib import Path
import cv2,numpy as np
from stress_ocr import transform,preprocess

p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--tag',default='v8');a=p.parse_args();root=a.root.resolve();matrix=root/('stress-results/negative-'+a.tag+'-matrix');output=root/'stress-results/final-report/examples';output.mkdir(parents=True,exist_ok=True);chosen=[]
for condition in ['jpeg_80','scale_0.60','recrop_x_plus2','recrop_y_plus2','recrop_y_plus4']:
    path=matrix/condition/'predictions.jsonl'
    if not path.exists():continue
    rows=[json.loads(l) for l in path.read_text().splitlines()];errors=[r for r in rows if not r.get('error') and r['label']!=r['prediction']];errors.sort(key=lambda r:r['confidence'],reverse=True)
    categories=['name','status','bank','bet','card','dealer','pot','split_pot','round_id']
    for category in categories:
        selected=[r for r in errors if r['category']==category]
        for r in selected[:2 if category=='name' else 1]:chosen.append(dict(r,condition=condition))
chosen=chosen[:24];sheet=np.full((len(chosen)*110,1800,3),245,np.uint8)
for i,row in enumerate(chosen):
    sid=row['sample_id'];condition=row['condition'];source=cv2.imread(str(root/'stress-database/images'/(sid+'.png')))
    if condition.startswith('recrop_'):
        path=root/'stress-recrops'/condition[7:]/'images'/(sid+'.png');perturbed=cv2.imread(str(path)) if path.exists() else source.copy()
    else:perturbed=transform(source,condition,int(sid))
    prepared,_=preprocess(perturbed,row['category']);assert hashlib.sha256(prepared.tobytes()).hexdigest()==row['preprocessed_sha256'],(sid,condition)
    for column,(name,image) in enumerate([('original',source),('perturbed',perturbed),('model-input',prepared)]):
        filename=f'{condition}-{sid}-{name}.png';assert cv2.imwrite(str(output/filename),image);h,w=image.shape[:2];factor=min(2,590/w,76/h);preview=cv2.resize(image,(round(w*factor),round(h*factor)),interpolation=cv2.INTER_NEAREST);x=column*600;sheet[i*110:i*110+preview.shape[0],x:x+preview.shape[1]]=preview
    label=f"{condition} ID{sid} {row['category']} target={row['label'] or '<negative>'} prediction={row['prediction']!r} confidence={row['confidence']:.4f}"
    cv2.putText(sheet,label,(4,i*110+102),0,.48,(0,0,0),1)
assert cv2.imwrite(str(output/'failure-contact.png'),sheet)
(output/'index.json').write_text(json.dumps({'columns':['original crop','stress-transformed crop','actual custom-preprocessed model input'],'pixel_hashes_verified':True,'cases':chosen},indent=2));print('Exported',len(chosen),'verified failure triples')
