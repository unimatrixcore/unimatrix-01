#!/usr/bin/env python3
"""Check compact class transfer and doubled temporal resolution in native exports."""
import argparse,json
from pathlib import Path
import numpy as np
import paddle.inference as infer

p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);a=p.parse_args();root=a.root
def predictor(path):
    cfg=infer.Config(str(path/'inference.json'),str(path/'inference.pdiparams'))
    cfg.disable_gpu();cfg.disable_glog_info();cfg.set_cpu_math_library_num_threads(4)
    cfg.switch_ir_optim(False)
    return infer.create_predictor(cfg)
def run(model,x):
    handle=model.get_input_handle(model.get_input_names()[0]);handle.reshape(x.shape);handle.copy_from_cpu(x)
    model.run();return model.get_output_handle(model.get_output_names()[0]).copy_to_cpu()
full=predictor(root/'paddle-transfer-v2/export');control=predictor(root/'compact-ocr-v4/export-control');high=predictor(root/'compact-ocr-v4/export-highres')
keep=json.loads((root/'compact-ocr-v4/transfer.json').read_text())['old_class_indices'];checks=[]
for width in [320,384,640]:
    x=np.random.default_rng(width).uniform(-1,1,(1,3,48,width)).astype('float32')
    original=run(full,x)[:,:,keep];expected=original/original.sum(-1,keepdims=True)
    actual=run(control,x);expanded=run(high,x)
    difference=float(np.max(np.abs(expected-actual)))
    assert difference<.0002,(width,difference)
    assert expanded.shape[1]==actual.shape[1]*2,(expanded.shape,actual.shape)
    checks.append({'input_width':width,'control_shape':list(actual.shape),'highres_shape':list(expanded.shape),'max_probability_difference':difference})
(root/'compact-ocr-v4/export-parity.json').write_text(json.dumps(checks,indent=2));print(json.dumps(checks))
