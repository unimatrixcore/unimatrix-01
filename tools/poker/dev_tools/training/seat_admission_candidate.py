"""Experimental pixel-only plate admission; deliberately not wired into runtime.

Configured colors describe the rendered background hue, not an exact screenshot
byte value. A bounded brightness projection tolerates rendering differences while
requiring a broad connected background field. The caller must still validate the
frame/game ID and configuration epoch before using these seat decisions.
"""
from collections import deque
import re
import numpy as np


_COLOR_KEYS = ('nameplate', 'in_turn', 'in_turn_urgent')


def _rect(node, width, height):
    if not isinstance(node, dict) or any(type(node.get(k)) is not int for k in ('x', 'y', 'w', 'h')):
        return False
    x, y, w, h = (node[k] for k in ('x', 'y', 'w', 'h'))
    return x >= 0 and y >= 0 and w >= 24 and h >= 12 and x + w <= width and y + h <= height


def _crop(frame, rect):
    x, y, w, h = (rect[k] for k in ('x', 'y', 'w', 'h'))
    return frame[y:y+h, x:x+w]


def _connected_field(mask):
    """Pool small cells to bridge glyph holes, then require 2-D connected support.

    Global density alone lets an avatar, a card corner, or timer strip admit a
    folded seat. Cells cannot create support: raw pixel density is also checked.
    Mixing palette hues is intentional because countdowns reveal normal plate
    background as the turn-colored portion shrinks.
    """
    rows, cols = 6, 12
    cells = np.zeros((rows, cols), dtype=bool)
    for row, yy in enumerate(np.array_split(np.arange(mask.shape[0]), rows)):
        for col, xx in enumerate(np.array_split(np.arange(mask.shape[1]), cols)):
            cells[row, col] = mask[np.ix_(yy, xx)].mean() >= .40
    remaining = set(zip(*np.nonzero(cells)))
    best = {'cells': 0, 'width': 0, 'height': 0}
    while remaining:
        seed = remaining.pop()
        todo, component = deque([seed]), [seed]
        while todo:
            y, x = todo.popleft()
            for other in ((y-1, x), (y+1, x), (y, x-1), (y, x+1)):
                if other in remaining:
                    remaining.remove(other)
                    component.append(other)
                    todo.append(other)
        if len(component) > best['cells']:
            yy, xx = zip(*component)
            best = {'cells': len(component), 'width': int(max(xx)-min(xx)+1), 'height': int(max(yy)-min(yy)+1)}
    density = float(mask.mean())
    supported_columns = float((mask.mean(axis=0) >= .40).mean())
    supported_rows = float((mask.mean(axis=1) >= .40).mean())
    passes = (density >= .45 and supported_columns >= .70 and supported_rows >= .55
              and best['cells'] >= 36 and best['width'] >= 9 and best['height'] >= 4)
    return bool(passes), {'density': density, 'supported_columns': supported_columns,
                          'supported_rows': supported_rows, 'component': best}


def _palette_masks(pixels, targets):
    pixels = pixels.astype(np.float32)
    scale = np.clip((pixels[:, :, None, :] * targets).sum(axis=3) / (targets*targets).sum(axis=1), .95, 1.10)
    return (np.abs(pixels[:, :, None, :] - scale[:, :, :, None]*targets) <= 5).all(axis=3)


def _bounded_plate(frame, plate, targets):
    """A plate-colored settings panel must not masquerade as multiple seats.

    Compare narrow collars just outside the configured plate. An opposing pair
    filled with the same palette indicates a field extending beyond this plate,
    rather than the bounded rounded rectangle for which it was calibrated.
    """
    x, y, w, h = (plate[k] for k in ('x', 'y', 'w', 'h'))
    pad = max(3, round(min(w, h) * .04))
    height, width = frame.shape[:2]
    rects = {'top': (x, max(0, y-pad), w, min(pad, y)),
             'bottom': (x, y+h, w, min(pad, height-y-h)),
             'left': (max(0, x-pad), y, min(pad, x), h),
             'right': (x+w, y, min(pad, width-x-w), h)}
    fractions = {}
    for key, (xx, yy, ww, hh) in rects.items():
        if not ww or not hh:
            return False, {'reason': 'plate_boundary_outside_frame'}
        fractions[key] = float(_palette_masks(frame[yy:yy+hh, xx:xx+ww], targets).any(axis=2).mean())
    oversized = ((fractions['top'] >= .60 and fractions['bottom'] >= .60)
                 or (fractions['left'] >= .60 and fractions['right'] >= .60))
    return not oversized, fractions


def _name_style(pixels):
    """Reject a green result marker without recognizing or banning any word.

    A gray username literally spelled Winner remains eligible. The source's
    bright green result text occupies the name field instead of the username.
    Missing normal foreground is unknown, including unsupported colored styles.
    This is a field decision: result markers do not deactivate bank/cards.
    """
    rgb = pixels[:, :, ::-1].astype(np.int16)
    red, green, blue = (rgb[:, :, i] for i in range(3))
    green_marker = (green >= 140) & (green-red >= 60) & (green-blue >= 60) & (red <= 110) & (blue <= 110)
    neutral = (rgb.min(axis=2) >= 115) & ((rgb.max(axis=2)-rgb.min(axis=2)) <= 70)
    marker_count = int(green_marker.sum())
    yy, xx = np.nonzero(green_marker)
    marker_geometry = (marker_count >= max(12, .012 * green_marker.size)
                       and np.ptp(xx) >= .12 * pixels.shape[1]
                       and np.ptp(yy) >= .15 * pixels.shape[0]) if marker_count else False
    evidence = {'green_fraction': float(green_marker.mean()), 'neutral_fraction': float(neutral.mean())}
    if marker_geometry:
        return False, 'colored_result_marker', evidence
    neutral_count = int(neutral.sum())
    yy, xx = np.nonzero(neutral)
    # A single narrow glyph (i, I, l, 1) can be a legitimate username.
    # Require a small glyph-sized support instead of a whole-ROI percentage.
    neutral_geometry = (neutral_count >= 12 and np.ptp(xx) >= 1
                        and np.ptp(yy) >= max(5, .15 * pixels.shape[0])) if neutral_count else False
    if not neutral_geometry:
        return False, 'normal_name_foreground_unproven', evidence
    return True, 'normal_name_style', evidence


def assess_seats(frame_bgr, regions_config, colors_config):
    """Return tri-state seat evidence plus independent name-field eligibility.

    Inputs contain pixels/geometry/palette only. Unknown seats fail closed through
    ``active_seats``; diagnostic output makes abstention explicit. No OCR, model
    predictions, temporal state, source identity, or visual truth is consulted.
    """
    result = {'valid_input': False, 'frame_eligible': False, 'active_seats': [], 'name_eligible_seats': [], 'seats': [], 'reason': ''}
    def fail(reason):
        result['reason'] = reason
        return result
    if (not isinstance(frame_bgr, np.ndarray) or frame_bgr.dtype != np.uint8
            or frame_bgr.ndim != 3 or frame_bgr.shape[2] != 3 or not frame_bgr.size):
        return fail('invalid_frame')
    height, width = frame_bgr.shape[:2]
    if (not isinstance(regions_config, dict)
            or any(type(regions_config.get(key)) is not int for key in ('screen_width', 'screen_height'))
            or (regions_config.get('screen_width'), regions_config.get('screen_height')) != (width, height)):
        return fail('screen_dimensions_mismatch')
    try:
        colors = [colors_config[key] for key in _COLOR_KEYS]
        if any(not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color) for color in colors):
            return fail('invalid_colors')
        targets = np.array([[int(color[i:i+2], 16) for i in (5, 3, 1)] for color in colors], dtype=np.float32)
        if np.any((targets * targets).sum(axis=1) == 0):
            return fail('invalid_colors')
    except (KeyError, TypeError, ValueError):
        return fail('invalid_colors')
    seats = regions_config.get('seats')
    if not isinstance(seats, list):
        return fail('invalid_seats')
    for index, seat in enumerate(seats):
        decision = {'seat': index, 'state': 'unknown', 'name_eligible': False, 'reason': 'invalid_plate_geometry'}
        result['seats'].append(decision)
        if not isinstance(seat, dict) or not _rect(seat.get('nameplate'), width, height):
            continue
        pixels = _crop(frame_bgr, seat['nameplate'])
        # Bounded brightness adaptation tolerates rendering, not arbitrary dimming.
        masks = _palette_masks(pixels, targets)
        mask = masks.any(axis=2)
        active, evidence = _connected_field(mask)
        bounded, boundary = _bounded_plate(frame_bgr, seat['nameplate'], targets)
        evidence['outside_collars'] = boundary
        active = active and bounded
        decision.update(evidence=evidence, palette_densities={key: float(masks[:, :, i].mean()) for i, key in enumerate(_COLOR_KEYS)})
        decision.update(state='active' if active else ('unknown' if mask.mean() >= .02 else 'inactive'),
                        reason='connected_plate_background' if active else ('oversized_palette_field' if not bounded else 'plate_background_unproven'))
        if not active:
            continue
        result['active_seats'].append(index)
        name = seat.get('name')
        if not _rect(name, width, height):
            decision['name_reason'] = 'invalid_name_geometry'
            continue
        plate = seat['nameplate']
        if not (plate['x'] <= name['x'] and plate['y'] <= name['y']
                and name['x']+name['w'] <= plate['x']+plate['w']
                and name['y']+name['h'] <= plate['y']+plate['h']):
            decision['name_reason'] = 'name_outside_plate'
            continue
        eligible, reason, evidence = _name_style(_crop(frame_bgr, name))
        decision.update(name_eligible=eligible, name_reason=reason, name_evidence=evidence)
        if eligible:
            result['name_eligible_seats'].append(index)
    # A zero-plate image provides no visual evidence of a readable table.
    # This is an additional necessary condition, never a replacement game-ID gate.
    result.update(valid_input=True, frame_eligible=bool(result['active_seats']), reason='pixel_candidate_only')
    return result
