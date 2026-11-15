import { MONTH_NAMES, SERIES_NAMES, monthKey, monthsInRange, seriesValue, sourceForMonth, pointsInRange, weeklyBins, historicalMedian, annualRawCounts, logColorPosition } from './calendar.js';
import { downloadCsv, exportChart } from './exports.js';

const state = {
  series: 'main', start: '2001-01', end: '2025-12', selected: '2025-01',
  data: null, points: null, county: null, map: null, pointLayer: null,
  mapError: null, heatmapBound: false,
};
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const colors = { terra: '#426c99', aqua: '#22867d', snpp: '#df6b25', main: '#b95320' };
const calendarColors = ['#fcf1dc', '#f4c690', '#e79249', '#cc5b21', '#73321b'];
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

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function validateDashboard(data) {
  if (!data?.meta || !Array.isArray(data.months) || !Array.isArray(data.daily) || !data.validation || !data.quality) throw new Error('The dashboard data does not match the required schema.');
  const keys = new Set();
  for (const row of data.months) {
    if (!Number.isInteger(row.year) || row.year < 2001 || row.year > 2025 || !Number.isInteger(row.month) || row.month < 1 || row.month > 12) throw new Error('The calendar contains an invalid year or month.');
    const key = monthKey(row.year, row.month);
    if (keys.has(key)) throw new Error(`The calendar repeats ${key}.`);
    keys.add(key);
    for (const source of ['main', 'terra', 'aqua', 'snpp']) {
      if (row[source] !== null && (typeof row[source] !== 'number' || !Number.isFinite(row[source]) || row[source] < 0)) throw new Error(`Invalid ${source} count for ${key}.`);
    }
  }
  if (keys.size !== 300 || !keys.has('2001-01') || !keys.has('2025-12')) throw new Error('The release must contain all 300 months from January 2001 through December 2025.');
  if (!Number.isFinite(data.meta.alpha) || data.meta.alpha <= 0) throw new Error('A positive fitted calibration coefficient is required.');
  return data;
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

async function initialize() {
  const results = await Promise.allSettled([fetchJson('data/dashboard.json'), fetchJson('data/points.json'), fetchJson('data/county.geojson')]);
  try {
    if (results[0].status === 'rejected') throw results[0].reason;
    state.data = validateDashboard(results[0].value);
    if (!window.Plotly) throw new Error('The local Plotly chart asset could not be loaded.');
    if (results[1].status === 'fulfilled') {
      try { state.points = validatePoints(results[1].value); } catch (error) { state.mapError = error.message; }
    } else state.mapError = results[1].reason.message;
    if (results[2].status === 'fulfilled') state.county = results[2].value;
    else state.mapError = [state.mapError, results[2].reason.message].filter(Boolean).join(' ');
    if (!window.L) state.mapError = [state.mapError, 'The local Leaflet map asset could not be loaded.'].filter(Boolean).join(' ');
    const months = [...state.data.months].sort((a, b) => monthKey(a.year, a.month).localeCompare(monthKey(b.year, b.month)));
    state.start = monthKey(months[0].year, months[0].month);
    state.end = monthKey(months.at(-1).year, months.at(-1).month);
    state.selected = '2025-01';
    bindControls();
    renderMethods();
    $('load-status').hidden = true;
    $('dashboard').hidden = false;
    setupMap();
    await render();
  } catch (error) {
    const panel = $('load-status');
    panel.hidden = false;
    $('dashboard').hidden = true;
    panel.classList.add('error');
    panel.replaceChildren();
    const content = document.createElement('div');
    const heading = document.createElement('strong');
    heading.textContent = 'The County Record Is Unavailable';
    const detail = document.createElement('p');
    console.error('Calendar initialization failed:', error);
    detail.textContent = 'The calendar data could not be loaded. Reload the page; if the problem persists, try again later.';
    content.append(heading, detail);
    panel.append(content);
  }
}

function bindControls() {
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
    state.start = '2001-01'; state.end = '2025-12'; state.selected = '2025-01'; state.series = 'main';
    $('start-month').value = state.start; $('end-month').value = state.end; $('series').value = state.series;
    $('filter-error').hidden = true;
    render();
  });
  $('download-points').addEventListener('click', () => {
    if (!state.points) return;
    const rows = pointsInRange(state.points, state.start, state.end, state.series, state.data.meta.switch_year);
    downloadCsv(`flarefront-observed-${state.series}-${state.start}-${state.end}.csv`, state.points.columns, rows);
    text('action-status', `Downloaded ${number.format(rows.length)} observed point records for the current date range and source selection.`);
  });
  $('download-calendar').addEventListener('click', () => {
    const months = filteredMonths();
    const rows = months.map((row) => {
      const value = seriesValue(row, state.series);
      const baseline = state.series === 'main' ? { value: row.median, count: row.baseline_n } : historicalMedian(state.data.months, row, state.series);
      return [monthKey(row.year, row.month), state.series, value, sourceForMonth(state.series, row.year, state.data.meta.switch_year), units(), baseline.value, baseline.count, value === null || baseline.value === null ? null : value - baseline.value, row.terra, row.aqua, row.snpp, row.main];
    });
    downloadCsv(`flarefront-calendar-${state.series}-${state.start}-${state.end}.csv`, ['month', 'selected_series', 'selected_value', 'selected_source', 'selected_units', 'historical_median', 'baseline_years', 'difference_from_median', 'terra_observed', 'aqua_observed', 'snpp_observed', 'main_terra_equivalent'], rows);
    text('action-status', `Downloaded ${rows.length} calendar months. Empty values indicate unavailable source periods.`);
  });
  document.querySelectorAll('[data-export]').forEach((button) => button.addEventListener('click', async () => {
    const id = button.dataset.export;
    const format = button.dataset.format;
    button.disabled = true;
    text('action-status', `Preparing the ${format.toUpperCase()} figure…`);
    try {
      await exportChart($(id), format, { filename: `flarefront-${id}-${state.series}-${id === 'heatmap' ? `${state.start}-${state.end}` : state.selected}`, widthInches: 7.16, heightInches: id === 'heatmap' ? 5.37 : 3.58 });
      text('action-status', `${format.toUpperCase()} figure downloaded.`);
    } catch (error) { text('action-status', `Figure export failed: ${error.message}`); }
    finally { button.disabled = false; }
  }));
}

function selectMonth(key) {
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

async function render() {
  const record = selectedRecord();
  const months = filteredMonths();
  const value = seriesValue(record, state.series);
  const source = sourceForMonth(state.series, record.year, state.data.meta.switch_year);
  const selectedPoints = state.points ? pointsInRange(state.points, state.selected, state.selected, state.series, state.data.meta.switch_year) : null;
  const baseline = state.series === 'main' ? { value: record.median, count: record.baseline_n } : historicalMedian(state.data.months, record, state.series);
  const difference = value === null || baseline.value === null || baseline.value === undefined ? null : value - baseline.value;
  text('selected-title', monthLabel(record));
  $('selected-month').value = state.selected;
  $('selected-month').min = state.start;
  $('selected-month').max = state.end;
  $('previous-month').disabled = state.selected <= state.start;
  $('next-month').disabled = state.selected >= state.end;
  text('count-label', state.series === 'main' ? 'Terra-Equivalent Detections' : 'Observed Hotspot Detections');
  text('stat-main', format(value));
  text('stat-main-note', state.series === 'main' && source === 'snpp' ? 'Scaled Suomi-NPP estimate' : `${SERIES_NAMES[source]} · unadjusted`);
  text('stat-points', value === null ? 'Unavailable' : selectedPoints === null ? 'Unavailable' : number.format(selectedPoints.length));
  text('stat-points-note', `${SERIES_NAMES[source]} · observed records`);
  text('stat-median', format(baseline.value));
  text('stat-median-note', `${baseline.count ?? 0} other years · full historical record`);
  text('stat-change', difference === null ? 'Unavailable' : `${difference > 0 ? '+' : difference < 0 ? '−' : ''}${format(Math.abs(difference))}`);
  text('stat-change-note', `Signed difference · ${units().toLowerCase()}`);
  for (const id of ['stat-main', 'stat-points', 'stat-median', 'stat-change']) {
    $(id).classList.toggle('unavailable', $(id).textContent === 'Unavailable');
  }
  text('calendar-description', `${SERIES_NAMES[state.series]}${state.series === 'main' ? ` · α = ${state.data.meta.alpha.toFixed(4)}` : ''} · ${units()}. Each cell is one calendar month; gray cells are unavailable. Colors are logarithmic, with fixed bounds for each series across date filters.`);
  text('switch-caption', state.series === 'main' ? `Source switch in ${state.data.meta.switch_year}: observed Terra counts before the switch; α × Suomi-NPP counts afterward. Retrospective estimates, not incident counts.` : 'Unadjusted qualifying observations. Sensor availability and processing versions vary across the historical record.');
  text('weekly-description', `${monthLabel(record)} · ${SERIES_NAMES[state.series]}. ${value === null ? 'This source is unavailable for the selected month.' : `Weekly pieces sum to ${format(value)} ${units().toLowerCase()}.`}`);
  text('map-description', `${monthLabel(record)} · ${SERIES_NAMES[source]} observed detections`);
  text('map-caption', value === null ? 'This source is unavailable for the selected month; no detections are plotted.' : selectedPoints === null ? `Point records unavailable. ${state.mapError ?? ''}` : `${number.format(selectedPoints.length)} raw hotspot points. ${state.series === 'main' && source === 'snpp' ? `The calendar value is scaled by α = ${state.data.meta.alpha.toFixed(4)}; map points remain observations.` : 'Multiple detections may belong to the same fire.'} County outline: Census 2026. No basemap imagery.`);
  text('download-description', `${state.start} through ${state.end} · ${SERIES_NAMES[state.series]}. Point CSV contains the source's observed records; calendar CSV keeps estimates separate.`);
  $('download-points').disabled = !state.points;
  renderPeaks(months);
  renderMap(value === null ? [] : selectedPoints ?? []);
  await Promise.all([renderHeatmap(months), renderWeekly(record), renderComparison(months)]);
}

function cellColor(value, max) {
  if (value === null) return '#e5e7e1';
  const stops = [[252,241,220], [244,198,144], [231,146,73], [204,91,33], [115,50,27]];
  const position = logColorPosition(value, max) * (stops.length - 1);
  const low = Math.min(Math.floor(position), stops.length - 2);
  const fraction = position - low;
  return `rgb(${stops[low].map((channel, index) => Math.round(channel + (stops[low + 1][index] - channel) * fraction)).join(',')})`;
}

async function renderHeatmap(months) {
  const values = months.map((row) => seriesValue(row, state.series));
  const max = Math.max(0, ...state.data.months.map((row) => seriesValue(row, state.series) ?? 0));
  const ticks = max ? [...[0, 1, 3, 10, 30, 100, 300, 1000, 3000].filter((value) => value < max * .8), max] : [0];
  const years = [...new Set(months.map((row) => row.year))].sort((a, b) => a - b);
  const shapes = months.map((row, index) => ({ type: 'rect', x0: row.month - .47, x1: row.month + .47, y0: row.year - .43, y1: row.year + .43, fillcolor: cellColor(values[index], max), line: { width: 0 }, layer: 'below' }));
  const record = selectedRecord();
  shapes.push({ type: 'rect', x0: record.month - .49, x1: record.month + .49, y0: record.year - .46, y1: record.year + .46, fillcolor: 'rgba(0,0,0,0)', line: { color: '#20251f', width: 1.6 }, layer: 'above' });
  const layout = chartLayout({ margin: { l: 58, r: 23, t: 28, b: 95 }, shapes });
  layout.xaxis = { ...layout.xaxis, tickmode: 'array', tickvals: MONTH_NAMES.map((_, index) => index + 1), ticktext: MONTH_NAMES.map((month) => month.slice(0, 3)), range: [.5, 12.5], tickfont: { size: 10 }, side: 'top', ticks: '', title: { text: 'Month', font: { size: 14 } } };
  layout.yaxis = { ...layout.yaxis, tickmode: 'array', tickvals: years, ticktext: years.map(String), range: [years.at(-1) + .6, years[0] - .6], tickfont: { size: 10 }, ticks: '', title: { text: 'Year', font: { size: 14 } } };
  const colorbar = {
    orientation: 'h', x: .5, xanchor: 'center', y: -.08, yanchor: 'top', len: .9,
    thickness: 9, outlinewidth: .6, outlinecolor: '#444444',
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
      customdata: months.map((row, index) => [monthKey(row.year, row.month), `${monthLabel(row)}<br>${format(values[index])} ${units().toLowerCase()}`]),
      marker: { symbol: 'square', size: 24, color: 'rgba(0,0,0,0)' }, hovertemplate: '%{customdata[1]}<extra></extra>',
    },
    {
      type: 'scatter', mode: 'markers', x: [1, 1], y: [years[0], years[0]],
      marker: { size: 0, opacity: 0, color: [0, 1], cmin: 0, cmax: 1,
        colorscale: calendarColors.map((color, index) => [index / 4, color]), showscale: true, colorbar },
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
  if (!state.county || !window.L) {
    const message = document.createElement('p'); message.className = 'map-empty'; message.textContent = `The county map is unavailable. ${state.mapError ?? 'County geometry was not loaded.'}`; $('county-map').append(message); return;
  }
  try {
    state.map = L.map('county-map', { scrollWheelZoom: false, attributionControl: true, preferCanvas: true });
    const boundary = L.geoJSON(state.county, { style: { color: '#7b8798', weight: 1.2, fillColor: '#d8dfe8', fillOpacity: .65 } }).addTo(state.map);
    state.map.fitBounds(boundary.getBounds(), { padding: [14, 14] });
    state.map.attributionControl.setPrefix(false);
    state.map.attributionControl.addAttribution('Census 2026 county boundary');
    state.pointLayer = L.layerGroup().addTo(state.map);
  } catch (error) {
    state.mapError = `County map could not be rendered: ${error.message}`;
    text('map-caption', state.mapError);
  }
}

function renderMap(rows) {
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
  const { meta, validation, quality } = state.data;
  text('header-period', `${meta.county ?? 'Los Angeles County'} · 2001–2025`);
  text('calibration-description', `Terra MODIS is the reference. The main calendar uses observed Terra counts through ${meta.switch_year - 1}, then α × Suomi-NPP counts from ${meta.switch_year}. α = ${meta.alpha.toFixed(6)} is fitted once as the ratio of summed Terra to Suomi-NPP training counts in ${validation.training.start_year}–${validation.training.end_year}. Aqua remains a separate raw comparison.`);
  text('baseline-description', 'The historical median uses the same calendar month in every other available year across the full record, excluding the selected year, for both main and raw series. Date filters do not change this reference. These retrospective medians are not forecasts.');
  const passed = validation.passed === true;
  text('validation-status', passed ? 'Calibration passed the predefined held-out comparison.' : 'Experimental estimate: calibration did not pass the predefined held-out comparison. The validated milestone remains incomplete.');
  $('validation-status').classList.toggle('passed', passed);
  appendTable($('validation-metrics'), ['Monthly MAE Against Terra', 'Detections'], [['Adjusted Suomi-NPP', format(validation.mae.adjusted)], ['Unscaled Suomi-NPP', format(validation.mae.unscaled)], ['Training Seasonal Median', format(validation.mae.seasonal)]]);
  if (Array.isArray(validation.by_year) && validation.by_year.length) appendTable($('validation-metrics'), ['Year', 'Adjusted MAE', 'Unscaled MAE', 'Seasonal MAE'], validation.by_year.map((row) => [row.year, format(row.adjusted), format(row.unscaled), format(row.seasonal)]));
  text('validation-period', `Evaluation: ${validation.test.start_year}–${validation.test.end_year}, ${validation.test.months} monthly comparisons. A pass requires adjusted MAE strictly below both baselines on identical eligible months. Training totals: ${format(validation.training.terra_total)} Terra and ${format(validation.training.snpp_total)} Suomi-NPP detections.`);
  const accounting = document.createElement('div'); accounting.className = 'quality-items';
  for (const [label, key] of [['Envelope Candidates', 'raw_candidates'], ['Inside County', 'inside_county'], ['Qualifying Records', 'qualifying'], ['Exact Duplicates Removed', 'duplicates']]) {
    const item = document.createElement('span'); const value = document.createElement('strong'); value.textContent = format(quality[key]); item.append(value, ` ${label}`); accounting.append(item);
  }
  $('quality-summary').append(accounting);
  if (quality.exclusions && Object.keys(quality.exclusions).length) appendTable($('quality-summary'), ['Exclusion Reason', 'Records'], Object.entries(quality.exclusions).map(([key, value]) => [key.replaceAll('_', ' '), typeof value === 'number' ? format(value) : JSON.stringify(value)]));
  const versions = validation.version_groups;
  const versionText = document.createElement('p');
  versionText.textContent = 'Processing-version strings are preserved in the observed point CSV. The historical record is not assumed to have uniform processing. The grouped held-out errors below compare the fixed calibration across the observed MODIS version transition.';
  $('version-summary').append(versionText);
  if (Array.isArray(versions) && versions.length) appendTable($('version-summary'), ['Evaluation Years', 'Months', 'Adjusted MAE', 'Unscaled MAE', 'Seasonal MAE'], versions.map((group) => [`${group.start_year}–${group.end_year}`, group.months, format(group.adjusted), format(group.unscaled), format(group.seasonal)]));
  const acknowledgment = document.createElement('p');
  acknowledgment.textContent = 'AI assisted code editor was used for code development';
  $('source-list').parentElement.append(acknowledgment);
  for (const limitation of state.data.limitations ?? []) { const item = document.createElement('li'); item.textContent = limitation; $('limitations-list').append(item); }
  for (const source of state.data.sources ?? []) {
    const item = document.createElement('li');
    try { const url = new URL(source.url); if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported protocol'); const link = document.createElement('a'); link.href = url.href; link.textContent = source.name; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); }
    catch { item.textContent = source.name; }
    $('source-list').append(item);
  }
  text('data-metadata', `${meta.start_date} through ${meta.end_date} · ${meta.timezone ?? 'UTC'} · County GEOID ${meta.geoid ?? '06037'}. All temporal aggregation uses acquisition dates in UTC. The same Census 2026 county boundary is applied to every year.`);
}

initialize();
