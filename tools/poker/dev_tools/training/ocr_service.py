#!/usr/bin/env python3
"""Persistent local JSONL transport for the pinned desktop CUDA reader.

Only stdout carries protocol messages; diagnostics belong on stderr. Capture
identity and Linux CLOCK_MONOTONIC time must originate before pixel acquisition.
"""
import argparse
import base64
import binascii
import contextlib
import json
from pathlib import Path
import sys

import cv2
import numpy as np

from realtime_collector import RealtimeCollector

MAX_LINE=48*1024*1024


def handle_request(service,request):
    if not isinstance(request,dict):raise ValueError('Expected request object')
    op=request.get('op')
    if op=='latest':return service.get_latest()
    if op=='close':service.close();return {'state':'unknown','reason':'closed','value':None}
    if op!='submit':raise ValueError('Unsupported operation')
    encoded=request.get('png_base64')
    if not isinstance(encoded,str) or len(encoded)>MAX_LINE-4096:raise ValueError('Invalid bounded PNG payload')
    try:raw=base64.b64decode(encoded,validate=True)
    except (ValueError,binascii.Error) as exc:raise ValueError('Invalid base64 PNG') from exc
    # Validate the PNG signature and IHDR dimensions before allocating decoded
    # pixels. The release has one exact geometry, not arbitrary image sizes.
    if len(raw)<24 or raw[:8]!=b'\x89PNG\r\n\x1a\n' or raw[12:16]!=b'IHDR':raise ValueError('Expected PNG image')
    width=int.from_bytes(raw[16:20],'big');height=int.from_bytes(raw[20:24],'big')
    if (width,height)!=(service.regions['screen_width'],service.regions['screen_height']):raise ValueError('Capture geometry differs from pinned release')
    image=cv2.imdecode(np.frombuffer(raw,np.uint8),cv2.IMREAD_COLOR)
    if image is None or image.shape!=(height,width,3):raise ValueError('PNG decoding failed')
    service.submit_frame(image,request.get('capture_id'),request.get('captured_at'))
    return service.get_latest()


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--release',type=Path,required=True);a=p.parse_args();root=a.release.resolve()
    config=json.loads((root/'runtime.json').read_text())
    def path(key):
        value=Path(config[key]);return value if value.is_absolute() else root/value
    # Keep any dependency's Python-level prints out of the framed response
    # stream. Native ONNX diagnostics already go to stderr.
    with contextlib.redirect_stdout(sys.stderr):
        service=RealtimeCollector(path('general_model'),json.loads(path('regions').read_text()),json.loads(path('colors').read_text()),name_model_dir=path('name_model'),frozen_path=root/'freeze.json')
    def reply(value):print(json.dumps(value,separators=(',',':'),allow_nan=False),flush=True)
    reply({'ready':True,'protocol':1,'regions':service.regions,'colors':service.colors})
    try:
        while True:
            line=sys.stdin.buffer.readline(MAX_LINE+1)
            if not line:break
            if len(line)>MAX_LINE:
                # A broken framing peer is closed, rather than interpreting
                # the remaining bytes as a new command.
                reply({'ok':False,'error':'Request exceeds bounded protocol size'});break
            try:
                request=json.loads(line)
                with contextlib.redirect_stdout(sys.stderr):result=handle_request(service,request)
                reply({'ok':True,'result':result})
                if request.get('op')=='close':break
            except Exception as exc:
                # Malformed input cannot leave an authoritative prior result.
                # Closing the stream forces the bridge to discard its session.
                reply({'ok':False,'error':str(exc)});break
    finally:service.close()

if __name__=='__main__':main()
