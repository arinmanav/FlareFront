"""Compare raw-count and spatial-occupancy calibrations against Terra."""

import argparse
from collections import Counter
from datetime import date, datetime
from hashlib import sha256
import json
import math
from pathlib import Path

import numpy as np

from analysis.benchmark_harmonization import choose_candidate, metrics, paired_rows, valid_count


ROOT = Path(__file__).resolve().parents[1]
PROTOCOL_PATH = Path(__file__).with_name('spatial_harmonization_protocol.json')


def project(latitude, longitude, grid):
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
               for v in (latitude, longitude)) or not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ValueError('Invalid source coordinates')
    scale = math.cos(math.radians(grid['standard_parallel_degrees']))
    radius = grid['radius_metres']
    return radius * math.radians(longitude) * scale, radius * math.sin(math.radians(latitude)) / scale


def occupied_cells(positions, grid):
    size = grid['cell_size_metres']
    if not math.isfinite(size) or size <= 0 or not grid['offset_fractions']:
        raise ValueError('Positive grid size and fixed origins are required')
    return sum(len({(math.floor(x / size - dx), math.floor(y / size - dy)) for x, y in positions})
               for dx, dy in grid['offset_fractions']) / len(grid['offset_fractions'])


def monthly_occupancy(points, grid):
    columns = {name: index for index, name in enumerate(points['columns'])}
    if not {'date', 'time', 'lat', 'lon', 'sensor'}.issubset(columns):
        raise ValueError('Source coordinates, dates, times and sensor identities are required')
    acquisitions = []
    for row in points['rows']:
        if row[columns['sensor']] != 'snpp':
            continue
        day = date.fromisoformat(row[columns['date']])
        hhmm = str(row[columns['time']]).zfill(4)
        if len(hhmm) != 4 or not hhmm.isdigit() or int(hhmm[:2]) > 23 or int(hhmm[2:]) > 59:
            raise ValueError('Invalid source acquisition HHMM')
        instant = datetime(day.year, day.month, day.day, int(hhmm[:2]), int(hhmm[2:]))
        acquisitions.append((instant, project(row[columns['lat']], row[columns['lon']], grid)))
    acquisitions.sort(key=lambda item: item[0])
    totals, positions, previous = Counter(), [], None
    for instant, position in acquisitions:
        if previous is not None and (instant.date() != previous.date()
                or (instant - previous).total_seconds() > grid['acquisition_gap_minutes'] * 60):
            totals[(previous.year, previous.month)] += occupied_cells(positions, grid)
            positions = []
        positions.append(position)
        previous = instant
    if previous is not None:
        totals[(previous.year, previous.month)] += occupied_cells(positions, grid)
    return totals


def prepare_rows(dashboard, points, protocol):
    rows = paired_rows(dashboard, points, protocol)
    occupancy = monthly_occupancy(points, protocol['grid'])
    for row in rows:
        row['occupancy'] = occupancy[(row['year'], row['month'])]
        if not 0 <= row['occupancy'] <= row['snpp'] or (row['snpp'] > 0 and row['occupancy'] == 0):
            raise ValueError('Spatial occupancy does not reconcile with source detections')
    return rows


def fit(rows, candidate):
    if not rows or any(not valid_count(row.get(key)) for row in rows for key in ('terra', candidate['feature'])):
        raise ValueError('Complete finite nonnegative training pairs are required')
    x = np.array([row[candidate['feature']] for row in rows], dtype=float)
    y = np.array([row['terra'] for row in rows], dtype=float)
    if x.sum() <= 0:
        raise ValueError('Positive source training total is required')
    if candidate['fit'] == 'ratio':
        coefficient = float(y.sum() / x.sum())
    elif candidate['fit'] == 'lad':
        positive = x > 0
        ratios, weights = y[positive] / x[positive], x[positive]
        order = np.argsort(ratios, kind='stable')
        median = np.searchsorted(np.cumsum(weights[order]), weights.sum() / 2, side='left')
        coefficient = float(ratios[order[median]])
    else:
        raise ValueError('Unknown calibration fit')
    return {**candidate, 'coefficient': coefficient, 'training_end': max(row['year'] for row in rows),
            'training_months': len(rows), 'training_feature_total': float(x.sum()), 'training_reference_total': float(y.sum())}


def predict(model, rows):
    values = [row.get(model['feature']) for row in rows]
    if not all(valid_count(value) for value in values):
        raise ValueError('Missing or invalid source feature')
    return [model['coefficient'] * value for value in values]


def select(training, protocol):
    if any(not protocol['training_start'] <= row['year'] <= protocol['training_end'] for row in training):
        raise ValueError('Selection received data outside the training period')
    scores, folds, failures = {}, {}, {}
    for candidate in protocol['candidates']:
        observed, estimates, records = [], [], []
        try:
            for year in protocol['validation_years']:
                past = [row for row in training if row['year'] < year]
                future = [row for row in training if row['year'] == year]
                if len(future) != 12:
                    raise ValueError('Incomplete forward-validation year')
                model = fit(past, candidate)
                predictions = predict(model, future)
                observed.extend(future)
                estimates.extend(predictions)
                records.append({'validation_year': year, 'model': model,
                                'metrics': metrics(future, predictions, protocol['selection']['peak_months'])})
            scores[candidate['id']] = metrics(observed, estimates, protocol['selection']['peak_months'])
            folds[candidate['id']] = records
        except ValueError as error:
            failures[candidate['id']] = str(error)
    if 'ratio' not in scores:
        raise ValueError('Original count ratio cannot be evaluated')
    return {'selected': choose_candidate(scores, protocol), 'scores': scores, 'folds': folds, 'failures': failures}


def evaluate(rows, protocol):
    training = [row for row in rows if protocol['training_start'] <= row['year'] <= protocol['training_end']]
    benchmark = [row for row in rows if protocol['benchmark_start'] <= row['year'] <= protocol['benchmark_end']]
    expected = {(year, month) for year in range(protocol['training_start'], protocol['benchmark_end'] + 1) for month in range(1, 13)}
    if len(rows) != len(expected) or {(row['year'], row['month']) for row in rows} != expected:
        raise ValueError('A complete, unique monthly comparison record is required')
    benchmark.sort(key=lambda row: (row['year'], row['month']))
    selection = select(training, protocol)
    models = {candidate['id']: fit(training, candidate) for candidate in protocol['candidates']}
    predictions = {key: predict(model, benchmark) for key, model in models.items()}
    predictions['raw'] = [row['snpp'] for row in benchmark]
    seasonal = {month: float(np.median([row['terra'] for row in training if row['month'] == month])) for month in range(1, 13)}
    predictions['seasonal'] = [seasonal[row['month']] for row in benchmark]
    predictions['selected'] = predictions[selection['selected']]
    records = [{'date': f"{row['year']}-{row['month']:02d}-01", 'year': row['year'], 'month': row['month'],
                'terra': row['terra'], 'occupancy': row['occupancy'],
                **{key: values[index] for key, values in predictions.items()}} for index, row in enumerate(benchmark)]
    return {'selection': selection, 'models': models, 'months': records,
            'metrics': {key: metrics(benchmark, values, protocol['selection']['peak_months']) for key, values in predictions.items()},
            'by_year': {str(year): {key: metrics([row for row in benchmark if row['year'] == year],
                       [value for row, value in zip(benchmark, values) if row['year'] == year], protocol['selection']['peak_months'])
                       for key, values in predictions.items()}
                       for year in range(protocol['benchmark_start'], protocol['benchmark_end'] + 1)}}


def build():
    protocol_bytes = PROTOCOL_PATH.read_bytes()
    protocol = json.loads(protocol_bytes)
    registry_path = ROOT / 'web/data/regions.json'
    registry = json.loads(registry_path.read_bytes())
    report = {'schema_version': 1, 'protocol': protocol, 'protocol_sha256': sha256(protocol_bytes).hexdigest(),
              'numpy_version': np.__version__, 'inputs': [], 'regions': []}
    for region in registry['regions']:
        payloads = {}
        for name in ('dashboard', 'points'):
            path = ROOT / 'web' / region['data_path'] / (name + '.json')
            content = path.read_bytes()
            payloads[name] = json.loads(content)
            report['inputs'].append({'path': path.relative_to(ROOT).as_posix(), 'sha256': sha256(content).hexdigest()})
        if payloads['dashboard']['meta']['geoid'] != region['geoid']:
            raise ValueError('County identity does not match its data')
        rows = prepare_rows(payloads['dashboard'], payloads['points'], protocol)
        result = evaluate(rows, protocol)
        if not math.isclose(result['models']['ratio']['coefficient'], payloads['dashboard']['meta']['alpha'], rel_tol=1e-12):
            raise ValueError('Original calibration was not reproduced')
        report['regions'].append({key: region[key] for key in ('id', 'city', 'county')} | result)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = build()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps([{ 'county': region['county'], 'selected': region['selection']['selected'],
                       'mae': {key: round(value['mae'], 6) for key, value in region['metrics'].items()},
                       'cv_mae': {key: round(value['mae'], 6) for key, value in region['selection']['scores'].items()} }
                     for region in result['regions']], indent=2))
