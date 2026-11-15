import { MONTH_NAMES, SERIES_NAMES } from './calendar.js';
import { longTermPatterns, compareYears } from './patterns.js';
import { historyNumber } from './history-view.js';
import { downloadCsv, exportChart } from './exports.js';

const $ = (id) => document.getElementById(id);
const coefficient = (value) => value === null ? 'Unavailable' : value.toFixed(2);

function valuesTable(headers, rows) {
  const table = document.createElement('table'), head = table.createTHead().insertRow(), body = table.createTBody();
  const caption = table.createCaption(); caption.textContent = 'The Values Behind This Chart';
  for (const label of headers) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; head.append(cell); }
  for (const row of rows) {
    const tr = body.insertRow();
    row.forEach((value, index) => {
      const cell = document.createElement(index ? 'td' : 'th');
      if (!index) cell.scope = 'row';
      cell.textContent = typeof value === 'number' ? historyNumber(value) : value ?? 'Unavailable';
      tr.append(cell);
    });
  }
  $('pattern-values').replaceChildren(table);
}

function selectYears(select, years, fallback) {
  const previous = Number(select.value);
  select.replaceChildren(...years.map(({ year }) => {
    const option = document.createElement('option'); option.value = year; option.textContent = year; return option;
  }));
  select.value = years.some(({ year }) => year === previous) ? previous : fallback ?? '';
}

export function createPatternsView(getContext, chartLayout) {
  let dataset = null, analysis = null, exportRows = [], exportHeaders = [];
  async function render() {
    const context = getContext();
    if (!context.data) return;
    const sensor = $('pattern-sensor').value, mode = $('pattern-mode').value;
    if (dataset !== context.data || analysis?.sensor !== sensor) {
      dataset = context.data;
      analysis = longTermPatterns(dataset.months, sensor);
      selectYears($('pattern-first-year'), analysis.years, analysis.years.at(-2)?.year);
      selectYears($('pattern-second-year'), analysis.years, analysis.years.at(-1)?.year);
    }
    const years = analysis.years, first = years.find((row) => row.year === Number($('pattern-first-year').value)), second = years.find((row) => row.year === Number($('pattern-second-year').value));
    $('pattern-year-controls').hidden = mode !== 'similarity';
    $('pattern-scope').textContent = `${context.scope} · ${SERIES_NAMES[sensor]} · ${years.length} complete calendar years${years.length ? `, ${years[0].year}–${years.at(-1).year}` : ''}. Uses the full archive, independently of the calendar’s date filters and series.`;
    const traces = [], addTrace = (name, x, y, alternate = false) => traces.push({ type: 'scatter', mode: 'lines+markers', name, x, y, connectgaps: false, line: { color: alternate ? '#b95320' : '#426c99', dash: alternate ? 'dash' : 'solid', width: 2 }, marker: { size: 5, symbol: alternate ? 'square' : 'circle' }, hovertemplate: '%{x}<br>%{y:,.2f} detections<extra>%{fullData.name}</extra>' });
    const layout = chartLayout({ showlegend: true, margin: { l: 64, r: 24, t: 76, b: 54 }, legend: { orientation: 'h', x: 0, y: 1.05, xanchor: 'left', yanchor: 'bottom', bgcolor: '#fff', bordercolor: '#444444', borderwidth: .6, font: { size: 12 } } });
    layout.yaxis.rangemode = 'tozero';
    layout.yaxis.title = { text: 'Reported Detections', font: { size: 14 } };
    layout.xaxis.title = { text: mode === 'annual' ? 'Year' : 'Month (UTC)', font: { size: 14 } };
    layout.xaxis.tickvals = mode === 'annual' ? undefined : MONTH_NAMES.map((name) => name.slice(0, 3));
    layout.xaxis.type = mode === 'annual' ? 'linear' : 'category';
    let title, description, summary;
    if (mode === 'seasonal') {
      title = 'Average Seasonal Cycle';
      description = 'Each point compares the same month across complete years. The mean retains extreme seasons; the median shows the middle year. Lines connect monthly summaries without smoothing.';
      addTrace('Monthly mean', layout.xaxis.tickvals, analysis.seasonal.map((row) => row.mean));
      addTrace('Monthly median', layout.xaxis.tickvals, analysis.seasonal.map((row) => row.median), true);
      const maximum = Math.max(0, ...analysis.seasonal.map((row) => row.mean ?? 0));
      const peak = analysis.seasonal.filter((row) => row.mean === maximum).map((row) => MONTH_NAMES[row.month - 1]);
      summary = maximum > 0 ? `Highest monthly mean: ${peak.join(', ')} (${historyNumber(maximum)} detections). Across all eligible year pairs, median seasonal rank correlation is ${coefficient(analysis.medianSimilarity)} (${analysis.validPairs} pairs).` : 'No positive detections in the eligible years; a recurring peak cannot be identified.';
      exportHeaders = ['month', 'monthly_mean', 'monthly_median', 'complete_years'];
      exportRows = analysis.seasonal.map((row) => [MONTH_NAMES[row.month - 1], row.mean, row.median, row.years]);
    } else if (mode === 'annual') {
      title = 'Annual Counts And Five-Year Average';
      description = 'The dashed line averages the current year and four preceding years. It requires five consecutive complete years, overlaps adjacent windows, and can lag recent changes.';
      const byYear = new Map(analysis.annual.map((row) => [row.year, row]));
      const span = years.length ? Array.from({ length: years.at(-1).year - years[0].year + 1 }, (_, index) => years[0].year + index) : [];
      addTrace('Annual total', span, span.map((year) => byYear.get(year)?.total ?? null));
      addTrace('Trailing five-year mean', span, span.map((year) => byYear.get(year)?.fiveYearMean ?? null), true);
      layout.xaxis.tickformat = 'd'; layout.xaxis.dtick = span.length > 10 ? 5 : 1;
      const last = analysis.annual.at(-1);
      summary = last?.fiveYearMean !== null && last ? `${last.year - 4}–${last.year}: ${historyNumber(last.fiveYearMean)} detections per year on average. These are descriptive counts, without a fitted trend or significance test.` : 'No five consecutive complete years are available for an average.';
      exportHeaders = ['year', 'annual_total', 'trailing_five_year_mean'];
      exportRows = analysis.annual.map((row) => [String(row.year), row.total, row.fiveYearMean]);
    } else {
      title = 'Year-To-Year Seasonal Similarity';
      description = 'Compare twelve matched months. Spearman ρ compares the order of active months; Pearson r compares count co-variation. A high correlation can coexist with very different annual totals.';
      const result = compareYears(first, second);
      if (first) addTrace(String(first.year), layout.xaxis.tickvals, first.values);
      if (second) addTrace(String(second.year), layout.xaxis.tickvals, second.values, true);
      summary = first && second && first.year !== second.year ? `Spearman ρ: ${coefficient(result.spearman)} · Pearson r: ${coefficient(result.pearson)} · 12 matched months. Annual totals: ${historyNumber(first.total)} in ${first.year}; ${historyNumber(second.total)} in ${second.year}.` : 'Choose two different complete years to compare seasonal patterns.';
      exportHeaders = ['month', `detections_${first?.year ?? 'first'}`, `detections_${second?.year ?? 'second'}`, 'spearman_rho', 'pearson_r'];
      exportRows = MONTH_NAMES.map((name, index) => [name, first?.values[index] ?? null, second?.values[index] ?? null, result.spearman, result.pearson]);
    }
    $('pattern-title').textContent = title;
    $('pattern-description').textContent = description;
    $('pattern-summary').textContent = years.length ? summary : 'No complete years are available for this sensor and area.';
    $('pattern-chart').setAttribute('aria-label', `${title}. ${description} Values are available in the table below.`);
    valuesTable(exportHeaders.map((key) => key.replaceAll('_', ' ').replace(/\b[a-z]/g, (letter) => letter.toUpperCase())), exportRows);
    $('pattern-status').textContent = '';
    await Plotly.react($('pattern-chart'), traces, layout, { responsive: true, displayModeBar: false, scrollZoom: false });
  }

  const run = () => render().catch((error) => { $('pattern-status').textContent = `Patterns could not be displayed: ${error.message}`; });
  for (const id of ['pattern-sensor', 'pattern-mode', 'pattern-first-year', 'pattern-second-year']) $(id).addEventListener('change', run);
  $('download-patterns').addEventListener('click', () => {
    const context = getContext(); if (!analysis || !context.data) return;
    downloadCsv(`${context.filename}-patterns-${analysis.sensor}-${$('pattern-mode').value}.csv`, ['sensor', 'included_years', ...context.headers, ...exportHeaders], exportRows.map((row) => [analysis.sensor, analysis.years.map((year) => year.year).join(';'), ...context.fields, ...row]));
    $('pattern-status').textContent = 'Chart values downloaded.';
  });
  $('download-correlations').addEventListener('click', () => {
    const context = getContext(); if (!analysis || !context.data) return;
    downloadCsv(`${context.filename}-year-correlations-${analysis.sensor}.csv`, ['sensor', ...context.headers, 'first_year', 'second_year', 'matched_months', 'pearson_r', 'spearman_rho'], analysis.pairs.map((row) => [analysis.sensor, ...context.fields, row.first, row.second, 12, row.pearson, row.spearman]));
    $('pattern-status').textContent = 'All year-pair correlations downloaded. Empty coefficients are undefined.';
  });
  for (const button of document.querySelectorAll('[data-pattern-format]')) button.addEventListener('click', async () => {
    const context = getContext(); if (!analysis || !context.data) return;
    button.disabled = true;
    const selection = $('pattern-mode').value === 'similarity' ? `-${$('pattern-first-year').value}-${$('pattern-second-year').value}` : '';
    try {
      await exportChart($('pattern-chart'), button.dataset.patternFormat, { filename: `${context.filename}-${analysis.sensor}-${$('pattern-mode').value}${selection}`, widthInches: 7.16, heightInches: 3.58 });
      $('pattern-status').textContent = 'Figure downloaded.';
    } catch (error) { $('pattern-status').textContent = `Figure export failed: ${error.message}`; }
    finally { button.disabled = false; }
  });
  return { render };
}
