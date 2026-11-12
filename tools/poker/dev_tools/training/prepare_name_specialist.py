#!/usr/bin/env python3
"""Build the name-only specialist dataset with explicit provenance checks."""
import argparse, hashlib, json, math
from pathlib import Path
import cv2
import numpy as np
import yaml

p = argparse.ArgumentParser()
p.add_argument('--root', type=Path, required=True)
p.add_argument('--data-root', type=Path, required=True)
p.add_argument('--epochs', type=int, default=4)
a = p.parse_args()
root, data = a.root.resolve(), a.data_root.resolve()
out = root / 'name-specialist-v12'
out.mkdir(parents=True, exist_ok=True)
def rows(path):
    return [json.loads(x) for x in path.read_text().splitlines() if x.strip()]
prod = data / 'production-data'
parts = {s: [r for r in rows(prod / f'{s}.jsonl') if r['category'] == 'name'] for s in ('train', 'val', 'test')}
train_ids = {str(r['id']) for r in parts['train']}
held_ids = {str(r['id']) for s in ('val', 'test') for r in parts[s]}
assert not train_ids & held_ids
held_labels = {r['label'] for s in ('val', 'test') for r in parts[s]}
held_labels |= {r['label'] for r in rows(data / 'novel-name-challenge/manifest.jsonl')}
raw_dir = data / 'raw-repetition-data'
raw = rows(raw_dir / 'manifest.jsonl')
gray_dir = root / 'compact-ocr-v4/reviewed-augmentation'
gray_audit = json.loads((gray_dir / 'audit.json').read_text())
gray = gray_audit['samples']
assert len(raw) == 4000 and len(gray) == 2000
for r in raw:
    assert r['split'] == 'train' and set(map(str, r['glyph_sources'])) <= train_ids
    assert r['label'] not in held_labels
    assert hashlib.sha256((raw_dir/r['image_path']).read_bytes()).hexdigest()==r['file_sha256']
for r in gray:
    assert {str(g['sample_id']) for g in r['glyphs']} <= train_ids
    assert r['label'] not in held_labels
assert len(parts['val']) == 255
(out / 'parent-name-manifest.json').write_text(json.dumps(parts, indent=2))
def entry(path, label):
    assert path.is_file(), path
    assert '\n' not in label and '\t' not in label
    return f'{path}\t{label}\n'
train = [entry(prod / r['image_path'], r['label']) for r in parts['train']]
for r in parts['train']+parts['val']:
    assert hashlib.sha256((prod/r['image_path']).read_bytes()).hexdigest()==r['file_sha256']
train += [entry(raw_dir / r['image_path'], r['label']) for r in raw]
train += [entry(gray_dir / r['image'], r['label']) for r in gray]
val = [entry(prod / r['image_path'], r['label']) for r in parts['val']]
blank_dir = out / 'blank-plates'
blank_dir.mkdir(exist_ok=True)
hashes = {}
thumbs = []
colors_path=Path(__file__).resolve().parents[2]/'src-tauri/assets/colors.json'
configured_colors=json.loads(colors_path.read_text())
colors=np.array([[int(configured_colors[key][index:index+2],16) for index in (5,3,1)] for key in ('nameplate','in_turn','in_turn_urgent')],dtype=np.int16)
for split, count, seed, target in [('train', 600, 202611072, train), ('val', 128, 202611073, val)]:
    rng = np.random.default_rng(seed)
    hashes[split] = set()
    for i in range(count):
        width = int(rng.integers(150, 221)); height = 32
        boundary = int(rng.integers(0, width + 1))
        c = rng.integers(0, 3, size=2)
        image = np.empty((height, width, 3), dtype=np.int16)
        image[:, :boundary] = colors[c[0]]; image[:, boundary:] = colors[c[1]]
        image = np.clip(image + rng.integers(-2, 3, image.shape), 0, 255).astype('uint8')
        digest = hashlib.sha256(image.tobytes()).hexdigest()
        hashes[split].add(digest)
        path = blank_dir / f'{split}-{i:04}.png'
        assert cv2.imwrite(str(path), image)
        target.append(entry(path, ''))
        if i < 24: thumbs.append(cv2.resize(image, (160, 32)))
assert not hashes['train'] & hashes['val']
sheet = np.vstack([np.hstack(thumbs[i:i+4]) for i in range(0, len(thumbs), 4)])
cv2.imwrite(str(out / 'blank-contact.png'), sheet)
(out / 'train.txt').write_text(''.join(train)); (out / 'val.txt').write_text(''.join(val))
cfg = yaml.safe_load((root / 'production-ocr-v10-clean/train.yml').read_text())
g = cfg['Global']
g.update(epoch_num=a.epochs, seed=202611072, collector_name_high_resolution=True, pretrained_model=str(root / 'production-ocr-v10-clean/checkpoints/best_accuracy.pdparams'), save_model_dir=str(out / 'checkpoints'), save_inference_dir=str(out / 'export'), character_dict_path=str(root / 'compact-ocr-v4/dictionary.txt'), infer_img=str(out / 'infer.png'), save_res_path=str(out / 'predict.txt'), eval_batch_step=[0, math.ceil(len(train)/32)])
cfg['Optimizer']['lr']['learning_rate'] = 2e-5
for section, name in [('Train','train'), ('Eval','val')]:
    cfg[section]['dataset']['data_dir'] = str(data)
    cfg[section]['dataset']['label_file_list'] = [str(out / f'{name}.txt')]
    cfg[section]['loader']['batch_size_per_card'] = 32
cfg['Train']['loader']['shuffle'] = True
cfg['Eval']['loader']['shuffle'] = False
(out / 'train.yml').write_text(yaml.safe_dump(cfg, sort_keys=False))
(out / 'audit.json').write_text(json.dumps({'real_train_variants':len(parts['train']),'unique_real_train_parents':len(train_ids), 'raw':len(raw), 'reviewed_gray':len(gray), 'constructed_blank_train':600, 'real_val':len(parts['val']), 'constructed_blank_val':128, 'train_total':len(train), 'val_total':len(val), 'blank_cross_split_duplicates':0, 'raw_and_gray_sources_train_only':True,'blank_palette_bgr':colors.tolist(),'palette_source_sha256':hashlib.sha256(colors_path.read_bytes()).hexdigest(),'starting_checkpoint_sha256':hashlib.sha256(Path(g['pretrained_model']).read_bytes()).hexdigest(),'geometry':'Second stem convolution stride=(2,1), unchanged weights; temporal stride2. Install name resolution policy in train/export.','role':'NAME specialist; original general reader retains all verified real negatives for other roles.'}, indent=2))
print((out / 'audit.json').read_text())
