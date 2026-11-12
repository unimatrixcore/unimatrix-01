"""Pure frame admission policy based on the collector's capture traversal."""
import re
import numpy as np
from schemas import valid, category_for_region
from seat_admission import assess_seats


def _category(rid):
    return category_for_region(rid)

def plan_frame_regions(frame_bgr, regions_config, colors_config, game_id_decision):
    result = {'accepted_frame': False, 'active_seats': [], 'name_eligible_seats': [], 'regions': [], 'rejected': []}
    def reject(rid, reason): result['rejected'].append({'region_id': rid, 'reason': reason})
    def fail(reason):
        reject('', reason)
        return result
    if not isinstance(frame_bgr, np.ndarray) or frame_bgr.dtype != np.uint8 or frame_bgr.ndim != 3 or frame_bgr.shape[2] != 3 or not frame_bgr.size:
        return fail('invalid_frame')
    if not isinstance(regions_config, dict): return fail('invalid_config')
    height, width = frame_bgr.shape[:2]
    if type(regions_config.get('screen_width')) is not int or type(regions_config.get('screen_height')) is not int or (width, height) != (regions_config['screen_width'], regions_config['screen_height']):
        return fail('screen_dimensions_mismatch')
    state = game_id_decision.get('state') if isinstance(game_id_decision, dict) else getattr(game_id_decision, 'state', None)
    text = game_id_decision.get('text') if isinstance(game_id_decision, dict) else getattr(game_id_decision, 'text', None)
    if state != 'text' or not isinstance(text, str) or not valid({'category':'round_id','label':text}): return fail('invalid_game_id')
    def rect(node):
        if not isinstance(node, dict) or any(type(node.get(k)) is not int for k in ('x','y','w','h')): return False
        x,y,w,h = (node[k] for k in ('x','y','w','h'))
        return x >= 0 and y >= 0 and w > 0 and h > 0 and x+w <= width and y+h <= height
    if not rect(regions_config.get('round_id')):return fail('invalid_round_id_geometry')
    try:
        colors = [colors_config[k] for k in ('nameplate','in_turn','in_turn_urgent')]
        if any(not isinstance(c,str) or not re.fullmatch(r'#[0-9a-fA-F]{6}',c) for c in colors): raise ValueError()
    except (KeyError, TypeError, ValueError): return fail('invalid_colors')
    seats = regions_config.get('seats', [])
    if not isinstance(seats, list): return fail('invalid_seats')
    for i, seat in enumerate(seats):
        if not seat: continue
        if not isinstance(seat, dict): return fail('invalid_seat')
        plate = seat.get('nameplate')
        if plate:
            if not rect(plate):
                reject(f'seats[{i}].nameplate', 'invalid_geometry')
                return result
    # Validate legacy geometry first so malformed configuration keeps its precise
    # rejection cause. The verified pixel helper then proves a bounded plate,
    # rather than allowing a small matching fragment to admit a folded seat.
    admission = assess_seats(frame_bgr, regions_config, colors_config)
    if not admission['valid_input']:
        return fail(admission['reason'])
    if not admission['frame_eligible']:
        return fail('no_verified_active_seats')
    result['active_seats'] = admission['active_seats']
    result['name_eligible_seats'] = admission['name_eligible_seats']
    def walk(rid, node):
        if any(re.search(p, rid) for p in ('nameplate','screen_width','screen_height','note')): return
        seat = re.search(r'seats\[(\d+)\]', rid)
        if seat and int(seat.group(1)) not in result['active_seats'] and not (rid.endswith('.bet') or rid == f'seats[{seat.group(1)}]'):
            return
        if isinstance(node, dict) and any(k in node for k in ('x','y','w','h')):
            if not rect(node): reject(rid, 'invalid_geometry'); return
            category = _category(rid)
            if category is None: reject(rid, 'unknown_category'); return
            # A result marker replaces only the username. A proven active
            # plate still admits its bank/cards and other ordinary fields.
            if category == 'name' and seat and int(seat.group(1)) not in result['name_eligible_seats']:
                return
            result['regions'].append({'region_id': rid, 'category': category, 'rect': {k: node[k] for k in ('x','y','w','h')}})
        elif isinstance(node, dict):
            for k,v in node.items(): walk(f'{rid}.{k}' if rid else k, v)
        elif isinstance(node, list):
            for i,v in enumerate(node): walk(f'{rid}[{i}]' if rid else str(i), v)
    walk('', regions_config)
    result['accepted_frame'] = True
    return result
