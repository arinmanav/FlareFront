const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const finiteNonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identifier = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);

function validateScenario(scenario) {
  if (scenario?.schema_version !== 1 || scenario.kind !== 'synthetic_training') throw new Error('A labeled synthetic training scenario is required.');
  if (!Array.isArray(scenario.bases) || !scenario.bases.length || !Array.isArray(scenario.cells) || !scenario.cells.length) throw new Error('The exercise requires fictional bases and abstract demand cells.');
  const baseIds = new Set();
  for (const base of scenario.bases) {
    if (!identifier(base?.id) || baseIds.has(base.id) || typeof base.name !== 'string' || !base.name.trim()) throw new Error('Fictional base IDs must be unique and have names.');
    baseIds.add(base.id);
  }
  if (!baseIds.has(scenario.fixed_base) || scenario.fixed_crews !== 4 || scenario.mobile_crews !== 1) throw new Error('The exercise requires four fixed crews and one mobile crew at valid fictional bases.');
  const cellIds = new Set();
  let total = 0;
  for (const cell of scenario.cells) {
    if (!identifier(cell?.id) || cellIds.has(cell.id) || !finiteNonnegative(cell.expected_incidents)) throw new Error('Demand cell IDs must be unique and simulated expected incidents must be finite and nonnegative.');
    cellIds.add(cell.id);
    total += cell.expected_incidents;
  }
  if (!Number.isFinite(total)) throw new Error('Total simulated demand exceeds the supported numeric range.');
  for (const base of scenario.bases) for (const cell of scenario.cells) {
    if (!finiteNonnegative(scenario.travel_minutes?.[base.id]?.[cell.id])) throw new Error(`A finite nonnegative simulated travel time is required for ${base.id} to ${cell.id}.`);
  }
}

export function evaluateTrainingAllocation(scenario, options = {}) {
  try {
    const { mobileBase, crewSize, thresholdMinutes } = options ?? {};
    validateScenario(scenario);
    if (!Number.isInteger(crewSize) || crewSize < 1 || crewSize > 10) throw new Error('Crew size must be a whole number from 1 to 10.');
    if (!Number.isInteger(thresholdMinutes) || thresholdMinutes < 1 || thresholdMinutes > 60) throw new Error('The simulated travel threshold must be a whole number from 1 to 60 minutes.');
    const selectedBase = scenario.bases.find((base) => base.id === mobileBase);
    if (!selectedBase) throw new Error('Choose a fictional mobile base from this exercise.');
    const fixedBase = scenario.bases.find((base) => base.id === scenario.fixed_base);
    const totalExpectedIncidents = scenario.cells.reduce((sum, cell) => sum + cell.expected_incidents, 0);
    const fixedCoveredCellIds = scenario.cells.filter((cell) => scenario.travel_minutes[fixedBase.id][cell.id] <= thresholdMinutes).map((cell) => cell.id);
    const comparisons = scenario.bases.map((base) => {
      const covered = scenario.cells.filter((cell) => scenario.travel_minutes[fixedBase.id][cell.id] <= thresholdMinutes || scenario.travel_minutes[base.id][cell.id] <= thresholdMinutes);
      return { mobileBase: base.id, baseName: base.name, baseline: base.id === fixedBase.id,
        coveredCellIds: covered.map((cell) => cell.id), coveredExpectedIncidents: covered.reduce((sum, cell) => sum + cell.expected_incidents, 0) };
    });
    comparisons.sort((a, b) => b.coveredExpectedIncidents - a.coveredExpectedIncidents || Number(b.baseline) - Number(a.baseline) || a.mobileBase.localeCompare(b.mobileBase));
    const baseline = comparisons.find((row) => row.baseline);
    const selected = comparisons.find((row) => row.mobileBase === mobileBase);
    const personnel = [
      { role: 'Fixed crews', baseId: fixedBase.id, baseName: fixedBase.name, crews: scenario.fixed_crews, personnel: scenario.fixed_crews * crewSize },
      { role: 'Mobile crew', baseId: selectedBase.id, baseName: selectedBase.name, crews: scenario.mobile_crews, personnel: scenario.mobile_crews * crewSize },
    ];
    return { status: 'ready', mobileBase, thresholdMinutes, crewSize, fixedCoveredCellIds,
      coveredCellIds: selected.coveredCellIds, coveredExpectedIncidents: selected.coveredExpectedIncidents,
      additionalExpectedIncidents: selected.coveredExpectedIncidents - baseline.coveredExpectedIncidents,
      totalExpectedIncidents, baseline, best: comparisons[0], comparisons, personnel,
      totalCrews: scenario.fixed_crews + scenario.mobile_crews, totalPersonnel: personnel.reduce((sum, row) => sum + row.personnel, 0) };
  } catch (error) { return { status: 'blocked', reason: error.message }; }
}

function table(target, headings, rows) {
  const element = document.createElement('table'); element.className = 'metrics-table';
  const head = document.createElement('thead'); const header = document.createElement('tr');
  for (const label of headings) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; header.append(cell); }
  head.append(header); element.append(head);
  const body = document.createElement('tbody');
  for (const values of rows) {
    const row = document.createElement('tr');
    for (const value of values) { const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell); }
    body.append(row);
  }
  element.append(body); target.replaceChildren(element);
}

export async function initializeTraining(onInspect) {
  const element = (id) => document.getElementById(id);
  const controls = ['training-open-calendar', 'training-open-map', 'training-open-evidence', 'training-crew-size', 'training-threshold', 'training-mobile-base', 'training-evaluate'];
  const loadStatus = element('training-load-status');
  element('training-case').hidden = true;
  loadStatus.hidden = false;
  loadStatus.textContent = 'Loading the labeled simulation exercise…';
  controls.forEach((id) => { element(id).disabled = true; });
  try {
    if (typeof onInspect !== 'function') throw new Error('Historical context navigation is unavailable.');
    const response = await fetch('data/training-scenario.json');
    if (!response.ok) throw new Error(`Training scenario: HTTP ${response.status}`);
    const scenario = await response.json();
    const defaults = scenario.defaults;
    const initial = evaluateTrainingAllocation(scenario, { mobileBase: defaults?.mobile_base, crewSize: defaults?.crew_size, thresholdMinutes: defaults?.threshold_minutes });
    if (initial.status !== 'ready') throw new Error(initial.reason);
    if (scenario.context?.region_id !== 'los-angeles' || scenario.context?.historical_month !== '2024-05' || Date.parse(scenario.context?.cutoff) !== Date.parse('2024-06-17T00:00:00Z')) throw new Error('The exercise context does not match the Santa Clarita historical case.');
    element('training-crew-size').value = String(defaults.crew_size);
    element('training-threshold').value = String(defaults.threshold_minutes);
    const mobile = element('training-mobile-base'); mobile.replaceChildren();
    for (const base of scenario.bases) { const option = document.createElement('option'); option.value = base.id; option.textContent = base.name; mobile.append(option); }
    mobile.value = defaults.mobile_base;
    const render = () => {
      const result = evaluateTrainingAllocation(scenario, { mobileBase: mobile.value, crewSize: element('training-crew-size').valueAsNumber, thresholdMinutes: element('training-threshold').valueAsNumber });
      if (result.status !== 'ready') {
        element('training-result').textContent = `Simulation blocked: ${result.reason}`;
        element('training-personnel').replaceChildren(); element('training-coverage').replaceChildren();
        return;
      }
      element('training-result').textContent = `Simulation: ${number.format(result.coveredExpectedIncidents)} of ${number.format(result.totalExpectedIncidents)} hypothetical expected incidents lie in cells reachable within ${result.thresholdMinutes} simulated minutes, versus ${number.format(result.baseline.coveredExpectedIncidents)} at baseline. ${result.totalCrews} crews × ${result.crewSize} people = ${result.totalPersonnel} personnel. Best simulated coverage: ${result.best.baseName}.`;
      table(element('training-personnel'), ['Assignment', 'Fictional Base', 'Crews', 'Personnel'], [...result.personnel.map((row) => [row.role, row.baseName, row.crews, row.personnel]), ['Total', 'All assignments', result.totalCrews, result.totalPersonnel]]);
      table(element('training-coverage'), ['Mobile Crew At', 'Reachable Cells', 'Simulated Expected Incidents'], result.comparisons.map((row) => [`${row.baseName}${row.baseline ? ' (baseline)' : ''}${row.mobileBase === result.mobileBase ? ' (selected)' : ''}`, row.coveredCellIds.join(', ') || 'None', number.format(row.coveredExpectedIncidents)]));
      const note = document.createElement('p'); note.className = 'caption';
      note.textContent = 'Simulation only: fictional bases, abstract demand cells and hypothetical travel times. Each cell counts once; additional crew size gives no coverage or capacity benefit in this model. Real MODIS, VIIRS and EMIT observations are separate historical context and are not inputs to simulated demand. This is not a trained prediction model or an operational allocation recommendation.';
      element('training-coverage').append(note);
    };
    element('training-evaluate').onclick = render;
    const inspect = (target) => async () => {
      try {
        await onInspect(target === 'decision-matrix' ? { target } : { region: scenario.context.region_id, month: scenario.context.historical_month, target });
      } catch (error) { element('training-result').textContent = `Historical context could not be opened: ${error.message}`; }
    };
    element('training-open-calendar').onclick = inspect('monthly-calendar');
    element('training-open-map').onclick = inspect('selected-panel');
    element('training-open-evidence').onclick = inspect('decision-matrix');
    controls.forEach((id) => { element(id).disabled = false; });
    loadStatus.hidden = true;
    element('training-case').hidden = false;
    render();
  } catch (error) {
    loadStatus.textContent = `Training exercise unavailable: ${error.message}`;
    loadStatus.hidden = false;
    element('training-case').hidden = true;
  }
}
