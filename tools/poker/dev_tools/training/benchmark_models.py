#!/usr/bin/env python3
"""Compare untouched pretrained crop recognizers on one immutable labeled sample.

Each model uses its documented image processor and raw decoding. No target-based
cropping, vocabulary correction, case folding, or schema repair is performed.
"""
import argparse,collections,hashlib,json,math,statistics,time
from pathlib import Path


def distance(a,b):
    row=list(range(len(b)+1))
    for i,x in enumerate(a,1):
        nxt=[i]
        for j,y in enumerate(b,1):nxt.append(min(nxt[-1]+1,row[j]+1,row[j-1]+(x!=y)))
        row=nxt
    return row[-1]


def summary(rows):
    return {'samples':len(rows),'exact_match':sum(r['target']==r['prediction'] for r in rows)/len(rows),
            'cer':sum(r['errors'] for r in rows)/sum(len(r['target']) for r in rows),
            'whitespace_normalized_exact':sum(' '.join(r['target'].split())==' '.join(r['prediction'].split()) for r in rows)/len(rows),
            'empty_outputs':sum(not r['prediction'] for r in rows),
            'raw_exact_match':sum(r['target']==r.get('raw_prediction',r['prediction']) for r in rows)/len(rows),
            'raw_cer':sum(r.get('raw_errors',r['errors']) for r in rows)/sum(len(r['target']) for r in rows)}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--backend',choices=['paddle','trocr','crnn'],required=True)
    parser.add_argument('--model',required=True)
    parser.add_argument('--manifest',type=Path,required=True)
    parser.add_argument('--image-root',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--batch-size',type=int,default=8)
    parser.add_argument('--device',default='cpu')
    parser.add_argument('--upstream',type=Path)
    parser.add_argument('--checkpoint',type=Path)
    parser.add_argument('--model-dir',type=Path)
    parser.add_argument('--weights-stage',choices=['pretrained','fine-tuned'],default='pretrained')
    parser.add_argument('--canonicalize-structured',action='store_true')
    parser.add_argument('--input-profile',type=Path)
    args=parser.parse_args()
    rows=[json.loads(line) for line in args.manifest.read_text().splitlines()]
    assert len({r['sample_id'] for r in rows})==len(rows)
    paths=[str(args.image_root/r['image_path']) for r in rows]
    load_start=time.perf_counter();metadata={};predict=None
    if args.backend=='paddle':
        import paddle
        import paddleocr
        from paddleocr import TextRecognition
        model=TextRecognition(model_name=args.model,model_dir=str(args.model_dir) if args.model_dir else None,device=args.device,cpu_threads=4,enable_mkldnn=False)
        metadata={'paddle':paddle.__version__,'paddleocr':paddleocr.__version__}
        if args.model_dir:
            metadata['model_files_sha256']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in args.model_dir.glob('inference.*')}
        def predict(batch):
            results=list(model.predict(input=batch,batch_size=len(batch)))
            # Resolve by input path; batch runtimes may reorder samples by width.
            by_path={str(r['input_path']):r for r in results}
            assert len(by_path)==len(batch)
            return [(str(by_path[p]['rec_text']),float(by_path[p]['rec_score'])) for p in batch]
    elif args.backend=='trocr':
        import torch
        import transformers
        from PIL import Image
        from transformers import TrOCRProcessor,VisionEncoderDecoderModel
        torch.set_num_threads(4)
        processor=TrOCRProcessor.from_pretrained(args.model,use_fast=False)
        model=VisionEncoderDecoderModel.from_pretrained(args.model).to(args.device).eval()
        metadata={'torch':torch.__version__,'transformers':transformers.__version__,'parameter_count':sum(p.numel() for p in model.parameters())}
        def predict(batch):
            images=[]
            for p in batch:
                with Image.open(p) as im:images.append(im.convert('RGB'))
            pixels=processor(images=images,return_tensors='pt').pixel_values.to(args.device)
            with torch.inference_mode():
                output=model.generate(pixels,max_new_tokens=128,num_beams=1,do_sample=False)
            texts=processor.batch_decode(output,skip_special_tokens=True)
            if args.device.startswith('cuda'):torch.cuda.synchronize()
            return [(text,None) for text in texts]
    else:
        import importlib.util
        import torch
        from PIL import Image
        import numpy as np
        from train_reviewed import ALPHABET,decode
        torch.set_num_threads(4)
        spec=importlib.util.spec_from_file_location('ocr_model',args.upstream/'ocrs_models/models.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        model=module.RecognitionModel(ALPHABET).to(args.device).eval()
        model.load_state_dict(torch.load(args.checkpoint,map_location='cpu',weights_only=True)['model_state'])
        metadata={'torch':torch.__version__,'checkpoint_sha256':hashlib.sha256(args.checkpoint.read_bytes()).hexdigest()}
        def predict(batch):
            tensors=[];widths=[]
            for p in batch:
                with Image.open(p) as im:
                    im=im.convert('L');width=min(800,max(12,round(im.width*64/im.height)));im=im.resize((width,64),Image.Resampling.BILINEAR)
                    tensors.append(torch.from_numpy(np.asarray(im,dtype=np.float32).copy()/255-.5));widths.append(width)
            x=torch.full((len(batch),1,64,((max(widths)+3)//4)*4),-.5)
            for i,t in enumerate(tensors):x[i,0,:,:widths[i]]=t
            with torch.inference_mode():pred=model(x.to(args.device)).argmax(-1).transpose(0,1).cpu().tolist()
            return [(decode(seq[:width//4]),None) for seq,width in zip(pred,widths)]
    if args.input_profile:
        profile=json.loads(args.input_profile.read_text());metadata['input_profile']={k:v for k,v in profile.items() if k!='rows'}
    metadata['structured_canonicalization']='Schema whitespace only: names and currency fields; all non-whitespace characters preserved' if args.canonicalize_structured else 'None'
    load_seconds=time.perf_counter()-load_start
    # Warm-up is excluded from timing; it uses the same public model settings.
    predict(paths[:min(args.batch_size,len(paths))])
    predictions=[];batch_times=[];start=time.perf_counter()
    args.output.mkdir(parents=True,exist_ok=True)
    with (args.output/'predictions.jsonl').open('w') as out:
        for offset in range(0,len(rows),args.batch_size):
            batch_rows=rows[offset:offset+args.batch_size];batch_paths=paths[offset:offset+args.batch_size]
            batch_start=time.perf_counter();outputs=predict(batch_paths);elapsed=time.perf_counter()-batch_start
            assert len(outputs)==len(batch_rows);batch_times.append(elapsed/len(batch_rows)*1000)
            for r,(text,confidence) in zip(batch_rows,outputs):
                raw_text=text
                if args.canonicalize_structured:
                    from ocr_output import canonicalize_output
                    text=canonicalize_output(text,r['category'])
                result={key:r[key] for key in ['sample_id','category','region_id','condition_hint','image_width','image_height']}
                result.update(target=r['label'],prediction=text,raw_prediction=raw_text,confidence=confidence,errors=distance(r['label'],text),raw_errors=distance(r['label'],raw_text))
                predictions.append(result);out.write(json.dumps(result,ensure_ascii=False)+'\n')
            out.flush()
            if (offset//args.batch_size)%10==0:print(f'{args.model}: {len(predictions)}/{len(rows)}',flush=True)
    report=summary(predictions)
    for key in ['category','region_id','condition_hint']:
        report[key]={value:summary([r for r in predictions if r[key]==value]) for value in sorted({r[key] for r in predictions})}
    report.update(model=args.model,backend=args.backend,device=args.device,batch_size=args.batch_size,
                  manifest_sha256=hashlib.sha256(args.manifest.read_bytes()).hexdigest(),load_seconds=load_seconds,
                  total_seconds=time.perf_counter()-start,mean_amortized_batch_ms=statistics.mean(batch_times),
                  p95_amortized_batch_ms=sorted(batch_times)[math.ceil(.95*len(batch_times))-1],versions=metadata,
                  weights_stage=args.weights_stage,protocol=f'{args.weights_stage} weights. Collector field crops; any image profile and formatting are recorded explicitly. Official per-model preprocessing; CRNN fixed-height grayscale. Raw output exact/CER; whitespace-normalized score secondary. No label-dependent transforms.')
    (args.output/'metrics.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ['category','region_id','condition_hint']},ensure_ascii=False),flush=True)

if __name__=='__main__':
    main()
