"""Normalize saved NWS weather and EMIT catalog records without network access."""

import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import re


def read_source(directory, name):
    path = Path(directory) / name
    if not path.exists():
        return None
    with path.open(encoding="utf-8-sig") as handle:
        result = json.load(handle)
    if not isinstance(result, dict):
        raise ValueError(f"Expected JSON object: {name}")
    return result


def finite(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"Expected finite numeric value: {value!r}")
    return value


def convert(value, unit, quantity):
    value = finite(value)
    if value is None:
        return None
    unit = (unit or "").split(":")[-1]
    if quantity == "temperature":
        if unit in ("C", "degC"):
            return value
        if unit in ("F", "degF"):
            return (value - 32) * 5 / 9
    elif quantity == "wind":
        if value < 0:
            raise ValueError("Wind speed must be nonnegative")
        factors = {"m_s-1": 1, "mph": 0.44704, "km_h-1": 1 / 3.6, "km/h": 1 / 3.6}
        if unit in factors:
            return value * factors[unit]
    elif quantity == "percent" and unit == "percent":
        if not 0 <= value <= 100:
            raise ValueError("Percentage must be between 0 and 100")
        return value
    raise ValueError(f"Unsupported {quantity} unit: {unit}")


def measurement(raw, quantity):
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("Expected unit-coded measurement")
    return convert(raw.get("value"), raw.get("unitCode"), quantity)


def wind_range(raw):
    if raw is None or raw == "":
        return None, None
    if raw == "Calm":
        return 0, 0
    match = re.fullmatch(r"(\d+(?:\.\d+)?)(?:\s+to\s+(\d+(?:\.\d+)?))?\s+(mph|km/h|m_s-1)", raw)
    if not match:
        raise ValueError(f"Unsupported wind description: {raw!r}")
    low, high = float(match[1]), float(match[2] or match[1])
    if high < low:
        raise ValueError("Reversed wind range")
    return convert(low, match[3], "wind"), convert(high, match[3], "wind")


def forecast_data(raw, point):
    result = {"status": "unavailable", "source_url": None, "issued_at": None,
              "generated_at": None, "periods": []}
    if raw is None:
        return result
    props = raw["properties"]
    result.update(status="available", source_url=props.get("@id") or raw.get("id") or
                  (point or {}).get("properties", {}).get("forecastHourly"),
                  issued_at=props.get("updateTime"), generated_at=props.get("generatedAt"))
    for period in props["periods"]:
        low, high = wind_range(period.get("windSpeed"))
        result["periods"].append({"start": period["startTime"], "end": period["endTime"],
            "temperature_c": convert(period.get("temperature"), period.get("temperatureUnit"), "temperature"),
            "relative_humidity_pct": measurement(period.get("relativeHumidity"), "percent"),
            "wind_min_mps": low, "wind_max_mps": high,
            "wind_direction": period.get("windDirection") or None,
            "precipitation_probability_pct": measurement(period.get("probabilityOfPrecipitation"), "percent"),
            "summary": period.get("shortForecast")})
    return result


def observation_data(raw, stations):
    result = dict.fromkeys(("source_url", "station_id", "station_name", "timestamp", "temperature_c",
                           "relative_humidity_pct", "wind_mps", "gust_mps", "quality_note"))
    result["status"] = "unavailable"
    if raw is None:
        return result
    props = raw["properties"]
    station_url = props.get("station")
    features = (stations or {}).get("features", [])
    station = next((item["properties"] for item in features
                    if item.get("id") == station_url or item.get("properties", {}).get("@id") == station_url), {})
    codes = {field: props[field].get("qualityControl") for field in
             ("temperature", "relativeHumidity", "windSpeed", "windGust")
             if isinstance(props.get(field), dict) and props[field].get("qualityControl") is not None}
    result.update(status="available", source_url=raw.get("id") or props.get("@id"),
        station_id=station.get("stationIdentifier") or (station_url.rsplit("/", 1)[-1] if station_url else None),
        station_name=station.get("name"), timestamp=props.get("timestamp"),
        temperature_c=measurement(props.get("temperature"), "temperature"),
        relative_humidity_pct=measurement(props.get("relativeHumidity"), "percent"),
        wind_mps=measurement(props.get("windSpeed"), "wind"),
        gust_mps=measurement(props.get("windGust"), "wind"),
        quality_note=("Source quality-control codes: " + json.dumps(codes, sort_keys=True)
                      if codes else "No source quality-control codes supplied; observation not independently verified."))
    return result


def scene_geometry(polygons):
    if not isinstance(polygons, list) or not polygons:
        raise ValueError("CMR scene has no polygon")
    converted = []
    for polygon in polygons:
        rings = []
        for ring in polygon:
            values = [float(value) for value in ring.split()]
            if len(values) < 8 or len(values) % 2:
                raise ValueError("Malformed CMR polygon ring")
            coordinates = []
            for lat, lon in zip(values[::2], values[1::2]):
                if not math.isfinite(lat) or not math.isfinite(lon) or not -90 <= lat <= 90 or not -180 <= lon <= 180:
                    raise ValueError("Invalid CMR coordinate")
                coordinates.append([lon, lat])
            if coordinates[0] != coordinates[-1]:
                raise ValueError("Unclosed CMR polygon")
            rings.append(coordinates)
        converted.append(rings)
    return {"type": "Polygon", "coordinates": converted[0]} if len(converted) == 1 else {
        "type": "MultiPolygon", "coordinates": converted}


def hyperspectral_data(raw):
    result = {"status": "catalog_only" if raw is not None else "unavailable",
        "index": {"name": "Gao NDWI", "wavelengths_nm": [860, 1240],
                  "formula": "(R860 - R1240) / (R860 + R1240)",
                  "interpretation": "Vegetation-water spectral indicator; not measured fuel moisture or fire probability"},
        "scenes": []}
    if raw is None:
        return result
    for entry in raw["feed"]["entry"]:
        title = entry["title"]
        match = re.match(r"EMIT_L2A_RFL_(\d{3})_", title)
        if not match:
            raise ValueError(f"Unexpected EMIT reflectance title: {title}")
        if match[1] != "001":
            continue
        urls = [link["href"] for link in entry["links"] if not link.get("inherited")
                and link.get("href", "").startswith("https://")]
        def asset(stem, suffix):
            return next((url for url in urls if "/" + stem in url and url.endswith(suffix)), None)
        reflectance = asset(title, ".nc")
        result["scenes"].append({"id": entry["id"], "title": title,
            "acquired_at": entry["time_start"], "version": "001",
            "geometry": scene_geometry(entry["polygons"]), "reflectance_url": reflectance,
            "mask_url": asset(title.replace("_RFL_", "_MASK_"), ".nc"),
            "browse_url": asset(title, ".png"),
            "catalog_url": "https://cmr.earthdata.nasa.gov/search/concepts/" + entry["id"] + ".umm_json"})
    return result


def build(source_dir, retrieved_at=None):
    if retrieved_at is None:
        manifest = read_source(source_dir, "manifest.json")
        retrieved_at = (manifest or {}).get("retrieved_at")
    if not retrieved_at:
        raise ValueError("Provide --retrieved-at or manifest.json retrieved_at")
    timestamp = datetime.fromisoformat(retrieved_at.replace("Z", "+00:00"))
    if timestamp.utcoffset() is None:
        raise ValueError("retrieved_at must include a timezone")
    point = read_source(source_dir, "nws-point.json")
    forecast = read_source(source_dir, "nws-forecast.json")
    stations = read_source(source_dir, "nws-stations.json")
    observation = read_source(source_dir, "nws-observation.json")
    granules = read_source(source_dir, "emit-granules.json")
    coordinates = (point or {}).get("geometry", {}).get("coordinates", [None, None])
    relative = (point or {}).get("properties", {}).get("relativeLocation", {}).get("properties", {})
    return {"schema_version": 1, "retrieved_at": retrieved_at,
        "weather": {"location": {"name": ", ".join(filter(None, [relative.get("city"), relative.get("state")])) or None,
                                 "latitude": coordinates[1], "longitude": coordinates[0]},
                    "forecast": forecast_data(forecast, point), "observation": observation_data(observation, stations)},
        "hyperspectral": hyperspectral_data(granules)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--retrieved-at")
    args = parser.parse_args()
    result = build(args.source_dir, args.retrieved_at)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
