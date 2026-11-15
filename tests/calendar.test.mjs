import test from 'node:test';
import assert from 'node:assert/strict';
import { monthKey, monthsInRange, seriesValue, weeklyBins, sourceForMonth, pointsInRange, historicalMedian, annualRawCounts, logColorPosition } from '../web/calendar.js';

test('Logarithmic colors preserve zero and the maximum while separating small positive counts', () => {
  assert.equal(logColorPosition(0, 15), 0);
  assert.equal(logColorPosition(3, 15), .5);
  assert.equal(logColorPosition(15, 15), 1);
  assert.equal(logColorPosition(0, 0), 0);
  assert.ok(logColorPosition(.5, 15) > 0);
});

test('Given a December-to-January range, inclusive month filtering retains both endpoints and excludes adjacent months', () => {
  const rows = [{ year: 2023, month: 11 }, { year: 2023, month: 12 }, { year: 2024, month: 1 }, { year: 2024, month: 2 }];
  assert.deepEqual(monthsInRange(rows, '2023-12', '2024-01').map((row) => monthKey(row.year, row.month)), ['2023-12', '2024-01']);
});

test('Given missing and observed-zero monthly values, the calendar preserves null and zero distinctly', () => {
  assert.equal(seriesValue({ snpp: null }, 'snpp'), null);
  assert.equal(seriesValue({ snpp: 0 }, 'snpp'), 0);
  assert.equal(seriesValue({ snpp: 2.5 }, 'snpp'), 2.5);
  assert.equal(seriesValue({}, 'snpp'), null);
  assert.equal(seriesValue({ snpp: NaN }, 'snpp'), null);
  assert.deepEqual(annualRawCounts([{ year: 2011, terra: 0, aqua: null, snpp: null }, { year: 2011, terra: 2, aqua: null, snpp: null }]), [{ year: 2011, terra: 2, aqua: null, snpp: null }]);
});

test('Given February 2024 daily observations, weekly bins include leap day and sum to the monthly total', () => {
  const daily = [{ date: '2024-02-01', main: 2 }, { date: '2024-02-04', main: 3 }, { date: '2024-02-05', main: 7 }, { date: '2024-02-29', main: 11 }];
  const bins = weeklyBins(daily, 2024, 2, 'main');
  assert.deepEqual(bins, [
    { week: '2024-01-29', value: 5, days: 2, missingDays: 0 },
    { week: '2024-02-05', value: 7, days: 1, missingDays: 0 },
    { week: '2024-02-26', value: 11, days: 1, missingDays: 0 },
  ]);
  assert.equal(bins.reduce((total, bin) => total + bin.value, 0), 23);
});

test('Given a month beginning midweek, Monday UTC bins clip contributions to the selected month', () => {
  const daily = [{ date: '2025-03-31', main: 100 }, { date: '2025-04-01', main: .5 }, { date: '2025-04-06', main: 1.5 }, { date: '2025-04-07', main: 3 }, { date: '2025-04-30', main: 5 }, { date: '2025-05-01', main: 100 }];
  assert.deepEqual(weeklyBins(daily, 2025, 4, 'main').map(({ week, value }) => ({ week, value })), [{ week: '2025-03-31', value: 2 }, { week: '2025-04-07', value: 3 }, { week: '2025-04-28', value: 5 }]);
});

test('Given main-series selections across 2013, map records use Terra before the switch and S-NPP afterward', () => {
  assert.equal(sourceForMonth('main', 2012), 'terra');
  assert.equal(sourceForMonth('main', 2013), 'snpp');
  assert.equal(sourceForMonth('aqua', 2001), 'aqua');
  const points = { columns: ['date', 'sensor'], rows: [['2012-12-31', 'terra'], ['2012-12-31', 'snpp'], ['2013-01-01', 'terra'], ['2013-01-01', 'snpp']] };
  assert.deepEqual(pointsInRange(points, '2012-12', '2013-01', 'main'), [['2012-12-31', 'terra'], ['2013-01-01', 'snpp']]);
});

test('Given matching date and source filters, point CSV rows and displayed raw point counts use the same records', () => {
  const points = { columns: ['sensor', 'date', 'lat'], rows: [['terra', '2024-01-31', 1], ['aqua', '2024-02-01', 2], ['terra', '2024-02-01', 3], ['terra', '2024-02-29', 4], ['terra', '2024-03-01', 5]] };
  const rows = pointsInRange(points, '2024-02', '2024-02', 'terra');
  assert.deepEqual(rows, [['terra', '2024-02-01', 3], ['terra', '2024-02-29', 4]]);
  assert.equal(rows.length, 2);
});

test('Given other-year same-month observations, historical median excludes the selected year and missing values', () => {
  const selected = { year: 2025, month: 1, terra: 999 };
  const months = [{ year: 2020, month: 1, terra: 0 }, { year: 2021, month: 1, terra: 8 }, { year: 2022, month: 1, terra: null }, { year: 2023, month: 2, terra: 100 }, selected];
  assert.deepEqual(historicalMedian(months, selected, 'terra'), { value: 4, count: 2 });
  assert.deepEqual(historicalMedian([selected], selected, 'terra'), { value: null, count: 0 });
});

test('Given unavailable and observed-zero weeks, aggregation preserves missing values and reports partial missing days', () => {
  const bins = weeklyBins([{ date: '2012-01-01', snpp: null }, { date: '2012-01-02', snpp: 0 }, { date: '2012-01-03', snpp: null }], 2012, 1, 'snpp');
  assert.deepEqual(bins, [{ week: '2011-12-26', value: null, days: 1, missingDays: 1 }, { week: '2012-01-02', value: 0, days: 2, missingDays: 1 }]);
});
