#!/usr/bin/env python3
"""Prepare official PaddleOCR fine-tuning without altering collector samples."""
import argparse,copy,hashlib,json,math
from pathlib import Path
import yaml


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--epochs',type=int,default=3);p.add_argument('--batch-size',type=int,default=32);a=p.parse_args()
    root=a.root.resolve();source=root/'paddle-training-source'
    comparison=json.loads((root/'benchmarks/comparison.json').read_text());winner=comparison['winner']
    if winner!='PP-OCRv6_small_rec':raise RuntimeError(f'Configuration needs explicit review for winner {winner}')
    model_dir=root/'benchmark-models'/winner;weights=model_dir/'pretrained.pdparams'
    if not weights.exists():raise RuntimeError('Official pretrained training checkpoint is missing')
    config=yaml.safe_load((source/'configs/rec/PP-OCRv6/PP-OCRv6_small_rec.yml').read_text())
    rows=[json.loads(l) for l in (root/'full-bundle/curated.jsonl').read_text().splitlines()]
    dictionary=source/config['Global']['character_dict_path']
    alphabet=set(dictionary.read_text().replace('\n','')+' ')
    missing=set(''.join(r['label'] for r in rows))-alphabet
    if missing:raise RuntimeError(f'Checkpoint alphabet cannot encode: {sorted(missing)}')
    out=root/'paddle-transfer-v2';out.mkdir(exist_ok=True)
    for split in ['train','val','test']:
        items=[r for r in rows if r['split']==split]
        (out/f'{split}.txt').write_text(''.join(str(root/'full-bundle'/r['image_path'])+'\t'+r['label']+'\n' for r in items))
    longest=max(len(r['label']) for r in rows);max_text=max(64,longest)
    global_cfg=config['Global'];global_cfg.update(epoch_num=a.epochs,use_gpu=True,distributed=False,seed=761,
        save_model_dir=str(out/'checkpoints'),pretrained_model=str(weights),save_epoch_step=1,
        eval_batch_step=[0,math.ceil(sum(r['split']=='train' for r in rows)/a.batch_size)],
        print_batch_step=100,cal_metric_during_train=False,max_text_length=max_text,
        use_amp=True,amp_level='O1',scale_loss=1024.0,use_dynamic_loss_scaling=True,
        character_dict_path=str(dictionary),d2s_train_image_shape=[3,48,320])
    config['Optimizer']['lr'].update(learning_rate=.0001,warmup_epoch=0)
    config['Metric'].update(ignore_space=False,is_filter=False)
    config['Loss'].update(loss_config_list=[{'CTCLoss':None},{'NRTRLoss':None}],weight_1=1.0,weight_2=0.0)
    config['Architecture']['Head']['head_list'][1]['NRTRHead']['max_text_length']=max_text
    # Preserve the full pretrained alphabet/head. Fixed-height aspect-preserving
    # padding at the original width 320 retains the pretrained input convention.
    # The expanded label limit keeps every validated split-pot transcription.
    transforms=[{'DecodeImage':{'img_mode':'BGR','channel_first':False}},
                {'MultiLabelEncode':{'gtc_encode':'NRTRLabelEncode'}},
                {'RecResizeImg':{'image_shape':[3,48,320]}},
                {'KeepKeys':{'keep_keys':['image','label_ctc','label_gtc','length','valid_ratio']}}]
    for split,key in [('train','Train'),('val','Eval')]:
        config[key]={'dataset':{'name':'SimpleDataSet','data_dir':str(root/'full-bundle'),
            'label_file_list':[str(out/f'{split}.txt')],'ratio_list':[1.0],'transforms':copy.deepcopy(transforms)},
            'loader':{'shuffle':split=='train','drop_last':False,'batch_size_per_card':a.batch_size,'num_workers':2}}
    (out/'config.yml').write_text(yaml.safe_dump(config,sort_keys=False,allow_unicode=True))
    manifest={'winner':winner,'selection':comparison['selection'],'epochs':a.epochs,'batch_size':a.batch_size,
        'max_label_length':longest,'configured_max_text_length':max_text,'image_shape':[3,48,320],
        'pretrained_sha256':hashlib.sha256(weights.read_bytes()).hexdigest(),
        'source_commit':'dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf',
        'splits':{s:sum(r['split']==s for r in rows) for s in ['train','val','test']},
        'training_policy':'Run through train_paddle_transfer.py: frozen pretrained backbone/BN; train CTC encoder/head only.','thermal_policy':'Normal hardware thermal management; no manual pacing.','checkpoint_selection':'Native strict validation exact-match accuracy; spaces preserved. Test list not used for training/checkpoint selection.'}
    (out/'provenance.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))

if __name__=='__main__':main()
