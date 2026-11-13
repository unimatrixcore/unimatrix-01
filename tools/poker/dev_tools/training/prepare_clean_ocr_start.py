#!/usr/bin/env python3
"""Map the untouched official CTC tensors, never a collector-tuned checkpoint."""
import argparse
import hashlib
import json
from pathlib import Path

import paddle


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);a=p.parse_args();root=a.root.resolve()
    source=root/'benchmark-models/PP-OCRv6_small_rec/pretrained.pdparams'
    chars=json.loads((root/'compact-ocr-v4/transfer.json').read_text())['new_character_classes']
    official_chars=json.loads((root/'geometry-controls/repetition-alphabet.json').read_text())
    assert chars[0]=='blank' and len(chars)==70 and all(official_chars.count(c)==1 for c in chars)
    indices=paddle.to_tensor([official_chars.index(c) for c in chars])
    state=paddle.load(str(source));mapped={}
    for name,tensor in state.items():
        if name.startswith('backbone.'):key=name
        elif name.startswith('head.ctc_encoder.'):key='neck.'+name[len('head.ctc_encoder.'):]
        elif name.startswith('head.ctc_head.'):key='head.'+name[len('head.ctc_head.'):]
        else:continue
        if key=='head.fc.weight':tensor=paddle.index_select(tensor,indices,axis=1)
        elif key=='head.fc.bias':tensor=paddle.index_select(tensor,indices,axis=0)
        mapped[key]=tensor
    reference=paddle.load(str(root/'negative-ocr-v8/checkpoints/best_accuracy.pdparams'))
    assert set(mapped)==set(reference)
    for name,tensor in mapped.items():assert list(tensor.shape)==list(reference[name].shape),name
    out=root/'production-clean-start';out.mkdir(exist_ok=True)
    paddle.save(mapped,str(out/'initial.pdparams'))
    report={'official_source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'mapped_sha256':hashlib.sha256((out/'initial.pdparams').read_bytes()).hexdigest(),
            'collector_tuned_weights_used':False,'class_indices':[official_chars.index(c) for c in chars],'classes':chars,'mapped_tensors':len(mapped),
            'purpose':'Clean-start control to remove inherited collector-label exposure. Existing evaluation sessions are still retrospective reused development evidence.'}
    (out/'provenance.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))


if __name__=='__main__':main()
