#!/usr/bin/env python3
"""Build reversible, train-only variations without truncating labeled pixels.

Positive context crops expand recorded full-capture rectangles and verify that
the complete original is still present. Negative geometry changes only pad the
original pixels: importing unreviewed neighboring content could invalidate a
negative label. True destructive recrops remain separate robustness tests.
"""
import argparse
import collections
import hashlib
import json
import sqlite3
from pathlib import Path

import cv2
import numpy as np
from schemas import CONTRACT, CONTRACT_SHA256


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def photometric(image, quality, brightness):
    result = np.clip(image.astype(np.int16) + brightness, 0, 255).astype(np.uint8)
    ok, encoded = cv2.imencode('.jpg', result, [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return cv2.imdecode(encoded, cv2.IMREAD_COLOR)


def padded(image, margins):
    left, right, top, bottom = margins
    color = tuple(float(v) for v in np.median(image.reshape(-1, 3), axis=0))
    return cv2.copyMakeBorder(image, top, bottom, left, right, cv2.BORDER_CONSTANT, value=color)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.manifest.read_text().splitlines()]
    args.output.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect((args.bundle / 'database-snapshot.db').resolve().as_uri() + '?mode=ro', uri=True)
    filenames = dict(db.execute('select id,filename from full_captures'))
    captures = collections.defaultdict(set)
    for row in rows:
        if row['source_id'] is not None:
            captures[row['source_id']].add(row['split'])
    assert all(len(splits) == 1 for splits in captures.values())
    output = []; counts = collections.Counter(); source_hashes = {}; examples = []
    cached_id = object(); full = None
    for row in sorted(rows, key=lambda r: (r['source_id'] or -1, int(r['sample_id']))):
        if not row.get('optimize', True):
            continue
        source = args.bundle / row['image_path']
        assert digest(source) == row['file_sha256']
        image = cv2.imread(str(source)); assert image is not None
        train = row['split'] == 'train'
        variants = [('original', image, {'preserves_original_pixels': True})]
        if train:
            variants += [('jpeg88_dark', photometric(image, 88, -8), {}),
                         ('jpeg94_light', photometric(image, 94, 7), {})]
            h, w = image.shape[:2]
            smaller = cv2.resize(image, (max(4, round(w*.9)), max(4, round(h*.9))), interpolation=cv2.INTER_AREA)
            variants.append(('scale90', smaller, {}))
            sid = row['source_id']
            if sid != cached_id:
                cached_id = sid; full = None
                name = filenames.get(sid)
                if name and Path(name).name == name:
                    path = args.sources / name
                    if path.is_file():
                        full = cv2.imread(str(path)); source_hashes[name] = digest(path)
            for index, margins in enumerate([(3, 1, 2, 1), (1, 3, 1, 3)]):
                left, right, top, bottom = margins
                extra = {'margins_lrtb': margins, 'preserves_original_pixels': True}
                context = None
                if row['label'] and full is not None and all(isinstance(row.get(k), int) for k in ['x','y','w','h']):
                    x,y,w,h = (row[k] for k in ['x','y','w','h'])
                    if x >= left and y >= top and x+w+right <= full.shape[1] and y+h+bottom <= full.shape[0]:
                        assert np.array_equal(full[y:y+h,x:x+w], image), row['sample_id']
                        context = full[y-top:y+h+bottom,x-left:x+w+right].copy()
                        assert np.array_equal(context[top:top+h,left:left+w], image)
                        extra.update(full_capture=True, source_filename=filenames[sid])
                if context is None:
                    context = padded(image, margins); extra['full_capture'] = False
                variants.append((f'context{index}', context, extra))
        for variant, data, extra in variants:
            name = f"images/{row['sample_id']}-{variant}.png"
            target = args.output / name; target.parent.mkdir(exist_ok=True)
            assert cv2.imwrite(str(target), data)
            record = {**row, 'parent_sample_id': row['sample_id'], 'sample_id': row['sample_id']+'-'+variant,
                      'image_path': name, 'augmentation': variant, 'file_sha256': digest(target), **extra,
                      'validation_contract': {'version':CONTRACT['version'],'sha256':CONTRACT_SHA256}}
            output.append(record); counts[(row['split'], variant, bool(row['label']))] += 1
        # Diversify contacts by category/label-kind, avoiding the first capture only.
        key = (row['category'], bool(row['label']))
        if train and sum(e['key'] == key for e in examples) < 3:
            examples.append({'key': key, 'row': row, 'variants': variants})
    rng = np.random.default_rng(20261107); rng.shuffle(output)
    (args.output/'manifest.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in output))
    for split in ['train','val','test']:
        selected = [r for r in output if r['split'] == split]
        assert split == 'train' or all(r['augmentation'] == 'original' for r in selected)
        (args.output/(split+'.jsonl')).write_text(''.join(json.dumps(r)+'\n' for r in selected))
    audit = {'rows': len(output), 'source_manifest_sha256': digest(args.manifest), 'seed': 20261107,
             'validation_contract': {'version':CONTRACT['version'],'sha256':CONTRACT_SHA256},
             'counts': [{'split': k[0], 'variant': k[1], 'positive': k[2], 'count': v} for k,v in counts.items()],
             'source_sha256': source_hashes, 'cross_split_source_groups': 0,
             'negative_policy': 'No imported full-capture context; all source negatives remain negatives.',
             'label_safety': 'No geometry operation removes any original labeled pixels. Context positives retain original target, may add neighboring distractors.',
             'synthetic_repetition': 'Not embedded here: attach separately after training-only provenance verification.'}
    (args.output/'audit.json').write_text(json.dumps(audit, indent=2))
    # All examples use fixed display scale; no stretching relative glyph widths.
    sheet = np.full((len(examples)*112, 1200, 3), 235, np.uint8)
    contact = []
    for index, example in enumerate(examples):
        row = example['row']; y = index*112
        cv2.putText(sheet, f"{row['sample_id']} {row['category']} target={row['label']!r}", (5,y+15), cv2.FONT_HERSHEY_SIMPLEX, .4, (0,0,0), 1)
        picks = [example['variants'][i] for i in [0,1,4,5]]
        for col,(name,im,meta) in enumerate(picks):
            cv2.putText(sheet,name,(col*300+5,y+32),cv2.FONT_HERSHEY_SIMPLEX,.35,(0,0,0),1)
            scale = min(290/im.shape[1], 70/im.shape[0], 3)
            im = cv2.resize(im,(max(1,round(im.shape[1]*scale)),max(1,round(im.shape[0]*scale))),interpolation=cv2.INTER_NEAREST)
            sheet[y+38:y+38+im.shape[0],col*300+5:col*300+5+im.shape[1]] = im
        contact.append({'sample_id':row['sample_id'],'category':row['category'],'label':row['label']})
    cv2.imwrite(str(args.output/'contact.png'),sheet)
    (args.output/'contact.json').write_text(json.dumps(contact,indent=2))
    print(json.dumps({'rows': len(output), 'splits': dict(collections.Counter(r['split'] for r in output)), 'examples':len(examples)}))


if __name__ == '__main__':
    main()
