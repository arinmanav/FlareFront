const $ = (id) => document.getElementById(id);
const day = 86400000;
const dateLabel = (value) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value));
const shiftedDate = (value, offset) => new Date(Date.parse(value) + offset * day).toISOString().slice(0, 10);
const percent = (value) => `${(100 * value).toFixed(1)}%`;
let state = null;

export function evaluatePrediction(record, cells, pick) {
  if (!cells.some((cell) => cell.id === pick?.cell) || !Number.isInteger(pick?.week) || pick.week < 0 || pick.week > 3) throw new Error('Choose one mapped area and one of the four weeks.');
  if (!Array.isArray(record?.outcomes) || record.outcomes.some((row) => !cells.some((cell) => cell.id === row.cell) || !Number.isInteger(row.week) || row.week < 0 || row.week > 3 || !Number.isInteger(row.detections) || row.detections <= 0)) throw new Error('The observed record is invalid.');
  const exact = record.outcomes.filter((row) => row.cell === pick.cell && row.week === pick.week);
  return { hit: exact.length > 0, detections: exact.reduce((sum, row) => sum + row.detections, 0),
    locationHit: record.outcomes.some((row) => row.cell === pick.cell),
    weekHit: record.outcomes.some((row) => row.week === pick.week) };
}

function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

function option(value, label) {
  const node = element('option', label); node.value = value; return node;
}

function tableRow(values) {
  const row = element('tr');
  values.forEach((value, index) => { const cell = element(index ? 'td' : 'th', value); if (!index) cell.scope = 'row'; row.append(cell); });
  return row;
}

const currentRegion = () => state.data.regions.find((region) => region.id === state.region);
const currentCase = () => currentRegion().cases[state.caseIndex];
const cellLabel = (id) => currentRegion().cells.find((cell) => cell.id === id)?.label ?? id;
const weekLabel = (record, week) => `${dateLabel(shiftedDate(record.origin, week * 7))} – ${dateLabel(shiftedDate(record.origin, week * 7 + 6))}`;

function renderResults(pick) {
  const record = currentCase(); const region = currentRegion();
  const result = evaluatePrediction(record, region.cells, pick);
  const baseline = evaluatePrediction(record, region.cells, record.picks.recent);
  const combined = evaluatePrediction(record, region.cells, record.picks.multisensor);
  $('prediction-verdict').textContent = result.hit ? 'Your Area And Week Matched Observed Activity' : 'No Observed Match In Your Area And Week';
  const comparison = (reference) => result.hit === reference.hit ? 'tied with' : result.hit ? 'scored higher than' : 'scored lower than';
  $('prediction-comparison').textContent = `On this window, your prediction ${comparison(baseline)} recent VIIRS and ${comparison(combined)} the combined MODIS / VIIRS rule. One case does not establish forecasting skill.`;
  $('prediction-diagnostics').textContent = `Your area: ${result.locationHit ? 'activity observed during the 28 days' : 'no activity recorded during the 28 days'}. Your week: ${result.weekHit ? 'activity observed somewhere in the county' : 'no activity recorded in the county'}. Exact match: ${result.detections} qualifying detections.`;
  const body = $('prediction-case-results'); body.replaceChildren();
  for (const [method, selection] of [['Your Prediction', pick], ...state.data.protocol.methods.map((key) => [state.data.method_names[key], record.picks[key]])]) {
    const scored = evaluatePrediction(record, region.cells, selection);
    body.append(tableRow([method, cellLabel(selection.cell), `Week ${selection.week + 1}`, scored.hit ? 'Observed Match' : 'No Observed Match', String(scored.detections)]));
  }
  const observations = $('prediction-observations'); observations.replaceChildren();
  for (let week = 0; week < 4; week++) {
    const rows = record.outcomes.filter((row) => row.week === week);
    const section = element('div'); section.append(element('h4', `Week ${week + 1}`), element('p', weekLabel(record, week), 'caption'));
    section.append(element('p', rows.length ? rows.map((row) => `${cellLabel(row.cell)} (${row.detections})`).join(', ') : 'No qualifying detections recorded.'));
    observations.append(section);
  }
  $('prediction-result').hidden = false;
  $('prediction-verdict').focus({ preventScroll: true });
}

function renderMap() {
  if (!state?.data || !window.L || !$('prediction-map').checkVisibility()) return;
  if (!state.map) {
    state.map = L.map('prediction-map', { zoomControl: true, scrollWheelZoom: false, zoomSnap: .25, zoomDelta: .5 });
    state.map.attributionControl.setPrefix(false);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 15, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
    tiles.on('tileerror', () => { $('prediction-map-status').textContent = 'Base tiles unavailable. County areas and recorded observations remain visible.'; });
    tiles.addTo(state.map);
    state.layer = L.layerGroup().addTo(state.map);
  }
  state.layer.clearLayers();
  const region = currentRegion(); const record = currentCase(); const selected = $('prediction-area').value;
  const week = Number($('prediction-week').value);
  const maxRecent = Math.max(1, ...Object.values(record.recent_snpp));
  for (const cell of region.cells) {
    const observed = record.outcomes.find((row) => row.cell === cell.id && row.week === week);
    const recent = record.recent_snpp[cell.id] ?? 0;
    const color = state.revealed ? observed ? '#b64a1d' : '#e4e9ed' : recent ? '#386a88' : '#e4e9ed';
    const layer = L.geoJSON(cell.geometry, { style: { color: selected === cell.id ? '#132f48' : '#778b9b', weight: selected === cell.id ? 3 : .8,
      fillColor: color, fillOpacity: state.revealed ? observed ? .68 : .18 : recent ? .2 + .6 * Math.log1p(recent) / Math.log1p(maxRecent) : .15 } });
    const tooltip = element('span', `${cell.label} · ${state.revealed ? `${observed?.detections ?? 0} detections in week ${week + 1}` : `${recent} recent VIIRS detections`}`);
    layer.bindTooltip(tooltip); layer.on('click', () => {
      if (state.revealed) return;
      $('prediction-area').value = cell.id; renderSelection(); renderMap();
    }); layer.addTo(state.layer);
  }
  state.map.invalidateSize({ animate: false });
  const viewKey = `${region.id}/${$('prediction-map').clientWidth}/${$('prediction-map').clientHeight}`;
  if (state.mapRegion !== viewKey) {
    const boundary = L.geoJSON({ type: 'FeatureCollection', features: region.cells.map((cell) => ({ type: 'Feature', properties: {}, geometry: cell.geometry })) });
    state.map.fitBounds(boundary.getBounds(), { padding: [12, 12], animate: false }); state.mapRegion = viewKey;
  }
  $('prediction-map-heading').textContent = state.revealed ? `Observed Activity · Week ${week + 1}` : 'Recent VIIRS Detections';
  $('prediction-map-legend').textContent = state.revealed ? 'Orange: observed activity · Dark outline: your chosen area · Pale: no recorded detection' : 'Blue: recent VIIRS detections (log shading) · Dark outline: selected area · Pale: no recorded detection';
}

function renderSelection() {
  const cell = currentRegion().cells.find((item) => item.id === $('prediction-area').value);
  if (!cell) { $('prediction-selection').textContent = ''; return; }
  $('prediction-selection').textContent = `${cell.label} · ${Math.abs(cell.center[1]).toFixed(2)}° N, ${Math.abs(cell.center[0]).toFixed(2)}° W · ${weekLabel(currentCase(), Number($('prediction-week').value))}`;
}

function renderCase() {
  state.revealed = false;
  const region = currentRegion(); const record = currentCase();
  $('prediction-result').hidden = true; $('prediction-lock').disabled = false; $('prediction-area').disabled = false;
  $('prediction-lock').textContent = 'Lock And Reveal';
  $('prediction-origin').textContent = `${region.county} · Window ${state.caseIndex + 1} Of ${region.cases.length}`;
  $('prediction-evidence-note').textContent = `Recent evidence: ${dateLabel(shiftedDate(record.input_end_exclusive, -28))} through ${dateLabel(shiftedDate(record.input_end_exclusive, -1))}. The two days immediately before the forecast are excluded. Seasonal history uses 2013–2019 only.`;
  $('prediction-area').replaceChildren(option('', 'Select An Area'), ...region.cells.map((cell) => option(cell.id, `${cell.label} · ${cell.center[1].toFixed(2)} N, ${Math.abs(cell.center[0]).toFixed(2)} W`)));
  $('prediction-area').selectedIndex = 0;
  $('prediction-week').replaceChildren(...[0, 1, 2, 3].map((week) => option(week, `Week ${week + 1} · ${weekLabel(record, week)}`)));
  $('prediction-retry-note').hidden = !state.seen.has(`${region.id}/${record.origin}`);
  renderSelection(); renderMap();
}

function renderBenchmark() {
  const region = currentRegion(); const body = $('prediction-benchmark'); body.replaceChildren();
  for (const method of state.data.protocol.methods) {
    const metric = region.metrics[method];
    body.append(tableRow([state.data.method_names[method], `${metric.hits} / ${metric.windows}`, percent(metric.hit_rate), `${metric.location_hits} / ${metric.windows}`, `${metric.hits} / ${metric.observed_active_cell_weeks}`]));
  }
  $('prediction-benchmark-note').textContent = `${region.county}: ${region.cases.length} non-overlapping 28-day windows in 2024–2025, including ${region.quiet_windows} with no qualifying detections. Every rule selects one area-week. The last three calendar days are outside the complete windows. Location-only matches allow any of the four weeks; they do not count as exact hits.`;
  const combined = region.metrics.multisensor.hits; const recent = region.metrics.recent.hits;
  const added = combined - region.metrics.history_recent.hits;
  $('prediction-county-conclusion').textContent = `The combined rule matched ${combined} windows; recent VIIRS matched ${recent}. Adding Terra to the same history-plus-recent rule ${added === 0 ? 'did not change the number of matches' : `${added > 0 ? 'increased' : 'reduced'} matches by ${Math.abs(added)}`}. This is an exploratory archive comparison, not a validated operational forecast.`;
}

export function selectPredictionRegion(id) {
  if (!state?.data || !state.data.regions.some((region) => region.id === id) || state.region === id) return;
  state.region = id; state.caseIndex = 0;
  $('prediction-region').value = id; renderWindowOptions(); renderCase(); renderBenchmark();
}

function renderWindowOptions() {
  $('prediction-window').replaceChildren(...currentRegion().cases.map((record, index) => option(index, `${dateLabel(record.origin)} – ${dateLabel(shiftedDate(record.end_exclusive, -1))}`)));
  $('prediction-window').value = String(state.caseIndex);
}

export async function initializePrediction(onRegionChange) {
  state = { data: null, region: 'los-angeles', caseIndex: 0, revealed: false, seen: new Set(), map: null, mapRegion: null };
  try {
    const response = await fetch('data/prediction.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    if (state.data.schema_version !== 1 || state.data.regions.length !== 4) throw new Error('The four-county prediction record is unavailable.');
    for (const region of state.data.regions) for (const record of region.cases) for (const pick of Object.values(record.picks)) evaluatePrediction(record, region.cells, pick);
    $('prediction-region').replaceChildren(...state.data.regions.map((region) => option(region.id, region.city)));
    $('prediction-region').onchange = () => { selectPredictionRegion($('prediction-region').value); onRegionChange?.(state.region); };
    $('prediction-window').onchange = () => { state.caseIndex = Number($('prediction-window').value); renderCase(); };
    $('prediction-area').onchange = () => { renderSelection(); renderMap(); };
    $('prediction-week').onchange = () => { if (!state.revealed) renderSelection(); renderMap(); };
    $('prediction-form').onsubmit = (event) => {
      event.preventDefault();
      if (state.revealed) return;
      const pick = { cell: $('prediction-area').value, week: Number($('prediction-week').value) };
      renderResults(pick); state.revealed = true;
      state.seen.add(`${state.region}/${currentCase().origin}`);
      $('prediction-lock').disabled = true; $('prediction-area').disabled = true;
      $('prediction-lock').textContent = 'Prediction Locked'; renderMap();
    };
    $('prediction-next').onclick = () => { state.caseIndex = (state.caseIndex + 1) % currentRegion().cases.length; $('prediction-window').value = String(state.caseIndex); renderCase(); $('prediction-origin').focus({ preventScroll: false }); };
    $('prediction-load-status').hidden = true; $('prediction-content').hidden = false;
    $('prediction-limitations').replaceChildren(...state.data.protocol.limitations.map((text) => element('li', text)));
    const overview = $('prediction-overview'); overview.replaceChildren();
    for (const region of state.data.regions) overview.append(tableRow([region.city, ...state.data.protocol.methods.map((method) => `${region.metrics[method].hits} / ${region.metrics[method].windows}`)]));
    const totals = state.data.regions.reduce((sum, region) => ({
      windows: sum.windows + region.cases.length,
      recent: sum.recent + region.metrics.recent.hits,
      combined: sum.combined + region.metrics.multisensor.hits,
    }), { windows: 0, recent: 0, combined: 0 });
    $('prediction-study-summary').textContent = `Across ${totals.windows} windows, recent VIIRS matched ${totals.recent} area-week choices; the combined MODIS / VIIRS rule matched ${totals.combined}. ${totals.combined <= totals.recent ? 'Combining them did not improve the overall score.' : 'This increase does not establish general forecasting skill.'} These are exploratory results.`;
    renderWindowOptions(); renderCase(); renderBenchmark();
    const observer = new ResizeObserver(() => { if ($('prediction-map').checkVisibility()) renderMap(); });
    observer.observe($('prediction-map'));
  } catch (error) {
    $('prediction-content').hidden = true; $('prediction-load-status').hidden = false;
    $('prediction-load-status').textContent = `Prediction record unavailable: ${error.message}. Reload to retry.`;
  }
}
