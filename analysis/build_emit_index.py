"""Extract five quality-screened spectral indices from matching native V001 EMIT files."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

import h5py
import numpy as np


INDEX_DEFINITIONS = (
    {"id": "ndwi", "name": "Gao NDWI", "formula": "(R860 - R1240) / (R860 + R1240)",
     "targets": (860, 1240), "operation": "normalized_difference", "wavelength_tolerance_nm": 10,
     "source_url": "https://doi.org/10.1016/S0034-4257(96)00067-3",
     "interpretation": "Nonwater surface water-sensitive spectral contrast; not measured vegetation water or fuel moisture."},
    {"id": "ndvi", "name": "NDVI", "formula": "(R860 - R660) / (R860 + R660)",
     "targets": (860, 660), "operation": "normalized_difference", "wavelength_tolerance_nm": 5,
     "source_url": "https://doi.org/10.1016/S0034-4257(96)00067-3",
     "interpretation": "Red-near-infrared spectral contrast; no independent vegetation classification is supplied."},
    {"id": "msi", "name": "Moisture Stress Index", "formula": "R1600 / R820",
     "targets": (1600, 820), "operation": "ratio", "wavelength_tolerance_nm": 5,
     "source_url": "https://doi.org/10.1016/0034-4257(89)90046-1",
     "interpretation": "Water-sensitive reflectance ratio; not a measured stress level or calibrated fuel-moisture estimate."},
    {"id": "psri", "name": "Plant Senescence Reflectance Index", "formula": "(R678 - R500) / R750",
     "targets": (678, 500, 750), "operation": "difference_ratio", "wavelength_tolerance_nm": 5,
     "source_url": "https://onlinelibrary.wiley.com/doi/10.1034/j.1399-3054.1999.106119.x",
     "interpretation": "Pigment-sensitive reflectance contrast; no independently verified vegetation senescence is established."},
    {"id": "pri", "name": "Photochemical Reflectance Index", "formula": "(R531 - R570) / (R531 + R570)",
     "targets": (531, 570), "operation": "normalized_difference", "wavelength_tolerance_nm": 5,
     "source_url": "https://nph.onlinelibrary.wiley.com/doi/10.1111/j.1469-8137.1995.tb03064.x",
     "interpretation": "Visible-band reflectance contrast; not a validated physiological condition or fire-probability estimate."},
)


class BandUnavailableError(ValueError):
    """A requested spectral center cannot be represented by a usable nearby band."""


def text(value):
    return value.decode("utf-8") if isinstance(value, bytes) else str(value)


def require_units(dataset, expected):
    if text(dataset.attrs.get("units", "")) != expected:
        raise ValueError(f"Unexpected units for {dataset.name}")


def fill_values(dataset):
    return np.asarray(dataset.attrs.get("_FillValue", [])).reshape(-1)


def select_bands(wavelengths, good, fwhm, targets=(860, 1240), tolerance_nm=10):
    wavelengths, good, fwhm = map(np.asarray, (wavelengths, good, fwhm))
    if wavelengths.ndim != 1 or good.shape != wavelengths.shape or fwhm.shape != wavelengths.shape:
        raise ValueError("Inconsistent spectral parameters")
    if not np.all(np.isfinite(wavelengths)) or not np.all(np.diff(wavelengths) > 0):
        raise ValueError("Wavelength centers must be finite and increasing")
    result = []
    for target in targets:
        index = int(np.argmin(abs(wavelengths - target)))
        if abs(wavelengths[index] - target) > tolerance_nm or good[index] != 1:
            raise BandUnavailableError(f"Nearest band to {target} nm is unusable or exceeds {tolerance_nm} nm tolerance")
        if not np.isfinite(fwhm[index]) or fwhm[index] <= 0:
            raise ValueError("Selected FWHM must be finite and positive")
        result.append({"target_nm": target, "index": index,
                       "wavelength_nm": float(wavelengths[index]), "fwhm_nm": float(fwhm[index])})
    return result


def interpolation_flags(packed_byte, band_index, fills=()):
    packed_byte = np.asarray(packed_byte)
    if packed_byte.dtype != np.uint8:
        raise ValueError("Packed band mask must be uint8")
    flagged = ((packed_byte >> (7 - band_index % 8)) & 1).astype(bool)
    for fill in fills:
        flagged |= packed_byte == fill
    return flagged


def calculate_spectral_index(operation, reflectances, in_bbox, aggregate, interpolation, reflectance_fills=(), aggregate_fills=()):
    reflectances = [np.asarray(value) for value in reflectances]
    arrays = [*reflectances, np.asarray(in_bbox), np.asarray(aggregate), np.asarray(interpolation)]
    if not reflectances or any(array.shape != arrays[0].shape for array in arrays):
        raise ValueError("Native pixel arrays must have identical shapes")
    in_bbox, aggregate, interpolation = arrays[-3:]
    first, second = reflectances[:2]
    retained = in_bbox.astype(bool).copy()
    quality = {"native_pixels": first.size, "in_bbox": int(np.count_nonzero(retained))}
    bad_aggregate = ~np.isfinite(aggregate) | (aggregate != 0)
    for fill in aggregate_fills:
        bad_aggregate |= aggregate == fill
    quality["aggregate_masked"] = int(np.count_nonzero(retained & bad_aggregate))
    retained &= ~bad_aggregate
    quality["interpolated"] = int(np.count_nonzero(retained & interpolation))
    retained &= ~interpolation.astype(bool)
    invalid = np.zeros(first.shape, dtype=bool)
    for values in reflectances:
        invalid |= ~np.isfinite(values) | (values < 0)
        for fill in reflectance_fills:
            invalid |= values == fill
    if operation == "normalized_difference" and len(reflectances) == 2:
        numerator = first.astype(np.float64) - second
        denominator = first.astype(np.float64) + second.astype(np.float64)
    elif operation == "ratio" and len(reflectances) == 2:
        numerator, denominator = first.astype(np.float64), second.astype(np.float64)
    elif operation == "difference_ratio" and len(reflectances) == 3:
        numerator = first.astype(np.float64) - second
        denominator = reflectances[2].astype(np.float64)
    else:
        raise ValueError("Unsupported index operation or band count")
    invalid |= ~np.isfinite(denominator) | (denominator <= 0)
    quality["invalid_reflectance"] = int(np.count_nonzero(retained & invalid))
    retained &= ~invalid
    quality["valid_pixels"] = int(np.count_nonzero(retained))
    assert sum(quality[key] for key in ("aggregate_masked", "interpolated", "invalid_reflectance", "valid_pixels")) == quality["in_bbox"]
    if not quality["valid_pixels"]:
        return quality, None
    values = numerator[retained] / denominator[retained]
    quartiles = np.percentile(values, [25, 50, 75])
    return quality, {"min": float(values.min()), "p25": float(quartiles[0]),
                     "median": float(quartiles[1]), "p75": float(quartiles[2]),
                     "max": float(values.max()), "mean": float(values.mean())}


def calculate_index(first, second, in_bbox, aggregate, interpolation, reflectance_fills=(), aggregate_fills=()):
    return calculate_spectral_index("normalized_difference", [first, second], in_bbox, aggregate,
        interpolation, reflectance_fills, aggregate_fills)


def extract_indices(reflectance, packed, spectral, in_bbox, aggregate, reflectance_fills=(), aggregate_fills=(), packed_fills=()):
    wavelengths, good, fwhm = (spectral[key][:] for key in ("wavelengths", "good_wavelengths", "fwhm"))
    reflectance_cache, packed_cache = {}, {}
    results = []
    for definition in INDEX_DEFINITIONS:
        result = {key: definition[key] for key in ("id", "name", "formula", "source_url", "wavelength_tolerance_nm", "interpretation")}
        result["approximation"] = "Nearest EMIT band centers approximate nominal formula wavelengths. Tolerance is an engineering guard, not universal physical validation. All indices share one reflectance scene and are not independent modalities."
        try:
            bands = select_bands(wavelengths, good, fwhm, definition["targets"], definition["wavelength_tolerance_nm"])
        except BandUnavailableError as error:
            result.update(status="unavailable", bands=[], quality=None, statistics=None, reason=str(error))
            results.append(result)
            continue
        interpolation = np.zeros(in_bbox.shape, dtype=bool)
        selected = []
        for band in bands:
            index = band["index"]
            if index not in reflectance_cache:
                reflectance_cache[index] = reflectance[:, :, index]
            byte = index // 8
            if byte not in packed_cache:
                packed_cache[byte] = packed[:, :, byte]
            selected.append(reflectance_cache[index])
            interpolation |= interpolation_flags(packed_cache[byte], index, packed_fills)
        quality, statistics = calculate_spectral_index(definition["operation"], selected, in_bbox, aggregate,
            interpolation, reflectance_fills, aggregate_fills)
        result.update(status="measured" if statistics else "no_valid_pixels", bands=bands,
                      quality=quality, statistics=statistics)
        results.append(result)
    return results


def identity(path, kind):
    match = re.fullmatch(r"EMIT_L2A_" + kind + r"_(001_\d{8}T\d{6}_\d+_\d+)\.nc", path.name)
    if not match:
        raise ValueError(f"Unexpected V001 filename: {path.name}")
    return match[1]


def file_record(path, created_at):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return {"name": path.name, "sha256": digest.hexdigest(), "bytes": path.stat().st_size,
            "created_at": created_at}


def build(reflectance_path, mask_path, bbox):
    reflectance_path, mask_path = Path(reflectance_path), Path(mask_path)
    bbox = list(map(float, bbox))
    if len(bbox) != 4 or not np.all(np.isfinite(bbox)):
        raise ValueError("Expected finite west south east north bbox")
    west, south, east, north = bbox
    if not -180 <= west < east <= 180 or not -90 <= south < north <= 90:
        raise ValueError("Invalid bbox bounds")
    scene_id = identity(reflectance_path, "RFL")
    if identity(mask_path, "MASK") != scene_id:
        raise ValueError("Filename acquisition identities differ")
    with h5py.File(reflectance_path, "r") as rfl, h5py.File(mask_path, "r") as mask:
        for key in ("product_version", "flight_line", "time_coverage_start", "time_coverage_end"):
            if key not in rfl.attrs or key not in mask.attrs or text(rfl.attrs[key]) != text(mask.attrs[key]):
                raise ValueError(f"Input identity mismatch: {key}")
        if text(rfl.attrs["product_version"]) != "V001":
            raise ValueError("Only V001 is supported")
        acquired_at = text(rfl.attrs["time_coverage_start"])
        parsed_time = datetime.fromisoformat(acquired_at.replace("Z", "+00:00"))
        if parsed_time.utcoffset() is None or parsed_time.strftime("%Y%m%dT%H%M%S") != scene_id.split("_")[1]:
            raise ValueError("Acquisition timestamp differs from filename")
        if not text(rfl.attrs["flight_line"]).startswith("emit" + scene_id.split("_")[1].lower() + "_"):
            raise ValueError("Flight line differs from filename acquisition")
        acquired_at = parsed_time.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        reflectance, quality_mask, packed = rfl["reflectance"], mask["mask"], mask["band_mask"]
        spectral = rfl["sensor_band_parameters"]
        require_units(reflectance, "unitless")
        require_units(quality_mask, "unitless")
        require_units(packed, "unitless")
        for key in ("wavelengths", "fwhm"):
            require_units(spectral[key], "nm")
        bands = select_bands(spectral["wavelengths"][:], spectral["good_wavelengths"][:], spectral["fwhm"][:])
        wavelengths = spectral["wavelengths"].shape[0]
        spatial_shape = reflectance.shape[:2]
        if reflectance.ndim != 3 or reflectance.shape[2] != wavelengths or quality_mask.shape != (*spatial_shape, 8) or packed.shape != (*spatial_shape, (wavelengths + 7) // 8):
            raise ValueError("Unexpected reflectance/mask dimensions")
        if packed.dtype != np.uint8:
            raise ValueError("Unexpected packed-mask dtype")
        names = [text(value) for value in mask["sensor_band_parameters/mask_bands"][:]]
        if names.count("Aggregate Flag") != 1:
            raise ValueError("Expected exactly one Aggregate Flag band")
        aggregate_index = names.index("Aggregate Flag")
        location = {}
        for key, unit in (("lat", "degrees north"), ("lon", "degrees east")):
            require_units(rfl["location/" + key], unit)
            require_units(mask["location/" + key], unit)
            values = rfl["location/" + key][:]
            other = mask["location/" + key][:]
            if values.shape != spatial_shape or other.shape != spatial_shape or not np.array_equal(values, other, equal_nan=True):
                raise ValueError("Reflectance and mask geolocation differ")
            location[key] = values
        lat, lon = location["lat"], location["lon"]
        in_bbox = np.isfinite(lat) & np.isfinite(lon) & (west <= lon) & (lon <= east) & (south <= lat) & (lat <= north)
        indices = extract_indices(reflectance, packed, spectral, in_bbox, quality_mask[:, :, aggregate_index],
            fill_values(reflectance), fill_values(quality_mask), fill_values(packed))
        ndwi = indices[0]
        quality, statistics = ndwi["quality"], ndwi["statistics"]
        inputs = [file_record(path, text(handle.attrs["date_created"]))
                  for path, handle in ((reflectance_path, rfl), (mask_path, mask))]
        title = text(rfl.attrs["title"])
    return {"schema_version": 1, "status": ndwi["status"],
        "scene_id": "EMIT_L2A_RFL_" + scene_id, "title": title, "acquired_at": acquired_at,
        "processed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "bbox": bbox, "bands": bands, "quality": quality, "statistics": statistics, "input_files": inputs,
        "mask_policy": "Native pixels inside inclusive bbox; Aggregate Flag finite and zero; both target-band MSB-first interpolation bits unset and neither selected packed byte equals its declared fill; reflectance finite, nonnegative and not declared fill; denominator positive. Sequential exclusions; native-pixel statistics are not area-weighted. No GLT resampling or upper clipping.",
        "units": "dimensionless",
        "interpretation": "Nonwater surface spectral NDWI; not vegetation, measured fuel moisture, or fire probability.",
        "indices": indices}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reflectance", type=Path, required=True)
    parser.add_argument("--mask", type=Path, required=True)
    parser.add_argument("--bbox", nargs=4, type=float, required=True, metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = build(args.reflectance, args.mask, args.bbox)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
