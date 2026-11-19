import hashlib
from io import BytesIO
from pathlib import Path
import re

from PIL import Image


POLICY = 'visible_runs_v1'
NEUTRAL = (15, 33, 46)


def pixel_hash(image):
    image = image.convert('RGB')
    return hashlib.sha256(f'{image.width}x{image.height}:RGB:'.encode() + image.tobytes()).hexdigest()


def rectangle(value, *, allow_empty=False):
    if not isinstance(value, dict) or any(type(value.get(k)) is not int for k in ('x', 'y', 'w', 'h')):
        raise ValueError('Visible-run rectangles require integer pixels')
    if min(value['x'], value['y']) < 0 or min(value['w'], value['h']) < (0 if allow_empty else 1):
        raise ValueError('Invalid visible-run rectangle')
    return value['x'], value['y'], value['w'], value['h']


def coverage(value, width, height):
    if width * height > 4_000_000 or not isinstance(value, list) or len(value) > width * height:
        raise ValueError('Visible-run mask exceeds its bounds')
    samples = bytearray()
    for pair in value:
        if (not isinstance(pair, (list, tuple)) or len(pair) != 2
                or any(type(n) is not int for n in pair)
                or not 0 <= pair[0] <= 16 or not 1 <= pair[1] <= width * height - len(samples)):
            raise ValueError('Invalid visible-run coverage encoding')
        samples.extend(bytes([pair[0]]) * pair[1])
    if len(samples) != width * height:
        raise ValueError('Visible-run mask size differs from its crop')
    return samples


def render_visible_run(source, evidence):
    if (not isinstance(evidence, dict) or evidence.get('policy') != POLICY
            or evidence.get('neutral_rgb') not in (list(NEUTRAL), NEUTRAL)):
        raise ValueError('Unsupported visible-run rendering policy')
    source = source.convert('RGB')
    samples = coverage(evidence.get('coverage_rle'), source.width, source.height)
    raw = source.tobytes()
    pixels = bytearray(len(raw))
    for index, sample in enumerate(samples):
        for channel, neutral in enumerate(NEUTRAL):
            offset = index * 3 + channel
            pixels[offset] = (raw[offset] * sample + neutral * (16 - sample) + 8) // 16
    result = Image.frombytes('RGB', source.size, bytes(pixels))
    if pixel_hash(result) != evidence.get('pixel_sha256'):
        raise ValueError('Visible-run pixels differ from their extractor identity')
    return result


def _reference(directory, relative, expected_hash, cache):
    root = Path(directory).resolve()
    if not isinstance(relative, str) or Path(relative).is_absolute() or '..' in Path(relative).parts:
        raise ValueError('Invalid visible-run reference path')
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError('Visible-run reference escapes the collection')
    before = path.stat()
    key = (str(path), expected_hash, before.st_size, before.st_mtime_ns)
    if key in cache:
        return cache[key]
    raw = path.read_bytes()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('Visible-run reference changed while reading')
    if hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError('Visible-run reference screenshot hash differs')
    with Image.open(BytesIO(raw)) as decoded:
        if decoded.size != (1920, 1080):
            raise ValueError('Visible-run reference must be a full 1920x1080 screenshot')
        image = decoded.convert('RGB')
    if len(cache) >= 4:
        cache.pop(next(iter(cache)))
    cache[key] = image
    return image


def verify_visible_run(full, rect, evidence, label, directory, reference_cache=None):
    reference_cache = {} if reference_cache is None else reference_cache
    if (not isinstance(evidence, dict) or evidence.get('recognition_target') != label
            or not isinstance(label, str) or not label.strip()):
        raise ValueError('Visible-run target must be its nonempty observed transcript')
    if any(c in label for c in '\r\n\t'):
        raise ValueError('Unsafe visible-run transcript')
    source_label = evidence.get('source_label')
    if not isinstance(source_label, str) or not 1 <= len(source_label) <= 128:
        raise ValueError('Visible-run source label is missing')
    if any(evidence.get(k) not in ('open', 'closed', 'unknown') for k in ('left_boundary', 'right_boundary')):
        raise ValueError('Visible-run boundaries are missing')
    if not re.fullmatch('[a-f0-9]{64}', evidence.get('extractor_sha256', '')):
        raise ValueError('Visible-run extractor identity is missing')
    px, py, pw, ph = rectangle(evidence.get('parent_rect'))
    run = evidence.get('run_rect', {})
    run = {k: run.get(alias) for k, alias in [('x', 'x'), ('y', 'y'), ('w', 'width'), ('h', 'height')]}
    rx, ry, rw, rh = rectangle(run)
    if (rx + rw > pw or ry + rh > ph or px + pw > full.width or py + ph > full.height
            or rect != dict(x=px + rx, y=py + ry, w=rw, h=rh)):
        raise ValueError('Visible-run coordinates do not bind its parent')
    source = full.crop((px + rx, py + ry, px + rx + rw, py + ry + rh)).convert('RGB')
    result = render_visible_run(source, evidence)
    samples = coverage(evidence['coverage_rle'], rw, rh)
    oracle = evidence.get('oracle')
    if (not isinstance(oracle, dict) or oracle.get('policy') != 'controlled_renderer_glyph_visibility_v1'
            or oracle.get('complete_target_ink_verified') is not True
            or oracle.get('foreign_ink_removed') is not True):
        raise ValueError('Visible-run glyph evidence is missing')
    baseline = _reference(directory, oracle.get('baseline_reference_screenshot'), oracle.get('baseline_reference_sha256'), reference_cache)
    if (oracle.get('baseline_capture_sha256') != oracle.get('baseline_reference_sha256')
            or oracle.get('baseline_match_policy') != 'exact_parent_pixels_same_source_value'
            or oracle.get('baseline_source_label') != source_label):
        raise ValueError('Visible-run baseline identity differs')
    parent = full.crop((px, py, px + pw, py + ph)).convert('RGB')
    baseline_parent = baseline.crop((px, py, px + pw, py + ph))
    if (pixel_hash(parent) != oracle.get('parent_raw_pixel_sha256')
            or parent.tobytes() != baseline_parent.tobytes()):
        raise ValueError('Visible-run baseline parent pixels differ')
    reference = _reference(directory, oracle.get('reference_screenshot'), oracle.get('reference_sha256'), reference_cache)
    fx, fy, fw, fh = rectangle(oracle.get('reference_parent_rect'))
    if ((fx, fy) != (px, py) or fw < pw or fh < ph
            or fx + fw > reference.width or fy + fh > reference.height):
        raise ValueError('Visible-run reference parent differs')
    glyphs = oracle.get('glyphs')
    if not isinstance(glyphs, list) or len(glyphs) != len(source_label):
        raise ValueError('Visible-run evidence must account for every source character')
    retained = []
    allowed_ink = bytearray(rw * rh)
    for index, glyph in enumerate(glyphs):
        if (not isinstance(glyph, dict) or glyph.get('source_index') != index
                or glyph.get('character') != source_label[index] or type(glyph.get('retained')) is not bool):
            raise ValueError('Visible-run source character binding differs')
        gx, gy, gw, gh = rectangle(glyph.get('rect'), allow_empty=True)
        kept = glyph['retained']
        if kept:
            retained.append(index)
        if source_label[index].isspace():
            continue
        if gx + gw > fw or gy + gh > fh:
            raise ValueError('Visible-run glyph extends beyond its clean reference')
        ink_count = 0
        for y in range(gy, gy + gh):
            for x in range(gx, gx + gw):
                color = reference.getpixel((fx + x, fy + y))
                if min(color) < 90 or max(color) - min(color) >= 45:
                    continue
                ink_count += 1
                inside = rx <= x < rx + rw and ry <= y < ry + rh
                intact = (inside and samples[(y - ry) * rw + x - rx] == 16
                          and source.getpixel((x - rx, y - ry)) == color)
                if kept and not intact:
                    raise ValueError('Visible-run target includes hidden or damaged glyph ink')
                if kept and intact:
                    allowed_ink[(y - ry) * rw + x - rx] = 1
                if not kept and inside and source.getpixel((x - rx, y - ry)) == color and samples[(y - ry) * rw + x - rx]:
                    raise ValueError('Visible-run input retains unlabeled glyph ink')
        if kept and not source_label[index].isspace() and not ink_count:
            raise ValueError('Visible-run target has no source glyph ink')
    if not retained or any(not glyphs[i]['retained'] for i in range(retained[0], retained[-1] + 1)):
        raise ValueError('Visible-run transcript stitches across unobserved characters')
    observed = ''.join(source_label[i] for i in retained).strip()
    if observed != label:
        raise ValueError('Visible-run recognition target differs from retained source glyphs')
    raw_result = result.tobytes()
    for index in range(rw * rh):
        color = raw_result[index * 3:index * 3 + 3]
        if max(color) - min(color) > 70:
            raise ValueError('Visible-run input retains unlabelled currency artwork')
        if min(color) >= 90 and max(color) - min(color) < 45 and not allowed_ink[index]:
            raise ValueError('Visible-run input retains foreign or unlabelled text ink')
    return result


def verified_training_target(row):
    proof = row.get('synthetic_ground_truth') or {}
    return (row.get('recognition_task') == 'visible_run'
            and row.get('synthetic_evidence_valid') is True
            and proof.get('visible_run_verified') is True
            and proof.get('recognition_target') == row.get('label')
            and isinstance(row.get('label'), str) and bool(row['label'].strip())
            and not any(char in row['label'] for char in '\t\r\n'))
