#!/usr/bin/env python3
"""Copy the curated corpus into a portable bundle, leaving source data intact."""

import sys as _storage_sys
from pathlib import Path as _StoragePath
_storage_sys.path.insert(0, str(_StoragePath(__file__).resolve().parents[1]))
from lib.storage_paths import training_dir, data_dir

import argparse,json,shutil,tarfile
from pathlib import Path

def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=training_dir());a=p.parse_args();b=a.root/'full-bundle';(b/'images').mkdir(parents=True,exist_ok=True);(b/'upstream/ocrs_models').mkdir(parents=True,exist_ok=True)
 rows=[json.loads(l) for l in (a.root/'full/curated.jsonl').read_text().splitlines()]
 for r in rows:
  dest=Path('images')/(r['sample_id']+'.png');shutil.copy2(r['image_path'],b/dest);r['image_path']=str(dest)
 (b/'curated.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
 for name in ['train_reviewed.py','requirements.txt']:shutil.copy2(Path(__file__).parent/name,b/name)
 shutil.copy2(a.root/'full/audit.json',b/'audit.json');shutil.copy2(a.root/'text-rec-checkpoint-s52qdbqt.pt',b/'base.pt')
 for cat in ['name','bank','other']:
  src=a.root/f'full-{cat}'
  for name in ['report.json','report.md']:
   if (src/name).exists():shutil.copy2(src/name,b/f'report-{cat}{Path(name).suffix}')
 shutil.copy2(a.root/'ocrs-models/ocrs_models/models.py',b/'upstream/ocrs_models/models.py');shutil.copy2(a.root/'ocrs-models/LICENSE.md',b/'upstream/LICENSE.md')
 (b/'upstream/COMMIT').write_text('a63bee16bf0c888e4ce7fe09ad124c83287444ee\n')
 with tarfile.open(a.root/'full-bundle.tar.gz','w:gz') as t:t.add(b,arcname='full-bundle')
 print(f'Packaged {len(rows)} crops, {(a.root/"full-bundle.tar.gz").stat().st_size} bytes')
if __name__=='__main__':main()
