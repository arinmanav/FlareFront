import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePrediction } from '../web/prediction.js';

const cells = [{ id: '1:1' }, { id: '1:2' }];
const record = { outcomes: [{ cell: '1:2', week: 2, detections: 5 }] };
test('One cell and one week scores against the observed cell-week, with separate location and time diagnostics', () => {
  assert.deepEqual(evaluatePrediction(record, cells, { cell: '1:2', week: 2 }), { hit: true, detections: 5, locationHit: true, weekHit: true });
  assert.deepEqual(evaluatePrediction(record, cells, { cell: '1:2', week: 1 }), { hit: false, detections: 0, locationHit: true, weekHit: false });
  assert.deepEqual(evaluatePrediction(record, cells, { cell: '1:1', week: 2 }), { hit: false, detections: 0, locationHit: false, weekHit: true });
});
test('An empty outcome scores no observed match, without claiming no fire', () => {
  assert.deepEqual(evaluatePrediction({ outcomes: [] }, cells, { cell: '1:1', week: 0 }), { hit: false, detections: 0, locationHit: false, weekHit: false });
});
test('Unknown cells, noninteger weeks and out-of-range weeks are rejected', () => {
  for (const pick of [{ cell: 'unknown', week: 0 }, { cell: '1:1', week: -1 }, { cell: '1:1', week: 4 }, { cell: '1:1', week: .5 }]) assert.throws(() => evaluatePrediction(record, cells, pick));
  assert.throws(() => evaluatePrediction({ outcomes: [{ cell: '1:1', week: 0, detections: 0 }] }, cells, { cell: '1:1', week: 0 }));
});
