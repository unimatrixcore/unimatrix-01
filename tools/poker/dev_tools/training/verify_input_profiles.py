#!/usr/bin/env python3
"""Compare reproducible pixel profiles with the actual train/evaluation inputs."""
import argparse,json
from pathlib import Path
import cv2,numpy as np
from prepare_ocr_inputs import localize_pill,normalize_name
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);a=p.parse_args();root=a.root.resolve();rows=[json.loads(l) for l in (root/'compact-ocr-v5/manifest.jsonl').read_text().splitlines()];results=[]
for profile,directory in [('v4-training','compact-ocr-v4/inputs'),('v5-training','compact-ocr-v5/inputs'),('runtime','compact-ocr-v5/final-inputs')]:
    mismatches=[]
    for row in rows:
        image=cv2.imread(str(root/'full-bundle'/row['image_path']))
        image,_=localize_pill(image,row['category'],profile!='v4-training',profile=='runtime')
        if row['category']=='name':image,_=normalize_name(image,remove_all_border=profile!='v4-training')
        expected=cv2.imread(str(root/directory/row['image_path']))
        if not np.array_equal(image,expected):mismatches.append(row['sample_id'])
    results.append({'profile':profile,'samples':len(rows),'pixel_mismatches':mismatches})
    print(profile,len(mismatches),'mismatches',flush=True)
(root/'compact-ocr-v5/input-profile-verification.json').write_text(json.dumps(results,indent=2));assert all(not r['pixel_mismatches'] for r in results),results
