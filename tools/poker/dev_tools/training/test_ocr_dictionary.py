import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from ocr_dictionary import (DEFAULT_PROFILE, LEGACY_PROFILE, characters_for_profile, clean_start_directory,
                            dictionary_text, profile_metadata, read_dictionary, validate_characters,
                            validate_output_width)
from portable_ocr import PortableModel, decode_ctc
from prepare_clean_ocr_start import map_tensors, source_indices


class DictionaryTests(unittest.TestCase):
    def test_exact_order_and_hashes_preserve_legacy_ids_except_final_space(self):
        old = characters_for_profile(LEGACY_PROFILE)
        new = characters_for_profile(DEFAULT_PROFILE)
        self.assertEqual(new[:69], old[:69])
        self.assertEqual(new[69:], [',', '/', '*', ' '])
        self.assertEqual(old[-1], ' ')
        self.assertEqual(profile_metadata(LEGACY_PROFILE)['classes_sha256'],
                         'fd400eb6d10c0b638569db59f131fe8f4c097a52ac8452291749515fc14ad15b')
        self.assertEqual(profile_metadata(DEFAULT_PROFILE)['classes_sha256'],
                         '609adc4610db99282e38e3900a37f26822ae1432c563f7e7a362c1635bc22292')
        self.assertEqual(profile_metadata(DEFAULT_PROFILE)['dictionary_sha256'],
                         '1975d3ae2a075e95ec810bd0224c3c9e15b6eb727e6a71c9d76f20d6c049aae4')
        new[0] = 'changed'
        self.assertEqual(characters_for_profile(DEFAULT_PROFILE)[0], 'blank')

    def test_reordered_or_cross_profile_vocabulary_rejected(self):
        for profile in (LEGACY_PROFILE, DEFAULT_PROFILE):
            chars = characters_for_profile(profile)
            wrong = list(chars)
            wrong[1], wrong[2] = wrong[2], wrong[1]
            with self.assertRaises(ValueError): validate_characters(wrong)
            with self.assertRaises(ValueError): validate_characters(chars, 'unknown')
            with self.assertRaises(ValueError): validate_output_width(chars, len(chars) + 3)
            with self.assertRaises(ValueError): validate_output_width(chars, 'classes')
            self.assertEqual(validate_characters(chars), profile)
        with self.assertRaises(ValueError):
            validate_characters(characters_for_profile(DEFAULT_PROFILE), LEGACY_PROFILE)

    def test_dictionary_file_encoding_and_separate_asset_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'dictionary.txt'
            for profile in (LEGACY_PROFILE, DEFAULT_PROFILE):
                path.write_text(dictionary_text(profile))
                self.assertEqual(read_dictionary(path, profile), characters_for_profile(profile))
                path.write_text(dictionary_text(profile).rstrip('\n'))
                with self.assertRaises(ValueError): read_dictionary(path, profile)
                path.write_bytes(dictionary_text(profile).replace('\n', '\r\n').encode())
                with self.assertRaises(ValueError): read_dictionary(path, profile)
            self.assertNotEqual(clean_start_directory(directory, LEGACY_PROFILE),
                                clean_start_directory(directory, DEFAULT_PROFILE))

    def test_blank_repeats_punctuation_and_spaces_decode_by_character_identity(self):
        chars = characters_for_profile(DEFAULT_PROFILE)
        sequence = [0, chars.index(','), chars.index(','), 0, chars.index(','),
                    chars.index('/'), chars.index('*'), 0, chars.index('*'), chars.index(' '), 0]
        probabilities = np.zeros((1, len(sequence), len(chars)), np.float32)
        probabilities[0, np.arange(len(sequence)), sequence] = 1
        self.assertEqual(decode_ctc(probabilities, chars), (',,/** ', 1.0))
        with self.assertRaises(ValueError):
            decode_ctc(probabilities, characters_for_profile(LEGACY_PROFILE))

    def test_original_tensor_columns_are_selected_by_character_not_previous_id(self):
        target = characters_for_profile(DEFAULT_PROFILE)
        source = list(reversed(target))
        indices = source_indices(source, target)
        weight = np.arange(120 * len(source)).reshape(120, len(source))
        state = {'backbone.conv': np.arange(4), 'head.ctc_encoder.mix': np.arange(5),
                 'head.ctc_head.fc.weight': weight, 'head.ctc_head.fc.bias': np.arange(len(source)),
                 'head.gtc_head.auxiliary': np.arange(2)}
        mapped = map_tensors(state, indices, lambda tensor, ids, axis: np.take(tensor, ids, axis))
        self.assertEqual(set(mapped), {'backbone.conv', 'neck.mix', 'head.fc.weight', 'head.fc.bias'})
        for index, char in enumerate(target):
            np.testing.assert_array_equal(mapped['head.fc.weight'][:, index], weight[:, source.index(char)])
            self.assertEqual(mapped['head.fc.bias'][index], source.index(char))
        with self.assertRaises(ValueError): source_indices(source + [','], target)
        with self.assertRaises(ValueError): source_indices(source[1:], target)

    def test_portable_rejects_cross_paired_model_head_and_dictionary(self):
        class Options:
            pass
        class Session:
            def __init__(self, *args, **kwargs): pass
            def get_outputs(self): return [SimpleNamespace(shape=[1, 'time', head_width])]
            def get_inputs(self): return [SimpleNamespace(name='image')]
        fake = SimpleNamespace(SessionOptions=Options, InferenceSession=Session)
        with tempfile.TemporaryDirectory() as directory, patch.dict('sys.modules', {'onnxruntime': fake}):
            path = Path(directory)
            for profile in (LEGACY_PROFILE, DEFAULT_PROFILE):
                chars = characters_for_profile(profile)
                (path / 'characters.json').write_text(json.dumps(chars))
                head_width = len(chars)
                self.assertEqual(PortableModel(path).dictionary_profile, profile)
                head_width = 73 if len(chars) == 70 else 70
                with self.assertRaises(ValueError): PortableModel(path)


if __name__ == '__main__':
    unittest.main()
