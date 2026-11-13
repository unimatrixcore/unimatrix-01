import hashlib
import unittest
from unittest.mock import patch
import cv2
import numpy as np
from collector_inference import suggest, suggest_many

class Model:
    def __init__(self,text):
        self.text=text;self.characters=['blank']+list(dict.fromkeys(text));self.calls=0;self.batch_sizes=[]
    def probabilities(self,image):
        self.calls+=1;ids=[0]
        for c in self.text:ids.extend([self.characters.index(c),0])
        p=np.zeros((1,len(ids),len(self.characters)),np.float32)
        p[0,np.arange(len(ids)),ids]=1
        return p

    def probabilities_many(self, images):
        self.batch_sizes.append(len(images))
        return np.concatenate([self.probabilities(image) for image in images], axis=0)

class SuggestionTests(unittest.TestCase):
    def setUp(self):
        _,image=cv2.imencode('.png',np.full((12,40,3),(53,42,25),np.uint8));self.png=image.tobytes()
        self.models={'names':Model('Player 1'),'general':Model('G10.5BB')};self.freeze={'weights':{'names':'a'*64,'general':'b'*64}}
    def test_role_raw_text_and_image_provenance(self):
        names=suggest(self.models,self.freeze,self.png,'seats[0].name')
        self.assertEqual((names['raw_text'],names['text']),('Player 1','Player 1'))
        self.assertEqual(names['model_sha256'],'a'*64);self.assertTrue(names['schema_valid'])
        bank=suggest(self.models,self.freeze,self.png,'seats[0].bank')
        self.assertEqual(bank['text'],'G 10.5 BB');self.assertEqual(bank['image_sha256'],hashlib.sha256(self.png).hexdigest())
        self.assertEqual(self.models['names'].calls,1);self.assertEqual(self.models['general'].calls,1)
    def test_whitespace_is_not_accepted_as_verified_blank(self):
        self.models['names']=Model(' ')
        self.assertFalse(suggest(self.models,self.freeze,self.png,'seats[0].name')['schema_valid'])
        self.models['general']=Model('')
        self.assertTrue(suggest(self.models,self.freeze,self.png,'community_cards[0]')['schema_valid'])
    def test_visible_statuses_are_valid_without_changing_the_prediction(self):
        for label in ('Fold', 'Hide Cards'):
            self.models['general']=Model(label)
            result=suggest(self.models,self.freeze,self.png,'seats[1].status')
            self.assertEqual((result['raw_text'],result['text']),(label,label))
            self.assertTrue(result['schema_valid'])
    def test_all_numbered_players_keep_their_exact_prediction(self):
        for number in range(1,10):
            label=f'Player {number}'
            self.models['names']=Model(label)
            result=suggest(self.models,self.freeze,self.png,'seats[0].name')
            self.assertEqual(result['raw_text'],label)
            self.assertEqual(result['text'],label)
            self.assertTrue(result['schema_valid'])
    def test_batched_roles_order_provenance_and_geometry_match_single(self):
        crops = []
        for region, size in [('seats[0].bank',(12,40)),('seats[0].name',(12,40)),('seats[1].bank',(12,40)),('seats[1].name',(12,40)),('seats[2].bank',(12,150))]:
            pixels=np.zeros((*size,3),np.uint8);pixels[0,0]=255
            _, png=cv2.imencode('.png',pixels)
            crops.append((png.tobytes(),region))
        expected=[suggest(self.models,self.freeze,raw,rid) for raw,rid in crops]
        stats={}
        actual=suggest_many(self.models,self.freeze,crops,batch_size=8,stats=stats)
        self.assertEqual(actual,expected)
        self.assertEqual(self.models['general'].batch_sizes,[2])
        self.assertEqual(self.models['names'].batch_sizes,[2])
        self.assertEqual(stats['model_calls'],3)
        self.assertEqual(stats['crop_count'],5)

    def test_uniform_crops_and_bounds_keep_single_prediction_semantics(self):
        expected=suggest(self.models,self.freeze,self.png,'seats[0].bank')
        self.assertEqual(suggest_many(self.models,self.freeze,[(self.png,'seats[0].bank')])[0],expected)
        self.assertEqual(self.models['general'].batch_sizes,[])
        for items in ([], [(self.png,'seats[0].bank')]*193):
            with self.assertRaises(ValueError): suggest_many(self.models,self.freeze,items)

    def test_context_and_invalid_images_are_rejected(self):
        for raw,rid in [(self.png,'seats[0].nameplate'),(b'bad','seats[0].name')]:
            with self.assertRaises(ValueError):suggest(self.models,self.freeze,raw,rid)

    def test_aggregate_geometry_is_bounded_before_decode(self):
        # A header-only input is enough: rejecting the aggregate must happen
        # before any potentially large compressed allocation is decoded.
        header = b'\x89PNG\r\n\x1a\n' + b'\x00\x00\x00\x0dIHDR' + (2000).to_bytes(4,'big') + (4000).to_bytes(4,'big')
        with patch('collector_inference.cv2.imdecode') as decode:
            with self.assertRaisesRegex(ValueError, 'pixel limit'):
                suggest_many(self.models,self.freeze,[(header,'seats[0].name')]*3)
            decode.assert_not_called()
