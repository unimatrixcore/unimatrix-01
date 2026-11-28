import base64
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from PIL import Image

import native_crop_evidence as native


def png(image):
    stream=BytesIO()
    image.save(stream,format='PNG')
    return stream.getvalue()


class NativeCropEvidenceTests(unittest.TestCase):
    def test_target_quarantine_pins_only_bad_caption_tool_and_profile(self):
        tool = '868214a3fb3d972943a982e812851580e81f6895689ad2b9ff7688d8e6791a59'
        profile = 'f3e05596327a81f75ca9ae28df3cd015cc1ef1e0cb050b9084d962db6c366755'
        self.assertEqual(native.native_target_quarantine('table_info', 'Caption', tool, profile)['reason'],
                         'source_caption_ink_unqualified_for_native_text_line_localizer')
        for category, label, changed_tool, changed_profile in (
                ('table_info', 'Caption', 'f' * 64, profile),
                ('table_info', 'Caption', tool, 'f' * 64),
                ('name', 'Player 1', tool, profile),
                ('table_info', '', tool, profile)):
            self.assertIsNone(native.native_target_quarantine(category, label, changed_tool, changed_profile))

    def setUp(self):
        temporary=tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name)
        self.image=Image.new('RGB',(30,20),(80,90,100))
        self.rect={'x':3,'y':4,'w':12,'h':8}
        self.crop=self.image.crop((3,4,15,12))
        self.crop.putpixel((0,0),(15,33,46))
        profile=self.root/'native/profile.json'
        profile.parent.mkdir()
        profile.write_text(json.dumps({'regions':[{'id':'seats[7].bank','source_region_id':'seat.0.bank'}]}))
        self.capture=native.digest(png(self.image))
        self.item={'available':True,'region_id':'seats[7].bank','bounds':{'x':3,'y':4,'width':12,'height':8},
                   'crop_mask':{'policy':'source_css_rounded_panels_rgb_v1'},'card_sampling':None,'card_plane':None,
                   'image_sha256':native.digest(png(self.crop)),'pixel_sha256':native.pixel_hash(self.crop),
                   'png_base64':base64.b64encode(png(self.crop)).decode()}
        self.proof={k:v for k,v in self.item.items() if k not in ('available','png_base64')}
        self.proof.update(protocol=native.PROTOCOL,profile='native/profile.json',profile_sha256=native.digest(profile.read_bytes()),
            tool_sha256='a'*64,capture_sha256=self.capture,source_rect=self.rect,
            renderer_region_id='seats[0].bank',
            source_dom_pixel_sha256=native.pixel_hash(self.image.crop((3,4,15,12))),width=12,height=8)
        self.cache={'name':'frame.png'}
        self.fake=mock.Mock()
        self.fake.frame.return_value={'seats[7].bank':self.item}

    def verify(self,proof=None):
        with mock.patch.object(native,'NativeCropClient',return_value=self.fake):
            return native.verify_native_crop(self.image,self.rect,proof or self.proof,'seats[0].bank',
                                             self.root,self.capture,self.cache)

    def test_reconstructs_native_pixels_instead_of_trusting_a_rectangle(self):
        found=self.verify()
        self.assertEqual(found.tobytes(),self.crop.tobytes())
        self.assertNotEqual(found.tobytes(),self.image.crop((3,4,15,12)).tobytes())
        self.fake.frame.assert_called_once_with(self.root/'full_captures/frame.png',self.capture)

    def test_rejects_changed_source_and_profile(self):
        changed=deepcopy(self.proof);changed['source_dom_pixel_sha256']='b'*64
        with self.assertRaisesRegex(ValueError,'source DOM pixels'):self.verify(changed)
        changed=deepcopy(self.proof);changed['profile_sha256']='b'*64
        with self.assertRaisesRegex(ValueError,'source profile'):self.verify(changed)

    def test_rejects_other_seat_even_with_identical_crop_bytes(self):
        profile=self.root/'native/profile.json'
        profile.write_text(json.dumps({'regions':[{'id':'seats[7].bank','source_region_id':'seat.1.bank'}]}))
        self.proof['profile_sha256']=native.digest(profile.read_bytes())
        with self.assertRaisesRegex(ValueError,'same renderer source field'):self.verify()

    def test_rejects_unavailable_crop_and_changed_native_mask(self):
        self.fake.frame.return_value={'seats[7].bank':{'available':False,'error':'unresolved'}}
        with self.assertRaisesRegex(ValueError,'not currently cropable'):self.verify()
        self.fake.frame.return_value={'seats[7].bank':self.item}
        changed=deepcopy(self.proof);changed['crop_mask']={}
        with self.assertRaisesRegex(ValueError,'crop_mask differs'):self.verify(changed)

    def test_rejects_profile_escape_and_symlink(self):
        changed=deepcopy(self.proof);changed['profile']='../outside.json'
        with self.assertRaisesRegex(ValueError,'escapes'):self.verify(changed)
        target=self.root/'native/profile.json';link=self.root/'native/link.json';link.symlink_to(target)
        changed=deepcopy(self.proof);changed['profile']='native/link.json'
        with self.assertRaisesRegex(ValueError,'symbolic'):self.verify(changed)

    def test_rejects_clipped_name_geometry_and_verified_name_ink(self):
        changed=deepcopy(self.proof);changed['source_text_rect']={'x':2,'y':5,'w':4,'h':2}
        with self.assertRaisesRegex(ValueError,'clips source text'):
            native.verify_name_ink(self.image,self.rect,changed,self.crop,None,self.root)
        blank=self.image.copy();blank.putpixel((3,4),(0,0,0))
        raw=png(blank);(self.root/'blank.png').write_bytes(raw)
        display={'blank_reference_screenshot':'blank.png','blank_reference_capture_sha256':native.digest(raw)}
        with self.assertRaisesRegex(ValueError,'preserve every verified'):
            native.verify_name_ink(self.image,self.rect,self.proof,self.crop,display,self.root)

    def test_name_without_independent_ink_reference_fails_closed(self):
        with self.assertRaisesRegex(ValueError,'independent hidden-text ink reference'):
            native.verify_name_ink(self.image,self.rect,self.proof,self.crop,None,self.root)

    def test_source_mapping_handles_cards_and_display_fields(self):
        self.assertEqual(native.source_field('seats[2].cards[1].suit'),'seat.2.card.1.suit')
        self.assertEqual(native.source_field('community_cards[3]'),'board.3.rank')
        self.assertEqual(native.source_field('split_pot'),'pot.visible')
        self.assertEqual(native.source_field('pot.split'),'pot.visible')
        self.assertEqual(native.source_field('dealer',3),'seat.3.dealer')
        with self.assertRaisesRegex(ValueError,'controlled source seat'):native.source_field('dealer')

    def test_actual_ink_reference_allows_font_metrics_outside_native_crop(self):
        blank=self.image.copy();blank.putpixel((6,7),(0,0,0))
        raw=png(blank);(self.root/'blank.png').write_bytes(raw)
        proof=deepcopy(self.proof)
        proof.update(source_text_rect={'x':2,'y':3,'w':10,'h':8},renderer_region_id='seats[0].name')
        proof['name_ink_reference']={'policy':'all_player_names_text_hidden_v2',
            'source_capture_sha256':self.capture,'restored_capture_sha256':self.capture,'layout_unchanged':True,
            'hidden_region_ids':['seats[0].name'],'source_rects':{'seats[0].name':self.rect},
            'screenshot':'blank.png','screenshot_sha256':native.digest(raw),
            'scope':'actual_native_name_fields','native_name_bounds':[self.proof['bounds']],
            'comparison_policy':'exact_rgb_difference_with_declared_name_fields_v1',
            'outside_name_changes':[],'outside_name_changed_pixels':0,'outside_name_bounds':None}
        native.verify_name_ink(self.image,self.rect,proof,self.crop,None,self.root,native_name_bounds=[self.proof['bounds']])
        changed=blank.copy();changed.putpixel((25,15),(0,0,0));raw=png(changed)
        (self.root/'blank.png').write_bytes(raw);proof['name_ink_reference']['screenshot_sha256']=native.digest(raw)
        with self.assertRaisesRegex(ValueError,'outside-field raster audit'):
            native.verify_name_ink(self.image,self.rect,proof,self.crop,None,self.root,native_name_bounds=[self.proof['bounds']])
        ref=proof['name_ink_reference']
        ref.update(outside_name_changes=[{'x':25,'y':15,'source_rgb':[80,90,100],'reference_rgb':[0,0,0]}],
                   outside_name_changed_pixels=1,outside_name_bounds={'x':25,'y':15,'w':1,'h':1})
        native.verify_name_ink(self.image,self.rect,proof,self.crop,None,self.root,native_name_bounds=[self.proof['bounds']])
        bounds=[self.proof['bounds'],{'x':25,'y':15,'width':1,'height':1}]
        ref['native_name_bounds']=bounds
        with self.assertRaisesRegex(ValueError,'intersects a native name crop'):
            native.verify_name_ink(self.image,self.rect,proof,self.crop,None,self.root,native_name_bounds=bounds)


if __name__=='__main__':unittest.main()
