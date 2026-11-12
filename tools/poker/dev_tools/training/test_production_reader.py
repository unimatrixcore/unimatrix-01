"""Exercise admission, caching and temporal revocation together."""
import json
from pathlib import Path
import unittest

import numpy as np

from production_reader import CollectorReader
from test_collector_frame_policy import rounded_plate, name_glyphs


class FakeModel:
    characters=['blank']+list('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.#:-()')+[' ']
    def __init__(self):self.calls=0
    def probabilities(self,image):
        self.calls+=1;marker=int(image[image.shape[0]//2,image.shape[1]//2,0])
        text={20:'#123456',21:'#654321',70:'G 1 BB',90:'S 2 BB'}.get(marker,'')
        return self.emit(text)
    def emit(self,text):
        ids=[0]
        for c in text:ids.extend([self.characters.index(c),0])
        result=np.zeros((1,len(ids),70),np.float32)
        result[0,np.arange(len(ids)),ids]=1
        return result


class ReaderTests(unittest.TestCase):
    def setUp(self):
        # A plate is bounded by a different table background. Filling the whole
        # image with plate color now correctly represents a modal, not a seat.
        self.image=np.full((160,240,3),(35,30,25),np.uint8)
        self.regions={'screen_width':240,'screen_height':160,'round_id':{'x':10,'y':10,'w':90,'h':30},
                      'seats':[{'nameplate':{'x':110,'y':65,'w':100,'h':85},'bank':{'x':120,'y':90,'w':60,'h':30}}]}
        rounded_plate(self.image,self.regions['seats'][0]['nameplate'])
        self.image[10:40,10:100]=(20,0,0);self.image[90:120,120:180]=(70,0,0)
        self.colors={'nameplate':'#192a35','in_turn':'#8900f2','in_turn_urgent':'#e13e5e'}
        self.model=FakeModel();self.reader=CollectorReader(None,model=self.model)

    def read(self,index,time=None):return self.reader.read_frame(self.image,self.regions,self.colors,'frame'+str(index),index*.5 if time is None else time)

    def test_cache_is_not_a_second_capture(self):
        self.assertFalse(self.read(1)['accepted_frame'])
        second=self.read(2);self.assertEqual(second['regions']['seats[0].bank']['decision']['text'],'G 1 BB')
        third=self.read(3);self.assertEqual(third['regions']['seats[0].bank']['decision']['text'],'G 1 BB')
        self.assertEqual(third['inference_crops'],0)
        duplicate=self.read(3);self.assertFalse(duplicate['accepted_frame'])
        self.assertFalse(self.read(4)['accepted_frame'])

    def test_bad_game_id_revokes_regions(self):
        self.read(1);self.read(2);self.read(3)
        self.image[10:40,10:100]=(0,0,0)
        result=self.read(4)
        self.assertFalse(result['accepted_frame']);self.assertEqual(result['regions'],{})
        self.assertFalse(self.reader.temporal.pending)

    def test_inactive_seat_revokes_bank(self):
        self.read(1);self.read(2);self.read(3)
        self.image[65:150,110:210]=(0,0,0)
        result=self.read(4)
        self.assertNotIn('seats[0].bank',result['regions'])
        self.assertNotIn('seats[0].bank',self.reader.temporal.pending)

    def test_currency_conflict_never_picks_a_winner(self):
        self.regions['seats'][0]['bet']={'x':120,'y':130,'w':60,'h':20}
        self.image[130:150,120:180]=(90,0,0)
        self.read(1);self.read(2);result=self.read(3)
        self.assertEqual(result['currency_context']['state'],'conflict')
        for rid in ['seats[0].bank','seats[0].bet']:
            self.assertEqual(result['regions'][rid]['decision']['state'],'unknown')
            self.assertNotIn(rid,self.reader.temporal.pending)

    def test_geometry_change_cannot_reuse_out_of_bounds_value(self):
        self.read(1);self.read(2);self.read(3)
        self.regions['seats'][0]['bank']={'x':239,'y':90,'w':60,'h':30}
        result=self.read(4)
        self.assertNotIn('seats[0].bank',result['regions'])
        self.assertNotIn('seats[0].bank',self.reader.temporal.pending)

    def test_name_specialist_routes_only_name_regions_and_fails_independently(self):
        class NameModel(FakeModel):
            fail=False
            def probabilities(self,image):
                self.calls+=1
                if self.fail:raise RuntimeError('Name inference failed')
                return self.emit('User1')
        names=NameModel();self.reader=CollectorReader(None,model=self.model,name_model=names)
        self.regions['seats'][0]['name']={'x':120,'y':72,'w':60,'h':15}
        name_glyphs(self.image,self.regions['seats'][0]['name'])
        self.read(1);self.read(2);result=self.read(3)
        self.assertEqual(result['regions']['seats[0].name']['decision']['text'],'User1')
        self.assertEqual(names.calls,5)
        self.assertEqual(self.model.calls,10)
        self.image[72:87,120:180]=(99,42,25)
        name_glyphs(self.image,self.regions['seats'][0]['name'])
        names.fail=True
        result=self.read(4)
        self.assertEqual(result['regions']['seats[0].name']['decision']['state'],'unknown')
        self.assertEqual(result['regions']['seats[0].bank']['decision']['text'],'G 1 BB')


if __name__=='__main__':unittest.main()

class ReaderDiscontinuityTests(ReaderTests):
    def test_configuration_change_requires_new_confirmation(self):
        self.read(1); self.read(2); self.read(3)
        self.colors['in_turn'] = '#000001'
        result = self.read(4)
        self.assertEqual(result['reason'], 'awaiting_game_id_confirmation')
        self.assertEqual(result['regions'], {})
        self.assertEqual(self.read(5)['regions']['seats[0].bank']['decision']['text'], 'G 1 BB')

    def test_reused_identity_after_intervening_capture_resets_temporal(self):
        self.read(1); self.read(2); self.read(3)
        result = self.reader.read_frame(self.image, self.regions, self.colors, 'frame1', 2)
        self.assertEqual(result['reason'], 'reused_capture_identity')
        self.assertEqual(self.read(5)['reason'], 'awaiting_game_id_confirmation')


class SpeculativeBodyTests(ReaderTests):
    def test_first_observation_is_private_second_confirms_cached_body(self):
        first = self.read(1)
        self.assertFalse(first['accepted_frame'])
        self.assertEqual(first['regions'], {})
        self.assertEqual(first['active_seats'], [])
        self.assertNotIn('currency_context', first)
        self.assertGreater(self.model.calls, 5)
        second = self.read(2)
        self.assertTrue(second['accepted_frame'])
        self.assertEqual(second['regions']['seats[0].bank']['decision']['text'], 'G 1 BB')
        self.assertEqual(second['inference_crops'], 0)

    def test_changed_body_requires_another_matching_capture(self):
        self.read(1)
        self.image[90:120,120:180] = (90, 0, 0)
        second = self.read(2)
        self.assertEqual(second['regions']['seats[0].bank']['decision']['state'], 'unknown')
        self.assertEqual(self.read(3)['regions']['seats[0].bank']['decision']['text'], 'S 2 BB')

    def test_changed_game_id_discards_private_body_evidence(self):
        self.read(1)
        self.image[10:40,10:100] = (21, 0, 0)
        second = self.read(2)
        self.assertFalse(second['accepted_frame'])
        self.assertEqual(second['regions'], {})
        third = self.read(3)
        self.assertTrue(third['accepted_frame'])
        self.assertEqual(third['regions']['seats[0].bank']['decision']['text'], 'G 1 BB')

    def test_invalid_header_does_not_infer_body_and_resets_evidence(self):
        self.read(1)
        self.image[10:40,10:100] = (0, 0, 0)
        self.image[90:120,120:180] = (90, 0, 0)
        calls = self.model.calls
        invalid = self.read(2)
        self.assertFalse(invalid['accepted_frame'])
        self.assertEqual(invalid['regions'], {})
        self.assertEqual(self.model.calls - calls, 5)
        self.image[10:40,10:100] = (20, 0, 0)
        self.assertFalse(self.read(3)['accepted_frame'])
        self.assertEqual(self.read(4)['regions']['seats[0].bank']['decision']['text'], 'S 2 BB')

    def test_duplicate_capture_cannot_confirm_cached_observation(self):
        self.assertFalse(self.read(1)['accepted_frame'])
        self.assertFalse(self.read(1)['accepted_frame'])
        self.assertFalse(self.read(2)['accepted_frame'])
        self.assertEqual(self.read(3)['regions']['seats[0].bank']['decision']['text'], 'G 1 BB')
