#!/usr/bin/env python3
"""Run the unchanged full-corpus evaluator with an explicit input candidate."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import stress_ocr
from robust_ocr_inputs import InputConfig, prepare_candidates
from schemas import CONTRACT, CONTRACT_SHA256


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--input-profile', choices=['raw', 'grayscale', 'legacy'], required=True)
    args, rest = parser.parse_known_args()
    if args.input_profile != 'legacy':
        def prepare(image, category):
            options = prepare_candidates(image, category, InputConfig(include_grayscale=args.input_profile == 'grayscale'))
            return options[args.input_profile], {'input_profile': args.input_profile, 'destructive_palette_filter': False}
        stress_ocr.preprocess = prepare
    sys.argv = [sys.argv[0], *rest]
    stress_ocr.main()
    output = Path(rest[rest.index('--output')+1])
    protocol = json.loads((output/'protocol.json').read_text())
    protocol['input_profile'] = args.input_profile
    protocol['validation_contract'] = {'version':CONTRACT['version'],'sha256':CONTRACT_SHA256}
    protocol['input_implementation_sha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),Path(__file__).with_name('robust_ocr_inputs.py')]}
    (output/'protocol.json').write_text(json.dumps(protocol,indent=2))


if __name__ == '__main__':
    main()
