#!/usr/bin/env python3
"""Verify ONNX/native probabilities, actual crop inputs and decoded outputs."""
import argparse
import hashlib
import json
import time
from pathlib import Path

import cv2
import numpy as np
import paddle.inference as infer
import yaml

from portable_ocr import PortableModel, decode_ctc, normalize_crop


def main():
    p=argparse.ArgumentParser();p.add_argument('--native',type=Path,required=True);p.add_argument('--portable',type=Path,required=True)
    p.add_argument('--bundle',type=Path,required=True);p.add_argument('--manifest',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    chars=['blank']+yaml.safe_load((a.native/'inference.yml').read_text())['PostProcess']['character_dict']+[' ']
    assert len(chars)==70
    (a.portable/'characters.json').write_text(json.dumps(chars))
    portable=PortableModel(a.portable)
    cfg=infer.Config(str(a.native/'inference.json'),str(a.native/'inference.pdiparams'));cfg.disable_gpu();cfg.disable_glog_info();cfg.set_cpu_math_library_num_threads(4);cfg.switch_ir_optim(False)
    native=infer.create_predictor(cfg)
    def reference(x):
        handle=native.get_input_handle(native.get_input_names()[0]);handle.reshape(x.shape);handle.copy_from_cpu(x);native.run()
        return native.get_output_handle(native.get_output_names()[0]).copy_to_cpu()
    checks=[]
    for width in [320,384,640]:
        x=np.random.default_rng(width).uniform(-1,1,(1,3,48,width)).astype(np.float32)
        expected=reference(x);actual=portable.session.run(None,{portable.input_name:x})[0]
        error=float(np.max(np.abs(expected-actual)));assert error<.00005,(width,error)
        checks.append({'width':width,'shape':list(actual.shape),'max_probability_error':error})
    from paddlex.inference.models.text_recognition.processors import OCRReisizeNormImg
    processor=OCRReisizeNormImg()
    rows=[json.loads(l) for l in a.manifest.read_text().splitlines()]
    rng=np.random.default_rng(20261107);rng.shuffle(rows)
    selected=[];counts={}
    for row in rows:
        key=(row['category'],bool(row['label']))
        if counts.get(key,0)<12:selected.append(row);counts[key]=counts.get(key,0)+1
    mismatches=[];maximum=0.;latencies=[];input_differences=0;probability_differences=[]
    for row in selected:
        image=cv2.imread(str(a.bundle/row['image_path']));assert image is not None
        x=normalize_crop(image)
        other=processor.resize(image)[None]
        if not np.array_equal(x,other):input_differences+=1
        expected=reference(x);start=time.perf_counter();actual=portable.probabilities(image);latencies.append((time.perf_counter()-start)*1000)
        difference=float(np.max(np.abs(expected-actual)));maximum=max(maximum,difference)
        probability_differences.append({'sample_id':row['sample_id'],'maximum_absolute_error':difference})
        # Real inputs can amplify CPU-kernel rounding through softmax. Keep a
        # recorded bound and independently require exact decoded-text parity;
        # do not hide the observed differences behind an equivalence claim.
        assert difference<.001,(row['sample_id'],difference)
        before=decode_ctc(expected,chars);after=decode_ctc(actual,chars)
        if before[0]!=after[0]:mismatches.append({'sample_id':row['sample_id'],'native':before[0],'onnx':after[0]})
    assert not input_differences and not mismatches,(input_differences,mismatches)
    report={'random_shape_checks':checks,'real_crop_samples':len(selected),'sample_ids':[r['sample_id'] for r in selected],
            'normalization_pixel_mismatches':input_differences,'decoded_mismatches':mismatches,'maximum_real_crop_probability_error':maximum,
            'real_probability_tolerance':.001,'per_crop_probability_differences':probability_differences,
            'cpu_latency_ms':{'p50':float(np.percentile(latencies,50)),'p95':float(np.percentile(latencies,95)),'maximum':max(latencies),'threads':4,'includes_resize':True,'concurrent_training_may_affect_timing':True},
            'model_sha256':hashlib.sha256((a.portable/'model.onnx').read_bytes()).hexdigest(),'characters_sha256':hashlib.sha256((a.portable/'characters.json').read_bytes()).hexdigest(),
            'limitation':'Sampled numerical equivalence is not whole-corpus decision parity or end-to-end frame latency proof.'}
    a.output.write_text(json.dumps(report,indent=2));print(json.dumps(report))


if __name__=='__main__':main()
