#!/usr/bin/env python3
"""Guard the GPU all-empty-target crash and preserve native positive/mixed CTC."""
import argparse,json
from pathlib import Path
import paddle
from negative_ctc_policy import CollectorBlankCTCLoss

p=argparse.ArgumentParser();p.add_argument('--devices',nargs='+',default=['cpu','gpu:0']);p.add_argument('--output',type=Path,required=True);a=p.parse_args();checks=[]
for device in a.devices:
    paddle.set_device(device);paddle.seed(761)
    for values in [[0,0],[1,0],[1,1]]:
        logits=paddle.randn([2,80,70]);logits.stop_gradient=False;labels=paddle.zeros([2,64],dtype='int64');labels[:,0]=10;lengths=paddle.to_tensor(values,dtype='int64')
        loss=CollectorBlankCTCLoss()(logits,[None,labels,lengths])['loss']
        if values==[0,0]:reference=-paddle.nn.functional.log_softmax(logits,axis=-1)[:,:,0].sum()/2
        else:reference=paddle.nn.CTCLoss(blank=0,reduction='none')(logits.transpose([1,0,2]),labels.astype('int32'),paddle.to_tensor([80,80],dtype='int64',place=paddle.CPUPlace()),lengths).mean()
        delta=float(paddle.abs(loss-reference));assert delta<.001,(device,values,delta);loss.backward();assert bool(paddle.isfinite(logits.grad).all())
        checks.append({'device':device,'target_lengths':values,'native_or_analytic_difference':delta,'finite_gradients':True})
a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(checks,indent=2));print(json.dumps(checks))
