#!/usr/bin/env python3
"""Describe collector visual-condition coverage; hints are not human labels.

Use configured RGB colors on original crops, without resizing or removing rows.
This is reporting only and never controls sample acceptance or split assignment.
"""

import sys as _storage_sys
from pathlib import Path as _StoragePath
_storage_sys.path.insert(0, str(_StoragePath(__file__).resolve().parents[1]))
from lib.storage_paths import training_dir, data_dir, config_file

import argparse,collections,json
from pathlib import Path
from PIL import Image,ImageChops,ImageStat


def density(image, color, tolerance=12):
    rgb=tuple(bytes.fromhex(color.lstrip('#')))
    masks=[channel.point([255 if abs(v-target)<=tolerance else 0 for v in range(256)])
           for channel,target in zip(image.split(),rgb)]
    return ImageStat.Stat(ImageChops.multiply(ImageChops.multiply(masks[0],masks[1]),masks[2])).mean[0]/255


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--manifest',type=Path,default=training_dir() / 'full/curated.jsonl')
    parser.add_argument('--colors',type=Path,default=config_file('colors.json', Path(__file__).resolve().parents[2] / 'src-tauri/assets/colors.json'))
    args=parser.parse_args()
    colors=json.loads(args.colors.read_text());rows=[json.loads(l) for l in args.manifest.read_text().splitlines()]
    results=[]
    for row in rows:
        hint='not_classified';score=0
        with Image.open(row['image_path']) as source:
            image=source.convert('RGB')
            if row['category']=='card':
                choices={f'{state}_{suit}':density(image,color) for state,key in [('normal','suits'),('dimmed','dim_suits')] for suit,color in colors[key].items()}
                hint,score=max(choices.items(),key=lambda item:item[1])
                if score<.05:hint='card_unknown'
            elif row['category'] in {'name','bank'}:
                scores={name:density(image,colors[name]) for name in ['nameplate','in_turn','in_turn_urgent']}
                states=[name for name in ['nameplate','in_turn','in_turn_urgent'] if scores[name]>=.05]
                hint='+'.join(states) or 'plate_unknown';score=sum(scores.values())
        results.append({'sample_id':row['sample_id'],'category':row['category'],'split':row['split'],'condition_hint':hint,'matched_fraction':score})
    output=args.manifest.parent
    (output/'condition-hints.json').write_text(json.dumps(results,indent=2)+'\n')
    coverage={split:dict(collections.Counter(r['condition_hint'] for r in results if r['split']==split)) for split in ['train','val','test']}
    report={'method':'Configured original-RGB color density within tolerance 12; >=5% support. Reporting hints only, not human condition annotations. Mixed nameplate progress colors remain combined. No pruning/resizing.','coverage':coverage}
    (output/'condition-coverage.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))

if __name__=='__main__':
    main()
