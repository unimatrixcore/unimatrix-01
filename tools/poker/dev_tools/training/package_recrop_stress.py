#!/usr/bin/env python3
"""Package deterministic shifted crops from recorded full-capture coordinates."""

import sys as _storage_sys
from pathlib import Path as _StoragePath
_storage_sys.path.insert(0, str(_StoragePath(__file__).resolve().parents[1]))
from lib.storage_paths import training_dir, data_dir

import collections, hashlib, json, sqlite3, tarfile
from pathlib import Path
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BASE = training_dir()
INPUT = BASE / 'stress-database'
OUT = BASE / 'stress-recrops'
SOURCES = data_dir() / 'collector_datasets/legacy/full_captures'
OFFSETS = {'x_minus2': (-2, 0), 'x_plus2': (2, 0), 'y_minus2': (0, -2), 'y_plus2': (0, 2), 'x_plus4': (4, 0), 'y_plus4': (0, 4)}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(line) for line in (INPUT / 'manifest.jsonl').read_text().splitlines()]
    db = sqlite3.connect(f'file:{INPUT / "database-snapshot.db"}?mode=ro', uri=True)
    names = dict(db.execute('select id, filename from full_captures'))
    groups = collections.defaultdict(list)
    for row in rows: groups[row.get('source_id')].append(row)
    availability = {k: {} for k in OFFSETS}
    equality = collections.Counter()
    examples = []
    source_hashes = {}
    for source_id, group in groups.items():
        filename = names.get(source_id)
        path = SOURCES / filename if filename and Path(filename).name == filename else None
        img = cv2.imread(str(path)) if path and path.is_file() else None
        if img is not None: source_hashes[filename] = sha(path)
        for row in group:
            sid = str(row['sample_id'])
            coords = [row.get(k) for k in ('x', 'y', 'w', 'h')]
            reason = None
            if source_id is None: reason = 'no_source_id'
            elif filename is None: reason = 'source_id_not_found'
            elif path is None: reason = 'invalid_source_filename'
            elif not path.is_file(): reason = 'missing_source_file'
            elif img is None: reason = 'source_decode_failed'
            elif any(not isinstance(v, int) for v in coords): reason = 'missing_geometry'
            elif coords[2] <= 0 or coords[3] <= 0: reason = 'invalid_geometry'
            meta = {'source_id': source_id, 'source_filename': filename, 'geometry': coords}
            if reason:
                equality[reason] += 1
                for condition in OFFSETS: availability[condition][sid] = {**meta, 'reason': reason}
                continue
            x,y,w,h = coords
            ih,iw = img.shape[:2]
            original = None
            if x >= 0 and y >= 0 and x+w <= iw and y+h <= ih:
                original = img[y:y+h,x:x+w]
                existing = cv2.imread(str(INPUT / row['image_path']))
                if existing is None: equality['existing_crop_missing_or_invalid'] += 1
                elif existing.shape != original.shape: equality['dimension_mismatch'] += 1
                elif np.array_equal(existing, original): equality['equal'] += 1
                else: equality['pixel_mismatch'] += 1
            else: equality['original_out_of_bounds'] += 1
            for condition,(dx,dy) in OFFSETS.items():
                xx,yy=x+dx,y+dy
                entry = {**meta, 'source_size': [iw,ih], 'offset': [dx,dy]}
                if xx < 0 or yy < 0 or xx+w > iw or yy+h > ih:
                    entry['reason'] = 'out_of_bounds'
                else:
                    dest = OUT / condition / 'images' / (sid + '.png')
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    crop = img[yy:yy+h,xx:xx+w]
                    if not cv2.imwrite(str(dest), crop): raise RuntimeError(str(dest))
                    entry.update(reason='available', sha256=sha(dest), size=[w,h])
                    if original is not None and len(examples) < 12:
                        examples.append((sid, condition, original.copy(), crop.copy()))
                availability[condition][sid] = entry
    (OUT / 'availability.json').write_text(json.dumps(availability, sort_keys=True))
    counts = {k: dict(collections.Counter(v['reason'] for v in vals.values())) for k,vals in availability.items()}
    report = {'rows': len(rows), 'conditions': counts, 'original_recrop_vs_existing': dict(equality), 'offsets': OFFSETS, 'manifest_sha256': sha(INPUT/'manifest.jsonl'), 'database_sha256': sha(INPUT/'database-snapshot.db'), 'source_sha256': source_hashes, 'contact_sheet_pairs': [{'sample_id': s, 'condition': c} for s,c,_,_ in examples]}
    (OUT / 'report.json').write_text(json.dumps(report, indent=2, sort_keys=True))
    if examples:
        sheet = np.full((len(examples)*100, 800, 3), 245, np.uint8)
        for i,(sid,condition,a,b) in enumerate(examples):
            cv2.putText(sheet, f'{sid} {condition}', (5,i*100+18), cv2.FONT_HERSHEY_SIMPLEX, .5, (0,0,0), 1)
            for j,im in enumerate((a,b)):
                scale=min(350/im.shape[1], 72/im.shape[0], 4)
                im=cv2.resize(im, (max(1,int(im.shape[1]*scale)),max(1,int(im.shape[0]*scale))), interpolation=cv2.INTER_NEAREST)
                sheet[i*100+25:i*100+25+im.shape[0], 5+j*390:5+j*390+im.shape[1]]=im
        cv2.imwrite(str(OUT/'contact-sheet.png'), sheet)
    with tarfile.open(BASE/'stress-recrops.tar.gz', 'w:gz') as tar: tar.add(OUT, arcname='stress-recrops')
    print(json.dumps({'rows':len(rows),'conditions':counts,'equality':dict(equality),'pairs':len(examples)}))

if __name__ == '__main__': main()
