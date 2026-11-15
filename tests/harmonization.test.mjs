import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harmonizationComparison, initializeHarmonization, monthlyHarmonization } from '../web/harmonization.js';

test('Selected-month comparison preserves observations and computes both absolute differences', async () => {
  const data = JSON.parse(await readFile(new URL('../web/data/dashboard.json', import.meta.url), 'utf8'));
  const row = data.months.find((row) => row.year === 2025 && row.month === 1);
  const before = structuredClone(row);
  const result = monthlyHarmonization(data, row);
  assert.equal(result.terra, 139);
  assert.equal(result.viirs, 1760);
  assert.ok(Math.abs(result.adjusted - 199.18968692449354) < 1e-10);
  assert.equal(result.rawDifference, 1621);
  assert.ok(Math.abs(result.adjustedDifference - 60.18968692449354) < 1e-10);
  assert.equal(result.calendarSource, 'adjusted');
  assert.deepEqual(row, before);
});

test('Missing sensors and unestimable calibration remain unavailable while observed zero remains zero', () => {
  const data = { meta: { alpha: .5, switch_year: 2013 } };
  assert.equal(monthlyHarmonization(data, { year: 2001, terra: 3, snpp: null }).adjusted, null);
  assert.equal(monthlyHarmonization(data, { year: 2024, terra: null, snpp: 4 }).adjustedDifference, null);
  assert.equal(monthlyHarmonization(data, { year: 2024, terra: 0, snpp: 0 }).adjustedDifference, 0);
  data.meta.alpha = null;
  assert.equal(monthlyHarmonization(data, { year: 2024, terra: 0, snpp: 0 }).adjusted, null);
});

test('Scaling may increase the difference; pre-switch counts remain Terra sourced', () => {
  const result = monthlyHarmonization({ meta: { alpha: .1, switch_year: 2013 } }, { year: 2012, terra: 10, snpp: 10 });
  assert.equal(result.rawDifference, 0);
  assert.equal(result.adjustedDifference, 9);
  assert.equal(result.calendarSource, 'terra');
});

const fixture = () => ({
  meta: { alpha: .5 },
  validation: { test: { start_year: 2020, end_year: 2025, months: 2 }, seasonal_training_medians: { 1: 0, 2: 2 } },
  months: [{ year: 2019, month: 1, terra: 100, snpp: 100 }, { year: 2020, month: 1, terra: 0, snpp: 4 }, { year: 2025, month: 2, terra: 4, snpp: 6 }, { year: 2026, month: 1, terra: 100, snpp: 100 }],
});

test('Given held-out endpoints and training months, comparison retains endpoints and computes independent absolute errors', () => {
  const data = fixture();
  const original = structuredClone(data);
  const result = harmonizationComparison(data);
  assert.deepEqual(result.rows.map((row) => row.year), [2020, 2025]);
  assert.deepEqual(result.mae, { raw: 3, adjusted: 1.5, seasonal: 1 });
  assert.equal(result.passed, false);
  assert.equal(result.reduction, 50);
  assert.deepEqual(data, original);
});

test('Given missing counts, an excluded month and observed zero, comparison preserves zero and uses identical eligible pairs', () => {
  const data = fixture();
  data.validation.test.excluded_months = ['2020-02'];
  data.months.push({ year: 2021, month: 1, terra: null, snpp: 10 }, { year: 2020, month: 2, terra: 100, snpp: 20 });
  assert.equal(harmonizationComparison(data).rows.length, 2);
  data.validation.test.months = 3;
  assert.throws(() => harmonizationComparison(data), /do not match/);
});

test('Given zero raw MAE, percentage reduction remains undefined and strict baseline comparison fails', () => {
  const data = fixture();
  data.meta.alpha = 1;
  data.months = [{ year: 2020, month: 1, terra: 0, snpp: 0 }];
  data.validation.test.months = 1;
  const result = harmonizationComparison(data);
  assert.equal(result.reduction, null);
  assert.equal(result.passed, false);
});

test('Unestimable calibration withholds all adjusted comparisons without multiplying a null coefficient', () => {
  const data = fixture();
  data.meta.alpha = null;
  data.validation.status = 'unestimable';
  data.validation.passed = false;
  const result = harmonizationComparison(data);
  assert.equal(result.status, 'unestimable');
  assert.equal(result.passed, false);
  assert.deepEqual(result.mae, { raw: null, adjusted: null, seasonal: null });
  assert.deepEqual(result.rows, []);
});

test('The delivered record reproduces its published held-out validation metrics from monthly source counts', async () => {
  const data = JSON.parse(await readFile(new URL('../web/data/dashboard.json', import.meta.url), 'utf8'));
  const { mae, passed, rows } = harmonizationComparison(data);
  assert.equal(rows.length, 72);
  for (const [key, published] of [['raw', 'unscaled'], ['adjusted', 'adjusted'], ['seasonal', 'seasonal']]) assert.ok(Math.abs(mae[key] - data.validation.mae[published]) < 1e-10);
  assert.equal(passed, data.validation.passed);
});

test('Before and After controls change only the VIIRS scale and disclose the linear axis rescaling', async (context) => {
  const elements = new Map();
  const makeElement = () => ({ textContent: '', value: 'adjusted', append() {}, replaceChildren() {}, setAttribute() {}, classList: { toggle() {}, remove() {} }, addEventListener(name, handler) { this[name] = handler; } });
  const originalDocument = globalThis.document;
  const originalPlotly = globalThis.Plotly;
  context.after(() => { globalThis.document = originalDocument; globalThis.Plotly = originalPlotly; });
  globalThis.document = { getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); }, createElement: makeElement };
  const calls = [];
  globalThis.Plotly = { react: async (...args) => { calls.push(args); } };
  const data = fixture();
  data.validation.training = { start_year: 2013, end_year: 2019, terra_total: 4, snpp_total: 8 };
  await initializeHarmonization(data);
  assert.deepEqual(calls[0][1].map((trace) => trace.y), [[0, 4], [2, 3]]);
  const mode = elements.get('comparison-mode');
  mode.value = 'raw';
  mode.onchange();
  assert.deepEqual(calls[1][1].map((trace) => trace.y), [[0, 4], [4, 6]]);
  assert.equal(calls[1][2].yaxis.type, 'linear');
  assert.equal(calls[1][2].yaxis.autorange, true);
  assert.match(elements.get('harmonization-caption').textContent, /linear y-axis rescales/);
  assert.match(elements.get('harmonization-improvement').textContent, /does not establish forecasting skill/);
});
