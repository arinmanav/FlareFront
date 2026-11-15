import { MONTH_NAMES, SERIES_NAMES, monthKey, seriesValue, sourceForMonth, monthlyAnomaly, dailyActivity } from './calendar.js';
import { fireColor, cellTextColor } from './fire-colors.js';

export function historyNumber(value) {
  if (value === null || value === undefined) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.abs(value) < 1 ? 3 : 1 }).format(value);
}

export function signedNumber(value) {
  return value === null ? 'Unavailable' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${historyNumber(Math.abs(value))}`;
}

export function renderCalendarValues(container, { data, months, series, selected, onSelect }) {
  const focusedMonth = container.contains(document.activeElement) ? document.activeElement.dataset.month : null;
  container.replaceChildren();
  const table = document.createElement('table'); table.className = 'calendar-values';
  const caption = table.createCaption();
  caption.textContent = `${selected.year} · ${SERIES_NAMES[series]} · ${series === 'main' ? 'Terra-equivalent detections' : 'Observed detections'}`;
  const heading = table.createTHead().insertRow();
  for (const label of ['Month', 'Count', 'Average', 'Anomaly']) {
    const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; heading.append(cell);
  }
  const body = table.createTBody();
  for (const row of months.filter((item) => item.year === selected.year)) {
    const key = monthKey(row.year, row.month), line = body.insertRow();
    const month = document.createElement('th'); month.scope = 'row';
    const button = document.createElement('button'); button.type = 'button'; button.dataset.month = key;
    button.textContent = MONTH_NAMES[row.month - 1].slice(0, 3); button.setAttribute('aria-label', `Select ${MONTH_NAMES[row.month - 1]} ${row.year}`);
    button.setAttribute('aria-pressed', String(row.month === selected.month));
    button.addEventListener('click', () => onSelect(key)); month.append(button); line.append(month);
    const anomaly = monthlyAnomaly(data.months, row, series, data.meta.switch_year);
    for (const value of [historyNumber(seriesValue(row, series)), historyNumber(anomaly.baseline.value), signedNumber(anomaly.difference)]) {
      const cell = line.insertCell(); cell.textContent = value === 'Unavailable' ? '—' : value;
      if (value === 'Unavailable') cell.setAttribute('aria-label', value);
    }
  }
  container.append(table);
  if (focusedMonth) container.querySelector(`[data-month="${focusedMonth}"]`)?.focus({ preventScroll: true });
}

export function renderDailyCalendar(container, data, record, series) {
  const source = sourceForMonth(series, record.year, data.meta.switch_year);
  const days = dailyActivity(data.daily, record.year, record.month, source);
  const maximum = Math.max(0, ...data.daily.map((row) => seriesValue(row, source) ?? 0));
  container.replaceChildren();
  const table = document.createElement('table'); table.className = 'daily-calendar';
  const caption = table.createCaption(); caption.textContent = `${MONTH_NAMES[record.month - 1]} ${record.year} · ${SERIES_NAMES[source]} · Raw Detections`;
  const header = table.createTHead().insertRow();
  for (const weekday of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
    const cell = document.createElement('th'); cell.scope = 'col';
    const name = document.createElement('abbr'); name.title = weekday; name.textContent = weekday.slice(0, 3); cell.append(name); header.append(cell);
  }
  const body = table.createTBody(); let week = body.insertRow();
  for (let gap = 0; gap < days[0].weekday; gap++) week.insertCell();
  for (const day of days) {
    if (day.weekday === 0 && day.day > 1) week = body.insertRow();
    const cell = week.insertCell(), background = fireColor(day.value, maximum);
    cell.style.backgroundColor = background; cell.style.color = cellTextColor(background);
    cell.setAttribute('aria-label', `${day.date}: ${day.value === null ? 'source unavailable' : `${day.value} reported detections`}`);
    cell.title = cell.getAttribute('aria-label');
    const date = document.createElement('span'); date.textContent = day.day;
    const count = document.createElement('strong'); count.textContent = day.value === null ? '—' : historyNumber(day.value);
    cell.append(date, count);
  }
  while (week.cells.length < 7) week.insertCell();
  container.append(table);
  return { detectionDays: days.filter((day) => day.value !== null && day.value > 0).length, availableDays: days.filter((day) => day.value !== null).length, totalDays: days.length };
}
