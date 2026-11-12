#!/usr/bin/env python3
"""Losslessly transfer needed visual/CTC tensors; drop unused multilingual classes."""
import argparse,copy,json,string,sys,hashlib
from pathlib import Path
import yaml,numpy as np,paddle
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--manifest',type=Path);p.add_argument('--augmentation',type=Path);a=p.parse_args();root=a.root.resolve();source=root/'paddle-training-source';sys.path.insert(0,str(source));paddle.set_device('cpu')
from ppocr.modeling.architectures import build_model
from ppocr.postprocess import build_post_process
out=root/'compact-ocr-v4';out.mkdir(exist_ok=True)
chars=string.digits+string.ascii_uppercase+string.ascii_lowercase+'.#:-()'
(out/'dictionary.txt').write_text(''.join(c+'\n' for c in chars))
config=yaml.safe_load((root/'paddle-transfer-v2/config.yml').read_text())
config['Global'].update(character_dict_path=str(out/'dictionary.txt'),use_space_char=True,save_model_dir=str(out/'checkpoints'),pretrained_model=str(out/'initial.pdparams'),epoch_num=3,print_batch_step=50,collector_pool_width=1)
config['Architecture']['Neck']={'name':'SequenceEncoder','encoder_type':'lightsvtr','dims':120,'depth':2,'mlp_ratio':2.0,'local_kernel':7}
config['Architecture']['Head']={'name':'CTCHead','fc_decay':.00001}
config['Loss']={'name':'CTCLoss'}
config['Optimizer']['lr'].update(learning_rate=.00002,warmup_epoch=0)
for key in ['Train','Eval']:
 config[key]['dataset']['transforms'][1]={'CTCLabelEncode':None}
 config[key]['dataset']['transforms'][3]={'KeepKeys':{'keep_keys':['image','label','length']}}
 config[key]['loader']['batch_size_per_card']=32
new_decoder=build_post_process(config['PostProcess'],config['Global']);new_chars=new_decoder.character
old_chars=json.loads((root/'geometry-controls/repetition-alphabet.json').read_text())
assert new_chars[0]=='blank' and len(new_chars)==70
assert all(old_chars.count(c)==1 for c in new_chars)
keep=[old_chars.index(c) for c in new_chars]
state=paddle.load(str(root/'paddle-transfer-v2/checkpoints/best_accuracy.pdparams'));mapped={}
for key,tensor in state.items():
 if key.startswith('backbone.'):new_key=key
 elif key.startswith('head.ctc_encoder.'):new_key='neck.'+key[len('head.ctc_encoder.'):]
 elif key.startswith('head.ctc_head.'):new_key='head.'+key[len('head.ctc_head.'):]
 else:continue
 if new_key=='head.fc.weight':tensor=paddle.index_select(tensor,paddle.to_tensor(keep),axis=1)
 elif new_key=='head.fc.bias':tensor=paddle.index_select(tensor,paddle.to_tensor(keep),axis=0)
 mapped[new_key]=tensor
build_config=copy.deepcopy(config['Architecture']);build_config['Head']['out_channels']=len(new_chars);model=build_model(build_config)
assert set(model.state_dict())==set(mapped),(set(model.state_dict())-set(mapped),set(mapped)-set(model.state_dict()))
for key,tensor in model.state_dict().items():assert list(tensor.shape)==list(mapped[key].shape),(key,tensor.shape,mapped[key].shape)
model.set_state_dict(mapped);paddle.save(mapped,str(out/'initial.pdparams'))
for width,name in [(2,'control'),(1,'highres')]:
 cfg=copy.deepcopy(config);cfg['Global']['collector_pool_width']=width;cfg['Global']['save_inference_dir']=str(out/f'export-{name}')
 (out/f'{name}.yml').write_text(yaml.safe_dump(cfg,sort_keys=False))
(out/'transfer.json').write_text(json.dumps({'source_checkpoint_sha256':hashlib.sha256((root/'paddle-transfer-v2/checkpoints/best_accuracy.pdparams').read_bytes()).hexdigest(),'new_character_classes':new_chars,'old_class_indices':keep,'mapped_tensor_count':len(mapped),'removed':'NRTR auxiliary decoder and unsupported output characters','geometry':'Unchanged convolutions. Final width pooling 2 for parity control; 1 for doubled sequence resolution.'},indent=2))
if a.manifest:
 rows=[json.loads(line) for line in a.manifest.read_text().splitlines()]
 cfg=copy.deepcopy(config);cfg['Global'].update(epoch_num=4,eval_batch_step=[0,258],save_inference_dir=str(out/'export'))
 for split,key in [('train','Train'),('val','Eval')]:
  lines=[str(out/'inputs'/r['image_path'])+'\t'+r['label']+'\n' for r in rows if r['split']==split]
  if split=='train' and a.augmentation:
   for line in (a.augmentation/'labels.txt').read_text().splitlines():
    image,label=line.split('\t');lines.append(str((a.augmentation/image).resolve())+'\t'+label+'\n')
  path=out/(split+'.txt');path.write_text(''.join(lines));cfg[key]['dataset'].update(data_dir=str(root),label_file_list=[str(path)])
 (out/'train.yml').write_text(yaml.safe_dump(cfg,sort_keys=False))
print('Prepared compact transfer:',len(mapped),'tensors,',len(new_chars),'CTC classes')
