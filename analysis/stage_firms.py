"""Stream FIRMS USA members and retain county-envelope candidates."""

import argparse
from collections import Counter
import csv
import io
import json
from pathlib import Path
import time
from zipfile import ZipFile


# Outward-rounded Census GEOID 06037 extent in WGS84; not the county polygon.
BOUNDS = (-118.952, 32.750, -117.646, 34.824)


def inspect_archives(source_dir, sensor, start_year, end_year, output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    subset_path = output_dir / f"{sensor}_envelope.csv"
    report_path = output_dir / f"{sensor}_inventory.json"
    reports = []
    fields = None
    started = time.monotonic()
    with subset_path.open("w", newline="", encoding="utf-8") as subset:
        writer = None
        for year in range(start_year, end_year + 1):
            archive = source_dir / f"{sensor}_{year}_all_countries.zip"
            expected_member = f"{sensor}/{year}/{sensor}_{year}_United_States.csv"
            counts = Counter()
            categories = {key: Counter() for key in ("satellite", "instrument", "version", "confidence", "type", "daynight")}
            minimum = maximum = None
            envelope_min = envelope_max = None
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
                        writer = csv.DictWriter(subset, fieldnames=["source_archive", "source_member", *fields])
                        writer.writeheader()
                    elif current_fields != fields:
                        raise ValueError(f"Schema changed in {archive.name}: {current_fields}")
                    for row in rows:
                        latitude, longitude = float(row["latitude"]), float(row["longitude"])
                        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                            raise ValueError(f"Invalid coordinate in {archive.name}")
                        day = row["acq_date"]
                        if len(day) != 10 or not day.startswith(f"{year}-"):
                            raise ValueError(f"Unexpected acquisition date {day!r} in {archive.name}")
                        counts["usa_rows"] += 1
                        minimum = day if minimum is None else min(minimum, day)
                        maximum = day if maximum is None else max(maximum, day)
                        if BOUNDS[0] <= longitude <= BOUNDS[2] and BOUNDS[1] <= latitude <= BOUNDS[3]:
                            counts["envelope_rows"] += 1
                            envelope_min = day if envelope_min is None else min(envelope_min, day)
                            envelope_max = day if envelope_max is None else max(envelope_max, day)
                            for key, values in categories.items():
                                if key in row:
                                    values[row[key]] += 1
                            writer.writerow({"source_archive": archive.name, "source_member": expected_member, **row})
            result = {
                "year": year,
                "archive": archive.name,
                "archive_bytes": archive.stat().st_size,
                "member": expected_member,
                "member_crc32": f"{member.CRC:08x}",
                "member_crc32_verified": True,
                "member_read_scope": "entire USA member",
                "member_uncompressed_bytes": member.file_size,
                "usa_rows": counts["usa_rows"],
                "envelope_rows": counts["envelope_rows"],
                "usa_min_date": minimum,
                "usa_max_date": maximum,
                "envelope_min_date": envelope_min,
                "envelope_max_date": envelope_max,
                "envelope_categories": categories,
            }
            reports.append(result)
            print(json.dumps({key: result[key] for key in ("year", "usa_rows", "envelope_rows", "usa_min_date", "usa_max_date")}), flush=True)
    report = {
        "sensor": sensor,
        "columns": fields,
        "bounding_box_west_south_east_north": BOUNDS,
        "subset_scope": "Bounding-box candidates; county polygon filtering has not been applied.",
        "coverage_note": "Dates of reported detections do not establish valid observation opportunities or cloud-free coverage.",
        "subset_path": subset_path.name,
        "crc_verification": "ZipFile checked each entire USA member against its recorded CRC32 while streaming to EOF.",
        "years": reports,
        "elapsed_seconds": round(time.monotonic() - started, 3),
    }
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": report_path.name, "subset": subset_path.name, "years": len(reports), "envelope_rows": sum(r["envelope_rows"] for r in reports), "elapsed_seconds": report["elapsed_seconds"]}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--sensor", choices=("modis", "viirs-snpp"), required=True)
    parser.add_argument("--start-year", type=int, required=True)
    parser.add_argument("--end-year", type=int, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.start_year > args.end_year:
        parser.error("start-year must not exceed end-year")
    inspect_archives(args.source_dir, args.sensor, args.start_year, args.end_year, args.output_dir)
