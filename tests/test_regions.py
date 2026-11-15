"""Behavior contracts for county-specific staging and sparse calibration."""

from contextlib import redirect_stdout
import csv
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile
import zlib

from analysis.build_data import apply_main_series, build, calibrate, load_config, load_county
from analysis.build_regions import build_regions, load_regions
from analysis.stage_firms import inspect_region_archives

PILOT_REGISTRY = {'schema_version': 1, 'default_region': 'los-angeles', 'regions': [
    {'id': 'los-angeles', 'city': 'Los Angeles', 'county': 'Los Angeles County', 'geoid': '06037', 'data_path': '.'},
    {'id': 'san-diego', 'city': 'San Diego', 'county': 'San Diego County', 'geoid': '06073', 'data_path': 'regions/san-diego'},
    {'id': 'san-jose', 'city': 'San Jose', 'county': 'Santa Clara County', 'geoid': '06085', 'data_path': 'regions/san-jose'},
    {'id': 'sacramento', 'city': 'Sacramento', 'county': 'Sacramento County', 'geoid': '06067', 'data_path': 'regions/sacramento'},
]}


def archive(directory, product="modis", year=2013, coordinates=(0.5,1,1.5,3)):
    fields = ["latitude", "longitude", "acq_date", "acq_time", "satellite", "instrument", "confidence", "version",
              "scan", "track", "frp", "daynight", "type"]
    fields += ["brightness", "bright_t31"] if product == "modis" else ["bright_ti4", "bright_ti5"]
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fields)
    writer.writeheader()
    for longitude in coordinates:
        row = dict.fromkeys(fields, "1")
        row.update(latitude="0.5", longitude=str(longitude), acq_date=f"{year}-01-01", acq_time="0001",
                   satellite="Terra" if product == "modis" else "N", instrument="MODIS" if product == "modis" else "VIIRS",
                   confidence="50" if product == "modis" else "n", version="6.03" if product == "modis" else "2",
                   daynight="D", type="0")
        writer.writerow(row)
    payload = buffer.getvalue().encode()
    path = directory / f"{product}_{year}_all_countries.zip"
    with ZipFile(path, "w") as bundle:
        bundle.writestr(f"{product}/{year}/{product}_{year}_United_States.csv", payload)
    return payload


def boundary(path, geoid="06073"):
    value = {"type":"FeatureCollection", "features":[{"type":"Feature", "properties":{"GEOID":geoid},
        "geometry":{"type":"Polygon", "coordinates":[[[0,0],[2,0],[2,1],[0,1],[0,0]]]}}]}
    path.write_text(json.dumps(value), encoding="utf-8")
    return value


def short_config():
    return {**load_config(), "county_geoid":"06073", "county_name":"San Diego County", "start_date":"2013-01-01", "snpp_start_date":"2013-01-01",
        "end_date":"2014-12-31", "fit_start_year":2013, "fit_end_year":2013,
        "test_start_year":2014, "test_end_year":2014, "validation_groups":[[2014,2014]]}


def staged_fixture(directory, coordinates):
    regions = {"fixture":{"bounds":(0,0,2,1),"output_dir":directory / "stage"}}
    for product in ("modis", "viirs-snpp"):
        for year in (2013,2014):
            archive(directory, product, year, coordinates)
        with redirect_stdout(io.StringIO()):
            inspect_region_archives(directory,product,2013,2014,regions)
    return directory / "stage"


class RegionTests(unittest.TestCase):
    def test_stream_regions(self):
        """Given overlapping envelopes, when staged together, then read one member and retain each boundary point."""
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            payload = archive(directory)
            regions = {"west":{"bounds":(0,0,1,1),"output_dir":directory / "west"},
                       "east":{"bounds":(1,0,2,1),"output_dir":directory / "east"}}
            with redirect_stdout(io.StringIO()), patch("analysis.stage_firms.ZipFile", wraps=ZipFile) as opened:
                reports = inspect_region_archives(directory,"modis",2013,2013,regions)
            self.assertEqual(opened.call_count,1)
            for key, longitudes in (("west",["0.5","1"]),("east",["1","1.5"])):
                with (directory/key/"modis_envelope.csv").open(newline="",encoding="utf-8") as handle:
                    rows = list(csv.DictReader(handle))
                self.assertEqual([row["longitude"] for row in rows],longitudes)
                report = reports[key]["years"][0]
                self.assertEqual((report["usa_rows"],report["envelope_rows"]),(4,2))
                self.assertEqual(report["member_crc32"],f"{zlib.crc32(payload):08x}")
                self.assertTrue(report["member_crc32_verified"])
                self.assertEqual(rows[0]["acq_time"],"0001")

    def test_boundary_parameter(self):
        """Given an alternative county polygon, when built, then use its identity and retain the LA default config."""
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            staged = staged_fixture(directory,[0.5])
            path = directory/"county.geojson"
            expected = boundary(path)
            result = build(staged,directory/"output",short_config(),path,allow_unestimable=True)
            self.assertEqual(result["meta"]["geoid"],"06073")
            self.assertEqual(result["meta"]["county"],"San Diego County")
            self.assertEqual(result["meta"]["alpha"],1)
            self.assertEqual(json.loads((directory/"output"/"county.geojson").read_text()),expected)
            with self.assertRaises(ValueError):
                load_county(path,"06037")
        self.assertEqual(load_config()["county_geoid"],"06037")

    def test_sparse_county(self):
        """Given zero training counts, when sparse mode is explicit, then emit null estimates and preserve raw zero reports."""
        config = short_config()
        rows = [{"year":year,"month":month,"terra":0,"snpp":0,"aqua":0} for year in (2013,2014) for month in range(1,13)]
        with self.assertRaises(ValueError):
            calibrate(rows,config)
        validation = calibrate(rows,config,allow_unestimable=True)
        self.assertIsNone(validation["alpha"])
        self.assertFalse(validation["passed"])
        self.assertEqual(validation["status"],"unestimable")
        apply_main_series([],rows,validation["alpha"],config)
        self.assertTrue(all(row["main"] is None and row["terra"] == 0 for row in rows))

    def test_independent_calibration(self):
        """Given two regional training ratios, when fitted, then keep separate coefficients despite held-out extremes."""
        config = short_config()
        first = [{"year":year,"month":month,"terra":2 if year == 2013 else 10000,"snpp":4} for year in (2013,2014) for month in range(1,13)]
        second = [{**row,"terra":1 if row["year"] == 2013 else 999999} for row in first]
        self.assertEqual(calibrate(first,config)["alpha"],0.5)
        self.assertEqual(calibrate(second,config)["alpha"],0.25)

    def test_empty_export(self):
        """Given empty regional observations, when built, then produce a usable empty point export and null estimates."""
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            staged = staged_fixture(directory,[])
            path = directory/"county.geojson"
            boundary(path)
            result = build(staged,directory/"output",short_config(),path,allow_unestimable=True)
            self.assertEqual(result["quality"]["qualifying"],0)
            with (directory/"output"/"hotspots.csv").open(newline="",encoding="utf-8") as handle:
                reader = csv.DictReader(handle)
                self.assertIn("source_archive",reader.fieldnames)
                self.assertEqual(list(reader),[])
            points = json.loads((directory/"output"/"points.json").read_text())
            self.assertEqual(points["rows"],[])
            self.assertTrue(all(row["main"] is None for row in result["months"]))

    def test_registry(self):
        """Given the selected registry, retain its frozen rank order and explicit county coverage."""
        registry = load_regions()
        self.assertEqual([region["id"] for region in registry["regions"]],
            ["lake","shasta","siskiyou","glenn","mariposa"])
        self.assertEqual(registry["default_region"],"lake")
        self.assertTrue(all(region['county'].endswith(' County') and region['data_path'] == 'regions/' + region['id'] for region in registry['regions']))

    def test_orchestrator_preserves_la(self):
        """Given three synthetic county inputs, when built together, then read four ZIPs and leave LA bytes unchanged."""
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for product in ("modis", "viirs-snpp"):
                for year in (2013,2014):
                    archive(directory,product,year,[0.5])
            for region in PILOT_REGISTRY["regions"][1:]:
                destination = directory/"boundaries"/region["id"]
                destination.mkdir(parents=True)
                boundary(destination/"county.geojson",region["geoid"])
            output = directory/"output"
            output.mkdir()
            (output/"dashboard.json").write_bytes(b"existing LA fixture")
            with redirect_stdout(io.StringIO()), patch("analysis.stage_firms.ZipFile",wraps=ZipFile) as opened, patch("analysis.build_regions.load_regions", return_value=PILOT_REGISTRY):
                results = build_regions(directory,directory/"boundaries",directory/"staging",output,config=short_config())
            self.assertEqual(opened.call_count,4)
            self.assertEqual(set(results),{"san-diego","san-jose","sacramento"})
            self.assertEqual((output/"dashboard.json").read_bytes(),b"existing LA fixture")
            self.assertEqual(results["san-jose"]["meta"]["county"],"Santa Clara County")
            self.assertTrue((output/"regions"/"san-diego"/"calendar.csv").exists())
            with self.assertRaises(ValueError):
                build_regions(directory,directory/"boundaries",directory/"staging",output,["los-angeles"],short_config())


if __name__ == "__main__":
    unittest.main()
