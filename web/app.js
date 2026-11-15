import { MONTH_NAMES, SERIES_NAMES, monthKey, monthsInRange, seriesValue, sourceForMonth, pointsInRange, weeklyBins, historicalMedian, monthlyAnomaly, annualRawCounts, logColorPosition } from './calendar.js';
import { downloadCsv, exportChart } from './exports.js';
import { initializeComparison } from './comparison.js';
import { initializeHarmonization, renderHarmonizationExample } from './harmonization.js';
import { validateRegions, regionFromSearch, validateRegionalDashboard, createRegionLoader } from './regions.js';
import { subsetRecord, areaDescription } from './area.js';
import { createAreaControls } from './area-controls.js';
import { FIRE_RAMP, fireColor } from './fire-colors.js';
import { historyNumber, signedNumber, renderCalendarValues, renderDailyCalendar } from './history-view.js';

const state = {
  series: 'main', start: '2001-01', end: '2025-12', selected: '2025-01',
  data: null, points: null, county: null, map: null, pointLayer: null,
  mapError: null, heatmapBound: false, countyBounds: null, mapRows: [],
  registry: null, region: null, loadGeneration: 0,
  countyData: null, countyPoints: null, area: null, areaControls: null, countySeries: 'main',
};
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const colors = { terra: '#426c99', aqua: '#22867d', snpp: '#df6b25', main: '#b95320' };
const chartConfig = { responsive: true, displayModeBar: false, scrollZoom: false, locale: 'en-US' };
const units = () => state.series === 'main' ? 'Terra-equivalent detections' : 'Observed hotspot detections';
const format = (value) => value === null || value === undefined ? 'Unavailable' : number.format(value);
const selectedRecord = () => state.data.months.find((row) => monthKey(row.year, row.month) === state.selected);
const filteredMonths = () => monthsInRange(state.data.months, state.start, state.end);
const monthLabel = (row) => `${MONTH_NAMES[row.month - 1]} ${row.year}`;

function text(id, value) { $(id).textContent = value; }

function chartLayout(overrides = {}) {
  const axis = { showline: true, mirror: true, linewidth: 1.2, linecolor: '#20251f', showgrid: false, zeroline: false, tickfont: { family: 'Arial', size: 12 }, ticks: 'outside', ticklen: 4, fixedrange: true, automargin: true };
  return {
    paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
    font: { family: 'Arial', size: 12, color: '#20251f' },
    margin: { l: 66, r: 25, t: 24, b: 58 },
    xaxis: { ...axis }, yaxis: { ...axis },
    showlegend: false, hovermode: 'closest',
    ...overrides,
  };
}

async function fetchJson(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function validatePoints(points) {
  if (!Array.isArray(points?.columns) || !Array.isArray(points.rows)) throw new Error('The hotspot point file has an invalid schema.');
  for (const column of ['date', 'time', 'lat', 'lon', 'sensor']) if (!points.columns.includes(column)) throw new Error(`The point file is missing ${column}.`);
  const date = points.columns.indexOf('date');
  const sensor = points.columns.indexOf('sensor');
  const lat = points.columns.indexOf('lat');
  const lon = points.columns.indexOf('lon');
  for (const row of points.rows) if (typeof row[date] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row[date]) || !['terra', 'aqua', 'snpp'].includes(row[sensor]) || !Number.isFinite(row[lat]) || !Number.isFinite(row[lon])) throw new Error('The point file contains an invalid detection.');
  return points;
}

const loadRegionFiles = createRegionLoader(fetchJson);

function countyName(region) {
  return /County$/i.test(region.county) ? region.county : `${region.county} County`;
}

function calendarControls(disabled) {
  document.querySelectorAll('#calendar-view button, #calendar-view input, #calendar-view select').forEach((control) => {
    if (control.id !== 'region-select') control.disabled = disabled;
  });
}

function showLoadStatus(message, error = false) {
  const panel = $('load-status');
  panel.hidden = false;
  panel.classList.toggle('error', error);
  panel.textContent = message;
}

async function selectRegion(region, updateUrl = false) {
  const generation = ++state.loadGeneration;
  state.region = region;
  $('region-select').value = region.id;
  if (updateUrl) {
    const url = new URL(location.href); url.searchParams.set('region', region.id);
    history.pushState(null, '', url);
  }
  text('county-heading', countyName(region));
  text('header-period', `${region.city} · County-Wide Record · UTC`);
  text('footer-region', `${countyName(region)} · Historical Hotspot Harmonization`);
  $('dashboard').hidden = true;
  calendarControls(true);
  state.areaControls?.dispose(); state.areaControls = null;
  if (state.area) state.series = state.countySeries;
  state.area = null; state.countyData = null; state.countyPoints = null;
  $('series').querySelector('[value="main"]').disabled = false;
  $('coordinate-entry').open = false;
  state.map?.remove(); state.map = null; state.pointLayer = null; state.countyBounds = null; state.mapRows = [];
  state.data = null; state.points = null; state.county = null; state.mapError = null; state.heatmapBound = false;
  $('county-map').replaceChildren();
  text('map-tiles-status', 'Loading Geographic Context…');
  $('map-tiles-status').classList.remove('error-message');
  $('comparison-mode').onchange = null;
  for (const id of ['heatmap', 'weekly-trend', 'sensor-comparison', 'harmonization-chart']) if (window.Plotly) Plotly.purge($(id));
  text('action-status', '');
  showLoadStatus(`Loading ${countyName(region)} observations and county geometry…`);
  try {
    const files = await loadRegionFiles(region);
    if (!files || generation !== state.loadGeneration) return;
    const data = validateRegionalDashboard(files.data, region);
    if (!window.Plotly) throw new Error('The local Plotly chart asset could not be loaded.');
    state.data = data; state.countyData = data;
    const mapErrors = [];
    if (files.points) {
      try { state.points = validatePoints(files.points); } catch (error) { mapErrors.push(`Point records unavailable: ${error.message}`); }
    } else mapErrors.push(`Point records unavailable: ${files.errors.points ?? 'The point file is missing.'}`);
    if (files.county?.type === 'FeatureCollection' && files.county.features?.length === 1 && files.county.features[0].properties?.GEOID === region.geoid) state.county = files.county;
    else mapErrors.push(`County geometry unavailable: ${files.errors.county ?? 'The boundary file is missing or invalid.'}`);
    if (!window.L) mapErrors.push('The local Leaflet map asset could not be loaded.');
    state.mapError = mapErrors.join(' ') || null;
    state.countyPoints = state.points;
    calendarControls(false);
    $('start-month').value = state.start; $('end-month').value = state.end; $('series').value = state.series;
    $('county-map').setAttribute('aria-label', `Observed Hotspots In ${countyName(region)}`);
    renderMethods();
    $('load-status').hidden = true;
    $('dashboard').hidden = false;
    setupMap();
    updateAreaAvailability();
    await Promise.all([render(), initializeHarmonization(data)]);
  } catch (error) {
    if (generation !== state.loadGeneration) return;
    state.data = null; state.points = null; state.county = null;
    $('dashboard').hidden = true;
    calendarControls(true);
    showLoadStatus(`${countyName(region)} record unavailable. ${error.message} Select another county or reload to retry.`, true);
  }
}

function updateAreaAvailability() {
  const available = Boolean(state.map && state.county && state.countyPoints);
  document.querySelectorAll('#area-controls button, #area-controls input').forEach((control) => { control.disabled = !available; });
  $('clear-area').disabled = !available || !state.area;
  if (!available) text('area-status', 'Area selection requires the county boundary, hotspot points and map to load. Reload or choose another county.');
}

async function applyArea(area) {
  if (area) {
    const subset = subsetRecord(state.countyData, state.countyPoints, area);
    if (!state.area) state.countySeries = state.series;
    state.data = subset.data; state.points = subset.points;
    if (state.series === 'main') state.series = 'snpp';
  } else {
    state.data = state.countyData; state.points = state.countyPoints;
    if (state.area) state.series = state.countySeries;
  }
  state.area = area;
  $('series').querySelector('[value="main"]').disabled = Boolean(area);
  $('series').value = state.series;
  text('action-status', '');
  await render();
}

function areaExportFields() {
  return [state.region.geoid, areaDescription(state.area), state.area ? JSON.stringify(state.area) : '', state.area ? 'Raw observations; no custom-area calibration' : 'County record'];
}
const areaExportHeaders = ['county_geoid', 'area_description', 'area_geometry', 'calibration_scope'];
const areaFilename = () => state.area ? '-custom-area' : '';

async function initialize() {
  bindControls();
  calendarControls(true);
  const comparisonReady = initializeComparison();
  try {
    state.registry = validateRegions(await fetchJson('data/regions.json'));
    for (const region of state.registry.regions) {
      const option = document.createElement('option'); option.value = region.id; option.textContent = countyName(region); $('region-select').append(option);
    }
    $('region-select').disabled = false;
    $('region-select').addEventListener('change', () => {
      const region = state.registry.regions.find((entry) => entry.id === $('region-select').value);
      if (region) selectRegion(region, true);
    });
    window.addEventListener('popstate', () => {
      const region = regionFromSearch(state.registry, location.search);
      if (region.id !== state.region?.id) selectRegion(region);
    });
    await selectRegion(regionFromSearch(state.registry, location.search));
  } catch (error) { calendarControls(true); showLoadStatus(`County records unavailable. ${error.message}`, true); }
  await comparisonReady;
  if (location.hash && !['#calendar', '#comparison'].includes(location.hash)) revealWorkflowTarget(location.hash.slice(1));
}

function bindControls() {
  $('calendar-mode').addEventListener('change', updateCalendarView);
  $('calendar-year').addEventListener('change', () => {
    const months = filteredMonths().filter((row) => row.year === Number($('calendar-year').value));
    const row = months.find((row) => row.month === selectedRecord().month) ?? months[0];
    if (row) selectMonth(monthKey(row.year, row.month));
  });
  $('map-extent').addEventListener('click', () => {
    if (state.map && state.countyBounds) state.map.fitBounds(state.countyBounds, { padding: [14, 14], animate: false });
  });
  for (const id of ['start-month', 'end-month']) $(id).addEventListener('change', () => {
    const start = $('start-month').value;
    const end = $('end-month').value;
    const valid = /^20\d{2}-\d{2}$/.test(start) && /^20\d{2}-\d{2}$/.test(end) && start >= '2001-01' && end <= '2025-12' && start <= end;
    $('filter-error').hidden = valid;
    if (!valid) { text('filter-error', 'Choose a valid range from January 2001 through December 2025, with From no later than Through.'); return; }
    state.start = start;
    state.end = end;
    state.selected = state.selected < start ? start : state.selected > end ? end : state.selected;
    render();
  });
  $('series').addEventListener('change', (event) => { state.series = event.target.value; render(); });
  $('selected-month').addEventListener('change', (event) => selectMonth(event.target.value));
  $('previous-month').addEventListener('click', () => shiftMonth(-1));
  $('next-month').addEventListener('click', () => shiftMonth(1));
  $('reset-filters').addEventListener('click', () => {
    state.areaControls?.clear();
    state.area = null; state.data = state.countyData; state.points = state.countyPoints;
    $('series').querySelector('[value="main"]').disabled = false;
    state.start = '2001-01'; state.end = '2025-12'; state.selected = '2025-01'; state.series = 'main';
    $('start-month').value = state.start; $('end-month').value = state.end; $('series').value = state.series;
    $('filter-error').hidden = true;
    render();
  });
  $('download-points').addEventListener('click', () => {
    if (!state.data || !state.points) return;
    const rows = pointsInRange(state.points, state.start, state.end, state.series, state.data.meta.switch_year);
    downloadCsv(`flarefront-${state.region.id}${areaFilename()}-observed-${state.series}-${state.start}-${state.end}.csv`, [...state.points.columns, ...areaExportHeaders], rows.map((row) => [...row, ...areaExportFields()]));
    text('action-status', `Downloaded ${number.format(rows.length)} observed point records for the current date range and source selection.`);
  });
  $('download-calendar').addEventListener('click', () => {
    if (!state.data) return;
    const months = filteredMonths();
    const rows = months.map((row) => {
      const value = seriesValue(row, state.series);
      const baseline = state.series === 'main' ? { value: row.median, count: row.baseline_n } : historicalMedian(state.data.months, row, state.series);
      const anomaly = monthlyAnomaly(state.data.months, row, state.series, state.data.meta.switch_year);
      return [monthKey(row.year, row.month), state.series, value, sourceForMonth(state.series, row.year, state.data.meta.switch_year), units(), baseline.value, baseline.count, value === null || baseline.value === null ? null : value - baseline.value, row.terra, row.aqua, row.snpp, row.main, ...areaExportFields(), anomaly.baseline.value, anomaly.baseline.count, anomaly.baseline.years.join(';'), anomaly.difference, anomaly.percent, anomaly.partial];
    });
    downloadCsv(`flarefront-${state.region.id}${areaFilename()}-calendar-${state.series}-${state.start}-${state.end}.csv`, ['month', 'selected_series', 'selected_value', 'selected_source', 'selected_units', 'historical_median', 'baseline_years', 'difference_from_median', 'terra_observed', 'aqua_observed', 'snpp_observed', 'main_terra_equivalent', ...areaExportHeaders, 'historical_mean', 'mean_baseline_n', 'mean_baseline_years', 'difference_from_mean', 'percent_from_mean', 'partial_source_month'], rows);
    text('action-status', `Downloaded ${rows.length} calendar months. Empty values indicate unavailable source periods.`);
  });
  document.querySelectorAll('[data-export]').forEach((button) => button.addEventListener('click', async () => {
    if (!state.data) return;
    const generation = state.loadGeneration;
    const id = button.dataset.export;
    const format = button.dataset.format;
    button.disabled = true;
    text('action-status', `Preparing the ${format.toUpperCase()} figure…`);
    try {
      await exportChart($(id), format, { filename: `flarefront-${state.region.id}${areaFilename()}-${id}-${state.series}-${id === 'heatmap' ? `${state.start}-${state.end}` : state.selected}`, widthInches: 7.16, heightInches: id === 'heatmap' ? 5.37 : 3.58 });
      if (generation === state.loadGeneration) text('action-status', `${format.toUpperCase()} figure downloaded.`);
    } catch (error) { if (generation === state.loadGeneration) text('action-status', `Figure export failed: ${error.message}`); }
    finally { if (generation === state.loadGeneration) button.disabled = false; }
  }));
}

function selectMonth(key) {
  if (!state.data) return;
  if (!state.data.months.some((row) => monthKey(row.year, row.month) === key) || key < state.start || key > state.end) {
    $('selected-month').value = state.selected;
    return;
  }
  state.selected = key;
  render();
}

function shiftMonth(amount) {
  const date = new Date(`${state.selected}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  selectMonth(date.toISOString().slice(0, 7));
}

function updateCalendarView() {
  const values = $('calendar-mode').value === 'values';
  $('heatmap').hidden = values;
  $('calendar-scale').hidden = values;
  $('values-view').hidden = !values;
  if (!values) requestAnimationFrame(resizeVisibleCharts);
}

async function render() {
  if (!state.data) return;
  const record = selectedRecord();
  const customArea = Boolean(state.area);
  $('harmonization-example').hidden = customArea;
  $('harmonization-details').hidden = customArea;
  $('area-summary').hidden = !customArea;
  $('area-key').hidden = !customArea;
  $('area-methods-note').hidden = !customArea;
  text('methods-label', customArea ? 'County Methods' : 'Methods');
  text('header-period', `${state.region.city} · ${customArea ? 'Selected Area' : 'County-Wide Record'} · UTC`);
  if (customArea) {
    text('area-summary-description', `${monthLabel(record)} · ${areaDescription(state.area)} · Intersection With ${countyName(state.region)}`);
    for (const sensor of ['terra', 'aqua', 'snpp']) text(`area-${sensor}-count`, format(record[sensor]));
  } else renderHarmonizationExample(state.data, record);
  const months = filteredMonths();
  const value = seriesValue(record, state.series);
  const source = sourceForMonth(state.series, record.year, state.data.meta.switch_year);
  const selectedPoints = state.points ? pointsInRange(state.points, state.selected, state.selected, state.series, state.data.meta.switch_year) : null;
  const { baseline, difference, percent, partial } = monthlyAnomaly(state.data.months, record, state.series, state.data.meta.switch_year);
  text('selected-title', monthLabel(record));
  $('selected-month').value = state.selected;
  $('selected-month').min = state.start;
  $('selected-month').max = state.end;
  $('previous-month').disabled = state.selected <= state.start;
  $('next-month').disabled = state.selected >= state.end;
  text('count-label', state.series === 'main' ? 'Terra-Equivalent Estimate' : 'Reported Hotspot Detections');
  text('stat-main', format(value));
  text('stat-main-note', state.series === 'main' && source === 'snpp' ? state.data.meta.alpha === null ? 'County calibration unavailable' : state.data.validation.passed ? 'Scaled Suomi-NPP estimate' : 'Experimental · Calibration did not pass' : `${SERIES_NAMES[source]} · unadjusted`);
  text('stat-points', format(record[source]));
  text('stat-points-note', `${SERIES_NAMES[source]} observations`);
  text('stat-average', historyNumber(baseline.value));
  text('stat-average-note', baseline.count ? `${baseline.count} other years · ${baseline.years[0]}–${baseline.years.at(-1)}` : 'No eligible comparison years');
  text('stat-change', signedNumber(difference));
  text('stat-change-note', partial ? 'Incomplete first month; comparison withheld' : difference === null ? 'Comparison unavailable' : `${difference > 0 ? 'Above' : difference < 0 ? 'Below' : 'At'} the same-month average${percent === null ? ' · Percentage undefined when average is zero' : ` · ${signedNumber(percent)}%`}`);
  text('history-caption', `Average = arithmetic mean of the same month in other years, using the full record for this ${customArea ? 'area' : 'county'} and series. Missing and explicitly incomplete first months are excluded. Anomalies use ${units().toLowerCase()}; they describe the historical record, not a forecast.`);
  for (const id of ['stat-main', 'stat-points', 'stat-average', 'stat-change']) {
    $(id).classList.toggle('unavailable', $(id).textContent === 'Unavailable');
  }
  text('calendar-title', customArea ? 'Area Fire Calendar' : 'Fire Activity Calendar');
  text('map-title', customArea ? 'Selected Area' : 'Hotspot Map');
  text('calendar-description', `${SERIES_NAMES[state.series]}${state.series === 'main' ? state.data.meta.alpha === null ? ' · calibration unavailable' : ` · α = ${state.data.meta.alpha.toFixed(4)}` : ''} · ${units()}. Each cell is one calendar month; gray cells are unavailable. Colors are logarithmic, with fixed bounds for each series and area across date filters.`);
  text('switch-caption', state.series === 'main' ? state.data.meta.alpha === null ? `County calibration is unestimable. Main-series values from ${state.data.meta.switch_year} are withheld; select a raw sensor to inspect observed counts.` : `Source switch in ${state.data.meta.switch_year}: observed Terra counts before the switch; α × Suomi-NPP counts afterward. Retrospective estimates, not incident counts.` : 'Unadjusted qualifying observations. Sensor availability and processing versions vary across the historical record.');
  text('weekly-description', `${monthLabel(record)} · ${SERIES_NAMES[state.series]}. ${value === null ? 'This source is unavailable for the selected month.' : `Weekly pieces sum to ${format(value)} ${units().toLowerCase()}.`}`);
  text('map-description', `${monthLabel(record)} · ${SERIES_NAMES[source]} observed detections`);
  $('point-key').style.backgroundColor = colors[source];
  text('point-key-label', `${SERIES_NAMES[source]} Detection`);
  text('map-caption', value === null ? 'This source is unavailable for the selected month; no detections are plotted.' : selectedPoints === null ? `Point records unavailable. ${state.mapError ?? ''}` : `${number.format(selectedPoints.length)} raw hotspot points. ${state.series === 'main' && source === 'snpp' ? `The calendar value is scaled by α = ${state.data.meta.alpha.toFixed(4)}; map points remain observations.` : 'Multiple detections may belong to the same fire.'} County outline: Census 2026. Hotspot coverage is limited to ${countyName(state.region)}.`);
  if (customArea) $('map-caption').textContent += ' Only detections inside both the selected shape and county are shown.';
  text('region-scope', customArea ? `Selected area ∩ ${countyName(state.region)}. All charts and CSVs use this intersection. Raw sensor counts only; county calibration does not transfer to this area. Zero means no qualifying detections reported, not an absence of fire.` : 'Historical observations for research, land management and responder planning. Coverage is county-wide; this is not a live warning service. Hotspots are satellite detections, not individual fires.');
  text('download-description', `${countyName(state.region)} · ${areaDescription(state.area)} · ${state.start} through ${state.end} · ${SERIES_NAMES[state.series]}. CSVs include the county and area definition. ${customArea ? 'Counts are raw; no custom-area calibration is fitted.' : 'Point CSV contains observed records; calendar CSV keeps estimates separate.'}`);
  $('download-points').disabled = !state.points;
  const years = [...new Set(months.map((row) => row.year))];
  $('calendar-year').replaceChildren(...years.map((year) => { const option = document.createElement('option'); option.value = year; option.textContent = year; return option; }));
  $('calendar-year').value = record.year;
  renderCalendarValues($('calendar-values'), { data: state.data, months, series: state.series, selected: record, onSelect: selectMonth });
  updateCalendarView();
  const days = renderDailyCalendar($('daily-calendar'), state.data, record, state.series);
  text('daily-description', `${days.detectionDays} UTC ${days.detectionDays === 1 ? 'date' : 'dates'} with reported detections · ${days.totalDays - days.availableDays} source dates unavailable. Observing coverage is unverified. Counts are raw, including when the monthly calendar shows Terra-equivalent estimates.`);
  renderPeaks(months);
  renderMap(value === null ? [] : selectedPoints ?? []);
  await Promise.all([renderHeatmap(months), renderWeekly(record), renderComparison(months)]);
}

async function renderHeatmap(months) {
  const values = months.map((row) => seriesValue(row, state.series));
  const max = Math.max(0, ...state.data.months.map((row) => seriesValue(row, state.series) ?? 0));
  const ticks = max ? [...[0, 1, 10, 100, 1000].filter((value) => value < max * .8), max] : [0];
  const years = [...new Set(months.map((row) => row.year))].sort((a, b) => a - b);
  const shapes = months.map((row, index) => ({ type: 'rect', x0: row.month - .47, x1: row.month + .47, y0: row.year - .43, y1: row.year + .43, fillcolor: fireColor(values[index], max), line: { width: 0 }, layer: 'below' }));
  const record = selectedRecord();
  shapes.push({ type: 'rect', x0: record.month - .49, x1: record.month + .49, y0: record.year - .46, y1: record.year + .46, fillcolor: 'rgba(0,0,0,0)', line: { color: '#20251f', width: 1.6 }, layer: 'above' });
  const layout = chartLayout({ margin: { l: 58, r: 23, t: 28, b: 95 }, shapes });
  layout.xaxis = { ...layout.xaxis, tickmode: 'array', tickvals: MONTH_NAMES.map((_, index) => index + 1), ticktext: MONTH_NAMES.map((month) => month.slice(0, 3)), range: [.5, 12.5], tickfont: { size: 10 }, side: 'top', ticks: '', title: { text: 'Month', font: { size: 14 } } };
  layout.yaxis = { ...layout.yaxis, tickmode: 'array', tickvals: years, ticktext: years.map(String), range: [years.at(-1) + .6, years[0] - .6], tickfont: { size: 10 }, ticks: '', title: { text: 'Year', font: { size: 14 } } };
  const colorbar = {
    orientation: 'h', x: .5, xanchor: 'center', y: -.08, yanchor: 'top', len: .9,
    thickness: 14, outlinewidth: .6, outlinecolor: '#444444',
    tickvals: ticks.map((value) => logColorPosition(value, max)), ticktext: ticks.map(format),
    tickfont: { family: 'Arial', size: 10 },
    title: {
      text: `${state.series === 'main' ? 'Terra-Equivalent Detections' : 'Observed Hotspot Detections'}<br>(Logarithmic Color Scale)`,
      side: 'bottom', font: { family: 'Arial', size: 11 },
    },
  };
  await Plotly.react($('heatmap'), [
    {
      type: 'scatter', mode: 'markers', x: months.map((row) => row.month), y: months.map((row) => row.year),
      customdata: months.map((row, index) => { const anomaly = monthlyAnomaly(state.data.months, row, state.series, state.data.meta.switch_year); return [monthKey(row.year, row.month), `${monthLabel(row)}<br>${format(values[index])} ${units().toLowerCase()}<br>Same-month average: ${historyNumber(anomaly.baseline.value)} (${anomaly.baseline.count} years)<br>Anomaly: ${signedNumber(anomaly.difference)}`]; }),
      marker: { symbol: 'square', size: 24, color: 'rgba(0,0,0,0)' }, hovertemplate: '%{customdata[1]}<extra></extra>',
    },
    {
      type: 'scatter', mode: 'markers', x: [1, 1], y: [years[0], years[0]],
      marker: { size: 0, opacity: 0, color: [0, 1], cmin: 0, cmax: 1,
        colorscale: FIRE_RAMP.map((color, index) => [index / (FIRE_RAMP.length - 1), color]), showscale: true, colorbar },
      hoverinfo: 'skip', showlegend: false,
    },
  ], layout, chartConfig);
  if (!state.heatmapBound) {
    $('heatmap').on('plotly_click', (event) => { const key = event.points[0]?.customdata?.[0]; if (key) selectMonth(key); });
    state.heatmapBound = true;
  }
}

function renderWeekly(record) {
  const bins = weeklyBins(state.data.daily, record.year, record.month, state.series);
  const layout = chartLayout();
  layout.xaxis.title = { text: 'Week Starting (UTC)', font: { size: 14 } };
  layout.xaxis.type = 'date';
  layout.xaxis.tickformat = '%b %d';
  layout.xaxis.tickvals = bins.map((bin) => bin.week);
  layout.yaxis.title = { text: state.series === 'main' ? 'Terra-Equivalent Detections' : 'Observed Detections', font: { size: 14 } };
  layout.yaxis.rangemode = 'tozero';
  return Plotly.react($('weekly-trend'), [{ type: 'scatter', mode: 'lines+markers', x: bins.map((bin) => bin.week), y: bins.map((bin) => bin.value), line: { color: colors[state.series], width: 2 }, marker: { color: colors[state.series], size: 6 }, connectgaps: false, hovertemplate: 'Week of %{x|%b %d, %Y}<br>%{y:.2f} detections<extra></extra>' }], layout, chartConfig);
}

function renderComparison(months) {
  const annual = annualRawCounts(months);
  const layout = chartLayout({ showlegend: true, margin: { l: 64, r: 25, t: 70, b: 53 }, legend: { orientation: 'h', x: 0, y: 1.05, xanchor: 'left', yanchor: 'bottom', bgcolor: '#ffffff', bordercolor: '#444444', borderwidth: .6, font: { size: 10 }, traceorder: 'normal' } });
  layout.xaxis.title = { text: 'Year', font: { size: 14 } };
  layout.xaxis.dtick = annual.length > 10 ? 5 : 1;
  layout.xaxis.tickformat = 'd';
  layout.yaxis.title = { text: 'Observed Detections', font: { size: 14 } };
  layout.yaxis.rangemode = 'tozero';
  return Plotly.react($('sensor-comparison'), ['terra', 'aqua', 'snpp'].map((series) => ({ type: 'scatter', mode: 'lines', name: { terra: 'Terra', aqua: 'Aqua', snpp: 'Suomi-NPP' }[series], x: annual.map((row) => row.year), y: annual.map((row) => row[series]), line: { color: colors[series], width: 2 }, connectgaps: false, hovertemplate: '%{x}: %{y:,.0f} detections<extra>%{fullData.name}</extra>' })), layout, chartConfig);
}

function renderPeaks(months) {
  const rows = months.filter((row) => seriesValue(row, state.series) !== null).sort((a, b) => b[state.series] - a[state.series] || monthKey(a.year, a.month).localeCompare(monthKey(b.year, b.month))).slice(0, 5);
  $('peak-list').replaceChildren();
  if (!rows.length) {
    const empty = document.createElement('li'); empty.className = 'empty-peaks'; empty.textContent = 'This source is unavailable throughout the selected date range.'; $('peak-list').append(empty); return;
  }
  for (const [index, row] of rows.entries()) {
    const item = document.createElement('li');
    const button = document.createElement('button'); button.type = 'button';
    const rank = document.createElement('span'); rank.className = 'peak-rank'; rank.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('span'); name.className = 'peak-name'; name.textContent = monthLabel(row);
    const value = document.createElement('span'); value.className = 'peak-value'; value.textContent = format(row[state.series]);
    button.setAttribute('aria-label', `${monthLabel(row)}, ${format(row[state.series])} ${units().toLowerCase()}. Select month.`);
    button.addEventListener('click', () => selectMonth(monthKey(row.year, row.month)));
    button.append(rank, name, value); item.append(button); $('peak-list').append(item);
  }
}

function setupMap() {
  if ($('calendar-view').hidden) return;
  if (!state.county || !window.L) {
    text('map-tiles-status', 'The county map is unavailable. Calendar values remain available.');
    const message = document.createElement('p'); message.className = 'map-empty'; message.textContent = `The county map is unavailable. ${state.mapError ?? 'County geometry was not loaded.'}`; $('county-map').append(message); return;
  }
  try {
    state.map = L.map('county-map', { scrollWheelZoom: false, attributionControl: true, preferCanvas: true, minZoom: 2, maxZoom: 19, zoomSnap: .25, zoomAnimation: false, fadeAnimation: false });
    const map = state.map;
    const failedTiles = new Set();
    const basemap = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, updateWhenIdle: true, keepBuffer: 0,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    });
    const tileKey = ({ x, y, z }) => `${z}/${x}/${y}`;
    const tileStatus = () => {
      if (state.map !== map) return;
      text('map-tiles-status', failedTiles.size ? 'Some background map tiles could not load. The county outline and hotspot data remain available.' : '');
      $('map-tiles-status').classList.toggle('error-message', failedTiles.size > 0);
    };
    basemap.on('tileerror', ({ coords }) => { failedTiles.add(tileKey(coords)); tileStatus(); });
    basemap.on('tileload', ({ coords }) => { failedTiles.delete(tileKey(coords)); tileStatus(); });
    basemap.on('tileunload', ({ coords }) => { failedTiles.delete(tileKey(coords)); tileStatus(); });
    basemap.addTo(state.map);
    const boundary = L.geoJSON(state.county, { style: { color: '#415c73', weight: 1.6, fillColor: '#d8dfe8', fillOpacity: .025 } }).addTo(state.map);
    state.countyBounds = boundary.getBounds();
    state.map.fitBounds(state.countyBounds, { padding: [14, 14], animate: false });
    state.map.attributionControl.setPrefix(false);
    state.map.attributionControl.addAttribution('Census 2026 county boundary');
    state.pointLayer = L.layerGroup().addTo(state.map);
    if (state.countyPoints) state.areaControls = createAreaControls({ map: state.map, county: state.county, onApply: applyArea });
    updateAreaAvailability();
  } catch (error) {
    state.mapError = `County map could not be rendered: ${error.message}`;
    text('map-caption', state.mapError);
  }
}

function renderMap(rows) {
  state.mapRows = rows;
  if (!state.map || !state.pointLayer || !state.points) return;
  state.pointLayer.clearLayers();
  const indices = Object.fromEntries(state.points.columns.map((column, index) => [column, index]));
  for (const row of rows) {
    const point = L.circleMarker([row[indices.lat], row[indices.lon]], { radius: 3, color: colors[row[indices.sensor]], weight: .5, fillColor: colors[row[indices.sensor]], fillOpacity: .7 });
    const popup = document.createElement('div');
    popup.textContent = `${row[indices.date]} ${String(row[indices.time]).padStart(4, '0')} UTC · ${SERIES_NAMES[row[indices.sensor]]} · ${row[indices.lat].toFixed(4)}, ${row[indices.lon].toFixed(4)}`;
    point.bindPopup(popup); state.pointLayer.addLayer(point);
  }
  state.map.invalidateSize();
}

function appendTable(target, headers, rows) {
  const table = document.createElement('table'); table.className = 'metrics-table';
  const head = document.createElement('thead'); const heading = document.createElement('tr');
  for (const title of headers) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = title; heading.append(cell); }
  head.append(heading); table.append(head);
  const body = document.createElement('tbody');
  for (const row of rows) { const line = document.createElement('tr'); for (const value of row) { const cell = document.createElement('td'); cell.textContent = value; line.append(cell); } body.append(line); }
  table.append(body); target.append(table);
}

function renderMethods() {
  const { meta, validation, quality } = state.countyData;
  for (const id of ['validation-metrics', 'quality-summary', 'version-summary', 'limitations-list', 'source-list']) $(id).replaceChildren();
  text('header-period', `${state.region.city} · County-Wide Record · UTC`);
  text('footer-region', `${countyName(state.region)} · Historical Hotspot Harmonization`);
  text('county-measurement', `Qualifying hotspot detections inside the full ${countyName(state.region)} boundary. Type 0 records qualify at MODIS confidence ≥ 30 or Suomi-NPP nominal/high confidence. Exact repeated location/date/time/satellite keys are removed; separate overpasses remain separate observations.`);
  text('calibration-description', meta.alpha === null ? `Terra MODIS is the reference. ${validation.reason ?? 'The county overlap cannot support a scale factor.'} Main-series values from ${meta.switch_year} are withheld. Raw sensor counts remain available.` : `Terra MODIS is the reference. The main calendar uses observed Terra counts through ${meta.switch_year - 1}, then α × Suomi-NPP counts from ${meta.switch_year}. County-specific α = ${meta.alpha.toFixed(6)} is fitted once as the ratio of summed Terra to Suomi-NPP training counts in ${validation.training.start_year}–${validation.training.end_year}. Aqua remains a separate raw comparison.`);
  text('baseline-description', 'The historical average is the arithmetic mean of the same calendar month in every other eligible year across the full record. Missing values and explicitly incomplete first months of the active source are excluded; zero observations remain included. A selected incomplete first month has no anomaly. Differences use the selected series units; percentage differences are undefined when the mean is zero. Date filters do not change the baseline. These comparisons are retrospective. The CSV also retains the earlier median and its available-year baseline for reproducibility.');
  const passed = validation.passed === true;
  text('validation-status', meta.alpha === null ? `County calibration unestimable. ${validation.reason ?? 'Adjusted comparisons are withheld.'}` : passed ? 'This county calibration passed the predefined held-out comparison.' : 'This county calibration did not pass the predefined held-out comparison. Adjusted values remain experimental.');
  $('validation-status').classList.toggle('passed', passed);
  appendTable($('validation-metrics'), ['Monthly MAE Against Terra', 'Detections'], [['Adjusted Suomi-NPP', format(validation.mae.adjusted)], ['Unscaled Suomi-NPP', format(validation.mae.unscaled)], ['Training Seasonal Median', format(validation.mae.seasonal)]]);
  if (Array.isArray(validation.by_year) && validation.by_year.length) appendTable($('validation-metrics'), ['Year', 'Adjusted MAE', 'Unscaled MAE', 'Seasonal MAE'], validation.by_year.map((row) => [row.year, format(row.adjusted), format(row.unscaled), format(row.seasonal)]));
  text('validation-period', `${meta.alpha === null ? 'Planned evaluation' : 'Evaluation'}: ${validation.test.start_year}–${validation.test.end_year}. ${meta.alpha === null ? 'No adjusted comparison is available.' : `${validation.test.months} monthly comparisons. A pass requires adjusted MAE strictly below both baselines on identical eligible months.`} Training totals: ${format(validation.training.terra_total)} Terra and ${format(validation.training.snpp_total)} Suomi-NPP detections.`);
  const accounting = document.createElement('div'); accounting.className = 'quality-items';
  for (const [label, key] of [['Envelope Candidates', 'raw_candidates'], ['Inside County', 'inside_county'], ['Qualifying Records', 'qualifying'], ['Exact Duplicates Removed', 'duplicates']]) {
    const item = document.createElement('span'); const value = document.createElement('strong'); value.textContent = format(quality[key]); item.append(value, ` ${label}`); accounting.append(item);
  }
  $('quality-summary').append(accounting);
  if (quality.exclusions && Object.keys(quality.exclusions).length) appendTable($('quality-summary'), ['Exclusion Reason', 'Records'], Object.entries(quality.exclusions).map(([key, value]) => [key.replaceAll('_', ' '), typeof value === 'number' ? format(value) : JSON.stringify(value)]));
  const versions = validation.version_groups;
  const versionText = document.createElement('p');
  versionText.textContent = `Processing-version strings are preserved in the observed point CSV. The historical record is not assumed to have uniform processing.${meta.alpha === null ? ' Adjusted errors are withheld because county calibration is unestimable.' : ' The grouped held-out errors below compare the county calibration across the observed MODIS version transition.'}`;
  $('version-summary').append(versionText);
  if (Array.isArray(versions) && versions.length) appendTable($('version-summary'), ['Evaluation Years', 'Months', 'Adjusted MAE', 'Unscaled MAE', 'Seasonal MAE'], versions.map((group) => [`${group.start_year}–${group.end_year}`, group.months, format(group.adjusted), format(group.unscaled), format(group.seasonal)]));
  for (const limitation of state.countyData.limitations ?? []) { const item = document.createElement('li'); item.textContent = limitation; $('limitations-list').append(item); }
  for (const source of state.countyData.sources ?? []) {
    const item = document.createElement('li');
    try { const url = new URL(source.url); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported protocol'); const link = document.createElement('a'); link.href = url.href; link.textContent = source.name; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); }
    catch { item.textContent = source.name; }
    $('source-list').append(item);
  }
  text('data-metadata', `${meta.start_date} through ${meta.end_date} · ${meta.timezone ?? 'UTC'} · County GEOID ${meta.geoid ?? '06037'}. All temporal aggregation uses acquisition dates in UTC. The same Census 2026 county boundary is applied to every year.`);
}

function resizeVisibleCharts() {
  document.querySelectorAll('.js-plotly-plot').forEach((chart) => {
    if (chart.checkVisibility()) Plotly.Plots.resize(chart);
  });
  if (!$('calendar-view').hidden) state.map?.invalidateSize({ animate: false });
}

function openView(name, focus = false) {
  for (const view of ['calendar', 'comparison']) {
    const active = view === name;
    $(`${view}-view`).hidden = !active;
    $(`${view}-tab`).setAttribute('aria-selected', String(active));
    $(`${view}-tab`).tabIndex = active ? 0 : -1;
  }
  if (focus) $(`${name}-tab`).focus();
  window.scrollTo({ top: 0, behavior: 'instant' });
  requestAnimationFrame(() => {
    if (name === 'calendar' && state.data && !state.map) { setupMap(); renderMap(state.mapRows); }
    resizeVisibleCharts();
  });
}

function revealWorkflowTarget(target) {
  const element = $(target);
  if (!element) return;
  if (element.tagName === 'DETAILS') element.open = true;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
  requestAnimationFrame(() => {
    element.scrollIntoView({ block: 'start', behavior: 'instant' });
    element.tabIndex = -1;
    element.focus({ preventScroll: true });
  });
}

function restoreViewFromHash() {
  const target = location.hash.slice(1);
  const comparisonTarget = $(target)?.closest('#comparison-view');
  openView(target === 'comparison' || comparisonTarget ? 'comparison' : 'calendar');
  if (target && !['calendar', 'comparison'].includes(target)) revealWorkflowTarget(target);
}

for (const name of ['calendar', 'comparison']) {
  $(`${name}-tab`).addEventListener('click', () => { location.hash = name; openView(name); });
  $(`${name}-tab`).addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 'calendar' : event.key === 'End' ? 'comparison' : name === 'calendar' ? 'comparison' : 'calendar';
    location.hash = target; openView(target, true);
  });
}
document.querySelectorAll('[data-open-comparison]').forEach((link) => link.addEventListener('click', (event) => {
  event.preventDefault();
  location.hash = 'comparison';
  openView('comparison');
}));
document.querySelectorAll('[data-calendar-target]').forEach((link) => link.addEventListener('click', (event) => {
  event.preventDefault();
  history.pushState(null, '', `#${link.dataset.calendarTarget}`);
  openView('calendar');
  revealWorkflowTarget(link.dataset.calendarTarget);
}));
document.querySelectorAll('details').forEach((details) => details.addEventListener('toggle', () => {
  if (details.open) requestAnimationFrame(resizeVisibleCharts);
}));
window.addEventListener('hashchange', restoreViewFromHash);
restoreViewFromHash();
initialize();
