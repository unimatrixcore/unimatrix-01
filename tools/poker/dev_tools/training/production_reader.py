"""Local collector-contract reader with explicit abstention and bounded cache.

The caller supplies genuine capture identity/time and raw monitor pixels. This
reader does not capture the desktop, control a browser, or infer missing digits.
"""
import collections
import hashlib
import json
import math
import re
import time

import numpy as np

from collector_frame_policy import plan_frame_regions
from portable_ocr import PortableModel, decode_ctc
from production_decision import Decision, TemporalAgreement, decide_views

OFFSETS=((0,0),(-2,0),(2,0),(0,-2),(0,2))
AXIS_OFFSETS=((0,0),(2,0),(0,2))


def configuration_fingerprint(regions,colors):
    return hashlib.sha256(json.dumps([regions,colors],sort_keys=True,allow_nan=False,separators=(',',':')).encode()).hexdigest()


def region_inputs(frame,rect,category,view_policy='five'):
    if not isinstance(rect,dict) or any(type(rect.get(k)) is not int for k in ('x','y','w','h')):raise ValueError('invalid_geometry')
    h,w=frame.shape[:2];x,y,rw,rh=(rect[k] for k in ('x','y','w','h'))
    if rw<=0 or rh<=0:raise ValueError('invalid_geometry')
    crops=[];digest=hashlib.sha256(category.encode())
    offsets=AXIS_OFFSETS if view_policy=='mixed' and category!='name' else OFFSETS
    for dx,dy in offsets:
        xx,yy=x+dx,y+dy
        if xx<0 or yy<0 or xx+rw>w or yy+rh>h:raise ValueError('view_out_of_bounds')
        crop=frame[yy:yy+rh,xx:xx+rw].copy();crops.append(crop)
        digest.update(str(crop.shape).encode());digest.update(crop.tobytes())
    return crops,digest.hexdigest()


class CollectorReader:
    def __init__(self,model_dir,threads=4,max_cache_entries=512,model=None,view_policy='five',device='cpu',name_model_dir=None,name_model=None):
        if max_cache_entries<1:raise ValueError('Cache must be bounded and positive')
        if view_policy not in ('five','mixed'):raise ValueError('Unknown view policy')
        self.model=model if model is not None else PortableModel(model_dir,threads,device=device)
        self.name_model=name_model if name_model is not None else (PortableModel(name_model_dir,threads,device=device) if name_model_dir else None)
        self.view_policy=view_policy
        self.max_cache_entries=max_cache_entries;self.cache=collections.OrderedDict()
        self.temporal=TemporalAgreement();self.last_frame=None;self.table=None;self.currency=None
        self.source_history=collections.OrderedDict();self.configuration=None

    def reset_temporal(self):
        self.temporal.reset();self.table=None;self.currency=None

    def _read_region(self,frame,rect,category):
        try:crops,key=region_inputs(frame,rect,category,self.view_policy)
        except ValueError as exc:return Decision('unknown',None,str(exc)),[],0,None
        if key in self.cache:
            result=self.cache.pop(key);self.cache[key]=result
            return result[0],result[1],0,key
        model=self.name_model if category=='name' and self.name_model is not None else self.model
        def predict_views(selected_model):
            predictions=[]
            for crop in crops:
                try:
                    probabilities=selected_model.probabilities(crop)
                    text,confidence=decode_ctc(probabilities,selected_model.characters)
                    predictions.append({'raw_prediction':text,'confidence':confidence})
                except Exception as exc:
                    predictions.append({'error':str(exc)})
            return predictions
        predictions=predict_views(model)
        calls=len(crops)
        decision=decide_views(category,predictions,required_views=len(crops))
        if category=='name' and self.name_model is not None and decision.state=='text' and re.fullmatch(r'Player[1-9]',decision.text):
            # The name specialist has no positive space examples in its original
            # training set. Ask the already pinned general model to READ these
            # exact same five views; never insert a space into specialist text.
            specialist_predictions=predictions
            predictions=predict_views(self.model)
            calls+=len(crops)
            secondary=decide_views(category,predictions,required_views=len(crops))
            literal=[view.get('raw_prediction') for view in predictions]
            matched=(len(crops)==5 and secondary.state=='text'
                     and all(isinstance(text,str) and re.fullmatch(r'Player ?[1-9]',text) for text in literal)
                     and len(set(literal))==1 and literal[0].replace(' ','')==decision.text)
            decision=(Decision('text',literal[0],'anonymous_name_general_crosscheck') if matched
                      else Decision('unknown',None,'anonymous_name_crosscheck_failed'))
            # Each selected/general raw view retains its corresponding original
            # specialist view, so the routing choice is fully auditable. Failed
            # secondary inference stays a top-level error and is not cached.
            predictions=[dict(view,model_role='general',selected_model_role='general' if matched else None,
                              routing_policy='anonymous_name_literal_crosscheck_v1',
                              specialist_view=dict(primary,model_role='names'))
                         for view,primary in zip(predictions,specialist_predictions)]
        # Cache deterministic successful inference only; a transient runtime
        # failure must get another chance on the next genuine capture.
        if not any(r.get('error') for r in predictions):
            self.cache[key]=(decision,predictions)
            while len(self.cache)>self.max_cache_entries:self.cache.popitem(last=False)
        return decision,predictions,calls,key

    def read_frame(self,frame,regions,colors,frame_id,captured_at):
        start=time.perf_counter();result={'frame_id':frame_id,'captured_at':captured_at,'accepted_frame':False,'regions':{},'inference_crops':0,'active_seats':[],'view_policy':self.view_policy}
        def finish(reason):
            result['reason']=reason;result['elapsed_ms']=(time.perf_counter()-start)*1000;return result
        if not isinstance(frame_id,str) or not frame_id.strip() or isinstance(captured_at,bool) or not isinstance(captured_at,(int,float)) or not math.isfinite(captured_at):
            self.reset_temporal();return finish('invalid_capture_provenance')
        if self.last_frame and captured_at<=self.last_frame[1]:
            self.reset_temporal();return finish('duplicate_or_out_of_order_frame')
        while self.source_history and next(iter(self.source_history.values()))<captured_at-60:self.source_history.popitem(last=False)
        if frame_id in self.source_history:
            self.reset_temporal();return finish('reused_capture_identity')
        self.source_history[frame_id]=captured_at
        while len(self.source_history)>2048:self.source_history.popitem(last=False)
        self.last_frame=(frame_id,captured_at)
        if not isinstance(frame,np.ndarray) or frame.dtype!=np.uint8 or frame.ndim!=3 or frame.shape[2]!=3 or not frame.size:
            self.reset_temporal();return finish('invalid_frame')
        if not isinstance(regions,dict) or (frame.shape[1],frame.shape[0])!=(regions.get('screen_width'),regions.get('screen_height')):
            self.reset_temporal();return finish('screen_dimensions_mismatch')
        try:epoch=configuration_fingerprint(regions,colors)
        except (TypeError,ValueError):self.reset_temporal();return finish('invalid_configuration')
        if epoch!=self.configuration:self.reset_temporal();self.configuration=epoch
        result['configuration_fingerprint']=epoch
        spatial,views,calls,digest=self._read_region(frame,regions.get('round_id'),'round_id');result['inference_crops']+=calls
        result['game_id_spatial']={'decision':spatial.__dict__,'views':views,'input_fingerprint':digest}
        if spatial.state!='text':
            self.reset_temporal();return finish('game_id_unverified')
        if self.table!=spatial.text:
            self.temporal.reset();self.table=spatial.text;self.currency=None
        game_id=self.temporal.update('round_id',self.table,frame_id,captured_at,spatial)
        result['game_id']=game_id.__dict__
        # Spatially valid Game ID evidence can select candidate crops before
        # temporal confirmation. Keep those observations private until BOTH
        # header and region agreement are confirmed on distinct captures.
        plan=plan_frame_regions(frame,regions,colors,spatial)
        if not plan['accepted_frame']:
            self.reset_temporal();return finish('collector_frame_rejected')
        candidate_regions={}
        for region in plan['regions']:
            rid=region['region_id']
            if rid=='round_id':
                candidate_regions[rid]={'category':'round_id','decision':game_id.__dict__,'spatial':spatial.__dict__,'input_fingerprint':digest};continue
            decision,evidence,calls,input_digest=self._read_region(frame,region['rect'],region['category']);result['inference_crops']+=calls
            confirmed=self.temporal.update(rid,self.table,frame_id,captured_at,decision)
            candidate_regions[rid]={'category':region['category'],'decision':confirmed.__dict__,'spatial':decision.__dict__,'views':evidence,'input_fingerprint':input_digest}
        # Removing a seat/region revokes its pending value immediately; a later
        # reappearance needs new observations rather than old confirmation.
        admitted=set(candidate_regions)
        for rid in list(self.temporal.pending):
            if rid not in admitted:self.temporal.pending.pop(rid,None)
        money=[(rid,r) for rid,r in candidate_regions.items() if r['category'] in ('bank','bet','pot','split_pot')]
        currencies={currency for _,r in money if r['spatial']['state']=='text' for currency in re.findall(r'(?:^|\s)([GS]) (?=\d)',r['spatial']['text'])}
        if self.currency:currencies.add(self.currency)
        if len(currencies)>1:
            currency_context={'state':'conflict','currency':None}
            for rid,r in money:
                if r['spatial']['state']=='text':
                    r['decision']=Decision('unknown',None,'game_currency_disagreement').__dict__
                    self.temporal.pending.pop(rid,None)
        elif currencies:
            currency=next(iter(currencies));currency_context={'state':'consistent','currency':currency}
            if game_id.state=='text' and any(r['decision']['state']=='text' and re.search(r'(?:^|\s)[GS] (?=\d)',r['decision']['text']) for _,r in money):self.currency=currency
        else:currency_context={'state':'unknown','currency':None}
        if game_id.state!='text':return finish('awaiting_game_id_confirmation')
        result.update(accepted_frame=True,regions=candidate_regions,active_seats=plan['active_seats'],rejected_regions=plan['rejected'],currency_context=currency_context)
        return finish('frame_processed')
