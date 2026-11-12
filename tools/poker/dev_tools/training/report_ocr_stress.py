#!/usr/bin/env python3
"""Aggregate whole-database stress evidence without hiding negative failures."""
import argparse,collections,hashlib,json
from pathlib import Path
from stress_ocr import stats


def read_rows(path):return [json.loads(l) for l in path.read_text().splitlines()]


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--run',default='negative-ocr-v8');a=p.parse_args();root=a.root.resolve();output=root/'stress-results/final-report';output.mkdir(exist_ok=True)
    tag=a.run.rsplit('-',1)[-1];selected='selected_'+tag;truth={r['sample_id']:r for r in read_rows(root/a.run/'manifest.jsonl')};phases={};phase_rows={}
    for name,directory in [('previous_v5','full-database'),('negative_v6','negative-v6-single'),(selected,'negative-'+tag+'-single')]:
        rows=read_rows(root/'stress-results'/directory/'identity/predictions.jsonl');assert {r['sample_id'] for r in rows}==set(truth) and len(rows)==len(truth)
        for row in rows:
            for field in ['label','label_kind','split']:row[field]=truth[row['sample_id']][field]
        phases[name]=stats(rows);phases[name]['split']={split:stats([r for r in rows if r['split']==split]) for split in ['train','val','test']};phase_rows[name]=rows
    before={r['sample_id']:(r['preprocessed_sha256'],r['input_shape']) for r in phase_rows['previous_v5']}
    assert all(before[r['sample_id']]==(r['preprocessed_sha256'],r['input_shape']) for r in phase_rows[selected]),'Pixel preprocessing changed between paired model baselines'
    matrix=root/('stress-results/negative-'+tag+'-matrix');conditions={};confidence={};worst=[]
    for directory in sorted(p for p in matrix.iterdir() if p.is_dir()):
        metrics=json.loads((directory/'metrics.json').read_text());rows=read_rows(directory/'predictions.jsonl');assert len(rows)==len(truth) and {r['sample_id'] for r in rows}==set(truth)
        groups=collections.defaultdict(list)
        for row in rows:
            if not row.get('error') and not row.get('negative_fixture'):groups[(row['category'],row['label'])].append(row)
        macro=sum(sum(r['prediction']==r['label'] for r in group)/len(group) for group in groups.values())/len(groups) if groups else None
        metrics['macro_category_label_accuracy']=macro;conditions[directory.name]=metrics
        confidence[directory.name]=[]
        for threshold in [0,.5,.8,.9,.95,.99,.999]:
            for schema_filter in [False,True]:
                accepted=[r for r in rows if not r.get('error') and r['prediction'] and r['confidence']>=threshold and (not schema_filter or r['schema_valid'])]
                wrong=[r for r in accepted if r['prediction']!=('' if r.get('negative_fixture') else r['label'])]
                confidence[directory.name].append({'threshold':threshold,'schema_filter':schema_filter,'accepted':len(accepted),'accepted_wrong':len(wrong),'accepted_wrong_with_valid_schema':sum(r['schema_valid'] for r in wrong)})
        errors=[r for r in rows if not r.get('error') and r['prediction']!=('' if r.get('negative_fixture') else r['label'])]
        errors.sort(key=lambda r:(r['schema_valid'],r['confidence']),reverse=True)
        representatives={}
        for row in errors:representatives.setdefault((row['category'],row['label'],row['prediction']),row)
        worst.extend(dict(r,condition=directory.name) for r in list(representatives.values())[:20])
        names=[r for r in rows if r['category']=='name' and not r.get('error')]
        metrics['name_preprocessing_coverage']={str(enabled):{'samples':len(group),'exact':sum(r['prediction']==r['label'] for r in group)} for enabled in [True,False] for group in [[r for r in names if bool(r.get('preprocessing',{}).get('name_normalization'))==enabled]]}
    model=root/a.run/'export';sha={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in model.glob('inference.*')}
    assert set(conditions)==set(json.loads((matrix/'protocol.json').read_text())['conditions']),'Stress matrix incomplete'
    for directory in [root/('stress-results/negative-'+tag+'-single'),matrix]:assert json.loads((directory/'protocol.json').read_text())['model_sha256']==sha
    challenge_directory=root/('stress-results/novel-names-'+tag+'/identity');challenge=json.loads((challenge_directory/'metrics.json').read_text())
    challenge_truth={r['sample_id']:r for r in read_rows(root/'novel-name-challenge/manifest.jsonl')};challenge_rows=read_rows(challenge_directory/'predictions.jsonl')
    challenge['by_run_length']={str(length):{'samples':len(group),'exact':sum(r['prediction']==r['label'] for r in group)} for length in sorted({r['run_length'] for r in challenge_truth.values()}) for group in [[r for r in challenge_rows if challenge_truth[r['sample_id']]['run_length']==length]]}
    challenge['by_gap']={str(gap):{'samples':len(group),'exact':sum(r['prediction']==r['label'] for r in group)} for gap in [1,2,3] for group in [[r for r in challenge_rows if challenge_truth[r['sample_id']]['gap']==gap]]}
    report={'model_sha256':sha,'database_rows':len(truth),'positive_rows':sum(bool(r['label']) for r in truth.values()),'verified_negative_rows':sum(r['label_kind']=='verified_negative' for r in truth.values()),'paired_baselines':phases,'conditions':conditions,'novel_name_challenge':challenge,'confidence_sweeps':confidence,'training_after_stress_sweep':False,'limitations':['Database includes training images; this is a regression/robustness audit, not a prospective generalization claim.','Validation/test sessions were reused during development.','Stress matrix uses batch8 with its own identity control; single-crop baseline is measured separately.','Full-capture recrop tests use8968 actual sources;601 no-source rows remain unchanged and are reported in a separate coverage stratum.','Severe crop/resize/blur transforms may destroy information; targets remain fixed to measure tolerance.','Synthetic blank/noise fixtures and novel strings are constructed challenges, not new real captures.','Schema validity and confidence do not establish correctness; wrong schema-valid values remain errors.']}
    ablations={}
    base_jpeg={r['sample_id']:r for r in read_rows(matrix/'jpeg_80/predictions.jsonl')}
    for category,directory in [('name','jpeg-name-ablation-v8'),('status','jpeg-status-ablation-v8')]:
        path=root/'stress-results'/directory
        rows=read_rows(path/'jpeg_80/predictions.jsonl')
        assert len(rows)==len(truth)
        assert json.loads((path/'protocol.json').read_text())['model_sha256']==sha
        for row in rows:
            if row['category']!=category:
                old=base_jpeg[row['sample_id']]
                assert (row['preprocessed_sha256'],row['prediction'])==(old['preprocessed_sha256'],old['prediction'])
        target=[r for r in rows if r['category']==category and r['label']]
        ablations[category]={'metrics':json.loads((path/'jpeg_80/metrics.json').read_text()),'target_samples':len(target),'target_exact':sum(r['prediction']==r['label'] for r in target),'diagnostic_only':True}
    report['diagnostic_filter_ablations']=ablations
    report['readiness']='Not ready for reliable amount reading under crop drift: legal high-confidence numeric errors observed.'
    report['prepared_duplicate_audit']=json.loads((root/a.run/'preprocessed-duplicate-audit.json').read_text())
    report['selected_evaluation_records']=len(truth)*(len(conditions)+1+len(ablations))+len(challenge_rows)
    report['critical_amount_errors']=[{'sample_id':7797,'condition':'recrop_y_plus2','target':'G 136.3 BB','prediction':'G 1363 BB'},{'sample_id':1602,'condition':'recrop_x_plus2','target':'G 44 BB','prediction':'G 444 BB'}]
    for case in report['critical_amount_errors']:
        row=next(r for r in read_rows(matrix/case['condition']/'predictions.jsonl') if str(r['sample_id'])==str(case['sample_id']))
        assert row['label']==case['target'] and row['prediction']==case['prediction'] and row['schema_valid']
        case['confidence']=row['confidence']
    (output/'report.json').write_text(json.dumps(report,indent=2));(output/'failure-examples.json').write_text(json.dumps(worst,indent=2))
    lines=['# Whole-database OCR stress test','',f"Every database row processed: {len(truth)}; {report['positive_rows']} positive targets and {report['verified_negative_rows']} visually verified target-region negatives.",'','## Paired clean baselines','', '| Model | Positive exact | Negative text outputs | Schema-valid negative outputs | All-target exact |','|---|---:|---:|---:|---:|']
    for name,m in phases.items():lines.append(f"| {name} | {m['positive_exact']}/{m['positive_samples']} | {m['verified_negative_false_outputs']}/{m['verified_negative_samples']} | {m['verified_negative_schema_valid_false_outputs']} | {m['audited_labels_pipeline']['exact_count']}/{m['labelled']} ({m['audited_labels_pipeline']['accuracy']:.4%}) |")
    lines+=['','The previous v5 positive-only full-corpus claim excluded the deliberate negatives. Once all reviewed negatives are scored, its whole-database exact match is 98.0980%, not 100%. Thirty-seven independently verified positive label corrections are recorded separately; original database labels were not overwritten.','', 'All1547 previously empty-label crops were visually reviewed. They are target-region negatives: neighboring ranks inside status regions, dealer D inside a card region, logos, avatars and clipped neighboring fragments are not valid target text. No positive relabels or unresolved ambiguities were found.','', 'Negative-aware training used1270 train negatives,154 validation negatives and123 test negatives, preserving whole capture sessions. No exact negative duplicate groups cross the splits. Native loader audits verify actual zero-length CTC targets; CPU/GPU blank loss and gradients were checked. The selected retention continuation used6221 positives+1270 negatives, kept2000 generic repetition examples, and imitated the prior frozen reader only on training positives. The real-only v7 candidate was rejected for repeated-letter forgetting.','', '## Fixed-model stress matrix','', '| Condition | All-target exact | Positive exact | Negative text outputs | Schema-valid negative outputs | High-confidence wrong (>=0.99) |','|---|---:|---:|---:|---:|---:|']
    for name,m in conditions.items():
        exact=m['audited_labels_pipeline']['accuracy'];value=f'{exact:.3%}' if exact is not None else 'synthetic negative only'
        lines.append(f"| {name} | {value} | {m['positive_exact']}/{m['positive_samples']} | {m['verified_negative_false_outputs']}/{m['verified_negative_samples']} | {m['verified_negative_schema_valid_false_outputs']} | {m['wrong_with_confidence_ge_0.99']} |")
        if m.get('known_negative_fixtures'):lines.append(f"| ↳ blank/noise false outputs | {m['known_negative_nonempty']}/{m['known_negative_fixtures']} | — | — | schema-valid: {m['known_negative_schema_valid_nonempty']} | — |")
    lines+=['',f"Novel string challenge: {challenge['audited_labels_pipeline']['exact_count']}/{challenge['labelled']} exact. These512 identifiers were excluded from every real and synthetic training label; they reuse reviewed training-font glyphs, so this is a compositional/counting test, not independent capture evidence.",'','## Interpretation','']
    lines+=['- '+s for s in report['limitations']]
    lines+=['','Full raw/formatted outputs, preprocessing decisions, confidence and per-region/per-category scores are retained for every condition. Processing failures count as exact-match misses. Schema rejection is a separately reported hypothetical reject-to-empty policy, not recognizer blank accuracy or proof of an integrated app guard. It never substitutes letters or digits. Confidence curves are descriptive; no threshold was selected on this stress set. No additional training occurred after the selected retained-reader export was frozen.','', 'The model remains uninstalled in the app; these measurements cover the native Paddle crop pipeline, not the existing RTen detector end to end.']
    lines+=['','## Stress-test verdict','',report['readiness'],'',f"The frozen selected model produced {report['selected_evaluation_records']:,} evaluation records including diagnostic controls. No weights were updated from these stress results.",'']
    for case in report['critical_amount_errors']:
        lines.append(f"- ID {case['sample_id']}, {case['condition']}: `{case['target']}` became `{case['prediction']}` at {case['confidence']:.3%} confidence; the incorrect amount passes the schema.")
    lines+=['','Runtime confidence averages emitted characters and does not penalize missing characters. It cannot rule out a deleted decimal point.','', 'JPEG80 damages fixed-color preprocessing: NAME exact improves from947/2593 to2539/2593 when only its color normalization is bypassed; STATUS improves from604/659 to646/659 when only the residual filter is bypassed. The status control also raises negative text outputs. These are diagnostic controls, not a promoted replacement pipeline. All unrelated-category prepared pixels and predictions were asserted identical.','', 'Raw decoded images are unique, but runtime preparation creates70 cross-split duplicate groups spanning382 rows (8495 unique prepared images). This overlap limits held-out independence; no rows were silently removed. See the attached prepared duplicate audit.']
    (output/'report.md').write_text('\n'.join(lines)+'\n');print(json.dumps({'baseline':phases[selected]['audited_labels_pipeline'],'conditions':len(conditions),'rows_per_condition':len(truth),'novel_exact':challenge['audited_labels_pipeline']}))


if __name__=='__main__':main()
