import test from 'node:test';
import assert from 'node:assert/strict';
import { bindMonthControls } from '../web/month-controls.js';

function setup() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, events: {}, addEventListener(event, callback) { this.events[event] = callback; } });
    return elements.get(id);
  };
  const state = { selected: '2025-01', start: '2001-01', end: '2025-12' };
  const select = (key) => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(key) && key >= state.start && key <= state.end) state.selected = key; };
  const controls = bindMonthControls({ getElementById: get }, { getSelection: () => state, onSelect: select, onShift: (amount) => {
    const date = new Date(`${state.selected}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + amount); select(date.toISOString().slice(0, 7));
  } });
  controls.update();
  return { state, get, update: controls.update, change: (id, value) => { get(id).value = value; get(id).events.change({ target: get(id) }); }, click: (id) => get(id).events.click() };
}

test('Given a loaded daily section, its local selector updates the shared month used by the daily calendar and weekly plot', () => {
  const h = setup(); h.change('daily-month', '2024-02');
  assert.equal(h.state.selected, '2024-02'); assert.equal(h.get('selected-month').value, '2024-02');
  h.click('daily-next-month'); assert.equal(h.state.selected, '2024-03'); assert.equal(h.get('daily-month').value, '2024-03');
  h.change('selected-month', '2023-12'); assert.equal(h.get('daily-month').value, '2023-12');
  h.click('daily-next-month'); assert.equal(h.state.selected, '2024-01');
});

test('Given an endpoint month, the local previous or next button is disabled and cannot select outside the valid range', () => {
  const h = setup(); h.change('daily-month', '2001-01');
  assert.equal(h.get('daily-previous-month').disabled, true); h.click('daily-previous-month'); assert.equal(h.state.selected, '2001-01');
  h.change('daily-month', '2025-12'); assert.equal(h.get('daily-next-month').disabled, true); h.click('daily-next-month'); assert.equal(h.state.selected, '2025-12');
});

test('Given a typed invalid month or changed date filter, both month controls restore or display the same valid selection', () => {
  const h = setup();
  for (const key of ['', '2024-13', '2026-01', '2000-12']) { h.change('daily-month', key); assert.equal(h.get('daily-month').value, '2025-01'); }
  Object.assign(h.state, { start: '2024-01', end: '2024-12', selected: '2024-12' }); h.update();
  for (const id of ['daily-month', 'selected-month']) { assert.equal(h.get(id).value, '2024-12'); assert.equal(h.get(id).min, '2024-01'); assert.equal(h.get(id).max, '2024-12'); }
  assert.equal(h.get('daily-next-month').disabled, true);
});
