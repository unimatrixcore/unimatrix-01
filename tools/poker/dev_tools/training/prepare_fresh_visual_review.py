#!/usr/bin/env python3
"""Build an unlabelled, source-pixel review pack without loading OCR or policy.

Run only after the capture owner confirms capture has finished. Source PNGs and
capture metadata are read-only; all derived files live in visual-review/.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from schemas import category_for_region


OFFSETS = ((0, 0), (-2, 0), (2, 0), (0, -2), (0, 2))
EXPECTED_CATEGORIES = {'round_id': 1, 'card': 23, 'pot': 1, 'split_pot': 1,
                       'name': 9, 'bank': 9, 'bet': 9, 'status': 9, 'dealer': 9}


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def rectangle_index(node, prefix=''):
    """Traverse geometry, including every seat, without evaluating admission."""
    if isinstance(node, dict):
        if all(key in node for key in ('x', 'y', 'w', 'h')):
            yield {'region_id': prefix, 'rect': {key: node[key] for key in ('x', 'y', 'w', 'h')}}
        else:
            for key, value in node.items():
                yield from rectangle_index(value, f'{prefix}.{key}' if prefix else key)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from rectangle_index(value, f'{prefix}[{index}]')


def verified_inputs(source, expected_frames):
    """Fail before creating outputs if provenance or the complete target set drifts."""
    metadata = json.loads((source / 'manifest.json').read_text())
    regions_raw = (source / 'regions.json').read_bytes()
    if sha256(regions_raw) != metadata['regions_sha256']:
        raise ValueError('regions.json hash mismatch')
    regions = json.loads(regions_raw)
    index = json.loads((source / 'crop-index.json').read_text())
    if index != list(rectangle_index(regions)):
        raise ValueError('crop-index.json differs from regions.json')
    context = [row for row in index if row['region_id'].endswith('.nameplate')]
    targets = [dict(row, category=category_for_region(row['region_id']))
               for row in index if not row['region_id'].endswith('.nameplate')]
    categories = {category: sum(row['category'] == category for row in targets)
                  for category in EXPECTED_CATEGORIES}
    if len(context) != 9 or len(targets) != 71 or categories != EXPECTED_CATEGORIES:
        raise ValueError('Expected exactly 71 OCR targets and 9 nameplate context rectangles')
    captures = [json.loads(line) for line in (source / 'captures.jsonl').read_text().splitlines()]
    if len(captures) != expected_frames or metadata['requested_frames'] != expected_frames:
        raise ValueError(f'Expected {expected_frames} completed captures; found {len(captures)}')
    if len({row['source_id'] for row in captures}) != len(captures):
        raise ValueError('Duplicate source capture identity')
    previous_time = None
    for frame_index, row in enumerate(captures):
        if row['file'] != f'frames/{frame_index:06d}.png':
            raise ValueError('Unexpected source filename/order')
        raw = (source / row['file']).read_bytes()
        if sha256(raw) != row['sha256']:
            raise ValueError(f'Source PNG hash mismatch: {row["file"]}')
        with Image.open(source / row['file']) as image:
            image.load()
            if image.format != 'PNG' or image.size != (row['width'], row['height']):
                raise ValueError(f'Source PNG dimensions mismatch: {row["file"]}')
        if (row['width'], row['height']) != (regions['screen_width'], regions['screen_height']):
            raise ValueError('Capture geometry differs from regions')
        timestamp = row['captured_at_monotonic']
        if previous_time is not None and timestamp <= previous_time:
            raise ValueError('Capture timestamps are not strictly increasing')
        previous_time = timestamp
    return metadata, targets, captures


def crop_identity(image, category):
    """Exact decoded RGB bytes plus dimensions and category; never similarity."""
    rgb = image.convert('RGB')
    header = json.dumps([category, rgb.width, rgb.height], separators=(',', ':')).encode()
    return header + b'\0' + rgb.tobytes()


def production_input_fingerprint(frame_rgb, rect, category):
    """Match production_reader.region_inputs(..., 'five') using BGR uint8 bytes.

    Keep this tiny pure equivalent here to avoid importing any model modules.
    The fingerprint is association evidence only, never a transcription/admission.
    """
    x, y, width, height = (rect[key] for key in ('x', 'y', 'w', 'h'))
    if any(type(rect[key]) is not int for key in ('x', 'y', 'w', 'h')) or width <= 0 or height <= 0:
        raise ValueError('invalid_geometry')
    digest = hashlib.sha256(category.encode())
    for dx, dy in OFFSETS:
        xx, yy = x + dx, y + dy
        if xx < 0 or yy < 0 or xx + width > frame_rgb.width or yy + height > frame_rgb.height:
            raise ValueError('view_out_of_bounds')
        crop = np.asarray(frame_rgb.crop((xx, yy, xx + width, yy + height)))[:, :, ::-1].copy()
        digest.update(str(crop.shape).encode())
        digest.update(crop.tobytes())
    return digest.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def write_jsonl(path, rows):
    path.write_text(''.join(json.dumps(row, allow_nan=False) + '\n' for row in rows))


def font(size=16):
    for path in ('/usr/share/fonts/TTF/DejaVuSansMono.ttf',
                 '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'):
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def crop_sheets(output, category, records, zoom):
    """Fixed integer zoom preserves all crop pixels, with metadata outside crops."""
    tile_width = max(355, max(row['width'] for row in records) * zoom + 24)
    tile_height = max(row['height'] for row in records) * zoom + 96
    columns = max(1, 1800 // tile_width)
    rows_per_page = max(1, 1900 // tile_height)
    page_size = columns * rows_per_page
    sheets = []
    for start in range(0, len(records), page_size):
        page = records[start:start + page_size]
        rows = (len(page) + columns - 1) // columns
        sheet = Image.new('RGB', (columns * tile_width, rows * tile_height + 36), '#202124')
        draw = ImageDraw.Draw(sheet)
        draw.text((10, 8), f'{category} | actual RGB crops {zoom}x | UNREVIEWED', font=font(), fill='white')
        sheet_path = f'sheets/{category}-{len(sheets):03d}.png'
        for position, record in enumerate(page):
            x, y = (position % columns) * tile_width, (position // columns) * tile_height + 36
            occurrence = record['occurrences'][0]
            lines = [record['id'] + f'  n={len(record["occurrences"])}',
                     f'f{occurrence["frame_index"]:06d} {occurrence["region_id"]}',
                     f'{occurrence["file"]} sha={occurrence["sha256"][:12]}']
            for line_index, line in enumerate(lines):
                draw.text((x + 8, y + line_index * 21), line, fill='white', font=font(14))
            with Image.open(output / record['crop_file']) as crop:
                enlarged = crop.resize((crop.width * zoom, crop.height * zoom), Image.Resampling.NEAREST)
                sheet.paste(enlarged, (x + 10, y + 70))
            record['evidence_sheet'] = sheet_path
            record['evidence_tile'] = position
            record['evidence_box'] = [x + 10, y + 70, x + 10 + record['width'] * zoom,
                                      y + 70 + record['height'] * zoom]
        sheet.save(output / sheet_path)
        sheets.append({'file': sheet_path, 'category': category,
                       'ids': [row['id'] for row in page], 'zoom': zoom})
    return sheets


def frame_sheets(source, output, captures):
    sheets, frame_rows = [], []
    width, height, tile_height = 768, 432, 502
    for start in range(0, len(captures), 6):
        page = captures[start:start + 6]
        sheet = Image.new('RGB', (1572, ((len(page) + 1) // 2) * tile_height + 40), '#202124')
        draw = ImageDraw.Draw(sheet)
        draw.text((10, 8), 'Full-frame source context | admission/layout UNREVIEWED', fill='white', font=font())
        filename = f'sheets/frames-{len(sheets):03d}.jpg'
        for position, capture in enumerate(page):
            frame_index = start + position
            x, y = (position % 2) * 786 + 8, (position // 2) * tile_height + 40
            draw.text((x, y), f'f{frame_index:06d} {capture["file"]}', fill='white', font=font())
            draw.text((x, y + 22), f'sha256 {capture["sha256"][:32]}', fill='white', font=font(14))
            with Image.open(source / capture['file']) as image:
                thumbnail = image.convert('RGB')
                thumbnail.thumbnail((width, height), Image.Resampling.LANCZOS)
                sheet.paste(thumbnail, (x, y + 48))
            frame_rows.append(dict(capture, frame_index=frame_index, evidence_sheet=filename,
                                   evidence_tile=position, admission='', layout='',
                                   readability='', visually_reviewed=False, notes=''))
        sheet.save(output / filename, quality=94, subsampling=0)
        sheets.append({'file': filename, 'category': 'full_frame',
                       'frame_indices': list(range(start, start + len(page)))})
    write_jsonl(output / 'frames.jsonl', frame_rows)
    return sheets


def build(source, expected_frames=120, zoom=3):
    source = source.resolve()
    metadata, targets, captures = verified_inputs(source, expected_frames)
    output = source / 'visual-review'
    output.mkdir(exist_ok=False)
    (output / 'crops').mkdir()
    (output / 'sheets').mkdir()
    categories = {category: [] for category in EXPECTED_CATEGORIES}
    identities = {}
    for frame_index, capture in enumerate(captures):
        with Image.open(source / capture['file']) as image:
            frame = image.convert('RGB')
        for target in targets:
            rect, category = target['rect'], target['category']
            x, y, width, height = (rect[key] for key in ('x', 'y', 'w', 'h'))
            fingerprint = production_input_fingerprint(frame, rect, category)
            crop = frame.crop((x, y, x + width, y + height))
            identity = crop_identity(crop, category)
            record = identities.get(identity)
            if record is None:
                sample_id = f'{category}-{len(categories[category]):05d}'
                record = {'id': sample_id, 'category': category, 'width': width, 'height': height,
                          'pixel_sha256': sha256(crop.tobytes()), 'identity_sha256': sha256(identity),
                          'image_path': f'crops/{sample_id}.png',
                          'crop_file': f'crops/{sample_id}.png', 'label': '', 'state': '',
                          'readability': '', 'visually_reviewed': False, 'notes': '', 'occurrences': []}
                crop.save(output / record['crop_file'])
                identities[identity] = record
                categories[category].append(record)
            record['occurrences'].append(dict(capture, frame_index=frame_index,
                occurrence_id=f'f{frame_index:06d}:{target["region_id"]}', region_id=target['region_id'],
                rect=rect, production_five_view_bgr_sha256=fingerprint,
                admission='', admission_visually_reviewed=False))
    sheets = []
    counters = {}
    for category, records in categories.items():
        sheets.extend(crop_sheets(output, category, records, zoom))
        write_jsonl(output / f'{category}.jsonl', records)
        counters[category] = {'unique_crops': len(records),
                             'occurrences': sum(len(row['occurrences']) for row in records),
                             'manifest': f'{category}.jsonl'}
    sheets.extend(frame_sheets(source, output, captures))
    inventory = {'scope': 'unlabelled_source_pixel_review_pack', 'session_id': metadata['session_id'],
                 'capture_count': len(captures), 'targets_per_frame': len(targets),
                 'excluded_nameplate_context_per_frame': 9,
                 'total_occurrences': len(captures) * len(targets),
                 'unique_crops': len(identities), 'categories': counters,
                 'contact_sheets': len(sheets), 'visually_reviewed': 0,
                 'source_captures_sha256': sha256((source / 'captures.jsonl').read_bytes()),
                 'regions_sha256': metadata['regions_sha256'],
                 'deduplication': 'Exact decoded RGB bytes plus width, height, category; no approximation.',
                 'fingerprint': 'Equivalent to production_reader.region_inputs(frame_bgr, rect, category, five).',
                 'label_propagation': 'Pending visual review; crop identity does not propagate occurrence admission.',
                 'zoom': zoom}
    write_json(output / 'inventory.json', inventory)
    write_json(output / 'contact-sheet-index.json', sheets)
    (output / 'README.md').write_text('''# Unreviewed fresh-capture visual review pack

This pack contains derived pixels and empty review fields, not ground truth.
Every source PNG was verified against captures.jsonl hash and dimensions before
output creation. Original PNGs were not modified. All 71 OCR targets per frame
are included regardless of apparent activity; 9 nameplates are context only.

Review each category manifest row using its 3x crop sheet and original crop.
Transcribe only target text; record unreadable/ambiguous/negative separately.
All frame and region occurrences remain attached to an exact RGB identity.
Inspect frames.jsonl and full-frame sheets independently for table/layout and
per-occurrence admission, opening original frames for details as needed.
Do not propagate admission from duplicate target pixels. Labels, readability,
decisions, and admission start empty; all visual review flags start false.

No predictions, private logs, OCR models, admission policy, training databases,
or inference were used to construct this pack. Holdout remains excluded from
training. contact-sheet-index.json enumerates every sheet and its IDs.
''')
    return inventory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--expected-frames', type=int, default=120)
    parser.add_argument('--zoom', type=int, choices=(2, 3), default=3)
    parser.add_argument('--capture-complete', action='store_true', required=True,
                        help='Capture owner has confirmed the capture process finished')
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.expected_frames, args.zoom), indent=2))


if __name__ == '__main__':
    main()
