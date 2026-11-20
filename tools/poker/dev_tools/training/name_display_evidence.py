"""Verify literal CSS-ellipsis references against frozen source screenshots."""
import hashlib
from io import BytesIO
import math
from pathlib import Path
import re

from PIL import Image, ImageChops


def _box(value):
    if not isinstance(value, dict):
        raise ValueError('Name display evidence requires rectangle objects')
    result = tuple(value.get(key) for key in ('x', 'y', 'w', 'h'))
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in result):
        raise ValueError('Name display rectangle must be finite')
    if min(result[:2]) < 0 or min(result[2:]) <= 0:
        raise ValueError('Name display rectangle is empty or outside the viewport')
    return result


def _contains(outer, inner):
    x, y, w, h = outer
    a, b, c, d = inner
    return a >= x - .01 and b >= y - .01 and a + c <= x + w + .01 and b + d <= y + h + .01


def verify_name_display(image, rect, proof, label, directory, capture_sha256, source_username, cache=None):
    if (not isinstance(proof, dict) or type(proof.get('schema_version')) is not int
            or proof['schema_version'] != 1 or proof.get('policy') != 'css_ellipsis_literal_reference_v1'):
        raise ValueError('Unsupported name display evidence')
    source = proof.get('source_username')
    prefix = proof.get('visible_prefix')
    if (not isinstance(source, str) or not re.fullmatch(r'[A-Za-z0-9]{1,24}', source)
            or source != source_username or not isinstance(prefix, str) or not prefix
            or not source.startswith(prefix) or len(prefix) >= len(source)
            or proof.get('rendered_text') != prefix + '…'
            or proof.get('recognition_target') != label or label != prefix + '...'
            or proof.get('normalization') != 'unicode_ellipsis_to_three_periods'
            or proof.get('source_capture_sha256') != capture_sha256 or proof.get('crop_rect') != rect):
        raise ValueError('Name display evidence differs from its source or visible target')
    literal = proof.get('literal_reference')
    required = dict(text=prefix + '…', text_overflow='clip', overflow_x='visible',
                    white_space='nowrap', direction='ltr', text_align='left', fully_visible=True,
                    physical_clipping_excluded=True, overlays_excluded=True,
                    ink_fully_visible=True, ancestor_clipping_disabled=True)
    if (not isinstance(literal, dict) or any(literal.get(key) != value for key, value in required.items())
            or any(type(literal.get(key)) is not bool for key in
                   ('fully_visible', 'physical_clipping_excluded', 'overlays_excluded',
                    'ink_fully_visible', 'ancestor_clipping_disabled'))):
        raise ValueError('Name display reference must render an unclipped literal')
    crop_box = _box(rect)
    element = _box(literal.get('element_rect'))
    content = _box(literal.get('content_rect'))
    viewport = (0, 0, image.width, image.height)
    glyphs = literal.get('glyph_rects')
    if (not _contains(viewport, crop_box) or not _contains(crop_box, element)
            or not _contains(element, content) or not isinstance(glyphs, list)
            or len(glyphs) != len(prefix) + 1):
        raise ValueError('Name display reference geometry differs from its full literal')
    glyph_boxes = [_box(glyph) for glyph in glyphs]
    if any(not _contains(crop_box, glyph) for glyph in glyph_boxes):
        raise ValueError('Name display reference glyph is clipped')
    root = Path(directory).resolve()
    files = []
    for filename_key, hash_key in [('reference_screenshot', 'reference_capture_sha256'),
                                  ('blank_reference_screenshot', 'blank_reference_capture_sha256')]:
        filename = proof.get(filename_key)
        if not isinstance(filename, str) or Path(filename).is_absolute():
            raise ValueError('Name display reference requires a relative path')
        path = (root / filename).resolve()
        if not path.is_relative_to(root) or path.is_symlink():
            raise ValueError('Name display reference escapes its collection')
        files.append((path, proof.get(hash_key)))
    cache = {} if cache is None else cache
    key = tuple((str(path), sha) for path, sha in files)
    if cache.get('key') != key:
        references = []
        for path, sha in files:
            raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != sha:
                raise ValueError('Name display reference screenshot hash differs')
            with Image.open(BytesIO(raw)) as decoded:
                if decoded.format != 'PNG' or decoded.size != image.size:
                    raise ValueError('Name display reference viewport differs')
                references.append(decoded.convert('RGB'))
        cache.clear()
        cache.update(key=key, image=references[0], blank=references[1],
                     ink_bounds=ImageChops.difference(references[0], references[1]).getbbox())
    ink_bounds = cache['ink_bounds']
    if ink_bounds and not _contains(crop_box, (ink_bounds[0], ink_bounds[1],
                                             ink_bounds[2] - ink_bounds[0], ink_bounds[3] - ink_bounds[1])):
        raise ValueError('Name display literal ink extends outside the crop')
    x, y, w, h = (rect[key] for key in ('x', 'y', 'w', 'h'))
    source_crop = image.crop((x, y, x + w, y + h)).convert('RGB').tobytes()
    reference_crop = cache['image'].crop((x, y, x + w, y + h)).tobytes()
    expected = hashlib.sha256(f'{w}x{h}:RGB:'.encode() + source_crop).hexdigest()
    if source_crop != reference_crop or proof.get('crop_rgb_sha256') != expected:
        raise ValueError('Name display literal pixels differ from the source crop')
    blank = cache['blank'].crop((x, y, x + w, y + h)).tobytes()
    ink = 0
    for index in range(w * h):
        offset = index * 3
        if reference_crop[offset:offset + 3] == blank[offset:offset + 3]:
            continue
        ink += 1
        px, py = x + index % w, y + index // w
        if not _contains(content, (px, py, 1, 1)) or not any(
                math.floor(gx) <= px < math.ceil(gx + gw) and math.floor(gy) <= py < math.ceil(gy + gh)
                for gx, gy, gw, gh in glyph_boxes):
            raise ValueError('Name display literal ink is clipped or exceeds its glyph bounds')
    if not ink:
        raise ValueError('Name display literal reference contains no visible ink')
    return dict(name_display_verified=True, source_username=source, recognition_target=label,
                reference_capture_sha256=proof['reference_capture_sha256'])
