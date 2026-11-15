import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { comparisonRows, comparisonTraces, validateStudy } from '../web/comparison.js';

const record = JSON.parse(await readFile(new URL('../web/data/harmonization-study.json', import.meta.url), 'utf8'));

test('Given all county months, comparison traces contain every observation and keep raw values unchanged', () => {
  const before = structuredClone(record);
  validateStudy(record);
  for (const method of ['raw', 'ratio', 'spatial_ratio', 'selected']) {
    const traces = comparisonTraces(record, method, '3d');
    assert.equal(traces.length, 8);
    for (let index = 0; index < 4; index++) {
      assert.deepEqual(traces[index * 2].z, record.regions[index].months.map((row) => row.terra));
      assert.deepEqual(traces[index * 2 + 1].z, record.regions[index].months.map((row) => row[method]));
      assert.equal(traces[index * 2 + 1].x.length, 72);
    }
    const twoDimensional = comparisonTraces(record, method, '2d');
    assert.equal(twoDimensional.length, 5);
    assert.deepEqual(twoDimensional[0].x, twoDimensional[0].y);
    assert.deepEqual(twoDimensional[1].y, traces[1].z);
  }
  assert.deepEqual(record, before);
});

test('Given invalid or mismatched study metrics, validation fails instead of displaying an unsupported result', () => {
  const inconsistent = structuredClone(record); inconsistent.regions[0].metrics.ratio.mae += 1;
  assert.throws(() => validateStudy(inconsistent), /errors do not match/);
  const missing = structuredClone(record); missing.regions[0].months[0].terra = null;
  assert.throws(() => validateStudy(missing), /observations/);
  const future = structuredClone(record); future.regions[0].models.ratio.training_end = 2020;
  assert.throws(() => validateStudy(future), /outside its training/);
  const duplicate = structuredClone(record); duplicate.regions[1].id = duplicate.regions[0].id;
  assert.throws(() => validateStudy(duplicate), /identities/);
  assert.throws(() => comparisonTraces(record, 'invented', '3d'), /Unknown/);
});

test('Given observed regressions, comparison reports higher error and preserves the training-selected method', () => {
  const rows = comparisonRows(record);
  assert.deepEqual(rows.map((row) => row.selected), ['ratio', 'ratio', 'ratio', 'ratio']);
  assert.deepEqual(rows.map((row) => row.difference < 0), [false, true, false, true]);
  assert.deepEqual(rows.map((row) => row.passes), [true, true, true, false]);
  assert.ok(rows[0].difference > 2.6 && rows[0].difference < 2.7);
});
