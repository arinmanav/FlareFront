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
    assert.equal(traces.length, record.regions.length * 2);
    for (let index = 0; index < record.regions.length; index++) {
      assert.deepEqual(traces[index * 2].z, record.regions[index].months.map((row) => row.terra));
      assert.deepEqual(traces[index * 2 + 1].z, record.regions[index].months.map((row) => row[method]));
      assert.equal(traces[index * 2 + 1].x.length, 72);
    }
    const twoDimensional = comparisonTraces(record, method, '2d');
    assert.equal(twoDimensional.length, record.regions.length + 1);
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

test('Given a failed or worse comparison, the result remains visible instead of being suppressed', () => {
  const fixture = structuredClone(record);
  fixture.regions[0].metrics.ratio.mae = 2;
  fixture.regions[0].metrics.spatial_ratio.mae = 5;
  fixture.regions[0].metrics.seasonal.mae = 1;
  const rows = comparisonRows(fixture);
  assert.equal(rows[0].difference, 3);
  assert.equal(rows[0].passes, false);
  assert.equal(rows[0].selected, fixture.regions[0].selection.selected);
});
