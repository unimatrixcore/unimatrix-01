"""Failure-oriented contract tests for accepted OCR values and stale frames."""
import unittest
from production_decision import Decision, TemporalAgreement, decide_views


def predictions(*texts):
    return [{'raw_prediction':text,'confidence':.9999} for text in texts]


class DecisionTests(unittest.TestCase):
    def test_confident_decimal_deletion_abstains(self):
        self.assertEqual(decide_views('bank',predictions('G 136.3 BB','G 1363 BB','G 136.3 BB','G 136.3 BB','G 136.3 BB')).state,'unknown')

    def test_invalid_text_is_not_a_blank(self):
        self.assertEqual(decide_views('card',predictions(*['X']*5)).state,'unknown')
        self.assertEqual(decide_views('name',predictions(*[' ']*5)).state,'unknown')
        self.assertEqual(decide_views('card',predictions(*['']*5)).state,'blank')

    def test_missing_failed_or_nan_views_abstain(self):
        self.assertEqual(decide_views('bank',predictions(*['G 1 BB']*4)).state,'unknown')
        views=predictions(*['G 1 BB']*5);views[3]['error']='decode failed'
        self.assertEqual(decide_views('bank',views).state,'unknown')
        views[3].pop('error');views[3]['confidence']=float('nan')
        self.assertEqual(decide_views('bank',views).state,'unknown')

    def test_correlated_wrong_agreement_is_not_magically_detected(self):
        # This limitation must remain visible; schemas cannot recover decimals.
        self.assertEqual(decide_views('bank',predictions(*['G 1363 BB']*5)).text,'G 1363 BB')

    def test_temporal_rejects_duplicates_changed_tables_and_stale_values(self):
        policy=TemporalAgreement();good=Decision('text','G 1 BB','all_views_agree')
        self.assertEqual(policy.update('bank','table1','f1',1.,good).state,'unknown')
        self.assertEqual(policy.update('bank','table1','f1',1.1,good).state,'unknown')
        self.assertEqual(policy.update('bank','table1','f2',1.2,good).state,'unknown')
        self.assertEqual(policy.update('bank','table1','f3',1.8,good).state,'text')
        self.assertEqual(policy.update('bank','table2','f4',2.2,good).state,'unknown')
        self.assertEqual(policy.update('bank','table2','f5',5.,good).state,'unknown')
        policy.update('bank','table2','f6',5.5,Decision('unknown',None,'view_disagreement'))
        self.assertEqual(policy.update('bank','table2','f7',6.,good).state,'unknown')
        self.assertEqual(policy.update('bank','table2','f8',6.5,good).state,'text')


if __name__ == '__main__':unittest.main()
