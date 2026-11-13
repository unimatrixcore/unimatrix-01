#!/usr/bin/env python3
"""Fine-tune the upstream OCR recognizer on reviewed, group-disjoint crops.

Use the pinned upstream models.py without importing its unrelated dataset tooling.
All choices use validation only; the held-out test is evaluated after selection.
"""
import argparse, collections, hashlib, importlib.util, json, random
from pathlib import Path
import numpy as np
from PIL import Image
import torch
from torch import nn
from torch.utils.data import Dataset, DataLoader

ALPHABET = ' 0123456789!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~' + chr(8364) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

def edit_distance(a,b):
    row=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        nxt=[i]
        for j,y in enumerate(b,1):nxt.append(min(nxt[-1]+1,row[j]+1,row[j-1]+(x!=y)))
        row=nxt
    return row[-1]

class Crops(Dataset):
    def __init__(self,rows,root):self.rows=rows;self.root=root
    def __len__(self):return len(self.rows)
    def __getitem__(self,i):
        r=self.rows[i];p=Path(r['image_path']);p=p if p.is_absolute() else self.root/p
        with Image.open(p) as img:
            img=img.convert('L');width=min(800,max(12,round(img.width*64/img.height)))
            img=img.resize((width,64),Image.Resampling.BILINEAR)
            data=torch.from_numpy(np.asarray(img,dtype=np.float32).copy()/255-.5).unsqueeze(0)
        target=torch.tensor([ALPHABET.index(c)+1 for c in r['label']],dtype=torch.long)
        required=len(target)+sum(a==b for a,b in zip(r['label'],r['label'][1:]))
        if width//4<required:raise ValueError(f"CTC incompatible crop {r['sample_id']}")
        return data,target,r

def collate(items):
    widths=[x.shape[-1] for x,_,_ in items];w=((max(widths)+3)//4)*4
    images=torch.full((len(items),1,64,w),-.5)
    for i,(x,_,_) in enumerate(items):images[i,:,:,:x.shape[-1]]=x
    return images,torch.cat([t for _,t,_ in items]),torch.tensor([len(t) for _,t,_ in items]),torch.tensor(widths)//4,[r for _,_,r in items]

def decode(seq):
    prev=0;result=''
    for c in seq:
        if c and c!=prev:result+=ALPHABET[c-1]
        prev=c
    return result

def evaluate(model,loader,device):
    model.eval();predictions=[]
    with torch.inference_mode():
        for images,_,_,lengths,rows in loader:
            pred=model(images.to(device)).argmax(-1).transpose(0,1).cpu().tolist()
            for seq,length,r in zip(pred,lengths.tolist(),rows):
                text=decode(seq[:length]);predictions.append({'sample_id':r['sample_id'],'category':r['category'],'region_id':r['region_id'],'dimensions':f"{r.get('image_width')}x{r.get('image_height')}",'target':r['label'],'prediction':text,'errors':edit_distance(r['label'],text)})
    def stats(rs):return {'samples':len(rs),'cer':sum(r['errors'] for r in rs)/sum(len(r['target']) for r in rs),'exact_match':sum(r['target']==r['prediction'] for r in rs)/len(rs)}
    result=stats(predictions);result['categories']={c:stats([r for r in predictions if r['category']==c]) for c in sorted({r['category'] for r in predictions})}
    result['regions']={c:stats([r for r in predictions if r['region_id']==c]) for c in sorted({r['region_id'] for r in predictions})}
    result['dimensions']={c:stats([r for r in predictions if r['dimensions']==c]) for c in sorted({r['dimensions'] for r in predictions})}
    return result,predictions

def main():
    p=argparse.ArgumentParser();p.add_argument('--manifest',type=Path,required=True);p.add_argument('--upstream',type=Path,required=True);p.add_argument('--checkpoint',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--epochs',type=int,default=12);p.add_argument('--batch-size',type=int,default=8);p.add_argument('--lr',type=float,default=1e-4);p.add_argument('--patience',type=int,default=6);p.add_argument('--finalize-only',action='store_true');a=p.parse_args()
    if a.finalize_only:
        if not (a.output/'best.pt').exists():raise RuntimeError('No selected checkpoint to finalize')
        a.epochs=0
    random.seed(761);np.random.seed(761);torch.manual_seed(761);torch.set_num_threads(4)
    if not torch.cuda.is_available():raise RuntimeError('CUDA unavailable; refusing accidental desktop/CPU training')
    device=torch.device('cuda');torch.cuda.set_per_process_memory_fraction(.75)
    rows=[json.loads(l) for l in a.manifest.read_text().splitlines()];groups={};hashes={};ids=set()
    for r in rows:
        assert r['review_status'] in {'visually_verified','collector_labeled_audited'};assert r['sample_id'] not in ids;ids.add(r['sample_id'])
        assert set(r['label'])<=set(ALPHABET)
        for key,seen in [('group_id',groups),('pixel_sha256',hashes)]:
            if r[key] in seen:assert seen[r[key]]==r['split'],f'{key} leakage'
            seen[r[key]]=r['split']
    loaders={s:DataLoader(Crops([r for r in rows if r['split']==s],a.manifest.parent),batch_size=a.batch_size,shuffle=s=='train',collate_fn=collate) for s in ['train','val','test']}
    assert all(len(l.dataset)>0 for l in loaders.values())
    spec=importlib.util.spec_from_file_location('ocr_model',a.upstream/'ocrs_models/models.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    model=module.RecognitionModel(ALPHABET).to(device)
    ckpt=torch.load(a.checkpoint,map_location='cpu',weights_only=True);model.load_state_dict(ckpt['model_state'])
    a.output.mkdir(parents=True,exist_ok=True)
    baseline_val,_=evaluate(model,loaders['val'],device)
    # Save baseline for independent held-out evaluation after epoch selection.
    base_state={k:v.detach().cpu().clone() for k,v in model.state_dict().items()}
    optimizer=torch.optim.Adam(model.parameters(),lr=a.lr);loss_fn=nn.CTCLoss();best=(float('inf'),0);history=[]
    for epoch in range(1,a.epochs+1):
        model.train()
        # Preserve pretrained batch normalization statistics with this small corpus.
        for layer in model.modules():
            if isinstance(layer,nn.BatchNorm2d):layer.eval()
        losses=[]
        for images,targets,target_lengths,input_lengths,_ in loaders['train']:
            optimizer.zero_grad();pred=model(images.to(device))
            loss=loss_fn(pred,targets.to(device),input_lengths,target_lengths)
            if not torch.isfinite(loss):raise RuntimeError('Nonfinite loss')
            loss.backward();nn.utils.clip_grad_norm_(model.parameters(),4);optimizer.step();losses.append(loss.item())
        validation,_=evaluate(model,loaders['val'],device);entry={'epoch':epoch,'loss':sum(losses)/len(losses),'validation':validation};history.append(entry);print(json.dumps(entry),flush=True)
        score=(validation['cer'],-validation['exact_match'])
        if score<best:
            best=score;torch.save({'model_state':model.state_dict(),'epoch':epoch,'alphabet':ALPHABET,'validation':validation},a.output/'best.pt')
        (a.output/'history.json').write_text(json.dumps(history,indent=2))
        selected=torch.load(a.output/'best.pt',map_location='cpu',weights_only=True)['epoch']
        if epoch-selected>=a.patience:
            print(f'Early stopping after {a.patience} epochs without validation improvement',flush=True)
            break
    model.load_state_dict(base_state);baseline_test,base_preds=evaluate(model,loaders['test'],device)
    best_ckpt=torch.load(a.output/'best.pt',map_location=device,weights_only=True);model.load_state_dict(best_ckpt['model_state']);tuned_test,tuned_preds=evaluate(model,loaders['test'],device)
    report={'seed':761,'device':torch.cuda.get_device_name(),'torch':torch.__version__,'manifest_sha256':hashlib.sha256(a.manifest.read_bytes()).hexdigest(),'checkpoint_sha256':hashlib.sha256(a.checkpoint.read_bytes()).hexdigest(),'train_samples':len(loaders['train'].dataset),'best_epoch':best_ckpt['epoch'],'completed_epochs':len(json.loads((a.output/'history.json').read_text())),'selection_policy':'Validation CER, then exact match; patience 6 completed epochs without improvement. Test evaluated after selection.','baseline_validation':baseline_val,'tuned_validation':best_ckpt['validation'],'baseline_test':baseline_test,'tuned_test':tuned_test,'improved_test_cer':tuned_test['cer']<baseline_test['cer'],'runtime_model_replaced':False,'limitation':'Collector-labeled corpus with category visual audits; offline evaluation does not prove live table accuracy.'}
    (a.output/'metrics.json').write_text(json.dumps(report,indent=2));(a.output/'predictions.json').write_text(json.dumps({'baseline':base_preds,'tuned':tuned_preds},indent=2))
    model.eval().cpu();dummy=torch.zeros(1,1,64,256)
    torch.onnx.export(model,dummy,str(a.output/'recognition.onnx'),input_names=['line_image'],output_names=['chars'],dynamic_axes={'line_image':{0:'batch',3:'width'},'chars':{0:'sequence',1:'batch'}},opset_version=17,dynamo=False)
    import onnxruntime as ort
    session=ort.InferenceSession(str(a.output/'recognition.onnx'),providers=['CPUExecutionProvider'])
    # Check numerical export equivalence at multiple widths, including batch 2.
    parity=[]
    for batch,width in [(1,128),(2,256),(1,512)]:
        x=torch.rand(batch,1,64,width)-.5
        with torch.inference_mode():expected=model(x).numpy()
        actual=session.run(None,{'line_image':x.numpy()})[0];np.testing.assert_allclose(actual,expected,rtol=1e-3,atol=1e-4);parity.append({'batch':batch,'width':width,'max_abs_error':float(np.max(np.abs(actual-expected)))})
    (a.output/'onnx-parity.json').write_text(json.dumps(parity,indent=2));print(json.dumps(report),flush=True)
if __name__=='__main__':main()
