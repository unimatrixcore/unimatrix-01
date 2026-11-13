#!/usr/bin/env python3
"""Create a train-calibrated Conv-only int8 deployment candidate.

Quantization is lossy. This never promotes the output: clean and stress
decisions, accepted errors, coverage and frame latency must be remeasured.
"""
import argparse
import collections
import hashlib
import json
import shutil
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from onnxruntime.quantization import CalibrationDataReader, CalibrationMethod, QuantFormat, QuantType, quantize_static

from portable_ocr import normalize_crop


def main():
    p=argparse.ArgumentParser();p.add_argument('--model',type=Path,required=True);p.add_argument('--manifest',type=Path,required=True)
    p.add_argument('--bundle',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--count',type=int,default=512);a=p.parse_args()
    rows=[r for r in map(json.loads,a.manifest.read_text().splitlines()) if r['split']=='train'];np.random.default_rng(71176).shuffle(rows)
    groups=collections.defaultdict(list)
    for row in rows:groups[(row['category'],bool(row['label']))].append(row)
    selected=[]
    while len(selected)<a.count and groups:
        for key in list(groups):
            if groups[key]:selected.append(groups[key].pop())
            if not groups[key]:del groups[key]
            if len(selected)>=a.count:break
    a.output.mkdir(exist_ok=True,parents=True)
    options=ort.SessionOptions();options.intra_op_num_threads=4;options.inter_op_num_threads=1
    session=ort.InferenceSession(str(a.model/'model.onnx'),sess_options=options,providers=['CPUExecutionProvider']);input_name=session.get_inputs()[0].name
    class Reader(CalibrationDataReader):
        def __init__(self):self.iterator=iter(selected)
        def get_next(self):
            row=next(self.iterator,None)
            if row is None:return None
            path=a.bundle/row['image_path'];assert hashlib.sha256(path.read_bytes()).hexdigest()==row['file_sha256']
            return {input_name:normalize_crop(cv2.imread(str(path)))}
    quantize_static(a.model/'model.onnx',a.output/'model.onnx',Reader(),quant_format=QuantFormat.QDQ,
                    op_types_to_quantize=['Conv'],per_channel=True,activation_type=QuantType.QInt8,weight_type=QuantType.QInt8,
                    calibrate_method=CalibrationMethod.MinMax,extra_options={'WeightSymmetric':True,'ActivationSymmetric':True})
    shutil.copy2(a.model/'characters.json',a.output/'characters.json')
    report={'source_model_sha256':hashlib.sha256((a.model/'model.onnx').read_bytes()).hexdigest(),
            'quantized_model_sha256':hashlib.sha256((a.output/'model.onnx').read_bytes()).hexdigest(),'calibration_count':len(selected),
            'calibration_sample_ids':[r['sample_id'] for r in selected],'calibration_splits':sorted({r['split'] for r in selected}),
            'method':'MinMax, signed int8 symmetric QDQ, per-channel Conv weights; neck/head MatMul and Softmax remain floating point.',
            'seed':71176,'promoted':False,'source':'https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html'}
    (a.output/'quantization.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='calibration_sample_ids'}))


if __name__=='__main__':main()
