"""Pinned, bounded live-frame interface for the production desktop GPU."""
import collections
import copy
from dataclasses import asdict
import hashlib
import json
import math
from pathlib import Path
import threading
import time

from collector_frame_policy import plan_frame_regions
from latest_frame_worker import FramePacket, LatestFrameWorker
from production_reader import CollectorReader, OFFSETS, configuration_fingerprint, region_inputs


def verify_frozen_runtime(frozen_path,model_dir,name_model_dir,regions,colors,device,max_age):
    """Verify the code actually imported, both model roles, and their policy."""
    import collector_frame_policy,latest_frame_worker,ocr_output,portable_ocr,production_decision,production_reader,schemas,seat_admission
    frozen=json.loads(Path(frozen_path).read_text())
    if device!='gpu:0':raise ValueError('Production release requires the desktop CUDA device')
    policy=frozen['policy']
    if frozen.get('validation_contract') != {'version':schemas.CONTRACT['version'],'sha256':schemas.CONTRACT_SHA256}:
        raise ValueError('OCR validation contract differs from the frozen release; candidate requalification required')
    if frozen.get('collector_contract_implementation_sha256') != hashlib.sha256(schemas.CONTRACT_IMPLEMENTATION_PATH.read_bytes()).hexdigest():
        raise ValueError('OCR contract implementation differs from the frozen release')
    if policy['views']!=[list(v) for v in OFFSETS] or policy['temporal_observations']!=2 or policy['maximum_temporal_gap_seconds']!=1.5 or policy['name_confidence_threshold'] is not None or policy['automatic_glyph_repair']:
        raise ValueError('Unsupported production decision policy')
    if max_age!=policy['maximum_result_age_seconds']:raise ValueError('Freshness policy differs from the frozen release')
    for role,directory in [('general',model_dir),('names',name_model_dir)]:
        for filename,expected in [('model.onnx',frozen['weights'][role]),('characters.json',frozen['characters_sha256'][role])]:
            if hashlib.sha256((Path(directory)/filename).read_bytes()).hexdigest()!=expected:raise ValueError('Frozen '+role+' '+filename+' mismatch')
    modules=[collector_frame_policy,latest_frame_worker,ocr_output,portable_ocr,production_decision,production_reader,schemas,seat_admission]
    sources={Path(m.__file__).name:Path(m.__file__) for m in modules};sources['realtime_collector.py']=Path(__file__)
    if set(sources)!=set(frozen['implementation_sha256']):raise ValueError('Incomplete runtime fingerprint')
    for name,path in sources.items():
        if hashlib.sha256(path.read_bytes()).hexdigest()!=frozen['implementation_sha256'][name]:raise ValueError('Executing unverified runtime code: '+name)
    if hashlib.sha256(schemas._source.read_bytes()).hexdigest()!=frozen['collector_validator_sha256']:raise ValueError('Collector validator changed')
    expected=configuration_fingerprint(regions,colors)
    if expected!=frozen['configuration_fingerprint']:raise ValueError('Unverified capture configuration')
    return expected


class RealtimeCollector:
    def __init__(self,model_dir,regions,colors,*,device='gpu:0',max_age_seconds=1.,reader=None,clock=time.monotonic,name_model_dir=None,frozen_path=None):
        self.regions=copy.deepcopy(regions);self.colors=copy.deepcopy(colors)
        self.frozen_configuration=None
        if reader is None:
            if name_model_dir is None or frozen_path is None:raise ValueError('Production requires both pinned model roles and a frozen runtime manifest')
            self.frozen_configuration=verify_frozen_runtime(frozen_path,model_dir,name_model_dir,self.regions,self.colors,device,max_age_seconds)
        self.reader=reader if reader is not None else CollectorReader(model_dir,device=device,name_model_dir=name_model_dir,view_policy='five')
        self.clock=clock;self.max_age=max_age_seconds;self._sequence=0;self._submit_lock=threading.RLock()
        self._source_ids=collections.OrderedDict();self._current=None
        def process(packet):
            with self._submit_lock:geometry=copy.deepcopy(self.regions);palette=copy.deepcopy(self.colors)
            if self.frozen_configuration and configuration_fingerprint(geometry,palette)!=self.frozen_configuration:
                self.reader.reset_temporal()
                return {'accepted_frame':False,'regions':{},'reason':'unverified_configuration'}
            payload=packet.pixels
            return self.reader.read_frame(payload['image'],geometry,palette,payload['capture_id'],packet.captured_at)
        self.worker=LatestFrameWorker(process,max_age_seconds,clock=clock,on_discontinuity=lambda reason:self.reader.reset_temporal())

    def submit_frame(self,image,capture_id,captured_at):
        """Copy genuine capture pixels; never replace capture time with receipt time."""
        if not isinstance(capture_id,str) or not capture_id.strip() or isinstance(captured_at,bool) or not isinstance(captured_at,(int,float)) or not math.isfinite(captured_at):raise ValueError('Genuine capture identity/time required')
        owned=copy.deepcopy(image)
        with self._submit_lock:
            while self._source_ids and next(iter(self._source_ids.values()))<captured_at-60:self._source_ids.popitem(last=False)
            if capture_id in self._source_ids:raise ValueError('Reused source capture identity')
            self._sequence+=1
            self.worker.submit(FramePacket(f'{self._sequence:020d}',captured_at,{'image':owned,'capture_id':capture_id}))
            self._source_ids[capture_id]=captured_at
            while len(self._source_ids)>2048:self._source_ids.popitem(last=False)
            self._current=(capture_id,captured_at,owned)

    def _validate_current_pixels(self,result):
        value=result['value'];capture_id,_,image=self._current
        if configuration_fingerprint(self.regions,self.colors)!=value.get('configuration_fingerprint'):
            return 'configuration_changed'
        if capture_id==value['frame_id']:return None
        _,header=region_inputs(image,self.regions['round_id'],'round_id')
        if header!=value['game_id_spatial'].get('input_fingerprint'):return 'newer_capture_changed_game_id'
        plan=plan_frame_regions(image,self.regions,self.colors,value['game_id'])
        if not plan['accepted_frame']:return 'newer_capture_unverified'
        admitted={r['region_id']:r for r in plan['regions']};old=value['regions'];current={}
        for rid,region in admitted.items():
            entry=old.get(rid)
            _,digest=region_inputs(image,region['rect'],region['category'])
            if entry is None or entry.get('input_fingerprint')!=digest:
                current[rid]={'category':region['category'],'decision':{'state':'unknown','text':None,'reason':'newer_capture_changed_region'}}
            else:current[rid]=entry
        value['regions']=current;value['active_seats']=plan['active_seats'];value['validated_against_capture_id']=capture_id
        value['currency_context']={'state':'pending_newer_capture','currency':None}
        return None

    def get_latest(self,*,require_newest=False):
        # Requiring the newest submitted ID is an optional transactional mode.
        # During continuous capture, unchanged input pixels can safely retain a
        # fresh processed read; changed regions are revoked without waiting for
        # the next neural pass. This avoids starving publication under overload.
        with self._submit_lock:
            result=asdict(self.worker.get_latest(require_newest=require_newest))
            if result['state']=='available':
                if not result['value'].get('accepted_frame'):
                    result['state']='unknown';result['reason']=result['value'].get('reason','reader_rejected_frame')
                else:
                    try:reason=self._validate_current_pixels(result)
                    except (ValueError,TypeError,KeyError,AttributeError):reason='current_input_unverified'
                    if reason:result.update(state='unknown',reason=reason,value=None)
            if result['captured_at'] is not None:
                result['capture_age_ms']=(self.clock()-result['captured_at'])*1000
                if result['capture_age_ms']>self.max_age*1000:result.update(state='unknown',reason='stale',value=None)
            return result

    def close(self,timeout=1.):return self.worker.close(timeout)
