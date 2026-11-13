#!/usr/bin/env python3
"""Adapt official training export metadata to PaddleOCR inference preprocessing."""
import argparse
from pathlib import Path
import yaml

p=argparse.ArgumentParser();p.add_argument('--export',type=Path,required=True);p.add_argument('--reference',type=Path,required=True);a=p.parse_args()
path=a.export/'inference.yml';native_path=a.export/'inference-native-export.yml'
if not native_path.exists():native_path.write_text(path.read_text())
native=yaml.safe_load(native_path.read_text());reference=yaml.safe_load((a.reference/'inference.yml').read_text())
reference['PostProcess']=native['PostProcess']
assert len(reference['PostProcess']['character_dict'])==68,'Expected collector dictionary, excluding blank and space'
path.write_text(yaml.safe_dump(reference,sort_keys=False))
