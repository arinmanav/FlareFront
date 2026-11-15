export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const SERIES_NAMES = { main: 'Terra-equivalent estimate', terra: 'Terra MODIS', aqua: 'Aqua MODIS', snpp: 'Suomi-NPP VIIRS' };

export function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function monthsInRange(months, start, end) {
  return months.filter(({ year, month }) => {
    const key = monthKey(year, month);
    return key >= start && key <= end;
  });
}

export function seriesValue(record, series) {
  const value = record?.[series];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function logColorPosition(value, maximum) {
  return maximum > 0 ? Math.log1p(value) / Math.log1p(maximum) : 0;
}

export function sourceForMonth(series, year, switchYear = 2013) {
  return series === 'main' ? (year < switchYear ? 'terra' : 'snpp') : series;
}

export function pointsInRange(points, start, end, series, switchYear = 2013) {
  const dateIndex = points.columns.indexOf('date');
  const sensorIndex = points.columns.indexOf('sensor');
  return points.rows.filter((row) => {
    const key = row[dateIndex].slice(0, 7);
    return key >= start && key <= end && row[sensorIndex] === sourceForMonth(series, Number(key.slice(0, 4)), switchYear);
  });
}

export function weeklyBins(daily, year, month, series) {
  const key = monthKey(year, month);
  const bins = new Map();
  for (const day of daily) {
    if (day.date.slice(0, 7) !== key) continue;
    const date = new Date(`${day.date}T00:00:00Z`);
    const weekday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - weekday);
    const monday = date.toISOString().slice(0, 10);
    const bin = bins.get(monday) ?? { week: monday, value: null, days: 0, missingDays: 0 };
    const value = seriesValue(day, series);
    if (value === null) bin.missingDays += 1;
    else bin.value = (bin.value ?? 0) + value;
    bin.days += 1;
    bins.set(monday, bin);
  }
  return [...bins.values()].sort((a, b) => a.week.localeCompare(b.week));
}

export function historicalMedian(months, selected, series) {
  const values = months.filter((row) => row.month === selected.month && row.year !== selected.year)
    .map((row) => seriesValue(row, series)).filter((value) => value !== null).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return { value: values.length ? (values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2) : null, count: values.length };
}

function isPartialMonth(row, series, switchYear) {
  const source = sourceForMonth(series, row.year, switchYear);
  return row.availability?.[source]?.startsWith('partial_first_month') === true;
}

export function historicalAverage(months, selected, series, switchYear = 2013) {
  const peers = months.filter((row) => row.month === selected.month && row.year !== selected.year
    && seriesValue(row, series) !== null && !isPartialMonth(row, series, switchYear));
  const years = peers.map((row) => row.year).sort((a, b) => a - b);
  return { value: peers.length ? peers.reduce((sum, row) => sum + row[series], 0) / peers.length : null, count: peers.length, years };
}

export function monthlyAnomaly(months, selected, series, switchYear = 2013) {
  const baseline = historicalAverage(months, selected, series, switchYear);
  const value = seriesValue(selected, series);
  const partial = isPartialMonth(selected, series, switchYear);
  const difference = value === null || baseline.value === null || partial ? null : value - baseline.value;
  return { baseline, difference, percent: difference !== null && baseline.value > 0 ? difference / baseline.value * 100 : null, partial };
}

export function dailyActivity(daily, year, month, source) {
  const byDate = new Map(daily.map((row) => [row.date, row]));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: days }, (_, index) => {
    const day = index + 1, date = `${monthKey(year, month)}-${String(day).padStart(2, '0')}`;
    return { date, day, weekday: (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7, value: seriesValue(byDate.get(date), source) };
  });
}

export function annualRawCounts(months) {
  const years = new Map();
  for (const month of months) {
    const row = years.get(month.year) ?? { year: month.year, terra: null, aqua: null, snpp: null };
    for (const series of ['terra', 'aqua', 'snpp']) {
      const value = seriesValue(month, series);
      if (value !== null) row[series] = (row[series] ?? 0) + value;
    }
    years.set(month.year, row);
  }
  return [...years.values()].sort((a, b) => a.year - b.year);
}
