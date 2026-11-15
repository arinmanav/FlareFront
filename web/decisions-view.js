import { hotspotContext } from './decision.js';

const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' });
const format = (value, unit = '') => Number.isFinite(value) ? `${number.format(value)}${unit}` : 'Unavailable';
const date = (value) => Number.isFinite(Date.parse(value)) ? `${dateFormat.format(new Date(value))} UTC` : 'Unavailable';
const studyBounds = [-118.8, 34.2, -118.2, 34.7];
const sources = [
  ['NWS API And Data Documentation', 'https://www.weather.gov/documentation/services-web-api'],
  ['Archived NDFD Forecasts', 'https://www.ncei.noaa.gov/products/weather-climate-models/national-digital-forecast-database'],
  ['Historical Hourly Weather Observations', 'https://www.ncei.noaa.gov/products/global-historical-climatology-network-hourly'],
  ['NASA EMIT Surface Reflectance · Version 001', 'https://doi.org/10.5067/EMIT/EMITL2ARFL.001'],
  ['NASA EMIT Reflectance And Quality-Mask Tutorial', 'https://nasa.github.io/LPDAAC-Data-Resources/external/Exploring_EMIT_L2A_Reflectance.html'],
  ['Gao (1996) · Vegetation Liquid Water And NDWI', 'https://doi.org/10.1016/S0034-4257(96)00067-3'],
];

export function evidenceAtCutoff(inputs, cutoff, lookbackDays, sensorStart = {}, spectralIndex = null) {
  const instant = Date.parse(cutoff);
  if (!Number.isFinite(instant) || !Number.isInteger(lookbackDays) || lookbackDays <= 0) throw new Error('Choose a valid UTC cutoff and lookback.');
  const forecast = inputs.weather?.forecast;
  const issued = Date.parse(forecast?.issued_at);
  const generated = Date.parse(forecast?.generated_at);
  const forecastAvailable = forecast?.status === 'available' && issued <= instant && generated <= instant &&
    forecast.periods.some((period) => Date.parse(period.start) <= instant && instant < Date.parse(period.end));
  const start = instant - lookbackDays * 86400000;
  const archiveCovered = start >= Date.parse('2001-01-01T00:00:00Z') && instant <= Date.parse('2026-01-01T00:00:00Z');
  const sensorAvailability = Object.fromEntries(['terra', 'aqua', 'snpp'].map((sensor) => {
    const first = Date.parse(`${sensorStart[sensor]}T00:00:00Z`);
    const uncertainAqua = sensor === 'aqua' && start < Date.parse('2002-08-01T00:00:00Z');
    const status = !archiveCovered || !Number.isFinite(first) || instant <= first ? 'unavailable' : start < first || uncertainAqua ? 'partial' : 'available';
    return [sensor, status];
  }));
  const scenes = (inputs.hyperspectral?.scenes ?? []).filter((scene) => Date.parse(scene.acquired_at) < instant);
  const sourceFilesPredateCutoff = spectralIndex?.input_files?.length === 2 && spectralIndex.input_files.every((file) => Date.parse(file.created_at) < instant);
  const spectralAvailable = spectralIndex?.schema_version === 1 && spectralIndex.status === 'measured' &&
    spectralIndex.quality?.valid_pixels > 0 && spectralIndex.quality.valid_pixels <= spectralIndex.quality.in_bbox &&
    Number.isFinite(spectralIndex.statistics?.median) && Date.parse(spectralIndex.acquired_at) < instant &&
    spectralIndex.bbox?.length === 4 && spectralIndex.bbox.every((value, index) => value === studyBounds[index]) &&
    scenes.some((scene) => scene.title === spectralIndex.scene_id) && Boolean(sourceFilesPredateCutoff);
  return { forecastAvailable, archiveCovered, sensorAvailability, scenes, spectralAvailable,
    spectralIndex: spectralAvailable ? spectralIndex : null, cutoff };
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(label, href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:') throw new Error('HTTPS required');
    const node = element('a', label);
    node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer';
    return node;
  } catch { return element('span', `${label} · Unavailable`); }
}

function readout(target, entries) {
  const list = element('dl');
  for (const [label, value] of entries) {
    const row = element('div'); row.append(element('dt', label), element('dd', value)); list.append(row);
  }
  $(target).replaceChildren(list);
}

function tableRow(values) {
  const row = element('tr');
  values.forEach((value, index) => {
    const cell = element(index === 0 ? 'th' : 'td', value);
    if (index === 0) cell.scope = 'row';
    row.append(cell);
  });
  return row;
}

function renderForecast(inputs, cutoff, evidence) {
  const { forecast = {}, observation = {}, location = {} } = inputs.weather ?? {};
  $('forecast-date').textContent = `Issued ${date(forecast.issued_at)} · Generated ${date(forecast.generated_at)}`;
  $('forecast-time-note').textContent = evidence.forecastAvailable
    ? `The saved forecast includes the cutoff and was issued and generated beforehand. Full prediction-window coverage still has to be checked for a placement scenario. Location: ${location.name ?? 'Santa Clarita'}.`
    : `This snapshot does not supply an as-issued forecast for the selected cutoff (${date(cutoff)}). It is shown separately as weather evidence, and is excluded from that decision comparison.`;
  $('forecast-body').replaceChildren(...(forecast.periods ?? []).slice(0, 24).map((period) => tableRow([
    date(period.start), format(period.temperature_c, ' °C'), format(period.relative_humidity_pct, '%'),
    period.wind_min_mps === period.wind_max_mps ? format(period.wind_min_mps, ' m/s') : `${format(period.wind_min_mps)}–${format(period.wind_max_mps)} m/s`,
    format(period.precipitation_probability_pct, '%'),
  ])));
  if (!forecast.periods?.length) $('forecast-body').append(tableRow(['No Forecast Periods Available', '-', '-', '-', '-']));
  readout('weather-observation', [
    ['Station', observation.station_name ? `${observation.station_name} (${observation.station_id})` : 'Unavailable'],
    ['Observed At', date(observation.timestamp)], ['Temperature', format(observation.temperature_c, ' °C')],
    ['Relative Humidity', format(observation.relative_humidity_pct, '%')], ['Wind / Gust', `${format(observation.wind_mps)} / ${format(observation.gust_mps)} m/s`],
  ]);
  const time = Date.parse(observation.timestamp);
  $('observation-time-note').textContent = `${!Number.isFinite(time) ? 'No observation timestamp is available.' : time >= Date.parse(cutoff)
    ? 'This observation is at or after the cutoff and is excluded from historical input.'
    : `This observation predates the cutoff by ${format((Date.parse(cutoff) - time) / 3600000)} hours; this alone does not establish suitability as a model input.`} ${observation.quality_note ?? ''} Missing measurements remain unavailable.`;
}

function renderSpectral(evidence) {
  const index = evidence.spectralIndex;
  const indices = index?.indices ?? [];
  const measured = indices.filter((entry) => entry.status === 'measured' && Number.isFinite(entry.statistics?.median));
  $('spectral-status').textContent = index ? `${measured.length || 1} Measured Indices · Limited Support` : 'No Eligible Measured Index';
  $('spectral-indices').replaceChildren();
  if (indices.length) {
    const table = element('table', undefined, 'metrics-table');
    const caption = element('caption', 'Measured EMIT Index Summaries · Dimensionless · Separate Quality Screening Per Index');
    const head = element('thead'); const headings = element('tr');
    for (const label of ['Index / Formula', 'Actual Bands (nm)', 'Retained Native Pixels', 'Median / Range']) {
      const cell = element('th', label); cell.scope = 'col'; headings.append(cell);
    }
    head.append(headings);
    const body = element('tbody');
    for (const entry of indices) {
      const row = element('tr'); const name = element('th'); name.scope = 'row';
      name.append(link(entry.id.toUpperCase(), entry.source_url), element('small', entry.formula));
      const bands = element('td', entry.bands.map((band) => format(band.wavelength_nm)).join(' / ') || 'Unavailable');
      bands.dataset.label = 'Actual Bands (nm)';
      const quality = entry.quality;
      const count = element('td', quality ? `${format(quality.valid_pixels)} / ${format(quality.in_bbox)} (${(100 * quality.valid_pixels / quality.in_bbox).toFixed(2)}%)` : 'Unavailable');
      count.dataset.label = 'Retained Native Pixels';
      const values = element('td', entry.status === 'measured' ? entry.statistics.median.toFixed(4) : 'Unavailable');
      values.dataset.label = 'Median / Range';
      if (entry.status === 'measured') values.append(element('small', `${entry.statistics.min.toFixed(4)} to ${entry.statistics.max.toFixed(4)}`));
      else values.append(element('small', entry.reason ?? 'No pixels pass the quality checks.'));
      row.append(name, bands, count, values); body.append(row);
    }
    table.append(caption, head, body); $('spectral-indices').append(table);
    $('spectral-indices').append(element('p', 'R denotes surface reflectance at the nominal wavelength in the formula. Actual EMIT bands approximate those wavelengths: the engineering tolerance is ±10 nm for Gao NDWI and ±5 nm for the other indices. Band widths and exact centers are retained in the downloadable summary; these approximations have not been independently validated for prediction.', 'caption'));
  }
  $('spectral-readout').replaceChildren();
  if (index) {
    const retained = (100 * index.quality.valid_pixels / index.quality.in_bbox).toFixed(2);
    readout('spectral-readout', [
      ['Acquired At', date(index.acquired_at)],
      ['Age At Cutoff', `${format((Date.parse(evidence.cutoff) - Date.parse(index.acquired_at)) / 86400000)} days`],
      ['Actual Band Centers', index.bands.map((band) => format(band.wavelength_nm, ' nm')).join(' / ')],
      ['Retained Native Pixels', `${format(index.quality.valid_pixels)} / ${format(index.quality.in_bbox)} (${retained}%)`],
      ['Median Spectral NDWI', index.statistics.median.toFixed(4)],
      ['Retained-Pixel Range', `${index.statistics.min.toFixed(4)} to ${index.statistics.max.toFixed(4)}`],
    ]);
    $('spectral-availability').textContent = `Only ${retained}% of sampled native pixels in the study envelope pass the aggregate and target-band quality checks. These screened nonwater surfaces have not been classified as vegetation and do not establish regional fuel condition. Statistics are not area-weighted; prediction improvement has not been evaluated. Acquisition and product creation precede the cutoff, but historical public availability has not been verified.`;
    const download = element('p'); const file = element('a', 'Download Index Summary And Provenance');
    file.href = 'data/emit-ndwi.json'; file.download = 'flarefront-emit-ndwi.json'; download.append(file); $('spectral-readout').append(download);
  } else {
    $('spectral-availability').textContent = `${evidence.scenes.length} candidate scene${evidence.scenes.length === 1 ? '' : 's'} intersect the search envelope before the cutoff. No processed index with matching scene, study area and earlier product timestamps is available for this cutoff. Catalog footprints alone do not establish valid observations.`;
  }
  const scenes = evidence.scenes.map((scene) => {
    const item = element('article', undefined, 'scene');
    item.append(element('h3', date(scene.acquired_at)), element('p', scene.title, 'scene-id'));
    item.append(element('p', index?.scene_id === scene.title ? 'Reflectance And Quality Mask Processed' : 'Catalog Metadata Only'));
    const links = element('p');
    links.append(link('Catalog', scene.catalog_url), ' · ', link('Reflectance', scene.reflectance_url), ' · ', link('Quality Mask', scene.mask_url));
    item.append(links); return item;
  });
  $('spectral-scenes').replaceChildren(...scenes);
  if (!scenes.length) $('spectral-scenes').append(element('p', 'No candidate scenes in the saved catalog precede this cutoff.'));
}

function renderMatrix(evidence, contextAvailable) {
  const weather = evidence.forecastAvailable ? 'Timestamp Eligible' : 'Unavailable At Cutoff';
  const history = contextAvailable ? 'Retrospective Context' : 'Unavailable';
  $('decision-matrix-body').replaceChildren(
    tableRow(['Weather Only', weather, 'Not Included', 'Not Included', 'Model Not Fitted']),
    tableRow(['Weather + Harmonized History', weather, history, 'Not Included', 'Not Evaluated']),
    tableRow(['Weather + History + Hyperspectral', weather, history, evidence.spectralAvailable ? `${evidence.spectralIndex.indices?.filter((entry) => entry.status === 'measured').length || 1} Measured · Limited Support` : 'No Eligible Measured Index', 'Not Evaluated']),
  );
  const labels = [...document.querySelectorAll('.decision-matrix thead th')].map((cell) => cell.textContent);
  for (const row of $('decision-matrix-body').rows) [...row.cells].forEach((cell, index) => { if (index) cell.dataset.label = labels[index]; });
}

export async function initializeDecisions(dashboard, compactPoints) {
  try {
    const [response, spectralIndex] = await Promise.all([fetch('data/decision-inputs.json'),
      fetch('data/emit-ndwi.json').then((result) => result.ok ? result.json() : null).catch(() => null)]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const inputs = await response.json();
    if (inputs.schema_version !== 1 || !inputs.weather || !inputs.hyperspectral) throw new Error('Invalid decision input schema');
    const points = compactPoints?.rows.map((row) => Object.fromEntries(compactPoints.columns.map((name, index) => [name, row[index]]))) ?? [];
    function render() {
      try {
        const value = $('decision-cutoff').value;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a valid cutoff, in UTC.');
        const cutoff = new Date(`${value}:00Z`).toISOString();
        const lookbackDays = Number($('decision-lookback').value);
        const evidence = evidenceAtCutoff(inputs, cutoff, lookbackDays, dashboard.meta.sensor_start, spectralIndex);
        const context = hotspotContext(points, { cutoff, bbox: studyBounds, lookbackDays, alpha: dashboard.meta.alpha, trainingEnd: `${dashboard.validation.training.end_year}-12-31T23:59:59Z` });
        const contextAvailable = evidence.sensorAvailability.snpp === 'available' && compactPoints && context.status !== 'blocked' && context.calibratedSnpp !== null;
        if (!evidence.archiveCovered || !compactPoints) $('hotspot-context').replaceChildren(element('p', 'The complete lookback is not covered by the bundled 2001–2025 point archive. No count is reported.'));
        else if (context.status === 'blocked') $('hotspot-context').replaceChildren(element('p', context.reasons.join(' ')));
        else {
          const counts = ['terra', 'aqua', 'snpp'].map((sensor) => evidence.sensorAvailability[sensor] === 'unavailable' ? 'Unavailable' : `${context.sourceCounts[sensor]}${evidence.sensorAvailability[sensor] === 'partial' ? ' (Partial)' : ''}`);
          readout('hotspot-context', [['Window Start', date(context.lookbackStart)], ['Terra / Aqua / Suomi-NPP', counts.join(' / ')], ['Scaled Suomi-NPP', format(contextAvailable ? context.calibratedSnpp : null, ' Terra-equivalent detections')]]);
          if (Object.values(evidence.sensorAvailability).includes('partial')) $('hotspot-context').append(element('p', 'Partial means the lookback crosses the sensor start. The exact first day for Aqua in July 2002 is unresolved.', 'caption'));
          $('hotspot-context').append(element('p', context.calibratedSnpp === null ? 'The calibration training period is not wholly before this cutoff; no adjusted value is shown.' : 'The county coefficient is applied to this study envelope for exploration. Its performance at this smaller spatial scale has not been validated.', 'caption'));
        }
        renderMatrix(evidence, Boolean(contextAvailable)); renderForecast(inputs, cutoff, evidence); renderSpectral(evidence);
        $('decision-error').hidden = true;
      } catch (error) { $('decision-error').textContent = error.message; $('decision-error').hidden = false; }
    }
    $('decision-cutoff').addEventListener('change', render);
    $('decision-lookback').addEventListener('change', render);
    $('decision-sources').replaceChildren(...sources.map(([label, url]) => { const item = element('li'); item.append(link(label, url)); return item; }));
    $('decision-snapshot-time').textContent = `Public-source retrieval batch completed ${date(inputs.retrieved_at)}. Acquisition, observation, forecast issue and forecast validity times are retained separately.`;
    render(); $('decision-load-status').hidden = true; $('decision-content').hidden = false;
  } catch (error) {
    console.error('Decision inputs unavailable:', error);
    $('decision-load-status').textContent = 'Decision inputs could not be loaded. The historical calendar remains available.';
    $('decision-load-status').classList.add('error');
  }
}
