import { HARMONIZATION_COLORS } from './plot-colors.js';
const METHODS = ['raw', 'ratio', 'lad', 'spatial_ratio', 'spatial_lad', 'selected', 'seasonal'];
const LABELS = { raw: 'Raw VIIRS', ratio: 'Count ratio', lad: 'Absolute-error fit', spatial_ratio: 'Spatial aggregation', spatial_lad: 'Spatial absolute-error fit', selected: 'Training-selected method', seasonal: 'Seasonal baseline' };
const COLORS = ['#275b91', '#bb5723', '#55755e', '#7c5d8d', '#a57b24'];
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const finiteCount = (value) => Number.isFinite(value) && value >= 0;
const close = (a, b) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(b));

export function validateStudy(study) {
  if (study?.schema_version !== 1 || study.protocol?.reference !== 'terra' || study.protocol?.source !== 'snpp'
      || !Array.isArray(study.regions) || study.regions.length < 1 || study.regions.length > 5) throw new Error('One to five county records and a Terra reference are required.');
  const expected = [];
  for (let year = study.protocol.benchmark_start; year <= study.protocol.benchmark_end; year++) {
    for (let month = 1; month <= 12; month++) expected.push(`${year}-${String(month).padStart(2, '0')}-01`);
  }
  if (study.protocol.training_end >= study.protocol.benchmark_start || expected.length !== 72) throw new Error('The declared training and comparison periods are invalid.');
  const ids = new Set();
  for (const region of study.regions) {
    if (!region.id || ids.has(region.id) || typeof region.county !== 'string' || region.months?.length !== expected.length) throw new Error('County identities or monthly coverage are invalid.');
    ids.add(region.id);
    const selected = region.selection?.selected;
    if (!['ratio', 'lad', 'spatial_ratio', 'spatial_lad'].includes(selected)) throw new Error('A training-selected method is unavailable.');
    for (const [index, row] of region.months.entries()) {
      if (row.date !== expected[index] || !finiteCount(row.terra) || !finiteCount(row.occupancy)
          || row.occupancy > row.raw || !METHODS.every((key) => finiteCount(row[key])) || !close(row.selected, row[selected])) {
        throw new Error('Incomplete or inconsistent comparison observations.');
      }
    }
    for (const key of METHODS) {
      const mae = region.months.reduce((sum, row) => sum + Math.abs(row[key] - row.terra), 0) / expected.length;
      if (!finiteCount(region.metrics?.[key]?.mae) || !close(mae, region.metrics[key].mae)) throw new Error('Reported errors do not match the monthly observations.');
    }
    for (const model of Object.values(region.models)) {
      if (!finiteCount(model.coefficient) || model.training_end > study.protocol.training_end) throw new Error('A calibration includes data outside its training period.');
    }
  }
  return study;
}

export function comparisonRows(study) {
  return study.regions.map((region) => ({
    county: region.county, raw: region.metrics.raw.mae, ratio: region.metrics.ratio.mae,
    spatial: region.metrics.spatial_ratio.mae, difference: region.metrics.spatial_ratio.mae - region.metrics.ratio.mae,
    selected: region.selection.selected,
    passes: region.metrics.ratio.mae < region.metrics.raw.mae && region.metrics.ratio.mae < region.metrics.seasonal.mae,
  }));
}

export function comparisonTraces(study, method, view) {
  if (!METHODS.includes(method) || !['3d', '2d'].includes(view)) throw new Error('Unknown comparison view or method.');
  if (view === '2d') {
    const maximum = Math.max(...study.regions.flatMap((region) => region.months.flatMap((row) => [row.terra, row[method]])));
    return [{ type: 'scatter', mode: 'lines', name: 'Equal counts', x: [0, maximum], y: [0, maximum],
      line: { color: '#666666', width: 1.5, dash: 'dash' }, hoverinfo: 'skip' },
    ...study.regions.map((region, index) => ({ type: 'scatter', mode: 'markers', name: region.county.replace(' County', ''),
      x: region.months.map((row) => row.terra), y: region.months.map((row) => row[method]),
      customdata: region.months.map((row) => [row.date.slice(0, 7), region.county]),
      marker: { color: COLORS[index], size: 6, opacity: .8, symbol: ['circle', 'square', 'diamond', 'triangle-up', 'triangle-down'][index] },
      hovertemplate: '%{customdata[1]} · %{customdata[0]}<br>Terra: %{x:,.0f}<br>VIIRS comparison: %{y:,.2f}<extra></extra>',
    }))];
  }
  return study.regions.flatMap((region, index) => [
    { key: 'terra', name: 'Terra MODIS reference', color: HARMONIZATION_COLORS.reference, dash: 'solid' },
    { key: method, name: method === 'raw' ? 'VIIRS observed' : 'VIIRS adjusted', color: method === 'raw' ? HARMONIZATION_COLORS.raw : HARMONIZATION_COLORS.adjusted, dash: 'dash' },
  ].map((series) => ({ type: 'scatter3d', mode: 'lines', name: series.name, legendgroup: series.name, showlegend: index === 0,
    x: region.months.map((_row, month) => month), y: region.months.map(() => index), z: region.months.map((row) => row[series.key]),
    customdata: region.months.map((row) => [row.date.slice(0, 7), region.county]),
    line: { color: series.color, width: 4, dash: series.dash }, connectgaps: false,
    hovertemplate: '%{customdata[1]} · %{customdata[0]}<br>%{z:,.2f} detections<extra>%{fullData.name}</extra>',
  })));
}

function renderResults(study) {
  const rows = comparisonRows(study);
  const retained = rows.filter((row) => row.selected === 'ratio').length;
  const improved = rows.filter((row) => row.difference < 0).length;
  const summary = document.getElementById('study-summary');
  const conclusion = document.createElement('p');
  conclusion.textContent = `Spatial aggregation has lower later-period error in ${improved} of ${rows.length} counties. Training-period validation retains the original count ratio in ${retained} of ${rows.length}. Method and location selection are separate evaluations.`;
  const limitation = document.createElement('p');
  const failed = rows.filter((row) => !row.passes).map((row) => row.county).join(', ');
  limitation.textContent = `The count ratio beats raw VIIRS and the seasonal baseline in ${rows.filter((row) => row.passes).length} counties.${failed ? ` ${failed} does not pass that comparison.` : ''} These are sensor-count comparisons, not a measure of how many fires occurred.`;
  summary.replaceChildren(conclusion, limitation);
  const table = document.createElement('table');
  table.className = 'metrics-table';
  const caption = table.createCaption();
  caption.textContent = 'Mean Absolute Error Against Terra · 2020–2025 · Detections Per Month · Lower Is Better';
  const head = table.createTHead().insertRow();
  for (const title of ['County', 'Raw VIIRS', 'Count Ratio', 'Spatial Aggregation', 'Spatial Vs Ratio']) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = title; head.append(cell);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    const county = document.createElement('th'); county.scope = 'row'; county.textContent = row.county.replace(' County', ''); tr.append(county);
    for (const value of [row.raw, row.ratio, row.spatial]) tr.insertCell().textContent = number.format(value);
    tr.insertCell().textContent = `${number.format(Math.abs(row.difference))} ${row.difference < 0 ? 'Lower' : row.difference > 0 ? 'Higher' : 'Unchanged'}`;
  }
  document.getElementById('study-results').replaceChildren(table);
}

export async function initializeComparison() {
  const chart = document.getElementById('cross-location-chart');
  const status = document.getElementById('comparison-status');
  const method = document.getElementById('study-method');
  const view = document.getElementById('study-view');
  method.disabled = true; view.disabled = true;
  try {
    const response = await fetch('data/harmonization-study.json');
    if (!response.ok) throw new Error(`Comparison data returned HTTP ${response.status}.`);
    const study = validateStudy(await response.json());
    renderResults(study);
    const render = async () => {
      const threeDimensional = view.value === '3d';
      const axis = { showline: true, linewidth: 1.2, linecolor: '#18212b', showgrid: false, zeroline: false, type: 'linear', rangemode: 'tozero', tickfont: { family: 'Arial', size: 11 } };
      const layout = { paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', font: { family: 'Arial', size: 12, color: '#18212b' },
        margin: { l: threeDimensional ? 0 : 64, r: 20, t: 58, b: threeDimensional ? 40 : 60 },
        legend: { orientation: 'h', x: 0, y: 1.06, xanchor: 'left', yanchor: 'bottom', borderwidth: .6, bordercolor: '#444444', bgcolor: '#ffffff', font: { size: 11 } },
        uirevision: view.value,
      };
      if (threeDimensional) {
        layout.scene = { bgcolor: '#ffffff', dragmode: 'orbit', aspectmode: 'manual', aspectratio: { x: 1.8, y: 1.2, z: .85 },
          camera: { eye: window.innerWidth < 600 ? { x: 2.4, y: -2.6, z: 1.7 } : { x: 1.55, y: -1.8, z: 1.25 }, center: { x: 0, y: 0, z: -.3 } },
          xaxis: { ...axis, title: { text: 'Month (UTC)' }, range: [0, 71], tickvals: [0, 12, 24, 36, 48, 60, 71], ticktext: ['2020', '2021', '2022', '2023', '2024', '2025', 'Dec 2025'], showbackground: false },
          yaxis: { ...axis, title: { text: 'County' }, range: [-.2, study.regions.length - .8], tickvals: study.regions.map((_region, index) => index), ticktext: study.regions.map((region) => region.county.replace(' County', '')), showbackground: false },
          zaxis: { ...axis, title: { text: 'Detections' }, showbackground: false },
        };
      } else {
        layout.xaxis = { ...axis, mirror: true, automargin: true, title: { text: 'Terra MODIS Detections' } };
        layout.yaxis = { ...axis, mirror: true, automargin: true, title: { text: method.value === 'raw' ? 'Observed VIIRS Detections' : 'VIIRS Terra-Equivalent Detections' } };
      }
      const caption = `${LABELS[method.value]} · 72 monthly pairs per county, 2020–2025. ${threeDimensional ? `Drag to rotate. Each row is a county; gray is Terra and ${method.value === 'raw' ? 'amber is unharmonized' : 'teal is harmonized'} VIIRS. Straight segments join monthly observations without smoothing.` : 'Each point is a month; the dashed line marks equal counts.'} Linear axes rescale with the method. Training uses 2013–2019; later years were previously inspected, so this is an exploratory comparison.`;
      document.getElementById('study-chart-caption').textContent = caption;
      chart.setAttribute('aria-label', caption);
      await Plotly.react(chart, comparisonTraces(study, method.value, view.value), layout, { responsive: true, displayModeBar: false, scrollZoom: false });
      for (const format of ['png', 'svg']) {
        const link = document.getElementById(`study-${format}`);
        link.href = `figures/harmonization_${method.value}_${view.value}.${format}`;
        link.title = threeDimensional ? 'Download This Method With A Fixed 3D Camera' : 'Download This Method In 2D';
      }
      document.getElementById('study-downloads').hidden = false;
    };
    const safelyRender = async () => {
      status.hidden = true;
      try { await render(); }
      catch (error) {
        if (view.value === '3d') {
          view.value = '2d';
          await render();
          status.textContent = 'The 3D view is unavailable in this browser. The same observations are shown in 2D.';
          status.hidden = false;
        } else { throw error; }
      }
    };
    const update = () => safelyRender().catch((error) => { status.textContent = `Chart unavailable: ${error.message}`; status.hidden = false; });
    method.onchange = update; view.onchange = update;
    method.disabled = false; view.disabled = false;
    await safelyRender();
  } catch (error) {
    status.textContent = `Comparison unavailable: ${error.message}`; status.hidden = false;
    status.classList.add('error');
  }
}
