import { monthKey, MONTH_NAMES } from './calendar.js';

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const count = (value) => Number.isFinite(value) && value >= 0;

export function monthlyHarmonization(data, row) {
  const terra = count(row?.terra) ? row.terra : null;
  const viirs = count(row?.snpp) ? row.snpp : null;
  const alpha = Number.isFinite(data.meta.alpha) && data.meta.alpha > 0 ? data.meta.alpha : null;
  const adjusted = viirs !== null && alpha !== null ? alpha * viirs : null;
  return { terra, viirs, alpha, adjusted,
    rawDifference: terra !== null && viirs !== null ? Math.abs(viirs - terra) : null,
    adjustedDifference: terra !== null && adjusted !== null ? Math.abs(adjusted - terra) : null,
    calendarSource: row?.year < data.meta.switch_year ? 'terra' : 'adjusted' };
}

export function renderHarmonizationExample(data, row) {
  const element = (id) => document.getElementById(id);
  const result = monthlyHarmonization(data, row);
  const format = (value) => value === null ? 'Unavailable' : number.format(value);
  element('example-month').textContent = row ? `${MONTH_NAMES[row.month - 1]} ${row.year} · UTC` : 'Month Unavailable';
  element('example-terra').textContent = format(result.terra);
  element('example-viirs').textContent = format(result.viirs);
  element('example-factor').textContent = result.alpha === null ? 'Unavailable' : result.alpha.toFixed(6);
  element('example-adjusted').textContent = format(result.adjusted);
  element('example-difference').textContent = result.rawDifference === null || result.adjustedDifference === null
    ? 'This month cannot be compared because a sensor count or calibration factor is unavailable.'
    : `Absolute difference from Terra: ${format(result.rawDifference)} before → ${format(result.adjustedDifference)} after. ${result.adjustedDifference < result.rawDifference ? 'Closer agreement' : result.adjustedDifference > result.rawDifference ? 'Larger difference' : 'Unchanged agreement'} for this month.`;
  element('example-source').textContent = result.calendarSource === 'terra'
    ? 'Before 2013, the main calendar uses observed Terra counts. Any adjusted VIIRS value here is a comparison only.'
    : 'The main calendar uses the adjusted VIIRS value. Map points remain the original observations; hotspots are not individual fires.';
  const { validation } = data;
  element('example-validation').textContent = result.alpha === null ? 'County Calibration Unavailable'
    : validation.passed ? 'County Calibration Passed The Held-Out Test' : 'County Calibration Did Not Pass · Experimental';
  element('example-validation').classList.toggle('passed', validation.passed === true);
}

export function harmonizationComparison(data) {
  const { validation, meta, months } = data;
  if (meta.alpha === null && validation.status === 'unestimable' && validation.passed === false) {
    return { rows: [], mae: { raw: null, adjusted: null, seasonal: null }, passed: false, reduction: null, status: 'unestimable' };
  }
  if (!Number.isFinite(meta.alpha) || meta.alpha <= 0) throw new Error('Harmonization requires a positive calibration coefficient.');
  const excluded = new Set(validation.test.excluded_months ?? []);
  const rows = months.filter((row) => row.year >= validation.test.start_year && row.year <= validation.test.end_year)
    .filter((row) => !excluded.has(monthKey(row.year, row.month)) && count(row.terra) && count(row.snpp))
    .sort((a, b) => monthKey(a.year, a.month).localeCompare(monthKey(b.year, b.month)));
  if (!rows.length || rows.length !== validation.test.months) throw new Error('Held-out monthly comparisons do not match the validation record.');
  const totals = { raw: 0, adjusted: 0, seasonal: 0 };
  for (const row of rows) {
    const seasonal = validation.seasonal_training_medians[String(row.month)];
    if (!count(seasonal)) throw new Error('A training seasonal median is unavailable.');
    totals.raw += Math.abs(row.snpp - row.terra);
    totals.adjusted += Math.abs(meta.alpha * row.snpp - row.terra);
    totals.seasonal += Math.abs(seasonal - row.terra);
  }
  const mae = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / rows.length]));
  return { rows, mae, passed: mae.adjusted < mae.raw && mae.adjusted < mae.seasonal,
    reduction: mae.raw > 0 ? (mae.raw - mae.adjusted) / mae.raw * 100 : null };
}

function renderMetrics(target, mae) {
  const table = document.createElement('table');
  table.className = 'metrics-table';
  const head = document.createElement('thead');
  const headings = document.createElement('tr');
  for (const label of ['Monthly MAE Against Terra', 'Detections']) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; headings.append(cell);
  }
  head.append(headings); table.append(head);
  const body = document.createElement('tbody');
  for (const [label, value] of [['Adjusted Suomi-NPP', mae.adjusted], ['Unscaled Suomi-NPP', mae.raw], ['Training Seasonal Median', mae.seasonal]]) {
    const row = document.createElement('tr');
    for (const text of [label, value === null ? 'Unavailable' : number.format(value)]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
    body.append(row);
  }
  table.append(body); target.replaceChildren(table);
}

export async function initializeHarmonization(data) {
  const element = (id) => document.getElementById(id);
  const { rows, mae, passed, reduction, status: comparisonStatus } = harmonizationComparison(data);
  const { training, test } = data.validation;
  const mode = element('comparison-mode');
  mode.onchange = null;
  mode.disabled = comparisonStatus === 'unestimable';
  element('alpha-equation').textContent = comparisonStatus === 'unestimable' ? 'α unavailable' : `α = ${data.meta.alpha.toFixed(6)}`;
  element('alpha-totals').textContent = `${number.format(training.terra_total)} Terra ÷ ${number.format(training.snpp_total)} Suomi-NPP detections · ${training.start_year}–${training.end_year}`;
  const status = element('harmonization-status');
  if (comparisonStatus === 'unestimable') {
    status.textContent = 'County Calibration Unestimable';
    status.classList.remove('passed');
    renderMetrics(element('harmonization-metrics'), mae);
    element('harmonization-improvement').textContent = data.validation.reason ?? 'The county training overlap cannot support a scale factor.';
    element('harmonization-caption').textContent = 'Adjusted comparison withheld. Raw sensor records remain available in the calendar and annual comparison.';
    element('harmonization-year-note').textContent = 'No adjusted comparison or pass is reported for this county.';
    Plotly.purge(element('harmonization-chart'));
    return;
  }
  status.textContent = passed ? 'Lower Held-Out MAE Than Both Baselines' : 'Held-Out Comparison Did Not Pass';
  status.classList.toggle('passed', passed);
  renderMetrics(element('harmonization-metrics'), mae);
  element('harmonization-improvement').textContent = reduction === null
    ? 'Unscaled MAE is zero; a percentage reduction is undefined. Agreement with Terra does not establish forecasting skill.'
    : `Adjusted monthly MAE is ${number.format(Math.abs(reduction))}% ${reduction >= 0 ? 'lower' : 'higher'} than unscaled Suomi-NPP on the same ${rows.length} held-out months. Agreement with Terra does not establish forecasting skill.`;
  const seasonalYears = (data.validation.by_year ?? []).filter((row) => row.seasonal < row.adjusted).map((row) => row.year);
  element('harmonization-year-note').textContent = `${seasonalYears.length ? `The seasonal baseline has lower MAE in ${seasonalYears.join(', ')} individually. ` : ''}Agreement with Terra does not establish forecasting skill.`;
  const eligible = new Set(rows.map((row) => monthKey(row.year, row.month)));
  const chartRows = data.months.filter((row) => row.year >= test.start_year && row.year <= test.end_year)
    .sort((a, b) => monthKey(a.year, a.month).localeCompare(monthKey(b.year, b.month)));
  const render = () => {
    const adjusted = mode.value === 'adjusted';
    const dates = chartRows.map((row) => `${monthKey(row.year, row.month)}-01`);
    const values = (source) => chartRows.map((row) => eligible.has(monthKey(row.year, row.month)) ? source(row) : null);
    const axis = { showline: true, mirror: true, linewidth: 1.2, linecolor: '#20251f', showgrid: false, zeroline: false, ticks: 'outside', ticklen: 4, fixedrange: true, automargin: true, tickfont: { family: 'Arial', size: 12 } };
    const yTitle = adjusted ? 'Detections / Terra-Equivalent Detections' : 'Observed Hotspot Detections';
    element('harmonization-caption').textContent = `${test.start_year}–${test.end_year} · ${rows.length} held-out monthly pairs. Terra is observed counts; Suomi-NPP is ${adjusted ? 'α × observed counts (Terra-equivalent detections)' : 'observed counts'}. The linear y-axis rescales when the mode changes. No logarithmic transform is applied. These are hotspot detections, not incident counts.`;
    element('harmonization-chart').setAttribute('aria-label', `${adjusted ? 'After' : 'Before'} harmonization: monthly Terra and Suomi-NPP detections, ${test.start_year} through ${test.end_year}. Linear y-axis rescales with mode.`);
    return Plotly.react(element('harmonization-chart'), [
      { type: 'scatter', mode: 'lines', name: 'Terra MODIS (observed)', x: dates, y: values((row) => row.terra), line: { color: '#426c99', width: 2 }, connectgaps: false, hovertemplate: '%{x|%b %Y}<br>%{y:,.0f} observed detections<extra>%{fullData.name}</extra>' },
      { type: 'scatter', mode: 'lines', name: adjusted ? 'α × Suomi-NPP VIIRS' : 'Suomi-NPP VIIRS (observed)', x: dates, y: values((row) => adjusted ? data.meta.alpha * row.snpp : row.snpp), line: { color: '#df6b25', width: 2 }, connectgaps: false, hovertemplate: `%{x|%b %Y}<br>%{y:,.2f} ${adjusted ? 'Terra-equivalent' : 'observed'} detections<extra>%{fullData.name}</extra>` },
    ], {
      paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', font: { family: 'Arial', size: 12, color: '#20251f' },
      margin: { l: 68, r: 24, t: 75, b: 58 }, showlegend: true, hovermode: 'closest',
      legend: { orientation: 'h', x: 0, y: 1.05, xanchor: 'left', yanchor: 'bottom', bgcolor: '#ffffff', bordercolor: '#444444', borderwidth: .6, font: { family: 'Arial', size: 10 }, traceorder: 'normal' },
      xaxis: { ...axis, type: 'date', title: { text: 'Month (UTC)', font: { size: 14 } }, tickformat: '%Y', dtick: 'M12' },
      yaxis: { ...axis, type: 'linear', autorange: true, rangemode: 'tozero', title: { text: yTitle, font: { size: 14 } } },
    }, { responsive: true, displayModeBar: false, scrollZoom: false, locale: 'en-US' });
  };
  mode.onchange = () => {
    render().catch((error) => { status.textContent = `Comparison chart unavailable: ${error.message}`; status.classList.remove('passed'); });
  };
  await render();
}
