import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegions, regionFromSearch, validateRegionalDashboard, createRegionLoader } from '../web/regions.js';

const registry = () => ({ schema_version: 1, default_region: 'los-angeles', regions: [
  { id: 'los-angeles', city: 'Los Angeles', county: 'Los Angeles', geoid: '06037', data_path: 'data' },
  { id: 'san-diego', city: 'San Diego', county: 'San Diego', geoid: '06073', data_path: 'data/regions/san-diego' },
] });

test('The registry permits only the original LA path and matching local county directories', () => {
  assert.equal(validateRegions(registry()).regions.length, 2);
  for (const path of ['../data', 'https://example.com/data', 'data/regions/sacramento', 'data/regions/san-diego/../los-angeles', '/data']) {
    const data = registry(); data.regions[1].data_path = path;
    assert.throws(() => validateRegions(data), /invalid county or data path/);
  }
  const duplicate = registry(); duplicate.regions.push(duplicate.regions[0]);
  assert.throws(() => validateRegions(duplicate));
});

test('A county selection may use a different default without retaining the original pilot in navigation', () => {
  const data = registry(); data.regions = [data.regions[1]]; data.default_region = 'san-diego';
  assert.equal(validateRegions(data).default_region, 'san-diego');
  data.default_region = 'missing'; assert.throws(() => validateRegions(data), /default record/);
});

test('A city URL selects only a registered county and preserves the default for unknown or malicious values', () => {
  const data = validateRegions(registry());
  assert.equal(regionFromSearch(data, '?region=san-diego').geoid, '06073');
  for (const search of ['', '?region=../secrets', '?region=https://example.com', '?region=san-francisco']) assert.equal(regionFromSearch(data, search).id, 'los-angeles');
});

function sparseDashboard() {
  return { meta: { geoid: '06073', alpha: null, switch_year: 2013 }, daily: [], quality: {},
    validation: { passed: false, status: 'unestimable' },
    months: Array.from({ length: 300 }, (_, index) => {
      const year = 2001 + Math.floor(index / 12);
      return { year, month: index % 12 + 1, terra: 0, aqua: 0, snpp: year < 2012 ? null : 0, main: year < 2013 ? 0 : null };
    }) };
}

test('Unestimable county calibration preserves raw zeros while withholding post-switch adjusted values', () => {
  const data = sparseDashboard();
  const original = structuredClone(data);
  assert.equal(validateRegionalDashboard(data, registry().regions[1]), data);
  assert.deepEqual(data, original);
  data.months.at(-1).main = 0;
  assert.throws(() => validateRegionalDashboard(data), /cannot supply adjusted counts/);
  data.months.at(-1).main = null;
  data.validation.passed = true;
  assert.throws(() => validateRegionalDashboard(data), /coefficient or explicit unestimable/);
});

test('A dashboard from another county is rejected rather than displayed under the selected city', () => {
  assert.throws(() => validateRegionalDashboard(sparseDashboard(), registry().regions[0]), /does not match/);
});

test('A late county response cannot overwrite the latest selected county even if fetch ignores cancellation', async () => {
  const pending = [];
  const load = createRegionLoader((path, options) => new Promise((resolve) => pending.push({ path, signal: options.signal, resolve })));
  const first = load(registry().regions[0]);
  const second = load(registry().regions[1]);
  assert.ok(pending.slice(0, 3).every(({ signal }) => signal.aborted));
  pending.slice(3).forEach(({ path, resolve }) => resolve(path));
  assert.equal((await second).data, 'data/regions/san-diego/dashboard.json');
  pending.slice(0, 3).forEach(({ resolve }) => resolve('old LA payload'));
  assert.equal(await first, null);
});

test('Missing optional points keep the selected county dashboard and boundary without falling back to LA', async () => {
  const paths = [];
  const load = createRegionLoader(async (path) => { paths.push(path); if (path.endsWith('points.json')) throw new Error('HTTP 404'); return {}; });
  const result = await load(registry().regions[1]);
  assert.deepEqual(result.data, {});
  assert.deepEqual(result.county, {});
  assert.equal(result.points, null);
  assert.match(result.errors.points, /HTTP 404/);
  assert.ok(paths.every((path) => path.startsWith('data/regions/san-diego/')));
});

test('Missing optional county geometry keeps the current county calendar and observed points', async () => {
  const load = createRegionLoader(async (path) => {
    if (path.endsWith('county.geojson')) throw new Error('Boundary unavailable');
    return path.endsWith('dashboard.json') ? { meta: { geoid: '06073' } } : { columns: [], rows: [] };
  });
  const result = await load(registry().regions[1]);
  assert.equal(result.data.meta.geoid, '06073');
  assert.deepEqual(result.points, { columns: [], rows: [] });
  assert.equal(result.county, null);
  assert.match(result.errors.county, /Boundary unavailable/);
});

test('A missing required dashboard rejects the selected record without using an earlier county dashboard', async () => {
  const load = createRegionLoader(async (path) => {
    if (path === 'data/regions/san-diego/dashboard.json') throw new Error('Dashboard unavailable');
    return { county: 'Los Angeles' };
  });
  assert.equal((await load(registry().regions[0])).data.county, 'Los Angeles');
  await assert.rejects(load(registry().regions[1]), /Dashboard unavailable/);
});
