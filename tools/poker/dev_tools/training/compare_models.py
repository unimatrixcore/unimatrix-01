#!/usr/bin/env python3
"""Validate identical benchmark coverage, then select an untouched starting model."""
import argparse,json
from pathlib import Path


def main():
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path);a=p.parse_args()
    expected=None;manifest_hash=None;models=[]
    for name in ['en-v5','v6-medium','v6-small','trocr-small','crnn-base']:
        directory=a.directory/name
        report=json.loads((directory/'metrics.json').read_text())
        predictions=[json.loads(line) for line in (directory/'predictions.jsonl').read_text().splitlines()]
        samples={r['sample_id']:r['target'] for r in predictions}
        assert len(samples)==len(predictions)==report['samples'],'Missing or repeated benchmark rows'
        if expected is None:expected=samples;manifest_hash=report['manifest_sha256']
        assert samples==expected,'Candidate sample/target mismatch'
        assert report['manifest_sha256']==manifest_hash,'Different benchmark manifest'
        models.append(report)
    models.sort(key=lambda r:(-r['exact_match'],r['cer']))
    comparison={'selection':'Untouched pretrained recognizers; raw case-sensitive exact match descending, then micro CER ascending. Same frozen validation sample. Test excluded.',
                'winner':models[0]['model'],'manifest_sha256':manifest_hash,
                'ranking':[{k:r[k] for k in ['model','backend','device','samples','exact_match','cer','whitespace_normalized_exact']} for r in models]}
    (a.directory/'comparison.json').write_text(json.dumps(comparison,indent=2)+'\n')
    print(json.dumps(comparison,indent=2))

if __name__=='__main__':main()
