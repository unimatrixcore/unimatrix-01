"""Literal anonymous-name crosschecks must not guess spaces or repair glyphs."""
import unittest

import numpy as np

from production_reader import CollectorReader
from test_production_reader import FakeModel


class ScriptModel(FakeModel):
    def __init__(self, outputs):
        super().__init__()
        self.outputs = outputs if isinstance(outputs, list) else [outputs] * 5
        self.inputs = []

    def probabilities(self, image):
        value = self.outputs[self.calls % len(self.outputs)]
        self.calls += 1
        self.inputs.append(image)
        if isinstance(value, Exception):
            raise value
        return self.emit(value)


class AnonymousNameCrosscheckTests(unittest.TestCase):
    def setUp(self):
        self.frame = np.arange(40 * 80 * 3, dtype=np.uint8).reshape(40, 80, 3)
        self.rect = dict(x=10, y=10, w=50, h=20)

    def read(self, specialist='Player4', general='Player 4', **kwargs):
        self.general = ScriptModel(general)
        self.specialist = ScriptModel(specialist)
        self.reader = CollectorReader(None, model=self.general, name_model=self.specialist, **kwargs)
        return self.reader._read_region(self.frame, self.rect, 'name')

    def test_spaced_read_is_literal_general_output_with_both_raw_views(self):
        decision, views, calls, digest = self.read()
        self.assertEqual((decision.state, decision.text), ('text', 'Player 4'))
        self.assertEqual(calls, 10)
        self.assertEqual((self.specialist.calls, self.general.calls), (5, 5))
        self.assertTrue(digest)
        for primary_input, secondary_input in zip(self.specialist.inputs, self.general.inputs):
            self.assertIs(primary_input, secondary_input)
        for view in views:
            self.assertEqual(view['raw_prediction'], 'Player 4')
            self.assertEqual(view['specialist_view']['raw_prediction'], 'Player4')
            self.assertEqual(view['specialist_view']['model_role'], 'names')
            self.assertEqual(view['selected_model_role'], 'general')

    def test_actual_unspaced_username_is_not_changed(self):
        decision, views, calls, _ = self.read(general='Player4')
        self.assertEqual((decision.state, decision.text), ('text', 'Player4'))
        self.assertTrue(all(view['raw_prediction'] == 'Player4' for view in views))
        self.assertEqual(calls, 10)

    def test_general_disagreement_wrong_glyphs_or_nonliteral_spacing_abstains(self):
        for general in ['Player 5', 'player 4', '', 'Player  4', 'Player 4 ', 'P layer4',
                        ['Player 4'] * 4 + ['Player4']]:
            with self.subTest(general=general):
                decision, views, calls, _ = self.read(general=general)
                self.assertEqual((decision.state, decision.text), ('unknown', None))
                self.assertEqual(decision.reason, 'anonymous_name_crosscheck_failed')
                self.assertEqual(calls, 10)
                self.assertTrue(all(view['selected_model_role'] is None for view in views))

    def test_secondary_error_is_preserved_and_retried_on_identical_pixels(self):
        decision, views, calls, _ = self.read(general=['Player 4'] * 4 + [RuntimeError('retry me')])
        self.assertEqual(decision.state, 'unknown')
        self.assertEqual(views[-1]['error'], 'retry me')
        self.assertEqual(views[-1]['specialist_view']['raw_prediction'], 'Player4')
        self.assertEqual(calls, 10)
        self.general.outputs = ['Player 4'] * 5
        second = self.reader._read_region(self.frame, self.rect, 'name')
        self.assertEqual(second[0].text, 'Player 4')
        self.assertEqual(second[2], 10)
        self.assertEqual((self.specialist.calls, self.general.calls), (10, 10))

    def test_combined_cache_avoids_both_models_and_keeps_evidence(self):
        first = self.read()
        second = self.reader._read_region(self.frame, self.rect, 'name')
        self.assertEqual(second[0], first[0])
        self.assertEqual(second[1], first[1])
        self.assertEqual(second[3], first[3])
        self.assertEqual(second[2], 0)
        self.assertEqual((self.specialist.calls, self.general.calls), (5, 5))

    def test_unknown_primary_does_not_get_rescued(self):
        decision, _, calls, _ = self.read(specialist=['Player4'] * 4 + ['Player5'])
        self.assertEqual(decision.state, 'unknown')
        self.assertEqual(calls, 5)
        self.assertEqual(self.general.calls, 0)

    def test_ordinary_spaced_blank_and_out_of_range_names_do_not_trigger(self):
        for specialist in ['LoneWolfer', 'LoneWoIfer', 'Player 4', '', 'Player0', 'Player10', 'player4', 'Player4...']:
            with self.subTest(specialist=specialist):
                decision, views, calls, _ = self.read(specialist=specialist)
                self.assertEqual(decision.text, specialist)
                self.assertEqual(calls, 5)
                self.assertEqual(self.general.calls, 0)
                self.assertFalse(any('specialist_view' in view for view in views))

    def test_general_only_name_reader_keeps_existing_behavior(self):
        model = ScriptModel('Player4')
        reader = CollectorReader(None, model=model)
        decision, _, calls, _ = reader._read_region(self.frame, self.rect, 'name')
        self.assertEqual(decision.text, 'Player4')
        self.assertEqual((calls, model.calls), (5, 5))

    def test_other_region_does_not_invoke_specialist_or_crosscheck(self):
        self.read()
        self.general.calls = self.specialist.calls = 0
        self.general.outputs = ['D'] * 5
        decision, _, calls, _ = self.reader._read_region(self.frame, self.rect, 'dealer')
        self.assertEqual(decision.text, 'D')
        self.assertEqual((calls, self.general.calls, self.specialist.calls), (5, 5, 0))


if __name__ == '__main__':
    unittest.main()
