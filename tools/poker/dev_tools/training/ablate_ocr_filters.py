#!/usr/bin/env python3
"""Diagnostic controls only: bypass one fixed-color filter, keep weights frozen."""
import argparse,hashlib,json,sys
from pathlib import Path
import stress_ocr
from prepare_ocr_inputs import localize_pill

p=argparse.ArgumentParser();p.add_argument('--ablation',choices=['name_filter','status_filter'],required=True);args,rest=p.parse_known_args();sys.argv=[sys.argv[0],*rest]
output=Path(rest[rest.index('--output')+1]);output.mkdir(parents=True,exist_ok=True)
(output/'ablation.json').write_text(json.dumps({'ablation':args.ablation,'weights_changed':False,'interpretation':'Diagnostic one-component bypass; not selected as a new production pipeline','script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2))
original=stress_ocr.preprocess


def diagnostic(image,category):
    if args.ablation=='name_filter' and category=='name':return image,{'pill_box':None,'name_normalization':None,'ablation':'fixed-color name normalization disabled'}
    if args.ablation=='status_filter' and category=='status':
        image,box=localize_pill(image,category,status_text_filter=False)
        return image,{'pill_box':box,'name_normalization':None,'ablation':'black-text/background residual filter disabled; pill localization unchanged'}
    return original(image,category)


stress_ocr.preprocess=diagnostic
stress_ocr.main()
