#!/usr/bin/env python3
"""Run the selected collector OCR pipeline without access to a target label."""
import argparse,json,tempfile
from pathlib import Path
import cv2
from prepare_ocr_inputs import localize_pill,normalize_name
from ocr_output import canonicalize_output


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model-dir',type=Path,required=True)
    p.add_argument('--image',type=Path,required=True)
    p.add_argument('--category',required=True,choices=['name','status','bank','bet','card','dealer','pot','split_pot','round_id'])
    p.add_argument('--device',default='cpu')
    a=p.parse_args()
    from paddleocr import TextRecognition
    image=cv2.imread(str(a.image))
    if image is None:raise ValueError('Cannot decode crop: '+str(a.image))
    image,box=localize_pill(image,a.category)
    normalization=None
    if a.category=='name':image,normalization=normalize_name(image)
    model=TextRecognition(model_name='PP-OCRv6_small_rec',model_dir=str(a.model_dir),device=a.device,cpu_threads=4,enable_mkldnn=False)
    with tempfile.TemporaryDirectory(prefix='collector-ocr-') as directory:
        path=Path(directory)/'input.png'
        if not cv2.imwrite(str(path),image):raise OSError('Cannot write temporary crop')
        result=next(iter(model.predict(input=str(path),batch_size=1)))
    raw=str(result['rec_text']);text=canonicalize_output(raw,a.category)
    print(json.dumps({'image':str(a.image),'category':a.category,'raw_prediction':raw,'prediction':text,'confidence':float(result['rec_score']),'pill_box':box,'name_normalization':normalization}))


if __name__=='__main__':main()
