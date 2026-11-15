import { seriesValue } from './calendar.js';

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function completeYears(months, sensor) {
  if (!['terra', 'aqua', 'snpp'].includes(sensor)) throw new Error('Long-term patterns require one raw sensor.');
  const grouped = new Map();
  for (const row of months) {
    const year = grouped.get(row.year) ?? [];
    year.push(row);
    grouped.set(row.year, year);
  }
  return [...grouped.entries()].sort(([a], [b]) => a - b).flatMap(([year, rows]) => {
    const ordered = [...rows].sort((a, b) => a.month - b.month);
    if (ordered.length !== 12 || ordered.some((row, index) => row.month !== index + 1
      || seriesValue(row, sensor) === null || row[sensor] < 0
      || row.availability?.[sensor]?.startsWith('partial_first_month'))) return [];
    const values = ordered.map((row) => row[sensor]);
    return [{ year, values, total: values.reduce((sum, value) => sum + value, 0) }];
  });
}

function ranks(values) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
    for (let i = start; i < end; i++) result[sorted[i].index] = (start + end + 1) / 2;
    start = end;
  }
  return result;
}

export function correlation(a, b) {
  if (a.length !== b.length || a.length < 2 || [...a, ...b].some((value) => !Number.isFinite(value))) return null;
  const meanA = mean(a), meanB = mean(b);
  let product = 0, squareA = 0, squareB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - meanA, y = b[i] - meanB;
    product += x * y; squareA += x * x; squareB += y * y;
  }
  return squareA && squareB ? Math.max(-1, Math.min(1, product / Math.sqrt(squareA * squareB))) : null;
}

export function compareYears(a, b) {
  if (!a || !b || a.year === b.year) return { pearson: null, spearman: null };
  return { pearson: correlation(a.values, b.values), spearman: correlation(ranks(a.values), ranks(b.values)) };
}

export function longTermPatterns(months, sensor) {
  const years = completeYears(months, sensor), byYear = new Map(years.map((row) => [row.year, row]));
  const seasonal = Array.from({ length: 12 }, (_, month) => {
    const values = years.map((row) => row.values[month]);
    return { month: month + 1, mean: mean(values), median: median(values), years: values.length };
  });
  const annual = years.map(({ year, total }) => {
    const window = Array.from({ length: 5 }, (_, index) => byYear.get(year - 4 + index));
    return { year, total, fiveYearMean: window.every(Boolean) ? mean(window.map((row) => row.total)) : null };
  });
  const pairs = [];
  for (let i = 0; i < years.length; i++) for (let j = i + 1; j < years.length; j++) {
    pairs.push({ first: years[i].year, second: years[j].year, ...compareYears(years[i], years[j]) });
  }
  const eligible = pairs.filter((pair) => pair.spearman !== null);
  return { sensor, years, seasonal, annual, pairs, medianSimilarity: median(eligible.map((pair) => pair.spearman)), validPairs: eligible.length };
}
