#!/usr/bin/env python3
"""Preserve collector variants; split using provenance rather than text similarity.

The collector already rejects dHash distance <=2 within an exact region ID.
Same labels across seats, dimensions, backgrounds and dimness are useful data.
No resized grayscale similarity threshold is used to delete these examples.
"""

import sys as _storage_sys
from pathlib import Path as _StoragePath
_storage_sys.path.insert(0, str(_StoragePath(__file__).resolve().parents[1]))
from lib.storage_paths import training_dir, data_dir

import argparse,collections,hashlib,json,sqlite3
from pathlib import Path
from PIL import Image
from schemas import valid, category_for_region, CONTRACT, CONTRACT_SHA256

CORRECTIONS={2525:'S 451 BB',2698:'S 49 BB',2802:'S 32 BB',7872:'G 2 BB',8248:'G 76.3 BB',8425:'G 96.3 BB'}
# Full-corpus disagreement review: pixels verified independently of prediction;
# source recrops matched exactly for 29/31, two sources are unavailable.
CORRECTIONS.update({487:'G 117.4 BB',1556:'Gto68',1679:'G 241.5 BB',1993:'G 342.5 BB',2054:'SB',2724:'S 153.5 BB',2879:'Krzyjess',2937:'S 129.5 BB S 24 BB S 9 BB',3617:'G 12.5 BB',3650:'G 89.1 BB',6659:'G 184.6 BB',6764:'G 39.4 BB G 7.2 BB'})
CORRECTIONS.update({i:'Show Cards' for i in [1658,1664,1732,1736,1750,1936]})
CORRECTIONS.update({i:'littlelifters' for i in [2014,2047,2181,2344,2346,2426,2457,2459,2461,2521,2524,2531,2533]})
QUARANTINE={8137:'Target final B visibly clipped by right crop boundary; keep source for later geometry review.'}

def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=training_dir());p.add_argument('--snapshot',type=Path,default=training_dir() / 'source-snapshot.db');p.add_argument('--negative-review',type=Path,default=Path(__file__).with_name('verified-negative-review.json'));a=p.parse_args()
 negative_review=json.loads(a.negative_review.read_text());assert negative_review['complete_visual_audit']
 negative_decisions={int(r['sample_id']):r for r in negative_review['decisions'] if r['decision']=='negative' and r['visually_reviewed']}
 c=sqlite3.connect(f'file:{a.snapshot}?mode=ro',uri=True);c.row_factory=sqlite3.Row
 originals=[dict(r) for r in c.execute('select * from images order by id')]
 visual=set()
 for category in ['bank','name','other']:
  for line in (a.root/f'full-{category}/accepted.jsonl').read_text().splitlines():
   r=json.loads(line)
   if r['review_status']=='visually_verified':visual.add(int(r['sample_id']))
 visual.update(r['id'] for r in map(json.loads,(a.root/'curated.jsonl').read_text().splitlines()))
 # Parent explicitly re-reviewed every game ID, varied same-label specimens,
 # previous exclusions, and all four malformed transcriptions against pixels.
 visual.update(r['id'] for r in originals if r['region_id']=='round_id' and r['label'])
 visual.update(r['id'] for r in json.loads((a.root/'variant-review/rows.json').read_text()))
 visual.update(CORRECTIONS);visual.update([4265,3212,6550,5390,5359,2885,8821,8802,585,7486,8284,8543])
 visual.update(negative_decisions)
 captures=[dict(r) for r in c.execute('select id,timestamp from full_captures order by timestamp')]
 session=0;prev=None;source_session={};starts={}
 for r in captures:
  if prev is None or r['timestamp']-prev>600000:session+=1;starts[session]=r['timestamp']
  source_session[r['id']]=session;prev=r['timestamp']
 accepted=[];excluded=[];by_pixels=collections.defaultdict(list)
 image_root=data_dir() / 'collector_datasets/legacy/images'
 for r in originals:
  rid=r['region_id'];r['category']=category_for_region(rid)
  r['validation_contract']={'version':CONTRACT['version'],'sha256':CONTRACT_SHA256}
  if r['category'] is None:r['reason']='Unsupported OCR region';excluded.append(r);continue
  r['sample_id']=str(r['id']);r['image_path']=str(image_root/r['filename'])
  is_negative=not r['label'] and r['id'] in negative_decisions
  if not r['label'] and not is_negative:r['reason']='Empty label has no completed visual negative review';excluded.append(r);continue
  if is_negative:
   if hashlib.sha256(Path(r['image_path']).read_bytes()).hexdigest()!=negative_decisions[r['id']]['source_file_sha256']:r['reason']='Reviewed negative pixels changed; visual review must be renewed';excluded.append(r);continue
   r['label']='';r['label_kind']='verified_negative';r['negative_review_evidence']=negative_decisions[r['id']]
  else:r['label_kind']='existing_positive'
  if r['id'] in QUARANTINE:r['reason']=QUARANTINE[r['id']];excluded.append(r);continue
  if r['id'] in CORRECTIONS:r['original_label']=r['label'];r['label']=CORRECTIONS[r['id']];r['correction_evidence']='Individual pixel review; reviewed-label-corrections.json and historical invalid-label sheets; source DB unchanged'
  if not is_negative and not valid(r):r['reason']='Schema invalid after reviewed corrections';excluded.append(r);continue
  try:
   with Image.open(r['image_path']) as im:
    im=im.convert('RGB');r['pixel_sha256']=hashlib.sha256(f'{im.width}x{im.height}:'.encode()+im.tobytes()).hexdigest();r['image_width'],r['image_height']=im.size
  except Exception as e:r['reason']=f'Image decode failure: {e}';excluded.append(r);continue
  r['review_status']='visually_verified' if r['id'] in visual else 'collector_labeled_audited'
  r['capture_session']=source_session.get(r['source_id']);by_pixels[r['pixel_sha256']].append(r);accepted.append(r)
 # Conflicting byte-identical images are quarantined; matching duplicates stay
 # represented and force their entire capture sessions into the same split.
 conflicts={sha for sha,rs in by_pixels.items() if len({r['label'] for r in rs})>1}
 kept=[]
 for r in accepted:
  if r['pixel_sha256'] in conflicts:r['reason']='Identical pixels with conflicting annotations';excluded.append(r)
  else:kept.append(r)
 accepted=kept;parent={s:s for s in [None,*starts]}
 def find(s):
  while parent[s]!=s:parent[s]=parent[parent[s]];s=parent[s]
  return s
 def union(s,t):
  s,t=find(s),find(t)
  if s!=t:parent[t]=s
 for sha,rs in by_pixels.items():
  if sha not in conflicts:
   for r in rs[1:]:union(rs[0]['capture_session'],r['capture_session'])
 component_counts=collections.Counter(find(r['capture_session']) for r in accepted)
 unknown=find(None)
 components=collections.defaultdict(list)
 for s in starts:components[find(s)].append(s)
 eligible=sorted((g for g,n in component_counts.items() if g!=unknown and n>=100),key=lambda g:max(starts[s] for s in components[g]))
 assert len(eligible)>=3
 val_group,test_group=eligible[-2:]
 for r in accepted:
  g=find(r['capture_session']);r['group_id']=f'provenance-{g}' if g is not None else 'provenance-unknown';r['split']='test' if g==test_group else 'val' if g==val_group else 'train'
 # Audit collector-equivalent cross-split similarities as signals only. Keep
 # each valid variant; do not redefine duplicate by label or broad category.
 per_region=collections.defaultdict(list)
 for r in accepted:per_region[r['region_id']].append(r)
 signals=[]
 for region,rs in per_region.items():
  for i,r in enumerate(rs):
   for s in rs[:i]:
    if r['split']!=s['split'] and r['phash'] and s['phash']:
     distance=(int(r['phash'],16)^int(s['phash'],16)).bit_count()
     if distance<=2:signals.append({'ids':[s['id'],r['id']],'region_id':region,'distance':distance,'labels':[s['label'],r['label']],'dimensions':[[s['image_width'],s['image_height']],[r['image_width'],r['image_height']]]})
 out=a.root/'full';out.mkdir(exist_ok=True)
 for name,rs in [('curated',accepted),('exclusions',excluded)]:
  (out/f'{name}.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rs))
 (out/'similarity-review-signals.json').write_text(json.dumps(signals,indent=2)+'\n')
 for key in ['source_id','group_id','pixel_sha256']:
  seen={}
  for r in accepted:
   if key=='source_id' and r[key] is None:continue
   if r[key] in seen:assert seen[r[key]]==r['split'],key
   seen[r[key]]=r['split']
 splits=collections.Counter(r['split'] for r in accepted);assert min(splits.values())>=100
 report={'accepted':len(accepted),'excluded':len(excluded),'splits':dict(splits),'snapshot_sha256':hashlib.sha256(a.snapshot.read_bytes()).hexdigest(),'visually_reviewed_ids':sorted(r['id'] for r in accepted if r['review_status']=='visually_verified'),'visually_verified':sum(r['review_status']=='visually_verified' for r in accepted),'collector_labeled_audited':sum(r['review_status']=='collector_labeled_audited' for r in accepted),'unknown_source_training_only':sum(r['source_id'] is None for r in accepted),'corrected_labels':CORRECTIONS,'quarantine':QUARANTINE,'exact_pixel_conflicts':len(conflicts),'exact_pixel_duplicate_groups':sum(len(rs)>1 for rs in by_pixels.values()),'same_region_dhash_cross_split_review_signals':len(signals),'coverage':{s:{'categories':dict(collections.Counter(r['category'] for r in accepted if r['split']==s)),'regions':dict(collections.Counter(r['region_id'] for r in accepted if r['split']==s)),'dimensions':dict(collections.Counter(f"{r['image_width']}x{r['image_height']}" for r in accepted if r['split']==s))} for s in splits},'policy':'Retain valid collector variants. No same-label or grayscale-MAE pruning. Source captures stay together; sessions separated by >10 minute gaps and linked by identical decoded pixels remain together. Hold out latest two provenance components with >=100 labels. Unknown-source component is training only. Same-region stored dHash<=2 is a review signal only.','limitations':'Most labels retain collector annotation plus category audit, not individual second review. Stored hashes can reflect recrop migration. Offline raw field-crop recognizer evaluation does not establish end-to-end ocrs detector/recognizer integration quality.'}
 report.update(verified_negative_count=sum(r['label_kind']=='verified_negative' for r in accepted),negative_review_sha256=hashlib.sha256(a.negative_review.read_bytes()).hexdigest(),target_policy='Reviewed negatives retain true empty strings. Unknown empty labels require visual review. Blank-aware CTC encoder is mandatory for Paddle training; never substitute a space target.')
 (out/'audit.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k not in ['coverage','visually_reviewed_ids']},indent=2))
if __name__=='__main__':main()
