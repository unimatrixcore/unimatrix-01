import unittest
from portable_ocr import verify_cuda_placement

class PlacementTests(unittest.TestCase):
    def event(self,op,provider):
        return {'cat':'Node','name':op,'args':{'op_name':op,'provider':provider}}
    def test_gpu_heavy_cpu_shape_is_allowed(self):
        proof=verify_cuda_placement([self.event('FusedConv','CUDAExecutionProvider'),self.event('Shape','CPUExecutionProvider')])
        self.assertEqual(proof['heavy_cuda_nodes'],1)
    def test_registered_cuda_does_not_excuse_cpu_heavy(self):
        with self.assertRaises(RuntimeError):
            verify_cuda_placement([self.event('Conv','CUDAExecutionProvider'),self.event('FusedMatMul','CPUExecutionProvider')])
    def test_empty_trace_fails_closed(self):
        with self.assertRaises(RuntimeError):verify_cuda_placement([])

class UniformInputTests(unittest.TestCase):
    def test_uniform_is_blank_but_one_pixel_difference_uses_model(self):
        import numpy as np
        from portable_ocr import PortableModel,decode_ctc
        class Session:
            calls=0
            def run(self,*args):
                self.calls+=1
                return [np.array([[[0.,1.]]],np.float32)]
        model=PortableModel.__new__(PortableModel)
        model.characters=['blank','l'];model.input_name='image';model.session=Session()
        image=np.full((32,201,3),(53,42,25),np.uint8)
        self.assertEqual(decode_ctc(model.probabilities(image),model.characters)[0],'')
        self.assertEqual(model.session.calls,0)
        image[0,0,0]+=1
        self.assertEqual(decode_ctc(model.probabilities(image),model.characters)[0],'l')
        self.assertEqual(model.session.calls,1)
