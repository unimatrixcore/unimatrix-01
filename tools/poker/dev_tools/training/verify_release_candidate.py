#!/usr/bin/env python3
"""Measure pinned GPU reader acceptance and bounded archived-frame replay.

Archived pixels and generated capture IDs/times exercise software; they are
explicitly not a fresh monitor capture or proof of prospective accuracy.
"""

import sys as _storage_sys
from pathlib import Path as _StoragePath
_storage_sys.path.insert(0, str(_StoragePath(__file__).resolve().parents[1]))
from lib.storage_paths import training_dir, data_dir

import argparse
import hashlib
import json
from pathlib import Path
import statistics
import time

import cv2

from realtime_collector import RealtimeCollector


def release_inputs(root):
    """Resolve the exact packaged model/config roles the service will load."""
    root = Path(root).resolve()
    runtime_path = root / 'runtime.json'
    config = json.loads(runtime_path.read_text())
    def artifact(key):
        path = Path(config[key])
        return path if path.is_absolute() else root / path
    paths = {key: artifact(key) for key in ('general_model', 'name_model', 'regions', 'colors')}
    regions = json.loads(paths['regions'].read_text())
    colors = json.loads(paths['colors'].read_text())
    return paths, regions, colors, hashlib.sha256(runtime_path.read_bytes()).hexdigest()


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,default=training_dir() / 'release-candidate')
    p.add_argument('--period',type=float,default=.5);p.add_argument('--frames',type=int,default=42)
    a=p.parse_args();root=a.root
    if a.frames<1 or a.period<=0:raise ValueError('Positive frame count and period required')
    paths,regions,colors,runtime_sha256=release_inputs(root)
    service=RealtimeCollector(paths['general_model'],regions,colors,name_model_dir=paths['name_model'],frozen_path=root/'freeze.json')
    report={'freeze_sha256':hashlib.sha256((root/'freeze.json').read_bytes()).hexdigest(),'runtime_sha256':runtime_sha256,'artifact_paths':{key:str(value) for key,value in paths.items()},'device':'desktop CUDA','cuda':{role:m.cuda_placement_proof for role,m in [('general',service.reader.model),('names',service.reader.name_model)]},'limitations':'Archived real pixels with generated identities/timing. Correlated sealed captures, reused development source frames. No live physical capture claim.'}
    try:
        labels=[json.loads(l) for l in (root/'sealed-labels.jsonl').read_text().splitlines()];sealed=[]
        for index,filename in enumerate(sorted({r['filename'] for r in labels})):
            image=cv2.imread(str(root/'sealed-captures'/filename));service.reader.reset_temporal();frames=[]
            # Synthetic distinct observations establish software confirmation only.
            for j in range(3):frames.append(service.reader.read_frame(image,regions,colors,f'sealed-{index}-{j}',float(index*3+j)))
            if frames[0]['accepted_frame'] or frames[0]['regions'] or frames[0]['active_seats']:
                raise AssertionError('First capture exposed unconfirmed body observations')
            final=frames[1]  # Score the second capture, not a later warmed third.
            for row in [r for r in labels if r['filename']==filename]:
                entry=final['regions'].get(row['region_id']);decision=entry['decision'] if entry else {'state':'unknown','text':None,'reason':'not_admitted'}
                sealed.append({**row,'decision':decision,'accepted_wrong':decision['state']!='unknown' and decision['text']!=row['label']})
        report['sealed']={'temporal_observations_per_scored_target':2,'first_capture_bodies_private':True,'samples':len(sealed),'accepted':sum(r['decision']['state']!='unknown' for r in sealed),'accepted_wrong':sum(r['accepted_wrong'] for r in sealed),'rows':sealed}
        replay=json.loads(training_dir() / 'production-v11/reader-replay-dual-gpu.json'.read_text())
        images=[cv2.imread(str(data_dir() / 'collector_datasets/legacy/full_captures'/r['source_filename'])) for r in replay['frames']]
        if any(im is None for im in images):raise ValueError('Missing replay image')
        # Clear warm crop results for the stream's initial frame; subsequent
        # caching reflects actual pixel equality, never label equality.
        service.reader.cache.clear();service.reader.reset_temporal()
        observed=[];start=time.monotonic();submitted=0;seen=set();reads=[];available_ages=[]
        while time.monotonic()<start+a.frames*a.period+1.1:
            now=time.monotonic()
            if submitted<a.frames and now>=start+submitted*a.period:
                source=(submitted//3)%len(images)
                service.submit_frame(images[source],f'stream-{submitted}',now)
                submitted+=1
            before=time.perf_counter();latest=service.get_latest();read_ms=(time.perf_counter()-before)*1000;reads.append(read_ms)
            if latest['state']=='available':available_ages.append(latest['capture_age_ms'])
            key=(latest['state'],latest['frame_id'],latest['reason'])
            if key not in seen:
                seen.add(key);value=latest['value'] or {}
                observed.append({'at_ms':(time.monotonic()-start)*1000,'state':latest['state'],'reason':latest['reason'],'frame_id':latest['frame_id'],'capture_age_ms':latest.get('capture_age_ms'),'dropped_count':latest['dropped_count'],'reader_elapsed_ms':value.get('elapsed_ms'),'accepted_frame':value.get('accepted_frame'),'accepted_regions':sum(r['decision']['state']!='unknown' for r in value.get('regions',{}).values())})
            time.sleep(.02)
        available=[r for r in observed if r['state']=='available'];ages=[r['capture_age_ms'] for r in available]
        report['stream']={'submitted':submitted,'period_ms':a.period*1000,'available_publications':len(available),'maximum_published_age_ms':max(available_ages) if available_ages else None,'maximum_new_publication_age_ms':max(ages) if ages else None,'available_read_count':len(available_ages),'stale_publications':sum(age>1000 for age in available_ages),'maximum_getter_ms':max(reads),'median_getter_ms':statistics.median(reads),'observations':observed}
    finally:service.close()
    (root/'runtime-acceptance.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({'sealed':{k:v for k,v in report['sealed'].items() if k!='rows'},'stream':{k:v for k,v in report['stream'].items() if k!='observations'},'cuda':report['cuda']}))

if __name__=='__main__':main()
