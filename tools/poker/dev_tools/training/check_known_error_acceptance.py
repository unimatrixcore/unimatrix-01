#!/usr/bin/env python3
"""Retrospective exact-source checks for previously observed canonical errors.

The two observations repeat ARCHIVED pixels with synthetic replay identities.
They exercise temporal policy deterministically and are not independent captures.
Source databases and source images remain read-only.
"""
import argparse,copy,hashlib,json,re,sys,time
from pathlib import Path
import cv2
import numpy as np
from production_reader import CollectorReader,region_inputs
from realtime_collector import verify_frozen_runtime


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def rgbsha(image):
    h,w=image.shape[:2]
    return hashlib.sha256(f'{w}x{h}:RGB:'.encode()+cv2.cvtColor(image,cv2.COLOR_BGR2RGB).tobytes()).hexdigest()
def resolve(config,rid):
    node=config
    for key,index in re.findall(r'([a-zA-Z_]+)|\[(\d+)\]',rid):
        node=node[int(index)] if index else node[key]
    return node

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--release',type=Path,required=True);p.add_argument('--root',type=Path,required=True);p.add_argument('--device',default='gpu:0');a=p.parse_args()
    root=a.root;root.mkdir(exist_ok=True,parents=True);stage=a.release.resolve();config=json.loads((stage/'runtime.json').read_text());regions=json.loads((stage/'regions.json').read_text());colors=json.loads((stage/'colors.json').read_text());models={role:stage/config[key] for role,key in [('general','general_model'),('names','name_model')]}
    verify_frozen_runtime(stage/'freeze.json',models['general'],models['names'],regions,colors,a.device,1.)
    reader=CollectorReader(models['general'],name_model_dir=models['names'],device=a.device,view_policy='five')
    inputs=json.loads((root/'inputs.json').read_text());results=[];base=time.monotonic()
    for item in inputs:
        row=item['manifest'];e=item['error'];rid=row['region_id'];out={k:v for k,v in item.items() if k!='manifest'};out['split']=row['split'];out['label_evidence']=row['label_evidence'];out['expected_label']=row['label'];out['scope']='Archived repeated-pixel policy replay; synthetic identities do not constitute independent physical observations.'
        if not item['source_exists']:
            out.update(status='missing_full_source_context',full_runtime_checked=False);results.append(out);continue
        source=Path(item['source_path']);original=Path(item['original_crop_path']);before=sha(source);frame=cv2.imread(str(source));crop=cv2.imread(str(original));out.update(source_sha256=before,source_dimensions=list(frame.shape[1::-1]),original_crop_file_verified=sha(original)==row.get('file_sha256',row.get('image_sha256')))
        rect=row.get('provenance',{}).get('crop_rect') or {k:row.get(k) for k in ('x','y','w','h')};out['original_rect']=rect;cr=frame[rect['y']:rect['y']+rect['h'],rect['x']:rect['x']+rect['w']];out['original_crop_matches_source']=cr.shape==crop.shape and np.array_equal(cr,crop);out['source_roi_pixel_sha256']=rgbsha(cr);out['saved_crop_pixel_sha256']=rgbsha(crop)
        current=resolve(regions,rid);out['current_rect']=current;out['current_rect_matches_original']=current==rect
        # Explicitly reset table/field agreement at every unrelated archive source.
        reader.reset_temporal();first=reader.read_frame(frame,regions,colors,f'archive-known-error-{item["index"]}-observation1',base+item['index']*2)
        second=reader.read_frame(frame,regions,colors,f'archive-known-error-{item["index"]}-observation2',base+item['index']*2+.5)
        out['full_runtime_checked']=True;out['frame_admitted']=second['accepted_frame'];out['frame_reason']=second['reason'];out['active_seats']=second.get('active_seats',[]);out['region_admitted']=rid in second.get('regions',{});out['first_game_id']=first.get('game_id');out['second_game_id']=second.get('game_id');out['current_region_result']=second.get('regions',{}).get(rid)
        # Inspect the genuine current five-view crop context even if full-frame
        # admission correctly rejects the target. It never becomes authoritative.
        decision,views,calls,digest=reader._read_region(frame,current,e['category']);out['current_spatial_diagnostic']={'decision':decision.__dict__,'views':views,'input_fingerprint':digest,'inference_crops':calls,'authoritative':False}
        if rect!=current and out['original_crop_matches_source']:
            d,v,c,k=reader._read_region(frame,rect,e['category']);out['original_rect_spatial_diagnostic']={'decision':d.__dict__,'views':v,'input_fingerprint':k,'inference_crops':c,'authoritative':False}
        entry=out['current_region_result'];decision=entry['decision'] if entry else None
        if not entry:out['status']='not_admitted'
        elif decision['state']=='unknown':out['status']='abstained'
        elif decision.get('text')==row['label']:out['status']='accepted_matches_stored_label'
        else:out['status']='accepted_differs_from_stored_label'
        out['source_unchanged_after_read']=sha(source)==before;assert out['source_unchanged_after_read'];results.append(out)
        (root/'results.json').write_text(json.dumps({'qualification':'UNQUALIFIED_PENDING_REVIEW','freeze_sha256':sha(stage/'freeze.json'),'reader_sha256':sha(Path(__file__).with_name('production_reader.py')),'rows':results},indent=2)+'\n')
        print(json.dumps({'index':item['index'],'status':out['status'],'label':row['label'],'decision':decision,'source_crop_match':out['original_crop_matches_source']}),flush=True)
    from collections import Counter
    report={'scope':'Targeted retrospective known-error regression; no training, no genuine temporal independence, no production promotion. Missing or mismatched full-source contexts are explicit.','freeze_sha256':sha(stage/'freeze.json'),'script_sha256':sha(__file__),'counts':dict(Counter(r['status'] for r in results)),'cases':len(inputs),'results':len(results),'source_crop_matches':sum(r.get('original_crop_matches_source',False) for r in results),'source_crop_mismatches':[r['index'] for r in results if r.get('original_crop_matches_source') is False],'accepted_label_differences':[r['index'] for r in results if r['status']=='accepted_differs_from_stored_label']}
    (root/'summary.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)

if __name__=='__main__':main()
