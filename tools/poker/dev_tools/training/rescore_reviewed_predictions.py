#!/usr/bin/env python3
"""Apply reviewed metadata to existing predictions without changing inputs/labels.

Fails if image hashes or either transcription differ. This is metadata-only
scoring, not another inference run; original outputs/protocol remain intact.
"""
import argparse
import hashlib
import json
from pathlib import Path
from stress_ocr import stats


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for key in ('source','original_manifest','reviewed_manifest','output'):p.add_argument('--'+key.replace('_','-'),type=Path,required=True)
    a=p.parse_args();load=lambda path:{r['sample_id']:r for r in map(json.loads,path.read_text().splitlines())}
    original=load(a.original_manifest);reviewed=load(a.reviewed_manifest);assert original.keys()==reviewed.keys()
    for sid in original:
        for key in ('file_sha256','image_path','label','original_label','category','region_id'):assert original[sid][key]==reviewed[sid][key],(sid,key)
    protocol=json.loads((a.source/'protocol.json').read_text());assert protocol['manifest_sha256']==hashlib.sha256(a.original_manifest.read_bytes()).hexdigest()
    a.output.mkdir(parents=True,exist_ok=True);summary={}
    for condition in protocol['conditions']:
        rows=list(load(a.source/condition/'predictions.jsonl').values());assert {r['sample_id'] for r in rows}==set(reviewed)
        for r in rows:
            meta=reviewed[r['sample_id']]
            for key in ('label','original_label','category','region_id'):assert r[key]==meta[key]
            r.update(label_kind=meta['label_kind'],split=meta['split'])
        folder=a.output/condition;folder.mkdir(exist_ok=True)
        (folder/'predictions.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
        report=stats(rows)
        for key in ('category','region_id','split'):report[key]={v:stats([r for r in rows if r[key]==v]) for v in sorted({r[key] for r in rows})}
        (folder/'metrics.json').write_text(json.dumps(report,indent=2));summary[condition]={k:v for k,v in report.items() if k not in ('category','region_id','split')}
    protocol['metadata_rescoring']={'original_inference_directory':str(a.source),'reviewed_manifest_sha256':hashlib.sha256(a.reviewed_manifest.read_bytes()).hexdigest(),'changes':'Reviewed negative evidence and capture-session split metadata only. Image hashes and all labels asserted equal; no inference/prediction changes.'}
    (a.output/'protocol.json').write_text(json.dumps(protocol,indent=2));(a.output/'summary.json').write_text(json.dumps(summary,indent=2))

if __name__=='__main__':main()
