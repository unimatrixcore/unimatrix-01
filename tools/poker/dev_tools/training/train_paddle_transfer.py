#!/usr/bin/env python3
"""Run official Paddle training with a controlled transfer-learning policy.

Preserve the pretrained glyph extractor and its normalization statistics while
adapting the CTC encoder/head to collector labels. The original implementation
still performs batching, shuffling, loss, optimization, and checkpointing.
"""
import os,runpy,sys
from pathlib import Path
import paddle

source=Path(os.environ['POKER_PADDLE_SOURCE']).resolve()
sys.path.insert(0,str(source))
import ppocr.modeling.architectures as architectures
original_build=architectures.build_model


def build_transfer_model(config):
    model=original_build(config)
    counts={'trainable':0,'frozen':0}
    for name,parameter in model.named_parameters():
        trainable=name.startswith(('head.ctc_encoder.','head.ctc_head.'))
        parameter.stop_gradient=not trainable
        counts['trainable' if trainable else 'frozen']+=parameter.numel()
    def preserve_feature_statistics(layer,inputs):
        layer.backbone.eval()
        for child in layer.sublayers():
            if isinstance(child,(paddle.nn.BatchNorm1D,paddle.nn.BatchNorm2D,paddle.nn.BatchNorm3D,paddle.nn.SyncBatchNorm)):
                child.eval()
    model.register_forward_pre_hook(preserve_feature_statistics)
    print('TRANSFER POLICY: frozen pretrained backbone/BN; train CTC encoder/head',counts,flush=True)
    return model


architectures.build_model=build_transfer_model
runpy.run_path(str(source/'tools/train.py'),run_name='__main__')
