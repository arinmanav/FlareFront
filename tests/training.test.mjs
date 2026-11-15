import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateTrainingAllocation, initializeTraining } from '../web/training.js';

const fixture = async () => JSON.parse(await readFile(new URL('../web/data/training-scenario.json', import.meta.url), 'utf8'));
const options = { mobileBase: 'b', crewSize: 4, thresholdMinutes: 15 };

test('At 15 simulated minutes, Base B covers eight expected incidents uniquely versus three for baseline A and seven for C', async () => {
  const scenario = await fixture();
  const original = structuredClone(scenario);
  const result = evaluateTrainingAllocation(scenario, options);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.coveredCellIds, ['A', 'B', 'C', 'D']);
  assert.equal(result.coveredExpectedIncidents, 8);
  assert.equal(result.totalExpectedIncidents, 10);
  assert.equal(result.baseline.coveredExpectedIncidents, 3);
  assert.equal(result.best.mobileBase, 'b');
  assert.equal(result.comparisons.find((row) => row.mobileBase === 'c').coveredExpectedIncidents, 7);
  assert.deepEqual(scenario, original);
});

test('Personnel totals preserve four fixed crews plus one mobile crew, with no coverage benefit from crew size', async () => {
  const scenario = await fixture();
  const four = evaluateTrainingAllocation(scenario, options);
  const six = evaluateTrainingAllocation(scenario, { ...options, crewSize: 6 });
  assert.deepEqual(four.personnel.map((row) => [row.baseId, row.crews, row.personnel]), [['a', 4, 16], ['b', 1, 4]]);
  assert.equal(four.totalPersonnel, 20);
  assert.equal(six.totalPersonnel, 30);
  assert.equal(six.coveredExpectedIncidents, four.coveredExpectedIncidents);
  assert.deepEqual(six.coveredCellIds, four.coveredCellIds);
});

test('Overlapping fixed and mobile reachability counts each demand cell once and ties preserve baseline A', async () => {
  const scenario = await fixture();
  const baseline = evaluateTrainingAllocation(scenario, { ...options, mobileBase: 'a' });
  assert.equal(baseline.coveredExpectedIncidents, 3);
  const tied = evaluateTrainingAllocation(scenario, { ...options, thresholdMinutes: 60 });
  assert.equal(tied.coveredExpectedIncidents, 10);
  assert.equal(tied.best.mobileBase, 'a');
  assert.deepEqual(tied.comparisons.map((row) => row.mobileBase), ['a', 'b', 'c']);
});

test('Threshold boundaries are inclusive and a one-minute threshold covers no cells', async () => {
  const scenario = await fixture();
  assert.equal(evaluateTrainingAllocation(scenario, { ...options, mobileBase: 'a', thresholdMinutes: 5 }).coveredExpectedIncidents, 2);
  const none = evaluateTrainingAllocation(scenario, { ...options, thresholdMinutes: 1 });
  assert.equal(none.coveredExpectedIncidents, 0);
  assert.equal(none.best.mobileBase, 'a');
});

test('Noninteger or out-of-range personnel and threshold inputs and unknown bases are blocked', async () => {
  const scenario = await fixture();
  for (const crewSize of [0, -1, 11, 1.5, NaN, Infinity, '4', null]) assert.equal(evaluateTrainingAllocation(scenario, { ...options, crewSize }).status, 'blocked');
  for (const thresholdMinutes of [0, -1, 61, 1.5, NaN, Infinity, '15', null]) assert.equal(evaluateTrainingAllocation(scenario, { ...options, thresholdMinutes }).status, 'blocked');
  assert.equal(evaluateTrainingAllocation(scenario, { ...options, mobileBase: 'real-station' }).status, 'blocked');
});

test('Incomplete, nonfinite or negative travel and demand inputs block allocation instead of becoming zero', async () => {
  for (const invalid of [null, undefined, -1, NaN, Infinity, '6']) {
    const scenario = await fixture(); scenario.travel_minutes.b.C = invalid;
    assert.equal(evaluateTrainingAllocation(scenario, options).status, 'blocked');
  }
  const missingBase = await fixture(); delete missingBase.travel_minutes.c;
  assert.equal(evaluateTrainingAllocation(missingBase, options).status, 'blocked');
  const negativeDemand = await fixture(); negativeDemand.cells[0].expected_incidents = -1;
  assert.equal(evaluateTrainingAllocation(negativeDemand, options).status, 'blocked');
});

test('Absent or non-synthetic scenarios never produce fallback fictional allocation results', async () => {
  for (const scenario of [null, {}, { kind: 'measured' }]) assert.equal(evaluateTrainingAllocation(scenario, options).status, 'blocked');
  const mislabeled = await fixture(); mislabeled.kind = 'operational';
  assert.equal(evaluateTrainingAllocation(mislabeled, options).status, 'blocked');
  assert.equal(evaluateTrainingAllocation(await fixture(), null).status, 'blocked');
});

function browserFixture(context, fetcher) {
  const elements = new Map();
  const create = () => ({ hidden: false, disabled: false, textContent: '', value: '', children: [],
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; } });
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.document = originalDocument; globalThis.fetch = originalFetch; });
  globalThis.document = { getElementById(id) { if (!elements.has(id)) elements.set(id, create()); return elements.get(id); }, createElement: create };
  globalThis.fetch = fetcher;
  return elements;
}

test('The initialized exercise shows baseline personnel and navigates to the original LA month and evidence only', async (context) => {
  const scenario = await fixture();
  const elements = browserFixture(context, async (path) => {
    assert.equal(path, 'data/training-scenario.json');
    return { ok: true, json: async () => scenario };
  });
  const navigation = [];
  await initializeTraining(async (details) => navigation.push(details));
  assert.equal(elements.get('training-case').hidden, false);
  assert.match(elements.get('training-result').textContent, /3 of 10 hypothetical/);
  assert.match(elements.get('training-result').textContent, /20 personnel/);
  await elements.get('training-open-calendar').onclick();
  await elements.get('training-open-map').onclick();
  await elements.get('training-open-evidence').onclick();
  assert.deepEqual(navigation, [
    { region: 'los-angeles', month: '2024-05', target: 'monthly-calendar' },
    { region: 'los-angeles', month: '2024-05', target: 'selected-panel' },
    { target: 'decision-matrix' },
  ]);
  elements.get('training-mobile-base').value = 'b';
  elements.get('training-evaluate').onclick();
  assert.match(elements.get('training-result').textContent, /8 of 10 hypothetical/);
  elements.get('training-crew-size').value = '0';
  elements.get('training-evaluate').onclick();
  assert.match(elements.get('training-result').textContent, /Simulation blocked/);
  assert.equal(elements.get('training-personnel').children.length, 0);
  assert.equal(elements.get('training-coverage').children.length, 0);
});

test('Failed scenario retrieval leaves training hidden and controls disabled without a fictional fallback', async (context) => {
  const elements = browserFixture(context, async () => ({ ok: false, status: 404 }));
  await initializeTraining(() => { throw new Error('Navigation must not run.'); });
  assert.equal(elements.get('training-case').hidden, true);
  assert.equal(elements.get('training-evaluate').disabled, true);
  assert.match(elements.get('training-load-status').textContent, /unavailable: Training scenario: HTTP 404/);
  assert.equal(elements.get('training-result'), undefined);
});

test('A rejected context-navigation callback reports its failure without claiming evidence was opened', async (context) => {
  const scenario = await fixture();
  const elements = browserFixture(context, async () => ({ ok: true, json: async () => scenario }));
  await initializeTraining(async () => { throw new Error('Context unavailable'); });
  await elements.get('training-open-calendar').onclick();
  assert.equal(elements.get('training-result').textContent, 'Historical context could not be opened: Context unavailable');
});
