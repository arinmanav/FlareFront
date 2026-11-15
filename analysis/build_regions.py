"""Stage additional California county calendars while preserving existing LA outputs."""

import argparse
import json
from pathlib import Path
import re

if __package__:
    from .build_data import PRODUCTS, build, load_config, load_county, write_json
    from .stage_firms import inspect_region_archives
else:
    from build_data import PRODUCTS, build, load_config, load_county, write_json
    from stage_firms import inspect_region_archives


REGIONS_PATH = Path(__file__).with_name("regions.json")
PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_regions(path=REGIONS_PATH):
    with Path(path).open(encoding="utf-8") as handle:
        registry = json.load(handle)
    regions = registry["regions"]
    if registry.get("schema_version") != 1 or not regions:
        raise ValueError("Unsupported or empty region registry")
    ids = [region["id"] for region in regions]
    if len(ids) != len(set(ids)) or registry.get("default_region") not in ids:
        raise ValueError("Region IDs must be unique and include the default")
    for region in regions:
        if not re.fullmatch(r"[a-z]+(?:-[a-z]+)*", region["id"]) or not re.fullmatch(r"\d{5}", region["geoid"]):
            raise ValueError("Invalid region ID or county GEOID")
        expected_path = "." if region["id"] == "los-angeles" else "regions/" + region["id"]
        if region["data_path"] != expected_path or not region["city"] or not region["county"]:
            raise ValueError("Invalid region metadata")
    return registry


def build_regions(source_dir, boundary_root, staging_root, output_root, region_ids=None, config=None):
    registry = load_regions()
    config = load_config() if config is None else config
    selected = [region for region in registry["regions"] if region["id"] != "los-angeles"]
    if region_ids is not None:
        if not region_ids or len(region_ids) != len(set(region_ids)) or not set(region_ids).issubset({region["id"] for region in selected}):
            raise ValueError("Choose distinct additional regions; the existing LA data are preserved")
        selected = [region for region in selected if region["id"] in region_ids]
    staging = {}
    for region in selected:
        boundary_path = Path(boundary_root) / region["id"] / "county.geojson"
        _, geometry = load_county(boundary_path, region["geoid"])
        staging[region["id"]] = {"bounds": geometry.bounds, "output_dir": Path(staging_root) / region["id"]}
    for product in PRODUCTS:
        start_year = int(config["start_date"][:4]) if product == "modis" else int(config["snpp_start_date"][:4])
        inspect_region_archives(source_dir, product, start_year, int(config["end_date"][:4]), staging)
    result = {}
    for region in selected:
        region_config = {**config, "county_geoid": region["geoid"], "county_name": region["county"]}
        result[region["id"]] = build(staging[region["id"]]["output_dir"],
            Path(output_root) / region["data_path"], region_config,
            Path(boundary_root) / region["id"] / "county.geojson", allow_unestimable=True)
    write_json(Path(output_root) / 'regions.json', {**registry, 'regions': [
        {**region, 'data_path': 'data' if region['data_path'] == '.' else 'data/' + region['data_path']}
        for region in registry['regions']]})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--boundary-root", type=Path, default=PROJECT_ROOT.parent / "data" / "regions")
    parser.add_argument("--staging-root", type=Path, default=PROJECT_ROOT.parent / "data" / "regions-staging")
    parser.add_argument("--output-root", type=Path, default=PROJECT_ROOT / "web" / "data")
    parser.add_argument("--regions", nargs="+")
    args = parser.parse_args()
    results = build_regions(args.source_dir, args.boundary_root, args.staging_root, args.output_root, args.regions)
    print(json.dumps({key: {"county": value["meta"]["county"], "qualifying": value["quality"]["qualifying"],
                            "validation": value["validation"]} for key, value in results.items()}, indent=2))


if __name__ == "__main__":
    main()
