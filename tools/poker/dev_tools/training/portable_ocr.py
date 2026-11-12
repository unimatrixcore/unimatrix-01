"""ONNX crop inference with explicit BGR/CTC contracts and bounded inputs.

The resize/normalization convention matches PaddleX OCRReisizeNormImg
(Apache-2.0): https://github.com/PaddlePaddle/PaddleX . This implementation
has no Paddle dependency. Validate probabilities and decoded text before use.
"""
import math
from pathlib import Path
import json
import tempfile

import cv2
import numpy as np


def normalize_crop(image):
    if not isinstance(image,np.ndarray) or image.dtype!=np.uint8 or image.ndim!=3 or image.shape[2]!=3 or not image.size:
        raise ValueError('Expected nonempty uint8 BGR crop')
    height,width=image.shape[:2]
    if height>4096 or width>16384:
        raise ValueError('Crop exceeds supported bounds')
    normalized_width=min(3200,int(48*max(320/48,width/height)))
    resized_width=min(normalized_width,math.ceil(48*width/height))
    resized=cv2.resize(image,(resized_width,48)).astype(np.float32).transpose(2,0,1)/255
    resized-=.5;resized/=.5
    output=np.zeros((1,3,48,normalized_width),np.float32)
    output[0,:,:,:resized_width]=resized
    return output


def decode_ctc(probabilities,characters):
    if probabilities.ndim!=3 or probabilities.shape[0]!=1 or probabilities.shape[2]!=len(characters):
        raise ValueError('Unexpected CTC output shape')
    if not np.isfinite(probabilities).all() or np.max(np.abs(probabilities.sum(-1)-1))>.001:
        raise ValueError('Expected finite CTC probabilities')
    values=probabilities[0];ids=values.argmax(-1);selected=ids!=0
    selected[1:] &= ids[1:]!=ids[:-1]
    text=''.join(characters[i] for i in ids[selected])
    confidence=float(values.max(-1)[selected].mean()) if np.any(selected) else 0.
    return text,confidence


def verify_cuda_placement(events):
    nodes=[e for e in events if e.get('cat')=='Node' and any(token in e.get('args',{}).get('op_name','') for token in ('Conv','MatMul','Gemm','Attention'))]
    if not nodes:raise RuntimeError('No heavy operators observed during CUDA startup verification')
    bad=[e.get('name') for e in nodes if e.get('args',{}).get('provider')!='CUDAExecutionProvider']
    if bad:raise RuntimeError('Heavy operators fell back from CUDA: '+str(bad))
    return {'heavy_nodes':len(nodes),'heavy_cuda_nodes':len(nodes),'cpu_heavy_nodes':0}


class PortableModel:
    def __init__(self,model_dir,threads=4,device='cpu',profile=False):
        import onnxruntime as ort
        path=Path(model_dir)
        self.characters=json.loads((path/'characters.json').read_text())
        if len(self.characters)!=70 or self.characters[0]!='blank':
            raise ValueError('Unexpected compact character dictionary')
        options=ort.SessionOptions();options.intra_op_num_threads=threads;options.inter_op_num_threads=1;options.enable_profiling=profile
        if device in ('gpu:0','cuda'):
            probe=tempfile.TemporaryDirectory(prefix='poker-ocr-cuda-probe-')
            options.enable_profiling=True;options.profile_file_prefix=str(Path(probe.name)/'placement')
            # CUDA performs the heavy operators. Shape bookkeeping needs one
            # host thread; spinning several idle CPU pools hurts frame latency
            # when a general model and name specialist coexist.
            options.intra_op_num_threads=1
            options.add_session_config_entry('session.intra_op.allow_spinning','0')
            # Load the isolated NVIDIA wheel libraries, then require actual
            # CUDA execution rather than silently accepting a CPU fallback.
            ort.preload_dlls(directory='')
            providers=[('CUDAExecutionProvider',{'device_id':0,'use_tf32':0,'cudnn_conv_algo_search':'HEURISTIC'})]
        elif device=='cpu':providers=['CPUExecutionProvider']
        else:raise ValueError('Supported devices: cpu, gpu:0')
        self.session=ort.InferenceSession(str(path/'model.onnx'),sess_options=options,providers=providers)
        if device!='cpu' and self.session.get_providers()[0]!='CUDAExecutionProvider':raise RuntimeError('CUDA provider failed; CPU fallback is not accepted')
        self.device=device
        inputs=self.session.get_inputs()
        if len(inputs)!=1:raise ValueError('Expected one image input')
        self.input_name=inputs[0].name
        if device!='cpu':
            self.session.disable_fallback()
            try:
                self.session.run(None,{self.input_name:np.zeros((1,3,48,320),np.float32)})
                trace=Path(self.session.end_profiling())
                self.cuda_placement_proof=verify_cuda_placement(json.loads(trace.read_text()))
            finally:probe.cleanup()

    def probabilities(self,image):
        normalized=normalize_crop(image)
        # An exactly uniform crop has no visible glyph. Require equality of
        # every original BGR pixel; low contrast or noisy crops still use OCR.
        # This prevents the recognizer hallucinating a character on flat UI.
        if np.all(image==image[0,0]):
            blank=np.zeros((1,1,len(self.characters)),np.float32);blank[0,0,0]=1.
            return blank
        return self.session.run(None,{self.input_name:normalized})[0]

    def probabilities_many(self,images):
        """Batch same-geometry views without changing any input's padding.

        This is an explicit candidate path. Its decoded decisions must be
        benchmarked against batch1 before callers enable it in production.
        """
        if not 1<=len(images)<=8:raise ValueError('Expected 1..8 views')
        normalized=[normalize_crop(image) for image in images]
        if len({array.shape for array in normalized})!=1:raise ValueError('View shapes differ')
        return self.session.run(None,{self.input_name:np.concatenate(normalized,axis=0)})[0]

    def predict(self,input,batch_size=1):
        # Evaluate crops individually so neighboring batch shapes cannot change
        # padding/numerics and therefore accepted target strings.
        for path in ([input] if isinstance(input,(str,Path)) else input):
            image=cv2.imread(str(path))
            if image is None:raise ValueError('Cannot decode crop')
            text,confidence=decode_ctc(self.probabilities(image),self.characters)
            yield {'input_path':str(path),'rec_text':text,'rec_score':confidence}
