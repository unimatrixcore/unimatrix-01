import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import collector_frame_policy,latest_frame_worker,ocr_output,portable_ocr,production_decision,production_reader,realtime_collector,schemas,seat_admission
from realtime_collector import RealtimeCollector,verify_frozen_runtime

class ReleasePinTests(unittest.TestCase):
    def test_constructor_requires_specialist_and_freeze(self):
        with self.assertRaisesRegex(ValueError,'both pinned'):RealtimeCollector(None,{}, {})
    def test_all_roles_code_config_and_policy_are_bound(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);models={}
            for role in ('general','names'):
                models[role]=root/role;models[role].mkdir()
                for name in ('model.onnx','characters.json'):(models[role]/name).write_text(role+name)
            digest=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
            regions={'screen_width':1920};colors={'nameplate':'#123456'}
            modules=[collector_frame_policy,latest_frame_worker,ocr_output,portable_ocr,production_decision,production_reader,realtime_collector,schemas,seat_admission]
            f={'weights':{r:digest(p/'model.onnx') for r,p in models.items()},'characters_sha256':{r:digest(p/'characters.json') for r,p in models.items()},'implementation_sha256':{Path(m.__file__).name:digest(Path(m.__file__)) for m in modules},'collector_validator_sha256':digest(schemas._source),'configuration_fingerprint':production_reader.configuration_fingerprint(regions,colors),'policy':{'views':[list(o) for o in production_reader.OFFSETS],'temporal_observations':2,'maximum_temporal_gap_seconds':1.5,'name_confidence_threshold':None,'automatic_glyph_repair':False,'maximum_result_age_seconds':1.}}
            f['validation_contract']={'version':schemas.CONTRACT['version'],'sha256':schemas.CONTRACT_SHA256}
            f['collector_contract_implementation_sha256']=digest(schemas.CONTRACT_IMPLEMENTATION_PATH)
            path=root/'freeze.json';path.write_text(json.dumps(f))
            def check(**kwargs):return verify_frozen_runtime(path,models['general'],models['names'],kwargs.get('regions',regions),colors,kwargs.get('device','gpu:0'),kwargs.get('age',1.))
            self.assertEqual(check(),f['configuration_fingerprint'])
            for key in ('validation_contract','collector_contract_implementation_sha256'):
                original=f.pop(key);path.write_text(json.dumps(f))
                with self.assertRaises(ValueError):check()
                f[key]=original;path.write_text(json.dumps(f))
            for kwargs in ({'regions':{}},{'device':'cpu'},{'age':2.}):
                with self.assertRaises(ValueError):check(**kwargs)
            # The prior eight-module release cannot silently acquire this new
            # admission dependency: it needs a separately qualified freeze.
            original=f['implementation_sha256'].pop('seat_admission.py');path.write_text(json.dumps(f))
            with self.assertRaisesRegex(ValueError,'Incomplete runtime fingerprint'):check()
            f['implementation_sha256']['seat_admission.py']=original
            for section,key in [('weights','names'),('characters_sha256','general'),('implementation_sha256','portable_ocr.py'),('implementation_sha256','seat_admission.py')]:
                original=f[section][key];f[section][key]='bad';path.write_text(json.dumps(f))
                with self.assertRaises(ValueError):check()
                f[section][key]=original
            f['policy']['temporal_observations']=1;path.write_text(json.dumps(f))
            with self.assertRaises(ValueError):check()
