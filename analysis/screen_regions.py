"""Screen California counties using training-only forward validation, then freeze identities."""

import argparse
from collections import Counter
import csv
from hashlib import sha256
import json
import math
from pathlib import Path
from statistics import mean, median
import urllib.parse
import urllib.request

from shapely.geometry import shape

from analysis.build_data import build, load_config, qualify_records, write_json
from analysis.stage_firms import inspect_region_archives


ROOT = Path(__file__).resolve().parents[1]
PROTOCOL_PATH = Path(__file__).with_name('selection_protocol.json')
BOUNDARY_URL = ('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/'
                'State_County/MapServer/1/query?' + urllib.parse.urlencode({
                    'where': "STATE='06'", 'outFields': 'GEOID,NAME,STATE,COUNTY',
                    'outSR': '4326', 'f': 'geojson', 'returnGeometry': 'true'}))


def load_boundaries(path, download=False):
    path = Path(path)
    if download:
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(BOUNDARY_URL, timeout=120) as response:
            content = response.read()
        path.write_bytes(content)
    content = path.read_bytes()
    data = json.loads(content)
    features = sorted(data.get('features', []), key=lambda feature: feature['properties']['GEOID'])
    if len(features) != 58 or len({feature['properties']['GEOID'] for feature in features}) != 58:
        raise ValueError('The screen requires exactly 58 distinct California county polygons')
    for feature in features:
        geometry = shape(feature['geometry'])
        if not feature['properties']['GEOID'].startswith('06') or geometry.is_empty or not geometry.is_valid:
            raise ValueError('Invalid California county geometry')
    return features, {'url': BOUNDARY_URL, 'sha256': sha256(content).hexdigest(),
                      'county_count': 58, 'boundary_vintage': '2026'}


def score_county(rows, protocol):
    if any(not protocol['training_start'] <= row['year'] <= protocol['training_end'] for row in rows):
        raise ValueError('County selection must not receive data outside the training years')
    expected = {(year, month) for year in range(protocol['training_start'], protocol['training_end'] + 1)
                for month in range(1, 13)}
    keys = [(row['year'], row['month']) for row in rows]
    reasons = []
    complete = len(keys) == len(expected) and set(keys) == expected
    finite = all(isinstance(row.get(sensor), (int, float)) and not isinstance(row.get(sensor), bool)
                 and math.isfinite(row[sensor]) and row[sensor] >= 0 for row in rows for sensor in ('terra', 'snpp'))
    if not complete or not finite:
        return {'eligible': False, 'reasons': ['incomplete_or_invalid_training_months'], 'passed': False,
                'training_months': len(rows), 'folds': [], 'cv_months': 0}
    terra_total = sum(row['terra'] for row in rows)
    positive = sum(row['terra'] > 0 for row in rows)
    if terra_total < protocol['minimum_terra_detections']:
        reasons.append('insufficient_terra_detections')
    if positive < protocol['minimum_positive_terra_months']:
        reasons.append('insufficient_positive_terra_months')
    result = {'eligible': not reasons, 'reasons': reasons, 'passed': False, 'training_months': len(rows),
              'training_terra_total': terra_total, 'training_snpp_total': sum(row['snpp'] for row in rows),
              'positive_terra_months': positive, 'folds': [], 'cv_months': 0}
    # Every county with estimable folds is scored, including counties below activity thresholds.
    errors = {method: [] for method in ('ratio', 'raw', 'seasonal')}
    observed = []
    for year in protocol['validation_years']:
        past = [row for row in rows if row['year'] < year]
        future = sorted((row for row in rows if row['year'] == year), key=lambda row: row['month'])
        source_total = sum(row['snpp'] for row in past)
        if source_total <= 0:
            result['eligible'] = False
            result['reasons'].append('nonpositive_forward_training_snpp_total')
            return result
        alpha = sum(row['terra'] for row in past) / source_total
        seasonal = {month: median(row['terra'] for row in past if row['month'] == month) for month in range(1, 13)}
        months = []
        for row in future:
            predictions = {'ratio': alpha * row['snpp'], 'raw': row['snpp'], 'seasonal': seasonal[row['month']]}
            for method, value in predictions.items():
                errors[method].append(abs(value - row['terra']))
            observed.append(row['terra'])
            months.append({**row, **{method + '_prediction': value for method, value in predictions.items()}})
        result['folds'].append({'validation_year': year, 'training_start': protocol['training_start'],
            'training_end': year - 1, 'training_months': len(past), 'alpha': alpha,
            'training_terra_total': sum(row['terra'] for row in past), 'training_snpp_total': source_total,
            'validation_months': months})
    result['cv_months'] = len(observed)
    result['mae'] = {method: mean(values) for method, values in errors.items()}
    result['mean_validation_terra'] = mean(observed)
    result['normalized_ratio_mae'] = result['mae']['ratio'] / mean(observed) if mean(observed) > 0 else None
    result['passed'] = result['eligible'] and result['mae']['ratio'] < min(result['mae']['raw'], result['mae']['seasonal'])
    return result


def select_counties(scores, count=5):
    candidates = [row for row in scores if row['eligible'] and row['passed']]
    candidates.sort(key=lambda row: (row['normalized_ratio_mae'], row['geoid']))
    if len(candidates) < count:
        raise ValueError(f'Only {len(candidates)} eligible counties pass; {count} required without relaxing the protocol')
    return candidates[:count]


def county_metadata(feature):
    properties = feature['properties']
    county = properties['NAME']
    if not county.endswith(' County'):
        county += ' County'
    slug = county.removesuffix(' County').lower().replace(' ', '-')
    return {'id': slug, 'city': county.removesuffix(' County'), 'county': county,
            'geoid': properties['GEOID'], 'data_path': 'regions/' + slug}


def screen(source_dir, boundary_path, staging_root, report_path):
    protocol_bytes = PROTOCOL_PATH.read_bytes()
    protocol = json.loads(protocol_bytes)
    features, boundary_source = load_boundaries(boundary_path)
    geometries = [shape(feature['geometry']) for feature in features]
    bounds = (min(g.bounds[0] for g in geometries), min(g.bounds[1] for g in geometries),
              max(g.bounds[2] for g in geometries), max(g.bounds[3] for g in geometries))
    stage = Path(staging_root) / 'training-california'
    inventories = []
    for product in ('modis', 'viirs-snpp'):
        inventory_path = stage / (product + '_inventory.json')
        if not inventory_path.exists():
            inspect_region_archives(source_dir, product, protocol['training_start'], protocol['training_end'],
                                    {'california': {'bounds': bounds, 'output_dir': stage}})
        inventory = json.loads(inventory_path.read_bytes())
        years = inventory['years']
        if [item['year'] for item in years] != list(range(2013, 2020)) or any(not item['member_crc32_verified'] for item in years):
            raise ValueError('Screen inputs must contain only verified 2013-2019 USA archive members')
        inventories.append(inventory)
    candidates = []
    for product in ('modis', 'viirs-snpp'):
        with (stage / (product + '_envelope.csv')).open(newline='', encoding='utf-8') as handle:
            for row in csv.DictReader(handle):
                if not 2013 <= int(row['acq_date'][:4]) <= 2019:
                    raise ValueError('Training stage contains later observations')
                if row['satellite'] in ('Terra', 'N'):
                    candidates.append(row)
    config = {**load_config(), 'start_date': '2013-01-01', 'end_date': '2019-12-31'}
    coordinates = [(float(row['longitude']), float(row['latitude'])) for row in candidates]
    scores = []
    for feature, geometry in zip(features, geometries):
        west, south, east, north = geometry.bounds
        raw = [row for row, (lon, lat) in zip(candidates, coordinates) if west <= lon <= east and south <= lat <= north]
        records, quality = qualify_records(raw, geometry, config)
        counts = Counter((int(row['date'][:4]), int(row['date'][5:7]), row['sensor']) for row in records)
        rows = [{'year': year, 'month': month, **{sensor: counts[(year, month, sensor)] for sensor in ('terra', 'snpp')}}
                for year in range(2013, 2020) for month in range(1, 13)]
        result = {**county_metadata(feature), **score_county(rows, protocol), 'qualification': quality}
        scores.append(result)
        print(json.dumps({'county': result['county'], 'eligible': result['eligible'], 'passed': result['passed'],
                          'normalized_ratio_mae': result.get('normalized_ratio_mae')}), flush=True)
    report = {'schema_version': 1, 'protocol': protocol, 'protocol_sha256': sha256(protocol_bytes).hexdigest(),
              'boundary_source': boundary_source, 'source_inventories': inventories, 'counties': scores,
              'selected': [], 'status': 'insufficient_passers'}
    try:
        selected = select_counties(scores, protocol['selected_count'])
    except ValueError:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        write_json(report_path, report)
        raise
    report['selected'] = [{key: row[key] for key in ('id', 'city', 'county', 'geoid', 'data_path')} for row in selected]
    report['status'] = 'identities_frozen_before_full_staging'
    report_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(report_path, report)
    return report, features


def build_selected(report, features, source_dir, staging_root, output_root):
    selected = report['selected']
    boundary_root = Path(staging_root) / 'selected-boundaries'
    stages = {}
    for region in selected:
        directory = boundary_root / region['id']
        directory.mkdir(parents=True, exist_ok=True)
        feature = next(feature for feature in features if feature['properties']['GEOID'] == region['geoid'])
        write_json(directory / 'county.geojson', {'type': 'FeatureCollection', 'features': [feature]})
        stages[region['id']] = {'bounds': shape(feature['geometry']).bounds,
                              'output_dir': Path(staging_root) / 'full-selected' / region['id']}
    config = load_config()
    for product, first in (('modis', 2001), ('viirs-snpp', 2012)):
        inspect_region_archives(source_dir, product, first, 2025, stages)
    summaries = []
    for region in selected:
        result = build(stages[region['id']]['output_dir'], Path(output_root) / region['data_path'],
                       {**config, 'county_geoid': region['geoid'], 'county_name': region['county']},
                       boundary_root / region['id'] / 'county.geojson')
        screened = next(row for row in report['counties'] if row['geoid'] == region['geoid'])
        training = result['validation']['training']
        if (training['terra_total'], training['snpp_total']) != (screened['training_terra_total'], screened['training_snpp_total']):
            raise ValueError('Full dataset does not reproduce the frozen training screen')
        summaries.append({'id': region['id'], 'validation': result['validation'], 'quality': result['quality']})
    registry = {'schema_version': 1, 'default_region': selected[0]['id'], 'regions': selected}
    write_json(ROOT / 'analysis/regions.json', registry)
    write_json(Path(output_root) / 'regions.json', {**registry, 'regions': [
        {**region, 'data_path': 'data/' + region['data_path']} for region in selected]})
    return summaries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--boundary', type=Path, required=True)
    parser.add_argument('--staging-root', type=Path, required=True)
    parser.add_argument('--download-boundaries', action='store_true')
    parser.add_argument('--build-selected', action='store_true')
    parser.add_argument('--report', type=Path, default=ROOT / 'web/data/location-screen.json')
    args = parser.parse_args()
    if args.download_boundaries:
        load_boundaries(args.boundary, download=True)
    report, features = screen(args.source_dir, args.boundary, args.staging_root, args.report)
    print(json.dumps({'frozen_selected': report['selected'], 'report_sha256': sha256(args.report.read_bytes()).hexdigest()}), flush=True)
    if args.build_selected:
        print(json.dumps(build_selected(report, features, args.source_dir, args.staging_root, ROOT / 'web/data')), flush=True)


if __name__ == '__main__':
    main()
