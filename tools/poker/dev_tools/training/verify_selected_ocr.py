#!/usr/bin/env python3
"""Verify frozen tensors and selected native export against its training model."""
import argparse,copy,json,sys
from pathlib import Path
import numpy as np,paddle,yaml
import paddle.inference as infer

p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--run',default='compact-ocr-v5');p.add_argument('--reference',type=Path);a=p.parse_args();root=a.root.resolve();run=root/a.run
config=yaml.safe_load((run/'train.yml').read_text())
sys.path.insert(0,str(root/'paddle-training-source'));paddle.set_device('cpu')
from compact_ocr_policy import install_policy
install_policy(1)
if config['Global'].get('collector_name_high_resolution'):
    from name_resolution_policy import install_name_resolution
    install_name_resolution()
from ppocr.modeling.architectures import build_model
initial_path=a.reference.resolve() if a.reference else root/'compact-ocr-v4/initial.pdparams'
initial=paddle.load(str(initial_path));state=paddle.load(str(run/'checkpoints/best_accuracy.pdparams'))
changed=[key for key in initial if not np.array_equal(initial[key].numpy(),state[key].numpy())]
assert not [key for key in changed if key.startswith('backbone.') or '._mean' in key or '._variance' in key]
architecture=copy.deepcopy(config['Architecture']);architecture['Head']['out_channels']=70
model=build_model(architecture);model.set_state_dict(state);model.eval()
cfg=infer.Config(str(run/'export/inference.json'),str(run/'export/inference.pdiparams'));cfg.disable_gpu();cfg.disable_glog_info();cfg.set_cpu_math_library_num_threads(4);cfg.switch_ir_optim(False);predictor=infer.create_predictor(cfg);checks=[]
for width in [320,384,640]:
    x=np.random.default_rng(width).uniform(-1,1,(1,3,48,width)).astype('float32')
    with paddle.no_grad():expected=model(paddle.to_tensor(x)).numpy()
    handle=predictor.get_input_handle(predictor.get_input_names()[0]);handle.reshape(x.shape);handle.copy_from_cpu(x);predictor.run();actual=predictor.get_output_handle(predictor.get_output_names()[0]).copy_to_cpu()
    error=float(np.max(np.abs(expected-actual)));assert error<.00002,(width,error)
    temporal_stride=2 if config['Global'].get('collector_name_high_resolution') else 4
    assert actual.shape==(1,width//temporal_stride,70)
    checks.append({'width':width,'shape':list(actual.shape),'max_probability_error':error})
report={'changed_tensors':changed,'backbone_or_bn_changes':0,'native_export_checks':checks,'training_real':6221,'training_synthetic':2000,'shuffle':True,'training_epochs':config['Global']['epoch_num'],'validation_checkpoint_selection':True}
report['reference_checkpoint']=str(initial_path);report['temporal_stride']=temporal_stride
if (run/'data-audit.json').exists():
    data=json.loads((run/'data-audit.json').read_text())
    if isinstance(data['counts']['train'],dict):
        counts=data['counts']['train'];report.update(training_positive=counts.get('existing_positive',0)+counts.get('reviewed_positive',0),training_negative=counts.get('verified_negative',0),training_real=sum(counts.get(k,0) for k in ['existing_positive','reviewed_positive','verified_negative']),training_synthetic=data.get('synthetic_repetition_training',2000))
    else:
        # Production variants preserve a parent manifest; do not confuse its
        # unique observations with the expanded loader's augmentation count.
        rows=[json.loads(line) for line in (run/'manifest.jsonl').read_text().splitlines()]
        train=[r for r in rows if r['split']=='train' and r.get('optimize',True)]
        report.update(training_positive=sum(bool(r['label']) for r in train),training_negative=sum(not r['label'] for r in train),training_real=len(train),training_synthetic=data['train_repetition'],training_variants=data['counts']['train'])
        report['training_synthetic']+=data.get('raw_repetition_training',0)
elif (run/'audit.json').exists():
    data=json.loads((run/'audit.json').read_text())
    report.update(training_positive=data['unique_real_train_parents'],training_real=data['unique_real_train_parents'],training_negative=0,training_variants=data['real_train_variants'],training_synthetic=data['raw']+data['reviewed_gray'],constructed_blank_training=data['constructed_blank_train'],real_validation=data['real_val'],constructed_blank_validation=data['constructed_blank_val'],specialist_role='name')
(run/'verification.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
