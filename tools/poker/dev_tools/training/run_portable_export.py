#!/usr/bin/env python3
"""Export equivalent elementary linear ops for older ONNX operator mappers.

Paddle 3.3 emits linear_v2, which the installed Paddle2ONNX 2.1 converter
does not support. No weights change: linear is exactly matmul plus bias.
The resulting export still requires numerical and decoded-output parity tests.
"""
import runpy
from pathlib import Path

import paddle
import paddle.nn.functional as functional


def elementary_linear(x,weight,bias=None,name=None):
    output=paddle.matmul(x,weight,name=name)
    return paddle.add(output,bias) if bias is not None else output


functional.linear=elementary_linear
runpy.run_path(str(Path(__file__).with_name('run_negative_ocr.py')),run_name='__main__')
