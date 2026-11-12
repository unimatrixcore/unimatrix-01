#!/usr/bin/env python3
"""Package EVERY database image, keeping original and audited labels separate."""
import argparse,collections,hashlib,json,shutil,sqlite3,tarfile
from pathlib import Path
from curate_full import CORRECTIONS

p=argparse.ArgumentParser();p.add_argument('--snapshot',type=Path,required=True);p.add_argument('--database-root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--trained-manifest',type=Path,required=True);a=p.parse_args()
a.output.mkdir(parents=True,exist_ok=True);(a.output/'images').mkdir(exist_ok=True)
c=sqlite3.connect(a.snapshot.resolve().as_uri()+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
split={r['sample_id']:r['split'] for r in map(json.loads,a.trained_manifest.read_text().splitlines())};rows=[]
for record in c.execute('select * from images order by id'):
    r=dict(record);sid=str(r['id']);region=r['region_id'];category='card' if 'cards' in region or 'hand' in region else region.rsplit('.',1)[-1]
    destination=Path('images')/(sid+'.png');source=a.database_root/'images'/r['filename'];error=None;digest=None
    try:shutil.copy2(source,a.output/destination);digest=hashlib.sha256((a.output/destination).read_bytes()).hexdigest()
    except OSError as exc:error=str(exc)
    original=r.get('label') or ''
    r.update(sample_id=sid,category=category,image_path=str(destination),original_label=original,label=CORRECTIONS.get(r['id'],original),label_corrected=r['id'] in CORRECTIONS,split=split.get(sid,'previously_excluded_or_unlabelled'),file_sha256=digest,copy_error=error)
    rows.append(r)
(a.output/'manifest.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
report={'rows':len(rows),'nonempty_original_labels':sum(bool(r['original_label']) for r in rows),'unlabelled':sum(not r['original_label'] for r in rows),'verified_corrections':sum(r['label_corrected'] for r in rows),'copy_errors':[r['sample_id'] for r in rows if r['copy_error']],'categories':dict(collections.Counter(r['category'] for r in rows)),'snapshot_sha256':hashlib.sha256(a.snapshot.read_bytes()).hexdigest(),'selection':'Every images table row; no schema, quality, dedup, split or label filter'}
(a.output/'inventory.json').write_text(json.dumps(report,indent=2));shutil.copy2(a.snapshot,a.output/'database-snapshot.db')
with tarfile.open(str(a.output)+'.tar.gz','w:gz') as archive:archive.add(a.output,arcname=a.output.name)
print(json.dumps(report,indent=2))
