"""Fail-closed input checks and conservation for semantic-only dataset changes."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image
import yaml

from apply_semantic_training_review import build, image_identity, read_rows, sha, write_rows


class SemanticReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'frozen'
        self.source.mkdir()
        (self.source / 'images').mkdir()
        self.output = self.root / 'candidate'
        self.review = self.root / 'review.jsonl'
        rows = []
        samples = [('marker-train', 'Winner', 'train', 'name', True, 'baseline'),
                   ('marker-val', 'Winner', 'val', 'name', True, 'baseline'),
                   ('marker-test', 'Winner', 'test', 'name', True, 'baseline'),
                   ('blank-train', '', 'train', 'name', True, 'blank_retention'),
                   ('blank-val', '', 'val', 'name', True, 'blank_retention'),
                   ('repetition', 'wwww', 'train', 'name', True, 'retention'),
                   ('baseline:8137', 'G 125.9 BB', 'val', 'bet', False, 'baseline')]
        for index, (sample, label, split, category, optimize, origin) in enumerate(samples):
            image = self.source / 'images' / f'{index}.png'
            Image.new('RGB', (9, 3), (index * 20, 80, 20)).save(image)
            pixel, shape = image_identity(image)
            rows.append(dict(sample_id=sample, label=label, split=split, category=category,
                optimize=optimize, origin=origin, image_path=f'images/{index}.png',
                file_sha256=sha(image), pixel_sha256=pixel, image_dimensions=shape,
                region_id='seats[0].' + category, aliases=[{'sample_id':sample, 'split':split}],
                groups=['capture:' + str(index)], provenance={'split':split}))
        self.rows = rows
        write_rows(self.source / 'manifest.jsonl', rows)
        (self.source / 'dictionary.txt').write_text('\n'.join(sorted(set('WinnerwG 125.9B'))) + '\n')
        for name in ('quarantined.jsonl', 'superseded.jsonl'):
            (self.source / name).write_text('')
        audit = {'training_ready':True, 'retention':{'kept':1}, 'blank_retention':{'counts':{'train':1, 'val':1}}}
        for role in ('general', 'names'):
            d = self.source / role
            d.mkdir()
            selected = [r for r in rows if role == 'general' or r['category'] == 'name']
            write_rows(d / 'manifest.jsonl', selected)
            checkpoint = self.root / f'{role}.pdparams'
            checkpoint.write_bytes(b'original-trained-checkpoint-' + role.encode())
            config = {'Global':{'pretrained_model':str(checkpoint), 'checkpoints':None},
                      'Train':{'dataset':{'transforms':[]}}, 'Eval':{'dataset':{'transforms':[]}}}
            for split, stage in (('train','Train'), ('val','Eval')):
                config[stage]['dataset'].update(data_dir=str(self.source), label_file_list=[str(d / f'{split}.txt')])
            for split in ('train','val','test'):
                (d / f'{split}.txt').write_text(''.join(f"{self.source / r['image_path']}\t{r['label']}\n"
                    for r in selected if r['split'] == split and (split == 'test' or r['optimize'])))
            (d / 'train.yml').write_text(yaml.safe_dump(config))
            audit[role] = {'starting_checkpoint':str(checkpoint), 'starting_checkpoint_sha256':sha(checkpoint)}
        (self.source / 'audit.json').write_text(json.dumps(audit))
        page = self.root / 'contact.png'
        Image.new('RGB',(3,3),'green').save(page)
        self.reviews = []
        for line, r in enumerate(rows[:3], 1):
            self.reviews.append(dict(sample_id=r['sample_id'], source_manifest=str(self.source / 'manifest.jsonl'),
                source_manifest_sha256=sha(self.source / 'manifest.jsonl'), source_manifest_line=line,
                source_file_sha256=r['file_sha256'], source_image=str(self.source / r['image_path']),
                pixel_identity={'sha256':r['pixel_sha256'], 'dimensions':r['image_dimensions']},
                **{k:r[k] for k in ('category','label','split','origin','region_id','pixel_sha256')},
                label_preserved=True, split_preserved=True, visually_reviewed=True, reviewer='assistant_visual',
                semantic_role='transient_winner_status_marker', decision='exclude_from_name_optimization',
                visual_transcription='Winner', text_complete=True, literal_label_matches_visible_text=True,
                clipped_or_ambiguous=False, evidence_page='contact.png', evidence_page_sha256=sha(page), evidence_cell=line))
        write_rows(self.review, self.reviews)

    def run_build(self):
        return build(self.source, self.review, self.output, expected_count=3,
                     expected_split_counts={'train':1, 'val':1, 'test':1})

    def test_conserves_labels_roles_controls_and_test_membership(self):
        frozen_hash = sha(self.source / 'manifest.jsonl')
        audit = self.run_build()
        after = read_rows(self.output / 'manifest.jsonl')
        for before, result in zip(self.rows, after):
            for key in ('sample_id','label','aliases','groups','provenance','split','pixel_sha256'):
                self.assertEqual(before[key], result[key])
        self.assertEqual(after[3:], self.rows[3:])
        self.assertTrue(all(not r['optimize'] for r in after[:3]))
        self.assertEqual(audit['preexisting_exclusions'], ['baseline:8137'])
        self.assertTrue(audit['training_ready'])
        self.assertEqual(sha(self.source / 'manifest.jsonl'), frozen_hash)
        for role in ('general','names'):
            self.assertNotIn('\tWinner\n', (self.output / role / 'train.txt').read_text())
            self.assertNotIn('\tWinner\n', (self.output / role / 'val.txt').read_text())
            self.assertIn('\tWinner\n', (self.output / role / 'test.txt').read_text())
            config = yaml.safe_load((self.output / role / 'train.yml').read_text())
            self.assertEqual(config['Global']['pretrained_model'], str(self.root / f'{role}.pdparams'))
            self.assertEqual(config['Train']['dataset']['data_dir'], str(self.output))
        self.assertNotEqual((self.source/'images/0.png').stat().st_ino, (self.output/'images/0.png').stat().st_ino)

    def test_stale_manifest_review_rejected_before_output(self):
        self.reviews[0]['source_manifest_sha256'] = '0' * 64
        write_rows(self.review, self.reviews)
        with self.assertRaisesRegex(ValueError, 'Stale review'):
            self.run_build()
        self.assertFalse(self.output.exists())

    def test_review_field_mismatches_rejected(self):
        for field, value in [('label','Other'), ('category','status'), ('split','test'),
                             ('pixel_sha256','0'*64), ('source_file_sha256','0'*64),
                             ('visually_reviewed',False), ('evidence_page_sha256','0'*64)]:
            with self.subTest(field=field):
                modified = deepcopy(self.reviews)
                modified[0][field] = value
                write_rows(self.review, modified)
                with self.assertRaises(ValueError):
                    self.run_build()
                self.assertFalse(self.output.exists())

    def test_missing_or_duplicate_review_rejected(self):
        for modified in (self.reviews[:2], [self.reviews[0],self.reviews[0],self.reviews[2]]):
            write_rows(self.review, modified)
            with self.assertRaisesRegex(ValueError, 'coverage'):
                self.run_build()
            self.assertFalse(self.output.exists())

    def test_changed_image_or_checkpoint_rejected(self):
        (self.source / 'images/6.png').write_bytes(b'changed source')
        with self.assertRaisesRegex(ValueError, 'image hash'):
            self.run_build()
        self.assertFalse(self.output.exists())

    def test_changed_checkpoint_rejected(self):
        (self.root / 'general.pdparams').write_bytes(b'changed checkpoint')
        with self.assertRaisesRegex(ValueError, 'checkpoint'):
            self.run_build()
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
