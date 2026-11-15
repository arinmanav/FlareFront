from copy import deepcopy
import json
import unittest

from analysis.build_spatial_harmonization import (PROTOCOL_PATH, ROOT, evaluate, fit,
    monthly_occupancy, occupied_cells, predict, prepare_rows, project, select)


def protocol():
    return json.loads(PROTOCOL_PATH.read_text(encoding='utf-8'))


def history():
    return [{'year': year, 'month': month, 'terra': 2 * month, 'snpp': month, 'occupancy': month / 2}
            for year in range(2013, 2026) for month in range(1, 13)]


class SpatialHarmonizationTests(unittest.TestCase):
    def test_same_location_counts_once_per_acquisition_and_again_next_pass(self):
        """Given duplicate positions at 10:00/10:02 and 11:40, aggregation returns two occupied cells."""
        points = {'columns': ['date', 'time', 'lat', 'lon', 'sensor'], 'rows': [
            ['2020-01-01', '1000', 34, -118, 'snpp'], ['2020-01-01', '1002', 34, -118, 'snpp'],
            ['2020-01-01', '1140', 34, -118, 'snpp'], ['2020-01-01', '1140', 34, -118, 'terra']]}
        original = deepcopy(points)
        self.assertEqual(monthly_occupancy(points, protocol()['grid']), {(2020, 1): 2})
        self.assertEqual(points, original)
        points['rows'][2][1] = '1022'
        self.assertEqual(monthly_occupancy(points, protocol()['grid'])[(2020, 1)], 1)
        points['rows'][2][1] = '1023'
        self.assertEqual(monthly_occupancy(points, protocol()['grid'])[(2020, 1)], 2)
        points['rows'][2][0] = '2020-02-01'
        self.assertEqual(monthly_occupancy(points, protocol()['grid']), {(2020, 1): 1, (2020, 2): 1})

    def test_fixed_offsets_reduce_grid_boundary_dependence(self):
        """Given two nearby points straddling one grid origin, the four-origin mean is 1.5."""
        grid = protocol()['grid']
        self.assertEqual(occupied_cells([(-1, 1), (1, 1)], grid), 1.5)
        self.assertEqual(occupied_cells([], grid), 0)
        self.assertEqual(project(0, 0, grid), (0, 0))
        self.assertAlmostEqual(project(36, 0, grid)[1], grid['radius_metres'] * .7265425280053609)

    def test_ratio_and_absolute_error_fit_obey_independent_examples(self):
        """Given feature [1,2,3] and targets [1,2,30], ratio is 5.5 and lower weighted-median slope is 1."""
        rows = [{'year': 2013, 'terra': y, 'snpp': x} for x, y in [(1, 1), (2, 2), (3, 30)]]
        ratio = fit(rows, {'feature': 'snpp', 'fit': 'ratio'})
        lad = fit(rows, {'feature': 'snpp', 'fit': 'lad'})
        self.assertEqual(ratio['coefficient'], 5.5)
        self.assertEqual(lad['coefficient'], 1)
        self.assertEqual(predict(lad, [{'snpp': 0}, {'snpp': 10}]), [0, 10])
        rows.append({'year': 2013, 'terra': 1000, 'snpp': 0})
        self.assertEqual(fit(rows, {'feature': 'snpp', 'fit': 'lad'})['coefficient'], 1)

    def test_future_reference_changes_do_not_change_selection_or_outputs(self):
        """Given the same training record, changing later Terra targets leaves every coefficient and output unchanged."""
        rows = history()
        initial = evaluate(rows, protocol())
        for row in rows:
            if row['year'] >= 2020:
                row['terra'] += 999
        modified = evaluate(rows, protocol())
        self.assertEqual(initial['models'], modified['models'])
        self.assertEqual(initial['selection'], modified['selection'])
        self.assertEqual([row['selected'] for row in initial['months']], [row['selected'] for row in modified['months']])
        with self.assertRaisesRegex(ValueError, 'outside the training'):
            select(rows, protocol())

    def test_missing_or_invalid_inputs_fail_without_zero_filling(self):
        """Given missing counts or invalid coordinates/times, spatial comparison rejects the input."""
        for invalid in [None, float('nan'), -1]:
            with self.assertRaisesRegex(ValueError, 'finite nonnegative'):
                fit([{'terra': invalid, 'snpp': 1}], {'feature': 'snpp', 'fit': 'ratio'})
        with self.assertRaisesRegex(ValueError, 'Invalid source coordinates'):
            project(91, 0, protocol()['grid'])
        with self.assertRaisesRegex(ValueError, 'HHMM'):
            monthly_occupancy({'columns': ['date', 'time', 'lat', 'lon', 'sensor'],
                               'rows': [['2020-01-01', '2460', 34, -118, 'snpp']]}, protocol()['grid'])
        with self.assertRaisesRegex(ValueError, 'complete, unique'):
            evaluate(history()[:-1], protocol())

    def test_real_data_reconciles_with_original_count_ratio(self):
        """Given the bundled LA points, counts reconcile and the baseline coefficient remains 676/5973."""
        dashboard = json.loads((ROOT / 'web/data/dashboard.json').read_text(encoding='utf-8'))
        points = json.loads((ROOT / 'web/data/points.json').read_text(encoding='utf-8'))
        rows = prepare_rows(dashboard, points, protocol())
        result = evaluate(rows, protocol())
        self.assertEqual(len(rows), 156)
        self.assertEqual(len(result['months']), 72)
        self.assertAlmostEqual(result['models']['ratio']['coefficient'], 676 / 5973)
        self.assertAlmostEqual(result['metrics']['ratio']['mae'], dashboard['validation']['mae']['adjusted'])
