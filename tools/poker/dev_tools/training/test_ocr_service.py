import base64
import unittest
import cv2
import numpy as np
from ocr_service import handle_request

class FakeService:
    regions={'screen_width':10,'screen_height':8}
    def submit_frame(self,image,capture_id,captured_at):self.submitted=(image,capture_id,captured_at)
    def get_latest(self):return {'state':'unknown','reason':'pending'}
    def close(self):self.closed=True

class TransportTests(unittest.TestCase):
    def test_pixels_identity_and_original_time_survive_transport(self):
        service=FakeService();pixels=np.full((8,10,3),(53,42,25),np.uint8)
        _,png=cv2.imencode('.png',pixels)
        handle_request(service,{'op':'submit','png_base64':base64.b64encode(png).decode(),'capture_id':'A','captured_at':12.5})
        self.assertTrue(np.array_equal(service.submitted[0],pixels));self.assertEqual(service.submitted[1:],('A',12.5))
    def test_bad_payloads_and_geometry_are_rejected(self):
        for encoded in ('????',base64.b64encode(b'not png').decode()):
            with self.assertRaises(ValueError):handle_request(FakeService(),{'op':'submit','png_base64':encoded})
        _,png=cv2.imencode('.png',np.zeros((9,10,3),np.uint8))
        with self.assertRaisesRegex(ValueError,'geometry'):handle_request(FakeService(),{'op':'submit','png_base64':base64.b64encode(png).decode()})
    def test_operations_are_explicit(self):
        s=FakeService();self.assertEqual(handle_request(s,{'op':'latest'})['reason'],'pending')
        handle_request(s,{'op':'close'});self.assertTrue(s.closed)
        with self.assertRaises(ValueError):handle_request(s,{'op':'reset'})
