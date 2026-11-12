#!/usr/bin/env python3
"""Generate repetition examples from unambiguously segmented training names."""
import argparse
import json
import random
import re
from pathlib import Path

import cv2
import numpy as np
from prepare_ocr_inputs import normalize_name

TARGET = 'ilI0O'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--image-root', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--count', type=int, default=2000)
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--reviewed-bank', type=Path, required=True,
                   help='Manually checked glyph source IDs and x bounds; auto-alignment is unsafe')
    a = p.parse_args()
    if a.count < 1:
        p.error('--count must be positive')
    rows = [json.loads(line) for line in a.manifest.read_text().splitlines() if line.strip()]
    heldout = {r['label'] for r in rows if r.get('split') in ('val', 'test') and r.get('category') == 'name'}
    selections=json.loads(a.reviewed_bank.read_text())
    bank = {entry['character']: [] for entry in selections}
    by_id={str(r['sample_id']):r for r in rows}
    for entry in selections:
        row=by_id[str(entry['sample_id'])]
        label = row.get('label', '')
        if row.get('split') != 'train' or row.get('category') != 'name' or not re.fullmatch(r'[A-Za-z0-9]+', label):
            raise ValueError('Reviewed glyph source must be a training NAME')
        image = cv2.imread(str(a.image_root / row['image_path']))
        if image is None:
            raise FileNotFoundError(row['image_path'])
        normalized, info = normalize_name(image)
        if info is None:
            continue
        gray = cv2.cvtColor(normalized, cv2.COLOR_BGR2GRAY)
        char=entry['character'];left,right=entry['x'];patch=gray[:,left:right].copy()
        ys=np.where(np.any(patch<200,axis=1))[0]
        assert len(ys)>2 and char in label
        patch=patch[ys[0]:ys[-1]+1]
        bank[char].append((patch,str(row['sample_id']),left,right))
    missing = [c for c in TARGET if not bank[c]]
    if missing:
        raise SystemExit('No aligned training glyphs for: ' + ', '.join(missing))
    a.output.mkdir(parents=True, exist_ok=True)
    images = a.output / 'images'
    images.mkdir(exist_ok=True)
    # Bank sheet includes every extracted patch, labeled by character and source ID.
    entries = [(c, item) for c in bank for item in bank[c]]
    cell_w, cell_h, cols = 150, 65, 8
    sheet = np.full(((len(entries) + cols - 1) // cols * cell_h, cols * cell_w, 3), 255, np.uint8)
    for i, (char, (patch, sid, left, right)) in enumerate(entries):
        x, y = i % cols * cell_w, i // cols * cell_h
        h, w = patch.shape
        sheet[y:y+h, x:x+w] = cv2.cvtColor(patch, cv2.COLOR_GRAY2BGR)
        cv2.putText(sheet, f'{char} {sid}:{left}-{right}', (x, y+55), cv2.FONT_HERSHEY_SIMPLEX, .35, (0, 0, 0), 1)
    cv2.imwrite(str(a.output / 'glyph-bank.png'), sheet)
    rng = random.Random(a.seed)
    records, labels = [], []
    for index in range(a.count):
        while True:
            char = rng.choice(TARGET)
            label = char * rng.randint(2, 14)
            if rng.random() < .7:
                other = rng.choice('FSBM3od')
                label = (other + label) if rng.random() < .5 else (label + other)
            if label not in heldout:
                break
        selected = [rng.choice(bank[c]) for c in label]
        height = 36
        pieces = [np.full((height, 3), 255, np.uint8)]
        provenance = []
        for patch, sid, left, right in selected:
            canvas = np.full((height, patch.shape[1]), 255, np.uint8)
            canvas[27-patch.shape[0]:27, :] = patch
            pieces.extend((canvas, np.full((height, rng.randint(1, 3)), 255, np.uint8)))
            provenance.append({'sample_id': sid, 'x': [left, right]})
        name = f'{index:06d}.png'
        line=np.concatenate(pieces,axis=1)
        canvas=np.full((height,max(198,line.shape[1]+16)),255,np.uint8)
        left=(canvas.shape[1]-line.shape[1])//2;canvas[:,left:left+line.shape[1]]=line
        if not cv2.imwrite(str(images / name), canvas):
            raise OSError('Failed to write ' + name)
        labels.append(f'images/{name}\t{label}\n')
        records.append({'image': 'images/' + name, 'label': label, 'glyphs': provenance})
    (a.output / 'labels.txt').write_text(''.join(labels))
    (a.output / 'audit.json').write_text(json.dumps({'seed': a.seed, 'manifest': str(a.manifest), 'image_root': str(a.image_root), 'bank_counts': {c: len(bank[c]) for c in TARGET}, 'samples': records}, indent=2) + '\n')


if __name__ == '__main__':
    main()
