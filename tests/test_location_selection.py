"""Training-only county selection behavior contracts."""

import unittest

from analysis.screen_regions import PROTOCOL_PATH, score_county, select_counties
import json


PROTOCOL = json.loads(PROTOCOL_PATH.read_bytes())


def training_rows():
    return [{'year': year, 'month': month, 'terra': month * (year - 2012),
             'snpp': 2 * month * (year - 2012)}
            for year in range(2013, 2020) for month in range(1, 13)]


class LocationSelectionTests(unittest.TestCase):
    def test_eligibility(self):
        """Given incomplete, inactive or sparse counts, screening excludes them with explicit reasons."""
        self.assertTrue(score_county(training_rows(), PROTOCOL)['eligible'])
        incomplete = score_county(training_rows()[:-1], PROTOCOL)
        self.assertFalse(incomplete['eligible'])
        self.assertEqual(incomplete['reasons'], ['incomplete_or_invalid_training_months'])
        zero = score_county([{**row, 'terra': 0} for row in training_rows()], PROTOCOL)
        self.assertFalse(zero['eligible'])
        self.assertIn('insufficient_terra_detections', zero['reasons'])
        self.assertIn('insufficient_positive_terra_months', zero['reasons'])
        sparse = score_county([{**row, 'terra': 100 if index < 23 else 0}
                              for index, row in enumerate(training_rows())], PROTOCOL)
        self.assertFalse(sparse['eligible'])
        self.assertEqual(sparse['reasons'], ['insufficient_positive_terra_months'])

    def test_no_later_year_leakage(self):
        """Given later observations, screening rejects input outside 2013-2019 before ranking."""
        for year in (2012, 2020, 2025):
            with self.subTest(year=year), self.assertRaisesRegex(ValueError, 'outside the training years'):
                score_county(training_rows() + [{'year': year, 'month': 1, 'terra': 999999, 'snpp': 1}], PROTOCOL)

    def test_ranking_and_ties(self):
        """Given tied normalized errors, selection orders by GEOID and refuses fewer than five passers."""
        scores = [{'geoid': geoid, 'eligible': True, 'passed': True, 'normalized_ratio_mae': error}
                  for geoid, error in [('06009', .3), ('06007', .2), ('06005', .2),
                                       ('06003', .1), ('06001', .4), ('06011', .5)]]
        scores += [{'geoid': '06013', 'eligible': False, 'passed': True, 'normalized_ratio_mae': 0},
                   {'geoid': '06015', 'eligible': True, 'passed': False, 'normalized_ratio_mae': 0}]
        self.assertEqual([row['geoid'] for row in select_counties(scores)],
                         ['06003', '06005', '06007', '06009', '06001'])
        with self.assertRaisesRegex(ValueError, 'without relaxing'):
            select_counties(scores[:4])

    def test_forward_training_coefficient(self):
        """Given a known ratio and later change, each fold uses preceding years only."""
        rows = training_rows()
        score = score_county(rows, PROTOCOL)
        self.assertEqual(score['cv_months'], 48)
        self.assertTrue(score['passed'])
        self.assertEqual(score['mae']['ratio'], 0)
        self.assertTrue(all(fold['alpha'] == .5 for fold in score['folds']))
        changed = [{**row, 'terra': row['terra'] * 2 if row['year'] == 2016 else row['terra']} for row in rows]
        folds = score_county(changed, PROTOCOL)['folds']
        self.assertEqual(folds[0]['alpha'], .5)
        self.assertEqual(folds[1]['alpha'], .7)
        self.assertEqual([fold['training_months'] for fold in folds], [36, 48, 60, 72])
        self.assertTrue(all(row['year'] == fold['validation_year'] for fold in folds for row in fold['validation_months']))

    def test_strict_baseline_comparison(self):
        """Given perfect seasonal agreement, a tie with seasonal MAE cannot pass."""
        rows = [{**row, 'terra': row['month'], 'snpp': row['month'] * 2} for row in training_rows()]
        score = score_county(rows, PROTOCOL)
        self.assertTrue(score['eligible'])
        self.assertFalse(score['passed'])
        self.assertEqual(score['mae']['ratio'], score['mae']['seasonal'])
