"""Reproduce fixed-budget location/week rankings from the county hotspot archives."""

from collections import Counter
from datetime import date, timedelta
from hashlib import sha256
import json
import math
from pathlib import Path

from shapely.geometry import box, mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
PROTOCOL = Path(__file__).with_name('prediction_protocol.json')
METHOD_NAMES = {
    'seasonal': 'Seasonal History',
    'recent': 'Recent VIIRS',
    'history_recent': 'History + Recent VIIRS',
    'multisensor': 'History + MODIS / VIIRS',
}


def windows(protocol):
    origin = date.fromisoformat(protocol['evaluation_start'])
    end = date.fromisoformat(protocol['evaluation_end_exclusive'])
    step = timedelta(days=protocol['horizon_days'])
    while origin + step <= end:
        yield origin
        origin += step


def cell_key(lat, lon, step):
    return f'{math.floor(lat / step)}:{math.floor(lon / step)}'


def load_points(path, step):
    payload = json.loads(path.read_text(encoding='utf-8'))
    columns = {name: index for index, name in enumerate(payload['columns'])}
    return [{'date': date.fromisoformat(row[columns['date']]),
             'sensor': row[columns['sensor']],
             'cell': cell_key(row[columns['lat']], row[columns['lon']], step)}
            for row in payload['rows']]


def grid_for(boundary, step):
    geometry = unary_union([shape(feature['geometry']) for feature in boundary['features']])
    west, south, east, north = geometry.bounds
    cells = []
    for latitude in range(math.floor(south / step), math.floor(north / step) + 1):
        for longitude in range(math.floor(west / step), math.floor(east / step) + 1):
            clipped = geometry.intersection(box(longitude * step, latitude * step,
                                                (longitude + 1) * step, (latitude + 1) * step))
            if clipped.is_empty or clipped.area <= 0:
                continue
            point = clipped.representative_point()
            cells.append({'id': f'{latitude}:{longitude}', 'label': f'Area {len(cells) + 1:02d}',
                          'center': [round(point.x, 5), round(point.y, 5)],
                          'geometry': mapping(clipped.simplify(0.001, preserve_topology=True))})
    return cells


def normalized(values):
    total = sum(values)
    return [value / total for value in values] if total else [0.0] * len(values)


def rank_window(points, cell_ids, origin, alpha, protocol):
    train_start = date.fromisoformat(protocol['training_start'])
    train_end = date.fromisoformat(protocol['training_end_exclusive'])
    if train_end > origin or not math.isfinite(alpha) or alpha < 0:
        raise ValueError('Training must precede the origin and calibration must be nonnegative.')
    seasonal = Counter((point['date'].month, point['cell']) for point in points
                       if point['sensor'] == 'snpp' and train_start <= point['date'] < train_end)
    denominators = Counter()
    day = train_start
    while day < train_end:
        denominators[day.month] += 1
        day += timedelta(days=1)
    cutoff = origin - timedelta(days=protocol['embargo_days'])
    recent_start = cutoff - timedelta(days=protocol['lookback_days'])
    recent = Counter((point['sensor'], point['cell']) for point in points
                     if recent_start <= point['date'] < cutoff)
    candidates = [(week, cell) for week in range(protocol['horizon_days'] // protocol['week_days']) for cell in cell_ids]
    history_scores = []
    for week, cell in candidates:
        days = [origin + timedelta(days=week * protocol['week_days'] + offset) for offset in range(protocol['week_days'])]
        history_scores.append(sum(seasonal[(day.month, cell)] / denominators[day.month] for day in days))
    history_scores = normalized(history_scores)
    recent_scores = normalized([recent[('snpp', cell)] for _, cell in candidates])
    sensor_scores = normalized([recent[('terra', cell)] + alpha * recent[('snpp', cell)] for _, cell in candidates])
    weight = protocol['history_weight']
    scores = {'seasonal': history_scores, 'recent': recent_scores,
              'history_recent': [weight * h + (1 - weight) * r for h, r in zip(history_scores, recent_scores)],
              'multisensor': [weight * h + (1 - weight) * r for h, r in zip(history_scores, sensor_scores)]}
    selections = {}
    for method in protocol['methods']:
        index = max(range(len(candidates)), key=lambda index: scores[method][index])
        week, cell = candidates[index]
        selections[method] = {'cell': cell, 'week': week, 'score': scores[method][index]}
    return selections, {cell: recent[('snpp', cell)] for cell in cell_ids}, cutoff


def observed_outcomes(points, origin, protocol):
    end = origin + timedelta(days=protocol['horizon_days'])
    counts = Counter((point['cell'], (point['date'] - origin).days // protocol['week_days'])
                     for point in points if point['sensor'] == 'snpp' and origin <= point['date'] < end)
    return [{'cell': cell, 'week': week, 'detections': count} for (cell, week), count in sorted(counts.items())]


def score_pick(pick, outcomes):
    exact = [row for row in outcomes if row['cell'] == pick['cell'] and row['week'] == pick['week']]
    return {'hit': bool(exact), 'detections': sum(row['detections'] for row in exact),
            'location_hit': any(row['cell'] == pick['cell'] for row in outcomes),
            'week_hit': any(row['week'] == pick['week'] for row in outcomes)}


def build_region(region, protocol):
    directory = ROOT / 'web' / region['data_path']
    points_path = directory / 'points.json'
    points = load_points(points_path, protocol['grid_degrees'])
    boundary_path = directory / 'county.geojson'
    cells = grid_for(json.loads(boundary_path.read_text(encoding='utf-8')), protocol['grid_degrees'])
    cell_ids = [cell['id'] for cell in cells]
    if not all(point['cell'] in cell_ids for point in points):
        raise ValueError('A qualifying observation falls outside the county grid.')
    dashboard_path = directory / 'dashboard.json'
    dashboard = json.loads(dashboard_path.read_text(encoding='utf-8'))
    alpha = dashboard['meta']['alpha']
    cases = []
    for origin in windows(protocol):
        selections, recent, cutoff = rank_window(points, cell_ids, origin, alpha, protocol)
        outcomes = observed_outcomes(points, origin, protocol)
        cases.append({'origin': origin.isoformat(), 'end_exclusive': (origin + timedelta(days=28)).isoformat(),
                      'input_end_exclusive': cutoff.isoformat(), 'recent_snpp': recent,
                      'picks': selections, 'outcomes': outcomes,
                      'scores': {method: score_pick(pick, outcomes) for method, pick in selections.items()}})
    metrics = {}
    for method in protocol['methods']:
        hits = sum(case['scores'][method]['hit'] for case in cases)
        metrics[method] = {'hits': hits, 'windows': len(cases), 'hit_rate': hits / len(cases),
                           'location_hits': sum(case['scores'][method]['location_hit'] for case in cases),
                           'week_hits': sum(case['scores'][method]['week_hit'] for case in cases),
                           'captured_active_cell_weeks': hits,
                           'observed_active_cell_weeks': sum(len(case['outcomes']) for case in cases)}
    return {**region, 'alpha': alpha, 'cells': cells, 'cases': cases, 'metrics': metrics,
            'quiet_windows': sum(not case['outcomes'] for case in cases),
            'source_sha256': {path.name: sha256(path.read_bytes()).hexdigest()
                              for path in [points_path, boundary_path, dashboard_path]}}


def build():
    protocol = json.loads(PROTOCOL.read_text(encoding='utf-8'))
    registry = json.loads((ROOT / 'web/data/regions.json').read_text(encoding='utf-8'))
    regions = [build_region(region, protocol) for region in registry['regions']]
    result = {'schema_version': 1, 'protocol': protocol, 'method_names': METHOD_NAMES, 'regions': regions,
              'protocol_sha256': sha256(PROTOCOL.read_bytes()).hexdigest()}
    output = ROOT / 'web/data/prediction.json'
    output.write_text(json.dumps(result, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf-8')
    for region in regions:
        print(region['city'], len(region['cells']), 'cells;', ', '.join(f'{method}: {value["hits"]}/{value["windows"]}' for method, value in region['metrics'].items()))
    print(f'Wrote {output.name}: {output.stat().st_size} bytes')


if __name__ == '__main__':
    build()
