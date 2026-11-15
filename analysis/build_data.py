"""Build reproducible county detections and the historical calendar."""

import argparse
from collections import Counter, defaultdict
import csv
from datetime import date, datetime, timedelta, timezone
import json
import math
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
from statistics import mean, median

import shapely
from shapely.geometry import shape


CONFIG_PATH = Path(__file__).with_name("config.json")
SENSORS = ("terra", "aqua", "snpp")
PRODUCTS = ("modis", "viirs-snpp")
POINT_COLUMNS = ["date", "time", "lat", "lon", "sensor", "confidence", "version",
                 "frp", "source_archive", "source_member"]
SOFTWARE_DEVELOPMENT = "AI assisted code editor was used for code development"
REQUIRED_COLUMNS = {"source_archive", "source_member", "latitude", "longitude",
                    "scan", "track", "acq_date", "acq_time", "satellite", "instrument",
                    "confidence", "version", "frp", "daynight", "type"}
EXCLUSION_KEYS = ("outside_period", "outside_county", "non_vegetation_type",
                  "low_confidence")


def load_config(path=CONFIG_PATH):
    with Path(path).open(encoding="utf-8") as handle:
        config = json.load(handle)
    for field in ("start_date", "end_date", "snpp_start_date"):
        date.fromisoformat(config[field])
    if config["timezone"] != "UTC" or config["reference_sensor"] != "terra":
        raise ValueError("The supported timestamp/reference contract is UTC/Terra")
    return config


def normalize_timestamp(acq_date, acq_time):
    """Return the canonical UTC date, four-digit HHMM, and ISO timestamp."""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", acq_date):
        raise ValueError(f"Invalid acquisition date: {acq_date!r}")
    if not re.fullmatch(r"\d{1,4}", acq_time):
        raise ValueError(f"Invalid acquisition time: {acq_time!r}")
    padded_time = acq_time.zfill(4)
    try:
        parsed = datetime.combine(date.fromisoformat(acq_date), datetime.min.time())
        parsed = parsed.replace(hour=int(padded_time[:2]), minute=int(padded_time[2:]),
                                tzinfo=timezone.utc)
    except ValueError as error:
        raise ValueError(f"Invalid UTC acquisition timestamp: {acq_date} {acq_time}") from error
    return acq_date, padded_time, parsed.isoformat().replace("+00:00", "Z")


def finite_number(value, field, minimum=None, maximum=None):
    try:
        result = float(value)
    except (ValueError, TypeError) as error:
        raise ValueError(f"Invalid {field}: {value!r}") from error
    if not math.isfinite(result) or (minimum is not None and result < minimum) or (
            maximum is not None and result > maximum):
        raise ValueError(f"Invalid {field}: {value!r}")
    return result


def validate_source_name(value, field):
    if not value or "\\" in value or PurePosixPath(value).is_absolute() or PureWindowsPath(value).drive:
        raise ValueError(f"{field} must be a relative archive/member name")
    if ".." in PurePosixPath(value).parts:
        raise ValueError(f"{field} must not traverse directories")


def normalize_record(raw):
    """Retain source strings and add validated, canonical detection fields."""
    missing = REQUIRED_COLUMNS - raw.keys()
    if missing:
        raise ValueError(f"Missing detection columns: {', '.join(sorted(missing))}")
    if None in raw or any(not isinstance(value, str) for value in raw.values()):
        raise ValueError("Detection row has missing or surplus CSV fields")
    satellite = raw["satellite"]
    identities = {("Terra", "MODIS"): "terra", ("Aqua", "MODIS"): "aqua",
                  ("N", "VIIRS"): "snpp"}
    sensor = identities.get((satellite, raw["instrument"]))
    if sensor is None:
        raise ValueError(f"Unknown satellite/instrument: {satellite!r}/{raw['instrument']!r}")
    if raw["daynight"] not in ("D", "N") or raw["type"] not in ("0", "1", "2", "3"):
        raise ValueError("Unknown day/night or hotspot type category")
    if not raw["version"] or not re.fullmatch(r"\d+(?:\.\d+)*", raw["version"]):
        raise ValueError("Invalid processing-version string")
    if sensor == "snpp":
        if raw["confidence"] not in ("l", "n", "h"):
            raise ValueError(f"Unknown VIIRS confidence: {raw['confidence']!r}")
        confidence = raw["confidence"]
    else:
        confidence = finite_number(raw["confidence"], "MODIS confidence", 0, 100)
    acq_date, acq_time, timestamp = normalize_timestamp(raw["acq_date"], raw["acq_time"])
    for field in ("source_archive", "source_member"):
        validate_source_name(raw[field], field)
    result = dict(raw)
    result.update(sensor=sensor, normalized_sensor={"terra": "modis_terra", "aqua": "modis_aqua",
                  "snpp": "viirs_snpp"}[sensor], date=acq_date, time=acq_time,
                  acquisition_datetime_utc=timestamp,
                  lat=finite_number(raw["latitude"], "latitude", -90, 90),
                  lon=finite_number(raw["longitude"], "longitude", -180, 180),
                  normalized_confidence=confidence, normalized_type=int(raw["type"]),
                  normalized_frp=finite_number(raw["frp"], "FRP", 0))
    for field in ("scan", "track"):
        finite_number(raw[field], field, 0)
    brightness_fields = ("bright_ti4", "bright_ti5") if sensor == "snpp" else ("brightness", "bright_t31")
    for field in brightness_fields:
        if field not in raw:
            raise ValueError(f"Missing sensor brightness column: {field}")
        finite_number(raw[field], field, 0)
    return result


def load_county(path, geoid):
    with Path(path).open(encoding="utf-8") as handle:
        geojson = json.load(handle)
    features = geojson.get("features", [])
    if geojson.get("type") != "FeatureCollection" or len(features) != 1:
        raise ValueError("County boundary must contain exactly one feature")
    feature = features[0]
    if feature.get("properties", {}).get("GEOID") != geoid:
        raise ValueError("County boundary GEOID does not match configuration")
    county = shape(feature["geometry"])
    if county.geom_type not in ("Polygon", "MultiPolygon") or county.is_empty or not county.is_valid:
        raise ValueError("County boundary must be a valid nonempty Polygon or MultiPolygon")
    return geojson, county


def qualify_records(records, county, config):
    """Apply ordered exclusions, then deduplicate qualifying overpass keys."""
    normalized = [normalize_record(record) for record in records]
    inside = shapely.covers(county, shapely.points([(record["lon"], record["lat"])
                                                   for record in normalized])).tolist() if normalized else []
    quality = {"raw_candidates": len(normalized), "inside_county": sum(inside), "qualifying": 0,
               "duplicates": 0, "exclusions": dict.fromkeys(EXCLUSION_KEYS, 0), "by_sensor": {}}
    seen = set()
    retained = []
    for record, covered in zip(normalized, inside):
        sensor = record["sensor"]
        sensor_quality = quality["by_sensor"].setdefault(sensor, {"raw_candidates": 0,
            "inside_county": 0, "qualifying": 0, "duplicates": 0,
            "exclusions": dict.fromkeys(EXCLUSION_KEYS, 0)})
        sensor_quality["raw_candidates"] += 1
        sensor_quality["inside_county"] += int(covered)
        reason = None
        if not config["start_date"] <= record["date"] <= config["end_date"]:
            reason = "outside_period"
        elif not covered:
            reason = "outside_county"
        elif record["normalized_type"] != config["hotspot_type"]:
            reason = "non_vegetation_type"
        elif (sensor == "snpp" and record["confidence"] not in config["viirs_confidence"]) or (
                sensor != "snpp" and record["normalized_confidence"] < config["modis_min_confidence"]):
            reason = "low_confidence"
        if reason:
            quality["exclusions"][reason] += 1
            sensor_quality["exclusions"][reason] += 1
            continue
        key = (record["lat"], record["lon"], record["date"], record["time"], record["satellite"])
        if key in seen:
            quality["duplicates"] += 1
            sensor_quality["duplicates"] += 1
            continue
        seen.add(key)
        record["qualification_reason"] = "county_type0_confidence"
        retained.append(record)
        quality["qualifying"] += 1
        sensor_quality["qualifying"] += 1
    retained.sort(key=lambda row: (row["date"], row["time"], row["sensor"], row["lat"], row["lon"]))
    assert quality["raw_candidates"] == quality["qualifying"] + quality["duplicates"] + sum(quality["exclusions"].values())
    quality["exclusion_order"] = list(EXCLUSION_KEYS) + ["duplicate_qualifying_key"]
    quality["coverage"] = "Unknown observation opportunities; zero counts indicate no qualifying detections reported."
    return retained, quality


def sensor_start(sensor, config):
    return {"terra": config["start_date"], "aqua": config["aqua_start_month"] + "-01",
            "snpp": config["snpp_start_date"]}[sensor]


def day_available(sensor, iso_date, config):
    if iso_date < sensor_start(sensor, config):
        return False
    return not any(gap["sensor"] == sensor and gap["start_date"] <= iso_date <= gap["end_date"]
                   for gap in config["known_source_gaps"])


def aggregate_daily(records, config):
    counts = Counter((record["date"], record["sensor"]) for record in records)
    current, end = date.fromisoformat(config["start_date"]), date.fromisoformat(config["end_date"])
    daily = []
    while current <= end:
        iso_date = current.isoformat()
        row = {"date": iso_date}
        for sensor in SENSORS:
            available = day_available(sensor, iso_date, config)
            if not available and counts[(iso_date, sensor)]:
                raise ValueError(f"Detection contradicts declared source unavailability: {iso_date} {sensor}")
            row[sensor] = counts[(iso_date, sensor)] if available else None
        daily.append(row)
        current += timedelta(days=1)
    return daily


def aggregate_monthly(daily, records, config):
    grouped = defaultdict(list)
    versions = defaultdict(set)
    for row in daily:
        grouped[row["date"][:7]].append(row)
    for record in records:
        versions[(record["date"][:7], record["sensor"])].add(record["version"])
    months = []
    for month_key, days in sorted(grouped.items()):
        year, month = map(int, month_key.split("-"))
        row = {"year": year, "month": month, "start_date": days[0]["date"],
               "end_date": days[-1]["date"], "units": config["units"],
               "availability": {}, "versions": {}}
        for sensor in SENSORS:
            values = [day[sensor] for day in days if day[sensor] is not None]
            gaps = any(gap["sensor"] == sensor and gap["start_date"] <= row["end_date"]
                       and gap["end_date"] >= row["start_date"] for gap in config["known_source_gaps"])
            row[sensor] = sum(values) if values and not gaps else None
            status = "source_gap" if gaps else "reported_counts_coverage_unknown" if values else "unavailable"
            if values and not gaps and (len(values) != len(days) or sensor == "aqua" and month_key == config["aqua_start_month"]):
                status = "partial_first_month_coverage_unknown"
            row["availability"][sensor] = status
            row["versions"][sensor] = sorted(versions[(month_key, sensor)])
        row["partial_first_year"] = {sensor: year == int(sensor_start(sensor, config)[:4]) and
            sensor_start(sensor, config)[5:] != "01-01" for sensor in SENSORS}
        months.append(row)
    return months


def calibrate(months, config, allow_unestimable=False):
    """Fit the declared ratio on training counts, then evaluate untouched months."""
    for start, end in ((config["fit_start_year"], config["fit_end_year"]),
                       (config["test_start_year"], config["test_end_year"])):
        keys = [(row["year"], row["month"]) for row in months if start <= row["year"] <= end]
        expected = {(year, month) for year in range(start, end + 1) for month in range(1, 13)}
        if len(keys) != len(expected) or set(keys) != expected:
            raise ValueError(f"Expected exactly one record for every month in {start}-{end}")
    training = [row for row in months if config["fit_start_year"] <= row["year"] <= config["fit_end_year"]]
    if not training or any(row["terra"] is None or row["snpp"] is None for row in training):
        raise ValueError("Training requires available Terra and S-NPP counts in every training month")
    terra_total = sum(row["terra"] for row in training)
    snpp_total = sum(row["snpp"] for row in training)
    if terra_total <= 0 or snpp_total <= 0:
        if allow_unestimable:
            testing = [row for row in months if config["test_start_year"] <= row["year"] <= config["test_end_year"]]
            eligible = [row for row in testing if row["terra"] is not None and row["snpp"] is not None]
            return {"passed": False, "status": "unestimable", "reason": "Training totals must both be positive",
                "alpha": None,
                "training": {"start_year": config["fit_start_year"], "end_year": config["fit_end_year"],
                             "terra_total": terra_total, "snpp_total": snpp_total, "months": len(training)},
                "test": {"start_year": config["test_start_year"], "end_year": config["test_end_year"],
                         "months": len(eligible), "excluded_months": [{"year": row["year"], "month": row["month"],
                         "reason": "proven_source_unavailability"} for row in testing if row not in eligible]},
                "mae": {"adjusted": None, "unscaled": None, "seasonal": None},
                "by_year": [], "version_groups": [], "seasonal_training_medians": {}}
        raise ValueError("Training totals must both be positive")
    alpha = terra_total / snpp_total
    seasonal = {month: median(row["terra"] for row in training if row["month"] == month)
                for month in range(1, 13)}
    testing = [row for row in months if config["test_start_year"] <= row["year"] <= config["test_end_year"]]
    eligible = [row for row in testing if row["terra"] is not None and row["snpp"] is not None]
    if not eligible:
        raise ValueError("No eligible holdout months")

    def errors(rows):
        return {"adjusted": mean(abs(alpha * row["snpp"] - row["terra"]) for row in rows),
                "unscaled": mean(abs(row["snpp"] - row["terra"]) for row in rows),
                "seasonal": mean(abs(seasonal[row["month"]] - row["terra"]) for row in rows)}

    mae = errors(eligible)
    yearly = [{"year": year, **errors(rows)} for year in range(config["test_start_year"], config["test_end_year"] + 1)
              if (rows := [row for row in eligible if row["year"] == year])]
    version_groups = [{"start_year": start, "end_year": end, "months": len(rows), **errors(rows)}
                      for start, end in config["validation_groups"]
                      if (rows := [row for row in eligible if start <= row["year"] <= end])]
    return {"passed": mae["adjusted"] < mae["unscaled"] and mae["adjusted"] < mae["seasonal"],
            "alpha": alpha,
            "training": {"start_year": config["fit_start_year"], "end_year": config["fit_end_year"],
                         "terra_total": terra_total, "snpp_total": snpp_total, "months": len(training)},
            "test": {"start_year": config["test_start_year"], "end_year": config["test_end_year"],
                     "months": len(eligible), "excluded_months": [{"year": row["year"], "month": row["month"],
                     "reason": "proven_source_unavailability"} for row in testing if row not in eligible]},
            "mae": mae, "by_year": yearly, "version_groups": version_groups,
            "seasonal_training_medians": seasonal}


def apply_main_series(daily, months, alpha, config):
    for row in [*daily, *months]:
        year = row["year"] if "year" in row else int(row["date"][:4])
        source = "terra" if year < config["switch_year"] else "snpp"
        row["source"] = source
        value = row[source]
        row["main"] = None if value is None or source == "snpp" and alpha is None else value if source == "terra" else alpha * value
    for row in months:
        peers = [other["main"] for other in months if other["month"] == row["month"]
                 and other["year"] != row["year"] and other["main"] is not None]
        row["baseline_n"] = len(peers)
        row["median"] = median(peers) if peers else None
        row["anomaly"] = row["main"] - row["median"] if row["main"] is not None and peers else None


def read_inputs(input_dir, config):
    records, inventories = [], []
    for product in PRODUCTS:
        path = input_dir / f"{product}_envelope.csv"
        with path.open(encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if len(reader.fieldnames or []) != len(set(reader.fieldnames or [])):
                raise ValueError(f"Duplicate CSV columns in {path.name}")
            product_records = list(reader)
        with (input_dir / f"{product}_inventory.json").open(encoding="utf-8") as handle:
            inventory = json.load(handle)
        first_year = int(config["start_date"][:4]) if product == "modis" else int(config["snpp_start_date"][:4])
        expected = set(range(first_year, int(config["end_date"][:4]) + 1))
        years = inventory["years"]
        if len(years) != len(expected) or {item["year"] for item in years} != expected:
            raise ValueError(f"Inventory does not account for every selected {product} year")
        counts = Counter((record["source_archive"], record["source_member"]) for record in product_records)
        declared = set()
        for item in years:
            archive = PureWindowsPath(item["archive"]).name
            key = (archive, item["member"])
            declared.add(key)
            if counts[key] != item["envelope_rows"]:
                raise ValueError(f"Staged candidates disagree with inventory: {archive}")
            inventories.append({"product": product, "year": item["year"], "archive": archive,
                "member": item["member"], "member_crc32": item["member_crc32"],
                "member_crc32_verified": item.get("member_crc32_verified", False),
                "member_uncompressed_bytes": item["member_uncompressed_bytes"],
                "envelope_rows": item["envelope_rows"]})
        if set(counts) - declared:
            raise ValueError(f"Uninventoried source in {product} candidates")
        records.extend(product_records)
    return records, inventories


def write_json(path, value):
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        handle.write("\n")


def write_csv(path, rows, fieldnames=None):
    if not rows and not fieldnames:
        raise ValueError(f"No rows to write: {path.name}")
    fields = list(dict.fromkeys(field for row in rows for field in row)) if rows else fieldnames
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: json.dumps(value, separators=(",", ":"), allow_nan=False)
                             if isinstance(value, (dict, list)) else value for key, value in row.items()})


def build(input_dir, output_dir, config=None, boundary_path=None, allow_unestimable=False):
    config = load_config() if config is None else config
    input_dir, output_dir = Path(input_dir), Path(output_dir)
    geojson, county = load_county(boundary_path or input_dir / "los_angeles_county_2026.geojson", config["county_geoid"])
    raw, inventories = read_inputs(input_dir, config)
    records, quality = qualify_records(raw, county, config)
    daily = aggregate_daily(records, config)
    months = aggregate_monthly(daily, records, config)
    validation = calibrate(months, config, allow_unestimable=allow_unestimable)
    apply_main_series(daily, months, validation["alpha"], config)
    version_counts = defaultdict(Counter)
    for record in records:
        version_counts[record["sensor"]][record["version"]] += 1
    sources = [{"name": "NASA FIRMS MODIS archive", "url": "https://firms.modaps.eosdis.nasa.gov/download/"},
               {"name": "NASA FIRMS Suomi-NPP VIIRS archive", "url": "https://firms.modaps.eosdis.nasa.gov/download/"},
               {"name": "U.S. Census Bureau 2026 county boundary", "url": "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer"}]
    limitations = [
        "Hotspot detections are satellite pixel reports, not wildfire incidents, burned area, or forecasts.",
        "Zero means no qualifying detections reported. Point files do not verify observation opportunities, cloud-free coverage, or absence of fire.",
        "Terra counts are used through 2012; alpha-scaled S-NPP counts are used from 2013. Fractional values are estimates in Terra-equivalent units.",
        "Processing labels are preserved as supplied; MODIS contains 6.2, 6.03, and 61.03. This is not a verified uniform Collection 6.1 record.",
        "Aqua begins in July 2002; the exact first observation day is unresolved. July 2002 and the 2002 Aqua year are partial.",
        "S-NPP is unavailable before January 20, 2012; January 2012 and its first year are partial.",
        "No additional source gaps are inferred from zero rows. Observation coverage remains unknown unless independently documented.",
        "The single-factor pilot does not model seasonal or diurnal sensitivity, clouds, observation opportunity, or processing changes.",
        "Same-month historical medians use all other available years and are retrospective comparisons, not decision-time forecasts."]
    if validation["alpha"] is None:
        limitations[2] = "Terra counts are used through 2012. Positive training totals are unavailable, so no harmonized estimates are supplied from 2013; raw sensor counts remain available."
        limitations.append("Calibration is unestimable because both training totals must be positive; no county coefficient is borrowed from another region.")
    elif not validation["passed"]:
        limitations.append("Calibration failed the strict held-out improvement criterion; the adjusted series remains experimental and the validated milestone is incomplete.")
    dashboard = {"meta": {"title": "FlareFront", "county": config["county_name"],
        "geoid": config["county_geoid"], "start_date": config["start_date"], "end_date": config["end_date"],
        "timezone": config["timezone"], "units": config["units"], "switch_year": config["switch_year"],
        "alpha": validation["alpha"], "schema_version": config["schema_version"],
        "software_development": SOFTWARE_DEVELOPMENT,
        "coverage_verified": False, "sensor_start": {sensor: sensor_start(sensor, config) for sensor in SENSORS},
        "aqua_start_day_verified": config["aqua_start_day_verified"],
        "qualification": {"type": config["hotspot_type"], "modis_min_confidence": config["modis_min_confidence"],
                          "viirs_confidence": config["viirs_confidence"]},
        "version_counts": dict(version_counts), "source_inventory": inventories,
        "source_members": len(inventories),
        "source_crc32_verified_members": sum(item["member_crc32_verified"] is True for item in inventories),
        "known_source_gaps": config["known_source_gaps"]}, "months": months, "daily": daily,
        "validation": validation, "quality": quality, "sources": sources, "limitations": limitations}
    output_dir.mkdir(parents=True, exist_ok=True)
    write_json(output_dir / "dashboard.json", dashboard)
    point_rows = [[record.get(field) for field in POINT_COLUMNS] for record in records]
    write_json(output_dir / "points.json", {"meta": {"software_development": SOFTWARE_DEVELOPMENT},
                                           "columns": POINT_COLUMNS, "rows": point_rows})
    write_json(output_dir / "county.geojson", geojson)
    empty_point_fields = [*POINT_COLUMNS, *sorted(REQUIRED_COLUMNS - set(POINT_COLUMNS)),
                          "normalized_sensor", "acquisition_datetime_utc", "normalized_confidence",
                          "normalized_type", "normalized_frp", "qualification_reason"]
    write_csv(output_dir / "hotspots.csv", records, fieldnames=empty_point_fields)
    write_csv(output_dir / "calendar.csv", months)
    return dashboard


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("web/data"))
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument("--boundary", type=Path)
    parser.add_argument("--allow-unestimable", action="store_true")
    args = parser.parse_args()
    dashboard = build(args.input_dir, args.output_dir, load_config(args.config), args.boundary, args.allow_unestimable)
    print(json.dumps({"months": len(dashboard["months"]), "quality": dashboard["quality"],
                      "validation": dashboard["validation"]}, allow_nan=False, indent=2))


if __name__ == "__main__":
    main()
