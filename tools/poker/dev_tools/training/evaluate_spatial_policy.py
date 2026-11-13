#!/usr/bin/env python3
"""Score abstention separately from errors using actual full-capture views."""
import argparse
import collections
import json
from pathlib import Path

from production_decision import Decision, decide_views

CONDITIONS = ['identity','recrop_x_minus2','recrop_x_plus2','recrop_y_minus2','recrop_y_plus2']


def summarize(rows):
    positive=[r for r in rows if r['label']]
    negative=[r for r in rows if not r['label']]
    accepted=[r for r in rows if r['decision']['state']!='unknown']
    wrong=[r for r in accepted if r['decision']['text']!=r['label']]
    return {'samples':len(rows),'accepted':len(accepted),'accepted_wrong':len(wrong),
            'abstentions':len(rows)-len(accepted),'positive_samples':len(positive),
            'positive_correct_accepted':sum(r['decision']['state']=='text' and r['decision']['text']==r['label'] for r in positive),
            'positive_correct_coverage':sum(r['decision']['state']=='text' and r['decision']['text']==r['label'] for r in positive)/len(positive) if positive else None,
            'negative_samples':len(negative),'negative_false_accepted_text':sum(r['decision']['state']=='text' for r in negative),
            'negative_confirmed_blank':sum(r['decision']['state']=='blank' for r in negative),
            'wrong_ids':[r['sample_id'] for r in wrong],
            'reasons':dict(collections.Counter(r['decision']['reason'] for r in rows))}


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--matrix',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--view-policy',choices=['five','mixed'],default='five');a=p.parse_args()
    protocol=json.loads((a.matrix/'protocol.json').read_text())
    assert all(c in protocol['conditions'] for c in CONDITIONS)
    conditions={c:{r['sample_id']:r for r in map(json.loads,(a.matrix/c/'predictions.jsonl').read_text().splitlines())} for c in CONDITIONS}
    ids=set(conditions['identity']);assert all(set(rows)==ids for rows in conditions.values())
    rows=[]
    for sid in sorted(ids,key=int):
        base=conditions['identity'][sid]
        selected=['identity','recrop_x_plus2','recrop_y_plus2'] if a.view_policy=='mixed' and base['category']!='name' else CONDITIONS
        views=[conditions[c][sid] for c in selected]
        assert all(r['label']==base['label'] and r['split']==base['split'] for r in views)
        if any(not r.get('geometry_available') for r in views[1:]):
            decision=Decision('unknown',None,'full_capture_geometry_unavailable')
        else:decision=decide_views(base['category'],views,required_views=len(views))
        rows.append({**{k:base[k] for k in ['sample_id','label','split','category','region_id']},'decision':decision.__dict__,'views':[{k:r.get(k) for k in ['raw_prediction','prediction','confidence','error']} for r in views]})
    summary=summarize(rows)
    summary['source_geometry_available']=summarize([r for r in rows if r['decision']['reason']!='full_capture_geometry_unavailable'])
    for field in ['category','split']:
        summary[field]={value:summarize([r for r in rows if r[field]==value]) for value in sorted({r[field] for r in rows})}
    available=[r for r in rows if r['decision']['reason']!='full_capture_geometry_unavailable']
    summary['source_geometry_available_category']={value:summarize([r for r in available if r['category']==value]) for value in sorted({r['category'] for r in available})}
    summary['split_category']={split:{category:summarize([r for r in rows if r['split']==split and r['category']==category]) for category in sorted({r['category'] for r in rows if r['split']==split})} for split in sorted({r['split'] for r in rows})}
    observed_profiles={r.get('preprocessing',{}).get('input_profile','legacy') for r in conditions['identity'].values() if not r.get('error')}
    assert len(observed_profiles)==1,observed_profiles
    input_profile=observed_profiles.pop()
    if 'input_profile' in protocol:assert protocol['input_profile']==input_profile
    summary['protocol']={'conditions':CONDITIONS,'view_policy':a.view_policy,'mixed_policy':'Names use5 views; other fields use original,x+2,y+2.','model_sha256':protocol['model_sha256'],'input_profile':input_profile,'temporal_agreement_evaluated':False,'confidence_threshold':None,'limitations':'Spatial views are correlated; accepted errors remain possible. Unknown is an abstention, never scored as a correct blank. All full-database rows retained; missing source geometry abstains. Existing splits are reused development evidence.'}
    a.output.mkdir(exist_ok=True,parents=True)
    (a.output/'predictions.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows));(a.output/'metrics.json').write_text(json.dumps(summary,indent=2))
    print(json.dumps({k:v for k,v in summary.items() if k not in ['category','protocol']}))


if __name__=='__main__':main()
