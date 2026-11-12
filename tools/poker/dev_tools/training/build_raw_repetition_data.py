#!/usr/bin/env python3
"""Compose reviewed training-font glyphs on actual UI plate colors.

Strings, colors and positions are generated independently. No real held-out
transcription or existing challenge string is added to training. Overwide text
is rejected rather than silently clipped or assigned an ellipsis label.
"""
import argparse
import hashlib
import json
import random
from pathlib import Path

import cv2
import numpy as np

from prepare_ocr_inputs import normalize_name


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--bundle',type=Path,required=True)
    p.add_argument('--glyph-bank',type=Path,required=True);p.add_argument('--exclude-manifest',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--count',type=int,default=4000);a=p.parse_args();a.output.mkdir(exist_ok=True,parents=True);(a.output/'images').mkdir(exist_ok=True)
    rows=[json.loads(l) for l in a.manifest.read_text().splitlines()];by_id={r['sample_id']:r for r in rows}
    excluded={r['label'] for r in rows if r['split']!='train'}
    excluded.update(r['label'] for r in map(json.loads,a.exclude_manifest.read_text().splitlines()))
    sources=json.loads(a.glyph_bank.read_text());bank={}
    for entry in sources:
        row=by_id[entry['sample_id']];assert row['split']=='train' and row['label'] and row.get('optimize',True)
        path=a.bundle/row['image_path'];assert hashlib.sha256(path.read_bytes()).hexdigest()==row['file_sha256']
        image,info=normalize_name(cv2.imread(str(path)));assert info
        gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY);left,right=entry['x'];patch=gray[:,left:right]
        ys=np.where(np.any(patch<200,axis=1))[0];assert len(ys)
        bank[entry['character']]=patch[ys[0]:ys[-1]+1].copy()
    # Explicitly review these patches and generated renders before training.
    glyph_sheet=np.full((100,len(bank)*90,3),235,np.uint8)
    for index,(character,patch) in enumerate(bank.items()):
        cv2.putText(glyph_sheet,character,(index*90+5,20),0,.6,(0,0,0),1)
        resized=cv2.resize(patch,(patch.shape[1]*2,patch.shape[0]*2),interpolation=cv2.INTER_NEAREST)
        glyph_sheet[30:30+resized.shape[0],index*90+5:index*90+5+resized.shape[1]]=cv2.cvtColor(resized,cv2.COLOR_GRAY2BGR)
    cv2.imwrite(str(a.output/'glyph-bank.png'),glyph_sheet)
    rng=random.Random(202611071);output=[];sample_images=[];used=set();backgrounds=[(53,42,25),(242,0,137),(94,62,225)]
    for i in range(a.count):
        for attempt in range(10000):
            char=rng.choice('ilI0O');length=rng.randint(2,32)
            label=rng.choice(['F','M','o','d','3','S','B'])+char*length+rng.choice(['','F','3','d','M','o'])
            gap=rng.choice([1,2,3]);text_width=sum(bank[c].shape[1] for c in label)+gap*(len(label)-1)
            if label not in excluded and 0<text_width<=186:break
        else:raise RuntimeError('Cannot sample a label-safe physical-width string')
        height=rng.choice([33,34,36]);width=rng.choice([198,200,204]);baseline=rng.choice([27,28,29]);left=(width-text_width)//2+rng.randint(-2,2)
        alpha=np.zeros((height,width),np.float32);cursor=left
        for c in label:
            patch=bank[c];h,w=patch.shape;assert baseline-h>=0 and baseline<=height-3
            alpha[baseline-h:baseline,cursor:cursor+w]=1-patch.astype(np.float32)/255;cursor+=w+gap
        bg=np.full((height,width,3),backgrounds[i%3],np.float32)
        boundary=rng.randrange(width+1)
        if i%4:bg[:,boundary:]=backgrounds[(i+1)%3]
        render=np.clip(bg*(1-alpha[:,:,None])+np.array((200,177,168))*alpha[:,:,None],0,255).astype(np.uint8)
        if i%5==0:
            ok,encoded=cv2.imencode('.jpg',render,[cv2.IMWRITE_JPEG_QUALITY,rng.choice([87,91,95])]);assert ok;render=cv2.imdecode(encoded,cv2.IMREAD_COLOR)
        sid=str(2000000+i);path=Path('images')/(sid+'.png');assert cv2.imwrite(str(a.output/path),render)
        output.append({'sample_id':sid,'category':'name','region_id':'synthetic.name','split':'train','label':label,'image_path':str(path),
                       'file_sha256':hashlib.sha256((a.output/path).read_bytes()).hexdigest(),'glyph_sources':[by_id[e['sample_id']]['sample_id'] for e in sources if e['character'] in label],
                       'repeated_character':char,'run_length':length,'gap':gap,'text_width':text_width,'canvas_width':width,'baseline':baseline,'background_boundary':boundary})
        used.add(label)
        if i<72:sample_images.append((label,render.copy()))
    (a.output/'manifest.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in output))
    (a.output/'labels.txt').write_text(''.join(r['image_path']+'\t'+r['label']+'\n' for r in output))
    for block in range(3):
        examples=sample_images[block*24:(block+1)*24];sheet=np.full((len(examples)*70,700,3),235,np.uint8)
        for index,(label,image) in enumerate(examples):
            cv2.putText(sheet,label,(5,index*70+15),0,.45,(0,0,0),1)
            image=cv2.resize(image,(image.shape[1]*2,image.shape[0]*2),interpolation=cv2.INTER_NEAREST)
            # Display the whole render at a uniform 1.4x scale to fit each row.
            image=cv2.resize(image,(round(image.shape[1]*.7),round(image.shape[0]*.7)),interpolation=cv2.INTER_NEAREST)
            sheet[index*70+20:index*70+20+image.shape[0],5:5+image.shape[1]]=image
        cv2.imwrite(str(a.output/f'contact-{block}.png'),sheet)
    audit={'samples':len(output),'unique_labels':len(used),'seed':202611071,'heldout_or_challenge_label_overlap':len(used & excluded),'glyph_sources':sources,
           'all_glyph_sources_training_only':True,'text_clipped':False,'maximum_text_width':186,'real_capture_claim':False,
           'visual_review_required':['glyph-bank.png','contact-0.png','contact-1.png','contact-2.png']}
    (a.output/'audit.json').write_text(json.dumps(audit,indent=2));print(json.dumps({k:v for k,v in audit.items() if k!='glyph_sources'}))


if __name__=='__main__':main()
