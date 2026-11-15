import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { historicalAverage, monthlyAnomaly, dailyActivity } from '../web/calendar.js';
import { circleArea, subsetRecord } from '../web/area.js';
import { FIRE_RAMP, MISSING_COLOR, fireColor, luminance, cellTextColor } from '../web/fire-colors.js';

const row = (year, value, availability = 'reported_counts_coverage_unknown') => ({ year, month: 1, snpp: value, availability: { snpp: availability } });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} versus ${expected}`);
const load = async (path) => JSON.parse(await readFile(new URL(`../web/${path}`, import.meta.url), 'utf8'));

test('Given same-month observations, the arithmetic mean excludes the selected year, missing values and explicitly partial source months but retains observed zeros', () => {
  const rows = [row(2012, 900, 'partial_first_month_coverage_unknown'), row(2013, 0), row(2014, 10), row(2015, null), row(2025, 1000), { ...row(2016, 700), month: 2 }];
  assert.deepEqual(historicalAverage(rows, rows[4], 'snpp'), { value: 5, count: 2, years: [2013, 2014] });
  const result = monthlyAnomaly(rows, rows[4], 'snpp');
  assert.equal(result.difference, 995); assert.equal(result.percent, 19900);
});

test('Given a main-series month, baseline eligibility follows its active source and does not discard another sensor’s partial month', () => {
  const rows = [{ ...row(2012, 300, 'partial_first_month_coverage_unknown'), main: 2, terra: 2 }, { ...row(2013, 10), main: 1 }, { ...row(2025, 20), main: 2 }];
  assert.deepEqual(historicalAverage(rows, rows[2], 'main'), { value: 1.5, count: 2, years: [2012, 2013] });
  rows[1].partial_first_year = { snpp: true };
  assert.equal(historicalAverage(rows, rows[2], 'main').count, 2);
});

test('Given missing, partial or zero baselines, anomalies are unavailable where comparison is invalid and never report an infinite percentage', () => {
  const selected = row(2025, 4);
  const zero = monthlyAnomaly([row(2020, 0), selected], selected, 'snpp');
  assert.equal(zero.difference, 4); assert.equal(zero.percent, null);
  for (const earlier of [[], [row(2020, null)]]) {
    const result = monthlyAnomaly([...earlier, selected], selected, 'snpp');
    assert.equal(result.baseline.value, null); assert.equal(result.difference, null); assert.equal(result.percent, null);
  }
  for (const current of [row(2025, null), row(2025, 4, 'partial_first_month_coverage_unknown')]) {
    const result = monthlyAnomaly([row(2020, 2), current], current, 'snpp');
    assert.equal(result.baseline.value, 2); assert.equal(result.difference, null); assert.equal(result.percent, null);
  }
});

test('Given a selected calendar month, daily activity retains every UTC date including leap days, missing dates and observed zeros', () => {
  const days = dailyActivity([{ date: '2024-02-01', terra: 0 }, { date: '2024-02-29', terra: 3 }], 2024, 2, 'terra');
  assert.equal(days.length, 29); assert.equal(days[0].weekday, 3); assert.equal(days[0].value, 0);
  assert.equal(days[1].value, null); assert.equal(days[28].date, '2024-02-29'); assert.equal(days[28].value, 3);
});

test('Given the published county and custom-area records, means and detection days match independent source calculations', async () => {
  const cases = [['data', [2.1607581338244324, 2.3333333333333335, 3.090909090909091, 25.666666666666668]],
    ['data/regions/sacramento', [.3345352564102564, .4583333333333333, .9090909090909091, 4.75]],
    ['data/regions/san-diego', [4.086854460093897, 4.5, 2.1363636363636362, 8.333333333333334]],
    ['data/regions/san-jose', [.13059838472834068, .041666666666666664, .09090909090909091, 1.4166666666666667]]];
  for (const [path, expected] of cases) {
    const data = await load(`${path}/dashboard.json`), selected = data.months.find((r) => r.year === 2025 && r.month === 1);
    ['main', 'terra', 'aqua', 'snpp'].forEach((sensor, index) => {
      const average = historicalAverage(data.months, selected, sensor);
      close(average.value, expected[index]); assert.equal(average.count, [24, 24, 22, 12][index]);
    });
  }
  const data = await load('data/dashboard.json'), points = await load('data/points.json');
  const subset = subsetRecord(data, points, circleArea(34.3917, -118.5426, 10)).data;
  for (const [index, sensor] of ['terra', 'aqua', 'snpp'].entries()) {
    assert.equal(dailyActivity(data.daily, 2025, 1, sensor).filter((day) => day.value > 0).length, [6, 10, 17][index]);
    assert.equal(dailyActivity(subset.daily, 2025, 1, sensor).filter((day) => day.value > 0).length, [0, 1, 1][index]);
    const selected = subset.months.find((r) => r.year === 2025 && r.month === 1), result = monthlyAnomaly(subset.months, selected, sensor);
    close(result.baseline.value, [0, 0, 16 / 12][index]);
    if (index < 2) assert.equal(result.percent, null);
    else close(result.percent, 1400);
  }
});

test('Given the fire color ramp, luminance is ordered and each numeric cell uses text with at least 4.5 to 1 contrast', () => {
  assert.equal(fireColor(0, 1000), FIRE_RAMP[0]); assert.equal(fireColor(1000, 1000), FIRE_RAMP.at(-1));
  assert.equal(fireColor(null, 1000), MISSING_COLOR);
  let previous = Infinity;
  for (let count = 0; count <= 1000; count++) {
    const background = fireColor(count, 1000), light = luminance(background);
    assert.ok(light <= previous + 1e-12); previous = light;
    const text = luminance(cellTextColor(background));
    assert.ok((Math.max(light, text) + .05) / (Math.min(light, text) + .05) >= 4.5);
  }
});
