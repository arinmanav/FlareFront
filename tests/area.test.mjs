import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { circleArea, rectangleArea, containsPoint, countyContains, validateAreaCoverage, subsetRecord } from '../web/area.js';

const load = async (name) => JSON.parse(await readFile(new URL(`../web/data/${name}`, import.meta.url), 'utf8'));
const [data, points, county] = await Promise.all(['dashboard.json', 'points.json', 'county.geojson'].map(load));
const rectangle = rectangleArea({ lat: 34.5, lng: -118.4 }, { lat: 34.3, lng: -118.65 });
const circle = circleArea(34.3917, -118.5426, 10);
const sensors = ['terra', 'aqua', 'snpp'];

test('Given a rectangle or coordinate circle, points on its boundary are included and invalid inputs are rejected', () => {
  assert.deepEqual(rectangle, { type: 'rectangle', west: -118.65, east: -118.4, south: 34.3, north: 34.5 });
  assert.equal(containsPoint(rectangle, 34.3, -118.65), true);
  assert.equal(containsPoint(rectangle, 34.5, -118.4), true);
  assert.equal(containsPoint(rectangle, 34.50001, -118.5), false);
  const equatorial = circleArea(0, 0, 1);
  assert.equal(containsPoint(equatorial, 0, 180 / (Math.PI * 6371.0088)), true);
  assert.equal(containsPoint(equatorial, 0, .01), false);
  for (const values of [[NaN, 0, 1], [91, 0, 1], [0, 181, 1], [0, 0, 0], [0, 0, 101]]) assert.throws(() => circleArea(...values));
  assert.throws(() => rectangleArea({ lat: 34, lng: -118 }, { lat: 34, lng: -117 }));
});

test('Given county polygons with holes and islands, only covered centers are accepted', () => {
  const geometry = { type: 'FeatureCollection', features: [{ geometry: { type: 'MultiPolygon', coordinates: [
    [[[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]], [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]],
    [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
  ] } }] };
  for (const [latitude, longitude, expected] of [[3, 3, true], [0, 0, true], [1.5, 1.5, false], [1, 1.5, true], [10.5, 10.5, true], [8, 8, false]]) {
    assert.equal(countyContains(geometry, latitude, longitude), expected);
    if (expected) assert.doesNotThrow(() => validateAreaCoverage(circleArea(latitude, longitude, 1), geometry));
    else assert.throws(() => validateAreaCoverage(circleArea(latitude, longitude, 1), geometry), /outside this county/);
  }
  assert.doesNotThrow(() => validateAreaCoverage(circle, county));
  assert.throws(() => validateAreaCoverage(circleArea(40.7, -74, 10), county), /four counties/);
});

test('Given a custom area, raw counts match the independent source oracle while unavailable sensor periods remain null', () => {
  for (const [area, total, january] of [[rectangle, [253, 288, 717], [2, 5, 22]], [circle, [161, 191, 559], [0, 4, 20]]]) {
    const result = subsetRecord(data, points, area);
    assert.deepEqual(sensors.map((sensor) => result.data.months.reduce((sum, row) => sum + (row[sensor] ?? 0), 0)), total);
    assert.deepEqual(sensors.map((sensor) => result.data.months.find((row) => row.year === 2025 && row.month === 1)[sensor]), january);
    assert.equal(result.points.rows.length, total.reduce((a, b) => a + b, 0));
    assert.equal(result.data.months.length, 300);
    assert.equal(result.data.daily.length, 9131);
    assert.equal(result.data.months[0].aqua, null); assert.equal(result.data.months[0].snpp, null);
    assert.equal(result.data.daily.find((row) => row.date === '2012-01-19').snpp, null);
    assert.notEqual(result.data.daily.find((row) => row.date === '2012-01-20').snpp, null);
    assert.deepEqual(result.data.months.find((row) => row.year === 2012 && row.month === 1).availability, data.months.find((row) => row.year === 2012 && row.month === 1).availability);
    assert.ok(result.data.months.every((row) => row.main === null));
    assert.equal(result.data.meta.alpha, null); assert.equal(result.data.validation.passed, false);
  }
});

test('Given an empty covered area, all available periods remain zero without a calibration claim', () => {
  const emptyPoints = { ...points, rows: [] };
  const result = subsetRecord(data, emptyPoints, circle);
  assert.equal(result.points.rows.length, 0);
  for (const [index, row] of result.data.months.entries()) for (const sensor of sensors) {
    assert.equal(row[sensor], data.months[index][sensor] === null ? null : 0);
  }
  assert.equal(result.data.validation.status, 'not_evaluated');
  assert.equal(result.data.quality, undefined);
  assert.ok(result.data.months.every((row) => Object.values(row.versions).every((versions) => versions.length === 0)));
});

test('Given a full-county envelope, raw counts reconcile without mutating the original calibrated record', () => {
  const originalData = JSON.stringify(data), originalPoints = JSON.stringify(points);
  const result = subsetRecord(data, points, rectangleArea({ lat: 32, lng: -121 }, { lat: 36, lng: -116 }));
  for (const key of ['months', 'daily']) for (const [index, row] of result.data[key].entries()) for (const sensor of sensors) assert.equal(row[sensor], data[key][index][sensor]);
  assert.equal(result.points.rows.length, 26113);
  assert.equal(JSON.stringify(data), originalData); assert.equal(JSON.stringify(points), originalPoints);
});
