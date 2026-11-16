const SENSORS = ['terra', 'aqua', 'snpp'];
const EARTH_RADIUS_METRES = 6371008.8;
const radians = (degrees) => degrees * Math.PI / 180;

function coordinate(latitude, longitude) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('Enter latitude from −90 to 90 and longitude from −180 to 180.');
  }
}

export function circleArea(latitude, longitude, radiusKm) {
  coordinate(latitude, longitude);
  if (!Number.isFinite(radiusKm) || radiusKm < .1 || radiusKm > 100) throw new Error('Choose a radius from 0.1 to 100 km.');
  return { type: 'circle', latitude, longitude, radiusKm };
}

export function rectangleArea(first, second) {
  coordinate(first.lat, first.lng); coordinate(second.lat, second.lng);
  const west = Math.min(first.lng, second.lng), east = Math.max(first.lng, second.lng);
  const south = Math.min(first.lat, second.lat), north = Math.max(first.lat, second.lat);
  if (east - west < 1e-6 || north - south < 1e-6) throw new Error('Choose two different corners with nonzero width and height.');
  return { type: 'rectangle', west, south, east, north };
}

export function distanceMetres(latitude, longitude, otherLatitude, otherLongitude) {
  const a = Math.sin(radians(otherLatitude - latitude) / 2) ** 2
    + Math.cos(radians(latitude)) * Math.cos(radians(otherLatitude)) * Math.sin(radians(otherLongitude - longitude) / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(Math.max(0, Math.min(1, a))));
}

export function containsPoint(area, latitude, longitude) {
  return area.type === 'circle'
    ? distanceMetres(area.latitude, area.longitude, latitude, longitude) <= area.radiusKm * 1000 + 1e-6
    : longitude >= area.west && longitude <= area.east && latitude >= area.south && latitude <= area.north;
}

function ringLocation(ring, longitude, latitude) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j], [x2, y2] = ring[i];
    const cross = (longitude - x1) * (y2 - y1) - (latitude - y1) * (x2 - x1);
    if (Math.abs(cross) <= 1e-10 && longitude >= Math.min(x1, x2) - 1e-10 && longitude <= Math.max(x1, x2) + 1e-10
        && latitude >= Math.min(y1, y2) - 1e-10 && latitude <= Math.max(y1, y2) + 1e-10) return 2;
    if ((y1 > latitude) !== (y2 > latitude) && longitude < (x2 - x1) * (latitude - y1) / (y2 - y1) + x1) inside = !inside;
  }
  return inside ? 1 : 0;
}

export function countyContains(county, latitude, longitude) {
  coordinate(latitude, longitude);
  return county.features.some(({ geometry }) => {
    const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : geometry.type === 'Polygon' ? [geometry.coordinates] : [];
    return polygons.some(([outer, ...holes]) => {
      const outerLocation = ringLocation(outer, longitude, latitude);
      return outerLocation === 2 || (outerLocation === 1 && holes.every((hole) => ringLocation(hole, longitude, latitude) !== 1));
    });
  });
}

export function validateAreaCoverage(area, county) {
  const latitude = area.type === 'circle' ? area.latitude : (area.south + area.north) / 2;
  const longitude = area.type === 'circle' ? area.longitude : (area.west + area.east) / 2;
  if (!countyContains(county, latitude, longitude)) throw new Error('The area center is outside this county. Choose a center inside the selected county, or switch counties.');
  return area;
}

export function areaDescription(area) {
  if (!area) return 'Full County';
  if (area.type === 'circle') return `${area.latitude.toFixed(4)}, ${area.longitude.toFixed(4)} · ${area.radiusKm} km Radius`;
  return `${area.south.toFixed(4)}–${area.north.toFixed(4)}° N, ${area.west.toFixed(4)}–${area.east.toFixed(4)}° Longitude`;
}

export function subsetRecord(data, points, area) {
  const columns = Object.fromEntries(points.columns.map((name, index) => [name, index]));
  for (const key of ['date', 'sensor', 'lat', 'lon', 'version']) if (!(key in columns)) throw new Error(`Area filtering requires the ${key} column.`);
  const rows = points.rows.filter((row) => containsPoint(area, row[columns.lat], row[columns.lon]));
  const dayCounts = new Map(), monthCounts = new Map(), versions = new Map();
  for (const row of rows) {
    const sensor = row[columns.sensor], date = row[columns.date], month = date.slice(0, 7);
    for (const [map, key] of [[dayCounts, `${date}:${sensor}`], [monthCounts, `${month}:${sensor}`]]) map.set(key, (map.get(key) ?? 0) + 1);
    const key = `${month}:${sensor}`;
    if (!versions.has(key)) versions.set(key, new Set());
    versions.get(key).add(row[columns.version]);
  }
  const counts = (original, key, map) => Object.fromEntries(SENSORS.map((sensor) => [sensor, original[sensor] === null ? null : map.get(`${key}:${sensor}`) ?? 0]));
  const daily = data.daily.map((row) => ({ date: row.date, ...counts(row, row.date, dayCounts), main: null }));
  const months = data.months.map((row) => {
    const key = `${row.year}-${String(row.month).padStart(2, '0')}`;
    return { year: row.year, month: row.month, start_date: row.start_date, end_date: row.end_date,
      availability: row.availability, partial_first_year: row.partial_first_year, ...counts(row, key, monthCounts), main: null,
      versions: Object.fromEntries(SENSORS.map((sensor) => [sensor, [...(versions.get(`${key}:${sensor}`) ?? [])].sort()])),
    };
  });
  return { data: { meta: { ...data.meta, alpha: null, units: 'Observed hotspot detections', area }, months, daily,
                  validation: { status: 'not_evaluated', passed: false, reason: 'Custom areas have no fitted calibration.' } },
           points: { ...points, meta: { ...points.meta, area }, rows } };
}
