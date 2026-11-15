import test from 'node:test';
import assert from 'node:assert/strict';
import { hotspotContext, rankPlacements, spectralNdwi } from '../web/decision.js';

const contextOptions = {
  cutoff: '2026-08-08T12:00:00Z',
  bbox: [-120, 35, -118, 37],
  alpha: 0.5,
  trainingEnd: '2026-08-01T00:00:00Z',
};

test('Given an out-of-range lookback, hotspotContext blocks rather than failing timestamp formatting', () => {
  assert.equal(hotspotContext([], { ...contextOptions, lookbackDays: 1e9 }).status, 'blocked');
});

test('Given finite positive reflectance with an overflowing sum, spectralNdwi preserves the normalized ratio', () => {
  assert.equal(spectralNdwi(Number.MAX_VALUE, Number.MAX_VALUE), 0);
});

function point(date = '2026-08-07', time = '1200', overrides = {}) {
  return { date, time, lat: 36, lon: -119, sensor: 'SNPP', ...overrides };
}

function modelInput() {
  return {
    decisionAt: '2026-08-08T12:00:00Z',
    forecastIssuedAt: '2026-08-08T11:00:00Z',
    forecastValidStart: '2026-08-08T12:00:00Z',
    forecastValidEnd: '2026-08-09T12:00:00Z',
    predictionEnd: '2026-08-09T12:00:00Z',
    trainingEnd: '2026-08-01T00:00:00Z',
    modelId: 'external-model-v1',
    stations: [
      { id: 'fixed', label: 'Fixed', eligible: true, verified: true },
      { id: 'base', label: 'Baseline', eligible: true, verified: true },
      { id: 'away', label: 'Away', eligible: true, verified: true },
    ],
    fixedStationId: 'fixed',
    baselineStationId: 'base',
    cells: [
      { id: 'shared', expectedIncidents: 2 },
      { id: 'extra', expectedIncidents: 3 },
      { id: 'remote', expectedIncidents: 7 },
    ],
    travelMinutes: {
      fixed: { shared: 5, extra: 30, remote: 40 },
      base: { shared: 4, extra: 20, remote: 30 },
      away: { shared: 6, extra: 10, remote: 25 },
    },
    thresholdMinutes: 10,
  };
}

function assertBlocked(result, reason) {
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.rows, []);
  assert.equal(result.preferredCandidateId, null);
  assert.ok(result.reasons.some(message => reason.test(message)), result.reasons.join('\n'));
}

test('Given a zero calibration factor, hotspotContext withholds calibrated SNPP and explains the positive-alpha requirement', () => {
  const result = hotspotContext([point()], { ...contextOptions, alpha: 0 });
  assert.equal(result.calibratedSnpp, null);
  assert.match(result.caveats.join(' '), /positive alpha/);
});

test('Given valid forecast dates spanning the entire prediction horizon, rankPlacements accepts inclusive forecast boundaries', () => {
  const result = rankPlacements(modelInput());
  assert.equal(result.status, 'experimental');
  const widerForecast = modelInput();
  widerForecast.forecastValidStart = '2026-08-08T11:00:00Z';
  widerForecast.forecastValidEnd = '2026-08-10T00:00:00Z';
  assert.equal(rankPlacements(widerForecast).status, 'experimental');
});

test('Given an expired forecast or one that starts after the decision, rankPlacements blocks', () => {
  assertBlocked(rankPlacements({ ...modelInput(), forecastValidEnd: '2026-08-08T11:59:59Z' }), /forecastValidEnd/);
  assertBlocked(rankPlacements({ ...modelInput(), forecastValidStart: '2026-08-08T12:00:01Z' }), /forecastValidStart/);
});

test('Given a forecast ending before predictionEnd or a predictionEnd at or before the decision, rankPlacements blocks', () => {
  assertBlocked(rankPlacements({ ...modelInput(), forecastValidEnd: '2026-08-09T11:59:59Z' }), /forecastValidEnd/);
  for (const predictionEnd of ['2026-08-08T12:00:00Z', '2026-08-08T11:59:59Z']) {
    assertBlocked(rankPlacements({ ...modelInput(), predictionEnd }), /predictionEnd/);
  }
});

test('Given missing, non-UTC or invalid calendar dates for forecast validity and prediction end, rankPlacements blocks', () => {
  for (const field of ['forecastValidStart', 'forecastValidEnd', 'predictionEnd']) {
    for (const value of [undefined, null, '', '2026-08-09T12:00:00', '2026-08-09T12:00:00-07:00', '2026-02-30T12:00:00Z']) {
      assertBlocked(rankPlacements({ ...modelInput(), [field]: value }), new RegExp(field));
    }
  }
});

test('Given acquisition points across the lookback and cutoff, hotspotContext includes the start and excludes the cutoff and later points', () => {
  const result = hotspotContext([
    point('2026-08-01', '11:59:59'),
    point('2026-08-01', '12:00:00'),
    point('2026-08-08', '11:59:59'),
    point('2026-08-08', '1200'),
    point('2026-08-09', '0000'),
  ], contextOptions);
  assert.equal(result.status, 'context-only');
  assert.deepEqual(result.sourceCounts, { terra: 0, aqua: 0, snpp: 2 });
  assert.equal(result.lookbackStart, '2026-08-01T12:00:00.000Z');
});

test('Given points inside, outside and on bbox edges, hotspotContext includes only points within the inclusive bbox', () => {
  const result = hotspotContext([
    point(), point(undefined, undefined, { lat: 35, lon: -120 }),
    point(undefined, undefined, { lat: 37, lon: -118 }),
    point(undefined, undefined, { lat: 34.999 }),
    point(undefined, undefined, { lon: -117.999 }),
  ], { ...contextOptions, bbox: { west: -120, south: 35, east: -118, north: 37 } });
  assert.deepEqual(result.sourceCounts, { terra: 0, aqua: 0, snpp: 3 });
});

test('Given three sensor archives and a pre-cutoff calibration, hotspotContext returns separate source counts and calibrated SNPP without a sensor total', () => {
  const result = hotspotContext([
    point(undefined, 1200, { sensor: 'Terra' }),
    point(undefined, '12:00', { sensor: 'Aqua' }),
    point(undefined, '1200', { sensor: 'S-NPP' }),
    point(undefined, '1200', { sensor: 'Suomi NPP' }),
  ], contextOptions);
  assert.deepEqual(result.sourceCounts, { terra: 1, aqua: 1, snpp: 2 });
  assert.equal(result.calibratedSnpp, 1);
  assert.equal(Object.hasOwn(result, 'total'), false);
  assert.match(result.caveats.join(' '), /do not establish sensor coverage/);
});

test('Given absent or future calibration, hotspotContext withholds calibrated SNPP and reports the archive availability caveat', () => {
  for (const changes of [{ alpha: undefined }, { trainingEnd: contextOptions.cutoff }, { trainingEnd: '2026-08-09T00:00:00Z' }, { alpha: -1 }]) {
    const result = hotspotContext([point()], { ...contextOptions, ...changes });
    assert.equal(result.calibratedSnpp, null);
    assert.match(result.caveats.join(' '), /Archive availability is not a historical feed-availability record/);
  }
});

test('Given invalid UTC cutoff, bbox or lookback, hotspotContext blocks with actionable reasons', () => {
  for (const changes of [{ cutoff: '2026-08-08T12:00:00' }, { cutoff: '2026-02-30T12:00:00Z' }, { bbox: [0, 0, -1, 1] }, { bbox: [-181, 0, 0, 1] }, { lookbackDays: 0 }, { lookbackDays: Infinity }]) {
    const result = hotspotContext([], { ...contextOptions, ...changes });
    assert.equal(result.status, 'blocked');
    assert.ok(result.reasons.length > 0);
    assert.equal(result.sourceCounts, null);
  }
});

test('Given malformed acquisitions, hotspotContext excludes them without reporting valid detections', () => {
  const result = hotspotContext([null, point('2026-02-30'), point(undefined, '2460'), point(undefined, undefined, { sensor: 'unknown' }), point(undefined, undefined, { lat: '36' })], contextOptions);
  assert.deepEqual(result.sourceCounts, { terra: 0, aqua: 0, snpp: 0 });
  assert.equal(result.excludedInvalidRows, 5);
});

test('Given masked, invalid, negative or zero-sum reflectance, spectralNdwi returns null', () => {
  assert.equal(spectralNdwi(0.6, 0.2, { masked: true }), null);
  for (const [a, b] of [[NaN, 1], [1, Infinity], [-0.1, 0.2], [0.1, -0.2], [0, 0], ['0.6', 0.2]]) assert.equal(spectralNdwi(a, b), null);
});

test('Given valid reflectance, spectralNdwi returns the normalized spectral difference', () => {
  assert.ok(Math.abs(spectralNdwi(0.6, 0.2) - 0.5) < 1e-12);
  assert.equal(spectralNdwi(0, 0.2), -1);
  assert.equal(spectralNdwi(0.2, 0), 1);
});

test('Given overlapping fixed and movable reachability, rankPlacements counts each covered cell once', () => {
  const input = modelInput();
  const before = structuredClone(input);
  const result = rankPlacements(input);
  assert.equal(result.status, 'experimental');
  assert.equal(result.preferredCandidateId, 'away');
  assert.deepEqual(result.rows, [
    { stationId: 'away', label: 'Away', coveredCellIds: ['shared', 'extra'], expectedCoveredIncidents: 5 },
    { stationId: 'base', label: 'Baseline', coveredCellIds: ['shared'], expectedCoveredIncidents: 2 },
    { stationId: 'fixed', label: 'Fixed', coveredCellIds: ['shared'], expectedCoveredIncidents: 2 },
  ]);
  assert.deepEqual(input, before);
  assert.match(result.caveats.join(' '), /Unvalidated research/);
});

test('Given a missing or invalid travel duration or prediction, rankPlacements blocks instead of substituting zero', () => {
  for (const value of [undefined, null, -1, NaN, Infinity, '5']) {
    const input = modelInput();
    if (value === undefined) delete input.travelMinutes.away.extra;
    else input.travelMinutes.away.extra = value;
    assertBlocked(rankPlacements(input), /station away, cell extra/);
  }
  for (const value of [undefined, null, -1, NaN, Infinity, '3']) {
    const input = modelInput();
    input.cells[1].expectedIncidents = value;
    assertBlocked(rankPlacements(input), /expectedIncidents/);
  }
});

test('Given missing or future forecast metadata or future training, rankPlacements blocks', () => {
  for (const changes of [{ forecastIssuedAt: undefined }, { forecastIssuedAt: '2026-08-08T12:00:01Z' }, { trainingEnd: '2026-08-08T12:00:00Z' }, { trainingEnd: '2026-08-09T00:00:00Z' }, { modelId: '' }]) {
    assertBlocked(rankPlacements({ ...modelInput(), ...changes }), /forecastIssuedAt|trainingEnd|modelId/);
  }
  const input = modelInput();
  input.forecastIssuedAt = input.decisionAt;
  assert.equal(rankPlacements(input).status, 'experimental');
});

test('Given tied scores, rankPlacements ranks the baseline first and remaining station IDs deterministically', () => {
  const input = modelInput();
  input.travelMinutes.away.extra = 20;
  input.stations.reverse();
  const result = rankPlacements(input);
  assert.deepEqual(result.rows.map(row => row.stationId), ['base', 'away', 'fixed']);
  assert.equal(result.preferredCandidateId, 'base');
});

test('Given duplicate station or cell IDs, rankPlacements blocks', () => {
  const stationDuplicate = modelInput();
  stationDuplicate.stations.push({ ...stationDuplicate.stations[0] });
  assertBlocked(rankPlacements(stationDuplicate), /Duplicate station ID/);
  const cellDuplicate = modelInput();
  cellDuplicate.cells.push({ ...cellDuplicate.cells[0] });
  assertBlocked(rankPlacements(cellDuplicate), /Duplicate cell ID/);
});

test('Given an unavailable baseline or fixed station, rankPlacements blocks', () => {
  for (const idField of ['baselineStationId', 'fixedStationId']) {
    assertBlocked(rankPlacements({ ...modelInput(), [idField]: 'missing' }), new RegExp(idField));
    const input = modelInput();
    input.stations.find(station => station.id === input[idField]).verified = false;
    assertBlocked(rankPlacements(input), new RegExp(idField));
    const ineligible = modelInput();
    ineligible.stations.find(station => station.id === ineligible[idField]).eligible = false;
    assertBlocked(rankPlacements(ineligible), new RegExp(idField));
  }
});

test('Given the baseline at the fixed station, rankPlacements accepts it and scores coverage geometry without engine capacity benefit', () => {
  const input = modelInput();
  input.baselineStationId = 'fixed';
  const result = rankPlacements(input);
  assert.equal(result.status, 'experimental');
  assert.equal(result.rows.find(row => row.stationId === 'fixed').expectedCoveredIncidents, 2);
  assert.match(result.caveats.join(' '), /Coverage geometry only: engine capacity benefit is not modeled/);
});

test('Given malformed input schemas, rankPlacements returns blocked without throwing', () => {
  for (const input of [null, undefined, [], 'bad', {}, { ...modelInput(), stations: [null] }, { ...modelInput(), cells: [null] }, { ...modelInput(), travelMinutes: null }, { ...modelInput(), thresholdMinutes: -1 }, { ...modelInput(), stations: [] }, { ...modelInput(), cells: [] }]) {
    assertBlocked(rankPlacements(input), /.+/);
  }
});
