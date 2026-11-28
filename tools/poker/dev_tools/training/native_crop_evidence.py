import atexit
import base64
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess

from PIL import Image, ImageChops, ImageDraw


PROTOCOL = 'native_canonical_crop_v1'
_clients = []


def native_target_quarantine(category, label, tool_sha256, profile_sha256):
    if (category == 'table_info' and label
            and tool_sha256 == '868214a3fb3d972943a982e812851580e81f6895689ad2b9ff7688d8e6791a59'
            and profile_sha256 == 'f3e05596327a81f75ca9ae28df3cd015cc1ef1e0cb050b9084d962db6c366755'):
        return {'policy': 'native_target_caption_ink_quarantine_v1',
                'reason': 'source_caption_ink_unqualified_for_native_text_line_localizer',
                'native_tool_sha256': tool_sha256, 'native_profile_sha256': profile_sha256}
    return None


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def pixel_hash(image):
    image = image.convert('RGB')
    return digest(f'{image.width}x{image.height}:RGB:'.encode() + image.tobytes())


def safe_child(root, name):
    if not isinstance(name, str) or not name or Path(name).is_absolute():
        raise ValueError('Native proof paths must be relative')
    root = Path(root).resolve()
    path = root / name
    if any(part.is_symlink() for part in [path, *path.parents] if part != root.parent):
        raise ValueError('Native proof cannot follow symbolic links')
    if not path.resolve().is_relative_to(root):
        raise ValueError('Native proof path escapes its dataset')
    return path


def source_field(region, dealer=None):
    if region == 'dealer':
        if type(dealer) is not int or not 0 <= dealer < 9:
            raise ValueError('Global dealer requires its controlled source seat')
        return f'seat.{dealer}.dealer'
    match = re.fullmatch(r'seats\[(\d)\]\.(.+)', region)
    if match:
        suffix = match[2]
        card = re.fullmatch(r'cards\[(\d)\](\.suit)?', suffix)
        if card:
            suffix = f'card.{card[1]}.' + ('suit' if card[2] else 'rank')
        return f'seat.{match[1]}.{suffix}'
    match = re.fullmatch(r'community_cards\[(\d)\](\.suit)?', region)
    if match:
        return f'board.{match[1]}.' + ('suit' if match[2] else 'rank')
    return {'round_id':'game.id', 'pot':'pot.total', 'split_pot':'pot.visible', 'pot.split':'pot.visible',
            'table_info':'table.info', 'popup':'table.popup'}.get(region, region)


def trusted_tool(expected_sha=None):
    if expected_sha is not None and not re.fullmatch(r'[a-f0-9]{64}', expected_sha):
        raise ValueError('Native tool identity must be a SHA256')
    data = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'poker'
    cache = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'poker'
    configured = os.environ.get('POKER_NATIVE_CROP_TOOL')
    paths = ([Path(configured)] if configured else [])
    if expected_sha:
        paths.append(data / 'ocr-training/native-crop-tools' / expected_sha / 'gameplay-ai')
    paths.append(cache / 'native-target/debug/examples/gameplay-ai')
    for path in paths:
        if path.is_file() and os.access(path, os.X_OK):
            found = digest(path.read_bytes())
            if expected_sha is None or found == expected_sha:
                return path.resolve(), found
    raise ValueError('Trusted native canonical crop helper is unavailable; install the matching gameplay-ai helper')


class NativeCropClient:
    def __init__(self, profile, expected_sha=None, executable=None):
        if executable is None:
            executable, self.tool_sha = trusted_tool(expected_sha)
        else:
            executable = Path(executable).resolve()
            self.tool_sha = digest(executable.read_bytes())
            if expected_sha is not None and self.tool_sha != expected_sha:
                raise ValueError('Configured native helper identity differs')
        self.profile = Path(profile).resolve()
        self.profile_sha = digest(self.profile.read_bytes())
        self.process = subprocess.Popen([str(executable), 'canonical', '--profile', str(self.profile)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.last = None
        _clients.append(self)

    def frame(self, path, expected_capture_sha, ids=None):
        identity = (str(Path(path).resolve()), expected_capture_sha, tuple(ids) if ids else None)
        if self.last and self.last[0] == identity:
            return self.last[1]
        request = {'image_path':identity[0], 'region_ids':ids}
        self.process.stdin.write(json.dumps(request) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline(64 * 1024 * 1024 + 1)
        if not line or len(line) > 64 * 1024 * 1024:
            raise ValueError('Native crop helper stopped or exceeded response limit')
        result = json.loads(line)
        if result.get('error'):
            raise ValueError('Native crop preparation failed: ' + result['error'])
        if (result.get('protocol') != PROTOCOL or result.get('profile_sha256') != self.profile_sha
                or result.get('tool_sha256') != self.tool_sha or result.get('capture_sha256') != expected_capture_sha
                or result.get('provider_calls') != 0):
            raise ValueError('Native reconstruction identity differs')
        items = result.get('items')
        if not isinstance(items, list) or len(items) > 192:
            raise ValueError('Invalid native crop inventory')
        indexed = {item['region_id']:item for item in items}
        if len(indexed) != len(items):
            raise ValueError('Duplicate native crop identity')
        self.last = identity, indexed
        return indexed

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=5)


@atexit.register
def _close_clients():
    for client in _clients:
        client.close()


def verify_name_ink(image, rect, proof, crop, display, directory, cache=None, native_name_bounds=None):
    bounds = proof['bounds']
    text = proof.get('source_text_rect')
    reference = proof.get('name_ink_reference')
    if not reference and text and (bounds['x'] > text['x'] or bounds['y'] > text['y']
                 or bounds['x'] + bounds['width'] < text['x'] + text['w']
                 or bounds['y'] + bounds['height'] < text['y'] + text['h']):
        raise ValueError('Native crop clips source text geometry')
    if reference is None and display is None:
        raise ValueError('Native name crops require an independent hidden-text ink reference')
    if reference is not None:
        if (not isinstance(reference,dict) or reference.get('policy')!='all_player_names_text_hidden_v2'
                or reference.get('source_capture_sha256')!=proof['capture_sha256']
                or reference.get('restored_capture_sha256')!=proof['capture_sha256']
                or reference.get('layout_unchanged') is not True
                or not isinstance(reference.get('hidden_region_ids'),list)
                or proof.get('renderer_region_id') not in reference['hidden_region_ids']):
            raise ValueError('Native name ink reference is not bound to the unchanged source state')
        if (reference.get('scope')!='actual_native_name_fields' or not isinstance(native_name_bounds,list)
                or reference.get('native_name_bounds')!=native_name_bounds):
            raise ValueError('Native name reference scope differs from the reconstructed native fields')
        filename=reference.get('screenshot');expected=reference.get('screenshot_sha256')
        regions=reference.get('source_rects')
        if not isinstance(regions,dict) or set(regions)!=set(reference['hidden_region_ids']):
            raise ValueError('Native name hidden-region inventory differs')
        if regions.get(proof.get('renderer_region_id'))!=rect:
            raise ValueError('Native name hidden region differs from its source rectangle')
    else:
        filename=display.get('blank_reference_screenshot');expected=display.get('blank_reference_capture_sha256')
    cache=cache if cache is not None else {}
    prior=cache.get('native_name_reference')
    identity=(filename,expected,proof.get('capture_sha256'),digest(json.dumps(reference,sort_keys=True).encode()))
    if prior and prior[0]==identity:
        blank=prior[1]
    else:
        raw = safe_child(directory, filename).read_bytes()
        if digest(raw) != expected:
            raise ValueError('Native name blank-reference identity differs')
        with Image.open(BytesIO(raw)) as decoded:
            blank = decoded.convert('RGB')
        if reference is not None:
            allowed=Image.new('L',image.size,0);draw=ImageDraw.Draw(allowed)
            for box in regions.values():
                if (not isinstance(box,dict) or any(type(box.get(k)) is not int for k in ('x','y','w','h'))
                        or min(box['x'],box['y'])<0 or min(box['w'],box['h'])<=0
                        or box['x']+box['w']>image.width or box['y']+box['h']>image.height):
                    raise ValueError('Native name hidden source rectangle is invalid')
                draw.rectangle((box['x'],box['y'],box['x']+box['w']-1,box['y']+box['h']-1),fill=255)
            difference=ImageChops.difference(image,blank)
            outside=ImageChops.multiply(difference,Image.merge('RGB',(ImageChops.invert(allowed),)*3))
            channels=outside.split()
            changed=ImageChops.lighter(ImageChops.lighter(channels[0],channels[1]),channels[2])
            box=changed.getbbox()
            points=[]
            if box:
                pixels=changed.crop(box).tobytes();width=box[2]-box[0]
                for index,value in enumerate(pixels):
                    if value:
                        x,y=box[0]+index%width,box[1]+index//width
                        points.append({'x':x,'y':y,'source_rgb':list(image.getpixel((x,y))),
                                       'reference_rgb':list(blank.getpixel((x,y)))})
                        if len(points)>4096:
                            raise ValueError('Native name reference outside-field drift exceeds its audit bound')
            bbox=None if not points else {'x':box[0],'y':box[1],'w':box[2]-box[0],'h':box[3]-box[1]}
            if (reference.get('comparison_policy')!='exact_rgb_difference_with_declared_name_fields_v1'
                    or reference.get('outside_name_changes')!=points
                    or reference.get('outside_name_changed_pixels')!=len(points)
                    or reference.get('outside_name_bounds')!=bbox):
                raise ValueError('Native name reference outside-field raster audit differs')
            import math
            for point in points:
                if any(math.floor(b['x'])<=point['x']<math.ceil(b['x']+b['width']) and
                       math.floor(b['y'])<=point['y']<math.ceil(b['y']+b['height']) for b in native_name_bounds):
                    raise ValueError('Native name reference outside-field drift intersects a native name crop')
        cache['native_name_reference']=(identity,blank)
    if blank.size != image.size:
        raise ValueError('Native name reference dimensions differ')
    import math
    left, top = math.floor(bounds['x']), math.floor(bounds['y'])
    box=(rect['x'],rect['y'],rect['x']+rect['w'],rect['y']+rect['h'])
    original=image.crop(box)
    channels=ImageChops.difference(original,blank.crop(box)).split()
    ink=ImageChops.lighter(ImageChops.lighter(channels[0],channels[1]),channels[2]).point(lambda v:255 if v else 0)
    if ink.getbbox() is None:
        raise ValueError('Native name ink reference contains no visible name ink')
    offset=(left-rect['x'],top-rect['y'])
    coverage=Image.new('L',original.size,0)
    coverage.paste(Image.new('L',crop.size,255),offset)
    if ImageChops.multiply(ink,ImageChops.invert(coverage)).getbbox():
        raise ValueError('Native crop does not preserve every verified displayed-name ink pixel')
    projected=Image.new('RGB',original.size)
    projected.paste(crop,offset)
    difference=ImageChops.difference(original,projected)
    if ImageChops.multiply(difference,Image.merge('RGB',(ink,)*3)).getbbox():
        raise ValueError('Native crop does not preserve every verified displayed-name ink pixel')


def verify_native_crop(image, rect, proof, region_id, directory, capture_sha, cache, display=None):
    if not isinstance(proof, dict) or proof.get('protocol') != PROTOCOL:
        raise ValueError('Native crop proof protocol differs')
    required = ['profile_sha256','tool_sha256','capture_sha256','pixel_sha256','image_sha256','source_dom_pixel_sha256']
    if any(not isinstance(proof.get(k), str) or not re.fullmatch(r'[a-f0-9]{64}', proof[k]) for k in required):
        raise ValueError('Native crop proof requires SHA256 identities')
    if proof['capture_sha256'] != capture_sha or proof.get('source_rect') != rect:
        raise ValueError('Native proof source capture or rectangle differs')
    if proof.get('renderer_region_id') != region_id:
        raise ValueError('Native proof renderer target identity differs')
    source = image.crop((rect['x'],rect['y'],rect['x']+rect['w'],rect['y']+rect['h']))
    if pixel_hash(source) != proof['source_dom_pixel_sha256']:
        raise ValueError('Native proof source DOM pixels differ')
    profile = safe_child(directory, proof.get('profile'))
    if digest(profile.read_bytes()) != proof['profile_sha256']:
        raise ValueError('Native proof source profile differs')
    parsed = json.loads(profile.read_text())
    regions = parsed.get('regions', [])
    selected = next((r for r in regions if r.get('id') == proof.get('region_id')), None)
    if not selected or selected.get('source_region_id') != source_field(region_id, proof.get('source_dealer')):
        raise ValueError('Native crop is not the same renderer source field')
    identity = (str(profile), proof['tool_sha256'])
    clients = cache.setdefault('native_clients', {})
    client = clients.get(identity)
    if client is None:
        client = NativeCropClient(profile, proof['tool_sha256'])
        clients[identity] = client
    capture_name = cache.get('name')
    path = cache.get('native_capture_path') or Path(directory) / 'full_captures' / capture_name
    native_items = client.frame(path, capture_sha)
    result = native_items.get(proof['region_id'])
    if not result or result.get('available') is not True:
        raise ValueError('Native source field is not currently cropable')
    if selected.get('category') not in ('card','suit') and (result.get('presence') or {}).get('state') in ('absent','ambiguous'):
        raise ValueError('Native source field is not admitted for recognition')
    for key in ['image_sha256','pixel_sha256','bounds','crop_mask','card_sampling','card_plane']:
        if result.get(key) != proof.get(key):
            raise ValueError('Native reconstructed ' + key + ' differs')
    raw = base64.b64decode(result['png_base64'], validate=True)
    if digest(raw) != proof['image_sha256']:
        raise ValueError('Native reconstructed PNG identity differs')
    with Image.open(BytesIO(raw)) as decoded:
        if decoded.mode != 'RGB':
            raise ValueError('Native OCR input must be canonical opaque RGB')
        crop = decoded.copy()
    if (pixel_hash(crop) != proof['pixel_sha256'] or crop.size != (proof.get('width'),proof.get('height'))):
        raise ValueError('Native reconstructed pixel identity or dimensions differ')
    if re.fullmatch(r'seats\[\d\]\.name', region_id):
        name_bounds=[native_items[r['id']]['bounds'] for r in regions if r.get('category')=='name'
                     and native_items.get(r['id'],{}).get('available') is True]
        verify_name_ink(image, rect, proof, crop, display, directory, cache, name_bounds)
    return crop
