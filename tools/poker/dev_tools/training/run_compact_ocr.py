#!/usr/bin/env python3
"""Run official training/export with the exact compact-model geometry policy."""
import argparse,runpy,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--mode',choices=['train','export','eval'],required=True);p.add_argument('--pool-width',type=int,choices=[1,2],required=True);args,rest=p.parse_known_args()
source=args.source.resolve();sys.path.insert(0,str(source))
from compact_ocr_policy import install_policy
install_policy(args.pool_width)
script=source/'tools'/('export_model.py' if args.mode=='export' else args.mode+'.py')
sys.argv=[str(script),*rest];runpy.run_path(str(script),run_name='__main__')
