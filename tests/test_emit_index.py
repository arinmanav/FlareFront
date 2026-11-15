"""Synthetic small HDF5 fixtures exercise native-pixel extraction behavior."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

import h5py
import numpy as np

SPEC = importlib.util.spec_from_file_location("emit_index", Path(__file__).parents[1] / "analysis" / "build_emit_index.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def fixtures(directory):
    paths = [Path(directory) / ("EMIT_L2A_" + kind + "_001_20240423T183357_2411412_006.nc") for kind in ("RFL", "MASK")]
    for path in paths:
        with h5py.File(path, "w") as handle:
            handle.attrs.update(product_version="V001", flight_line="emit20240423t183357_o11412_s000",
                time_coverage_start="2024-04-23T18:33:57+0000", time_coverage_end="2024-04-23T18:34:08+0000",
                date_created="2024-04-25T23:41:02Z", title="Synthetic unit fixture")
            for key, unit, values in (("lat", "degrees north", [[34.3,34.3,34.3],[34.3,36,34.3]]),
                                      ("lon", "degrees east", np.full((2,3), -118.5))):
                dataset = handle.create_dataset("location/" + key, data=values)
                dataset.attrs["units"] = unit
            handle.create_group("sensor_band_parameters")
    with h5py.File(paths[0], "a") as handle:
        values = np.full((2,3,3), 0.2, dtype="float32")
        values[:,:,0] = 0.6
        values[1,0,0] = -1
        values[1,2,:] = 0
        dataset = handle.create_dataset("reflectance", data=values)
        dataset.attrs.update(units="unitless", _FillValue=np.float32(-9999))
        for name, values in (("wavelengths", [857.5,1000,1238]), ("fwhm", [8.5,8.5,8.5]), ("good_wavelengths", [1,1,1])):
            dataset = handle.create_dataset("sensor_band_parameters/" + name, data=values)
            if name != "good_wavelengths":
                dataset.attrs["units"] = "nm"
    with h5py.File(paths[1], "a") as handle:
        values = np.zeros((2,3,8), dtype="float32")
        values[0,1,7] = 1
        dataset = handle.create_dataset("mask", data=values)
        dataset.attrs.update(units="unitless", _FillValue=np.float32(-9999))
        values = np.zeros((2,3,1), dtype="uint8")
        values[0,2,0] = 128
        dataset = handle.create_dataset("band_mask", data=values)
        dataset.attrs.update(units="unitless", _FillValue=np.uint8(241))
        handle.create_dataset("sensor_band_parameters/mask_bands", data=np.array(
            ["Cloud flag", "Cirrus flag", "Water flag", "Spacecraft Flag", "Dilated Cloud Flag", "AOD550", "H2O (g cm-2)", "Aggregate Flag"], dtype="S32"))
    return paths


def five_index_fixtures(directory):
    paths = fixtures(directory)
    wavelengths = [500,531,570,660,678,750,820,860,1240,1600]
    values = [.1,.3,.1,.2,.5,.2,.4,.6,.2,.8]
    with h5py.File(paths[0], "a") as handle:
        del handle["reflectance"]
        dataset = handle.create_dataset("reflectance",data=np.tile(values,(2,3,1)).astype("float32"))
        dataset.attrs.update(units="unitless",_FillValue=np.float32(-9999))
        for name, data in (("wavelengths",wavelengths),("fwhm",np.full(10,8.5)),("good_wavelengths",np.ones(10))):
            del handle["sensor_band_parameters/"+name]
            dataset = handle.create_dataset("sensor_band_parameters/"+name,data=data)
            if name != "good_wavelengths":
                dataset.attrs["units"] = "nm"
    with h5py.File(paths[1], "a") as handle:
        del handle["band_mask"]
        dataset = handle.create_dataset("band_mask",data=np.zeros((2,3,2),dtype="uint8"))
        dataset.attrs.update(units="unitless",_FillValue=np.uint8(241))
    return paths


class EmitIndexTests(unittest.TestCase):
    def test_five_formulas(self):
        """Given known reflectances, when extracted, then match analytical formulas including ratios above one."""
        with tempfile.TemporaryDirectory() as directory:
            result = MODULE.build(*five_index_fixtures(directory),[-118.8,34.2,-118.2,34.7])
        expected = {"ndwi":.5,"ndvi":.5,"msi":2,"psri":2,"pri":.5}
        self.assertEqual(len(result["indices"]),5)
        for index in result["indices"]:
            self.assertEqual(index["status"],"measured")
            self.assertEqual(index["quality"]["valid_pixels"],4)
            for statistic in index["statistics"].values():
                self.assertAlmostEqual(statistic,expected[index["id"]],places=6)
            self.assertEqual(index["wavelength_tolerance_nm"],10 if index["id"] == "ndwi" else 5)
            self.assertIn("not independent modalities",index["approximation"])
            self.assertTrue(index["source_url"].startswith("https://"))
        self.assertEqual(result["statistics"],result["indices"][0]["statistics"])
        self.assertEqual(result["quality"],result["indices"][0]["quality"])

    def test_independent_screening(self):
        """Given target-specific exclusions, when extracted, then preserve independent sequential counters."""
        with tempfile.TemporaryDirectory() as directory:
            rfl, mask = five_index_fixtures(directory)
            with h5py.File(mask,"a") as handle:
                handle["band_mask"][0,0,1] = 64
            with h5py.File(rfl,"a") as handle:
                handle["reflectance"][0,2,6] = 0
                handle["reflectance"][1,0,4] = -1
                handle["reflectance"][1,2,1:3] = 0
            result = MODULE.build(rfl,mask,[-118.8,34.2,-118.2,34.7])
        indices = {index["id"]:index for index in result["indices"]}
        self.assertEqual([indices[key]["quality"]["valid_pixels"] for key in ("ndwi","ndvi","msi","psri","pri")],[4,4,2,3,3])
        self.assertEqual(indices["msi"]["quality"]["interpolated"],1)
        self.assertEqual(indices["msi"]["quality"]["invalid_reflectance"],1)
        for index in indices.values():
            quality = index["quality"]
            self.assertEqual(sum(quality[key] for key in ("aggregate_masked","interpolated","invalid_reflectance","valid_pixels")),quality["in_bbox"])

    def test_unavailable_indices(self):
        """Given an unusable nearest band, when extracted, then mark only affected formulas unavailable without substitution."""
        with tempfile.TemporaryDirectory() as directory:
            rfl, mask = five_index_fixtures(directory)
            with h5py.File(rfl,"a") as handle:
                handle["sensor_band_parameters/good_wavelengths"][1] = 0
                handle["sensor_band_parameters/wavelengths"][3] = 654
            result = MODULE.build(rfl,mask,[-118.8,34.2,-118.2,34.7])
            indices = {index["id"]:index for index in result["indices"]}
            for key in ("ndvi","pri"):
                self.assertEqual(indices[key]["status"],"unavailable")
                self.assertIsNone(indices[key]["statistics"])
                self.assertIsNone(indices[key]["quality"])
                self.assertIn("5 nm",indices[key]["reason"])
            self.assertEqual(indices["ndwi"]["status"],"measured")
            with h5py.File(rfl,"a") as handle:
                handle["sensor_band_parameters/good_wavelengths"][8] = 0
            with self.assertRaises(MODULE.BandUnavailableError):
                MODULE.build(rfl,mask,[-118.8,34.2,-118.2,34.7])

    def test_known_index(self):
        """Given matching synthetic files, when extracted, then preserve known index and exclusions."""
        with tempfile.TemporaryDirectory() as directory:
            result = MODULE.build(*fixtures(directory), [-118.8,34.2,-118.2,34.7])
        self.assertEqual(result["status"], "measured")
        self.assertEqual(result["quality"], {"native_pixels":6,"in_bbox":5,"aggregate_masked":1,
            "interpolated":1,"invalid_reflectance":2,"valid_pixels":1})
        for value in result["statistics"].values():
            self.assertAlmostEqual(value, 0.5)
        self.assertEqual(len(result["input_files"][0]["sha256"]), 64)

    def test_identity(self):
        """Given mismatched flight identity or geolocation, when extracted, then reject the pair."""
        with tempfile.TemporaryDirectory() as directory:
            rfl, mask = fixtures(directory)
            with h5py.File(mask, "a") as handle:
                handle.attrs["flight_line"] = "wrong"
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                MODULE.build(rfl, mask, [-118.8,34.2,-118.2,34.7])
            with h5py.File(mask, "a") as handle:
                handle.attrs["flight_line"] = "emit20240423t183357_o11412_s000"
                handle["location/lat"][0,0] = 34.4
            with self.assertRaisesRegex(ValueError, "geolocation differ"):
                MODULE.build(rfl, mask, [-118.8,34.2,-118.2,34.7])

    def test_no_valid(self):
        """Given aggregate-masked pixels only, when extracted, then emit null statistics."""
        with tempfile.TemporaryDirectory() as directory:
            rfl, mask = fixtures(directory)
            with h5py.File(mask, "a") as handle:
                handle["mask"][:,:,7] = 1
            result = MODULE.build(rfl, mask, [-118.8,34.2,-118.2,34.7])
        self.assertEqual(result["status"], "no_valid_pixels")
        self.assertIsNone(result["statistics"])
        self.assertEqual(result["quality"]["aggregate_masked"], 5)

    def test_band_selection(self):
        """Given an unusable nearest band, when selected, then fail rather than choose a different band."""
        with self.assertRaises(ValueError):
            MODULE.select_bands([857,865,1238], [0,1,1], [8,8,8])
        with self.assertRaises(ValueError):
            MODULE.select_bands([800,1000,1238], [1,1,1], [8,8,8])
        result = MODULE.select_bands([857,1000,1238], [1,1,1], [8,8,8])
        self.assertEqual([band["index"] for band in result], [0,2])

    def test_bit_order(self):
        """Given packed flags, when screened, then use MSB-first bits and reject declared byte fill."""
        values = np.array([128,1,0,241], dtype="uint8")
        self.assertEqual(MODULE.interpolation_flags(values,64,[241]).tolist(), [True,False,False,True])
        self.assertEqual(MODULE.interpolation_flags(values,7,[241]).tolist(), [False,True,False,True])

    def test_invalid_reflectance(self):
        """Given invalid retrieval values, when calculated, then reject without clipping retained values."""
        quality, stats = MODULE.calculate_index(np.array([[2.,np.nan,-1.,0.,999.]]),
            np.array([[1.,1.,1.,0.,1.]]),np.ones((1,5),bool),np.zeros((1,5)),np.zeros((1,5),bool),[999.])
        self.assertEqual(quality["invalid_reflectance"],4)
        self.assertAlmostEqual(stats["mean"],1/3)

    def test_ratio_denominators(self):
        """Given zero or negative denominators, when screened, then reject them while retaining valid negative contrasts."""
        quality, stats = MODULE.calculate_spectral_index("ratio",[np.array([[2.,2.,2.]]),np.array([[1.,0.,-1.]])],
            np.ones((1,3),bool),np.zeros((1,3)),np.zeros((1,3),bool))
        self.assertEqual(quality["invalid_reflectance"],2)
        self.assertEqual(stats["median"],2)
        quality, stats = MODULE.calculate_spectral_index("difference_ratio",
            [np.array([[.1,.1]]),np.array([[.5,.5]]),np.array([[.2,-.2]])],
            np.ones((1,2),bool),np.zeros((1,2)),np.zeros((1,2),bool))
        self.assertEqual(quality["invalid_reflectance"],1)
        self.assertAlmostEqual(stats["median"],-2)

    def test_unique_band_reads(self):
        """Given a band shared between formulas, when extracted, then read each selected reflectance slice only once."""
        class SliceReader:
            def __init__(self, values):
                self.values, self.indices = values, []

            def __getitem__(self, key):
                self.indices.append(key[2])
                return self.values[key]

        with tempfile.TemporaryDirectory() as directory:
            rfl, mask = five_index_fixtures(directory)
            with h5py.File(rfl,"r") as reflectance_file, h5py.File(mask,"r") as mask_file:
                reader = SliceReader(reflectance_file["reflectance"])
                MODULE.extract_indices(reader,mask_file["band_mask"],reflectance_file["sensor_band_parameters"],
                    np.ones((2,3),bool),mask_file["mask"][:,:,7])
        self.assertEqual(len(reader.indices),10)
        self.assertEqual(set(reader.indices),set(range(10)))


if __name__ == "__main__":
    unittest.main()
