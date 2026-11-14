import json
from pathlib import Path
import tempfile
import unittest

from lab_training_data import _semantic_baseline
from prepare_named_collection_training import digest, write_jsonl


class SemanticExclusionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'final'
        self.root.mkdir()
        self.original = {'sample_id': 'named:1', 'category': 'name', 'label': 'Winner',
                         'split': 'train', 'region_id': 'seats[0].name',
                         'pixel_sha256': 'a' * 64, 'file_sha256': 'b' * 64, 'optimize': True}
        write_jsonl(self.root / 'manifest.jsonl', [self.original])
        self.directory = self.root.parent / 'semantic-v2'
        (self.directory / 'review-evidence').mkdir(parents=True)
        (self.directory / 'review-evidence/contact.png').write_bytes(b'pixel review evidence')
        self.review = {**self.original, 'source_manifest_line': 1,
                       'source_manifest_sha256': digest((self.root / 'manifest.jsonl').read_bytes()),
                       'source_file_sha256': self.original['file_sha256'],
                       'decision': 'exclude_from_name_optimization',
                       'semantic_role': 'transient_winner_status_marker',
                       'visually_reviewed': True, 'label_preserved': True, 'split_preserved': True,
                       'literal_label_matches_visible_text': True, 'clipped_or_ambiguous': False,
                       'evidence_page': 'contact.png', 'evidence_page_sha256': digest(b'pixel review evidence')}
        self.save_review()

    def save_review(self):
        path = self.directory / 'semantic-review.jsonl'
        write_jsonl(path, [self.review])
        (self.directory / 'audit.json').write_text(json.dumps({
            'training_ready': True, 'semantic_exclusion_count': 1,
            'semantic_review_sha256': digest(path.read_bytes()),
            'source_manifest_sha256': digest((self.root / 'manifest.jsonl').read_bytes())}))

    def test_review_masks_optimization_without_changing_label_or_partition(self):
        result = _semantic_baseline(self.root, [self.original.copy()])[0]
        self.assertFalse(result['optimize'])
        self.assertEqual(result['label'], 'Winner')
        self.assertEqual(result['split'], 'train')
        self.assertTrue(self.original['optimize'])

    def test_changed_source_identity_and_review_decision_are_rejected(self):
        for field, value in [('label', ''), ('pixel_sha256', 'c' * 64),
                             ('decision', 'retarget_blank'), ('visually_reviewed', False)]:
            with self.subTest(field=field):
                prior = self.review[field]
                self.review[field] = value
                self.save_review()
                with self.assertRaises(ValueError):
                    _semantic_baseline(self.root, [self.original.copy()])
                self.review[field] = prior

    def test_changed_visual_evidence_is_rejected(self):
        (self.directory / 'review-evidence/contact.png').write_bytes(b'changed pixels')
        with self.assertRaisesRegex(ValueError, 'source-pixel evidence changed'):
            _semantic_baseline(self.root, [self.original.copy()])


if __name__ == '__main__':
    unittest.main()
