#!/usr/bin/env python3
"""Compose frozen role evaluations, preserving every row and source protocol."""
import argparse
import json
from pathlib import Path

from stress_ocr import stats


def read(path):return [json.loads(line) for line in path.read_text().splitlines()]


def main():
    p=argparse.ArgumentParser();p.add_argument('--general',type=Path,required=True);p.add_argument('--names',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    gp=json.loads((a.general/'protocol.json').read_text());np=json.loads((a.names/'protocol.json').read_text())
    conditions=[c for c in gp['conditions'] if c in np['conditions']]
    assert conditions and gp['device']==np['device'] and gp['backend']==np['backend']
    a.output.mkdir(exist_ok=True,parents=True)
    protocol={**gp,'conditions':conditions,'name_model_sha256':np['model_sha256'],'role_routing':'NAME uses high-resolution specialist; all other roles use general reader.',
              'source_protocols':{'general':gp,'name':np},'composition_only':True}
    summary={}
    for condition in conditions:
        general=read(a.general/condition/'predictions.jsonl');names={r['sample_id']:r for r in read(a.names/condition/'predictions.jsonl')}
        assert {r['sample_id'] for r in general if r['category']=='name'}==set(names)
        rows=[]
        for base in general:
            if base['category']=='name':
                row=names[base['sample_id']]
                for key in ['label','original_label','category','split','preprocessed_sha256','input_shape']:
                    assert base.get(key)==row.get(key),(condition,base['sample_id'],key)
                rows.append({**row,'model_role':'name'})
            else:rows.append({**base,'model_role':'general'})
        folder=a.output/condition;folder.mkdir(exist_ok=True)
        (folder/'predictions.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
        report=stats(rows)
        for key in ['category','region_id','split']:report[key]={v:stats([r for r in rows if r[key]==v]) for v in sorted({r[key] for r in rows})}
        if condition.startswith('recrop_'):report['geometry_coverage']={str(v):stats([r for r in rows if r.get('geometry_available')==v]) for v in [True,False]}
        (folder/'metrics.json').write_text(json.dumps(report,indent=2));summary[condition]={k:v for k,v in report.items() if k not in ['category','region_id','split']}
    (a.output/'protocol.json').write_text(json.dumps(protocol,indent=2));(a.output/'summary.json').write_text(json.dumps(summary,indent=2))
    print(json.dumps({c:{'exact':r['audited_labels_pipeline']['exact_count'],'samples':r['rows'],'processing_errors':r['processing_errors']} for c,r in summary.items()}))


if __name__=='__main__':main()
