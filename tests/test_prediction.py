import unittest
from datetime import date, timedelta
import json

from analysis.build_prediction import PROTOCOL, observed_outcomes, rank_window, score_pick, windows


class PredictionContracts(unittest.TestCase):
    def test_future_and_embargoed_points_cannot_change_prediction(self):
        """Given a frozen origin, adding later observations leaves its ranked selections unchanged."""
        protocol = json.loads(PROTOCOL.read_text())
        origin = date(2024, 1, 1)
        points = [{'date': date(2013, 1, 1), 'cell': '1:1', 'sensor': 'snpp'},
                  {'date': date(2023, 12, 20), 'cell': '1:1', 'sensor': 'snpp'}]
        before = rank_window(points, ['1:1', '1:2'], origin, .1, protocol)
        later = [{'date': day, 'cell': '1:2', 'sensor': sensor}
                 for day in [origin - timedelta(days=2), origin, origin + timedelta(days=30)]
                 for sensor in ['snpp', 'terra'] for _ in range(100)]
        self.assertEqual(before, rank_window(points + later, ['1:1', '1:2'], origin, .1, protocol))

    def test_only_matching_location_and_week_is_a_hit(self):
        """Given one observed cell-week, only that exact pair scores a hit; quiet windows score zero."""
        outcomes = [{'cell': '1:2', 'week': 2, 'detections': 5}]
        self.assertTrue(score_pick({'cell': '1:2', 'week': 2}, outcomes)['hit'])
        self.assertFalse(score_pick({'cell': '1:1', 'week': 2}, outcomes)['hit'])
        self.assertFalse(score_pick({'cell': '1:2', 'week': 1}, outcomes)['hit'])
        self.assertFalse(score_pick({'cell': '1:2', 'week': 2}, [])['hit'])

    def test_windows_are_complete_disjoint_and_include_quiet_periods(self):
        """Given 731 evaluation days, there are 26 complete 28-day windows, independent of observations."""
        protocol = json.loads(PROTOCOL.read_text())
        origins = list(windows(protocol))
        self.assertEqual(len(origins), 26)
        self.assertEqual(origins[0], date(2024, 1, 1))
        self.assertEqual(origins[-1] + timedelta(days=28), date(2025, 12, 29))
        self.assertTrue(all(b - a == timedelta(days=28) for a, b in zip(origins, origins[1:])))
        self.assertEqual(observed_outcomes([], origins[0], protocol), [])

    def test_no_history_ties_are_deterministic(self):
        """Given empty input, every method selects week zero and the first grid cell without inventing evidence."""
        protocol = json.loads(PROTOCOL.read_text())
        picks, _, _ = rank_window([], ['1:1', '1:2'], date(2024, 1, 1), .1, protocol)
        self.assertEqual(set(picks), set(protocol['methods']))
        for pick in picks.values():
            self.assertEqual(pick, {'cell': '1:1', 'week': 0, 'score': 0})

    def test_outcome_endpoints_and_sensor_are_respected(self):
        protocol = json.loads(PROTOCOL.read_text())
        origin = date(2024, 1, 1)
        points = [{'date': origin + timedelta(days=offset), 'cell': '1:1', 'sensor': sensor}
                  for offset, sensor in [(-1, 'snpp'), (0, 'snpp'), (6, 'snpp'), (7, 'snpp'),
                                         (27, 'snpp'), (28, 'snpp'), (2, 'terra')]]
        self.assertEqual(observed_outcomes(points, origin, protocol), [
            {'cell': '1:1', 'week': 0, 'detections': 2}, {'cell': '1:1', 'week': 1, 'detections': 1},
            {'cell': '1:1', 'week': 3, 'detections': 1}])

    def test_training_cannot_extend_past_origin(self):
        protocol = json.loads(PROTOCOL.read_text())
        with self.assertRaises(ValueError):
            rank_window([], ['1:1'], date(2019, 1, 1), .1, protocol)
