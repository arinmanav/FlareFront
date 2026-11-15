const DAY_MS = 86_400_000;
const ARCHIVE_CAVEAT = 'Archive availability is not a historical feed-availability record. Detection counts do not establish sensor coverage, fire incidence, or a forecast.';
const RANKING_CAVEATS = [
  'Unvalidated research scores; not operational recommendations.',
  'Coverage geometry only: engine capacity benefit is not modeled.',
  'Expected incidents are supplied by the external model; this helper does not predict incidents.',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function utcTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!parts) return null;
  const instant = new Date(value);
  const values = [instant.getUTCFullYear(), instant.getUTCMonth() + 1, instant.getUTCDate(), instant.getUTCHours(), instant.getUTCMinutes(), instant.getUTCSeconds()];
  if (!values.every((part, index) => part === Number(parts[index + 1]))) return null;
  return instant.getTime();
}

function acquisitionTimestamp(point) {
  if (!isRecord(point) || typeof point.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(point.date)) return null;
  let time = point.time;
  if (Number.isInteger(time) && time >= 0 && time <= 2359) time = String(time).padStart(4, '0');
  if (typeof time !== 'string') return null;
  if (/^\d{4}$/.test(time)) time = `${time.slice(0, 2)}:${time.slice(2)}:00`;
  else if (/^\d{2}:\d{2}$/.test(time)) time += ':00';
  return utcTimestamp(`${point.date}T${time}Z`);
}

function sensorId(value) {
  if (typeof value !== 'string') return null;
  const sensor = value.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (sensor === 'terra' || sensor === 'aqua') return sensor;
  return sensor === 'snpp' || sensor === 'suominpp' ? 'snpp' : null;
}

function bboxBounds(bbox) {
  const bounds = Array.isArray(bbox) && bbox.length === 4
    ? bbox
    : isRecord(bbox) ? [bbox.west, bbox.south, bbox.east, bbox.north] : [];
  if (bounds.length !== 4 || !bounds.every(Number.isFinite)) return null;
  const [west, south, east, north] = bounds;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west > east || south > north) return null;
  return bounds;
}

/** Summarize archived acquisitions in [cutoff - lookbackDays, cutoff), without combining sensors. */
export function hotspotContext(points, options = {}) {
  const settings = isRecord(options) ? options : {};
  const { cutoff, bbox, lookbackDays = 7, alpha, trainingEnd } = settings;
  const cutoffMs = utcTimestamp(cutoff);
  const bounds = bboxBounds(bbox);
  const reasons = [];
  if (cutoffMs === null) reasons.push('cutoff must be a valid ISO UTC timestamp ending in Z.');
  if (!bounds) reasons.push('bbox must contain valid west, south, east, north bounds without crossing the antimeridian.');
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0 || !Number.isFinite(new Date(cutoffMs - lookbackDays * DAY_MS).getTime())) reasons.push('lookbackDays must be positive and keep the lookback start within the supported timestamp range.');
  if (!Array.isArray(points)) reasons.push('points must be an array of acquisition records.');
  if (reasons.length) return { status: 'blocked', reasons, sourceCounts: null, calibratedSnpp: null, caveats: [ARCHIVE_CAVEAT] };

  const startMs = cutoffMs - lookbackDays * DAY_MS;
  const [west, south, east, north] = bounds;
  const sourceCounts = { terra: 0, aqua: 0, snpp: 0 };
  let excludedInvalidRows = 0;
  for (const point of points) {
    const timestamp = acquisitionTimestamp(point);
    const sensor = sensorId(point?.sensor);
    if (timestamp === null || !sensor || !Number.isFinite(point?.lat) || !Number.isFinite(point?.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
      excludedInvalidRows += 1;
      continue;
    }
    if (timestamp >= startMs && timestamp < cutoffMs && point.lon >= west && point.lon <= east && point.lat >= south && point.lat <= north) sourceCounts[sensor] += 1;
  }
  const trainingMs = utcTimestamp(trainingEnd);
  const calibratedSnpp = Number.isFinite(alpha) && alpha > 0 && trainingMs !== null && trainingMs < cutoffMs && Number.isFinite(alpha * sourceCounts.snpp)
    ? alpha * sourceCounts.snpp
    : null;
  const caveats = [ARCHIVE_CAVEAT];
  if (calibratedSnpp === null) caveats.push('SNPP calibration is unavailable: a finite positive alpha and trainingEnd strictly before cutoff are required.');
  return {
    status: 'context-only',
    cutoff: new Date(cutoffMs).toISOString(),
    lookbackStart: new Date(startMs).toISOString(),
    sourceCounts,
    calibratedSnpp,
    excludedInvalidRows,
    caveats,
  };
}

/** Return the spectral NDWI ratio; this value is not fuel moisture or fire probability. */
export function spectralNdwi(r860, r1240, { masked = false } = {}) {
  if (masked || !Number.isFinite(r860) || !Number.isFinite(r1240) || r860 < 0 || r1240 < 0) return null;
  const denominator = r860 + r1240;
  if (denominator === 0) return null;
  if (Number.isFinite(denominator)) return (r860 - r1240) / denominator;
  // Normalize finite inputs to preserve the ratio when their sum overflows.
  const scale = Math.max(r860, r1240);
  return (r860 / scale - r1240 / scale) / (r860 / scale + r1240 / scale);
}

function blocked(reasons) {
  return { status: 'blocked', reasons, rows: [], preferredCandidateId: null, caveats: [...RANKING_CAVEATS] };
}

/** Rank externally modeled expected incidents covered by fixed-plus-movable travel reachability. */
export function rankPlacements(input) {
  if (!isRecord(input)) return blocked(['input must be an object.']);
  const { decisionAt, forecastIssuedAt, forecastValidStart, forecastValidEnd, predictionEnd, trainingEnd, modelId, stations, fixedStationId, baselineStationId, cells, travelMinutes, thresholdMinutes } = input;
  const reasons = [];
  const decisionMs = utcTimestamp(decisionAt);
  const forecastMs = utcTimestamp(forecastIssuedAt);
  const forecastStartMs = utcTimestamp(forecastValidStart);
  const forecastEndMs = utcTimestamp(forecastValidEnd);
  const predictionEndMs = utcTimestamp(predictionEnd);
  const trainingMs = utcTimestamp(trainingEnd);
  if (decisionMs === null) reasons.push('decisionAt must be a valid ISO UTC timestamp ending in Z.');
  if (forecastMs === null) reasons.push('forecastIssuedAt is required and must be a valid ISO UTC timestamp ending in Z.');
  else if (decisionMs !== null && forecastMs > decisionMs) reasons.push('forecastIssuedAt must not be after decisionAt.');
  if (forecastStartMs === null) reasons.push('forecastValidStart is required and must be a valid ISO UTC timestamp ending in Z.');
  else if (decisionMs !== null && forecastStartMs > decisionMs) reasons.push('forecastValidStart must be at or before decisionAt.');
  if (forecastEndMs === null) reasons.push('forecastValidEnd is required and must be a valid ISO UTC timestamp ending in Z.');
  if (predictionEndMs === null) reasons.push('predictionEnd is required and must be a valid ISO UTC timestamp ending in Z.');
  else {
    if (decisionMs !== null && predictionEndMs <= decisionMs) reasons.push('predictionEnd must be strictly after decisionAt.');
    if (forecastEndMs !== null && forecastEndMs < predictionEndMs) reasons.push('forecastValidEnd must cover the complete horizon through predictionEnd.');
  }
  if (trainingMs === null) reasons.push('trainingEnd must be a valid ISO UTC timestamp ending in Z.');
  else if (decisionMs !== null && trainingMs >= decisionMs) reasons.push('trainingEnd must be strictly before decisionAt.');
  if (!isId(modelId)) reasons.push('modelId must identify the external prediction model.');
  if (!Number.isFinite(thresholdMinutes) || thresholdMinutes < 0) reasons.push('thresholdMinutes must be finite and nonnegative.');
  if (!Array.isArray(stations) || stations.length === 0) reasons.push('stations must be a nonempty array.');
  if (!Array.isArray(cells) || cells.length === 0) reasons.push('cells must be a nonempty array of external expected-incident predictions.');
  if (!isRecord(travelMinutes)) reasons.push('travelMinutes must map station IDs to cell travel durations.');
  if (reasons.length) return blocked(reasons);

  const stationIds = new Set();
  for (const station of stations) {
    if (!isRecord(station) || !isId(station.id) || typeof station.label !== 'string' || !station.label.trim() || typeof station.eligible !== 'boolean' || typeof station.verified !== 'boolean') {
      reasons.push('Each station requires a unique nonempty id, label, and boolean eligible and verified fields.');
      continue;
    }
    if (stationIds.has(station.id)) reasons.push(`Duplicate station ID: ${station.id}.`);
    stationIds.add(station.id);
  }
  const cellIds = new Set();
  for (const cell of cells) {
    if (!isRecord(cell) || !isId(cell.id)) {
      reasons.push('Each cell requires a unique nonempty id.');
      continue;
    }
    if (cellIds.has(cell.id)) reasons.push(`Duplicate cell ID: ${cell.id}.`);
    cellIds.add(cell.id);
    if (!Number.isFinite(cell.expectedIncidents) || cell.expectedIncidents < 0) reasons.push(`Cell ${cell.id} requires finite nonnegative expectedIncidents from the external model.`);
  }
  if (reasons.length) return blocked(reasons);

  const candidates = stations.filter(station => station.eligible && station.verified);
  const eligibleIds = new Set(candidates.map(station => station.id));
  if (!isId(fixedStationId) || !eligibleIds.has(fixedStationId)) reasons.push('fixedStationId must identify a verified eligible station.');
  if (!isId(baselineStationId) || !eligibleIds.has(baselineStationId)) reasons.push('baselineStationId must identify a verified eligible station.');
  for (const station of candidates) {
    const durations = Object.hasOwn(travelMinutes, station.id) ? travelMinutes[station.id] : null;
    for (const cell of cells) {
      if (!isRecord(durations) || !Object.hasOwn(durations, cell.id) || !Number.isFinite(durations[cell.id]) || durations[cell.id] < 0) reasons.push(`Missing or invalid travel duration for station ${station.id}, cell ${cell.id}.`);
    }
  }
  if (reasons.length) return blocked(reasons);

  const rows = candidates.map(station => {
    const coveredCells = cells.filter(cell => travelMinutes[fixedStationId][cell.id] <= thresholdMinutes || travelMinutes[station.id][cell.id] <= thresholdMinutes);
    return {
      stationId: station.id,
      label: station.label,
      coveredCellIds: coveredCells.map(cell => cell.id),
      expectedCoveredIncidents: coveredCells.reduce((total, cell) => total + cell.expectedIncidents, 0),
    };
  });
  if (rows.some(row => !Number.isFinite(row.expectedCoveredIncidents))) return blocked(['Summed expected incidents exceed the finite numeric range.']);
  rows.sort((a, b) => b.expectedCoveredIncidents - a.expectedCoveredIncidents || Number(b.stationId === baselineStationId) - Number(a.stationId === baselineStationId) || (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0));
  return {
    status: 'experimental',
    reasons: [],
    modelId,
    rows,
    preferredCandidateId: rows[0].stationId,
    caveats: [...RANKING_CAVEATS],
  };
}
