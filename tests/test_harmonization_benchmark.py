"""Independent contracts for count calibration and time-separated selection."""

from copy import deepcopy
import json
import unittest

import numpy as np

from analysis.benchmark_harmonization import (PROTOCOL_PATH, ROOT, choose_candidate, evaluate_county,
    fit_model, metrics, paired_rows, predict, select_model, validate_output_directory)


def row(year, month, reference, source):
    return {'year': year, 'month': month, 'terra': reference, 'snpp': source,
            'terra_day': reference, 'terra_night': 0, 'snpp_day': source / 2, 'snpp_night': source / 2}


def protocol():
    return json.loads(PROTOCOL_PATH.read_text(encoding='utf-8'))


def history():
    return [row(year, month, 2 * (1 + month + year - 2013), month + year - 2013)
            for year in range(2013, 2026) for month in range(1, 13)]


class BenchmarkTests(unittest.TestCase):
    def test_ratio_reproduces_known_counts_and_does_not_mutate_inputs(self):
        """Given source totals 20 and reference 10, fitting then predicting 8 gives 4."""
        rows = [row(2013, 1, 4, 8), row(2013, 2, 6, 12)]
        original = deepcopy(rows)
        model = fit_model(rows, {'kind': 'ratio'})
        self.assertEqual(model['alpha'], .5)
        self.assertEqual(predict(model, [row(2020, 1, 0, 8)]), [4])
        self.assertEqual(rows, original)

    def test_regularized_partitions_have_known_closed_form(self):
        """Given unequal quarter and solar totals, each fitted factor obeys its declared prior."""
        rows = [row(2013, month, reference, 8) for month, reference in [(1,4),(4,8),(7,12),(10,8)]]
        quarterly = fit_model(rows, {'kind': 'quarter_ratio', 'prior_fraction': 1})
        self.assertEqual(quarterly['factors'], {'0': .75, '1': 1, '2': 1.25, '3': 1})
        self.assertEqual(predict(quarterly, rows), [6,8,10,8])
        solar = fit_model(rows, {'kind': 'solar_ratio', 'prior_fraction': 1})
        self.assertEqual(solar['factors'], {'day': 1.5, 'night': .5})
        self.assertEqual(predict(solar, rows), [8,8,8,8])

    def test_poisson_recovers_known_mean_and_conserves_training_total(self):
        """Given y=2*(1+x), count regression predicts [2,8,20] for x=[0,3,9]."""
        rows = history()[:84]
        for seasonal in (False, True):
            model = fit_model(rows, {'kind':'poisson', 'seasonal':seasonal, 'penalty':1})
            estimates = predict(model, [row(2020, month, 0, source) for month, source in [(1,0),(6,3),(12,9)]])
            np.testing.assert_allclose(estimates, [2,8,20], rtol=1e-7)
            # The unpenalized intercept's score enforces this independent total constraint.
            self.assertAlmostEqual(sum(predict(model, rows)), sum(entry['terra'] for entry in rows), places=5)
        varied = deepcopy(rows)
        for entry in varied:
            entry['terra'] += 3 if entry['month'] < 5 else 0
            entry['terra_day'] = entry['terra']
        model = fit_model(varied, {'kind':'poisson', 'seasonal':True, 'penalty':1})
        self.assertAlmostEqual(sum(predict(model, varied)), sum(entry['terra'] for entry in varied), places=4)

    def test_future_targets_cannot_affect_selected_method_or_fitted_parameters(self):
        """Changing benchmark Terra targets leaves training selection and predictions identical."""
        rows = history()
        result, predictions = evaluate_county(rows, protocol())
        modified = deepcopy(rows)
        for entry in modified:
            if entry['year'] >= 2020:
                entry['terra'] += 1000
                entry['terra_day'] += 1000
        other, future_predictions = evaluate_county(modified, protocol())
        self.assertEqual(result['selection'], other['selection'])
        self.assertEqual([record['predicted'] for record in predictions], [record['predicted'] for record in future_predictions])
        for key in result['benchmark']:
            self.assertEqual(result['benchmark'][key]['model'], other['benchmark'][key]['model'])
        with self.assertRaisesRegex(ValueError, 'outside the training'):
            select_model(rows, protocol())

    def test_invalid_or_missing_pairs_are_not_silently_zero_filled(self):
        """Missing counts, duplicate months and invalid solar partitions stop evaluation."""
        valid = [row(2013, 1, 4, 8), row(2013, 2, 6, 12)]
        for invalid in (None, float('nan'), -1):
            rows = deepcopy(valid); rows[0]['terra'] = invalid
            with self.assertRaisesRegex(ValueError, 'Missing or invalid'):
                fit_model(rows, {'kind':'ratio'})
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            fit_model(valid + [valid[0]], {'kind':'ratio'})
        rows = deepcopy(valid); rows[0]['snpp_night'] = 0
        with self.assertRaisesRegex(ValueError, 'partition'):
            fit_model(rows, {'kind':'ratio'})
        with self.assertRaisesRegex(ValueError, 'Positive paired'):
            fit_model([row(2013, 1, 0, 1)], {'kind':'ratio'})

    def test_metrics_report_bias_peaks_and_undefined_correlations(self):
        """Known observed/predicted values give independently calculable errors and null constant-series correlation."""
        rows = [row(2020, 1, 0, 0), row(2020, 2, 2, 2), row(2020, 3, 10, 10)]
        result = metrics(rows, [1,4,7], peak_months=1)
        self.assertEqual(result['mae'], 2)
        self.assertAlmostEqual(result['rmse'], (14/3)**.5)
        self.assertEqual(result['signed_bias'], 0)
        self.assertEqual(result['peak_mae'], 3)
        self.assertEqual(result['peak_month_keys'], ['2020-03'])
        self.assertEqual(result['active_month_mae'], 2.5)
        self.assertIsNone(metrics(rows, [1,1,1])['pearson_r'])

    def test_selection_enforces_improvement_and_peak_guard(self):
        """A small MAE gain or a large peak regression retains the original ratio."""
        rules = protocol()
        scores = {'ratio': {'mae': 10, 'peak_mae': 20}, 'recent_ratio': {'mae': 9.6, 'peak_mae': 20}}
        self.assertEqual(choose_candidate(scores, rules), 'ratio')
        scores['recent_ratio'] = {'mae': 8, 'peak_mae': 23}
        self.assertEqual(choose_candidate(scores, rules), 'ratio')
        scores['recent_ratio'] = {'mae': 8, 'peak_mae': 21}
        self.assertEqual(choose_candidate(scores, rules), 'recent_ratio')

    def test_output_cannot_replace_runtime_data(self):
        """A request to write into web or dist fails before creating output files."""
        for path in [ROOT, ROOT / 'web', ROOT / 'web/data/benchmark', ROOT / 'dist', ROOT / 'analysis']:
            with self.assertRaisesRegex(ValueError, 'separate'):
                validate_output_directory(path)

    def test_original_points_reconcile_and_baseline_matches_published_mae(self):
        dashboard = json.loads((ROOT / 'web/data/dashboard.json').read_text(encoding='utf-8'))
        points = json.loads((ROOT / 'web/data/points.json').read_text(encoding='utf-8'))
        rows = paired_rows(dashboard, points, protocol())
        self.assertEqual(len(rows), 156)
        training = [entry for entry in rows if entry['year'] < 2020]
        benchmark = [entry for entry in rows if entry['year'] >= 2020]
        model = fit_model(training, {'kind':'ratio'})
        self.assertAlmostEqual(model['alpha'], 676/5973)
        self.assertAlmostEqual(metrics(benchmark, predict(model, benchmark))['mae'], dashboard['validation']['mae']['adjusted'])
