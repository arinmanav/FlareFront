"""Behavior contracts for county detections and fixed-period calibration."""

from collections import defaultdict
from copy import deepcopy
import csv
from contextlib import redirect_stdout
import io
import json
import math
import os
from pathlib import Path
from statistics import median
import tempfile
import unittest
from zipfile import BadZipFile, ZIP_STORED, ZipFile
import zlib

from shapely.geometry import MultiPolygon, Polygon

from analysis.build_data import (aggregate_daily, aggregate_monthly, apply_main_series,
                                 build, calibrate, load_config, normalize_record,
                                 normalize_timestamp, qualify_records)
from analysis.stage_firms import inspect_archives


def detection(sensor="terra", **updates):
    row = {"source_archive": "modis_2013_all_countries.zip",
           "source_member": "modis/2013/modis_2013_United_States.csv",
           "latitude": "0.5", "longitude": "0.5", "brightness": "310",
           "bright_t31": "280", "scan": "1", "track": "1", "acq_date": "2013-01-01",
           "acq_time": "943", "satellite": "Terra", "instrument": "MODIS",
           "confidence": "30", "version": "6.03", "frp": "2.5", "daynight": "D", "type": "0"}
    if sensor == "aqua":
        row["satellite"] = "Aqua"
    elif sensor == "snpp":
        row.update(source_archive="viirs-snpp_2013_all_countries.zip",
                   source_member="viirs-snpp/2013/viirs-snpp_2013_United_States.csv",
                   satellite="N", instrument="VIIRS", confidence="n", version="2",
                   bright_ti4="310", bright_ti5="280")
        del row["brightness"], row["bright_t31"]
    row.update(updates)
    return row


def monthly_fixture():
    rows = [{"year": year, "month": month, "terra": 0, "aqua": 0, "snpp": 0}
            for year in range(2001, 2026) for month in range(1, 13)]
    for row in rows:
        if row["year"] == 2013 and row["month"] == 1:
            row.update(terra=10, snpp=20)
        elif row["year"] == 2013 and row["month"] == 2:
            row.update(terra=20, snpp=40)
        elif row["year"] >= 2020:
            row.update(terra=2, snpp=4)
    return rows


class AnalysisContractTests(unittest.TestCase):
    def test_staging_preserves_raw_rows_and_verifies_full_member(self):
        rows = [detection(latitude="34", longitude="-118", acq_time="0001"),
                detection(latitude="32.750", longitude="-118.952", acq_time="0943"),
                detection(latitude="40", longitude="-120", acq_time="1000")]
        fields = [field for field in rows[0] if not field.startswith("source_")]
        buffer = io.StringIO(newline="")
        writer = csv.DictWriter(buffer, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
        payload = buffer.getvalue().encode("utf-8")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / "modis_2013_all_countries.zip"
            member = "modis/2013/modis_2013_United_States.csv"
            with ZipFile(archive, "w", compression=ZIP_STORED) as bundle:
                bundle.writestr(member, payload)
            original = archive.read_bytes()
            output = directory / "staging"
            with redirect_stdout(io.StringIO()):
                inspect_archives(directory, "modis", 2013, 2013, output)
            with (output / "modis_envelope.csv").open(encoding="utf-8", newline="") as handle:
                retained = list(csv.DictReader(handle))
            self.assertEqual([row["acq_time"] for row in retained], ["0001", "0943"])
            self.assertEqual([row["version"] for row in retained], ["6.03", "6.03"])
            self.assertEqual(retained[0]["source_archive"], archive.name)
            self.assertEqual(retained[0]["source_member"], member)
            inventory_text = (output / "modis_inventory.json").read_text(encoding="utf-8")
            self.assertNotIn(str(directory), inventory_text)
            inventory = json.loads(inventory_text)
            year = inventory["years"][0]
            self.assertEqual((year["usa_rows"], year["envelope_rows"]), (3, 2))
            self.assertEqual(year["member_crc32"], f"{zlib.crc32(payload):08x}")
            self.assertTrue(year["member_crc32_verified"])
            self.assertEqual(year["member_uncompressed_bytes"], len(payload))
            self.assertEqual(year["archive"], archive.name)
            self.assertEqual(year["member_read_scope"], "entire USA member")
            self.assertEqual(archive.read_bytes(), original)

    def test_staging_rejects_corrupt_member(self):
        payload = b"latitude,longitude,acq_date,acq_time,satellite,confidence,version\n34,-118,2013-01-01,0001,Terra,30,6.03\n"
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / "modis_2013_all_countries.zip"
            with ZipFile(archive, "w", compression=ZIP_STORED) as bundle:
                bundle.writestr("modis/2013/modis_2013_United_States.csv", payload)
            contents = archive.read_bytes()
            payload_position = contents.index(payload)
            corrupted = bytearray(contents)
            corrupted[payload_position + len(payload) - 2] ^= 1
            archive.write_bytes(corrupted)
            output = directory / "staging"
            with self.assertRaises(BadZipFile), redirect_stdout(io.StringIO()):
                inspect_archives(directory, "modis", 2013, 2013, output)
            self.assertFalse((output / "modis_inventory.json").exists())

    def setUp(self):
        self.config = load_config()
        self.county = MultiPolygon([Polygon([(0, 0), (4, 0), (4, 4), (0, 4)],
                                             holes=[[(1, 1), (3, 1), (3, 3), (1, 3)]]),
                                    Polygon([(6, 0), (7, 0), (7, 1), (6, 1)])])

    def test_county_covers_boundaries_holes_and_island(self):
        coordinates = [(0.5, 0.5), (0, 2), (1, 2), (2, 2), (6.5, 0.5), (8, 8)]
        rows = [detection(longitude=str(lon), latitude=str(lat)) for lon, lat in coordinates]
        retained, quality = qualify_records(rows, self.county, self.config)
        self.assertEqual({(row["lon"], row["lat"]) for row in retained},
                         {(0.5, 0.5), (0, 2), (1, 2), (6.5, 0.5)})
        self.assertEqual(quality["exclusions"]["outside_county"], 2)

    def test_utc_time_padding_and_invalid_timestamp(self):
        self.assertEqual(normalize_timestamp("2013-01-01", "943"),
                         ("2013-01-01", "0943", "2013-01-01T09:43:00Z"))
        self.assertEqual(normalize_timestamp("2013-01-01", "0001")[1:],
                         ("0001", "2013-01-01T00:01:00Z"))
        row = normalize_record(detection())
        self.assertEqual(row["acq_time"], "943")
        self.assertEqual(row["time"], "0943")
        self.assertEqual(row["version"], "6.03")
        for day, time in [("2013-02-29", "1000"), ("2013-1-01", "943"),
                          ("2013-01-01", "2400"), ("2013-01-01", "1260"),
                          ("2013-01-01", "9.43"), ("2013-01-01", "")]:
            with self.subTest(day=day, time=time), self.assertRaises(ValueError):
                normalize_timestamp(day, time)

    def test_qualification_thresholds_and_categories(self):
        rows = [detection(confidence="29"), detection(confidence="30", acq_time="944"),
                detection("snpp", confidence="l"), detection("snpp", confidence="n", acq_time="945"),
                detection("snpp", confidence="h", acq_time="946"), detection(type="2", acq_time="947")]
        retained, quality = qualify_records(rows, self.county, self.config)
        self.assertEqual([(row["sensor"], row["confidence"]) for row in retained],
                         [("terra", "30"), ("snpp", "n"), ("snpp", "h")])
        self.assertEqual(quality["exclusions"]["low_confidence"], 2)
        self.assertEqual(quality["exclusions"]["non_vegetation_type"], 1)
        for updates in [{"satellite": "NOAA20"}, {"instrument": "other"}, {"type": "9"},
                        {"daynight": "X"}, {"confidence": "101"}, {"latitude": "nan"},
                        {"version": ""}, {"source_member": "../private.csv"}]:
            with self.subTest(updates=updates), self.assertRaises(ValueError):
                normalize_record(detection(**updates))
        with self.assertRaises(ValueError):
            normalize_record(detection("snpp", confidence="medium"))
        malformed = detection()
        malformed[None] = ["unexpected CSV field"]
        with self.assertRaises(ValueError):
            normalize_record(malformed)

    def test_deduplication_and_reconciliation(self):
        rows = [detection(), detection(acq_time="0943"), detection(acq_time="944"),
                detection("aqua"), detection(longitude="8", type="2", confidence="0"),
                detection(type="2", confidence="0"), detection(confidence="0"),
                detection(acq_date="2000-12-31")]
        retained, quality = qualify_records(rows, self.county, self.config)
        self.assertEqual(len(retained), 3)
        self.assertEqual(quality["duplicates"], 1)
        self.assertEqual(quality["exclusions"], {"outside_period": 1, "outside_county": 1,
                                               "non_vegetation_type": 1, "low_confidence": 1})
        self.assertEqual(quality["raw_candidates"], quality["qualifying"] + quality["duplicates"]
                         + sum(quality["exclusions"].values()))
        self.assertEqual({row["time"] for row in retained}, {"0943", "0944"})
        for counts in quality["by_sensor"].values():
            self.assertEqual(counts["raw_candidates"], counts["qualifying"] + counts["duplicates"]
                             + sum(counts["exclusions"].values()))

    def test_training_coefficient_ignores_holdout(self):
        months = monthly_fixture()
        result = calibrate(months, self.config)
        self.assertEqual(result["training"]["terra_total"], 30)
        self.assertEqual(result["training"]["snpp_total"], 60)
        self.assertEqual(result["alpha"], 0.5)
        for row in months:
            if row["year"] >= 2020:
                row.update(terra=10000, snpp=1)
        self.assertEqual(calibrate(months, self.config)["alpha"], 0.5)
        for row in months:
            if 2013 <= row["year"] <= 2019:
                row["snpp"] = 0
        with self.assertRaises(ValueError):
            calibrate(months, self.config)

    def test_validation_baselines_and_strict_pass(self):
        months = monthly_fixture()
        for row in months:
            if 2013 <= row["year"] <= 2019:
                row.update(terra=2 * (row["year"] - 2013), snpp=4 * (row["year"] - 2013))
            elif row["year"] >= 2020:
                row.update(terra=10, snpp=20)
        result = calibrate(months, self.config)
        self.assertEqual(result["mae"], {"adjusted": 0, "unscaled": 10, "seasonal": 4})
        self.assertTrue(result["passed"])
        self.assertEqual(result["test"]["months"], 72)
        self.assertEqual(result["seasonal_training_medians"], dict.fromkeys(range(1, 13), 6))
        self.assertEqual([group["months"] for group in result["version_groups"]], [36, 36])
        for row in months:
            if row["year"] >= 2020:
                row.update(terra=6, snpp=12)
        tied = calibrate(months, self.config)
        self.assertEqual(tied["mae"]["adjusted"], tied["mae"]["seasonal"])
        self.assertFalse(tied["passed"])
        eligible = deepcopy(months)
        next(row for row in eligible if row["year"] == 2020 and row["month"] == 1)["snpp"] = None
        missing = calibrate(eligible, self.config)
        self.assertEqual(missing["test"]["months"], 71)
        self.assertEqual(missing["test"]["excluded_months"],
                         [{"year": 2020, "month": 1, "reason": "proven_source_unavailability"}])
        self.assertEqual(missing["mae"], {"adjusted": 0, "unscaled": 6, "seasonal": 0})
        with self.assertRaises(ValueError):
            calibrate(months + [deepcopy(months[-1])], self.config)

    def test_peer_year_median_excludes_selected_year(self):
        months = [{"year": year, "month": 1, "terra": value, "snpp": value}
                  for year, value in [(2001, 2), (2002, 4), (2003, 100)]]
        apply_main_series([], months, 0.5, self.config)
        self.assertEqual([row["median"] for row in months], [52, 51, 3])
        self.assertEqual([row["baseline_n"] for row in months], [2, 2, 2])
        self.assertEqual([row["anomaly"] for row in months], [-50, -47, 97])

    def test_unavailable_versus_zero(self):
        daily = aggregate_daily([], self.config)
        by_date = {row["date"]: row for row in daily}
        self.assertIsNone(by_date["2012-01-19"]["snpp"])
        self.assertEqual(by_date["2012-01-20"]["snpp"], 0)
        self.assertIsNone(by_date["2002-06-30"]["aqua"])
        self.assertEqual(by_date["2002-07-01"]["aqua"], 0)
        months = aggregate_monthly(daily, [], self.config)
        self.assertEqual(len(months), 300)
        self.assertIsNone(months[0]["snpp"])
        january_2012 = next(row for row in months if (row["year"], row["month"]) == (2012, 1))
        self.assertEqual(january_2012["snpp"], 0)
        self.assertEqual(january_2012["availability"]["snpp"], "partial_first_month_coverage_unknown")
        july_2002 = next(row for row in months if (row["year"], row["month"]) == (2002, 7))
        self.assertEqual(july_2002["availability"]["aqua"], "partial_first_month_coverage_unknown")
        self.assertTrue(july_2002["partial_first_year"]["aqua"])
        gap_config = deepcopy(self.config)
        gap_config["known_source_gaps"] = [{"sensor": "snpp", "start_date": "2020-01-15", "end_date": "2020-01-15"}]
        gap_daily = aggregate_daily([], gap_config)
        gap_months = aggregate_monthly(gap_daily, [], gap_config)
        self.assertIsNone(next(row for row in gap_daily if row["date"] == "2020-01-15")["snpp"])
        gap_january = next(row for row in gap_months if (row["year"], row["month"]) == (2020, 1))
        self.assertIsNone(gap_january["snpp"])
        self.assertEqual(gap_january["availability"]["snpp"], "source_gap")

    def test_real_pipeline_contract(self):
        configured = os.environ.get("FLAREFRONT_INPUT_DIR")
        candidates = [Path(configured)] if configured else [parent / "data" / "staging" for parent in Path(__file__).resolve().parents]
        input_dir = next((path for path in candidates if (path / "modis_envelope.csv").is_file()), None)
        if input_dir is None:
            self.skipTest("Staged source data unavailable; set FLAREFRONT_INPUT_DIR to run the real-data acceptance case")
        with tempfile.TemporaryDirectory() as temporary:
            output_dir = Path(temporary)
            dashboard = build(input_dir, output_dir)
            self.assertEqual(len(dashboard["months"]), 300)
            self.assertEqual([(row["year"], row["month"]) for row in dashboard["months"]],
                             [(year, month) for year in range(2001, 2026) for month in range(1, 13)])
            self.assertTrue(math.isfinite(dashboard["meta"]["alpha"]))
            self.assertGreater(dashboard["meta"]["alpha"], 0)
            self.assertFalse(dashboard["meta"]["coverage_verified"])
            acknowledgment = "AI assisted code editor was used for code development"
            self.assertEqual(dashboard["meta"]["software_development"], acknowledgment)
            with (output_dir / "hotspots.csv").open(encoding="utf-8", newline="") as handle:
                detections = list(csv.DictReader(handle))
            self.assertEqual(len(detections), dashboard["quality"]["qualifying"])
            for sensor in ("terra", "aqua", "snpp"):
                self.assertEqual(sum(row["sensor"] == sensor for row in detections),
                                 sum(row[sensor] or 0 for row in dashboard["months"]))
            training = [row for row in detections if "2013-01-01" <= row["date"] <= "2019-12-31"]
            terra = sum(row["satellite"] == "Terra" for row in training)
            snpp = sum(row["satellite"] == "N" for row in training)
            self.assertEqual(dashboard["meta"]["alpha"], terra / snpp)
            self.assertEqual({row["version"] for row in detections if row["instrument"] == "MODIS"},
                             {"6.2", "6.03", "61.03"})
            daily_totals = defaultdict(lambda: defaultdict(float))
            for day in dashboard["daily"]:
                for sensor in ("terra", "aqua", "snpp", "main"):
                    if day[sensor] is not None:
                        daily_totals[day["date"][:7]][sensor] += day[sensor]
            for month in dashboard["months"]:
                key = f"{month['year']:04d}-{month['month']:02d}"
                for sensor in ("terra", "aqua", "snpp", "main"):
                    if month[sensor] is not None:
                        self.assertAlmostEqual(month[sensor], daily_totals[key][sensor], places=9)
                peers = [row["main"] for row in dashboard["months"] if row["month"] == month["month"]
                         and row["year"] != month["year"] and row["main"] is not None]
                self.assertEqual(month["median"], median(peers))
            for path in output_dir.iterdir():
                text = path.read_text(encoding="utf-8")
                self.assertNotIn("C:\\Users", text)
                self.assertNotIn("C:/Users", text)
                self.assertNotIn("NaN", text)
            points = json.loads((output_dir / "points.json").read_text(encoding="utf-8"))
            self.assertEqual(points["meta"]["software_development"], acknowledgment)
            self.assertEqual(points["columns"], ["date", "time", "lat", "lon", "sensor", "confidence",
                                                 "version", "frp", "source_archive", "source_member"])
            self.assertEqual(len(points["rows"]), len(detections))
            self.assertTrue(all(len(row[1]) == 4 for row in points["rows"]))
            self.assertEqual(json.loads((output_dir / "county.geojson").read_text(encoding="utf-8")),
                             json.loads((input_dir / "los_angeles_county_2026.geojson").read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
