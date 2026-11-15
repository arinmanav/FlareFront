import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { completeYears, longTermPatterns, correlation, compareYears } from '../web/patterns.js';

const year = (number, values) => values.map((value, index) => ({ year: number, month: index + 1, terra: value }));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} versus ${expected}`);

test('Given raw monthly records, long-term summaries retain complete years and zeros but exclude partial, missing and duplicate months', () => {
  const valid = year(2001, Array(12).fill(0));
  const missing = year(2002, Array(11).fill(1)), nullMonth = year(2003, [null, ...Array(11).fill(1)]);
  const duplicate = year(2004, Array(12).fill(1)); duplicate[0].month = 2;
  const partial = year(2005, Array(12).fill(1)); partial[0].availability = { terra: 'partial_first_month_coverage_unknown' };
  assert.deepEqual(completeYears([...valid, ...missing, ...nullMonth, ...duplicate, ...partial], 'terra'), [{ year: 2001, total: 0, values: Array(12).fill(0) }]);
  assert.throws(() => completeYears(valid, 'main'), /one raw sensor/);
});

test('Given complete years with an extreme season, monthly mean and median retain distinct independently known values', () => {
  const result = longTermPatterns([...year(2001, Array(12).fill(0)), ...year(2002, Array(12).fill(2)), ...year(2003, [100, ...Array(11).fill(4)])], 'terra');
  assert.deepEqual(result.seasonal[0], { month: 1, mean: 34, median: 2, years: 3 });
  assert.deepEqual(result.seasonal[1], { month: 2, mean: 2, median: 2, years: 3 });
  const even = longTermPatterns([...year(2001, Array(12).fill(0)), ...year(2002, Array(12).fill(4))], 'terra');
  assert.equal(even.seasonal[0].median, 2);
});

test('Given annual records with gaps, trailing five-year means require five consecutive complete years', () => {
  const rows = [2001, 2002, 2003, 2004, 2005, 2007].flatMap((number) => year(number, [number - 2000, ...Array(11).fill(0)]));
  const result = longTermPatterns(rows, 'terra');
  assert.deepEqual(result.annual.map((row) => row.fiveYearMean), [null, null, null, null, 3, null]);
});

test('Given year profiles with ties or constant values, correlations use average ranks and return unavailable for undefined comparisons', () => {
  assert.equal(correlation([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(correlation([2, 2, 2], [1, 2, 3]), null);
  assert.equal(correlation([1, 2], [1]), null);
  assert.equal(correlation([1, NaN], [1, 2]), null);
  const a = { year: 2001, values: [1, 1, 2, 3] }, b = { year: 2002, values: [1, 2, 2, 3] };
  close(compareYears(a, b).spearman, 5 / 6);
  assert.deepEqual(compareYears(a, a), { pearson: null, spearman: null });
});

test('Given the published county records, seasonal summaries and correlations match independent Python calculations', async () => {
  const cases = [
    ['data', 9, 63.64, 2, .05760437208791381, -.1944840771302778, -.08430031771838328, 83],
    ['data/regions/san-diego', 10, 77.32, 0, .042375529304806384, .6608141969859909, .5108910520108028, 21.2],
    ['data/regions/san-jose', 8, 25.72, 0, -.09090909090909093, -.09090909090909093, -.09090909090909091, 2.6],
    ['data/regions/sacramento', 10, 2.56, 2, .1824162705374861, .718, .3801952894892043, 23.4],
  ];
  for (const [path, peak, average, median, similarity, rho, r, fiveYear] of cases) {
    const data = JSON.parse(await readFile(new URL(`../web/${path}/dashboard.json`, import.meta.url)));
    const result = longTermPatterns(data.months, 'terra');
    assert.equal(result.years.length, 25); assert.equal(result.validPairs, 300);
    const maximum = result.seasonal.reduce((a, b) => a.mean > b.mean ? a : b);
    assert.equal(maximum.month, peak); close(maximum.mean, average); close(maximum.median, median);
    close(result.medianSimilarity, similarity); close(result.annual.at(-1).fiveYearMean, fiveYear);
    const pair = compareYears(result.years.at(-2), result.years.at(-1));
    close(pair.spearman, rho); close(pair.pearson, r);
    for (const [sensor, start, n] of [['aqua', 2003, 23], ['snpp', 2013, 13]]) {
      const years = completeYears(data.months, sensor);
      assert.equal(years[0].year, start); assert.equal(years.length, n);
    }
  }
});

test('Given a custom area with zero counts, seasonal averages remain zero and correlations remain unavailable', () => {
  const result = longTermPatterns([...year(2001, Array(12).fill(0)), ...year(2002, Array(12).fill(0))], 'terra');
  assert.ok(result.seasonal.every((row) => row.mean === 0 && row.median === 0));
  assert.equal(result.validPairs, 0); assert.equal(result.medianSimilarity, null);
  assert.deepEqual(result.pairs, [{ first: 2001, second: 2002, pearson: null, spearman: null }]);
  const empty = longTermPatterns([], 'terra');
  assert.equal(empty.years.length, 0); assert.ok(empty.seasonal.every((row) => row.mean === null));
});
