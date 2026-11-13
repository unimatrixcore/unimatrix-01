"""Enforce capture/pixel separation and training-only augmentation provenance."""
import collections,hashlib,json
from pathlib import Path
import cv2


def verify_partition(rows,bundle,augmentation=None):
    pixels=collections.defaultdict(list);captures=collections.defaultdict(set)
    for row in rows:
        path=Path(bundle)/row['image_path'];assert hashlib.sha256(path.read_bytes()).hexdigest()==row['file_sha256']
        image=cv2.imread(str(path));assert image is not None
        digest=hashlib.sha256(str(image.shape).encode()+image.tobytes()).hexdigest();pixels[digest].append(row)
        if row['source_id'] is None:assert row['split']=='train'
        else:captures[row['source_id']].add(row['split'])
    assert all(len(splits)==1 for splits in captures.values()),'Source capture crossed partitions'
    cross=[r for group in pixels.values() if len({r['split'] for r in group})>1 for r in group]
    assert not cross,'Exact pixels crossed capture splits: '+str([r['sample_id'] for r in cross])
    aug_count=0
    if augmentation:
        augmentation=Path(augmentation);audit=json.loads((augmentation/'audit.json').read_text());labels={line.split('\t')[0]:line.split('\t')[1] for line in (augmentation/'labels.txt').read_text().splitlines()}
        train={r['sample_id'] for r in rows if r['split']=='train' and r['label'] and r.get('optimize',True)};heldout={r['label'] for r in rows if r['split']!='train' and r['category']=='name'}
        assert len(labels)==len(audit['samples'])
        for sample in audit['samples']:
            assert labels[sample['image']]==sample['label'] and sample['label'] not in heldout
            assert sample['glyphs'] and all(glyph['sample_id'] in train for glyph in sample['glyphs'])
        aug_count=len(labels)
    return {'rows':len(rows),'source_capture_groups':len(captures),'cross_split_capture_groups':0,'cross_split_exact_pixel_groups':0,'unique_decoded_images':len(pixels),'augmentation_provenance_verified':bool(augmentation),'augmentation_rows':aug_count}
