#!/usr/bin/env python3
"""Untrained identifier strings from reviewed font glyphs; never training data."""
import argparse,hashlib,json,random
from pathlib import Path
import cv2,numpy as np
from prepare_ocr_inputs import normalize_name

p=argparse.ArgumentParser();p.add_argument('--bundle',type=Path,required=True);p.add_argument('--glyph-bank',type=Path,required=True);p.add_argument('--training-augmentation',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--count',type=int,default=512);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True);(a.output/'images').mkdir(exist_ok=True)
source_rows=[json.loads(l) for l in (a.bundle/'manifest.jsonl').read_text().splitlines()];known={r['label'] for r in source_rows if r['label']}
known.update(l.split('\t')[1] for l in a.training_augmentation.read_text().splitlines());bank={};selections=json.loads(a.glyph_bank.read_text())
for entry in selections:
    im=cv2.imread(str(a.bundle/'images'/(str(entry['sample_id'])+'.png')));im,info=normalize_name(im);assert info is not None
    gray=cv2.cvtColor(im,cv2.COLOR_BGR2GRAY);left,right=entry['x'];patch=gray[:,left:right];ys=np.where(np.any(patch<200,axis=1))[0];bank[entry['character']]=patch[ys[0]:ys[-1]+1].copy()
rng=random.Random(418807);rows=[];labels=set()
for i in range(a.count):
    while True:
        char=rng.choice('ilI0O');length=rng.choice([2,3,4,5,8,12,16,20,24,28,32]);prefix=rng.choice(['F','S','B','M','3','o','d']);label=prefix+char*length+rng.choice(['','F','3','d'])
        if label not in known and label not in labels:break
    labels.add(label);gap=rng.randint(1,3);width=sum(bank[c].shape[1]+gap for c in label)+16;width=max(198,width);image=np.full((36,width),255,np.uint8);cursor=(width-sum(bank[c].shape[1]+gap for c in label))//2
    for c in label:
        patch=bank[c];h,w=patch.shape;image[27-h:27,cursor:cursor+w]=patch;cursor+=w+gap
    # Render gray UI foreground over normal/turn/urgent backgrounds, including
    # moving color boundaries. The label string is independent of the colors.
    backgrounds=[(53,42,25),(242,0,137),(94,62,225)];bg=np.full((36,width,3),backgrounds[i%3],np.float32)
    if i%4:boundary=rng.randint(0,width);bg[:,boundary:]=backgrounds[(i+1)%3]
    alpha=1-image.astype(np.float32)/255;render=np.clip(bg*(1-alpha[:,:,None])+np.array((200,177,168))*alpha[:,:,None],0,255).astype(np.uint8)
    sid=str(1000000+i);path=Path('images')/(sid+'.png');assert cv2.imwrite(str(a.output/path),render)
    rows.append({'sample_id':sid,'category':'name','region_id':'synthetic.name','split':'novel_string_challenge','original_label':label,'label':label,'label_corrected':False,'label_kind':'constructed_positive','image_path':str(path),'file_sha256':hashlib.sha256((a.output/path).read_bytes()).hexdigest(),'repeated_character':char,'run_length':length,'gap':gap,'source':'reviewed training-font glyph patches; novel strings excluded from every known real and synthetic training label'})
(a.output/'manifest.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows));(a.output/'protocol.json').write_text(json.dumps({'samples':len(rows),'seed':418807,'label_overlap_with_training':0,'interpretation':'Synthetic novel strings, not new real captures; physical glyphs came from reviewed training sources','glyph_sources':selections},indent=2));print('Constructed',len(rows),'novel strings')
