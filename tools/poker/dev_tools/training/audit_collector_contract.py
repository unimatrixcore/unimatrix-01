#!/usr/bin/env python3
"""Check expected truths AND cross-layer consistency, never agreement alone."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import subprocess
from schemas import valid, CONTRACT, CONTRACT_PATH, CONTRACT_SHA256, category_for_region

UI_NAMES={'name':'NAME','status':'STATUS','card':'CARD','bank':'BANK','bet':'MONEY','dealer':'DEALER','pot':'POT','split_pot':'SPLIT_POT','round_id':'ROUND_ID'}


def audit(manifest=None):
    tools=Path(__file__).resolve().parents[1]
    ui=tools/'static/js/lib/schemas.js'
    fixtures=json.loads((tools/'tests/fixtures/ocr_contract_cases.json').read_text())
    rows=[json.loads(line) for line in manifest.read_text().splitlines() if line] if manifest else []
    cases=[{'category':r['category'],'label':r['label'],'sample_id':r.get('sample_id',r.get('id'))} for r in rows if r.get('category') in UI_NAMES]
    expected_cases=fixtures['cases']
    all_cases=expected_cases+cases
    payload={'source':ui.read_text(),'contract':CONTRACT,'cases':all_cases,'names':UI_NAMES,'regions':fixtures['regions']}
    js="""const fs=require('fs'),vm=require('vm');const p=JSON.parse(fs.readFileSync(0,'utf8'));const ctx={OCR_CONTRACT:p.contract};vm.createContext(ctx);vm.runInContext(p.source+';globalThis.contractSchemas=Schemas;globalThis.registry=SchemaRegistry;',ctx);process.stdout.write(JSON.stringify({text:p.cases.map(r=>ctx.contractSchemas[p.names[r.category]].validate(r.label).isValid),regions:p.regions.map(r=>ctx.registry.getCategory(r.region_id)),review:['New Table Status','', 'Bad\\nStatus'].map(label=>ctx.registry.validateReviewed('seats[0].status',label))}));"""
    completed=subprocess.run(['node','-e',js],input=json.dumps(payload),text=True,capture_output=True,check=True)
    results=json.loads(completed.stdout)
    differences=[{**row,'ui':ui_result,'python':valid(row)} for row,ui_result in zip(all_cases,results['text']) if ui_result!=valid(row)]
    wrong_expectations=[{**row,'ui':ui_result,'python':valid(row)} for row,ui_result in zip(expected_cases,results['text']) if ui_result!=row['expected'] or valid(row)!=row['expected']]
    wrong_regions=[{**row,'ui':ui_result,'python':category_for_region(row['region_id'])} for row,ui_result in zip(fixtures['regions'],results['regions']) if ui_result!=row['expected_category'] or category_for_region(row['region_id'])!=row['expected_category']]
    assert len(results['text'])==len(all_cases)
    assert len(results['regions'])==len(fixtures['regions'])
    if [(r['isValid'],r['outsideContract']) for r in results['review']] != [(True,True),(False,False),(False,False)]:
        wrong_expectations.append({'case':'explicit-human-status-review','actual':results['review']})
    statuses=collections.Counter(r['label'] for r in rows if r.get('category')=='status' and r.get('label'))
    return {'validation_contract':{'version':CONTRACT['version'],'sha256':CONTRACT_SHA256},
            'contract_path':str(CONTRACT_PATH),'expected_cases':len(expected_cases),'manifest_cases':len(cases),
            'disagreements':differences,'wrong_expected_results':wrong_expectations,'wrong_regions':wrong_regions,
            'manual_status_review_check':results['review'],
            'observed_manifest_status_labels':dict(statuses),
            'allowed_statuses_without_positive_manifest_coverage':sorted(set(CONTRACT['categories']['status']['values'])-set(statuses)) if manifest else [],
            'collector_ui_sha256':hashlib.sha256(ui.read_bytes()).hexdigest(),
            'blank_policy':'Only dealer has a valid blank completed-text schema. Storage/review permits explicit blanks on known OCR regions; neither schema validity nor an empty unreviewed label establishes a negative training target.',
            'limitation':'Format agreement and fixtures do not prove pixel correctness, coverage completeness, model accuracy or production qualification.'}


def main():
    p=argparse.ArgumentParser();p.add_argument('--manifest',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    report=audit(a.manifest)
    a.output.parent.mkdir(exist_ok=True,parents=True);a.output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ('observed_manifest_status_labels',)}))
    if report['disagreements'] or report['wrong_expected_results'] or report['wrong_regions']:
        raise SystemExit('OCR contract audit failed; inspect report')


if __name__=='__main__':main()
