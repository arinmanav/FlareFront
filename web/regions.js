import { monthKey } from './calendar.js';

export function validateRegions(registry) {
  if (registry?.schema_version !== 1 || !Array.isArray(registry.regions) || !registry.regions.length) throw new Error('The city registry is unavailable or invalid.');
  const ids = new Set();
  for (const region of registry.regions) {
    if (!/^[a-z]+(?:-[a-z]+)*$/.test(region.id) || ids.has(region.id) ||
        typeof region.city !== 'string' || !region.city.trim() || typeof region.county !== 'string' || !region.county.trim() ||
        !/^06\d{3}$/.test(region.geoid) || region.data_path !== (region.id === 'los-angeles' ? 'data' : `data/regions/${region.id}`)) {
      throw new Error('The city registry contains an invalid county or data path.');
    }
    ids.add(region.id);
  }
  if (!ids.has(registry.default_region) || !ids.has('los-angeles')) throw new Error('The city registry is missing its default or Los Angeles record.');
  return registry;
}

export function regionFromSearch(registry, search) {
  const id = new URLSearchParams(search).get('region');
  return registry.regions.find((region) => region.id === id) ?? registry.regions.find((region) => region.id === registry.default_region);
}

export function validateRegionalDashboard(data, region) {
  if (!data?.meta || !Array.isArray(data.months) || !Array.isArray(data.daily) || !data.validation || !data.quality) throw new Error('The dashboard data does not match the required schema.');
  if (region && data.meta.geoid !== region.geoid) throw new Error('The calendar does not match the selected county.');
  const keys = new Set();
  const unestimable = data.meta.alpha === null && data.validation.status === 'unestimable' && data.validation.passed === false;
  if (!unestimable && (!Number.isFinite(data.meta.alpha) || data.meta.alpha <= 0)) throw new Error('A fitted coefficient or explicit unestimable status is required.');
  for (const row of data.months) {
    if (!Number.isInteger(row.year) || row.year < 2001 || row.year > 2025 || !Number.isInteger(row.month) || row.month < 1 || row.month > 12) throw new Error('The calendar contains an invalid year or month.');
    const key = monthKey(row.year, row.month);
    if (keys.has(key)) throw new Error(`The calendar repeats ${key}.`);
    keys.add(key);
    for (const source of ['main', 'terra', 'aqua', 'snpp']) {
      if (row[source] !== null && (typeof row[source] !== 'number' || !Number.isFinite(row[source]) || row[source] < 0)) throw new Error(`Invalid ${source} count for ${key}.`);
    }
    if (unestimable && row.year >= data.meta.switch_year && row.main !== null) throw new Error('An unestimable calibration cannot supply adjusted counts.');
  }
  if (keys.size !== 300 || !keys.has('2001-01') || !keys.has('2025-12')) throw new Error('The release must contain all 300 months from January 2001 through December 2025.');
  return data;
}

export function createRegionLoader(fetchJson) {
  let generation = 0;
  let controller;
  return async (region) => {
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    try {
      const files = await Promise.allSettled(['dashboard.json', 'points.json', 'county.geojson'].map((file) => fetchJson(`${region.data_path}/${file}`, { signal: controller.signal })));
      if (current !== generation) return null;
      if (files[0].status === 'rejected') throw files[0].reason;
      const errors = {};
      for (const [key, index] of [['points', 1], ['county', 2]]) if (files[index].status === 'rejected') errors[key] = files[index].reason?.message ?? String(files[index].reason);
      return { data: files[0].value, points: files[1].status === 'fulfilled' ? files[1].value : null, county: files[2].status === 'fulfilled' ? files[2].value : null, errors };
    } catch (error) {
      if (current !== generation) return null;
      throw error;
    }
  };
}
