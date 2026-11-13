#!/usr/bin/env python3
"""Capture an independent, unlabelled Wayland session for blind OCR evaluation."""
import argparse
import contextlib
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

import cv2
import numpy as np

from realtime_collector import RealtimeCollector


def digest(data):
    return hashlib.sha256(data).hexdigest()


def png_geometry(raw):
    if len(raw) < 24 or raw[:8] != b'\x89PNG\r\n\x1a\n' or raw[12:16] != b'IHDR':
        raise ValueError('Capture is not a PNG')
    return int.from_bytes(raw[16:20], 'big'), int.from_bytes(raw[20:24], 'big')


def region_index(node, prefix=''):
    """Index all configured rectangles, including inactive seats and negatives."""
    if isinstance(node, dict):
        if all(k in node for k in ('x', 'y', 'w', 'h')):
            yield {'region_id': prefix, 'rect': {k: node[k] for k in ('x', 'y', 'w', 'h')}}
        else:
            for key, value in node.items():
                yield from region_index(value, f'{prefix}.{key}' if prefix else key)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from region_index(value, f'{prefix}[{index}]')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--output', required=True, help='Confirmed Wayland output name')
    parser.add_argument('--destination', type=Path, required=True)
    parser.add_argument('--frames', type=int, default=120)
    parser.add_argument('--period', type=float, default=.5)
    args = parser.parse_args()
    if args.frames < 1 or not math.isfinite(args.period) or not .5 <= args.period <= 1:
        parser.error('frames must be positive and period must be between 0.5 and 1 seconds')
    root = args.release.resolve()
    config_raw = (root / 'runtime.json').read_bytes()
    config = json.loads(config_raw)
    def path(key):
        value = Path(config[key])
        return value if value.is_absolute() else root / value
    regions_raw, colors_raw = path('regions').read_bytes(), path('colors').read_bytes()
    regions, colors = json.loads(regions_raw), json.loads(colors_raw)
    freeze_raw = (root / 'freeze.json').read_bytes()
    # Exclusive directory creation prevents overwriting an existing session.
    args.destination.mkdir(parents=False, exist_ok=False)
    dest = args.destination
    (dest / 'frames').mkdir()
    (dest / 'private').mkdir(mode=0o700)
    (dest / 'regions.json').write_bytes(regions_raw)
    (dest / 'crop-index.json').write_text(json.dumps(list(region_index(regions)), indent=2) + '\n')
    (dest / 'README.md').write_text('''# Fresh holdout: accuracy unreviewed\n\nThese are actual captures, not an accuracy result. Holdout data must never be used for training.\nReview the original full-frame pixels and the rectangles in crop-index.json and record ground truth before opening private predictions or logs. Include negatives, unreadable and absent regions; do not infer truth from the model. Do not propagate labels between frames except for exactly identical target crop pixels with the same OCR category and admission semantics, and record identity hashes and provenance for each propagation. A dealer D inside a CARD target remains a negative rank example; a neighboring glyph is not automatically the target text. Record readability and region admission separately; inactive is not a synonym for blank. Nameplate rectangles are context, not OCR targets. Compare and report pixel overlap with prior training data before scoring. Keep the original monotonic capture timestamps; never restamp them. Predictions can be dropped or stale under the bounded live policy, so report coverage as well as accuracy after review.\n''')
    session = str(uuid.uuid4())
    metadata = {'session_id': session, 'scope': 'actual_capture_accuracy_unreviewed', 'output': args.output,
                'clock': 'Linux CLOCK_MONOTONIC (seconds)', 'requested_frames': args.frames, 'period_seconds': args.period,
                'final_publication_drain_seconds': 1.1,
                'release': str(root), 'runtime_sha256': digest(config_raw), 'regions_sha256': digest(regions_raw),
                'colors_sha256': digest(colors_raw), 'freeze_sha256': digest(freeze_raw), 'freeze': json.loads(freeze_raw)}
    (dest / 'manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
    service = None
    stop = threading.Event()
    poller = None
    stack = contextlib.ExitStack()
    try:
        # Native/runtime diagnostics and predictions stay outside the blind review area.
        with contextlib.nullcontext():
            log = stack.enter_context((dest / 'private' / 'runtime.log').open('w'))
            predictions = stack.enter_context((dest / 'private' / 'predictions.jsonl').open('w'))
            manifest = stack.enter_context((dest / 'captures.jsonl').open('w'))
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                service = RealtimeCollector(path('general_model'), regions, colors, name_model_dir=path('name_model'), frozen_path=root / 'freeze.json')
            def poll():
                while not stop.wait(.1):
                    try:
                        result = service.get_latest()
                        predictions.write(json.dumps({'polled_at_monotonic': time.monotonic(), 'result': result}, allow_nan=False) + '\n')
                        predictions.flush()
                    except Exception as exc:
                        log.write(f'Polling failed: {type(exc).__name__}\n'); log.flush()
                        return
            poller = threading.Thread(target=poll, daemon=True)
            poller.start()
            start = time.monotonic()
            for index in range(args.frames):
                deadline = start + index * args.period
                delay = deadline - time.monotonic()
                if delay > 0: time.sleep(delay)
                captured_at = time.monotonic()  # Before invoking grim, never receipt time.
                wall = datetime.datetime.now(datetime.timezone.utc).isoformat()
                raw = subprocess.run(['grim', '-o', args.output, '-t', 'png', '-l', '1', '-'], stdout=subprocess.PIPE, stderr=log, timeout=3, check=True).stdout
                width, height = png_geometry(raw)
                if (width, height) != (regions['screen_width'], regions['screen_height']):
                    raise ValueError('Capture geometry differs from pinned release')
                image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
                if image is None or image.shape != (height, width, 3): raise ValueError('PNG decoding failed')
                source_id = f'{session}-{index:06d}'
                filename = f'frames/{index:06d}.png'
                (dest / filename).write_bytes(raw)
                row = {'source_id': source_id, 'file': filename, 'sha256': digest(raw), 'captured_at_monotonic': captured_at,
                       'captured_at_utc': wall, 'scheduled_at_monotonic': deadline, 'width': width, 'height': height}
                manifest.write(json.dumps(row, allow_nan=False) + '\n'); manifest.flush(); os.fsync(manifest.fileno())
                try:
                    service.submit_frame(image, source_id, captured_at)
                except Exception as exc:
                    log.write(f'Submission failed for frame {index}: {type(exc).__name__}\n'); log.flush()
                print(f'Captured {index + 1}/{args.frames}; elapsed {time.monotonic() - start:.1f}s', flush=True)
            # Keep observing through the last capture's one-second freshness
            # window. Otherwise shutdown drops its publication from the evidence
            # even when inference finishes normally just after submission.
            stop.wait(metadata['final_publication_drain_seconds'])
    finally:
        stop.set()
        if poller is not None: poller.join()
        if service is not None: service.close()
        stack.close()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('Interrupted; completed captures remain in the destination.', file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print(f'Capture stopped ({type(exc).__name__}); completed captures remain in the destination.', file=sys.stderr)
        sys.exit(1)
