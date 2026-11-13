"""Local crop suggestions for human review; never writes accepted labels."""
import argparse
import base64
import contextlib
import hashlib
import json
from pathlib import Path
import sys

import cv2
import numpy as np

from collector_frame_policy import _category
from ocr_output import canonicalize_output
from portable_ocr import PortableModel, decode_ctc, normalize_crop
from schemas import valid, CONTRACT, CONTRACT_SHA256


def load_models(release, device):
    config = json.loads((release / 'runtime.json').read_text())
    freeze = json.loads((release / 'freeze.json').read_text())
    models = {}
    for role, key in [('general', 'general_model'), ('names', 'name_model')]:
        folder = release / config[key]
        for filename, expected in [('model.onnx', freeze['weights'][role]),
                                   ('characters.json', freeze['characters_sha256'][role])]:
            if hashlib.sha256((folder / filename).read_bytes()).hexdigest() != expected:
                raise ValueError(f'Pinned {role} {filename} differs from release')
        models[role] = PortableModel(folder, device=device)
    return models, freeze


def crop_geometry(raw):
    if not raw or len(raw) > 16 * 1024 * 1024:
        raise ValueError('Crop exceeds input limit')
    # Read geometry before decoding an untrusted compressed allocation.
    if len(raw) < 24 or raw[:8] != b'\x89PNG\r\n\x1a\n' or raw[12:16] != b'IHDR':
        raise ValueError('Expected PNG crop')
    width, height = int.from_bytes(raw[16:20], 'big'), int.from_bytes(raw[20:24], 'big')
    if not 0 < width <= 16384 or not 0 < height <= 4096 or width * height > 8_000_000:
        raise ValueError('Unsupported crop dimensions')
    return width, height


def decode_crop(raw, region_id):
    category = _category(region_id)
    if category is None or 'nameplate' in region_id:
        raise ValueError('Unsupported OCR region')
    width, height = crop_geometry(raw)
    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if image is None or image.shape != (height, width, 3):
        raise ValueError('Cannot decode crop')
    return image, category


def prediction_for(freeze, raw, image, category, original, confidence):
    height, width = image.shape[:2]
    role = 'names' if category == 'name' else 'general'
    text = canonicalize_output(original, category)
    return {'raw_text': original, 'text': text, 'confidence': confidence,
            'validation_contract': {'version': CONTRACT['version'], 'sha256': CONTRACT_SHA256},
            'schema_valid': (not original and not text) or (bool(text) and valid({'category': category, 'label': text})),
            'model_id': role + ':' + freeze['weights'][role][:12],
            'model_sha256': freeze['weights'][role], 'category': category,
            'image_sha256': hashlib.sha256(raw).hexdigest(),
            'pixel_sha256': hashlib.sha256(f'{width}x{height}:RGB:'.encode() + cv2.cvtColor(image, cv2.COLOR_BGR2RGB).tobytes()).hexdigest(),
            'input_profile': 'raw', 'suggestion_only': True}



def suggest(models, freeze, raw, region_id):
    image, category = decode_crop(raw, region_id)
    role = 'names' if category == 'name' else 'general'
    model = models[role]
    original, confidence = decode_ctc(model.probabilities(image), model.characters)
    return prediction_for(freeze, raw, image, category, original, confidence)


def suggest_many(models, freeze, items, batch_size=8, stats=None):
    """Group bounded, same-padding crops by model while preserving item order.

    Flat crops keep the single-image recognizer's exact blank shortcut. Mixed
    geometry never shares a tensor, so batching cannot alter resize/padding.
    """
    if not isinstance(items, list) or not 1 <= len(items) <= 192:
        raise ValueError('Expected 1..192 crops')
    if not 1 <= batch_size <= 8 or sum(len(raw) for raw, _ in items) > 16 * 1024 * 1024:
        raise ValueError('Batch exceeds input limit')
    # Bound the whole decompressed allocation before decoding any crop.
    if sum(width * height for width, height in (crop_geometry(raw) for raw, _ in items)) > 16_000_000:
        raise ValueError('Batch exceeds pixel limit')
    prepared = [decode_crop(raw, region_id) for raw, region_id in items]
    outputs = [None] * len(items)
    groups = {}
    calls = 0
    for index, (image, category) in enumerate(prepared):
        role = 'names' if category == 'name' else 'general'
        if np.all(image == image[0, 0]) or batch_size == 1:
            model = models[role]
            text, confidence = decode_ctc(model.probabilities(image), model.characters)
            outputs[index] = prediction_for(freeze, items[index][0], image, category, text, confidence)
            calls += 1
        else:
            shape = normalize_crop(image).shape
            groups.setdefault((role, shape), []).append(index)
    for (role, _), indices in groups.items():
        model = models[role]
        for offset in range(0, len(indices), batch_size):
            chunk = indices[offset:offset + batch_size]
            if len(chunk) == 1:
                probabilities = model.probabilities(prepared[chunk[0]][0])
            else:
                probabilities = model.probabilities_many([prepared[index][0] for index in chunk])
            calls += 1
            for batch_index, index in enumerate(chunk):
                image, category = prepared[index]
                text, confidence = decode_ctc(probabilities[batch_index:batch_index + 1], model.characters)
                outputs[index] = prediction_for(freeze, items[index][0], image, category, text, confidence)
    if stats is not None:
        stats.update(model_calls=calls, crop_count=len(items), batch_size=batch_size)
    return outputs

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--device', default='gpu:0', choices=['gpu:0', 'cpu'])
    parser.add_argument('--batch-size', type=int, default=1, choices=range(1, 9))
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        models, freeze = load_models(args.release.resolve(), args.device)
    def reply(value):
        print(json.dumps(value, allow_nan=False), flush=True)
    reply({'ready': True, 'device': args.device, 'weights': freeze['weights']})
    while True:
        line = sys.stdin.buffer.readline(24 * 1024 * 1024 + 1)
        if not line:
            break
        if len(line) > 24 * 1024 * 1024:
            reply({'ok': False, 'error': 'Request too large'})
            break
        try:
            request = json.loads(line)
            if 'items' in request:
                items = request['items']
                if not isinstance(items, list) or not 1 <= len(items) <= 192:
                    raise ValueError('Expected 1..192 crops')
                decoded = [(base64.b64decode(item['png_base64'], validate=True), item['region_id']) for item in items]
                stats = {}
                with contextlib.redirect_stdout(sys.stderr):
                    predictions = suggest_many(models, freeze, decoded, args.batch_size, stats)
                reply({'ok': True, 'predictions': predictions, 'stats': stats})
            else:
                raw = base64.b64decode(request['png_base64'], validate=True)
                with contextlib.redirect_stdout(sys.stderr):
                    prediction = suggest(models, freeze, raw, request['region_id'])
                reply({'ok': True, 'prediction': prediction})
        except Exception as exc:
            reply({'ok': False, 'error': str(exc)})


if __name__ == '__main__':
    main()
