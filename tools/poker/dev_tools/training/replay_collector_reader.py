#!/usr/bin/env python3
"""Exercise the entire local reader on archived full frames, without capture.

Repeated-frame identities/timing are constructed replay controls. They verify
software state handling and latency, not fresh physical capture acceptance.
Only stored labels with exactly matching region geometry are scored as truth.
"""
import argparse
import collections
import hashlib
import json
import sqlite3
from pathlib import Path

import cv2

from production_reader import CollectorReader


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--model-dir',type=Path,required=True);p.add_argument('--manifest',type=Path,required=True)
    p.add_argument('--snapshot',type=Path,required=True);p.add_argument('--sources',type=Path,required=True);p.add_argument('--regions',type=Path,required=True)
    p.add_argument('--colors',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--view-policy',choices=['five','mixed'],default='five');p.add_argument('--device',default='cpu');p.add_argument('--threads',type=int,default=4);p.add_argument('--name-model-dir',type=Path);a=p.parse_args()
    rows=[json.loads(l) for l in a.manifest.read_text().splitlines()];by_source=collections.defaultdict(list)
    for r in rows:
        if r['source_id'] is not None:by_source[r['source_id']].append(r)
    selected=[]
    for session in [1,2,8,13,16,18,19]:
        choices=[(len(group),sid) for sid,group in by_source.items() if group[0]['capture_session']==session]
        if choices:selected.append(max(choices)[1])
    db=sqlite3.connect(a.snapshot.resolve().as_uri()+'?mode=ro',uri=True)
    sources={sid:(filename,timestamp) for sid,filename,timestamp in db.execute('select id,filename,timestamp from full_captures')}
    regions=json.loads(a.regions.read_text());colors=json.loads(a.colors.read_text());results=[];known=[]
    for sid in selected:
        filename,timestamp=sources[sid];assert Path(filename).name==filename
        path=a.sources/filename;image=cv2.imread(str(path));assert image is not None
        reader=CollectorReader(a.model_dir,view_policy=a.view_policy,device=a.device,threads=a.threads,name_model_dir=a.name_model_dir)
        frames=[]
        for index in range(3):frames.append(reader.read_frame(image,regions,colors,f'replay-{sid}-{index}',index*.5))
        third=frames[-1];truth={r['region_id']:r for r in by_source[sid]}
        # A fourth control disables the inference cache to measure the complete
        # admitted-frame cost rather than extrapolating from per-crop timings.
        reader.cache.clear();uncached=reader.read_frame(image,regions,colors,f'replay-{sid}-uncached',1.5)
        for rid,entry in third['regions'].items():
            row=truth.get(rid)
            if row is None:continue
            node=regions
            import re
            for key,index in re.findall(r'([^\.\[\]]+)|\[(\d+)\]',rid):node=node[int(index)] if index else node[key]
            expected_rect=[row.get(k) for k in ['x','y','w','h']]
            if [node[k] for k in ['x','y','w','h']]!=expected_rect:continue
            decision=entry['decision'];accepted=decision['state']!='unknown'
            known.append({'source_id':sid,'sample_id':row['sample_id'],'region_id':rid,'category':row['category'],'split':row['split'],
                          'label':row['label'],'decision':decision,'accepted_wrong':accepted and decision['text']!=row['label']})
        results.append({'source_id':sid,'source_filename':filename,'source_timestamp':timestamp,'source_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                        'capture_session':by_source[sid][0]['capture_session'],'split':by_source[sid][0]['split'],'frames':frames,'uncached_frame':uncached})
    report={'source_frames':len(results),'known_geometry_matched_targets':len(known),'accepted_wrong':sum(r['accepted_wrong'] for r in known),'view_policy':a.view_policy,'device':a.device,'threads':a.threads,
            'known_target_results':known,'frames':results,'interpretation':'Archived real pixels with synthetic replay identities/timing. No new physical captures or temporal accuracy claim.',
            'regions_sha256':hashlib.sha256(a.regions.read_bytes()).hexdigest(),'colors_sha256':hashlib.sha256(a.colors.read_bytes()).hexdigest()}
    a.output.parent.mkdir(exist_ok=True,parents=True);a.output.write_text(json.dumps(report,indent=2))
    print(json.dumps({'source_frames':len(results),'known_targets':len(known),'accepted_wrong':report['accepted_wrong'],
                      'frame_timings':[{'source':r['source_id'],'active_seats':len(r['frames'][-1]['active_seats']),'admitted_regions':len(r['frames'][-1]['regions']),
                                       'cached_ms':r['frames'][-1]['elapsed_ms'],'uncached_ms':r['uncached_frame']['elapsed_ms'],'uncached_calls':r['uncached_frame']['inference_crops']} for r in results]}))


if __name__=='__main__':main()
