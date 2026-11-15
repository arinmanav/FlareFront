"""Stream FIRMS USA members and retain county-envelope candidates."""

import argparse
from collections import Counter
from contextlib import ExitStack
import csv
import io
import json
from pathlib import Path
import time
from zipfile import ZipFile


# Outward-rounded Census GEOID 06037 extent in WGS84; not the county polygon.
BOUNDS = (-118.952, 32.750, -117.646, 34.824)


def inspect_region_archives(source_dir, sensor, start_year, end_year, regions):
    """Read each USA member once and distribute candidates among region envelopes."""
    if not regions or start_year > end_year:
        raise ValueError("At least one region and an ordered year range are required")
    prepared = {}
    for region_id, region in regions.items():
        bounds = tuple(map(float, region["bounds"]))
        if len(bounds) != 4 or not -180 <= bounds[0] < bounds[2] <= 180 or not -90 <= bounds[1] < bounds[3] <= 90:
            raise ValueError(f"Invalid bounds: {region_id}")
        output_dir = Path(region["output_dir"])
        output_dir.mkdir(parents=True, exist_ok=True)
        prepared[region_id] = {"bounds": bounds, "output_dir": output_dir, "reports": [], "writer": None}
    fields = None
    started = time.monotonic()
    with ExitStack() as stack:
        for region in prepared.values():
            region["handle"] = stack.enter_context((region["output_dir"] / f"{sensor}_envelope.csv").open("w", newline="", encoding="utf-8"))
        for year in range(start_year, end_year + 1):
            archive = Path(source_dir) / f"{sensor}_{year}_all_countries.zip"
            expected_member = f"{sensor}/{year}/{sensor}_{year}_United_States.csv"
            usa_rows = 0
            minimum = maximum = None
            for region in prepared.values():
                region["count"] = 0
                region["minimum"] = region["maximum"] = None
                region["categories"] = {key: Counter() for key in ("satellite", "instrument", "version", "confidence", "type", "daynight")}
            with ZipFile(archive) as bundle:
                member = bundle.getinfo(expected_member)
                with bundle.open(member) as raw:
                    rows = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
                    current_fields = rows.fieldnames
                    required = {"latitude", "longitude", "acq_date", "acq_time", "satellite", "confidence", "version"}
                    if not current_fields or not required.issubset(current_fields):
                        raise ValueError(f"Missing required columns in {archive.name}: {current_fields}")
                    if fields is None:
                        fields = current_fields
                        for region in prepared.values():
                            region["writer"] = csv.DictWriter(region["handle"], fieldnames=["source_archive", "source_member", *fields])
                            region["writer"].writeheader()
                    elif current_fields != fields:
                        raise ValueError(f"Schema changed in {archive.name}: {current_fields}")
                    for row in rows:
                        latitude, longitude = float(row["latitude"]), float(row["longitude"])
                        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                            raise ValueError(f"Invalid coordinate in {archive.name}")
                        day = row["acq_date"]
                        if len(day) != 10 or not day.startswith(f"{year}-"):
                            raise ValueError(f"Unexpected acquisition date {day!r} in {archive.name}")
                        usa_rows += 1
                        minimum = day if minimum is None else min(minimum, day)
                        maximum = day if maximum is None else max(maximum, day)
                        for region in prepared.values():
                            bounds = region["bounds"]
                            if bounds[0] <= longitude <= bounds[2] and bounds[1] <= latitude <= bounds[3]:
                                region["count"] += 1
                                region["minimum"] = day if region["minimum"] is None else min(region["minimum"], day)
                                region["maximum"] = day if region["maximum"] is None else max(region["maximum"], day)
                                for key, values in region["categories"].items():
                                    if key in row:
                                        values[row[key]] += 1
                                region["writer"].writerow({"source_archive": archive.name, "source_member": expected_member, **row})
            common = {
                "year": year,
                "archive": archive.name,
                "archive_bytes": archive.stat().st_size,
                "member": expected_member,
                "member_crc32": f"{member.CRC:08x}",
                "member_crc32_verified": True,
                "member_read_scope": "entire USA member",
                "member_uncompressed_bytes": member.file_size,
                "usa_rows": usa_rows,
                "usa_min_date": minimum,
                "usa_max_date": maximum,
            }
            for region in prepared.values():
                region["reports"].append({**common, "envelope_rows": region["count"],
                    "envelope_min_date": region["minimum"], "envelope_max_date": region["maximum"],
                    "envelope_categories": region["categories"]})
            print(json.dumps({"year": year, "usa_rows": usa_rows,
                "envelope_rows": {key: region["count"] for key, region in prepared.items()}}), flush=True)
    reports = {}
    for region_id, region in prepared.items():
        report = {
            "sensor": sensor,
            "columns": fields,
            "bounding_box_west_south_east_north": region["bounds"],
            "subset_scope": "Bounding-box candidates; county polygon filtering has not been applied.",
            "coverage_note": "Dates of reported detections do not establish valid observation opportunities or cloud-free coverage.",
            "subset_path": f"{sensor}_envelope.csv",
            "crc_verification": "ZipFile checked each entire USA member against its recorded CRC32 while streaming to EOF.",
            "years": region["reports"],
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }
        report_path = region["output_dir"] / f"{sensor}_inventory.json"
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        reports[region_id] = report
    return reports


def inspect_archives(source_dir, sensor, start_year, end_year, output_dir, bounds=BOUNDS):
    return inspect_region_archives(source_dir, sensor, start_year, end_year,
        {"county": {"bounds": bounds, "output_dir": output_dir}})["county"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--sensor", choices=("modis", "viirs-snpp"), required=True)
    parser.add_argument("--start-year", type=int, required=True)
    parser.add_argument("--end-year", type=int, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--bounds", nargs=4, type=float, default=BOUNDS, metavar=("WEST", "SOUTH", "EAST", "NORTH"))
    args = parser.parse_args()
    if args.start_year > args.end_year:
        parser.error("start-year must not exceed end-year")
    inspect_archives(args.source_dir, args.sensor, args.start_year, args.end_year, args.output_dir, args.bounds)
