"""Synthetic unit fixtures verify the offline source-normalization contract."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("decision_inputs", Path(__file__).parents[1] / "analysis" / "build_decision_inputs.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class DecisionInputsTests(unittest.TestCase):
    def test_conversions(self):
        """Given unit-coded observations, when normalized, then preserve physical quantities."""
        raw = {"id": "https://example.test/observation", "properties": {
            "station": "https://example.test/stations/TEST", "timestamp": "2026-11-15T12:00:00Z",
            "temperature": {"value": 68, "unitCode": "wmoUnit:degF", "qualityControl": "V"},
            "windSpeed": {"value": 36, "unitCode": "wmoUnit:km_h-1"},
            "windGust": {"value": 12, "unitCode": "wmoUnit:m_s-1"},
            "relativeHumidity": {"value": 50, "unitCode": "wmoUnit:percent"}}}
        result = MODULE.observation_data(raw, None)
        self.assertEqual(result["temperature_c"], 20)
        self.assertEqual(result["wind_mps"], 10)
        self.assertEqual(result["gust_mps"], 12)
        self.assertEqual(result["station_id"], "TEST")
        self.assertIn('"temperature": "V"', result["quality_note"])
        self.assertEqual(MODULE.convert(20, "C", "temperature"), 20)
        self.assertEqual(MODULE.convert(20, "wmoUnit:degC", "temperature"), 20)

    def test_missing(self):
        """Given absent sources, when built, then emit unavailable layers without invented values."""
        with tempfile.TemporaryDirectory() as directory:
            result = MODULE.build(directory, "2026-11-15T12:00:00Z")
        self.assertEqual(result["weather"]["forecast"]["status"], "unavailable")
        self.assertIsNone(result["weather"]["observation"]["temperature_c"])
        self.assertEqual(result["hyperspectral"]["status"], "unavailable")
        self.assertIsNone(MODULE.measurement({"value": None, "unitCode": "unknown"}, "wind"))
        with self.assertRaises(ValueError):
            MODULE.build(".")

    def test_forecast(self):
        """Given range winds and precipitation chance, when normalized, then retain both endpoints and percent."""
        raw = {"properties": {"updateTime": "2026-11-15T12:00:00Z", "generatedAt": "2026-11-15T12:01:00Z",
            "periods": [{"startTime": "2026-11-15T13:00:00Z", "endTime": "2026-11-15T14:00:00Z",
                         "temperature": 32, "temperatureUnit": "F", "windSpeed": "5 to 10 mph",
                         "probabilityOfPrecipitation": {"unitCode": "wmoUnit:percent", "value": 70}}]}}
        result = MODULE.forecast_data(raw, {"properties": {"forecastHourly": "https://example.test/hourly"}})
        period = result["periods"][0]
        self.assertAlmostEqual(period["wind_min_mps"], 2.2352)
        self.assertAlmostEqual(period["wind_max_mps"], 4.4704)
        self.assertEqual(period["temperature_c"], 0)
        self.assertEqual(period["precipitation_probability_pct"], 70)
        self.assertIsNone(period["relative_humidity_pct"])
        self.assertEqual(result["source_url"], "https://example.test/hourly")
        self.assertEqual(MODULE.wind_range("Calm"), (0, 0))
        with self.assertRaises(ValueError):
            MODULE.wind_range("10 to 5 mph")

    def test_scenes(self):
        """Given catalog scenes of two versions, when normalized, then expose only V001 with lon-lat coordinates."""
        title = "EMIT_L2A_RFL_001_20240423T183357_fixture"
        reflectance = "https://example.test/protected/" + title + ".nc"
        mask = reflectance.replace("_RFL_", "_MASK_")
        entry = {"id": "G1-TEST", "title": title, "time_start": "2024-04-23T18:33:57Z",
                 "polygons": [["34 -118 35 -118 35 -117 34 -118"]],
                 "links": [{"href": reflectance}, {"href": mask}, {"href": reflectance[:-3] + ".png"}]}
        other = dict(entry, title=title.replace("_001_", "_002_"))
        result = MODULE.hyperspectral_data({"feed": {"entry": [entry, other]}})
        self.assertEqual(result["status"], "catalog_only")
        self.assertEqual(len(result["scenes"]), 1)
        scene = result["scenes"][0]
        self.assertEqual(scene["geometry"]["coordinates"][0][0], [-118, 34])
        self.assertEqual(scene["reflectance_url"], reflectance)
        self.assertEqual(scene["mask_url"], mask)
        self.assertNotIn("value", result["index"])

    def test_malformed(self):
        """Given malformed JSON or impossible measurements, when built, then raise an error."""
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "nws-point.json").write_text("{broken", encoding="utf-8")
            with self.assertRaises(json.JSONDecodeError):
                MODULE.build(directory, "2026-11-15T12:00:00Z")
        for quantity, value, unit in [("wind", -1, "m_s-1"), ("percent", 101, "percent"),
                                      ("wind", 10, "unknown"), ("temperature", float("nan"), "C")]:
            with self.assertRaises(ValueError):
                MODULE.convert(value, unit, quantity)

    def test_manifest_and_timezone(self):
        """Given a retrieval manifest, when built, then use its explicit timezone-aware timestamp."""
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "manifest.json").write_text('{"retrieved_at":"2026-11-15T12:00:00Z"}', encoding="utf-8")
            self.assertEqual(MODULE.build(directory)["retrieved_at"], "2026-11-15T12:00:00Z")
            with self.assertRaises(ValueError):
                MODULE.build(directory, "2026-11-15T12:00:00")


if __name__ == "__main__":
    unittest.main()
