#!/usr/bin/env python3
"""Stress the frozen fine-tuned export on every DB row, without retraining."""
import argparse,collections,hashlib,json,tempfile,time
from pathlib import Path
import cv2,numpy as np
from benchmark_models import distance
from prepare_ocr_inputs import localize_pill,normalize_name
from ocr_output import canonicalize_output
from schemas import valid, _source as collector_contract_path, CONTRACT, CONTRACT_SHA256

CONDITIONS=['identity','brightness_minus10','brightness_plus10','gamma_0.85','scale_0.85','blur_0.5','jpeg_80','shift_x2','shift_y2','brightness_minus30','scale_0.60','blur_1.0','combined','known_blank','background_noise']

def transform(image,condition,seed):
    h,w=image.shape[:2]
    if condition=='identity':return image
    if condition in ('known_blank','background_noise'):
        background=np.median(image.reshape(-1,3),axis=0);blank=np.broadcast_to(background,image.shape).copy()
        if condition=='background_noise':blank+=np.random.default_rng(seed).normal(0,3,image.shape)
        return np.clip(blank,0,255).astype(np.uint8)
    if condition.startswith('brightness_'):
        amount={'brightness_minus10':-10,'brightness_plus10':10,'brightness_minus30':-30}[condition]
        return np.clip(image.astype(np.int16)+amount,0,255).astype(np.uint8)
    if condition=='gamma_0.85':return np.clip(255*(image.astype(np.float32)/255)**.85,0,255).astype(np.uint8)
    if condition.startswith('scale_'):
        factor=float(condition.split('_')[1]);return cv2.resize(image,(max(4,round(w*factor)),max(4,round(h*factor))),interpolation=cv2.INTER_AREA)
    if condition.startswith('blur_'):return cv2.GaussianBlur(image,(0,0),float(condition.split('_')[1]))
    if condition=='jpeg_80':
        ok,encoded=cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,80]);assert ok
        return cv2.imdecode(encoded,cv2.IMREAD_COLOR)
    if condition in ('shift_x2','shift_y2'):
        matrix=np.float32([[1,0,2 if condition=='shift_x2' else 0],[0,1,2 if condition=='shift_y2' else 0]])
        return cv2.warpAffine(image,matrix,(w,h),borderMode=cv2.BORDER_REPLICATE)
    if condition=='combined':
        image=transform(image,'scale_0.85',seed);image=transform(image,'brightness_minus10',seed)
        return transform(transform(image,'blur_0.5',seed),'jpeg_80',seed)
    raise ValueError(condition)

def preprocess(image,category):
    image,box=localize_pill(image,category)
    normalization=None
    if category=='name':image,normalization=normalize_name(image)
    return image,{'pill_box':box,'name_normalization':normalization}

def stats(rows):
    known=lambda r:bool(r['original_label']) or r.get('label_kind') in ('verified_negative','reviewed_positive')
    known_rows=[r for r in rows if known(r) and not r.get('negative_fixture')]
    labelled=[r for r in known_rows if not r.get('error')]
    unlabelled=[r for r in rows if not known(r) and not r.get('negative_fixture') and not r.get('error')]
    negatives=[r for r in rows if r.get('negative_fixture') and not r.get('error')]
    reviewed_negatives=[r for r in labelled if r.get('label_kind')=='verified_negative']
    positives=[r for r in labelled if r['label']]
    def score(target,prediction):
        count=sum(not r.get('error') and r[target]==r.get(prediction) for r in known_rows);denominator=sum(len(r[target]) for r in labelled)
        return {'exact_count':count,'denominator':len(known_rows),'accuracy':count/len(known_rows) if known_rows else None,'cer':sum(distance(r[target],r[prediction]) for r in labelled)/denominator if denominator and len(labelled)==len(known_rows) else None,'processing_failures_count_as_mismatch':True}
    mistakes=[r for r in labelled if r['label']!=r['prediction']]
    for r in labelled:r['validated_prediction']=r['prediction'] if r['schema_valid'] or not r['prediction'] else ''
    return {'rows':len(rows),'processing_errors':sum(bool(r.get('error')) for r in rows),'labelled':len(known_rows),'original_labels_pipeline':score('original_label','prediction'),'audited_labels_pipeline':score('label','prediction'),'audited_labels_raw':score('label','raw_prediction'),'audited_labels_schema_validated':score('label','validated_prediction'),'positive_samples':sum(bool(r['label']) for r in known_rows),'positive_exact':sum(r['label']==r['prediction'] for r in positives),'verified_negative_samples':sum(r.get('label_kind')=='verified_negative' for r in known_rows),'verified_negative_processing_errors':sum(r.get('label_kind')=='verified_negative' and bool(r.get('error')) for r in known_rows),'verified_negative_false_outputs':sum(bool(r['prediction']) for r in reviewed_negatives),'verified_negative_schema_valid_false_outputs':sum(bool(r['prediction']) and r['schema_valid'] for r in reviewed_negatives),'unlabelled':len(unlabelled),'unlabelled_nonempty_outputs':sum(bool(r['prediction']) for r in unlabelled),'unlabelled_schema_valid_nonempty':sum(bool(r['prediction']) and r['schema_valid'] for r in unlabelled),'known_negative_fixtures':len(negatives),'known_negative_nonempty':sum(bool(r['prediction']) for r in negatives),'known_negative_schema_valid_nonempty':sum(bool(r['prediction']) and r['schema_valid'] for r in negatives),'known_negative_schema_valid_confidence_ge_0.9':sum(bool(r['prediction']) and r['schema_valid'] and r['confidence']>=.9 for r in negatives),'wrong_with_confidence_ge_0.9':sum(r['confidence']>=.9 for r in mistakes),'wrong_with_confidence_ge_0.99':sum(r['confidence']>=.99 for r in mistakes)}

def main():
    p=argparse.ArgumentParser();p.add_argument('--bundle',type=Path,required=True);p.add_argument('--manifest',type=Path);p.add_argument('--recrops',type=Path);p.add_argument('--model-dir',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--device',default='gpu:0');p.add_argument('--batch-size',type=int,default=1);p.add_argument('--conditions',nargs='+',default=CONDITIONS)
    p.add_argument('--backend',choices=['native','onnx'],default='native')
    p.add_argument('--name-model-dir',type=Path)
    a=p.parse_args()
    manifest=a.manifest or a.bundle/'manifest.jsonl'
    a.output.mkdir(parents=True,exist_ok=True);rows=[json.loads(l) for l in manifest.read_text().splitlines()]
    assert len({r['sample_id'] for r in rows})==len(rows)
    if a.backend=='onnx':
        from portable_ocr import PortableModel
        model=PortableModel(a.model_dir,device=a.device)
    else:
        from paddleocr import TextRecognition
        model=TextRecognition(model_name='PP-OCRv6_small_rec',model_dir=str(a.model_dir),device=a.device,cpu_threads=4,enable_mkldnn=False)
    name_model=None
    if a.name_model_dir:
        name_model=PortableModel(a.name_model_dir,device=a.device) if a.backend=='onnx' else TextRecognition(model_name='PP-OCRv6_small_rec',model_dir=str(a.name_model_dir),device=a.device,cpu_threads=4,enable_mkldnn=False)
    provenance={'model_sha256':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in a.model_dir.iterdir() if f.is_file() and (f.name.startswith('inference.') or f.name in ('model.onnx','characters.json'))},'backend':a.backend,'manifest_sha256':hashlib.sha256(manifest.read_bytes()).hexdigest(),'script_sha256':{Path(f).name:hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in [__file__,str(Path(__file__).with_name('prepare_ocr_inputs.py')),str(Path(__file__).with_name('ocr_output.py')),str(Path(__file__).with_name('schemas.py')),str(collector_contract_path)]},'batch_size':a.batch_size,'device':a.device,'conditions':a.conditions,'model':str(a.model_dir.resolve()),'evaluation':'Frozen export; no training or calibration during this run','unlabelled_policy':'Verified negative/text decisions scored when present; ambiguous/unreviewed rows get predictions without an invented ground truth','translation_policy':'shift_* replicates borders; recrop_* uses original full captures, unavailable-source rows remain unchanged and are reported separately'}
    provenance['opencv_version']=cv2.__version__
    if a.backend=='onnx':
        provenance['execution_providers']=model.session.get_providers()
        provenance['provider_options']=model.session.get_provider_options()
        provenance['script_sha256']['portable_ocr.py']=hashlib.sha256(Path(__file__).with_name('portable_ocr.py').read_bytes()).hexdigest()
    if a.name_model_dir:provenance['name_model_sha256']={f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in a.name_model_dir.iterdir() if f.is_file() and (f.name.startswith('inference.') or f.name in ('model.onnx','characters.json'))}
    provenance['validation_contract']={'version':CONTRACT['version'],'sha256':CONTRACT_SHA256}
    (a.output/'protocol.json').write_text(json.dumps(provenance,indent=2));summary={}
    for condition in a.conditions:
        results=[];start=time.perf_counter();folder=a.output/condition;folder.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='ocr-stress-') as temp,(folder/'predictions.jsonl').open('w') as output:
            for offset in range(0,len(rows),a.batch_size):
                batch=rows[offset:offset+a.batch_size];pending=[];paths=[]
                for row in batch:
                    r={k:row[k] for k in ['sample_id','category','region_id','split','original_label','label','label_corrected']}
                    r['label_kind']=row.get('label_kind','existing_positive' if row['original_label'] else 'unknown')
                    r['negative_fixture']=condition in ('known_blank','background_noise')
                    try:
                        source=a.bundle/row['image_path'];image=cv2.imread(str(source))
                        if image is None:raise ValueError('Missing or undecodable crop')
                        assert hashlib.sha256(source.read_bytes()).hexdigest()==row['file_sha256']
                        if condition.startswith('recrop_'):
                            assert a.recrops,'--recrops required'
                            recrop=a.recrops/condition[7:]/'images'/(row['sample_id']+'.png');r['geometry_available']=recrop.exists()
                            if recrop.exists():image=cv2.imread(str(recrop));assert image is not None
                        else:image=transform(image,condition,int(row['sample_id']))
                        image,preprocessing=preprocess(image,row['category']);r['preprocessing']=preprocessing;path=Path(temp)/(row['sample_id']+'.png')
                        assert cv2.imwrite(str(path),image)
                        r.update(preprocessed_sha256=hashlib.sha256(image.tobytes()).hexdigest(),input_shape=list(image.shape));pending.append((r,path));paths.append(str(path))
                    except Exception as exc:r['error']=str(exc);results.append(r);output.write(json.dumps(r)+'\n')
                if paths:
                    try:
                        if name_model is None:predictions=list(model.predict(input=paths,batch_size=len(paths)))
                        else:
                            predictions=[]
                            for selected_model,wants_name in [(model,False),(name_model,True)]:
                                selected_paths=[str(path) for row,path in pending if (row['category']=='name')==wants_name]
                                if selected_paths:predictions.extend(selected_model.predict(input=selected_paths,batch_size=len(selected_paths)))
                        by_path={str(r['input_path']):r for r in predictions};assert set(by_path)==set(paths)
                        staged=[]
                        for r,path in pending:
                            pred=by_path[str(path)];raw=str(pred['rec_text']);text=canonicalize_output(raw,r['category']);schema_valid=valid({'category':r['category'],'label':text});r.update(raw_prediction=raw,prediction=text,confidence=float(pred['rec_score']),schema_valid=schema_valid,validated_prediction=text if schema_valid or not text else '')
                            staged.append(r)
                        for r in staged:results.append(r);output.write(json.dumps(r)+'\n')
                        for r,path in pending:path.unlink()
                    except Exception as exc:
                        for r,path in pending:r['error']='Inference: '+str(exc);results.append(r);output.write(json.dumps(r)+'\n')
                output.flush()
                if offset%500==0:print(condition,offset,'/',len(rows),flush=True)
        assert len(results)==len(rows),(condition,len(results),len(rows))
        report=stats(results);report['seconds']=time.perf_counter()-start
        for key in ['category','region_id','split']:report[key]={v:stats([r for r in results if r[key]==v]) for v in sorted({r[key] for r in results})}
        if condition.startswith('recrop_'):report['geometry_coverage']={str(v):stats([r for r in results if r.get('geometry_available')==v]) for v in [True,False]}
        (folder/'metrics.json').write_text(json.dumps(report,indent=2));summary[condition]={k:v for k,v in report.items() if k not in ['category','region_id','split']};(a.output/'summary.json').write_text(json.dumps(summary,indent=2));print('FINISHED',condition,json.dumps(summary[condition]),flush=True)

if __name__=='__main__':main()
