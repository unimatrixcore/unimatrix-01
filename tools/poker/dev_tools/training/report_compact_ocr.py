#!/usr/bin/env python3
"""Summarize measured results; preserve raw scores and development-set limits."""
import argparse,hashlib,json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--run',default='compact-ocr-v5');p.add_argument('--evaluation-prefix',default='');a=p.parse_args();root=a.root.resolve();run=root/a.run
report={}
for name in ['validation','test','full-corpus']:
    directory=run/(a.evaluation_prefix+name)
    metrics=json.loads((directory/'metrics.json').read_text());report[name]={k:metrics[k] for k in ['samples','exact_match','raw_exact_match','cer','raw_cer','manifest_sha256']}
    predictions=[json.loads(l) for l in (directory/'predictions.jsonl').read_text().splitlines()]
    report[name]['exact_count']=sum(r['prediction']==r['target'] for r in predictions)
    report[name]['raw_exact_count']=sum(r['raw_prediction']==r['target'] for r in predictions)
    report[name]['errors']=[r for r in predictions if r['errors']]
report['verification']=json.loads((run/'verification.json').read_text())
report['model_sha256']={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in (run/'export').glob('inference.*')}
report['limitations']=['Validation/test capture sessions excluded from optimization; reused during development, so not prospective acceptance.','Full corpus includes training samples and is a regression audit, not a generalization score.','Collector annotations are not all independently visually reverified. Disagreements were individually reviewed.','Requires pixel preprocessing and schema whitespace formatting. Raw output scores are reported separately.','Native Paddle export; not installed in the app RTen/ocrs engine.']
(run/'final-report.json').write_text(json.dumps(report,indent=2))
lines=['# Selected collector OCR model','',f'Run: `{a.run}` on unimatrix-01.','', '| Set | Crops | Raw exact | Pipeline exact | Pipeline CER |','|---|---:|---:|---:|---:|']
for name in ['validation','test','full-corpus']:
    m=report[name];lines.append(f"| {name} | {m['samples']} | {m['raw_exact_count']}/{m['samples']} ({m['raw_exact_match']:.4%}) | {m['exact_count']}/{m['samples']} ({m['exact_match']:.4%}) | {m['cer']:.4%} |")
lines+=['','Pipeline uses color-alpha name normalization, removes plate-border components, localizes status/bet pills, and suppresses status-button exterior artwork. Formatting changes whitespace only; no vocabulary, username lookup, letter/digit substitution or target-based crop transforms.','', 'Data: 6,221 real training crops, 890 validation, 910 test; source-capture sessions grouped before splitting, unknown-source training-only. All valid same-label/seat/geometry variants retained. One clipped crop remains quarantined. Thirty-seven individually verified exported-label corrections in total; original source database untouched.','', 'Training: benchmark-winning PP-OCRv6-small, then frozen backbone/BN transfer; compact 70-class CTC, doubled temporal resolution. Four compact epochs plus 12 clean-label continuation epochs, shuffled batches of 32, 2,000 generic repeated-glyph training examples. Selected by native validation exact match. Glyph sources were individually checked training crops; automatic projection-only glyph extraction failed audit and was excluded.','', 'Verification: initial class-transfer parity at three widths; final training/export parity at three widths; unchanged backbone and BN tensors. See `verification.json`, the v4 transfer/parity evidence and complete predictions. CPU label-free inference smoke test reads eight repeated i characters correctly.','', 'Label review: 31 training-label errors found by full-corpus disagreement audit; 29 had exact original-capture recrop equality, two lacked source captures. Seven additional l-count errors were genuine model errors and were retained as such. Historical reports and predictions remain unchanged.','', '## Limits','']
lines += ['- '+s for s in report['limitations']]
lines += ['', '## Inference','', '```sh','PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True python scripts/recognize_crops.py \\', '  --model-dir export --image /path/to/crop.png --category name --device cpu','```','', 'Use the bundled PaddleOCR/Paddle environment versions and preprocessing scripts. Training can be reproduced from the recorded configuration and source checkpoint; see repository `dev_tools/training/README.md`.']
(run/'final-report.md').write_text('\n'.join(lines)+'\n');print(json.dumps({k:{f:v for f,v in d.items() if f!='errors'} for k,d in report.items() if k in ['validation','test','full-corpus']}))
