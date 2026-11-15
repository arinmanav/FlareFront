"""Compare count calibrations without replacing the published county records."""

import argparse
from collections import Counter
import csv
from datetime import date
import hashlib
import json
import math
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
PROTOCOL_PATH = Path(__file__).with_name('harmonization_protocol.json')


def valid_count(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def validate_rows(rows):
    if not rows:
        raise ValueError('No paired months supplied')
    seen = set()
    for row in rows:
        key = (row['year'], row['month'])
        date(*key, 1)
        if key in seen:
            raise ValueError('Duplicate paired month')
        seen.add(key)
        for sensor in ('terra', 'snpp'):
            if not valid_count(row.get(sensor)):
                raise ValueError('Missing or invalid sensor count; zero filling is not permitted')
            parts = [row.get(sensor + '_' + period) for period in ('day', 'night')]
            if not all(valid_count(value) for value in parts) or not math.isclose(sum(parts), row[sensor], abs_tol=1e-9):
                raise ValueError('Solar acquisition counts must partition the original sensor count')


def paired_rows(dashboard, points, protocol):
    columns = {name: index for index, name in enumerate(points['columns'])}
    if not {'date', 'time', 'lon', 'sensor'}.issubset(columns):
        raise ValueError('Point timestamps, sensor identities and longitudes are required')
    counts = Counter()
    for point in points['rows']:
        sensor = point[columns['sensor']]
        instant = date.fromisoformat(point[columns['date']])
        if sensor not in ('terra', 'snpp') or not protocol['training_start'] <= instant.year <= protocol['benchmark_end']:
            continue
        hhmm = str(point[columns['time']]).zfill(4)
        if len(hhmm) != 4 or not hhmm.isdigit() or int(hhmm[:2]) > 23 or int(hhmm[2:]) > 59:
            raise ValueError('Invalid acquisition HHMM')
        longitude = point[columns['lon']]
        if not isinstance(longitude, (int, float)) or not math.isfinite(longitude) or not -180 <= longitude <= 180:
            raise ValueError('Invalid acquisition longitude')
        solar_hour = (int(hhmm[:2]) + int(hhmm[2:]) / 60 + longitude / 15) % 24
        period = 'day' if 6 <= solar_hour < 18 else 'night'
        counts[(instant.year, instant.month, sensor, period)] += 1
    rows = []
    for original in dashboard['months']:
        if protocol['training_start'] <= original['year'] <= protocol['benchmark_end']:
            row = {key: original[key] for key in ('year', 'month', 'terra', 'snpp')}
            for sensor in ('terra', 'snpp'):
                for period in ('day', 'night'):
                    row[sensor + '_' + period] = counts[(row['year'], row['month'], sensor, period)]
            rows.append(row)
    validate_rows(rows)
    expected = {(year, month) for year in range(protocol['training_start'], protocol['benchmark_end'] + 1) for month in range(1, 13)}
    if {(row['year'], row['month']) for row in rows} != expected:
        raise ValueError('The benchmark requires complete paired months in the declared periods')
    return sorted(rows, key=lambda row: (row['year'], row['month']))


def design_matrix(rows, seasonal):
    source = np.array([row['snpp'] for row in rows], dtype=float)
    columns = [np.ones(len(rows)), np.log1p(source)]
    if seasonal:
        angle = 2 * np.pi * (np.array([row['month'] for row in rows]) - 1) / 12
        columns.extend((np.sin(angle), np.cos(angle)))
    return np.column_stack(columns)


def fit_poisson(rows, seasonal, penalty):
    if not math.isfinite(penalty) or penalty <= 0:
        raise ValueError('A positive shrinkage penalty is required')
    x = design_matrix(rows, seasonal)
    y = np.array([row['terra'] for row in rows], dtype=float)
    prior = np.zeros(x.shape[1]); prior[1] = 1
    regularization = np.full(x.shape[1], penalty); regularization[0] = 0
    beta = prior.copy()
    beta[0] = math.log(y.sum() / sum(1 + row['snpp'] for row in rows))

    def objective(coef):
        eta = x @ coef
        with np.errstate(over='ignore', invalid='ignore'):
            value = np.mean(np.exp(eta) - y * eta) + np.sum(regularization * (coef - prior) ** 2) / 2
        return float(value) if np.isfinite(value) else math.inf

    for iteration in range(100):
        mu = np.exp(x @ beta)
        gradient = x.T @ (mu - y) / len(y) + regularization * (beta - prior)
        if np.max(np.abs(gradient)) <= 1e-8 * (1 + y.mean()):
            return {'coefficients': beta.tolist(), 'iterations': iteration, 'gradient_max': float(np.max(np.abs(gradient)))}
        hessian = (x.T * mu) @ x / len(y) + np.diag(regularization)
        step = np.linalg.solve(hessian, gradient)
        before = objective(beta)
        fraction = 1.0
        for _ in range(40):
            proposal = beta - fraction * step
            if objective(proposal) <= before - 1e-4 * fraction * float(gradient @ step):
                beta = proposal
                break
            fraction /= 2
        else:
            raise ValueError('Poisson line search failed; no fitted model returned')
    raise ValueError('Poisson optimization did not converge')


def fit_model(rows, candidate):
    validate_rows(rows)
    rows = sorted(rows, key=lambda row: (row['year'], row['month']))
    if candidate.get('recent_years'):
        rows = [row for row in rows if row['year'] >= rows[-1]['year'] - candidate['recent_years'] + 1]
    source_total = sum(row['snpp'] for row in rows)
    reference_total = sum(row['terra'] for row in rows)
    if source_total <= 0 or reference_total <= 0:
        raise ValueError('Positive paired training totals are required')
    model = {**candidate, 'training_start_year': rows[0]['year'], 'training_end_year': rows[-1]['year'],
             'training_months': len(rows), 'training_terra_total': reference_total, 'training_snpp_total': source_total}
    kind = candidate['kind']
    if kind == 'ratio':
        model['alpha'] = reference_total / source_total
    elif kind in ('quarter_ratio', 'solar_ratio'):
        prior = candidate['prior_fraction']
        if not math.isfinite(prior) or prior <= 0:
            raise ValueError('A positive prior fraction is required')
        groups = range(4) if kind == 'quarter_ratio' else ('day', 'night')
        model['factors'] = {}
        for group in groups:
            if kind == 'quarter_ratio':
                part = [row for row in rows if (row['month'] - 1) // 3 == group]
                reference = sum(row['terra'] for row in part)
                source = sum(row['snpp'] for row in part)
            else:
                reference = sum(row['terra_' + group] for row in rows)
                source = sum(row['snpp_' + group] for row in rows)
            model['factors'][str(group)] = (reference + prior * reference_total / len(groups)) / (source + prior * source_total / len(groups))
    elif kind == 'poisson':
        model.update(fit_poisson(rows, candidate['seasonal'], candidate['penalty']))
    else:
        raise ValueError('Unknown count calibration')
    return model


def predict(model, rows):
    if model['kind'] == 'ratio':
        values = [model['alpha'] * row['snpp'] for row in rows]
    elif model['kind'] == 'quarter_ratio':
        values = [model['factors'][str((row['month'] - 1) // 3)] * row['snpp'] for row in rows]
    elif model['kind'] == 'solar_ratio':
        values = [sum(model['factors'][period] * row['snpp_' + period] for period in ('day', 'night')) for row in rows]
    elif model['kind'] == 'poisson':
        with np.errstate(over='ignore'):
            values = np.exp(design_matrix(rows, model['seasonal']) @ np.array(model['coefficients'])).tolist()
    else:
        raise ValueError('Unknown fitted model')
    if not all(valid_count(value) for value in values):
        raise ValueError('Non-finite or negative prediction; values are not clipped')
    return values


def metrics(rows, predictions, peak_months=5):
    y = np.array([row['terra'] for row in rows], dtype=float)
    p = np.array(predictions, dtype=float)
    if not len(y) or y.shape != p.shape or not np.all(np.isfinite(p)) or np.any(p < 0):
        raise ValueError('Finite nonnegative predictions must match paired observations')
    error = p - y
    peak = np.argsort(-y, kind='stable')[:peak_months]
    actual = float(y.sum()); predicted = float(p.sum())
    return {'months': len(y), 'mae': float(np.mean(np.abs(error))), 'rmse': float(np.sqrt(np.mean(error ** 2))),
            'observed_total': actual, 'predicted_total': predicted, 'signed_bias': predicted - actual,
            'relative_bias_percent': (predicted - actual) / actual * 100 if actual else None,
            'pearson_r': float(np.corrcoef(y, p)[0, 1]) if np.ptp(y) > 0 and np.ptp(p) > 0 else None,
            'peak_mae': float(np.mean(np.abs(error[peak]))),
            'peak_month_keys': [f"{rows[i]['year']}-{rows[i]['month']:02d}" for i in peak],
            'active_month_mae': float(np.mean(np.abs(error[y > 0]))) if np.any(y > 0) else None}


def choose_candidate(scores, protocol):
    baseline = scores['ratio']
    rule = protocol['selection']
    eligible = [candidate['id'] for candidate in protocol['candidates'] if candidate['id'] in scores
                and scores[candidate['id']]['mae'] < baseline['mae'] * (1 - rule['minimum_relative_improvement'])
                and scores[candidate['id']]['peak_mae'] <= baseline['peak_mae'] * rule['maximum_peak_mae_ratio']]
    return min(eligible, key=lambda key: scores[key]['mae']) if eligible else 'ratio'


def select_model(training_rows, protocol):
    if any(not protocol['training_start'] <= row['year'] <= protocol['training_end'] for row in training_rows):
        raise ValueError('Model selection received a row outside the training period')
    scores, folds, failures = {}, {}, {}
    for candidate in protocol['candidates']:
        observed, predictions, candidate_folds = [], [], []
        try:
            for year in protocol['validation_years']:
                fit_rows = [row for row in training_rows if row['year'] < year]
                validation_rows = [row for row in training_rows if row['year'] == year]
                if len(validation_rows) != 12 or not fit_rows:
                    raise ValueError('Incomplete forward-validation fold')
                model = fit_model(fit_rows, candidate)
                predicted = predict(model, validation_rows)
                observed.extend(validation_rows); predictions.extend(predicted)
                candidate_folds.append({'training_end': year - 1, 'validation_year': year,
                                        'metrics': metrics(validation_rows, predicted, protocol['selection']['peak_months'])})
            scores[candidate['id']] = metrics(observed, predictions, protocol['selection']['peak_months'])
            folds[candidate['id']] = candidate_folds
        except (ValueError, np.linalg.LinAlgError) as error:
            failures[candidate['id']] = str(error)
    if 'ratio' not in scores:
        raise ValueError('Baseline could not be evaluated: ' + failures.get('ratio', 'missing baseline'))
    return {'selected': choose_candidate(scores, protocol), 'scores': scores, 'folds': folds, 'failures': failures}


def evaluate_county(rows, protocol):
    validate_rows(rows)
    rows = sorted(rows, key=lambda row: (row['year'], row['month']))
    training = [row for row in rows if protocol['training_start'] <= row['year'] <= protocol['training_end']]
    benchmark = [row for row in rows if protocol['benchmark_start'] <= row['year'] <= protocol['benchmark_end']]
    selection = select_model(training, protocol)
    seasonal = {month: float(np.median([row['terra'] for row in training if row['month'] == month])) for month in range(1, 13)}
    results, records, failures = {}, [], {}
    frozen_models = {}
    for candidate in protocol['candidates']:
        try:
            frozen_models[candidate['id']] = fit_model(training, candidate)
        except (ValueError, np.linalg.LinAlgError) as error:
            failures[candidate['id']] = str(error)
    for key, model in frozen_models.items():
        try:
            values = predict(model, benchmark)
            results[key] = {'model': model, 'metrics': metrics(benchmark, values, protocol['selection']['peak_months']),
                            'by_year': {str(year): metrics([row for row in benchmark if row['year'] == year],
                                [value for row, value in zip(benchmark, values) if row['year'] == year], protocol['selection']['peak_months'])
                                for year in range(protocol['benchmark_start'], protocol['benchmark_end'] + 1)}}
            records.extend({'method': key, 'year': row['year'], 'month': row['month'], 'terra': row['terra'],
                            'snpp': row['snpp'], 'predicted': value} for row, value in zip(benchmark, values))
        except ValueError as error:
            failures[key] = str(error)
    return {'selection': selection, 'benchmark': results, 'benchmark_failures': failures,
            'seasonal_baseline': metrics(benchmark, [seasonal[row['month']] for row in benchmark], protocol['selection']['peak_months']),
            'raw_baseline': metrics(benchmark, [row['snpp'] for row in benchmark], protocol['selection']['peak_months'])}, records


def validate_output_directory(output):
    output = Path(output).resolve()
    for protected in (ROOT / 'web', ROOT / 'dist', ROOT / 'analysis', ROOT / 'tests'):
        if output == protected or protected in output.parents or output in protected.parents:
            raise ValueError('Benchmark output must be separate from runtime data and source directories')
    return output


def run(output, protocol_path=PROTOCOL_PATH):
    output = validate_output_directory(output)
    protocol_bytes = Path(protocol_path).read_bytes()
    protocol = json.loads(protocol_bytes)
    registry_path = ROOT / 'web/data/regions.json'
    registry = json.loads(registry_path.read_bytes())
    report = {'protocol': protocol, 'protocol_sha256': hashlib.sha256(protocol_bytes).hexdigest(),
              'numpy_version': np.__version__, 'inputs': [], 'regions': {}}
    all_predictions, summary = [], []
    for region in registry['regions']:
        data_path = ROOT / 'web' / region['data_path']
        source = {}
        for name in ('dashboard', 'points'):
            path = data_path / (name + '.json'); payload = path.read_bytes()
            report['inputs'].append({'path': path.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(payload).hexdigest()})
            source[name] = json.loads(payload)
        if source['dashboard']['meta']['geoid'] != region['geoid']:
            raise ValueError('County registry and dashboard identity disagree')
        rows = paired_rows(source['dashboard'], source['points'], protocol)
        result, predictions = evaluate_county(rows, protocol)
        result['county'] = region['county']; report['regions'][region['id']] = result
        all_predictions.extend({'region': region['id'], **row} for row in predictions)
        for key, value in result['benchmark'].items():
            summary.append({'region': region['id'], 'method': key, 'selected': key == result['selection']['selected'],
                            'validation_mae': result['selection']['scores'].get(key, {}).get('mae'),
                            **{name: metric for name, metric in value['metrics'].items() if name != 'peak_month_keys'}})
    output.mkdir(parents=True, exist_ok=True)
    (output / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    for name, rows in [('summary.csv', summary), ('predictions.csv', all_predictions)]:
        with (output / name).open('w', encoding='utf-8', newline='') as handle:
            writer = csv.DictWriter(handle, fieldnames=list(rows[0])); writer.writeheader(); writer.writerows(rows)
    print(json.dumps({key: {'selected': value['selection']['selected'],
        'old_mae': value['benchmark']['ratio']['metrics']['mae'],
        'selected_mae': value['benchmark'].get(value['selection']['selected'], {}).get('metrics', {}).get('mae'),
        'failures': value['benchmark_failures']} for key, value in report['regions'].items()}, indent=2))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    run(args.output_dir)
